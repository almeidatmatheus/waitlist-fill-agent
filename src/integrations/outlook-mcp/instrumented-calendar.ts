// Decorator adding structured logs + call records (used by evals to count tool calls) to any CalendarPort.
import { errMsg } from '../../shared/errors.ts';
import type { Logger } from '../../shared/logger.ts';
import { CalendarError } from '../../shared/errors.ts';
import type { CalendarPort, CalendarSubscription, ToolCallRecord, CreateEventInput, UpdateEventInput } from './types.ts';

export class InstrumentedCalendar implements CalendarPort {
  readonly calls: ToolCallRecord[] = [];
  private inner: CalendarPort;
  private log: Logger;
  constructor(inner: CalendarPort, log: Logger) {
    this.inner = inner;
    this.log = log;
  }
  get name() { return this.inner.name; }

  private async track<T>(tool: string, fields: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      const out = await fn();
      const durationMs = Date.now() - t0;
      this.calls.push({ tool, ok: true, durationMs });
      this.log.info('mcp.call', { tool, ok: true, durationMs, ...fields });
      return out;
    } catch (e) {
      const durationMs = Date.now() - t0;
      this.calls.push({ tool, ok: false, durationMs, error: errMsg(e) });
      this.log.warn('mcp.call', { tool, ok: false, durationMs, error: errMsg(e), kind: (e as { kind?: string }).kind, ...fields });
      throw e;
    }
  }

  listEvents(fromDate: string, toDate: string) {
    return this.track('calendar.list', { fromDate, toDate }, () => this.inner.listEvents(fromDate, toDate));
  }
  createEvent(input: CreateEventInput) {
    return this.track('calendar.create', { ref: input.ref, start: input.start }, () => this.inner.createEvent(input));
  }
  updateEvent(input: UpdateEventInput) {
    return this.track('calendar.update', { ref: input.ref, date: input.date }, () => this.inner.updateEvent(input));
  }
  get supportsSubscription() { return typeof this.inner.ensureSubscription === 'function'; }
  ensureSubscription(): Promise<CalendarSubscription> {
    return this.track('calendar.subscribe', {}, async () => {
      if (!this.inner.ensureSubscription) throw new CalendarError('not_supported', 'calendar provider has no change notifications');
      return this.inner.ensureSubscription();
    });
  }
  capabilities() { return this.inner.capabilities(); }
  close() { return this.inner.close(); }
}
