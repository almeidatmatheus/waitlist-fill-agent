// Jev integration: client contract, decision thresholds, fallbacks, and end-to-end use in the workflow
// and in the confirmation gate. A simulated System One API answers scripted decisions.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { JevClient, JevError, type JevAnswer, type JevQuestion } from '../src/agents/jev/client.ts';
import { JevInterpreter } from '../src/agents/jev/jev-interpreter.ts';
import { JevConfirmationJudge } from '../src/agents/jev/confirmation.ts';
import { ScriptedLlm } from '../src/agents/rule-based-llm.ts';
import { silentLogger } from '../src/shared/logger.ts';
import { createHarness, closeDb, IDS } from './support/harness.ts';

after(closeDb);

type Decide = (questions: Record<string, JevQuestion>, state: any) => Record<string, JevAnswer>;
const choice = (c: string, confidence: number): JevAnswer => ({ type: 'choice', choice: c, confidence, probabilities: { [c]: confidence } });
const noul = (v: number): JevAnswer => ({ type: 'noul', noul: v });

/** Fake System One endpoint; validates the request shape and records every call. */
function fakeJev(decide: Decide, opts: { status?: number[]; delayMs?: number } = {}) {
  const calls: { url: string; headers: any; body: any }[] = [];
  const statuses = [...(opts.status ?? [])];
  const fetchImpl = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
    const st = statuses.shift();
    if (st && st !== 200) return new Response('{}', { status: st });
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: decide(body.questions, body.state), usage: { input_tokens: 1200, output_tokens: 0 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new JevClient({ apiKey: 'test-key', model: 'jev-latest', url: 'https://jev.test', timeoutMs: 500, priceInputPer1M: 0.042, fetchImpl });
  return { client, calls };
}

const offerAnswers = (intent: string, conf: number, o: { clinical?: number; human?: number; injection?: number } = {}): Decide => () => ({
  '@intent': choice(intent, conf), '@clinical': noul(o.clinical ?? 0.01), '@human': noul(o.human ?? 0.01), '@injection': noul(o.injection ?? 0.01),
});
const input = { patientFirstName: 'Sarah', clinicName: 'Clinic', treatmentName: 'Dental cleaning', slotText: 'tomorrow at 2:00 PM', history: [], message: 'Yes please' };

test('client: documented request shape, retries 429, typed errors', async () => {
  const { client, calls } = fakeJev(offerAnswers('accept', 0.97), { status: [429, 200] });
  const r = await client.ask({ s: 1 }, { '@intent': { type: 'choice', instructions: 'x', criteria: { a: 'A' } } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://jev.test/v1/systemone');
  assert.equal(calls[0].headers.authorization, 'Bearer test-key');
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['model', 'questions', 'state']);
  assert.equal(r.model, 'jev-1.13.0');
  assert.ok(Math.abs(client.cost(r.usage) - 1200 * 0.042 / 1e6) < 1e-12);
  const slow = fakeJev(offerAnswers('accept', 0.9), { delayMs: 800 });
  await assert.rejects(slow.client.ask({}, {}), JevError);
  const down = fakeJev(offerAnswers('accept', 0.9), { status: [500] });
  await assert.rejects(down.client.ask({}, {}), /jev 500/);
});

test('interpreter: one Jev call answers 4 typed questions; confident decisions skip the LLM', async () => {
  const { client, calls } = fakeJev(offerAnswers('decline', 0.96));
  const llm = new ScriptedLlm([]);
  const ji = new JevInterpreter({ jev: client, fallback: llm, minConfidence: 0.7, minAcceptConfidence: 0.85, log: silentLogger });
  const r = await ji.interpret({ ...input, message: 'No, thanks.' });
  assert.equal(r.value.intent, 'decline');
  assert.equal(r.decidedBy, 'jev');
  assert.equal(llm.calls, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].body.questions).sort(), ['@clinical', '@human', '@injection', '@intent']);
  assert.match(r.value.reply, /yes or no/, 'clarification text comes from templates, not from Jev');
});

