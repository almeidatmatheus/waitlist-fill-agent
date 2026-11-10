// Debug tool: replay scripted patient turns against the real agent (test DB, mock calendar/WhatsApp) and
// print the conversation with every tool call, gate decision and fallback. Uses real OpenAI (and Jev with --jev).
//   node --env-file=.env scripts/agent-replay.ts '["Cancel Monday","y"]' [--jev] [--reps=3] [--patient=noah]
import OpenAI from 'openai';
import { createHarness, closeDb, IDS } from '../tests/support/harness.ts';
import { JevClient } from '../src/agents/jev/client.ts';

const E = process.env;
const turns: string[] = JSON.parse(process.argv[2] ?? '[]');
const withJev = process.argv.includes('--jev');
const reps = Number(process.argv.find(a => a.startsWith('--reps='))?.slice(7) ?? 1);
const who = (process.argv.find(a => a.startsWith('--patient='))?.slice(10) ?? 'noah') as keyof typeof IDS.phone;
const phone = IDS.phone[who];

for (let rep = 1; rep <= reps; rep++) {
  const jev = withJev ? new JevClient({ apiKey: E.TYPESAFE_API_KEY!, model: E.TYPESAFE_MODEL || 'jev-latest', url: E.TYPESAFE_URL || 'https://api.typesafe.ai', timeoutMs: 2500, priceInputPer1M: 0.042 }) : null;
  const h = await createHarness({ overrides: { agentClient: new OpenAI({ apiKey: E.OPENAI_API_KEY }), jev }, config: { OPENAI_MODEL: E.OPENAI_MODEL! } });
  console.log(`--- run ${rep}${withJev ? ' (Jev)' : ''}`);
  let seen = 0;
  for (const t of turns) {
    const before = (await h.db.query(`SELECT max(id) m FROM workflow_events`)).rows[0].m ?? 0;
    await h.reply(phone, t);
    console.log(`P: ${t}`);
    const ev = (await h.db.query(`SELECT event_type, payload FROM workflow_events WHERE id > $1 AND event_type IN ('agent_turn', 'confirmation_judged') ORDER BY id`, [before])).rows;
    for (const e of ev) {
      if (e.event_type === 'confirmation_judged') console.log(`   gate: ${e.payload.by} -> ${e.payload.verdict} (${e.payload.confidence ?? '-'})`);
      else console.log(`   tools: ${(e.payload.tools ?? []).map((x: any) => `${x.name}${x.status ? `=${x.status}` : ''}`).join(', ') || '-'}${e.payload.usedFallback ? `  FALLBACK(${e.payload.fallbackReason ?? '?'}${e.payload.rejectedReply ? `: "${e.payload.rejectedReply}"` : ''})` : ''}`);
    }
    for (const m of h.sent(phone).slice(seen)) console.log(`C: ${m}`);
    seen = h.sent(phone).length;
  }
  await h.close();
}
await closeDb();
