// Patient-initiated cancellations and reschedules over WhatsApp.
//
// The LLM extracts intent + requested date/time. Everything else is deterministic:
//   which appointment (only the patient's own, future, scheduled ones), cut-off policy, opening hours,
//   free slots (live calendar via MCP), explicit "yes" before any change, and the calendar writes.
//
// Durable state machine (patient_requests):
//   awaiting_selection -> awaiting_confirmation -> executing -> completed
//                                   \-> declined / expired / superseded / handoff / failed
// Execution is idempotent and resumable (step column):
//   reschedule: none -> new_event_created (create new event by ref, verify, insert appointment)
//               -> old_event_released (edit old event: "[CANCELLED]" + free) -> done (old slot goes to recovery)
//   cancel:     none -> old_event_released -> done (slot goes to recovery = offered to the waiting list)
// The MCP's `rm` (delete) always requires human approval, so events are never deleted automatically:
// a cancelled event is edited (title marker + shown as free), which needs no approval for attendee-less events.
import { withTx, isUniqueViolation, type Db } from '../database/pool.ts';
import { CalendarError, errMsg } from '../shared/errors.ts';
import { newCalendarRef } from '../shared/ids.ts';
import type { Logger } from '../shared/logger.ts';
import { formatSlot, fromLocalWallClock, localDate, toLocalWallClock } from '../shared/time.ts';
import type { CalendarPort } from '../integrations/outlook-mcp/types.ts';
import type { FollowUp } from '../agents/types.ts';
import type { WorkflowRunner } from '../workflows/runner.ts';
import type { MessagingService } from './messaging-service.ts';
import type { HandoffService } from './handoff-service.ts';
import { parseOpeningHours, suggestSlots, isSlotFree, type AvailabilityQuery, type OpeningHours, type Slot } from './availability.ts';
import { recordEvent } from './workflow-events.ts';
import { maskedName } from './templates.ts';
import { isSuspicious } from '../agents/guardrails.ts';
import { mentionsTime } from '../agents/time-mention.ts';
import { RulesConfirmationJudge, type ConfirmationJudge } from '../agents/jev/confirmation.ts';


export interface RequestRow {
  id: string;
  patientId: string;
  conversationId: string | null;
  kind: 'cancel' | 'reschedule';
  status: string;
  appointmentId: string | null;
  options: { start: string; end: string }[];
  chosenStart: Date | null;
  chosenEnd: Date | null;
  newCalendarRef: string | null;
  newAppointmentId: string | null;
  step: 'none' | 'new_event_created' | 'old_event_released' | 'done';
  attempts: number;
  expiresAt: Date;
}

const mapReq = (x: any): RequestRow => ({
  id: x.id, patientId: x.patient_id, conversationId: x.conversation_id, kind: x.kind, status: x.status, appointmentId: x.appointment_id,
  options: x.options ?? [], chosenStart: x.chosen_start, chosenEnd: x.chosen_end, newCalendarRef: x.new_calendar_ref, newAppointmentId: x.new_appointment_id,
  step: x.step, attempts: x.attempts, expiresAt: x.expires_at,
});

export interface Appt { id: string; startsAt: Date; endsAt: Date; treatmentId: string; treatment: string; duration: number; calendarRef: string | null; graphId?: string | null }

export interface RequestContext {
  patientId: string;
  fullName: string;
  conversationId: string | null;
  eventId: string;
  correlationId: string;
  text: string;
  turn: FollowUp;
}

export class PatientRequestService {
  private o: { db: Db; calendar: CalendarPort; runner: WorkflowRunner; messaging: MessagingService; handoff: HandoffService; log: Logger; now: () => Date; tz: string; openingHours: string; minLeadMinutes: number; ttlMinutes: number; clinicPhone: string; maxAttempts?: number; confirmation?: ConfirmationJudge };
  private hours: OpeningHours;
  constructor(o: PatientRequestService['o']) {
    this.o = o;
    this.hours = parseOpeningHours(o.openingHours);
  }

  private get db() { return this.o.db; }
  private slot(d: Date) { return formatSlot(d, this.o.tz, this.o.now()); }

