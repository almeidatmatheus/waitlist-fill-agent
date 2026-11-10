// Inbound WhatsApp processing: durable dedupe (inbound_events UNIQUE(provider, external id)), then routing
// to the right conversation/workflow. Webhook delivery and processing are decoupled: the HTTP handler only
// persists, so WA-AKG gets a fast 2xx and pending events survive restarts (the sweeper re-processes them).
import type { Db } from '../database/pool.ts';
import { errMsg } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import { newCorrelationId } from '../shared/ids.ts';
import { formatSlot, toLocalWallClock } from '../shared/time.ts';
import type { InboundMessage } from '../integrations/wa-akg/types.ts';
import { isClinical, safeFollowUpReply, followUpTemplate, applyFollowUpPolicy, conversationClosed } from '../agents/guardrails.ts';
import type { FollowUp, FollowUpInput, LlmPort } from '../agents/types.ts';
import type { PatientRequestService } from './patient-request-service.ts';
import type { ToolAgent } from '../agents/tool-agent.ts';
import { classify } from '../agents/rule-based-llm.ts';
import { recordEvent } from './workflow-events.ts';
import { firstName } from './templates.ts';
import { LeaseBusyError, type WorkflowRunner } from '../workflows/runner.ts';
import type { MessagingService } from './messaging-service.ts';
import type { HandoffService } from './handoff-service.ts';
import { expireOfferIfDue } from './offer-service.ts';
import { T } from './templates.ts';

export type IngestResult = { status: 'accepted'; eventId: string; correlationId: string } | { status: 'duplicate' };

export class InboundService {
  private db: Db;
  private runner: WorkflowRunner;
  private messaging: MessagingService;
  private handoff: HandoffService;
  private log: Logger;
  private now: () => Date;
  private tz: string;
  private clinicPhone: string;
  private clinicName: string;
  private llm: LlmPort;
  private requests: PatientRequestService;
  private agent: ToolAgent | null;
  private maxAttempts = 5;
  /** Cap on small-talk replies per patient per 24h, so a friendly chat can never loop (requests are not capped). */
  private maxFollowUps = 5;

  constructor(o: { db: Db; runner: WorkflowRunner; messaging: MessagingService; handoff: HandoffService; llm: LlmPort; requests: PatientRequestService; agent?: ToolAgent | null; log: Logger; now: () => Date; timezone: string; clinicPhone: string; clinicName: string }) {
    this.db = o.db; this.runner = o.runner; this.messaging = o.messaging; this.handoff = o.handoff; this.llm = o.llm; this.requests = o.requests; this.agent = o.agent ?? null; this.log = o.log; this.now = o.now; this.tz = o.timezone; this.clinicPhone = o.clinicPhone; this.clinicName = o.clinicName;
  }

  async ingest(msg: InboundMessage, rawPayload: unknown): Promise<IngestResult> {
    const correlationId = newCorrelationId();
    const r = await this.db.query(
      `INSERT INTO inbound_events (provider, external_message_id, payload, correlation_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, external_message_id) DO NOTHING RETURNING id`,
      [msg.provider, msg.externalMessageId, JSON.stringify({ message: { ...msg, timestamp: msg.timestamp.toISOString() }, raw: rawPayload }), correlationId],
    );
    if (!r.rowCount) {
      this.log.info('webhook.duplicate', { provider: msg.provider, externalMessageId: msg.externalMessageId });
      return { status: 'duplicate' };
    }
    this.log.info('webhook.accepted', { correlationId, eventId: r.rows[0].id, provider: msg.provider });
    return { status: 'accepted', eventId: r.rows[0].id, correlationId };
  }

  /** Records ignored deliveries (fromMe, groups...) for dedupe/audit. */
  async recordIgnored(provider: string, externalMessageId: string, reason: string) {
    await this.db.query(
      `INSERT INTO inbound_events (provider, external_message_id, payload, status, correlation_id, processed_at, last_error)
       VALUES ($1, $2, '{}'::jsonb, 'ignored', $3, now(), $4) ON CONFLICT (provider, external_message_id) DO NOTHING`,
      [provider, externalMessageId, newCorrelationId(), reason],
    );
  }

  private async finish(eventId: string, status: 'processed' | 'ignored', note?: string) {
    await this.db.query(`UPDATE inbound_events SET status = $2, processed_at = now(), last_error = $3, attempts = attempts + 1 WHERE id = $1`, [eventId, status, note ?? null]);
  }

