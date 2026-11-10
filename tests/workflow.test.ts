// Conversation state transitions through the real LangGraph workflow (PostgreSQL checkpoints).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, closeDb, IDS } from './support/harness.ts';
import { ScriptedLlm } from '../src/agents/rule-based-llm.ts';

after(closeDb);

test('accept: offer -> reply resumes the conversation -> verified booking -> confirmation', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    assert.equal((await h.workflow(workflowId)).status, 'awaiting_patient');
    assert.equal((await h.workflow(workflowId)).current_state, 'awaiting_patient_response');
    assert.match(h.lastSent(IDS.phone.sarah)!, /^Hi Sarah! .*dental cleaning appointment is available tomorrow at 2:00 PM/);
    assert.equal(h.sent(IDS.phone.oliver).length + h.sent(IDS.phone.james).length + h.sent(IDS.phone.grace).length, 0, 'only the selected patient is contacted');

    const r = await h.reply(IDS.phone.sarah, 'Yes, please.');
    assert.equal(r.status, 202);
    assert.equal(h.lastSent(IDS.phone.sarah), "You're all set! Your dental cleaning is confirmed for tomorrow at 2:00 PM. See you then 😊");
    const wf = await h.workflow(workflowId);
    assert.equal(wf.status, 'booked');
    const b = (await h.db.query('SELECT * FROM bookings WHERE workflow_id = $1', [workflowId])).rows;
    assert.equal(b.length, 1);
    assert.equal(b[0].status, 'confirmed');
    assert.equal(h.calendar.findByRef(b[0].calendar_ref).length, 1, 'exactly one calendar event');
    const appt = (await h.db.query('SELECT * FROM appointments WHERE id = $1', [b[0].appointment_id])).rows[0];
    assert.equal(appt.patient_id, IDS.patient.sarah);
    assert.equal(appt.source, 'recovery');
    assert.equal((await h.db.query(`SELECT status FROM waitlist WHERE id = $1`, [IDS.waitlist.sarah])).rows[0].status, 'booked');
    const ev = (await h.db.query(`SELECT event_type FROM workflow_events WHERE workflow_id = $1 ORDER BY id`, [workflowId])).rows.map(r => r.event_type);
    assert.ok(ev.indexOf('calendar_event_verified') < ev.indexOf('booking_confirmed'));
    assert.ok(ev.includes('later_appointment_needs_release'), "Sarah's later appointment is flagged for staff");
  } finally { await h.close(); }
});

test('decline moves to the next eligible patient', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    await h.reply(IDS.phone.sarah, 'No, thanks.');
    assert.match(h.lastSent(IDS.phone.sarah)!, /keep your place on the waiting list/);
    assert.match(h.lastSent(IDS.phone.james)!, /^Hi James!/);
    const offers = await h.offers(workflowId);
    assert.deepEqual(offers.map(o => [o.patient_id, o.status]), [[IDS.patient.sarah, 'declined'], [IDS.patient.james, 'pending']]);
  } finally { await h.close(); }
});

test('offer expiry (clock + sweeper) moves to the next patient; a late "yes" never books', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    h.advance(31);
    const rep = await h.app.sweeper.sweep();
    assert.equal(rep.expired, 1);
    assert.match(h.lastSent(IDS.phone.sarah)!, /expired/);
    assert.match(h.lastSent(IDS.phone.james)!, /^Hi James!/);
    await h.reply(IDS.phone.sarah, 'Yes please!');
    assert.match(h.lastSent(IDS.phone.sarah)!, /no longer available/);
    assert.equal((await h.db.query('SELECT count(*)::int n FROM bookings WHERE workflow_id = $1', [workflowId])).rows[0].n, 0);
    assert.equal(h.calendar.createCalls, 0);
  } finally { await h.close(); }
});

test('a reply after the deadline but before the sweeper runs is rejected deterministically', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    h.advance(45); // no sweep
    await h.reply(IDS.phone.sarah, 'Yes, please.');
    assert.match(h.lastSent(IDS.phone.sarah)!, /no longer available/);
    assert.equal((await h.db.query('SELECT count(*)::int n FROM bookings WHERE workflow_id = $1', [workflowId])).rows[0].n, 0);
    assert.equal((await h.offers(workflowId))[0].status, 'expired');
    assert.match(h.lastSent(IDS.phone.james)!, /^Hi James!/, 'workflow moved on');
  } finally { await h.close(); }
});

test('questions, reschedule requests and ambiguity get a clarification, then a yes books', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    await h.reply(IDS.phone.sarah, 'What time is it?');
    assert.match(h.lastSent(IDS.phone.sarah)!, /tomorrow at 2:00 PM.*yes or no/);
    await h.reply(IDS.phone.sarah, 'Can I come on Friday instead?');
    assert.match(h.lastSent(IDS.phone.sarah)!, /only offer tomorrow at 2:00 PM/);
    await h.reply(IDS.phone.sarah, 'Yes, I will take it');
    assert.equal((await h.workflow(workflowId)).status, 'booked');
    const interp = (await h.db.query(`SELECT payload FROM workflow_events WHERE workflow_id = $1 AND event_type = 'response_interpreted' ORDER BY id`, [workflowId])).rows.map(r => r.payload.intent);
    assert.deepEqual(interp, ['question', 'reschedule_request', 'accept']);
  } finally { await h.close(); }
});

