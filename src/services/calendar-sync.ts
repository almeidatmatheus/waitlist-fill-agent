// Ensures every scheduled appointment with a calendar_ref exists in the clinic calendar
// (used to push the synthetic seed into the mock calendar, the fake Graph or a real test calendar).
import type { Db } from '../database/pool.ts';
import type { CalendarPort } from '../integrations/outlook-mcp/types.ts';
import { addDays, localDate, toLocalWallClock } from '../shared/time.ts';
import { maskedName } from './templates.ts';

export async function syncAppointmentsToCalendar(db: Db, calendar: CalendarPort, tz: string, now: Date, lookaheadDays = 60): Promise<{ created: number; present: number; approvalRequired: number }> {
  const r = await db.query(
    `SELECT a.calendar_ref, a.starts_at, a.ends_at, t.name AS treatment, p.full_name FROM appointments a
       JOIN treatments t ON t.id = a.treatment_id JOIN patients p ON p.id = a.patient_id
      WHERE a.status = 'scheduled' AND a.calendar_ref IS NOT NULL AND a.starts_at > $1 ORDER BY a.starts_at`,
    [now],
  );
  if (!r.rowCount) return { created: 0, present: 0, approvalRequired: 0 };
  const from = localDate(now, tz);
  const listing = await calendar.listEvents(from, addDays(from, lookaheadDays));
  const byRef = new Map(listing.events.filter(e => !e.cancelled && e.ref).map(e => [e.ref!, e]));
  // Keep the permanent Graph id next to the ref, so later edits and checks can go straight to the event.
  const saveId = (ref: string, graphId: string | null | undefined) => graphId
    ? db.query(`UPDATE appointments SET outlook_event_id = $2 WHERE calendar_ref = $1 AND outlook_event_id IS DISTINCT FROM $2`, [ref, graphId])
    : Promise.resolve();
  let created = 0, present = 0, approvalRequired = 0;
  for (const a of r.rows) {
    const seen = byRef.get(a.calendar_ref);
    if (seen) { present++; await saveId(a.calendar_ref, seen.graphId); continue; }
    const res = await calendar.createEvent({
      ref: a.calendar_ref,
      title: `${a.calendar_ref} · ${a.treatment} · ${maskedName(a.full_name)}`,
      start: toLocalWallClock(a.starts_at, tz),
      durationMinutes: Math.round((a.ends_at.getTime() - a.starts_at.getTime()) / 60000),
      description: 'Synthetic appointment (fictional clinic).',
    });
    if (res.status === 'created') { created++; await saveId(a.calendar_ref, res.graphId); } else approvalRequired++;
  }
  return { created, present, approvalRequired };
}
