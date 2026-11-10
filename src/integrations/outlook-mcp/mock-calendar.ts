// In-memory CalendarPort for tests, evals and the offline demo. Optional JSON-file persistence lets
// the demo survive restarts. Failure injection simulates Graph/MCP outages, timeouts and conflicts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CalendarError } from '../../shared/errors.ts';
import { CALENDAR_REF_RE } from '../../shared/ids.ts';
import type { CalendarEvent, CalendarListing, CalendarPort, CalendarSubscription, CreateEventInput, CreateEventResult, UpdateEventInput, UpdateEventResult } from './types.ts';

type Op = 'list' | 'create' | 'update';
export type Fault =
  | { kind: 'error'; error: CalendarError }
  /** The event IS created, but the caller sees a timeout (ambiguous outcome). */
  | { kind: 'create_then_timeout' }
  | { kind: 'incomplete' }
  | { kind: 'approval_required' };

const addMinutes = (local: string, m: number) => new Date(Date.parse(local + ':00Z') + m * 60000).toISOString().slice(0, 16);

export class MockCalendar implements CalendarPort {
  readonly name = 'mock-calendar';
  events: CalendarEvent[] = [];
  createCalls = 0;
  listCalls = 0;
  private faults: Record<Op, Fault[]> = { list: [], create: [], update: [] };
  updateCalls = 0;
  private file: string | null;
  delayMs = 0;

  constructor(opts: { file?: string } = {}) {
    this.file = opts.file ?? null;
    if (this.file && existsSync(this.file)) this.events = JSON.parse(readFileSync(this.file, 'utf8'));
  }

  private persist() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.events, null, 2));
  }

  /** Queue a fault for the next call(s) of an operation. */
  inject(op: Op, fault: Fault, times = 1) {
    for (let i = 0; i < times; i++) this.faults[op].push(fault);
  }

  clearFaults() { this.faults = { list: [], create: [], update: [] }; }

  /** Adds an event directly (seeding, or simulating a staff member booking the slot). */
  addEvent(e: Partial<CalendarEvent> & { title: string; start: string; end: string }) {
    const ev: CalendarEvent = { ref: CALENDAR_REF_RE.exec(e.title)?.[0] ?? null, allDay: false, cancelled: false, showAs: 'busy', graphId: `mock-${randomBytes(8).toString('hex')}`, ...e };
    this.events.push(ev);
    this.persist();
    return ev;
  }

  removeByRef(ref: string): boolean {
    const n = this.events.length;
    this.events = this.events.filter(e => e.ref !== ref);
    this.persist();
    return this.events.length < n;
  }

  markCancelled(ref: string): boolean {
    const e = this.events.find(x => x.ref === ref);
    if (e) { e.cancelled = true; this.persist(); }
    return !!e;
  }

  findByRef(ref: string) { return this.events.filter(e => e.ref === ref); }

  async capabilities() { return ['ls', 'cr']; }

  private async delay() { if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs)); }

  async listEvents(fromDate: string, toDate: string): Promise<CalendarListing> {
    this.listCalls++;
    await this.delay();
    const f = this.faults.list.shift();
    if (f?.kind === 'error') throw f.error;
    const events = this.events.filter(e => e.start.slice(0, 10) >= fromDate && e.start.slice(0, 10) <= toDate).map(e => ({ ...e }));
    return { events, complete: f?.kind !== 'incomplete' };
  }

  async createEvent(input: CreateEventInput): Promise<CreateEventResult> {
    this.createCalls++;
    await this.delay();
    const f = this.faults.create.shift();
    if (f?.kind === 'error') throw f.error;
    if (f?.kind === 'approval_required') return { status: 'approval_required', preview: `CRIAR "${input.title}"` };
    const ev = this.addEvent({ title: input.title, start: input.start, end: addMinutes(input.start, input.durationMinutes) });
    if (f?.kind === 'create_then_timeout') throw new CalendarError('timeout', 'MCP cr timed out (event may exist)');
    return { status: 'created', graphId: ev.graphId, raw: `criado:${this.events.length}` };
  }

  async updateEvent(input: UpdateEventInput): Promise<UpdateEventResult> {
    this.updateCalls++;
    await this.delay();
    const f = this.faults.update.shift();
    if (f?.kind === 'error') throw f.error;
    if (f?.kind === 'approval_required') return { status: 'approval_required', preview: 'ALTERAR' };
    const e = (input.graphId ? this.events.find(x => x.graphId === input.graphId && !x.cancelled) : undefined)
      ?? this.events.find(x => x.ref === input.ref && !x.cancelled && x.start.slice(0, 10) === input.date);
    if (!e) return { status: 'not_found' };
    if (input.title !== undefined) e.title = input.title;
    if (input.free) e.showAs = 'free';
    this.persist();
    if (f?.kind === 'create_then_timeout') throw new CalendarError('timeout', 'MCP ed timed out (edit may have been applied)');
    return { status: 'updated' };
  }

  /** Change notifications: tests set `subscriptionError` to simulate a provider that cannot subscribe. */
  subscribeCalls = 0;
  subscriptionError: CalendarError | null = null;
  subscriptionDays = 2;
  subscriptionNow: () => number = Date.now;
  async ensureSubscription(): Promise<CalendarSubscription> {
    this.subscribeCalls++;
    if (this.subscriptionError) throw this.subscriptionError;
    return { id: 'mock-subscription', expiresAt: new Date(this.subscriptionNow() + this.subscriptionDays * 86400000) };
  }

  async close() {}
}
