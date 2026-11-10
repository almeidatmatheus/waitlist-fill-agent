// Time zone helpers. Internally everything is UTC (Date / timestamptz); the clinic time zone is
// used for display and for the wall-clock strings the Outlook MCP reads and writes (YYYY-MM-DDTHH:mm).

function parts(d: Date, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d).map(x => [x.type, x.value]),
  );
  return p as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;
}

function offsetMinutes(tz: string, t: number): number {
  const p = parts(new Date(t), tz);
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000) / 60000;
}

/** UTC instant -> clinic wall clock "YYYY-MM-DDTHH:mm". */
export function toLocalWallClock(d: Date, tz: string): string {
  const p = parts(d, tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Clinic wall clock "YYYY-MM-DDTHH:mm" -> UTC instant (handles DST transitions). */
export function fromLocalWallClock(local: string, tz: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error(`invalid wall clock: ${local}`);
  const w = Date.parse(local + ':00Z');
  let t = w - offsetMinutes(tz, w) * 60000;
  t = w - offsetMinutes(tz, t) * 60000;
  return new Date(t);
}

export const localDate = (d: Date, tz: string) => toLocalWallClock(d, tz).slice(0, 10);

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

/** Human friendly: "tomorrow at 2:00 PM", "Friday 14 November at 9:30 AM". */
export function formatSlot(d: Date, tz: string, now: Date = new Date()): string {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d).toUpperCase().replace(/\s+/g, ' ');
  const day = localDate(d, tz), today = localDate(now, tz);
  if (day === today) return `today at ${time}`;
  if (day === addDays(today, 1)) return `tomorrow at ${time}`;
  const label = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  return `${label} at ${time}`;
}

export function formatDisplay(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export const minutesBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 60000);