test('interpreter: accept needs a higher bar; injection or low confidence goes to the LLM fallback', async () => {
  const mk = (d: Decide) => { const llm = new ScriptedLlm([{ intent: 'ambiguous', confidence: 0.5 }]); return { llm, ji: new JevInterpreter({ jev: fakeJev(d).client, fallback: llm, minConfidence: 0.7, minAcceptConfidence: 0.85, log: silentLogger }) }; };
  let t = mk(offerAnswers('accept', 0.8));
  let r = await t.ji.interpret(input);
  assert.equal(t.llm.calls, 1);
  assert.match(r.decidedBy!, /^llm_fallback:low_confidence:accept/);
  t = mk(offerAnswers('accept', 0.98, { injection: 0.9 }));
  r = await t.ji.interpret(input);
  assert.equal(t.llm.calls, 1, 'manipulative accept is never taken from Jev');
  t = mk(offerAnswers('accept', 0.6, { clinical: 0.93 }));
  r = await t.ji.interpret(input);
  assert.equal(r.value.intent, 'clinical_concern');
  assert.equal(t.llm.calls, 0);
});

test('interpreter: Jev down -> LLM fallback; no fallback -> safe "ambiguous"', async () => {
  const down = fakeJev(offerAnswers('accept', 0.99), { status: [503] });
  const llm = new ScriptedLlm([{ intent: 'accept', confidence: 0.9 }]);
  const r = await new JevInterpreter({ jev: down.client, fallback: llm, minConfidence: 0.7, minAcceptConfidence: 0.85, log: silentLogger }).interpret(input);
  assert.equal(r.decidedBy, 'llm_fallback:jev_error');
  const r2 = await new JevInterpreter({ jev: fakeJev(offerAnswers('accept', 0.5)).client, fallback: null, minConfidence: 0.7, minAcceptConfidence: 0.85, log: silentLogger }).interpret(input);
  assert.equal(r2.value.intent, 'ambiguous');
});

test('workflow with Jev: the offer reply is decided by Jev and the booking completes', async () => {
  const { client } = fakeJev(offerAnswers('accept', 0.97));
  const llm = new ScriptedLlm([]);
  const h = await createHarness({ llm, overrides: { jev: client } });
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    await h.reply(IDS.phone.sarah, 'Yes please');
    assert.equal((await h.workflow(workflowId)).status, 'booked');
    assert.equal(llm.calls, 0);
    const ev = (await h.db.query(`SELECT payload FROM workflow_events WHERE workflow_id = $1 AND event_type = 'response_interpreted'`, [workflowId])).rows[0].payload;
    assert.equal(ev.llm.decidedBy, 'jev');
  } finally { await h.close(); }
});

test('confirmation gate with Jev: natural yes confirms, low confidence and Jev outages are safe', async () => {
  let next: Decide = () => ({ '@answer': choice('confirm', 0.96), '@injection': noul(0.02) });
  const { client, calls } = fakeJev((q, s) => next(q, s));
  const h = await createHarness({ overrides: { jev: client } });
  const NOAH = IDS.phone.noah;
  try {
    await h.reply(NOAH, 'I need to cancel my appointment');
    // A reply the regex rules would NOT accept as a yes:
    next = () => ({ '@answer': choice('confirm', 0.6), '@injection': noul(0.02) });
    await h.reply(NOAH, "that'd be lovely, thank you");
    assert.equal((await h.db.query(`SELECT status FROM appointments WHERE id = $1`, [IDS.appt.noahFilling])).rows[0].status, 'scheduled', 'low confidence never confirms');
    next = () => ({ '@answer': choice('confirm', 0.96), '@injection': noul(0.02) });
    await h.reply(NOAH, "that'd be lovely, thank you!");
    assert.equal((await h.db.query(`SELECT status FROM appointments WHERE id = $1`, [IDS.appt.noahFilling])).rows[0].status, 'cancelled');
    const judged = (await h.db.query(`SELECT payload FROM workflow_events WHERE event_type = 'confirmation_judged' ORDER BY id`)).rows.map(r => r.payload.by);
    assert.deepEqual(judged, ['jev', 'jev']);
    assert.ok(calls.some(c => c.body.questions['@answer']));
  } finally { await h.close(); }
});

test('confirmation judge: Jev outage falls back to the rules', async () => {
  const j = new JevConfirmationJudge({ jev: fakeJev(() => ({}), { status: [503] }).client, minConfidence: 0.85, log: silentLogger });
  assert.deepEqual((({ verdict, by }) => ({ verdict, by }))(await j.judge('Cancel X?', 'yes')), { verdict: 'confirm', by: 'rules_fallback' });
  assert.equal((await j.judge('Cancel X?', 'hmm maybe')).verdict, 'unclear');
});
