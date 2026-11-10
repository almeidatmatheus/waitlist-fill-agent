// Deterministic waitlist eligibility and prioritisation. The LLM is never involved here.
//
// Eligibility rules (all must pass) - documented in docs/business-rules.md:
//  R1  waitlist entry status is 'waiting'
//  R2  same treatment as the cancelled appointment (no "compatible treatment" guessing)
//  R3  treatment duration fits inside the slot
//  R4  patient allows contact and has a WhatsApp-capable number
//  R5  slot starts at least MIN_LEAD_TIME_MINUTES from now
//  R6  slot lies entirely inside the patient's preferred window, when one is set
//  R7  if the patient already holds a scheduled appointment for this treatment, the slot is earlier
//  R8  patient is not the one whose appointment was cancelled
//  R9  this waitlist entry has not already been offered this slot (declined/expired/failed)
//  R10 patient has no other live offer and no open human handoff
//  R11 patient has no other scheduled appointment overlapping the slot
//
// Priority policy (deterministic total order):
//  P1  longest waiting first (waitlist.created_at ascending)
//  P2  then the largest wait reduction (current appointment start minus slot start; none counts as largest)
//  P3  then waitlist id, so ties are always broken the same way
import type { Queryable } from '../database/pool.ts';

export interface SlotInfo {
  workflowId: string;
  slotReference: string;
  cancelledAppointmentId: string;
  cancelledPatientId: string;
  treatmentId: string;
  treatmentName: string;
  durationMinutes: number;
  startsAt: Date;
  endsAt: Date;
}

export interface CandidateRow {
  waitlistId: string;
  patientId: string;
  fullName: string;
  waitlistStatus: string;
  treatmentId: string;
  treatmentDuration: number;
  contactAllowed: boolean;
  hasContact: boolean;
  preferredStart: Date | null;
  preferredEnd: Date | null;
  createdAt: Date;
  currentAppointmentStart: Date | null;
  alreadyOfferedThisSlot: boolean;
  hasLiveOfferOrHandoff: boolean;
  hasOverlappingAppointment: boolean;
}

export interface RuleResult { eligible: boolean; failed: string[] }

export function evaluateEligibility(c: CandidateRow, slot: SlotInfo, now: Date, minLeadMinutes: number): RuleResult {
  const failed: string[] = [];
  const slotMinutes = (slot.endsAt.getTime() - slot.startsAt.getTime()) / 60000;
  if (c.waitlistStatus !== 'waiting') failed.push('R1_not_waiting');
  if (c.treatmentId !== slot.treatmentId) failed.push('R2_treatment_mismatch');
  if (c.treatmentDuration > slotMinutes) failed.push('R3_duration_exceeds_slot');
  if (!c.contactAllowed || !c.hasContact) failed.push('R4_contact_not_allowed');
  if (slot.startsAt.getTime() < now.getTime() + minLeadMinutes * 60000) failed.push('R5_insufficient_lead_time');
  if ((c.preferredStart && slot.startsAt < c.preferredStart) || (c.preferredEnd && slot.endsAt > c.preferredEnd)) failed.push('R6_outside_preferred_window');
  if (c.currentAppointmentStart && c.currentAppointmentStart <= slot.startsAt) failed.push('R7_not_earlier_than_current');
  if (c.patientId === slot.cancelledPatientId) failed.push('R8_cancelling_patient');
  if (c.alreadyOfferedThisSlot) failed.push('R9_already_offered');
  if (c.hasLiveOfferOrHandoff) failed.push('R10_live_offer_or_handoff');
  if (c.hasOverlappingAppointment) failed.push('R11_overlapping_appointment');
  return { eligible: failed.length === 0, failed };
}

export function prioritize(cands: CandidateRow[], slot: SlotInfo): CandidateRow[] {
  const gain = (c: CandidateRow) => (c.currentAppointmentStart ? c.currentAppointmentStart.getTime() - slot.startsAt.getTime() : Number.POSITIVE_INFINITY);
  return [...cands].sort((a, b) =>
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (gain(b) === gain(a) ? 0 : gain(b) > gain(a) ? 1 : -1) ||
    a.waitlistId.localeCompare(b.waitlistId));
}

