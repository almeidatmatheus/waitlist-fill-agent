// Fill simulation: how fast is a freed slot filled under each offer mode?
//
// Runs the REAL recovery workflow (LangGraph, services, webhook endpoint, sweeper, PostgreSQL test database)
// on a simulated clock, with mock calendar and WhatsApp doubles and the rule-based interpreter. No network,
// no API key. Scripted patients answer "yes" / "no" / nothing after a delay drawn from a seeded random
// generator, so every offer mode faces exactly the same patients in the same trial.
//
// The patient behaviour is an ASSUMPTION (see BEHAVIOUR below), not measured data. The numbers compare the
// modes with each other under that assumption; they do not predict a real clinic.
//
//   node --env-file=.env scripts/fill-sim.ts [--trials=150] [--patients=6]
//
// Writes evals/bench/results/fill-sim.json, docs/fill-simulation.md and the README block between
// <!-- FILL:START --> and <!-- FILL:END -->.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, closeDb, IDS, type Harness } from '../tests/support/harness.ts';

const arg = (name: string, fallback: number) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const TRIALS = arg('trials', 150);
const PATIENTS = arg('patients', 6);
const TTL = 30;           // OFFER_TTL_MINUTES
const MAX_MINUTES = 240;  // safety cap per trial

/** Assumed patient behaviour. */
const BEHAVIOUR = {
  pYes: 0.30,
  pNo: 0.20,          // the rest never answer
  delayMedianMin: 6,  // log-normal reply delay
  delaySigma: 1.0,
};

const MODES = [
  { key: 'one', label: 'One at a time', env: { OFFER_CASCADE_SIZE: '1', OFFER_WIDEN_AFTER_MINUTES: '0' } },
  { key: 'widen', label: 'Widening (default: 3 patients, +1 every 5 min)', env: { OFFER_CASCADE_SIZE: '3', OFFER_WIDEN_AFTER_MINUTES: '5' } },
  { key: 'all', label: 'All at once (3 patients)', env: { OFFER_CASCADE_SIZE: '3', OFFER_WIDEN_AFTER_MINUTES: '0' } },
] as const;

// ------------------------------------------------------------------ seeded randomness
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type Plan = { decision: 'yes' | 'no' | 'silent'; delay: number };
function plans(trial: number): Plan[] {
  const r = rng(1000 + trial);
  return Array.from({ length: PATIENTS }, () => {
    const u = r();
    const decision = u < BEHAVIOUR.pYes ? 'yes' : u < BEHAVIOUR.pYes + BEHAVIOUR.pNo ? 'no' : 'silent';
    const z = Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r()); // standard normal
    const delay = Math.max(1, Math.round(BEHAVIOUR.delayMedianMin * Math.exp(BEHAVIOUR.delaySigma * z)));
    return { decision, delay };
  });
}

// ------------------------------------------------------------------ one trial
interface TrialResult {
  filled: boolean;
  minutes: number | null;       // cancellation -> booking
  contacted: number;            // patients who received the offer
  winner: number | null;        // priority rank (0 = waited longest)
  fairWinner: boolean | null;   // winner is the longest-waiting patient who would say yes in time
  superseded: number;           // held an open offer and were told the slot went to someone else
  messages: number;             // WhatsApp messages sent by the clinic
}

const phoneOf = (i: number) => `+4477009010${String(i).padStart(2, '0')}`;
const NAMES = ['Ava', 'Ben', 'Cara', 'Dev', 'Elle', 'Finn', 'Gia', 'Hugo', 'Iris', 'Jon', 'Kay', 'Liam'];

async function setupWaitlist(h: Harness) {
  // Replace the seeded waiting list with PATIENTS synthetic patients for Oliver's cleaning slot, in a known order.
  await h.db.query('DELETE FROM waitlist');
  const treatment = (await h.db.query('SELECT treatment_id FROM appointments WHERE id = $1', [IDS.appt.oliverCleaning])).rows[0].treatment_id;
  for (let i = 0; i < PATIENTS; i++) {
    const phone = phoneOf(i);
    const p = await h.db.query(
      `INSERT INTO patients (full_name, phone_number, whatsapp_jid, contact_allowed) VALUES ($1, $2, $3, true) RETURNING id`,
      [`${NAMES[i % NAMES.length]} Sim${i}`, phone, `${phone.slice(1)}@s.whatsapp.net`],
    );
    await h.db.query(
      `INSERT INTO waitlist (patient_id, treatment_id, status, created_at) VALUES ($1, $2, 'waiting', now() - make_interval(days => $3))`,
      [p.rows[0].id, treatment, 100 - i],
    );
  }
}

