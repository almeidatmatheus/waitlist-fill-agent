// Provider-neutral calendar port used by the services. Implemented by the Outlook MCP adapter
// (real MCP protocol) and by an in-memory mock for tests and the offline demo.

export interface CalendarEvent {
  /** Stable correlation token parsed from the title ("AAR-xxxxxxxx"), if present. */
  ref: string | null;
  title: string;
  /** Clinic wall clock, "YYYY-MM-DDTHH:mm". */
  start: string;
  end: string;
  allDay: boolean;
  cancelled: boolean;
  /** busy | free | tentative | ... (normalised to English). */
  showAs: string;
  /** Permanent Microsoft Graph id (immutable id). Safe to persist; the edit tool takes it as its target. */
  graphId: string;
}

export interface CalendarListing {
  events: CalendarEvent[];
  /** false when the provider signalled truncated results; callers must not infer absence from it. */
  complete: boolean;
}

export interface CreateEventInput {
  ref: string;
  title: string;
  /** Clinic wall clock "YYYY-MM-DDTHH:mm". */
  start: string;
  durationMinutes: number;
  description: string;
}

export type CreateEventResult =
  | { status: 'created'; graphId: string; raw: string }
  | { status: 'approval_required'; preview: string };

export interface UpdateEventInput {
  ref: string;
  /** Stored Graph id of the event, when known: edited directly, with the ref lookup as fallback. */
  graphId?: string | null;
  /** Clinic-local date of the event (YYYY-MM-DD), used to locate it. */
  date: string;
  title?: string;
  /** Mark the time as free (soft cancellation: the slot becomes bookable without deleting the event). */
  free?: boolean;
}

export type UpdateEventResult = { status: 'updated' } | { status: 'not_found' } | { status: 'approval_required'; preview: string };

export interface ToolCallRecord {
  tool: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

/** A Microsoft Graph change-notification subscription kept by the calendar provider. */
export interface CalendarSubscription {
  id: string;
  expiresAt: Date;
}

export interface CalendarPort {
  readonly name: string;
  /** Lists events with start in [fromDate, toDate] (inclusive local dates, YYYY-MM-DD). Throws CalendarError on any failure. */
  listEvents(fromDate: string, toDate: string): Promise<CalendarListing>;
  /** Creates an event on the clinic calendar without attendees. Never auto-confirms an approval request. */
  createEvent(input: CreateEventInput): Promise<CreateEventResult>;
  /** Edits an attendee-less event on the clinic calendar. Never deletes (deletion requires human approval in the MCP). */
  updateEvent(input: UpdateEventInput): Promise<UpdateEventResult>;
  /**
   * Creates the change-notification subscription for the clinic calendar, or renews it (idempotent).
   * The receiving URL and the shared secret are provider configuration, never arguments.
   * Optional: providers without notifications leave it out and the app keeps polling.
   */
  ensureSubscription?(): Promise<CalendarSubscription>;
  /** Tool names discovered from the provider (for health/diagnostics). */
  capabilities(): Promise<string[]>;
  close(): Promise<void>;
}