  async openRequest(patientId: string): Promise<RequestRow | null> {
    const r = await this.db.query(`SELECT * FROM patient_requests WHERE patient_id = $1 AND status IN ('awaiting_selection', 'awaiting_confirmation', 'executing')`, [patientId]);
    if (!r.rowCount) return null;
    const req = mapReq(r.rows[0]);
    if (req.status !== 'executing' && req.expiresAt.getTime() <= this.o.now().getTime()) {
      await this.setStatus(req.id, 'expired');
      return null;
    }
    return req;
  }

  /** Text of the proposal the patient is answering (fed to the LLM as context). */
  async pendingProposal(patientId: string): Promise<string | null> {
    const req = await this.openRequest(patientId);
    if (!req || req.status !== 'awaiting_confirmation') return null;
    const appt = req.appointmentId ? await this.appointment(req.appointmentId) : null;
    if (req.kind === 'cancel' && appt) return `Cancel the ${appt.treatment} ${this.slot(appt.startsAt)}?`;
    if (req.chosenStart && appt) return `Move the ${appt.treatment} from ${this.slot(appt.startsAt)} to ${this.slot(req.chosenStart)}?`;
    if (!req.options.length) return 'Asked the patient which day and time would suit them for the new appointment.';
    return `Move the appointment to one of: ${req.options.map(o => this.slot(new Date(o.start))).join('; ')}`;
  }

  async upcoming(patientId: string): Promise<Appt[]> {
    const r = await this.db.query(
      `SELECT a.id, a.starts_at, a.ends_at, a.treatment_id, a.calendar_ref, a.outlook_event_id, t.name, t.duration_minutes FROM appointments a JOIN treatments t ON t.id = a.treatment_id
        WHERE a.patient_id = $1 AND a.status = 'scheduled' AND a.starts_at > $2 ORDER BY a.starts_at LIMIT 10`,
      [patientId, this.o.now()],
    );
    return r.rows.map(x => ({ id: x.id, startsAt: x.starts_at, endsAt: x.ends_at, treatmentId: x.treatment_id, treatment: x.name, duration: x.duration_minutes, calendarRef: x.calendar_ref, graphId: x.outlook_event_id ?? null }));
  }

  private async appointment(id: string): Promise<Appt | null> {
    const r = await this.db.query(`SELECT a.id, a.starts_at, a.ends_at, a.treatment_id, a.calendar_ref, a.outlook_event_id, a.status, t.name, t.duration_minutes FROM appointments a JOIN treatments t ON t.id = a.treatment_id WHERE a.id = $1`, [id]);
    const x = r.rows[0];
    return x ? { id: x.id, startsAt: x.starts_at, endsAt: x.ends_at, treatmentId: x.treatment_id, treatment: x.name, duration: x.duration_minutes, calendarRef: x.calendar_ref, graphId: x.outlook_event_id ?? null } : null;
  }

  private async setStatus(id: string, status: string, extra: Record<string, unknown> = {}) {
    const cols = Object.keys(extra);
    await this.db.query(`UPDATE patient_requests SET status = $2, updated_at = now()${cols.map((c, i) => `, ${c} = $${i + 3}`).join('')} WHERE id = $1`, [id, status, ...cols.map(c => extra[c])]);
  }

  private reply(ctx: { patientId: string; conversationId: string | null; correlationId: string }, key: string, text: string) {
    return this.o.messaging.send({ patientId: ctx.patientId, conversationId: ctx.conversationId, offerId: null, idempotencyKey: key, text, correlationId: ctx.correlationId });
  }

  private query(appt: Appt, patientId: string, otherBusy: Slot[]): AvailabilityQuery {
    return { calendar: this.o.calendar, tz: this.o.tz, hours: this.hours, now: this.o.now(), minLeadMinutes: this.o.minLeadMinutes, durationMinutes: appt.duration, ignoreRefs: appt.calendarRef ? [appt.calendarRef] : [], ignoreGraphIds: appt.graphId ? [appt.graphId] : [], extraBusy: otherBusy };
  }

  /** The patient's other scheduled appointments block their own new time. */
  private async otherBusy(patientId: string, exceptId: string): Promise<Slot[]> {
    const r = await this.db.query(`SELECT starts_at, ends_at FROM appointments WHERE patient_id = $1 AND status = 'scheduled' AND id <> $2`, [patientId, exceptId]);
    return r.rows.map(x => ({ start: x.starts_at, end: x.ends_at }));
  }

