// Durable booking state machine.
//
//   reserved --claim--> calendar_pending --(event visible in calendar)--> calendar_created --finalize(tx)--> confirmed
//        \                    |  \--(conflict found)--> released (offer: slot_unavailable)
//         \                   |--(MCP error / timeout / not yet visible)--> needs_reconciliation --retry--> calendar_pending
//          \                  |--(server asks for human confirmation)--> approval_required (human handoff)
//           \                 \--(attempts exhausted)--> failed (human handoff, calendar must be checked by staff)
//
// Why: a PostgreSQL transaction cannot atomically include a Microsoft Graph write. Every step is
// persisted; the calendar event carries the booking's unique calendar_ref, so a retry first LOOKS for
// that ref before creating anything (no duplicate events after timeouts, crashes or restarts).
// DB locks are only held for short local transactions, never while waiting for the MCP.
import { withTx, isUniqueViolation, type Db, type Queryable } from '../database/pool.ts';
import { CalendarError, errMsg } from '../shared/errors.ts';
import { newCalendarRef } from '../shared/ids.ts';
import type { Logger } from '../shared/logger.ts';
import { localDate, toLocalWallClock } from '../shared/time.ts';
import type { CalendarEvent, CalendarPort } from '../integrations/outlook-mcp/types.ts';
import { recordEvent } from './workflow-events.ts';
import { maskedName } from './templates.ts';

export type BookingStatus = 'reserved' | 'calendar_pending' | 'calendar_created' | 'confirmed' | 'needs_reconciliation' | 'approval_required' | 'failed' | 'released';

export interface BookingRow {
  id: string;
  offerId: string;
  workflowId: string;
  slotReference: string;
  patientId: string;
  treatmentId: string;
  startsAt: Date;
  endsAt: Date;
  calendarRef: string;
  status: BookingStatus;
  attempts: number;
  appointmentId: string | null;
  lastError: string | null;
  nextAttemptAt: Date | null;
  updatedAt: Date;
}

const mapBooking = (x: any): BookingRow => ({
  id: x.id, offerId: x.offer_id, workflowId: x.workflow_id, slotReference: x.slot_reference, patientId: x.patient_id, treatmentId: x.treatment_id,
  startsAt: x.starts_at, endsAt: x.ends_at, calendarRef: x.calendar_ref, status: x.status, attempts: x.attempts, appointmentId: x.appointment_id,
  lastError: x.last_error, nextAttemptAt: x.next_attempt_at, updatedAt: x.updated_at,
});

export type ReserveResult =
  | { ok: true; bookingId: string; duplicate: boolean }
  | { ok: false; reason: 'offer_not_found' | 'offer_not_pending' | 'offer_expired' | 'patient_ineligible' | 'slot_taken' };

export type BookingOutcome =
  | { status: 'confirmed'; bookingId: string; appointmentId: string }
  | { status: 'unavailable'; bookingId: string; reason: string }
  | { status: 'pending'; bookingId: string; error: string }
  | { status: 'approval_required'; bookingId: string; preview: string }
  | { status: 'failed'; bookingId: string; reason: string };

export interface BookingConfig {
  timezone: string;
  maxAttempts: number;
  /** A calendar_pending claim older than this is considered abandoned (crash) and may be re-claimed. */
  staleClaimMs: number;
  baseBackoffMs: number;
}

export class BookingService {
  private db: Db;
  private calendar: CalendarPort;
  private cfg: BookingConfig;
  private log: Logger;
  private now: () => Date;

  constructor(db: Db, calendar: CalendarPort, cfg: BookingConfig, log: Logger, now: () => Date) {
    this.db = db;
    this.calendar = calendar;
    this.cfg = cfg;
    this.log = log;
    this.now = now;
  }

  async get(q: Queryable, id: string): Promise<BookingRow | null> {
    const r = await q.query('SELECT * FROM bookings WHERE id = $1', [id]);
    return r.rowCount ? mapBooking(r.rows[0]) : null;
  }

