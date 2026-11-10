// Reproducible eval command: runs Promptfoo against the real workflow and writes a summary
// (pass/fail per scenario, incorrect booking attempts, tool calls, latency, tokens, cost, scores).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const judge = process.argv.includes('--judge');
if (judge && !process.env.OPENAI_API_KEY) {
  console.error('eval:judge needs OPENAI_API_KEY (the LLM-as-judge grader runs on OpenAI).');
  process.exit(2);
}
if (!process.env.TEST_DATABASE_URL) {
  console.error('TEST_DATABASE_URL is required (evals reset that database).');
  process.exit(2);
}
const root = join(import.meta.dirname, '..');
const outDir = join(root, 'evals', 'output');
mkdirSync(outDir, { recursive: true });
const config = join(root, 'evals', judge ? 'promptfooconfig.judge.yaml' : 'promptfooconfig.yaml');
const out = join(outDir, judge ? 'results.judge.json' : 'results.json');

const env = {
  ...process.env,
  PROMPTFOO_DISABLE_TELEMETRY: '1', PROMPTFOO_DISABLE_UPDATE: '1', PROMPTFOO_DISABLE_SHARING: '1',
  PROMPTFOO_CONFIG_DIR: join(root, '.promptfoo'),
  ...(judge ? { PROMPTFOO_DEFAULT_GRADING_PROVIDER: `openai:chat:${process.env.EVAL_JUDGE_MODEL || process.env.OPENAI_MODEL}` } : {}),
};
const t0 = Date.now();
const r = spawnSync(join(root, 'node_modules', '.bin', 'promptfoo'), ['eval', '-c', config, '-o', out, '--no-cache', '-j', '1', '--no-progress-bar'], { env, stdio: 'inherit', cwd: root });

let results: any;
try { results = JSON.parse(readFileSync(out, 'utf8')); } catch { console.error('no Promptfoo results file produced'); process.exit(r.status ?? 1); }
const rows = (results.results?.results ?? results.results ?? []) as any[];
const lines = [
  `# Promptfoo evaluation results${judge ? ' (with LLM-as-judge)' : ''}`,
  '',
  `- Date: ${new Date().toISOString()}`,
  `- Command: \`npm run ${judge ? 'eval:judge' : 'eval'}\``,
  `- LLM under test: ${process.env.EVAL_LLM === 'openai' ? `OpenAI ${process.env.OPENAI_MODEL}` : 'deterministic rule-based interpreter (mock, no API calls)'}`,
  `- Wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  '',
  '| # | Scenario | Result | Score | Workflow status | Incorrect bookings | Tool calls | Latency ms | Tokens | Cost USD |',
  '|---|---|---|---|---|---|---|---|---|---|',
];
let pass = 0;
for (const [i, x] of rows.entries()) {
  let o: any = {};
  try { o = JSON.parse(x.response?.output ?? '{}'); } catch { /* error rows */ }
  const ok = x.success === true;
  if (ok) pass++;
  const failed = (x.gradingResult?.componentResults ?? []).filter((c: any) => !c.pass).map((c: any) => c.reason).join('; ');
  lines.push(`| ${i + 1} | ${x.testCase?.description ?? x.vars?.scenario} | ${ok ? 'PASS' : `FAIL${failed ? `: ${failed.replace(/\|/g, '/').slice(0, 120)}` : ''}`} | ${(x.score ?? 0).toFixed(2)} | ${o.workflowStatus ?? '-'} | ${o.incorrectBookingAttempts ?? '-'} | ${o.toolCalls?.length ?? '-'} | ${o.latencyMs ?? x.latencyMs ?? '-'} | ${(o.inputTokens ?? 0) + (o.outputTokens ?? 0)} | ${o.costUsd ?? 0} |`);
}
lines.push('', `**${pass}/${rows.length} scenarios passed.**`, '');
const md = lines.join('\n');
writeFileSync(join(outDir, judge ? 'summary.judge.md' : 'summary.md'), md);
console.log('\n' + md);
process.exit(pass === rows.length && rows.length > 0 ? 0 : 1);