async function runTrial(mode: (typeof MODES)[number], trial: number): Promise<TrialResult> {
  const h = await createHarness({ config: { ...mode.env, OFFER_TTL_MINUTES: String(TTL) } });
  try {
    await setupWaitlist(h);
    const plan = plans(trial);
    const offeredAt: (number | null)[] = plan.map(() => null);
    const replied: boolean[] = plan.map(() => false);
    const noteOffers = (t: number) => { for (let i = 0; i < PATIENTS; i++) if (offeredAt[i] === null && h.sent(phoneOf(i)).some(m => m.startsWith('Hi '))) offeredAt[i] = t; };

    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    noteOffers(0);
    let status = (await h.workflow(workflowId)).status as string;
    let minutes: number | null = null;
    for (let t = 1; t <= MAX_MINUTES && status === 'awaiting_patient'; t++) {
      h.advance(1);
      await h.app.sweeper.sweep();   // expiry and widening, like the real sweeper loop
      await h.app.tasks.idle();
      noteOffers(t);
      for (let i = 0; i < PATIENTS; i++) {
        const p = plan[i];
        if (replied[i] || offeredAt[i] === null || p.decision === 'silent' || offeredAt[i]! + p.delay > t) continue;
        // A patient who was already told the slot is gone does not answer the old offer.
        if (h.sent(phoneOf(i)).some(m => m.startsWith('Sorry, that appointment') || m.startsWith('This appointment offer has now expired'))) { replied[i] = true; continue; }
        replied[i] = true;
        await h.reply(phoneOf(i), p.decision === 'yes' ? 'Yes, please.' : 'No, thank you.');
        noteOffers(t);
      }
      status = (await h.workflow(workflowId)).status as string;
      if (status === 'booked') minutes = t;
    }
    const winner = plan.findIndex((_, i) => h.sent(phoneOf(i)).some(m => m.startsWith("You're all set")));
    const firstWilling = plan.findIndex(p => p.decision === 'yes' && p.delay < TTL);
    return {
      filled: status === 'booked', minutes,
      contacted: offeredAt.filter(x => x !== null).length,
      winner: winner === -1 ? null : winner,
      fairWinner: winner === -1 ? null : winner === firstWilling,
      superseded: plan.filter((_, i) => h.sent(phoneOf(i)).some(m => m.includes('has just been booked by another patient'))).length,
      messages: plan.reduce((n, _, i) => n + h.sent(phoneOf(i)).length, 0),
    };
  } finally { await h.close(); }
}

// ------------------------------------------------------------------ run + report
const q = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const num = (x: number | null, digits = 1) => (x === null ? '-' : x.toFixed(digits));

const started = Date.now();
const out: Record<string, { label: string; trials: TrialResult[] }> = {};
for (const mode of MODES) {
  const trials: TrialResult[] = [];
  for (let i = 0; i < TRIALS; i++) trials.push(await runTrial(mode, i));
  out[mode.key] = { label: mode.label, trials };
  console.log(`${mode.label}: ${trials.filter(t => t.filled).length}/${TRIALS} filled`);
}
await closeDb();

// A slot can only be filled if somebody on the list would say yes within the offer window.
const fillable = Array.from({ length: TRIALS }, (_, i) => plans(i).some(p => p.decision === 'yes' && p.delay < TTL)).filter(Boolean).length;

const row = (name: string, f: (t: TrialResult[]) => string) => `| ${name} | ${MODES.map(m => f(out[m.key].trials)).join(' | ')} |`;
const table = [
  `| | ${MODES.map(m => m.label).join(' | ')} |`,
  `|---|${MODES.map(() => '---').join('|')}|`,
  row('Slots filled', t => `${pct(t.filter(x => x.filled).length, TRIALS)} (${t.filter(x => x.filled).length}/${TRIALS})`),
  row('Minutes to fill: median / p90', t => { const m = t.filter(x => x.filled).map(x => x.minutes!); return `${num(q(m, 0.5), 0)} / ${num(q(m, 0.9), 0)}`; }),
  row('Minutes to fill: mean', t => num(mean(t.filter(x => x.filled).map(x => x.minutes!)))),
  row('Filled within 15 min', t => pct(t.filter(x => x.filled && x.minutes! <= 15).length, TRIALS)),
  row('Patients contacted per slot', t => num(mean(t.map(x => x.contacted)))),
  row('Messages sent per slot', t => num(mean(t.map(x => x.messages)))),
  row('Patients told "booked by another patient" per filled slot', t => num(mean(t.filter(x => x.filled).map(x => x.superseded)), 2)),
  row('Slot went to the longest-waiting patient who wanted it', t => { const f = t.filter(x => x.filled); return pct(f.filter(x => x.fairWinner).length, f.length); }),
].join('\n');

