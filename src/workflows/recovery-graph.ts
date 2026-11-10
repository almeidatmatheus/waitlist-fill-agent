// LangGraph.js recovery workflow: one thread per cancelled slot (thread_id = recovery_workflows.id).
//
// The graph never blocks while waiting for a patient, a human or a calendar retry: dedicated
// "awaiting_*" nodes call interrupt(), the state is checkpointed in PostgreSQL, and the run ends.
// A later webhook / sweeper / staff action resumes the thread with Command({ resume }).
// Interrupt nodes contain no side effects (LangGraph re-executes a node from its start on resume).
// All other side effects are idempotent (idempotency keys, compare-and-set transitions).
//
// Offer cascade: a slot can be on offer to up to OFFER_CASCADE_SIZE patients at once (`live` in the state).
// Either all of them are contacted together, or the offer is widened to one more patient every
// OFFER_WIDEN_AFTER_MINUTES. The first patient whose acceptance reserves the slot gets it; the others are
// told straight away that it has gone. Events are still processed one at a time per slot.
import { END, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { Db } from '../database/pool.ts';
import type { AppConfig } from '../config/env.ts';
import type { Logger } from '../shared/logger.ts';
import { errMsg } from '../shared/errors.ts';
import { formatSlot } from '../shared/time.ts';
import type { LlmPort } from '../agents/types.ts';
import { interpretPatientReply } from '../agents/interpreter.ts';
import { findCandidates, loadSlot, type SlotInfo } from '../services/waitlist-matching.ts';
import { createOffer, getOffer, transitionOffer, expireOfferIfDue, closeConversation } from '../services/offer-service.ts';
import type { MessagingService } from '../services/messaging-service.ts';
import type { BookingService } from '../services/booking-service.ts';
import type { HandoffService } from '../services/handoff-service.ts';
import { recordEvent } from '../services/workflow-events.ts';
import { T, firstName } from '../services/templates.ts';
import { RecoveryState, type LiveOffer, type RecoveryStateType, type RecoveryUpdate, type ResumeEvent, type SlotSnapshot } from './state.ts';

export interface GraphDeps {
  db: Db;
  cfg: AppConfig;
  log: Logger;
  now: () => Date;
  llm: LlmPort;
  messaging: MessagingService;
  booking: BookingService;
  handoff: HandoffService;
}

const slotInfo = (s: SlotSnapshot, workflowId: string, cancelledPatientId: string, durationMinutes: number): SlotInfo => ({
  workflowId, slotReference: s.slotReference, cancelledAppointmentId: s.cancelledAppointmentId, cancelledPatientId,
  treatmentId: s.treatmentId, treatmentName: s.treatmentName, durationMinutes, startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt),
});