export async function loadCandidates(q: Queryable, slot: SlotInfo): Promise<CandidateRow[]> {
  // Loads every waitlist row for the treatment; rules are then applied in code so each rejection is explainable.
  const r = await q.query(
    `SELECT w.id AS waitlist_id, w.patient_id, p.full_name, w.status AS waitlist_status, w.treatment_id,
            t.duration_minutes AS treatment_duration, p.contact_allowed,
            (p.whatsapp_jid IS NOT NULL OR p.phone_number IS NOT NULL) AS has_contact,
            w.preferred_start, w.preferred_end, w.created_at,
            (SELECT min(a.starts_at) FROM appointments a
               WHERE a.patient_id = w.patient_id AND a.treatment_id = w.treatment_id AND a.status = 'scheduled') AS current_appointment_start,
            EXISTS (SELECT 1 FROM appointment_offers o WHERE o.waitlist_id = w.id AND o.appointment_slot_reference = $2) AS already_offered,
            (EXISTS (SELECT 1 FROM appointment_offers o WHERE o.patient_id = w.patient_id AND o.status IN ('pending', 'accepted'))
              OR EXISTS (SELECT 1 FROM human_handoffs h WHERE h.patient_id = w.patient_id AND h.status = 'open')) AS live_offer_or_handoff,
            EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = w.patient_id AND a.status = 'scheduled'
                      AND a.starts_at < $4 AND a.ends_at > $3) AS overlapping
       FROM waitlist w
       JOIN patients p ON p.id = w.patient_id
       JOIN treatments t ON t.id = w.treatment_id
      WHERE w.treatment_id = $1`,
    [slot.treatmentId, slot.slotReference, slot.startsAt, slot.endsAt],
  );
  return r.rows.map(x => ({
    waitlistId: x.waitlist_id, patientId: x.patient_id, fullName: x.full_name, waitlistStatus: x.waitlist_status, treatmentId: x.treatment_id,
    treatmentDuration: x.treatment_duration, contactAllowed: x.contact_allowed, hasContact: x.has_contact,
    preferredStart: x.preferred_start, preferredEnd: x.preferred_end, createdAt: x.created_at,
    currentAppointmentStart: x.current_appointment_start, alreadyOfferedThisSlot: x.already_offered,
    hasLiveOfferOrHandoff: x.live_offer_or_handoff, hasOverlappingAppointment: x.overlapping,
  }));
}

export interface MatchResult {
  ranked: CandidateRow[];
  rejected: { waitlistId: string; failed: string[] }[];
}

export async function findCandidates(q: Queryable, slot: SlotInfo, now: Date, minLeadMinutes: number, excludeWaitlistIds: string[] = []): Promise<MatchResult> {
  const rows = (await loadCandidates(q, slot)).filter(c => !excludeWaitlistIds.includes(c.waitlistId));
  const ok: CandidateRow[] = [];
  const rejected: MatchResult['rejected'] = [];
  for (const c of rows) {
    const r = evaluateEligibility(c, slot, now, minLeadMinutes);
    if (r.eligible) ok.push(c);
    else rejected.push({ waitlistId: c.waitlistId, failed: r.failed });
  }
  return { ranked: prioritize(ok, slot), rejected };
}

export async function loadSlot(q: Queryable, workflowId: string): Promise<SlotInfo> {
  const r = await q.query(
    `SELECT w.id, w.slot_reference, w.cancelled_appointment_id, a.patient_id, w.treatment_id, t.name, t.duration_minutes, w.starts_at, w.ends_at
       FROM recovery_workflows w JOIN appointments a ON a.id = w.cancelled_appointment_id JOIN treatments t ON t.id = w.treatment_id
      WHERE w.id = $1`,
    [workflowId],
  );
  if (!r.rowCount) throw new Error(`workflow ${workflowId} not found`);
  const x = r.rows[0];
  return {
    workflowId: x.id, slotReference: x.slot_reference, cancelledAppointmentId: x.cancelled_appointment_id, cancelledPatientId: x.patient_id,
    treatmentId: x.treatment_id, treatmentName: x.name, durationMinutes: x.duration_minutes, startsAt: x.starts_at, endsAt: x.ends_at,
  };
}
