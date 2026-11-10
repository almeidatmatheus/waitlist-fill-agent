import { Annotation } from '@langchain/langgraph';
import type { Intent } from '../agents/types.ts';

/** Values the graph is resumed with after an interrupt (one per external event). */
export type ResumeEvent =
  | { type: 'patient_message'; offerId: string; text: string; inboundEventId: string; correlationId: string }
  | { type: 'offer_expired'; offerId: string; correlationId: string }
  | { type: 'widen'; correlationId: string }
  | { type: 'staff_decision'; decision: 'offer_next' | 'close'; correlationId: string }
  | { type: 'retry_booking'; bookingId: string; correlationId: string };

export type WaitingFor = 'patient' | 'human' | 'reconciliation';

export interface SlotSnapshot {
  slotReference: string;
  cancelledAppointmentId: string;
  treatmentId: string;
  treatmentName: string;
  startsAt: string; // ISO UTC (checkpoint-serialisable)
  endsAt: string;
}

/** Only ids and a first name: phone numbers never enter the checkpoint. (A patient_message event does carry its text.) */
export interface CandidateSnapshot {
  waitlistId: string;
  patientId: string;
  firstName: string;
}

/** An offer that is still open. Several can be open for one slot (offer cascade). */
export interface LiveOffer extends CandidateSnapshot {
  offerId: string;
  conversationId: string;
  clarifications: number;
}

export interface InterpretationSnapshot {
  intent: Intent | 'expired';
  confidence: number;
  reply: string;
  overridden: string | null;
}

export type Outcome = 'booked' | 'exhausted' | 'slot_unavailable' | 'failed' | 'closed';

const last = <T>(fallback: () => T) => Annotation<T>({ reducer: (_a: T, b: T) => b, default: fallback });
const sum = () => Annotation<number>({ reducer: (a: number, b: number) => a + b, default: () => 0 });

export const RecoveryState = Annotation.Root({
  workflowId: last<string>(() => ''),
  correlationId: last<string>(() => ''),
  status: last<string>(() => 'cancellation_detected'),
  slot: last<SlotSnapshot | null>(() => null),
  triedWaitlistIds: last<string[]>(() => []),
  // Every open offer for this slot. candidate/offerId/conversationId/clarifications below describe the one
  // offer the current event is about.
  live: last<LiveOffer[]>(() => []),
  lastOfferAt: last<string | null>(() => null),
  widenAt: last<string | null>(() => null),
  handoffOpen: last<boolean>(() => false),
  candidate: last<CandidateSnapshot | null>(() => null),
  offerId: last<string | null>(() => null),
  conversationId: last<string | null>(() => null),
  lastEvent: last<ResumeEvent | null>(() => null),
  interpretation: last<InterpretationSnapshot | null>(() => null),
  clarifications: last<number>(() => 0),
  bookingId: last<string | null>(() => null),
  route: last<string | null>(() => null),
  handoffReason: last<string | null>(() => null),
  outcome: last<Outcome | null>(() => null),
  error: last<string | null>(() => null),
  llmCalls: sum(),
  inputTokens: sum(),
  outputTokens: sum(),
  costUsd: sum(),
});

export type RecoveryStateType = typeof RecoveryState.State;
export type RecoveryUpdate = typeof RecoveryState.Update;