export function buildRecoveryGraph(deps: GraphDeps, checkpointer: BaseCheckpointSaver) {
  const { db, cfg, now } = deps;
  const tz = cfg.clinic.timezone;
  const slotText = (s: RecoveryStateType) => formatSlot(new Date(s.slot!.startsAt), tz, now());

  // Wraps every node: structured log with workflow/conversation ids, current state and duration.
  const node = (name: string, fn: (s: RecoveryStateType) => Promise<RecoveryUpdate>) => async (s: RecoveryStateType): Promise<RecoveryUpdate> => {
    const t0 = Date.now();
    const log = deps.log.child({ workflowId: s.workflowId, conversationId: s.conversationId, correlationId: s.correlationId, state: name });
    try {
      const out = await fn(s);
      log.info('workflow.state', { durationMs: Date.now() - t0, route: out.route ?? null });
      return { status: name, ...out };
    } catch (e) {
      log.error('workflow.node_error', { durationMs: Date.now() - t0, error: errMsg(e) });
      throw e; // checkpoint stays at the previous step; the runner records the error and retries later
    }
  };

  const send = (s: RecoveryStateType, key: string, text: string) =>
    deps.messaging.send({ patientId: s.candidate!.patientId, conversationId: s.conversationId, offerId: s.offerId, idempotencyKey: key, text, correlationId: s.correlationId || s.workflowId });

  const cascadeSize = cfg.clinic.offerCascadeSize;
  const widenMs = cfg.clinic.offerWidenAfterMinutes * 60000;

  /** Open offers. A thread checkpointed before the cascade existed has only the single current offer. */
  const liveOf = (s: RecoveryStateType): LiveOffer[] =>
    s.live.length || !s.offerId || !s.candidate || !s.conversationId ? s.live
      : [{ ...s.candidate, offerId: s.offerId, conversationId: s.conversationId, clarifications: s.clarifications }];
  const others = (s: RecoveryStateType, keepOfferId: string | null) => liveOf(s).filter(o => o.offerId !== keepOfferId);

  /** The slot has gone (booked, unavailable, closed): end every other open offer and tell those patients. */
  const closeOthers = async (s: RecoveryStateType, keepOfferId: string | null, reason: string): Promise<LiveOffer[]> => {
    const rest = others(s, keepOfferId);
    // Only say "booked by another patient" when that is what happened.
    const taken = reason === 'accepted_by_another_patient' || reason === 'booked';
    for (const o of rest) {
      const moved = await transitionOffer(db, o.offerId, ['pending'], 'superseded', now());
      // Re-execution after a crash: the transition already happened, the notice may not have been sent.
      if (moved || (await getOffer(db, o.offerId))?.status === 'superseded') {
        await deps.messaging.send({ patientId: o.patientId, conversationId: o.conversationId, offerId: o.offerId, idempotencyKey: `notice:taken:${o.offerId}`, text: taken ? T.slotTaken() : T.lateReply(), correlationId: s.correlationId || s.workflowId });
      }
      await closeConversation(db, o.conversationId);
    }
    if (rest.length) await recordEvent(db, s.workflowId, 'offers_superseded', { offerIds: rest.map(o => o.offerId), reason });
    return liveOf(s).filter(o => o.offerId === keepOfferId);
  };

  const noCurrent = { candidate: null, offerId: null, conversationId: null, interpretation: null, clarifications: 0 } satisfies RecoveryUpdate;

  /** The current offer is over: drop it and let waitlist_search decide whether to contact someone else. */
  const nextCandidate = (s: RecoveryStateType): RecoveryUpdate => ({
    triedWaitlistIds: s.candidate ? [...new Set([...s.triedWaitlistIds, s.candidate.waitlistId])] : s.triedWaitlistIds,
    live: others(s, s.offerId),
    candidate: null, offerId: null, conversationId: null, interpretation: null, bookingId: null, clarifications: 0, handoffReason: null,
    route: 'waitlist_search',
  });

  const g = new StateGraph(RecoveryState)
    .addNode('cancellation_detected', node('cancellation_detected', async s => {
      const slot = await loadSlot(db, s.workflowId);
      await recordEvent(db, s.workflowId, 'workflow_started', { slotReference: slot.slotReference, treatment: slot.treatmentName, startsAt: slot.startsAt });
      return {
        slot: { slotReference: slot.slotReference, cancelledAppointmentId: slot.cancelledAppointmentId, treatmentId: slot.treatmentId, treatmentName: slot.treatmentName, startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString() },
        route: 'waitlist_search',
      };
    }))
    .addNode('waitlist_search', node('waitlist_search', async s => {
      const live = liveOf(s);
      const wait = (widenAt: string | null): RecoveryUpdate => ({ ...noCurrent, live, widenAt, route: 'awaiting_patient_response' });
      // An open handoff stops new offers. Offers already out stay open; with none left, staff decide.
      if (s.handoffOpen) return live.length ? wait(null) : { live, widenAt: null, route: 'awaiting_human' };
      const dueAt = widenMs && s.lastOfferAt ? new Date(s.lastOfferAt).getTime() + widenMs : null;
      const want = live.length === 0 ? 1
        : widenMs === 0 ? cascadeSize
        : Math.min(cascadeSize, live.length + (dueAt !== null && dueAt <= now().getTime() ? 1 : 0));
      if (live.length >= want) return wait(live.length < cascadeSize && dueAt !== null ? new Date(dueAt).toISOString() : null);
      const slot = await loadSlot(db, s.workflowId);
      const m = await findCandidates(db, slot, now(), cfg.clinic.minLeadTimeMinutes, s.triedWaitlistIds);
      await recordEvent(db, s.workflowId, 'waitlist_searched', { eligible: m.ranked.map(c => c.waitlistId), rejected: m.rejected });
      const c = m.ranked[0];
      if (!c) return live.length ? wait(null) : { candidate: null, live, widenAt: null, route: 'workflow_exhausted' };
      return { live, candidate: { waitlistId: c.waitlistId, patientId: c.patientId, firstName: firstName(c.fullName) }, route: 'candidate_selected' };
    }))
    .addNode('candidate_selected', node('candidate_selected', async s => {
      await recordEvent(db, s.workflowId, 'candidate_selected', { waitlistId: s.candidate!.waitlistId, patientId: s.candidate!.patientId, policy: 'P1 longest waiting, P2 largest wait reduction, P3 id', alreadyOnOffer: s.live.length });
      return { route: 'offer_created' };
    }))
    .addNode('offer_created', node('offer_created', async s => {
      const slot = await loadSlot(db, s.workflowId);
      const r = await createOffer(db, slot, s.candidate!, now(), cfg.clinic.offerTtlMinutes);
      if (!r.ok) {
        await recordEvent(db, s.workflowId, 'offer_skipped', { waitlistId: s.candidate!.waitlistId, reason: r.reason });
        return nextCandidate(s);
      }
      return { offerId: r.offer.id, conversationId: r.conversationId, clarifications: 0, route: 'message_sent' };
    }))
    .addNode('message_sent', node('message_sent', async s => {
      const text = T.offer(s.candidate!.firstName, s.slot!.treatmentName, slotText(s), cfg.clinic.name, cfg.clinic.offerTtlMinutes, cascadeSize > 1);
      const r = await send(s, `offer:${s.offerId}`, text);
      if (!r.ok) {
        await transitionOffer(db, s.offerId!, ['pending'], 'send_failed', now());
        await closeConversation(db, s.conversationId);
        await recordEvent(db, s.workflowId, 'offer_message_failed', { offerId: s.offerId, kind: r.kind });
        return nextCandidate(s);
      }
      await recordEvent(db, s.workflowId, 'offer_message_sent', { offerId: s.offerId, duplicate: r.duplicate });
      const entry: LiveOffer = { ...s.candidate!, offerId: s.offerId!, conversationId: s.conversationId!, clarifications: 0 };
      // Back to waitlist_search: it contacts the next patient now (simultaneous cascade) or waits.
      return { live: [...s.live.filter(o => o.offerId !== entry.offerId), entry], lastOfferAt: now().toISOString(), route: 'waitlist_search' };
    }))
    .addNode('awaiting_patient_response', async (s: RecoveryStateType): Promise<RecoveryUpdate> => {
      const live = liveOf(s);
      const ev = interrupt({ waitingFor: 'patient', offerIds: live.map(o => o.offerId) }) as ResumeEvent;
      const status = 'awaiting_patient_response';
      if (ev?.type === 'widen') return { status, correlationId: ev.correlationId, route: 'waitlist_search' };
      if (ev?.type === 'staff_decision' && s.handoffOpen) return { status, lastEvent: ev, correlationId: ev.correlationId, route: 'handoff_resolved' };
      if (ev?.type === 'patient_message' || ev?.type === 'offer_expired') {
        const o = live.find(x => x.offerId === ev.offerId);
        // The event picks which open offer the following nodes work on.
        if (o) return {
          status, live, lastEvent: ev, correlationId: ev.correlationId, interpretation: null, bookingId: null,
          candidate: { waitlistId: o.waitlistId, patientId: o.patientId, firstName: o.firstName }, offerId: o.offerId, conversationId: o.conversationId, clarifications: o.clarifications,
          route: ev.type === 'patient_message' ? 'patient_response_interpretation' : 'offer_expired',
        };
      }
      // Stale or unrelated event (e.g. for an offer that is already over): ignore and keep waiting.
      return { status, route: 'awaiting_patient_response' };
    })
    .addNode('patient_response_interpretation', node('patient_response_interpretation', async s => {
      const ev = s.lastEvent as Extract<ResumeEvent, { type: 'patient_message' }>;
      const offer = await getOffer(db, s.offerId!);
      // Deterministic gate before any LLM call: a reply after the deadline can never book.
      if (!offer || offer.status !== 'pending' || offer.expiresAt.getTime() <= now().getTime()) {
        if (offer?.status === 'pending') await expireOfferIfDue(db, offer.id, now());
        return { interpretation: { intent: 'expired', confidence: 1, reply: '', overridden: 'offer_not_pending' }, route: 'offer_expired' };
      }
      const hist = await db.query(`SELECT direction, content FROM messages WHERE offer_id = $1 AND delivery_status IN ('sent', 'received') ORDER BY created_at, id`, [s.offerId]);
      const history = hist.rows.map(m => ({ role: m.direction === 'outbound' ? 'clinic' as const : 'patient' as const, text: m.content as string }));
      if (history.length && history[history.length - 1].role === 'patient' && history[history.length - 1].text === ev.text) history.pop();
      const out = await interpretPatientReply(deps.llm, {
        patientFirstName: s.candidate!.firstName, clinicName: cfg.clinic.name, treatmentName: s.slot!.treatmentName, slotText: slotText(s), history, message: ev.text,
      }, deps.log.child({ workflowId: s.workflowId, correlationId: ev.correlationId }));
      await recordEvent(db, s.workflowId, 'response_interpreted', {
        offerId: s.offerId, inboundEventId: ev.inboundEventId, intent: out.intent, confidence: out.confidence, overridden: out.overridden,
        needsCalendarInfo: out.needsCalendarInfo, requestedDay: out.requestedDay, usedFallbackReply: out.usedFallbackReply,
        llm: out.llm,
      });
      const i = out.intent;
      const route =
        i === 'accept' ? 'availability_verification'
        : i === 'decline' || i === 'already_booked' || i === 'opt_out' ? 'offer_declined'
        : i === 'human_request' || i === 'clinical_concern' ? 'human_handoff'
        : s.clarifications >= cfg.clinic.maxClarificationTurns ? 'human_handoff'
        : 'clarification_sent';
      return {
        interpretation: { intent: i, confidence: out.confidence, reply: out.reply, overridden: out.overridden },
        handoffReason: route === 'human_handoff' ? (i === 'human_request' || i === 'clinical_concern' ? i : 'clarification_limit') : null,
        llmCalls: out.llm.called ? 1 : 0, inputTokens: out.llm.inputTokens, outputTokens: out.llm.outputTokens, costUsd: out.llm.costUsd ?? 0,
        route,
      };
    }))
    .addNode('clarification_sent', node('clarification_sent', async s => {
      const ev = s.lastEvent as Extract<ResumeEvent, { type: 'patient_message' }>;
      await send(s, `reply:${ev.inboundEventId}`, s.interpretation!.reply);
      const n = s.clarifications + 1;
      return { clarifications: n, live: s.live.map(o => (o.offerId === s.offerId ? { ...o, clarifications: n } : o)), route: 'awaiting_patient_response' };
    }))
    .addNode('availability_verification', node('availability_verification', async s => {
      const r = await deps.booking.reserve(s.offerId!);
      if (!r.ok) {
        await recordEvent(db, s.workflowId, 'booking_rejected', { offerId: s.offerId, reason: r.reason });
        if (r.reason === 'offer_expired') return { route: 'offer_expired' };
        if (r.reason === 'slot_taken') return { route: 'slot_unavailable' };
        await transitionOffer(db, s.offerId!, ['pending'], 'superseded', now());
        await closeConversation(db, s.conversationId);
        return nextCandidate(s);
      }
      // First acceptance wins: the slot is now reserved for this patient, so every other open offer ends here.
      const live = await closeOthers(s, s.offerId, 'accepted_by_another_patient');
      try {
        const a = await deps.booking.checkAvailability(r.bookingId);
        await recordEvent(db, s.workflowId, 'availability_checked', { bookingId: r.bookingId, result: a });
        return { live, widenAt: null, bookingId: r.bookingId, route: a === 'unavailable' ? 'slot_unavailable' : 'booking' };
      } catch (e) {
        // Unknown availability (Graph/MCP failure): do not book now, let the reconciler retry the booking.
        await recordEvent(db, s.workflowId, 'availability_unknown', { bookingId: r.bookingId, error: errMsg(e).slice(0, 200) });
        return { live, widenAt: null, bookingId: r.bookingId, route: 'booking' };
      }
    }))
    .addNode('booking', node('booking', async s => {
      const o = await deps.booking.execute(s.bookingId!);
      const route = o.status === 'confirmed' ? 'confirmation'
        : o.status === 'unavailable' ? 'slot_unavailable'
        : o.status === 'pending' ? 'awaiting_booking_reconciliation'
        : o.status === 'approval_required' ? 'human_handoff'
        : 'workflow_failed';
      return { route, handoffReason: o.status === 'approval_required' ? 'calendar_approval_required' : s.handoffReason, error: o.status === 'failed' ? o.reason : null };
    }))
    .addNode('awaiting_booking_reconciliation', async (s: RecoveryStateType): Promise<RecoveryUpdate> => {
      const ev = interrupt({ waitingFor: 'reconciliation', bookingId: s.bookingId }) as ResumeEvent;
      if (ev?.type === 'retry_booking' && ev.bookingId === s.bookingId) return { status: 'awaiting_booking_reconciliation', correlationId: ev.correlationId, route: 'booking' };
      return { status: 'awaiting_booking_reconciliation', route: 'awaiting_booking_reconciliation' };
    })
    .addNode('confirmation', node('confirmation', async s => {
      const b = await deps.booking.get(db, s.bookingId!);
      if (b?.status !== 'confirmed') return { route: 'workflow_failed', error: 'confirmation reached without a confirmed booking' };
      const r = await send(s, `confirmation:${s.bookingId}`, T.confirmation(s.candidate!.firstName, s.slot!.treatmentName, slotText(s)));
      if (!r.ok) await recordEvent(db, s.workflowId, 'confirmation_send_failed', { bookingId: s.bookingId });
      await closeConversation(db, s.conversationId);
      // The patient may still hold a later appointment for the same treatment. Releasing it means cancelling a
      // calendar event, which the MCP gates behind human confirmation, so it is flagged for staff instead.
      const later = await db.query(`SELECT id FROM appointments WHERE patient_id = $1 AND treatment_id = $2 AND status = 'scheduled' AND id <> $3 AND starts_at > $4`, [s.candidate!.patientId, s.slot!.treatmentId, b.appointmentId, s.slot!.startsAt]);
      if (later.rowCount) await recordEvent(db, s.workflowId, 'later_appointment_needs_release', { appointmentIds: later.rows.map(r => r.id) });
      await recordEvent(db, s.workflowId, 'workflow_completed', { outcome: 'booked', bookingId: s.bookingId, appointmentId: b.appointmentId });
      await closeOthers(s, s.offerId, 'booked');
      return { live: [], widenAt: null, outcome: 'booked', route: 'end' };
    }))
    .addNode('offer_declined', node('offer_declined', async s => {
      const intent = s.interpretation?.intent;
      await transitionOffer(db, s.offerId!, ['pending'], 'declined', now());
      let text = T.declinedAck(s.candidate!.firstName);
      if (intent === 'already_booked') {
        await db.query(`UPDATE waitlist SET status = 'fulfilled_elsewhere' WHERE id = $1 AND status = 'waiting'`, [s.candidate!.waitlistId]);
        text = T.alreadyBookedAck(s.candidate!.firstName);
      } else if (intent === 'opt_out') {
        await db.query(`UPDATE patients SET contact_allowed = false WHERE id = $1`, [s.candidate!.patientId]);
        await db.query(`UPDATE waitlist SET status = 'withdrawn' WHERE id = $1 AND status = 'waiting'`, [s.candidate!.waitlistId]);
        text = T.optOutAck();
      }
      await send(s, `notice:ack:${s.offerId}`, text);
      await closeConversation(db, s.conversationId);
      await recordEvent(db, s.workflowId, 'offer_declined', { offerId: s.offerId, intent });
      return nextCandidate(s);
    }))
    .addNode('offer_expired', node('offer_expired', async s => {
      await expireOfferIfDue(db, s.offerId!, now());
      const o = await getOffer(db, s.offerId!);
      if (o?.status === 'expired') await send(s, `notice:expired:${s.offerId}`, T.expired());
      await closeConversation(db, s.conversationId);
      await recordEvent(db, s.workflowId, 'offer_expired', { offerId: s.offerId, status: o?.status });
      return nextCandidate(s);
    }))
    .addNode('human_handoff', node('human_handoff', async s => {
      const reason = s.handoffReason ?? 'unspecified';
      await transitionOffer(db, s.offerId!, ['pending', 'accepted'], 'handoff', now());
      await closeConversation(db, s.conversationId, 'handoff');
      const h = await deps.handoff.open({ workflowId: s.workflowId, conversationId: s.conversationId, patientId: s.candidate!.patientId, reason });
      const phone = cfg.clinic.phoneDisplay;
      const text = reason === 'clinical_concern' ? T.clinical(phone)
        : reason === 'calendar_approval_required' ? T.bookingFailed(phone)
        : h.notified ? T.humanNotified() : T.humanNotConfigured(phone);
      await send(s, `notice:handoff:${s.offerId}`, text);
      // Only this patient's offer stops. Other open offers carry on; waitlist_search parks the workflow
      // for staff once none are left.
      return { ...nextCandidate(s), handoffReason: reason, handoffOpen: true };
    }))
    .addNode('awaiting_human', async (s: RecoveryStateType): Promise<RecoveryUpdate> => {
      const ev = interrupt({ waitingFor: 'human', reason: s.handoffReason }) as ResumeEvent;
      if (ev?.type === 'staff_decision') return { status: 'awaiting_human', lastEvent: ev, correlationId: ev.correlationId, route: 'handoff_resolved' };
      return { status: 'awaiting_human', route: 'awaiting_human' };
    })
    .addNode('handoff_resolved', node('handoff_resolved', async s => {
      const ev = s.lastEvent as Extract<ResumeEvent, { type: 'staff_decision' }>;
      await deps.handoff.resolveForWorkflow(s.workflowId);
      await db.query(`UPDATE conversations SET status = 'closed', updated_at = now() WHERE thread_id = $1 AND status = 'handoff'`, [s.workflowId]);
      await recordEvent(db, s.workflowId, 'handoff_resolved', { decision: ev.decision });
      if (ev.decision === 'close') {
        await closeOthers(s, null, 'closed_by_staff');
        return { ...noCurrent, live: [], widenAt: null, handoffOpen: false, outcome: 'closed', route: 'end' };
      }
      return { ...noCurrent, handoffOpen: false, handoffReason: null, route: 'waitlist_search' };
    }))
    .addNode('slot_unavailable', node('slot_unavailable', async s => {
      await transitionOffer(db, s.offerId!, ['pending', 'accepted'], 'slot_unavailable', now());
      await send(s, `notice:unavailable:${s.offerId}`, T.slotUnavailable());
      await closeConversation(db, s.conversationId);
      await closeOthers(s, s.offerId, 'slot_unavailable');
      await recordEvent(db, s.workflowId, 'workflow_completed', { outcome: 'slot_unavailable' });
      return { live: [], widenAt: null, outcome: 'slot_unavailable', route: 'end' };
    }))
    .addNode('workflow_failed', node('workflow_failed', async s => {
      if (s.offerId) await transitionOffer(db, s.offerId, ['pending', 'accepted'], 'failed', now());
      await deps.handoff.open({ workflowId: s.workflowId, conversationId: s.conversationId, patientId: s.candidate?.patientId ?? null, reason: `workflow_failed: ${s.error ?? 'unknown'}`.slice(0, 200) });
      if (s.candidate && s.offerId) await send(s, `notice:failed:${s.offerId}`, T.bookingFailed(cfg.clinic.phoneDisplay));
      await closeConversation(db, s.conversationId, 'handoff');
      await closeOthers(s, s.offerId, 'workflow_failed');
      await recordEvent(db, s.workflowId, 'workflow_completed', { outcome: 'failed', error: s.error });
      return { live: [], widenAt: null, outcome: 'failed', route: 'end' };
    }))
    .addNode('workflow_exhausted', node('workflow_exhausted', async s => {
      await recordEvent(db, s.workflowId, 'workflow_completed', { outcome: 'exhausted', tried: s.triedWaitlistIds.length });
      return { outcome: 'exhausted', route: 'end' };
    }));

  const NODES = ['waitlist_search', 'candidate_selected', 'offer_created', 'message_sent', 'awaiting_patient_response', 'patient_response_interpretation',
    'clarification_sent', 'availability_verification', 'booking', 'awaiting_booking_reconciliation', 'confirmation', 'offer_declined', 'offer_expired',
    'human_handoff', 'awaiting_human', 'handoff_resolved', 'slot_unavailable', 'workflow_failed', 'workflow_exhausted'] as const;
  const pathMap = Object.fromEntries([...NODES.map(n => [n, n]), ['end', END]]) as Record<string, string>;
  const byRoute = (s: RecoveryStateType) => (s.route && s.route in pathMap ? s.route : 'workflow_failed');

  const wired = g.addEdge(START, 'cancellation_detected');
  for (const n of ['cancellation_detected', ...NODES] as const) (wired as any).addConditionalEdges(n, byRoute, pathMap);
  return wired.compile({ checkpointer });
}

export type RecoveryGraph = ReturnType<typeof buildRecoveryGraph>;
