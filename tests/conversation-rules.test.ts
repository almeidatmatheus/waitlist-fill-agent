// Pure rules behind the conversation fixes found by the simulated-patient eval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionsTime } from '../src/agents/time-mention.ts';
import { RulesConfirmationJudge } from '../src/agents/jev/confirmation.ts';
import { isClinical } from '../src/agents/guardrails.ts';
import { confirmQuestion } from '../src/agents/tool-agent.ts';

test('mentionsTime recognises the ways people write a time, and only that time', () => {
  for (const t of ['2:30pm please', '2.30 works', '14:30', '230pm', 'half past 2 is fine', '2:30 PM'])
    assert.ok(mentionsTime(t, '14:30'), t);
  for (const t of ['3:30pm', '12:30', '2pm', '22:30 lol']) assert.ok(!mentionsTime(t, '14:30'), t);
  for (const t of ['4pm', '4 p.m.', '16:00', "4 o'clock", '4:00']) assert.ok(mentionsTime(t, '16:00'), t);
  for (const t of ['14pm', '4:30', '40 minutes']) assert.ok(!mentionsTime(t, '16:00'), t);
});

test('rules gate: texting shorthand yes, selections, and negatives', async () => {
  const j = new RulesConfirmationJudge();
  const v = async (m: string, selection = false) => (await j.judge('Move the Filling to 2:30 PM?', m, { selection })).verdict;
  assert.equal(await v('y'), 'confirm');
  assert.equal(await v('k'), 'confirm');
  assert.equal(await v('y not'), 'unclear', 'only the whole message counts as shorthand');
  assert.equal(await v('2:30pm please'), 'unclear', 'naming a time is not a yes on its own');
  assert.equal(await v('2:30pm please', true), 'confirm', 'picking an offered time is');
  assert.equal(await v('is 2:30 free?', true), 'unclear');
  assert.equal(await v("2:30 doesn't work for me", true), 'decline');
});

test('clinical pre-classifier: medication words only when asking about taking something', () => {
  assert.equal(isClinical('Do I need to bring the paperwork and my medication list?'), false);
  assert.equal(isClinical('Should I take ibuprofen before the appointment?'), true);
  assert.equal(isClinical("I'm on antibiotics at the moment"), true);
  assert.equal(isClinical('my cheek is swollen'), true);
});

test('confirmQuestion turns a pending proposal into a natural question', () => {
  assert.equal(confirmQuestion('Cancel the Filling tomorrow at 10:00 AM?'), 'Just to double-check: shall I cancel the Filling tomorrow at 10:00 AM?');
  assert.equal(confirmQuestion('Move the Filling from tomorrow at 10:00 AM to tomorrow at 2:30 PM?'), 'Just to double-check: shall I move the Filling from tomorrow at 10:00 AM to tomorrow at 2:30 PM?');
  assert.equal(confirmQuestion('Asked the patient which day and time would suit them.'), null);
});

test('agent reply guard: promises and "passed on" claims are only allowed when true', async () => {
  const { createHarness, closeDb, IDS } = await import('./support/harness.ts');
  const steps: any[] = [{ text: "I can't check that here, but I've passed that to the team and they'll let you know." }];
  const client: any = { chat: { completions: { create: async () => ({ choices: [{ message: { role: 'assistant', content: steps.shift()?.text ?? 'NO_REPLY' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } } };
  const h = await createHarness({ overrides: { agentClient: client } });
  try {
    await h.reply(IDS.phone.noah, 'what should I bring?');
    assert.doesNotMatch(h.lastSent(IDS.phone.noah)!, /passed|let you know/, 'no handoff happened, so no such claim');
  } finally { await h.close(); await closeDb(); }
});

test('change-claim guard works with typographic apostrophes and other verbs (sim-eval t18)', async () => {
  const { guardAgentReply } = await import('../src/agents/tool-agent.ts');
  assert.equal(guardAgentReply('Great — I’ve updated it to Tuesday 10 November at 12:30 PM 😊', false), null);
  assert.equal(guardAgentReply('Done — it’s moved to 2:30', false), null);
  assert.notEqual(guardAgentReply('Great — I’ve updated it to Tuesday 10 November at 12:30 PM', true), null, 'fine once it really happened');
  assert.notEqual(guardAgentReply('2:30 is free. Shall I move it there?', false), null);
});

test('closing messages: only pure closings, never a question or a new request', async () => {
  const { isClosingMessage } = await import('../src/agents/guardrails.ts');
  for (const t of ['Thanks!', 'thank you so much 😊', 'ok bye', 'Thanks again, have a good day!', '👍', 'great, thanks', 'Cheers, see you then', 'ok', 'You too!'])
    assert.ok(isClosingMessage(t), t);
  for (const t of ['thanks, one more question', 'thanks, can I also move my other one?', 'ok but what about Friday', 'Thanks?', 'no thanks', 'cancel it, thanks', 'I want to talk to a person'])
    assert.ok(!isClosingMessage(t), t);
});

test('conversation closed: only after the clinic signed off, with nothing pending', async () => {
  const { conversationClosed } = await import('../src/agents/guardrails.ts');
  const h = (clinic: string) => [{ role: 'patient' as const, text: 'cancel please' }, { role: 'clinic' as const, text: clinic }];
  assert.equal(conversationClosed(h("You're welcome! 😊"), 'thanks again!', false), true);
  assert.equal(conversationClosed(h('You’re welcome, take care'), 'bye 👍', false), true);
  assert.equal(conversationClosed(h("Done, it's cancelled."), 'Thanks!', false), false, 'the first thanks after a change still gets a reply');
  assert.equal(conversationClosed(h("You're welcome! Anything else?"), 'thanks', false), false, 'the clinic asked something');
  assert.equal(conversationClosed(h("You're welcome!"), 'thanks', true), false, 'a proposal is pending');
  assert.equal(conversationClosed(h("You're welcome!"), 'thanks, and can I move my other one?', false), false);
});

test('closed conversation: no reply and no model call (no ping-pong)', async () => {
  const { createHarness, closeDb, IDS } = await import('./support/harness.ts');
  let calls = 0;
  const replies = ["You're welcome! 😊", 'Sure, what would you like to change?'];
  const client: any = { chat: { completions: { create: async () => { calls++; return { choices: [{ message: { role: 'assistant', content: replies.shift() ?? 'NO_REPLY' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; } } } };
  const h = await createHarness({ overrides: { agentClient: client } });
  const NOAH = IDS.phone.noah;
  try {
    await h.reply(NOAH, 'Thank you for your help!');
    assert.equal(h.sent(NOAH).length, 1);
    assert.equal(calls, 1);
    await h.reply(NOAH, 'thanks again, bye 👍');
    assert.equal(h.sent(NOAH).length, 1, 'no reply to a pure closing after the sign-off');
    assert.equal(calls, 1, 'and no model call');
    assert.equal((await h.db.query(`SELECT count(*)::int n FROM workflow_events WHERE event_type = 'conversation_closed'`)).rows[0].n, 1);
    await h.reply(NOAH, 'oh wait, can I change something?');
    assert.equal(h.sent(NOAH).length, 2, 'a real message reopens the conversation');
  } finally { await h.close(); await closeDb(); }
});