  /**
   * Handles a message when it is (or continues) a cancel/reschedule conversation.
   * Returns a short note for the inbound log, or null when the message is not about a request.
   */
  async handle(ctx: RequestContext): Promise<string | null> {
    let { turn } = ctx;
    let req = await this.openRequest(ctx.patientId);
    const key = (suffix: string) => `request:${ctx.eventId}:${suffix}`;

    if (req?.status === 'executing') {
      await this.reply(ctx, key('busy'), `Still working on it. I'll let you know as soon as it's done.`);
      return 'request_in_progress';
    }

    // Choosing one of the numbered appointments ("2") while we wait for a selection.
    const num = /^\s*([1-9])\s*[.)]?\s*$/.exec(ctx.text);
    if (req?.status === 'awaiting_selection' && num && !req.appointmentId) {
      const list = await this.upcoming(ctx.patientId);
      const pick = list[Number(num[1]) - 1];
      if (pick) return this.proceed(ctx, req, pick, turn, key);
    }

    // Any answer to a single, concrete proposal goes through the same confirmation judge as the tool agent.
    if (req?.status === 'awaiting_confirmation' && req.appointmentId && !['reject', 'cancel_request', 'reschedule_request'].includes(turn.category)
      && (req.kind === 'cancel' || req.options.length === 1)) {
      const d = isSuspicious(ctx.text)
        ? { verdict: 'unclear' as const, confidence: 1, by: 'injection_guard', latencyMs: 0, costUsd: 0 }
        : await (this.o.confirmation ?? new RulesConfirmationJudge()).judge((await this.pendingProposal(ctx.patientId)) ?? '', ctx.text);
      await recordEvent(this.db, null, 'confirmation_judged', { requestId: req.id, verdict: d.verdict, confidence: d.confidence, by: d.by, latencyMs: d.latencyMs, costUsd: d.costUsd });
      if (d.verdict === 'confirm') {
        if (req.kind === 'reschedule') await this.setStatus(req.id, 'awaiting_confirmation', { chosen_start: new Date(req.options[0].start), chosen_end: new Date(req.options[0].end) });
        return this.execute(req.id, ctx);
      }
      if (d.verdict === 'decline') turn = { ...turn, category: 'reject' };
    }

    if (turn.category === 'reject' && req) {
      await this.setStatus(req.id, 'declined');
      const appt = req.appointmentId ? await this.appointment(req.appointmentId) : null;
      await this.reply(ctx, key('declined'), appt ? `No problem, your ${appt.treatment.toLowerCase()} stays ${this.slot(appt.startsAt)} 😊` : `No problem, nothing has been changed.`);
      return 'request_declined';
    }

    if (req?.status === 'awaiting_confirmation' && (turn.category === 'confirm' || turn.category === 'reschedule_request')) {
      const appt = req.appointmentId ? await this.appointment(req.appointmentId) : null;
      if (!appt) { await this.setStatus(req.id, 'failed', { last_error: 'appointment missing' }); return null; }
      if (req.kind === 'reschedule') {
        const chosen = this.matchOption(req, turn, appt);
        if (chosen) {
          await this.setStatus(req.id, 'awaiting_confirmation', { chosen_start: new Date(chosen.start), chosen_end: new Date(chosen.end) });
          return this.execute(req.id, ctx);
        }
        if (turn.category === 'confirm') {
          await this.reply(ctx, key('which'), `Which time works best for you: ${this.optionText(req.options)}?`);
          return 'request_needs_choice';
        }
        // A new time was proposed: search again for the same appointment.
        return this.proceed(ctx, req, appt, turn, key);
      }
    }

    if (turn.category !== 'cancel_request' && turn.category !== 'reschedule_request') {
      if (req?.status === 'awaiting_selection' && req.appointmentId == null && turn.appointmentDate) {
        const match = (await this.upcoming(ctx.patientId)).filter(a => localDate(a.startsAt, this.o.tz) === turn.appointmentDate);
        if (match.length === 1) return this.proceed(ctx, req, match[0], turn, key);
      }
      return null;
    }

