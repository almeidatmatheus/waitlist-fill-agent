// Offer cascade: one freed slot on offer to several patients; the first to accept gets it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, closeDb, IDS, type Harness } from './support/harness.ts';

after(closeDb);

const ADMIN = { authorization: 'Bearer test-admin-token-0123456789', 'content-type': 'application/json' };
const statuses = async (h: Harness, workflowId: string) => Object.fromEntries((await h.offers(workflowId)).map(o => [o.patient_id, o.status]));
const bookings = async (h: Harness, workflowId: string) => (await h.db.query(`SELECT patient_id, status FROM bookings WHERE workflow_id = $1`, [workflowId])).rows;
const decide = (h: Harness, workflowId: string, decision: string) =>
  h.app.server.inject({ method: 'POST', url: `/workflows/${workflowId}/handoff-decision`, headers: ADMIN, payload: { decision } });

test('all at once: three patients are offered the slot, the first yes books it, the others are told it has gone', async () => {
  const h = await createHarness({ config: { OFFER_CASCADE_SIZE: '3', OFFER_WIDEN_AFTER_MINUTES: '0' } });
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    for (const who of ['sarah', 'james', 'isla'] as const) {
      assert.match(h.lastSent(IDS.phone[who])!, /goes to the first one who confirms/, `${who} is told the offer is shared`);
    }
    assert.deepEqual(await statuses(h, workflowId), { [IDS.patient.sarah]: 'pending', [IDS.patient.james]: 'pending', [IDS.patient.isla]: 'pending' });
    assert.equal((await h.workflow(workflowId)).status, 'awaiting_patient');

    await h.reply(IDS.phone.james, 'Yes, please.'); // second in the waiting list answers first
    assert.match(h.lastSent(IDS.phone.james)!, /^You're all set!/);
    assert.match(h.lastSent(IDS.phone.sarah)!, /just been booked by another patient/);
    assert.match(h.lastSent(IDS.phone.isla)!, /just been booked by another patient/);
    assert.deepEqual(await statuses(h, workflowId), { [IDS.patient.sarah]: 'superseded', [IDS.patient.james]: 'confirmed', [IDS.patient.isla]: 'superseded' });
    assert.equal((await h.workflow(workflowId)).status, 'booked');

    // A later yes from someone who lost the slot never books and never sounds like a booking.
    await h.reply(IDS.phone.sarah, 'Yes please!');
    assert.match(h.lastSent(IDS.phone.sarah)!, /no longer available/);
    assert.deepEqual(await bookings(h, workflowId), [{ patient_id: IDS.patient.james, status: 'confirmed' }]);
    assert.equal(h.calendar.createCalls, 1);
    assert.equal((await h.db.query(`SELECT status FROM waitlist WHERE id = $1`, [IDS.waitlist.sarah])).rows[0].status, 'waiting', 'Sarah keeps her place');
  } finally { await h.close(); }
});

test('two patients say yes at the same moment: exactly one booking, the other is told it has gone', async () => {
  const h = await createHarness({ config: { OFFER_CASCADE_SIZE: '2', OFFER_WIDEN_AFTER_MINUTES: '0' } });
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    await Promise.all([h.reply(IDS.phone.sarah, 'Yes!'), h.reply(IDS.phone.james, 'Yes, please.')]);
    await h.app.sweeper.sweep(); // picks up a reply that lost the race for the workflow lease, if any
    const b = await bookings(h, workflowId);
    assert.equal(b.length, 1);
    assert.equal(b[0].status, 'confirmed');
    const winner = b[0].patient_id === IDS.patient.sarah ? 'sarah' : 'james';
    const loser = winner === 'sarah' ? 'james' : 'sarah';
    assert.match(h.lastSent(IDS.phone[winner])!, /^You're all set!/);
    assert.ok(h.sent(IDS.phone[loser]).some(m => /just been booked by another patient/.test(m)));
    assert.ok(!h.sent(IDS.phone[loser]).some(m => /all set|confirmed/i.test(m)), 'the loser never gets a confirmation');
    assert.equal(h.calendar.createCalls, 1);
  } finally { await h.close(); }
});