  async process(eventId: string): Promise<void> {
    const ev = await this.db.query(`SELECT * FROM inbound_events WHERE id = $1 AND status = 'pending'`, [eventId]);
    if (!ev.rowCount) return;
    const row = ev.rows[0];
    const correlationId: string = row.correlation_id;
    const msg = row.payload.message as { externalMessageId: string; fromJid: string; fromPhone: string | null; text: string };
    const log = this.log.child({ correlationId, inboundEventId: eventId });
    try {
      const p = await this.db.query(`SELECT id, full_name FROM patients WHERE whatsapp_jid = $1 OR phone_number = $2 LIMIT 1`, [msg.fromJid, msg.fromPhone]);
      if (!p.rowCount) {
        // Unknown number: never reply (development must never contact unknown numbers).
        log.info('inbound.unknown_sender');
        return this.finish(eventId, 'ignored', 'unknown_sender');
      }
      const patientId: string = p.rows[0].id;
      const conv = await this.db.query(
        `SELECT c.id, c.status, c.thread_id, c.active_offer_id, o.status AS offer_status, o.expires_at, w.starts_at
           FROM conversations c LEFT JOIN appointment_offers o ON o.id = c.active_offer_id LEFT JOIN recovery_workflows w ON w.id = c.thread_id
          WHERE c.patient_id = $1 ORDER BY (c.status IN ('open', 'handoff')) DESC, c.updated_at DESC LIMIT 1`,
        [patientId],
      );
      const c = conv.rows[0];
      await this.db.query(
        `INSERT INTO messages (conversation_id, patient_id, offer_id, external_message_id, direction, content, delivery_status, correlation_id)
         VALUES ($1, $2, $3, $4, 'inbound', $5, 'received', $6) ON CONFLICT DO NOTHING`,
        [c?.id ?? null, patientId, c?.active_offer_id ?? null, msg.externalMessageId, msg.text, correlationId],
      );
      log.info('inbound.routed', { conversationId: c?.id ?? null, workflowId: c?.thread_id ?? null, offerStatus: c?.offer_status ?? null, conversationStatus: c?.status ?? null });

      if (c?.status === 'handoff') {
        // A human owns this conversation now; only a safety notice for clinical language.
        if (isClinical(msg.text)) await this.notice(patientId, c.id, c.active_offer_id, `notice:clinical:${eventId}`, T.clinical(this.clinicPhone), correlationId);
        return this.finish(eventId, 'processed', 'handoff_owned');
      }

      const now = this.now();
      if (c?.status === 'open' && c.offer_status === 'pending' && c.thread_id) {
        if (new Date(c.expires_at).getTime() <= now.getTime()) {
          // Late reply that beat the expiry sweeper: expire first (moves the workflow on), then tell the patient.
          await expireOfferIfDue(this.db, c.active_offer_id, now);
          await this.runner.resume(c.thread_id, { type: 'offer_expired', offerId: c.active_offer_id, correlationId });
          await this.notice(patientId, c.id, c.active_offer_id, `notice:late:${eventId}`, T.lateReply(), correlationId);
          return this.finish(eventId, 'processed', 'late_reply');
        }
        await this.runner.resume(c.thread_id, { type: 'patient_message', offerId: c.active_offer_id, text: msg.text, inboundEventId: eventId, correlationId });
        return this.finish(eventId, 'processed');
      }

      // No live offer: clinical safety first, then the assistant (small talk, questions, cancel/reschedule).
      if (isClinical(msg.text)) {
        await this.handoff.open({ workflowId: c?.thread_id ?? null, conversationId: c?.id ?? null, patientId, reason: 'clinical_concern_outside_offer' });
        await this.notice(patientId, c?.id ?? null, c?.active_offer_id ?? null, `notice:clinical:${eventId}`, T.clinical(this.clinicPhone), correlationId);
        return this.finish(eventId, 'processed', 'clinical_outside_offer');
      }
      if (c?.offer_status === 'accepted') return this.finish(eventId, 'processed', 'booking_in_progress');
      const note = await this.assist({
        eventId, patientId, fullName: p.rows[0].full_name, conversationId: c?.id ?? null, offerId: c?.active_offer_id ?? null, workflowId: c?.thread_id ?? null,
        offerStatus: c?.offer_status ?? null, text: msg.text, correlationId,
      });
      return this.finish(eventId, 'processed', note);
    } catch (e) {
      const busy = e instanceof LeaseBusyError;
      const attempts = Number(row.attempts) + 1;
      const failed = !busy && attempts >= this.maxAttempts;
      await this.db.query(`UPDATE inbound_events SET attempts = attempts + 1, last_error = $2, status = $3 WHERE id = $1`, [eventId, errMsg(e).slice(0, 500), failed ? 'failed' : 'pending']);
      log.warn('inbound.process_failed', { attempts, error: errMsg(e), willRetry: !failed });
      if (failed) await this.handoff.open({ workflowId: null, conversationId: null, patientId: null, reason: `inbound_event_failed:${eventId}` }).catch(() => {});
    }
  }