  /** Steps 1-3 + 5: validate offer & patient, then take the DB-level slot reservation (short transaction). */
  async reserve(offerId: string): Promise<ReserveResult> {
    const now = this.now();
    try {
      return await withTx(this.db, async tx => {
        const o = await tx.query('SELECT * FROM appointment_offers WHERE id = $1 FOR UPDATE', [offerId]);
        if (!o.rowCount) return { ok: false as const, reason: 'offer_not_found' as const };
        const offer = o.rows[0];
        const existing = await tx.query('SELECT id FROM bookings WHERE offer_id = $1', [offerId]);
        if (existing.rowCount) return { ok: true as const, bookingId: existing.rows[0].id as string, duplicate: true };
        if (offer.status !== 'pending') return { ok: false as const, reason: 'offer_not_pending' as const };
        // Deadline is checked against the clock, not only the status: the expiry sweeper may not have run yet.
        if (offer.expires_at.getTime() <= now.getTime()) {
          await tx.query(`UPDATE appointment_offers SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [offerId]);
          return { ok: false as const, reason: 'offer_expired' as const };
        }
        const elig = await tx.query(
          `SELECT p.contact_allowed, w.status AS waitlist_status FROM patients p JOIN waitlist w ON w.id = $2 WHERE p.id = $1`,
          [offer.patient_id, offer.waitlist_id],
        );
        if (!elig.rowCount || !elig.rows[0].contact_allowed || elig.rows[0].waitlist_status !== 'waiting') return { ok: false as const, reason: 'patient_ineligible' as const };
        const wf = (await tx.query('SELECT slot_reference, treatment_id, starts_at, ends_at FROM recovery_workflows WHERE id = $1', [offer.workflow_id])).rows[0];
        const ins = await tx.query(
          `INSERT INTO bookings (offer_id, workflow_id, slot_reference, patient_id, treatment_id, starts_at, ends_at, calendar_ref, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved', $9, $9) RETURNING id`,
          [offerId, offer.workflow_id, wf.slot_reference, offer.patient_id, wf.treatment_id, wf.starts_at, wf.ends_at, newCalendarRef(), now],
        );
        await tx.query(`UPDATE appointment_offers SET status = 'accepted', responded_at = $2 WHERE id = $1`, [offerId, now]);
        await recordEvent(tx, offer.workflow_id, 'booking_reserved', { bookingId: ins.rows[0].id, offerId });
        return { ok: true as const, bookingId: ins.rows[0].id as string, duplicate: false };
      });
    } catch (e) {
      if (isUniqueViolation(e, 'bookings_one_active_per_slot_uq')) return { ok: false, reason: 'slot_taken' };
      if (isUniqueViolation(e, 'bookings_offer_id_key')) {
        const ex = await this.db.query('SELECT id FROM bookings WHERE offer_id = $1', [offerId]);
        return { ok: true, bookingId: ex.rows[0].id, duplicate: true };
      }
      throw e;
    }
  }

  private async slotContext(b: BookingRow) {
    const r = await this.db.query(
      `SELECT a.calendar_ref AS cancelled_ref, t.name AS treatment, t.duration_minutes, p.full_name
         FROM recovery_workflows w JOIN appointments a ON a.id = w.cancelled_appointment_id
         JOIN treatments t ON t.id = $2 JOIN patients p ON p.id = $3 WHERE w.id = $1`,
      [b.workflowId, b.treatmentId, b.patientId],
    );
    return r.rows[0] as { cancelled_ref: string | null; treatment: string; duration_minutes: number; full_name: string };
  }

  private conflicts(events: CalendarEvent[], b: BookingRow, cancelledRef: string | null): CalendarEvent[] {
    const s = toLocalWallClock(b.startsAt, this.cfg.timezone), e = toLocalWallClock(b.endsAt, this.cfg.timezone);
    return events.filter(ev => !ev.cancelled && ev.showAs !== 'free' && ev.ref !== b.calendarRef && (!cancelledRef || ev.ref !== cancelledRef) && ev.start < e && ev.end > s);
  }

  /** Step 4: re-check Outlook availability through the MCP (outside any transaction). */
  async checkAvailability(bookingId: string): Promise<'available' | 'unavailable' | 'already_created'> {
    const b = await this.get(this.db, bookingId);
    if (!b) throw new Error('booking not found');
    const ctx = await this.slotContext(b);
    const day = localDate(b.startsAt, this.cfg.timezone);
    const listing = await this.calendar.listEvents(day, day);
    if (!listing.complete) throw new CalendarError('incomplete', 'calendar listing truncated; availability unknown');
    if (listing.events.some(ev => ev.ref === b.calendarRef && !ev.cancelled)) return 'already_created';
    if (this.conflicts(listing.events, b, ctx.cancelled_ref).length) {
      await this.release(b, 'calendar_conflict');
      return 'unavailable';
    }
    return 'available';
  }

  private async release(b: BookingRow, reason: string) {
    await withTx(this.db, async tx => {
      await tx.query(`UPDATE bookings SET status = 'released', last_error = $2, updated_at = now() WHERE id = $1 AND status NOT IN ('confirmed', 'failed')`, [b.id, reason]);
      await tx.query(`UPDATE appointment_offers SET status = 'slot_unavailable' WHERE id = $1 AND status IN ('pending', 'accepted')`, [b.offerId]);
      await recordEvent(tx, b.workflowId, 'booking_released', { bookingId: b.id, reason });
    });
  }

  private backoff(attempts: number) { return Math.min(this.cfg.baseBackoffMs * 2 ** Math.max(0, attempts - 1), 5 * 60_000); }

  private async needsReconciliation(b: BookingRow, error: string): Promise<BookingOutcome> {
    if (b.attempts >= this.cfg.maxAttempts) return this.fail(b, `attempts exhausted: ${error}`);
    const next = new Date(this.now().getTime() + this.backoff(b.attempts));
    await this.db.query(`UPDATE bookings SET status = 'needs_reconciliation', last_error = $2, next_attempt_at = $3, updated_at = now() WHERE id = $1 AND status IN ('calendar_pending', 'reserved')`, [b.id, error.slice(0, 500), next]);
    await recordEvent(this.db, b.workflowId, 'booking_needs_reconciliation', { bookingId: b.id, attempts: b.attempts, error: error.slice(0, 200), nextAttemptAt: next });
    this.log.warn('booking.needs_reconciliation', { bookingId: b.id, workflowId: b.workflowId, attempts: b.attempts, error });
    return { status: 'pending', bookingId: b.id, error };
  }

  private async fail(b: BookingRow, reason: string): Promise<BookingOutcome> {
    await withTx(this.db, async tx => {
      await tx.query(`UPDATE bookings SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1 AND status <> 'confirmed'`, [b.id, reason.slice(0, 500)]);
      await tx.query(`UPDATE appointment_offers SET status = 'failed' WHERE id = $1 AND status IN ('pending', 'accepted')`, [b.offerId]);
      await recordEvent(tx, b.workflowId, 'booking_failed', { bookingId: b.id, calendarRef: b.calendarRef, reason: reason.slice(0, 200) });
    });
    this.log.error('booking.failed', { bookingId: b.id, workflowId: b.workflowId, reason });
    return { status: 'failed', bookingId: b.id, reason };
  }

  /** Steps 6-8: create (or adopt) the calendar event, verify it, then persist the result. Safe to call repeatedly. */
  async execute(bookingId: string): Promise<BookingOutcome> {
    let b = await this.get(this.db, bookingId);
    if (!b) throw new Error('booking not found');
    switch (b.status) {
      case 'confirmed': return { status: 'confirmed', bookingId, appointmentId: b.appointmentId! };
      case 'failed': return { status: 'failed', bookingId, reason: b.lastError ?? 'failed' };
      case 'released': return { status: 'unavailable', bookingId, reason: b.lastError ?? 'released' };
      case 'approval_required': return { status: 'approval_required', bookingId, preview: b.lastError ?? '' };
      case 'calendar_created': return this.finalize(b, null);
    }
    const now = this.now();
    const claim = await this.db.query(
      `UPDATE bookings SET status = 'calendar_pending', attempts = attempts + 1, updated_at = $2
        WHERE id = $1 AND (status IN ('reserved', 'needs_reconciliation') OR (status = 'calendar_pending' AND updated_at < $3)) RETURNING *`,
      [bookingId, now, new Date(now.getTime() - this.cfg.staleClaimMs)],
    );
    if (!claim.rowCount) return { status: 'pending', bookingId, error: 'booking is being processed by another worker' };
    b = mapBooking(claim.rows[0]);
    const ctx = await this.slotContext(b);
    const day = localDate(b.startsAt, this.cfg.timezone);

    // Idempotency check first: did a previous (timed-out / crashed) attempt already create the event?
    let events: CalendarEvent[];
    try {
      const listing = await this.calendar.listEvents(day, day);
      if (!listing.complete) return this.needsReconciliation(b, 'calendar listing truncated');
      events = listing.events;
    } catch (e) {
      return this.needsReconciliation(b, `pre-create listing failed: ${errMsg(e)}`);
    }
    const mine = events.find(ev => ev.ref === b!.calendarRef && !ev.cancelled);
    if (mine) return this.markCreatedAndFinalize(b, mine.graphId, 'adopted_existing_event');
    if (this.conflicts(events, b, ctx.cancelled_ref).length) {
      await this.release(b, 'calendar_conflict');
      return { status: 'unavailable', bookingId, reason: 'calendar_conflict' };
    }

    let created;
    try {
      created = await this.calendar.createEvent({
        ref: b.calendarRef,
        title: `${b.calendarRef} · ${ctx.treatment} · ${maskedName(ctx.full_name)}`,
        start: toLocalWallClock(b.startsAt, this.cfg.timezone),
        durationMinutes: Math.round((b.endsAt.getTime() - b.startsAt.getTime()) / 60000),
        description: `Booked by Waitlist Fill Agent (fictional clinic, synthetic data). Ref ${b.calendarRef}.`,
      });
    } catch (e) {
      // Outcome unknown (e.g. timeout after the server created it): the next attempt lists before creating.
      return this.needsReconciliation(b, `create failed: ${errMsg(e)}`);
    }
    if (created.status === 'approval_required') {
      await this.db.query(`UPDATE bookings SET status = 'approval_required', last_error = $2, updated_at = now() WHERE id = $1`, [b.id, created.preview.slice(0, 500)]);
      await recordEvent(this.db, b.workflowId, 'booking_approval_required', { bookingId: b.id });
      return { status: 'approval_required', bookingId, preview: created.preview };
    }

    // Verify: never claim success until the event is actually visible in the calendar.
    try {
      const after = await this.calendar.listEvents(day, day);
      const seen = after.events.find(ev => ev.ref === b!.calendarRef && !ev.cancelled);
      if (!seen) return this.needsReconciliation(b, 'event not visible after create');
      return this.markCreatedAndFinalize(b, seen.graphId ?? created.graphId, 'created');
    } catch (e) {
      return this.needsReconciliation(b, `verification listing failed: ${errMsg(e)}`);
    }
  }

  private async markCreatedAndFinalize(b: BookingRow, graphId: string | null, how: string): Promise<BookingOutcome> {
    await this.db.query(`UPDATE bookings SET status = 'calendar_created', outlook_event_id = COALESCE($2, outlook_event_id), updated_at = now() WHERE id = $1 AND status IN ('calendar_pending', 'needs_reconciliation', 'reserved')`, [b.id, graphId]);
    await recordEvent(this.db, b.workflowId, 'calendar_event_verified', { bookingId: b.id, calendarRef: b.calendarRef, how });
    return this.finalize({ ...b, status: 'calendar_created' }, graphId);
  }

  /** Persist booking result atomically (local DB only). Idempotent: re-running after a crash is safe. */
  private async finalize(b: BookingRow, graphId: string | null): Promise<BookingOutcome> {
    try {
      return await withTx(this.db, async tx => {
        const cur = mapBooking((await tx.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [b.id])).rows[0]);
        if (cur.status === 'confirmed') return { status: 'confirmed' as const, bookingId: b.id, appointmentId: cur.appointmentId! };
        const appt = await tx.query(
          `INSERT INTO appointments (patient_id, treatment_id, outlook_event_id, calendar_ref, starts_at, ends_at, status, source)
           VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', 'recovery')
           ON CONFLICT (calendar_ref) DO UPDATE SET updated_at = now() RETURNING id`,
          [cur.patientId, cur.treatmentId, graphId ?? (await tx.query('SELECT outlook_event_id FROM bookings WHERE id = $1', [b.id])).rows[0].outlook_event_id, cur.calendarRef, cur.startsAt, cur.endsAt],
        );
        const appointmentId = appt.rows[0].id as string;
        await tx.query(`UPDATE bookings SET status = 'confirmed', appointment_id = $2, last_error = NULL, updated_at = now() WHERE id = $1`, [b.id, appointmentId]);
        await tx.query(`UPDATE appointment_offers SET status = 'confirmed' WHERE id = $1 AND status IN ('accepted', 'pending')`, [cur.offerId]);
        await tx.query(`UPDATE waitlist SET status = 'booked' WHERE id = (SELECT waitlist_id FROM appointment_offers WHERE id = $1)`, [cur.offerId]);
        await recordEvent(tx, cur.workflowId, 'booking_confirmed', { bookingId: b.id, appointmentId, calendarRef: cur.calendarRef });
        return { status: 'confirmed' as const, bookingId: b.id, appointmentId };
      });
    } catch (e) {
      // Calendar event exists but the DB write failed: stays calendar_created; the reconciler finalizes later.
      this.log.error('booking.finalize_failed', { bookingId: b.id, error: errMsg(e) });
      await this.db.query(`UPDATE bookings SET next_attempt_at = $3, last_error = $2 WHERE id = $1`, [b.id, `finalize failed: ${errMsg(e)}`.slice(0, 500), new Date(this.now().getTime() + this.backoff(1))]).catch(() => {});
      return { status: 'pending', bookingId: b.id, error: `finalize failed: ${errMsg(e)}` };
    }
  }

  async dueForReconciliation(): Promise<BookingRow[]> {
    const now = this.now();
    const r = await this.db.query(
      `SELECT * FROM bookings
        WHERE (status = 'needs_reconciliation' AND (next_attempt_at IS NULL OR next_attempt_at <= $1))
           OR (status = 'calendar_created' AND (next_attempt_at IS NULL OR next_attempt_at <= $1))
           OR (status IN ('calendar_pending', 'reserved') AND updated_at < $2)
        ORDER BY updated_at LIMIT 20`,
      [now, new Date(now.getTime() - this.cfg.staleClaimMs)],
    );
    return r.rows.map(mapBooking);
  }
}