test('widening: one patient first, one more every few minutes, earlier offers stay open', async () => {
  const h = await createHarness({ config: { OFFER_CASCADE_SIZE: '3', OFFER_WIDEN_AFTER_MINUTES: '5' } });
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    assert.match(h.lastSent(IDS.phone.sarah)!, /^Hi Sarah!/);
    assert.equal(h.sent(IDS.phone.james).length + h.sent(IDS.phone.isla).length, 0, 'the first patient has the offer alone at the start');
    assert.ok((await h.workflow(workflowId)).widen_at, 'the next widening is scheduled');

    assert.equal((await h.app.sweeper.sweep()).widened, 0, 'not due yet');
    h.advance(6);
    assert.equal((await h.app.sweeper.sweep()).widened, 1);
    assert.match(h.lastSent(IDS.phone.james)!, /^Hi James!/);
    assert.equal(h.sent(IDS.phone.isla).length, 0);
    assert.deepEqual(await statuses(h, workflowId), { [IDS.patient.sarah]: 'pending', [IDS.patient.james]: 'pending' });

    h.advance(6);
    assert.equal((await h.app.sweeper.sweep()).widened, 1);
    assert.match(h.lastSent(IDS.phone.isla)!, /^Hi Isla!/);
    assert.equal((await h.workflow(workflowId)).widen_at, null, 'cascade is full: nothing more is scheduled');
    h.advance(6);
    assert.equal((await h.app.sweeper.sweep()).widened, 0);

    // The first patient can still take it: her offer was never withdrawn.
    await h.reply(IDS.phone.sarah, 'Yes, please.');
    assert.match(h.lastSent(IDS.phone.sarah)!, /^You're all set!/);
    assert.deepEqual(await statuses(h, workflowId), { [IDS.patient.sarah]: 'confirmed', [IDS.patient.james]: 'superseded', [IDS.patient.isla]: 'superseded' });
  } finally { await h.close(); }
});

test('widening stops when the waiting list has nobody else', async () => {
  const h = await createHarness({ config: { OFFER_CASCADE_SIZE: '5', OFFER_WIDEN_AFTER_MINUTES: '5' } });
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    for (let i = 0; i < 2; i++) { h.advance(6); assert.equal((await h.app.sweeper.sweep()).widened, 1); }
    h.advance(6);
    assert.equal((await h.app.sweeper.sweep()).widened, 1, 'one last search finds nobody');
    assert.equal((await h.workflow(workflowId)).widen_at, null);
    assert.equal((await h.app.sweeper.sweep()).widened, 0, 'and the sweeper stops asking');
    assert.equal((await h.offers(workflowId)).length, 3);
  } finally { await h.close(); }
});

test('a decline or an expiry ends only that offer; the slot is offered on', async () => {
  const h = await createHarness({ config: { OFFER_CASCADE_SIZE: '2', OFFER_WIDEN_AFTER_MINUTES: '0' } });
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    assert.equal(h.sent(IDS.phone.isla).length, 0, 'cascade of two: the third patient waits');
    await h.reply(IDS.phone.sarah, 'No, thanks.');
    assert.match(h.lastSent(IDS.phone.sarah)!, /keep your place on the waiting list/);
    assert.match(h.lastSent(IDS.phone.isla)!, /^Hi Isla!/, 'the free place in the cascade goes to the next patient');
    assert.deepEqual(await statuses(h, workflowId), { [IDS.patient.sarah]: 'declined', [IDS.patient.james]: 'pending', [IDS.patient.isla]: 'pending' });

    h.advance(31); // both remaining offers expire
    assert.equal((await h.app.sweeper.sweep()).expired, 2);
    assert.match(h.lastSent(IDS.phone.james)!, /expired/);
    assert.match(h.lastSent(IDS.phone.isla)!, /expired/);
    assert.equal((await h.workflow(workflowId)).status, 'exhausted');
    assert.equal((await bookings(h, workflowId)).length, 0);
  } finally { await h.close(); }
});