  /**
   * Conversation outside a live offer. One LLM call understands the message; deterministic code then either
   * runs a cancel/reschedule request (calendar via MCP) or sends a short, guarded small-talk reply.
   */
  private async assist(a: { eventId: string; patientId: string; fullName: string; conversationId: string | null; offerId: string | null; workflowId: string | null; offerStatus: string | null; text: string; correlationId: string }): Promise<string> {
    const now = this.now();
    const upcoming = await this.requests.upcoming(a.patientId);
    const hist = await this.db.query(
      `SELECT direction, content FROM messages WHERE patient_id = $1 AND delivery_status IN ('sent', 'received') ORDER BY created_at DESC, id DESC LIMIT 9`,
      [a.patientId],
    );
    const history = hist.rows.reverse().map(m => ({ role: m.direction === 'outbound' ? 'clinic' as const : 'patient' as const, text: m.content as string }));
    if (history.length && history[history.length - 1].role === 'patient' && history[history.length - 1].text === a.text) history.pop();
    const pendingProposal = await this.requests.pendingProposal(a.patientId);

    // The conversation is already over (the clinic signed off, nothing pending) and the patient only closes it
    // ("thanks again!", "bye 👍"): no reply and no model call, so the chat does not ping-pong.
    if (conversationClosed(history, a.text, !!pendingProposal)) {
      await recordEvent(this.db, a.workflowId, 'conversation_closed', { inboundEventId: a.eventId });
      return 'conversation_closed';
    }

    // A late "yes" to an offer that is gone always gets the deterministic answer.
    const lateOffer = a.offerStatus && ['expired', 'superseded', 'slot_unavailable', 'send_failed'].includes(a.offerStatus);
    if (lateOffer && !pendingProposal && classify(a.text).intent === 'accept') {
      await this.notice(a.patientId, a.conversationId, a.offerId, `notice:late:${a.eventId}`, T.lateReply(), a.correlationId);
      return 'late_reply';
    }

    if (this.agent) return this.runAgent(a, history, pendingProposal);

    const localNow = toLocalWallClock(now, this.tz);
    const input: FollowUpInput = {
      patientFirstName: firstName(a.fullName), clinicName: this.clinicName, clinicPhone: this.clinicPhone,
      today: `${new Intl.DateTimeFormat('en-GB', { timeZone: this.tz, weekday: 'long' }).format(now)} ${localNow.slice(0, 10)} (now ${localNow.slice(11)})`,
      appointments: upcoming.map(x => { const l = toLocalWallClock(x.startsAt, this.tz); return { date: l.slice(0, 10), time: l.slice(11), treatment: x.treatment }; }),
      nextAppointment: upcoming[0] ? formatSlot(upcoming[0].startsAt, this.tz, now) : null,
      outcome: a.offerStatus === 'confirmed' ? 'confirmed' : a.offerStatus === 'declined' ? 'declined' : 'none',
      pendingProposal, history, message: a.text,
    };
    let turn: FollowUp, llmError: string | null = null, tokens = { inputTokens: 0, outputTokens: 0 };
    try {
      const r = await this.llm.followUp(input);
      turn = applyFollowUpPolicy(a.text, r.value, !!pendingProposal);
      tokens = r.usage ?? tokens;
    } catch (e) {
      llmError = errMsg(e);
      turn = { category: 'other', shouldReply: true, reply: '', appointmentDate: null, targetDate: null, targetTime: null, timeOfDay: null };
    }
    await recordEvent(this.db, a.workflowId, 'assistant_turn', { inboundEventId: a.eventId, category: turn.category, hasProposal: !!pendingProposal, targetDate: turn.targetDate, targetTime: turn.targetTime, llmError, ...tokens });

    // 1) Cancel / reschedule (and answers to a pending proposal).
    const handled = await this.requests.handle({ patientId: a.patientId, fullName: a.fullName, conversationId: a.conversationId, eventId: a.eventId, correlationId: a.correlationId, text: a.text, turn });
    if (handled) return handled;

    // 2) A late "yes" to an offer that is gone gets the deterministic answer (never anything that sounds like a booking).
    if (a.offerStatus && ['expired', 'superseded', 'slot_unavailable', 'send_failed'].includes(a.offerStatus) && turn.category !== 'thanks' && turn.category !== 'acknowledgement') {
      await this.notice(a.patientId, a.conversationId, a.offerId, `notice:late:${a.eventId}`, T.lateReply(), a.correlationId);
      return 'late_reply';
    }

    // 3) Small talk / questions: guarded LLM reply, capped so the chat cannot loop.
    if (!turn.shouldReply) return `follow_up_${turn.category}_no_reply`;
    const recent = await this.db.query(`SELECT count(*)::int n FROM messages WHERE patient_id = $1 AND idempotency_key LIKE 'followup:%' AND created_at > $2`, [a.patientId, new Date(now.getTime() - 24 * 3600_000)]);
    if (recent.rows[0].n >= this.maxFollowUps) return 'follow_up_limit';
    const safe = llmError ? { text: followUpTemplate('other', input), usedFallback: true } : safeFollowUpReply(turn, input);
    await this.notice(a.patientId, a.conversationId, a.offerId, `followup:${a.eventId}`, safe.text, a.correlationId);
    return `follow_up_${turn.category}${safe.usedFallback ? '_fallback' : ''}`;
  }

