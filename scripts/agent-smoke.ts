// Live smoke test of the function-calling agent with the REAL OpenAI model (uses OPENAI_API_KEY / OPENAI_MODEL).
// Runs against TEST_DATABASE_URL with the mock calendar and mock WhatsApp: no real messages are sent.
//   node --env-file=.env scripts/agent-smoke.ts
import OpenAI from 'openai';
import { createHarness, closeDb, IDS } from '../tests/support/harness.ts';

if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) throw new Error('OPENAI_API_KEY and OPENAI_MODEL are required');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60000 });
const h = await createHarness({ overrides: { agentClient: client }, config: { OPENAI_MODEL: process.env.OPENAI_MODEL } });
const NOAH = IDS.phone.noah;
const say = async (text: string) => {
  console.log(`\npatient> ${text}`);
  const before = h.sent(NOAH).length;
  await h.reply(NOAH, text);
  const ev = (await h.db.query(`SELECT payload FROM workflow_events WHERE event_type = 'agent_turn' ORDER BY id DESC LIMIT 1`)).rows[0]?.payload;
  console.log(`  tools: ${ev?.tools?.map((t: any) => `${t.name}${t.status ? `(${t.status})` : ''}${t.ok ? '' : '!'}`).join(' -> ') || '(none)'} | calls=${ev?.modelCalls} tokens=${(ev?.inputTokens ?? 0) + (ev?.outputTokens ?? 0)} ${ev?.latencyMs}ms${ev?.usedFallback ? ' FALLBACK' : ''}`);
  console.log(`clinic > ${h.sent(NOAH).length > before ? h.lastSent(NOAH) : '(no reply)'}`);
};
try {
  await say('Hi! I have an appointment tomorrow but I need to move it to 4pm if possible');
  await say('yes please');
  await say('thanks!');
  await say('actually, can I cancel it?');
  await say('yes');
  const a = (await h.db.query(`SELECT status, source, to_char(starts_at AT TIME ZONE 'Europe/London','DD Mon HH24:MI') t FROM appointments WHERE patient_id = '22222222-0000-4000-8000-000000000005' ORDER BY created_at`)).rows;
  console.log('\nNoah appointments:', a);
  console.log('Mia (waiting list) got:', h.sent(IDS.phone.mia).length, 'offer(s)');
} finally {
  await h.close();
  await closeDb();
}
