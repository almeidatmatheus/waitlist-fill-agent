// Cancellation detection over the existing Outlook MCP: every conclusion comes from a calendar listing.
// Microsoft Graph change notifications (when configured) only make a listing happen sooner.
// Safety rules:
//  - any listing error (Graph outage, auth, timeout) or truncated listing => no conclusions at all
//  - an event explicitly marked cancelled => confirmed immediately
//  - a missing event => confirmed only after N consecutive successful polls (CANCELLATION_CONFIRMATIONS)
//  - a missing event that Graph also reported as deleted (hintDeleted) => confirmed by the first successful
//    listing: the notification and the listing are two independent signals
//  - "mass disappearance" (>= 3 and > 50% of expected events missing at once) => treated as an anomaly
//    (wrong calendar, permissions, partial data), not as cancellations
//  - recovery_workflows.cancelled_appointment_id is UNIQUE, so one cancellation starts one workflow
import type { Db } from '../database/pool.ts';
import { errMsg } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import { addDays, localDate } from '../shared/time.ts';
import type { CalendarPort } from '../integrations/outlook-mcp/types.ts';
import type { WorkflowRunner } from '../workflows/runner.ts';
import { recordEvent } from './workflow-events.ts';

// A hint outlives failed listings and a listing that still showed the event (Graph can lag), but not for long.
const HINT_TTL_MS = 10 * 60000;

export interface PollReport {
  ok: boolean;
  checked: number;
  present: number;
  suspected: string[];
  confirmed: { appointmentId: string; observation: 'missing' | 'cancelled'; workflowId: string | null }[];
  skippedReason?: string;
}

export class CancellationDetector {
  private db: Db;
  private calendar: CalendarPort;
  private runner: WorkflowRunner;
  private log: Logger;
  private now: () => Date;
  private o: { timezone: string; lookaheadDays: number; confirmations: number };
  private running = false;
  /** Graph ids reported as deleted by a change notification, with the time of the report. */
  private deletedHints = new Map<string, number>();
  /** Wall-clock time of the last poll that reached a conclusion (0 = never). */
  lastPollAt = 0;

  constructor(db: Db, calendar: CalendarPort, runner: WorkflowRunner, log: Logger, now: () => Date, o: { timezone: string; lookaheadDays: number; confirmations: number }) {
    this.db = db; this.calendar = calendar; this.runner = runner; this.log = log; this.now = now; this.o = o;
  }

  /** A change notification said this event was deleted. Never acted on by itself: the next listing decides. */
  hintDeleted(graphId: string) {
    if (this.deletedHints.size >= 500) this.deletedHints.delete(this.deletedHints.keys().next().value!);
    this.deletedHints.set(graphId, this.now().getTime());
  }

  async poll(): Promise<PollReport> {
    if (this.running) return { ok: false, checked: 0, present: 0, suspected: [], confirmed: [], skippedReason: 'poll already running' };
    this.running = true;
    try { return await this.doPoll(); } finally { this.running = false; }
  }

  private async doPoll(): Promise<PollReport> {
    const now = this.now();
    const from = localDate(now, this.o.timezone), to = addDays(from, this.o.lookaheadDays);
    const appts = (await this.db.query(
      `SELECT id, calendar_ref, outlook_event_id, calendar_missing_count FROM appointments
        WHERE status = 'scheduled' AND calendar_ref IS NOT NULL AND starts_at > $1 AND starts_at < $2::date + 1`,
      [now, to],
    )).rows as { id: string; calendar_ref: string; outlook_event_id: string | null; calendar_missing_count: number }[];
    const report: PollReport = { ok: true, checked: appts.length, present: 0, suspected: [], confirmed: [] };
    for (const [id, at] of this.deletedHints) if (now.getTime() - at > HINT_TTL_MS) this.deletedHints.delete(id);
    const hints = new Set(this.deletedHints.keys());
    if (!appts.length) { this.lastPollAt = Date.now(); return report; }

    let listing;
    try {
      listing = await this.calendar.listEvents(from, to);
    } catch (e) {
      await recordEvent(this.db, null, 'cancellation_poll_failed', { error: errMsg(e).slice(0, 200), kind: (e as { kind?: string }).kind });
      this.log.warn('cancellation.poll_failed', { error: errMsg(e), kind: (e as { kind?: string }).kind });
      return { ...report, ok: false, skippedReason: `calendar error: ${errMsg(e)}` };
    }
    if (!listing.complete) {
      await recordEvent(this.db, null, 'cancellation_poll_incomplete', {});
      return { ...report, ok: false, skippedReason: 'calendar listing incomplete' };
    }

    const byRef = new Map<string, { cancelled: boolean }>();
    const byGraphId = new Map<string, { cancelled: boolean }>();
    for (const e of listing.events) {
      if (e.ref) { const prev = byRef.get(e.ref); byRef.set(e.ref, { cancelled: prev ? prev.cancelled && e.cancelled : e.cancelled }); }
      if (e.graphId) byGraphId.set(e.graphId, { cancelled: e.cancelled });
    }
    // Match by the AAR ref in the title, or by the stored Graph id (survives a staff member editing the title).
    const find = (a: { calendar_ref: string; outlook_event_id: string | null }) => byRef.get(a.calendar_ref) ?? (a.outlook_event_id ? byGraphId.get(a.outlook_event_id) : undefined);
    const missing = appts.filter(a => !find(a));
    if (missing.length >= 3 && missing.length / appts.length > 0.5) {
      await recordEvent(this.db, null, 'cancellation_poll_anomaly', { expected: appts.length, missing: missing.length });
      this.log.warn('cancellation.anomaly', { expected: appts.length, missing: missing.length });
      return { ...report, ok: false, skippedReason: 'too many events missing at once; treated as anomaly' };
    }

    for (const a of appts) {
      const seen = find(a);
      let observation: 'missing' | 'cancelled' | null = null, notified = false;
      if (seen && !seen.cancelled) {
        report.present++;
        await this.db.query(`UPDATE appointments SET calendar_missing_count = 0, last_calendar_check_at = $2 WHERE id = $1`, [a.id, now]);
        continue;
      }
      if (seen?.cancelled) observation = 'cancelled';
      else {
        const n = (await this.db.query(`UPDATE appointments SET calendar_missing_count = calendar_missing_count + 1, last_calendar_check_at = $2 WHERE id = $1 RETURNING calendar_missing_count`, [a.id, now])).rows[0].calendar_missing_count as number;
        notified = !!a.outlook_event_id && hints.has(a.outlook_event_id);
        if (n >= this.o.confirmations || notified) { observation = 'missing'; if (notified) this.deletedHints.delete(a.outlook_event_id!); }
        else { report.suspected.push(a.id); await recordEvent(this.db, null, 'cancellation_suspected', { appointmentId: a.id, consecutiveMisses: n }); }
      }
      if (observation) {
        try {
          const r = await this.runner.startForCancellation({ appointmentId: a.id, source: 'calendar_poll', observation, details: { calendarRef: a.calendar_ref, ...(notified ? { deletedNotification: true } : {}) } });
          report.confirmed.push({ appointmentId: a.id, observation, workflowId: r.workflowId });
        } catch (e) {
          this.log.error('cancellation.start_failed', { appointmentId: a.id, error: errMsg(e) });
          report.confirmed.push({ appointmentId: a.id, observation, workflowId: null });
        }
      }
    }
    this.lastPollAt = Date.now();
    this.log.info('cancellation.poll', { checked: report.checked, present: report.present, suspected: report.suspected.length, confirmed: report.confirmed.length });
    return report;
  }
}