  /** Function-calling agent (OpenAI mode): the model picks tools; tools enforce the rules. */
  private async runAgent(a: { eventId: string; patientId: string; fullName: string; conversationId: string | null; offerId: string | null; workflowId: string | null; text: string; correlationId: string }, history: { role: 'clinic' | 'patient'; text: string }[], pendingProposal: string | null): Promise<string> {
    const received = (await this.db.query(`SELECT received_at FROM inbound_events WHERE id = $1`, [a.eventId])).rows[0]?.received_at ?? this.now();
    const run = await this.agent!.run({
      patientId: a.patientId, firstName: firstName(a.fullName), conversationId: a.conversationId, correlationId: a.correlationId, inboundEventId: a.eventId,
      messageText: a.text, messageReceivedAt: new Date(received), history, pendingProposal,
    });
    await recordEvent(this.db, a.workflowId, 'agent_turn', {
      inboundEventId: a.eventId, tools: run.tools.map(t => ({ name: t.name, ok: t.ok, status: (t.result as { status?: string })?.status ?? null })),
      changeCompleted: run.changeCompleted, usedFallback: run.usedFallback, fallbackReason: run.fallbackReason ?? null, rejectedReply: run.rejectedReply ?? null, modelCalls: run.modelCalls, inputTokens: run.inputTokens, outputTokens: run.outputTokens, latencyMs: run.latencyMs,
    });
    if (!run.reply) return 'agent_no_reply';
    const smallTalk = run.tools.length === 0;
    if (smallTalk) {
      const recent = await this.db.query(`SELECT count(*)::int n FROM messages WHERE patient_id = $1 AND idempotency_key LIKE 'followup:%' AND created_at > $2`, [a.patientId, new Date(this.now().getTime() - 24 * 3600_000)]);
      if (recent.rows[0].n >= this.maxFollowUps) return 'follow_up_limit';
    }
    await this.notice(a.patientId, a.conversationId, a.offerId, `${smallTalk ? 'followup' : 'agent'}:${a.eventId}`, run.reply, a.correlationId);
    return `agent_${run.tools.map(t => t.name).join('+') || 'reply'}`;
  }

  private notice(patientId: string, conversationId: string | null, offerId: string | null, key: string, text: string, correlationId: string) {
    return this.messaging.send({ patientId, conversationId, offerId, idempotencyKey: key, text, correlationId });
  }

  async pendingEventIds(olderThanMs: number): Promise<string[]> {
    const r = await this.db.query(
      `SELECT id FROM inbound_events WHERE status = 'pending' AND received_at < now() - make_interval(secs => $1) ORDER BY received_at LIMIT 50`,
      [olderThanMs / 1000],
    );
    return r.rows.map(x => x.id);
  }
}
