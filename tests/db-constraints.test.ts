import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, closeDb, IDS } from './support/harness.ts';

after(closeDb);

const violates = (constraint: string) => (e: { constraint?: string; code?: string }) => e.constraint === constraint || (constraint === 'check' && e.code === '23514');

test('database constraints protect core invariants', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    const db = h.db;
    // one workflow per cancelled appointment
    await assert.rejects(db.query(`INSERT INTO recovery_workflows (cancelled_appointment_id, slot_reference, treatment_id, starts_at, ends_at) SELECT cancelled_appointment_id, 'slot:other', treatment_id, starts_at, ends_at FROM recovery_workflows WHERE id = $1`, [workflowId]), violates('recovery_workflows_cancelled_appointment_id_key'));
    // one cancellation event per appointment
    await assert.rejects(db.query(`INSERT INTO cancellation_events (appointment_id, source, observation) VALUES ($1, 'manual', 'manual')`, [IDS.appt.oliverCleaning]), violates('cancellation_events_appointment_id_key'));
    // a waitlist entry is offered a slot at most once
    await assert.rejects(db.query(`INSERT INTO appointment_offers (appointment_slot_reference, workflow_id, waitlist_id, patient_id, status, expires_at) SELECT appointment_slot_reference, workflow_id, waitlist_id, patient_id, 'declined', expires_at FROM appointment_offers WHERE workflow_id = $1`, [workflowId]), violates('offers_slot_waitlist_uq'));
    // one live offer per patient
    const b = await h.trigger(IDS.appt.ethanCleaning); // Sarah already holds a live offer -> James gets this one
    assert.match(h.lastSent(IDS.phone.james)!, /^Hi James!/);
    const bare = (await db.query(`INSERT INTO recovery_workflows (cancelled_appointment_id, slot_reference, treatment_id, starts_at, ends_at) SELECT id, 'slot:bare', treatment_id, starts_at, ends_at FROM appointments WHERE id = $1 RETURNING id`, [IDS.appt.isla])).rows[0].id;
    await assert.rejects(db.query(`INSERT INTO appointment_offers (appointment_slot_reference, workflow_id, waitlist_id, patient_id, status, expires_at) VALUES ('slot:bare', $1, $2, $3, 'pending', now() + interval '1 hour')`, [bare, IDS.waitlist.isla, IDS.patient.sarah]), violates('offers_one_live_per_patient_uq'));
    // one open conversation per patient
    await assert.rejects(db.query(`INSERT INTO conversations (patient_id, status) VALUES ($1, 'open')`, [IDS.patient.sarah]), violates('conversations_one_open_per_patient_uq'));
    // duplicate inbound message id
    await db.query(`INSERT INTO inbound_events (provider, external_message_id, payload, correlation_id) VALUES ('wa-akg', 'DUP', '{}', 'c')`);
    await assert.rejects(db.query(`INSERT INTO inbound_events (provider, external_message_id, payload, correlation_id) VALUES ('wa-akg', 'DUP', '{}', 'c')`), violates('inbound_events_provider_external_message_id_key'));
    // data validity checks
    await assert.rejects(db.query(`INSERT INTO patients (full_name, phone_number) VALUES ('X', '07700 900123')`), violates('check'));
    await assert.rejects(db.query(`INSERT INTO appointments (patient_id, treatment_id, starts_at, ends_at) SELECT patient_id, treatment_id, ends_at, starts_at FROM appointments LIMIT 1`), violates('check'));
    await assert.rejects(db.query(`UPDATE appointment_offers SET status = 'maybe' WHERE workflow_id = $1`, [workflowId]), violates('check'));
    await assert.rejects(db.query(`INSERT INTO waitlist (patient_id, treatment_id) SELECT patient_id, treatment_id FROM waitlist WHERE id = $1`, [IDS.waitlist.sarah]), violates('waitlist_active_patient_treatment_uq'));
  } finally { await h.close(); }
});

test('a constraint violation inside offer creation is handled, not crashed on', async () => {
  const h = await createHarness();
  try {
    // Sarah gets a live offer for slot A; when slot B (also cleaning) is processed, offer creation for
    // Sarah would violate offers_one_live_per_patient_uq if she were selected; matching skips her (R10).
    await h.trigger(IDS.appt.oliverCleaning);
    await h.db.query(`DELETE FROM human_handoffs`);
    const b = await h.trigger(IDS.appt.ethanCleaning);
    const offers = await h.offers(b.workflowId);
    assert.deepEqual(offers.map(o => o.patient_id), [IDS.patient.james]);
    assert.equal((await h.workflow(b.workflowId)).status, 'awaiting_patient');
  } finally { await h.close(); }
});