const assumptions = `${PATIENTS} eligible patients per slot; each says yes with probability ${BEHAVIOUR.pYes}, no with ${BEHAVIOUR.pNo}, and otherwise never answers; reply delay is log-normal with a median of ${BEHAVIOUR.delayMedianMin} minutes (sigma ${BEHAVIOUR.delaySigma}); offers expire after ${TTL} minutes`;
const root = join(import.meta.dirname, '..');
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

mkdirSync(join(root, 'evals/bench/results'), { recursive: true });
writeFileSync(join(root, 'evals/bench/results/fill-sim.json'), JSON.stringify({ at: new Date().toISOString(), trials: TRIALS, patients: PATIENTS, ttl: TTL, behaviour: BEHAVIOUR, fillable, modes: out }, null, 1));

writeFileSync(join(root, 'docs/fill-simulation.md'), `# Fill simulation: offer modes compared

Generated by \`scripts/fill-sim.ts\` (\`npm run sim:fill\`). Last run: ${stamp} UTC, ${TRIALS} simulated cancellations per mode.

**What runs.** The real recovery workflow: LangGraph, the services, the webhook endpoint, the sweeper and PostgreSQL, on a simulated clock that advances one minute at a time. The calendar and WhatsApp are in-memory doubles and replies are interpreted by the rule-based interpreter, so there is no network and no API cost. Each trial is one cancelled appointment. Every mode faces the same patients with the same answers and delays in the same trial.

**Assumed patient behaviour.** ${assumptions[0].toUpperCase()}${assumptions.slice(1)}. This is an assumption, not data from a clinic: the simulation compares the modes with each other, it does not predict real fill rates. With these numbers, ${fillable} of ${TRIALS} slots (${pct(fillable, TRIALS)}) have at least one patient who would accept in time, which is the ceiling for "slots filled".

${table}

**Reading the table.**

- "Minutes to fill" counts from the cancellation being detected to the confirmed booking. Detection time is not included (see [setup.md](setup.md): about 7 seconds with change notifications, 1 to 2 minutes with polling at the default settings).
- "Told booked by another patient" is the cost of the cascade: patients who held an open offer when someone else took the slot. One at a time never does this.
- "Longest-waiting patient who wanted it" is the fairness measure: among filled slots, how often the winner was the first patient in waiting-list order who would have said yes in time.

**What the simulation does not cover.**

- The simulated slot is on the next day, so no mode runs out of time and all three fill every slot that can be filled. For a slot a few hours away, a slower mode could run out of time; that was not simulated.
- A patient who has been told the slot is gone, or that the offer expired, does not answer afterwards. Two "yes" replies in the same instant are covered by a test (\`tests/offer-cascade.test.ts\`), not by this simulation.
- Replies are a plain "yes" or "no". Questions, clarifications and handoffs are not simulated.
- Time moves in one-minute steps.

Raw results: [evals/bench/results/fill-sim.json](../evals/bench/results/fill-sim.json).
`);

const block = `<!-- FILL:START -->
**Simulated comparison** (${TRIALS} cancellations per mode, the real workflow on a simulated clock; assumed behaviour: ${assumptions}). Details: [docs/fill-simulation.md](docs/fill-simulation.md). Reproduce with \`npm run sim:fill\`.

${table}

<sub>The patient behaviour is an assumption, not clinic data: the table compares the modes with each other. ${fillable} of ${TRIALS} slots had a patient who would accept in time, and the simulated slot is a day away, so every mode fills all of them. Last run: ${stamp} UTC.</sub>
<!-- FILL:END -->`;
const readmeP = join(root, 'README.md');
const readme = readFileSync(readmeP, 'utf8');
if (readme.includes('<!-- FILL:START -->')) writeFileSync(readmeP, readme.replace(/<!-- FILL:START -->[\s\S]*<!-- FILL:END -->/, () => block));
else console.log('README has no <!-- FILL:START --> block; not updated');

console.log(`\n${table}\n\n${Math.round((Date.now() - started) / 1000)} s; wrote evals/bench/results/fill-sim.json, docs/fill-simulation.md`);