    // New cancel/reschedule request (supersedes an unfinished one).
    const kind = turn.category === 'cancel_request' ? 'cancel' : 'reschedule';
    if (req && req.kind !== kind) { await this.setStatus(req.id, 'superseded'); req = null; }
    const list = await this.upcoming(ctx.patientId);
    if (!list.length) {
      await this.reply(ctx, key('none'), `I can't see any upcoming appointment under this number. If that doesn't sound right, the team can check on ${this.o.clinicPhone}.`);
      return 'request_no_appointment';
    }
    let target: Appt | null = null;
    if (req?.appointmentId) target = list.find(a => a.id === req!.appointmentId) ?? null;
    if (turn.appointmentDate) {
      const m = list.filter(a => localDate(a.startsAt, this.o.tz) === turn.appointmentDate);
      if (m.length === 1) target = m[0];
    }
    if (!target && list.length === 1) target = list[0];
    if (!req) req = await this.create(ctx, kind);
    if (!req) return 'request_conflict';
    if (!target) {
      await this.setStatus(req.id, 'awaiting_selection');
      await this.reply(ctx, key('select'), `Sure. Which one do you mean?\n${list.map((a, i) => `${i + 1}) ${a.treatment} ${this.slot(a.startsAt)}`).join('\n')}`);
      return 'request_awaiting_selection';
    }
    return this.proceed(ctx, req, target, turn, key);
  }

  private async create(ctx: RequestContext, kind: 'cancel' | 'reschedule'): Promise<RequestRow | null> {
    try {
      const r = await this.db.query(
        `INSERT INTO patient_requests (patient_id, conversation_id, kind, expires_at) VALUES ($1, $2, $3, $4) RETURNING *`,
        [ctx.patientId, ctx.conversationId, kind, new Date(this.o.now().getTime() + this.o.ttlMinutes * 60000)],
      );
      await recordEvent(this.db, null, 'patient_request_opened', { requestId: r.rows[0].id, kind });
      return mapReq(r.rows[0]);
    } catch (e) {
      if (isUniqueViolation(e, 'patient_requests_one_open_uq')) return this.openRequest(ctx.patientId);
      throw e;
    }
  }

  private optionText(opts: { start: string }[]) {
    const s = opts.map(o => this.slot(new Date(o.start)));
    return s.length > 1 ? `${s.slice(0, -1).join(', ')} or ${s[s.length - 1]}` : s[0];
  }

  private matchOption(req: RequestRow, turn: FollowUp, appt: Appt): { start: string; end: string } | null {
    if (turn.category === 'confirm' && req.options.length === 1 && !turn.targetTime) return req.options[0];
    if (!turn.targetTime) return null;
    return req.options.find(o => {
      const local = toLocalWallClock(new Date(o.start), this.o.tz);
      return local.slice(11) === turn.targetTime && (!turn.targetDate || local.slice(0, 10) === turn.targetDate);
    }) ?? null;
  }

  /** Appointment chosen: apply cut-off, then ask to confirm (cancel) or search the calendar (reschedule). */
  private async proceed(ctx: RequestContext, req: RequestRow, appt: Appt, turn: FollowUp, key: (s: string) => string): Promise<string> {
    if (appt.startsAt.getTime() < this.o.now().getTime() + this.o.minLeadMinutes * 60000) {
      await this.setStatus(req.id, 'handoff', { appointment_id: appt.id });
      await this.o.handoff.open({ workflowId: null, conversationId: ctx.conversationId, patientId: ctx.patientId, reason: `${req.kind}_too_close_to_start` });
      await this.reply(ctx, key('late'), `That one is very soon, so I can't change it from here. Please give the clinic a call on ${this.o.clinicPhone} and they'll sort it out.`);
      return 'request_too_late';
    }
    const ttl = new Date(this.o.now().getTime() + this.o.ttlMinutes * 60000);
    if (req.kind === 'cancel') {
      await this.setStatus(req.id, 'awaiting_confirmation', { appointment_id: appt.id, expires_at: ttl });
      await this.reply(ctx, key('confirm_cancel'), `Sure, you'd like to cancel your ${appt.treatment.toLowerCase()} ${this.slot(appt.startsAt)}?`);
      return 'request_awaiting_cancel_confirmation';
    }
    // Reschedule: live availability from the calendar.
    const q = this.query(appt, ctx.patientId, await this.otherBusy(ctx.patientId, appt.id));
    let options: Slot[];
    let exact = false;
    try {
      const date = turn.targetDate ?? (turn.targetTime ? localDate(appt.startsAt, this.o.tz) : null);
      if (date && turn.targetTime) {
        const start = fromLocalWallClock(`${date}T${turn.targetTime}`, this.o.tz);
        exact = await isSlotFree(start, q);
        options = exact ? [{ start, end: new Date(start.getTime() + appt.duration * 60000) }] : await suggestSlots(date, q, { preferredTime: turn.targetTime, max: 3 });
      } else if (date) {
        options = await suggestSlots(date, q, { timeOfDay: turn.timeOfDay, max: 3 });
      } else {
        await this.setStatus(req.id, 'awaiting_confirmation', { appointment_id: appt.id, options: JSON.stringify([]), expires_at: ttl });
        await this.reply(ctx, key('when'), `Of course. What day and time would suit you better?`);
        return 'request_needs_time';
      }
    } catch (e) {
      this.o.log.warn('request.availability_unknown', { requestId: req.id, error: errMsg(e) });
      await this.reply(ctx, key('cal_error'), `Sorry, I can't check the calendar right now. Could you try again in a few minutes? Or call the clinic on ${this.o.clinicPhone}.`);
      return 'request_calendar_unavailable';
    }
    if (!options.length) {
      await this.setStatus(req.id, 'awaiting_confirmation', { appointment_id: appt.id, options: JSON.stringify([]), expires_at: ttl });
      await this.reply(ctx, key('nothing'), `Sorry, there's nothing free then. Is there another day that works for you?`);
      return 'request_no_slots';
    }
    const opts = options.map(o => ({ start: o.start.toISOString(), end: o.end.toISOString() }));
    await this.setStatus(req.id, 'awaiting_confirmation', { appointment_id: appt.id, options: JSON.stringify(opts), expires_at: ttl });
    await recordEvent(this.db, null, 'reschedule_options', { requestId: req.id, exact, options: opts });
    const text = exact
      ? `${this.slot(options[0].start).replace(/^./, c => c.toUpperCase())} is free. Want me to move your ${appt.treatment.toLowerCase()} there?`
      : turn.targetTime
        ? `That time isn't available, but I can do ${this.optionText(opts)}. Which works for you?`
        : `I can do ${this.optionText(opts)}. Which works for you?`;
    await this.reply(ctx, key('options'), text);
    return exact ? 'request_awaiting_reschedule_confirmation' : 'request_options_sent';
  }

  /** Executes (or resumes) a confirmed request. Idempotent; safe to call from the sweeper. */
  async execute(requestId: string, ctx?: Pick<RequestContext, 'correlationId'> & { conversationId?: string | null; notify?: boolean }): Promise<string> {
    const claim = await this.db.query(
      // next_attempt_at doubles as a lease: nobody re-claims a request while an attempt is in flight.
      `UPDATE patient_requests SET status = 'executing', attempts = attempts + 1, next_attempt_at = $3, updated_at = now()
        WHERE id = $1 AND (status = 'awaiting_confirmation' OR (status = 'executing' AND (next_attempt_at IS NULL OR next_attempt_at <= $2))) RETURNING *`,
      [requestId, this.o.now(), new Date(this.o.now().getTime() + 120_000)],
    ).catch(e => { if (isUniqueViolation(e, 'patient_requests_one_exec_per_appt_uq')) return { rowCount: 0, rows: [] }; throw e; });
    if (!claim.rowCount) return 'request_not_claimed';
    const req = mapReq(claim.rows[0]);
    const p = (await this.db.query('SELECT full_name FROM patients WHERE id = $1', [req.patientId])).rows[0];
    // notify=false: the tool agent words the outcome itself (later sweeper retries always notify).
    const c = { patientId: req.patientId, conversationId: ctx?.conversationId ?? req.conversationId, correlationId: ctx?.correlationId ?? `request-${req.id}`, notify: ctx?.notify ?? true };
    const appt = await this.appointment(req.appointmentId!);
    if (!appt) { await this.setStatus(req.id, 'failed', { last_error: 'appointment missing' }); return 'request_failed'; }
    const date = localDate(appt.startsAt, this.o.tz);
    try {
      let step = req.step;
      if (req.kind === 'reschedule' && step === 'none') {
        if (!req.chosenStart || !req.chosenEnd) throw new Error('no chosen slot');
        const ref = req.newCalendarRef ?? newCalendarRef();
        if (!req.newCalendarRef) await this.db.query(`UPDATE patient_requests SET new_calendar_ref = $2 WHERE id = $1`, [req.id, ref]);
        const newDate = localDate(req.chosenStart, this.o.tz);
        const listing = await this.o.calendar.listEvents(newDate, newDate);
        if (!listing.complete) throw new CalendarError('incomplete', 'listing truncated');
        if (!listing.events.some(e => e.ref === ref && !e.cancelled)) {
          // Re-check right before writing: the slot may have been taken since we offered it.
          const q = this.query(appt, req.patientId, await this.otherBusy(req.patientId, appt.id));
          if (!(await isSlotFree(req.chosenStart, q))) {
            await this.setStatus(req.id, 'awaiting_confirmation', { options: JSON.stringify([]), chosen_start: null, chosen_end: null });
            if (c.notify) await this.reply(c, `request:${req.id}:taken:${req.attempts}`, `Sorry, that time was just taken. Is there another day or time that suits you?`);
            return 'request_slot_taken';
          }
          const created = await this.o.calendar.createEvent({
            ref, title: `${ref} · ${appt.treatment} · ${maskedName(p.full_name)}`, start: toLocalWallClock(req.chosenStart, this.o.tz),
            durationMinutes: appt.duration, description: `Rescheduled by the patient over WhatsApp (fictional clinic). Ref ${ref}.`,
          });
          if (created.status === 'approval_required') return this.toHuman(req, c, 'calendar_approval_required');
        }
        const verify = await this.o.calendar.listEvents(newDate, newDate);
        const mine = verify.events.find(e => e.ref === ref && !e.cancelled);
        if (!mine) throw new CalendarError('transient', 'new event not visible yet');
        await withTx(this.db, async tx => {
          const a = await tx.query(
            `INSERT INTO appointments (patient_id, treatment_id, calendar_ref, outlook_event_id, starts_at, ends_at, status, source) VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', 'reschedule')
             ON CONFLICT (calendar_ref) DO UPDATE SET outlook_event_id = COALESCE(appointments.outlook_event_id, EXCLUDED.outlook_event_id), updated_at = now() RETURNING id`,
            [req.patientId, appt.treatmentId, ref, mine.graphId, req.chosenStart, req.chosenEnd],
          );
          await tx.query(`UPDATE patient_requests SET step = 'new_event_created', new_appointment_id = $2 WHERE id = $1`, [req.id, a.rows[0].id]);
        });
        step = 'new_event_created';
      }
      if (step === 'none' || step === 'new_event_created') {
        if (appt.calendarRef) {
          const u = await this.o.calendar.updateEvent({ ref: appt.calendarRef, graphId: appt.graphId, date, title: `[CANCELLED] ${appt.calendarRef} · ${appt.treatment} · ${maskedName(p.full_name)}`, free: true });
          if (u.status === 'approval_required') return this.toHuman(req, c, 'calendar_approval_required');
          const check = await this.o.calendar.listEvents(date, date);
          if (check.events.some(e => (e.ref === appt.calendarRef || (!!appt.graphId && e.graphId === appt.graphId)) && !e.cancelled && e.showAs !== 'free')) throw new CalendarError('transient', 'old event still busy after edit');
        }
        await this.db.query(`UPDATE patient_requests SET step = 'old_event_released' WHERE id = $1`, [req.id]);
        step = 'old_event_released';
      }
      if (step === 'old_event_released') {
        // The freed slot goes straight to the recovery workflow (offered to the waiting list).
        let workflowId: string | null = null;
        try {
          const r = await this.o.runner.startForCancellation({
            appointmentId: appt.id, source: 'patient', observation: req.kind === 'cancel' ? 'patient_cancel' : 'patient_reschedule',
            finalStatus: req.kind === 'cancel' ? 'cancelled' : 'rescheduled', details: { requestId: req.id }, correlationId: c.correlationId,
          });
          workflowId = r.workflowId;
        } catch (e) {
          const st = (await this.db.query(`SELECT status FROM appointments WHERE id = $1`, [appt.id])).rows[0]?.status;
          if (st === 'scheduled') throw e; // nothing recorded yet: retry later
          this.o.log.warn('request.recovery_start_failed', { requestId: req.id, error: errMsg(e) }); // recorded; the sweeper continues the workflow
          workflowId = (await this.db.query(`SELECT id FROM recovery_workflows WHERE cancelled_appointment_id = $1`, [appt.id])).rows[0]?.id ?? null;
        }
        await this.db.query(`UPDATE patient_requests SET step = 'done', status = 'completed', workflow_id = $2, last_error = NULL, updated_at = now() WHERE id = $1`, [req.id, workflowId]);
        await recordEvent(this.db, workflowId, 'patient_request_completed', { requestId: req.id, kind: req.kind, appointmentId: appt.id, newAppointmentId: req.newAppointmentId });
        const text = req.kind === 'cancel'
          ? `Done, your ${appt.treatment.toLowerCase()} ${this.slot(appt.startsAt)} is cancelled. If you'd like to book again, just message us.`
          : `All set! Your ${appt.treatment.toLowerCase()} is now ${this.slot(req.chosenStart!)}. See you then 😊`;
        if (c.notify) await this.reply(c, `request:${req.id}:done`, text);
        return 'request_completed';
      }
      return 'request_noop';
    } catch (e) {
      const max = this.o.maxAttempts ?? 5;
      if (req.attempts >= max) return this.toHuman(req, c, `execution_failed: ${errMsg(e)}`.slice(0, 200));
      const next = new Date(this.o.now().getTime() + Math.min(5000 * 2 ** (req.attempts - 1), 300000));
      await this.db.query(`UPDATE patient_requests SET last_error = $2, next_attempt_at = $3, updated_at = now() WHERE id = $1`, [req.id, errMsg(e).slice(0, 500), next]);
      this.o.log.warn('request.retry_scheduled', { requestId: req.id, attempts: req.attempts, error: errMsg(e) });
      if (req.attempts === 1 && c.notify) await this.reply(c, `request:${req.id}:delayed`, `I'm having trouble reaching the calendar right now, so nothing has changed yet. I'll keep trying and let you know once it's done.`);
      return 'request_retry_scheduled';
    }
  }

  private async toHuman(req: RequestRow, c: { patientId: string; conversationId: string | null; correlationId: string; notify?: boolean }, reason: string): Promise<string> {
    await this.setStatus(req.id, 'handoff', { last_error: reason });
    await this.o.handoff.open({ workflowId: null, conversationId: c.conversationId, patientId: req.patientId, reason: `patient_${req.kind}: ${reason}`.slice(0, 200) });
    const changed = req.step !== 'none';
    if (c.notify !== false) await this.reply(c, `request:${req.id}:handoff`, changed
      ? `Sorry, I couldn't finish this change on my own. The team has the details, but please call ${this.o.clinicPhone} to make sure everything is right.`
      : `Sorry, I couldn't do this on my own, so nothing has changed. Please call the clinic on ${this.o.clinicPhone} and they'll help.`);
    return 'request_handoff';
  }

  // ------------------------------------------------------------------------------------------------
  // Tool-facing operations (used by the function-calling agent). They return data instead of sending
  // messages, and enforce every rule themselves: the model can only ask, never bypass.

  /** The patient's own appointment, or null (ownership check for every tool call). */
  async ownAppointment(patientId: string, appointmentId: string): Promise<Appt | null> {
    return (await this.upcoming(patientId)).find(a => a.id === appointmentId) ?? null;
  }

  tooClose(appt: Appt) { return appt.startsAt.getTime() < this.o.now().getTime() + this.o.minLeadMinutes * 60000; }

  async availabilityFor(patientId: string, appt: Appt, date: string, preferredTime: string | null, timeOfDay: 'morning' | 'afternoon' | 'evening' | null): Promise<{ requestedTimeFree: boolean | null; options: Slot[] }> {
    const q = this.query(appt, patientId, await this.otherBusy(patientId, appt.id));
    if (preferredTime) {
      const start = fromLocalWallClock(`${date}T${preferredTime}`, this.o.tz);
      if (await isSlotFree(start, q)) return { requestedTimeFree: true, options: [{ start, end: new Date(start.getTime() + appt.duration * 60000) }] };
      return { requestedTimeFree: false, options: await suggestSlots(date, q, { preferredTime, max: 4 }) };
    }
    return { requestedTimeFree: null, options: await suggestSlots(date, q, { timeOfDay, max: 4 }) };
  }

  /** Creates (or replaces) the patient's pending proposal. Nothing changes until it is confirmed. */
  async propose(ctx: { patientId: string; conversationId: string | null }, kind: 'cancel' | 'reschedule', appt: Appt, slot?: Slot): Promise<'proposed' | 'too_close' | 'not_available'> {
    if (this.tooClose(appt)) return 'too_close';
    if (kind === 'reschedule') {
      const q = this.query(appt, ctx.patientId, await this.otherBusy(ctx.patientId, appt.id));
      if (!slot || !(await isSlotFree(slot.start, q))) return 'not_available';
    }
    const open = await this.openRequest(ctx.patientId);
    if (open?.status === 'executing') throw new Error('a change is already being applied');
    if (open) await this.setStatus(open.id, 'superseded');
    const r = await this.db.query(
      `INSERT INTO patient_requests (patient_id, conversation_id, kind, status, appointment_id, options, chosen_start, chosen_end, expires_at)
       VALUES ($1, $2, $3, 'awaiting_confirmation', $4, $5, $6, $7, $8) RETURNING id`,
      [ctx.patientId, ctx.conversationId, kind, appt.id, JSON.stringify(slot ? [{ start: slot.start.toISOString(), end: slot.end.toISOString() }] : []),
        slot?.start ?? null, slot?.end ?? null, new Date(this.o.now().getTime() + this.o.ttlMinutes * 60000)],
    );
    await recordEvent(this.db, null, 'patient_request_proposed', { requestId: r.rows[0].id, kind, via: 'tool_agent' });
    return 'proposed';
  }

  /**
   * Executes the pending proposal only when the confirmation is plausible:
   *  - the proposal was made BEFORE the current patient message arrived (the model cannot propose and confirm in one go)
   *  - the current message is not a refusal and not a prompt-injection attempt
   */
  async confirmPending(ctx: { patientId: string; conversationId: string | null; correlationId: string; messageReceivedAt: Date; messageText: string }): Promise<{ result: string; request?: RequestRow; appt?: Appt | null }> {
    const req = await this.openRequest(ctx.patientId);
    if (!req || req.status !== 'awaiting_confirmation' || !req.appointmentId) return { result: 'no_pending_change' };
    if (req.kind === 'reschedule' && !req.chosenStart) return { result: 'no_pending_change' };
    const proposedAt = (await this.db.query(`SELECT updated_at FROM patient_requests WHERE id = $1`, [req.id])).rows[0].updated_at as Date;
    // Normally the proposal must come BEFORE the patient's "yes". One exception: picking an offered time.
    // If the clinic's previous message listed this exact time and the patient's message names it
    // ("2:30pm please"), the choice itself is the agreement, so the proposal made in this turn may be confirmed.
    let selection = false;
    if (req.kind === 'reschedule' && req.chosenStart) {
      const hm = toLocalWallClock(req.chosenStart, this.o.tz).slice(11, 16);
      const lastClinic = (await this.db.query(
        `SELECT content FROM messages WHERE patient_id = $1 AND direction = 'outbound' ORDER BY created_at DESC, id DESC LIMIT 1`,
        [ctx.patientId],
      )).rows[0]?.content as string | undefined;
      selection = !!lastClinic && mentionsTime(lastClinic, hm) && mentionsTime(ctx.messageText, hm);
    }
    if (proposedAt.getTime() >= ctx.messageReceivedAt.getTime() && !selection) return { result: 'not_confirmed_by_patient_yet' };
    // Hard floor first (injection heuristics), then the judge (Jev when configured, rules otherwise).
    if (isSuspicious(ctx.messageText)) return { result: 'patient_did_not_clearly_confirm' };
    const judge = this.o.confirmation ?? new RulesConfirmationJudge();
    const d = await judge.judge((await this.pendingProposal(ctx.patientId)) ?? '', ctx.messageText, { selection });
    await recordEvent(this.db, null, 'confirmation_judged', { requestId: req.id, verdict: d.verdict, confidence: d.confidence, by: d.by, latencyMs: d.latencyMs, costUsd: d.costUsd, selection });
    if (d.verdict !== 'confirm') return { result: 'patient_did_not_clearly_confirm' };
    const appt = await this.appointment(req.appointmentId);
    const note = await this.execute(req.id, { correlationId: ctx.correlationId, conversationId: ctx.conversationId, notify: false });
    return { result: note.replace(/^request_/, ''), request: req, appt };
  }

  async withdraw(patientId: string): Promise<boolean> {
    const req = await this.openRequest(patientId);
    if (!req || req.status === 'executing') return false;
    await this.setStatus(req.id, 'declined');
    return true;
  }

  async dueForRetry(): Promise<string[]> {
    const r = await this.db.query(`SELECT id FROM patient_requests WHERE status = 'executing' AND (next_attempt_at IS NULL OR next_attempt_at <= $1) LIMIT 20`, [this.o.now()]);
    return r.rows.map(x => x.id);
  }
}

