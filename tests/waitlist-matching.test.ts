import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEligibility, prioritize, findCandidates, type CandidateRow, type SlotInfo } from '../src/services/waitlist-matching.ts';
import { resetDb, closeDb, IDS } from './support/harness.ts';

after(closeDb);

const now = new Date('2026-11-10T09:00:00Z');
const slot: SlotInfo = {
  workflowId: 'w', slotReference: 'slot:x', cancelledAppointmentId: 'a', cancelledPatientId: 'p-cancel', treatmentId: 't1', treatmentName: 'Dental cleaning',
  durationMinutes: 30, startsAt: new Date('2026-11-11T14:00:00Z'), endsAt: new Date('2026-11-11T14:30:00Z'),
};
const base: CandidateRow = {
  waitlistId: 'w1', patientId: 'p1', fullName: 'Test Patient', waitlistStatus: 'waiting', treatmentId: 't1', treatmentDuration: 30, contactAllowed: true, hasContact: true,
  preferredStart: null, preferredEnd: null, createdAt: new Date('2026-10-01T00:00:00Z'), currentAppointmentStart: null, alreadyOfferedThisSlot: false,
  hasLiveOfferOrHandoff: false, hasOverlappingAppointment: false,
};
const failedRules = (over: Partial<CandidateRow>, s = slot, minLead = 60) => evaluateEligibility({ ...base, ...over }, s, now, minLead).failed;

test('a fully compatible waitlist entry is eligible', () => {
  assert.deepEqual(evaluateEligibility(base, slot, now, 60), { eligible: true, failed: [] });
});

test('each deterministic eligibility rule rejects with an explainable code', () => {
  assert.deepEqual(failedRules({ waitlistStatus: 'booked' }), ['R1_not_waiting']);
  assert.deepEqual(failedRules({ treatmentId: 't2' }), ['R2_treatment_mismatch']);
  assert.deepEqual(failedRules({ treatmentDuration: 45 }), ['R3_duration_exceeds_slot']);
  assert.deepEqual(failedRules({ contactAllowed: false }), ['R4_contact_not_allowed']);
  assert.deepEqual(failedRules({}, { ...slot, startsAt: new Date(now.getTime() + 30 * 60000), endsAt: new Date(now.getTime() + 60 * 60000) }), ['R5_insufficient_lead_time']);
  assert.deepEqual(failedRules({ preferredStart: new Date('2026-11-12T00:00:00Z') }), ['R6_outside_preferred_window']);
  assert.deepEqual(failedRules({ preferredEnd: new Date('2026-11-11T14:15:00Z') }), ['R6_outside_preferred_window']);
  assert.deepEqual(failedRules({ currentAppointmentStart: new Date('2026-11-11T10:00:00Z') }), ['R7_not_earlier_than_current']);
  assert.deepEqual(failedRules({ patientId: 'p-cancel' }), ['R8_cancelling_patient']);
  assert.deepEqual(failedRules({ alreadyOfferedThisSlot: true }), ['R9_already_offered']);
  assert.deepEqual(failedRules({ hasLiveOfferOrHandoff: true }), ['R10_live_offer_or_handoff']);
  assert.deepEqual(failedRules({ hasOverlappingAppointment: true }), ['R11_overlapping_appointment']);
});

test('an earlier current appointment of the same treatment is fine only if the slot is earlier', () => {
  assert.deepEqual(failedRules({ currentAppointmentStart: new Date('2026-11-30T10:00:00Z') }), []);
});

test('prioritisation: longest waiting first, then largest wait reduction, then id', () => {
  const a = { ...base, waitlistId: 'a', createdAt: new Date('2026-10-05T00:00:00Z') };
  const b = { ...base, waitlistId: 'b', createdAt: new Date('2026-10-01T00:00:00Z') };
  const c = { ...base, waitlistId: 'c', createdAt: new Date('2026-10-05T00:00:00Z'), currentAppointmentStart: new Date('2026-11-20T00:00:00Z') };
  const d = { ...base, waitlistId: 'd', createdAt: new Date('2026-10-05T00:00:00Z'), currentAppointmentStart: new Date('2026-12-20T00:00:00Z') };
  assert.deepEqual(prioritize([a, c, d, b], slot).map(x => x.waitlistId), ['b', 'a', 'd', 'c']);
  // deterministic tie-break
  const e = { ...base, waitlistId: 'e' }, f = { ...base, waitlistId: 'f' };
  assert.deepEqual(prioritize([f, e], slot).map(x => x.waitlistId), ['e', 'f']);
});

test('seeded data: the cleaning slot ranks Sarah, James, Isla and explains every rejection', async () => {
  const db = await resetDb();
  const a = (await db.query(`SELECT a.*, t.name, t.duration_minutes FROM appointments a JOIN treatments t ON t.id = a.treatment_id WHERE a.id = $1`, [IDS.appt.oliverCleaning])).rows[0];
  const s: SlotInfo = { workflowId: 'w', slotReference: 'slot:test', cancelledAppointmentId: a.id, cancelledPatientId: a.patient_id, treatmentId: a.treatment_id, treatmentName: a.name, durationMinutes: a.duration_minutes, startsAt: a.starts_at, endsAt: a.ends_at };
  const r = await findCandidates(db, s, new Date(), 60);
  assert.deepEqual(r.ranked.map(c => c.waitlistId), [IDS.waitlist.sarah, IDS.waitlist.james, IDS.waitlist.isla]);
  const rej = Object.fromEntries(r.rejected.map(x => [x.waitlistId, x.failed]));
  assert.deepEqual(rej[IDS.waitlist.grace], ['R4_contact_not_allowed']);
  assert.deepEqual(rej[IDS.waitlist.leo], ['R6_outside_preferred_window']);
  assert.equal(r.ranked.some(c => c.patientId === IDS.patient.oliver), false);
});
