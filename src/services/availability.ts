// Deterministic availability: which start times are bookable on the clinic calendar.
// The LLM never decides availability; it only tells us which day/time the patient asked for.
import type { CalendarPort } from '../integrations/outlook-mcp/types.ts';
import { CalendarError } from '../shared/errors.ts';
import { addDays, fromLocalWallClock, toLocalWallClock } from '../shared/time.ts';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface OpeningHours { days: Set<number>; open: string; close: string }

/** "mon-fri 09:00-18:00" | "mon,wed,fri 08:30-17:00". */
export function parseOpeningHours(spec: string): OpeningHours {
  const m = /^\s*([a-z,-]+)\s+(\d{2}:\d{2})-(\d{2}:\d{2})\s*$/i.exec(spec);
  if (!m) throw new Error(`invalid CLINIC_OPENING_HOURS: ${spec}`);
  const days = new Set<number>();
  for (const part of m[1].toLowerCase().split(',')) {
    const [a, b] = part.split('-');
    const ia = DAYS.indexOf(a), ib = b ? DAYS.indexOf(b) : ia;
    if (ia < 0 || ib < 0) throw new Error(`invalid day in CLINIC_OPENING_HOURS: ${part}`);
    for (let d = ia; ; d = (d + 1) % 7) { days.add(d); if (d === ib) break; }
  }
  if (m[2] >= m[3]) throw new Error('CLINIC_OPENING_HOURS: open must be before close');
  return { days, open: m[2], close: m[3] };
}

const dow = (date: string) => new Date(date + 'T00:00:00Z').getUTCDay();

export interface Slot { start: Date; end: Date }

export interface AvailabilityQuery {
  calendar: CalendarPort;
  tz: string;
  hours: OpeningHours;
  now: Date;
  minLeadMinutes: number;
  durationMinutes: number;
  /** Calendar refs that do not block (e.g. the patient's own appointment being moved). */
  ignoreRefs: string[];
  /** Graph ids of the patient's own event(s), ignored like ignoreRefs (works even if the title was edited). */
  ignoreGraphIds?: string[];
  /** Busy intervals known from the database (e.g. the patient's other appointments). */
  extraBusy?: Slot[];
  stepMinutes?: number;
}

/** All bookable starts on one local date, in order. Throws CalendarError when availability is unknown. */
export async function freeSlotsOn(date: string, q: AvailabilityQuery): Promise<Slot[]> {
  if (!q.hours.days.has(dow(date))) return [];
  const listing = await q.calendar.listEvents(date, date);
  if (!listing.complete) throw new CalendarError('incomplete', 'calendar listing truncated; availability unknown');
  const busy: Slot[] = listing.events
    .filter(e => !e.cancelled && e.showAs !== 'free' && !(e.ref && q.ignoreRefs.includes(e.ref)) && !(e.graphId && q.ignoreGraphIds?.includes(e.graphId)))
    .map(e => ({ start: fromLocalWallClock(e.start, q.tz), end: fromLocalWallClock(e.end, q.tz) }));
  busy.push(...(q.extraBusy ?? []));
  const step = q.stepMinutes ?? 30;
  const open = fromLocalWallClock(`${date}T${q.hours.open}`, q.tz).getTime();
  const close = fromLocalWallClock(`${date}T${q.hours.close}`, q.tz).getTime();
  const earliest = q.now.getTime() + q.minLeadMinutes * 60000;
  const out: Slot[] = [];
  for (let t = open; t + q.durationMinutes * 60000 <= close; t += step * 60000) {
    const s = t, e = t + q.durationMinutes * 60000;
    if (s < earliest) continue;
    if (busy.some(b => b.start.getTime() < e && b.end.getTime() > s)) continue;
    out.push({ start: new Date(s), end: new Date(e) });
  }
  return out;
}

export async function isSlotFree(start: Date, q: AvailabilityQuery): Promise<boolean> {
  const local = toLocalWallClock(start, q.tz);
  const date = local.slice(0, 10), hhmm = local.slice(11);
  const endLocal = toLocalWallClock(new Date(start.getTime() + q.durationMinutes * 60000), q.tz);
  if (hhmm < q.hours.open || endLocal.slice(0, 10) !== date || endLocal.slice(11) > q.hours.close) return false;
  const slots = await freeSlotsOn(date, { ...q, stepMinutes: 5 });
  return slots.some(s => s.start.getTime() === start.getTime());
}

/**
 * Up to `max` options: slots on `date` closest to the preferred time (or matching the time of day),
 * then the following opening days if that day has nothing.
 */
export async function suggestSlots(date: string, q: AvailabilityQuery, opts: { preferredTime?: string | null; timeOfDay?: 'morning' | 'afternoon' | 'evening' | null; max?: number; searchDays?: number } = {}): Promise<Slot[]> {
  const max = opts.max ?? 3;
  const range = (s: Slot) => { const h = toLocalWallClock(s.start, q.tz).slice(11); return opts.timeOfDay === 'morning' ? h < '12:00' : opts.timeOfDay === 'afternoon' ? h >= '12:00' && h < '17:00' : opts.timeOfDay === 'evening' ? h >= '17:00' : true; };
  for (let i = 0, d = date; i < (opts.searchDays ?? 7); i++, d = addDays(d, 1)) {
    let slots = (await freeSlotsOn(d, q)).filter(range);
    if (!slots.length) continue;
    if (opts.preferredTime && i === 0) {
      const pref = fromLocalWallClock(`${d}T${opts.preferredTime}`, q.tz).getTime();
      slots = [...slots].sort((a, b) => Math.abs(a.start.getTime() - pref) - Math.abs(b.start.getTime() - pref)).slice(0, max).sort((a, b) => a.start.getTime() - b.start.getTime());
    }
    return slots.slice(0, max);
  }
  return [];
}
