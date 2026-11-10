import { randomBytes, randomUUID } from 'node:crypto';

/** Stable correlation token embedded in calendar event titles, e.g. "AAR-3f9a1c0b". */
export const newCalendarRef = () => `AAR-${randomBytes(4).toString('hex')}`;
export const CALENDAR_REF_RE = /\bAAR-[0-9a-f]{8}\b/;
export const newCorrelationId = () => randomUUID();