test('too many unclear replies hand the conversation to a human', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    await h.reply(IDS.phone.sarah, 'Maybe later.');
    await h.reply(IDS.phone.sarah, 'hmm not sure');
    await h.reply(IDS.phone.sarah, 'we will see');
    const wf = await h.workflow(workflowId);
    assert.equal(wf.status, 'awaiting_human');
    const ho = (await h.db.query(`SELECT reason, notified FROM human_handoffs WHERE workflow_id = $1`, [workflowId])).rows;
    assert.deepEqual(ho, [{ reason: 'clarification_limit', notified: false }]);
    // No notifier configured -> we must not claim the team was notified.
    assert.match(h.lastSent(IDS.phone.sarah)!, /Please call the clinic/);
  } finally { await h.close(); }
});

test('clinical symptoms: human handoff, safety wording, no medical advice, no LLM call', async () => {
  const llm = new ScriptedLlm([]);
  const h = await createHarness({ llm });
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    await h.reply(IDS.phone.sarah, 'I have severe tooth pain.');
    assert.equal(llm.calls, 0);
    assert.equal((await h.workflow(workflowId)).status, 'awaiting_human');
    const msg = h.lastSent(IDS.phone.sarah)!;
    assert.match(msg, /can't give medical advice/);
    assert.doesNotMatch(msg, /ibuprofen|paracetamol|rinse/i);
    assert.equal((await h.offers(workflowId))[0].status, 'handoff');
  } finally { await h.close(); }
});

test('human request with a configured notifier says the team was told; staff can move to the next patient', async () => {
  const calls: string[] = [];
  const handoffFetch = (async (url: string) => { calls.push(url); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  const h = await createHarness({ config: { HUMAN_HANDOFF_WEBHOOK_URL: 'http://staff.example.test/hook' }, overrides: { handoffFetch } });
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    await h.reply(IDS.phone.sarah, 'Can you call me?');
    assert.equal(calls.length, 1);
    assert.match(h.lastSent(IDS.phone.sarah)!, /passed your message to our clinic team/);
    const res = await h.app.server.inject({ method: 'POST', url: `/workflows/${workflowId}/handoff-decision`, headers: { authorization: 'Bearer test-admin-token-0123456789', 'content-type': 'application/json' }, payload: { decision: 'offer_next' } });
    assert.equal(res.statusCode, 200);
    assert.match(h.lastSent(IDS.phone.james)!, /^Hi James!/);
    assert.equal((await h.db.query(`SELECT status FROM human_handoffs WHERE workflow_id = $1`, [workflowId])).rows[0].status, 'resolved');
  } finally { await h.close(); }
});

test('"already booked" removes the patient from the waitlist and continues', async () => {
  const h = await createHarness();
  try {
    await h.trigger(IDS.appt.oliverCleaning);
    await h.reply(IDS.phone.sarah, 'I already booked another appointment.');
    assert.equal((await h.db.query(`SELECT status FROM waitlist WHERE id = $1`, [IDS.waitlist.sarah])).rows[0].status, 'fulfilled_elsewhere');
    assert.match(h.lastSent(IDS.phone.james)!, /^Hi James!/);
  } finally { await h.close(); }
});

test('everyone declines -> workflow exhausted; ineligible patients are never contacted', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    await h.reply(IDS.phone.sarah, 'No thanks');
    await h.reply(IDS.phone.james, 'No thank you');
    await h.reply(IDS.phone.isla, 'Nope');
    assert.equal((await h.workflow(workflowId)).status, 'exhausted');
    assert.equal(h.sent(IDS.phone.grace).length, 0, 'contact_allowed=false');
    assert.equal(h.messaging.to('+447700900007').length, 0, 'outside preferred window');
  } finally { await h.close(); }
});

test('two concurrent workflows: each reply resumes the right conversation', async () => {
  const h = await createHarness();
  try {
    const a = await h.trigger(IDS.appt.oliverCleaning); // cleaning -> Sarah
    const b = await h.trigger(IDS.appt.noahFilling);    // filling  -> Mia
    assert.match(h.lastSent(IDS.phone.mia)!, /filling appointment/);
    await h.reply(IDS.phone.mia, 'Yes please');
    assert.equal((await h.workflow(b.workflowId)).status, 'booked');
    assert.equal((await h.workflow(a.workflowId)).status, 'awaiting_patient');
    await h.reply(IDS.phone.sarah, 'no thanks');
    assert.equal((await h.offers(a.workflowId))[0].status, 'declined');
    assert.equal((await h.offers(b.workflowId))[0].status, 'confirmed');
  } finally { await h.close(); }
});

test('messages from unknown numbers are stored nowhere near a patient and never answered', async () => {
  const h = await createHarness();
  try {
    await h.trigger(IDS.appt.oliverCleaning);
    const before = h.messaging.sent.length;
    const r = await h.reply('+447700900999', 'Yes please');
    assert.equal(r.status, 202);
    assert.equal(h.messaging.sent.length, before);
    assert.equal((await h.db.query(`SELECT status, last_error FROM inbound_events ORDER BY received_at DESC LIMIT 1`)).rows[0].last_error, 'unknown_sender');
  } finally { await h.close(); }
});

test('message delivery failure skips to the next patient', async () => {
  const h = await createHarness();
  try {
    h.messaging.failNext();
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    const offers = await h.offers(workflowId);
    assert.deepEqual(offers.map(o => o.status), ['send_failed', 'pending']);
    assert.match(h.lastSent(IDS.phone.james)!, /^Hi James!/);
    assert.equal((await h.db.query(`SELECT delivery_status FROM messages WHERE idempotency_key = $1`, [`offer:${offers[0].id}`])).rows[0].delivery_status, 'failed');
  } finally { await h.close(); }
});
