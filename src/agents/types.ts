// The LLM is used for language only: classifying a patient's reply and drafting a short answer.
// It never decides eligibility, availability or booking; those are deterministic application code.

export const INTENTS = [
  'accept',
  'decline',
  'reschedule_request',
  'question',
  'ambiguous',
  'already_booked',
  'human_request',
  'clinical_concern',
  'opt_out',
] as const;
export type Intent = (typeof INTENTS)[number];

export interface InterpretInput {
  patientFirstName: string;
  clinicName: string;
  treatmentName: string;
  /** Human readable slot in clinic time, e.g. "tomorrow at 2:00 PM". */
  slotText: string;
  /** Recent conversation (oldest first), already limited to this offer. */
  history: { role: 'clinic' | 'patient'; text: string }[];
  /** Latest patient message: UNTRUSTED input. */
  message: string;
}

export interface Interpretation {
  intent: Intent;
  confidence: number;
  /** True when answering requires calendar information beyond the offered slot (e.g. another day). */
  needsCalendarInfo: boolean;
  /** A day the patient asked for instead, as written by them (informational only, never booked). */
  requestedDay: string | null;
  /** Short WhatsApp reply draft (used only for clarification turns, after validation). */
  reply: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResult<T> {
  value: T;
  model: string;
  usage: LlmUsage | null;
  costUsd: number | null;
  latencyMs: number;
  /** Which component made the decision (e.g. 'jev', 'llm_fallback:low_confidence'). */
  decidedBy?: string;
}

export interface LlmPort {
  readonly name: string;
  interpret(input: InterpretInput): Promise<LlmResult<Interpretation>>;
  followUp(input: FollowUpInput): Promise<LlmResult<FollowUp>>;
}

// ---- Conversation outside a live offer: small talk, questions, and cancel/reschedule requests.
// The model only extracts WHAT the patient wants; which appointment, which slots are free and every
// calendar change are decided by deterministic code (services/patient-request-service.ts).
export const FOLLOW_UP_CATEGORIES = ['thanks', 'acknowledgement', 'appointment_question', 'cancel_request', 'reschedule_request', 'confirm', 'reject', 'other'] as const;
export type FollowUpCategory = (typeof FOLLOW_UP_CATEGORIES)[number];

export interface FollowUpInput {
  patientFirstName: string;
  clinicName: string;
  clinicPhone: string;
  /** e.g. "Sunday 2026-11-08" in the clinic time zone, so relative dates can be resolved. */
  today: string;
  /** The patient's OWN upcoming appointments (never anyone else's). */
  appointments: { date: string; time: string; treatment: string }[];
  /** Next appointment in friendly words ("tomorrow at 2:00 PM"), or null. */
  nextAppointment: string | null;
  /** Outcome of the latest offer, if any. */
  outcome: 'confirmed' | 'declined' | 'none';
  /** Text of a cancel/reschedule proposal waiting for the patient's answer, if any. */
  pendingProposal: string | null;
  history: { role: 'clinic' | 'patient'; text: string }[];
  /** Latest patient message: UNTRUSTED input. */
  message: string;
}

export interface FollowUp {
  category: FollowUpCategory;
  /** false for pure acknowledgements ("ok", "👍") so the chat does not ping-pong. */
  shouldReply: boolean;
  reply: string;
  /** Date of the appointment the patient refers to (YYYY-MM-DD), if stated. */
  appointmentDate: string | null;
  /** Requested new date/time for a reschedule or a choice among options (YYYY-MM-DD / HH:mm). */
  targetDate: string | null;
  targetTime: string | null;
  timeOfDay: 'morning' | 'afternoon' | 'evening' | null;
}
