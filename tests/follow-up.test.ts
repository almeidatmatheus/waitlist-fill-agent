// Natural conversation after an offer is settled ("thank you", "ok", "can I move it?").
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, closeDb, IDS } from './support/harness.ts';
import { ScriptedLlm } from '../src/agents/rule-based-llm.ts';
import { LlmError } from '../src/shared/errors.ts';

after(closeDb);

const followUps = async (h: any) => (await h.db.query(`SELECT content FROM messages WHERE idempotency_key LIKE 'followup:%' ORDER BY created_at, id`)).rows.map((r: any) => r.content);

test('"thank you" after the booking gets a warm reply, not a repeated confirmation', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    await h.reply(IDS.phone.sarah, 'Yes');
    await h.reply(IDS.phone.sarah, 'Thank you');
    const last = h.lastSent(IDS.phone.sarah)!;
    assert.match(last, /welcome/i);
    assert.match(last, /tomorrow at 2:00 PM/);
    assert.doesNotMatch(last, /already confirmed/);
    assert.equal((await h.db.query(`SELECT count(*)::int n FROM bookings WHERE workflow_id = $1`, [workflowId])).rows[0].n, 1);
    assert.equal(h.calendar.createCalls, 1);
  } finally { await h.close(); }
});

test('pure acknowledgements get no reply, and follow-ups are capped (no ping-pong)', async () => {
  const h = await createHarness();
  try {
    await h.trigger(IDS.appt.oliverCleaning);
    await h.reply(IDS.phone.sarah, 'Yes');
    const before = h.sent(IDS.phone.sarah).length;
    await h.reply(IDS.phone.sarah, 'ok');
    await h.reply(IDS.phone.sarah, '👍');
    assert.equal(h.sent(IDS.phone.sarah).length, before);
    for (let i = 0; i < 7; i++) await h.reply(IDS.phone.sarah, `thanks ${i}`);
    assert.equal((await followUps(h)).length, 5);
  } finally { await h.close(); }
});

test('unsafe model drafts are replaced; model failures still get a friendly safe reply', async () => {
  const h = await createHarness({ llm: new ScriptedLlm([], [{ category: 'other', shouldReply: true, reply: "Done! I've cancelled your appointment." }, new LlmError('timeout')]) });
  try {
    await h.trigger(IDS.appt.oliverCleaning);
    await h.reply(IDS.phone.sarah, 'Yes');
    await h.reply(IDS.phone.sarah, 'what about the other thing');
    assert.doesNotMatch(h.lastSent(IDS.phone.sarah)!, /cancelled your appointment/);
    assert.match(h.lastSent(IDS.phone.sarah)!, /the team is on 020 7946 0000/);
    assert.equal((await h.db.query(`SELECT count(*)::int n FROM appointments WHERE status <> 'scheduled' AND patient_id = $1`, [IDS.patient.sarah])).rows[0].n, 0);
    await h.reply(IDS.phone.sarah, 'Thank you');
    assert.match(h.lastSent(IDS.phone.sarah)!, /Thanks for your message\. I can help you cancel or reschedule/);
  } finally { await h.close(); }
});

test('after a decline, a thank-you never implies a booking', async () => {
  const h = await createHarness();
  try {
    await h.trigger(IDS.appt.oliverCleaning);
    await h.reply(IDS.phone.sarah, 'No, thanks.');
    await h.reply(IDS.phone.sarah, 'Thank you!');
    const last = h.lastSent(IDS.phone.sarah)!;
    assert.match(last, /welcome/i);
    assert.doesNotMatch(last, /confirmed|booked|tomorrow at 2:00 PM/i);
  } finally { await h.close(); }
});