test('a question from one patient is answered without disturbing the other offer', async () => {
  const h = await createHarness({ config: { OFFER_CASCADE_SIZE: '2', OFFER_WIDEN_AFTER_MINUTES: '0' } });
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    const before = h.sent(IDS.phone.james).length;
    await h.reply(IDS.phone.sarah, 'How long does it take?');
    assert.equal(h.sent(IDS.phone.james).length, before, 'James hears nothing about it');
    assert.deepEqual(await statuses(h, workflowId), { [IDS.patient.sarah]: 'pending', [IDS.patient.james]: 'pending' });
    await h.reply(IDS.phone.sarah, 'Yes, please.');
    assert.match(h.lastSent(IDS.phone.sarah)!, /^You're all set!/);
    assert.match(h.lastSent(IDS.phone.james)!, /just been booked by another patient/);
  } finally { await h.close(); }
});

test('handoff for one patient does not freeze the slot for the others', async () => {
  const h = await createHarness({ config: { OFFER_CASCADE_SIZE: '2', OFFER_WIDEN_AFTER_MINUTES: '0' } });
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    await h.reply(IDS.phone.sarah, 'Can you call me?');
    assert.deepEqual(await statuses(h, workflowId), { [IDS.patient.sarah]: 'handoff', [IDS.patient.james]: 'pending' });
    assert.equal((await h.workflow(workflowId)).status, 'awaiting_patient', 'James can still answer');
    assert.equal(h.sent(IDS.phone.isla).length, 0, 'no new offers while a handoff is open');
    await h.reply(IDS.phone.james, 'Yes, please.');
    assert.match(h.lastSent(IDS.phone.james)!, /^You're all set!/);
    assert.equal((await h.workflow(workflowId)).status, 'booked');
    assert.equal((await h.db.query(`SELECT status FROM human_handoffs WHERE workflow_id = $1`, [workflowId])).rows[0].status, 'open', 'staff still owe Sarah a call');
  } finally { await h.close(); }
});

test('handoff: when the other offers end, the slot waits for staff; staff can also close it early', async () => {
  const h = await createHarness({ config: { OFFER_CASCADE_SIZE: '2', OFFER_WIDEN_AFTER_MINUTES: '0' } });
  try {
    const a = await h.trigger(IDS.appt.oliverCleaning);
    await h.reply(IDS.phone.sarah, 'Can you call me?');
    await h.reply(IDS.phone.james, 'No, thanks.');
    assert.equal((await h.workflow(a.workflowId)).status, 'awaiting_human');
    assert.equal((await decide(h, a.workflowId, 'offer_next')).statusCode, 200);
    assert.match(h.lastSent(IDS.phone.isla)!, /^Hi Isla!/);
  } finally { await h.close(); }

  const h2 = await createHarness({ config: { OFFER_CASCADE_SIZE: '2', OFFER_WIDEN_AFTER_MINUTES: '0' } });
  try {
    const b = await h2.trigger(IDS.appt.oliverCleaning);
    assert.equal((await decide(h2, b.workflowId, 'close')).statusCode, 409, 'no handoff yet: nothing for staff to decide');
    await h2.reply(IDS.phone.sarah, 'Can you call me?');
    assert.equal((await decide(h2, b.workflowId, 'close')).statusCode, 200, 'staff close the slot while James still holds an offer');
    assert.equal(h2.lastSent(IDS.phone.james), "Sorry, that appointment offer is no longer available. You'll keep your place on our waiting list.", 'no claim that someone else booked it');
    assert.equal((await h2.workflow(b.workflowId)).status, 'closed');
    assert.deepEqual(await statuses(h2, b.workflowId), { [IDS.patient.sarah]: 'handoff', [IDS.patient.james]: 'superseded' });
  } finally { await h2.close(); }
});
