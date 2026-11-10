// End-to-end demo, fully offline and reproducible:
//   - PostgreSQL (docker compose) with the synthetic clinic seed
//   - the real Fastify server, LangGraph workflow, PostgreSQL checkpoints and services
//   - calendar: the REAL outlook-calendar-lite-mcp process over stdio, backed by a local fake Microsoft
//     Graph (when the MCP clone is found), otherwise the in-memory mock calendar
//   - WhatsApp: mock gateway; patient replies are POSTed to /webhooks/wa-akg with a valid WA-AKG HMAC
//   - LLM: rule-based mock by default; LLM_PROVIDER=openai uses OpenAI (OPENAI_MODEL)
// It RESETS the database in DATABASE_URL, so it refuses to run in production.
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config/env.ts';
import { buildApp } from '../src/app.ts';
import { createPool } from '../src/database/pool.ts';
import { dropAll, migrate } from '../src/database/migrate.ts';
import { seed } from '../src/database/seed.ts';
import { createLogger } from '../src/shared/logger.ts';
import { MockCalendar } from '../src/integrations/outlook-mcp/mock-calendar.ts';
import { MockMessaging } from '../src/integrations/wa-akg/mock-messaging.ts';
import { McpClient } from '../src/integrations/outlook-mcp/mcp-client.ts';
import { OutlookMcpCalendar } from '../src/integrations/outlook-mcp/outlook-mcp-calendar.ts';
import { startFakeGraph, type FakeGraph } from '../src/integrations/outlook-mcp/fake-graph.ts';
import { buildWaAkgWebhook, signBody } from '../src/integrations/wa-akg/webhook.ts';
import { syncAppointmentsToCalendar } from '../src/services/calendar-sync.ts';
import type { CalendarPort } from '../src/integrations/outlook-mcp/types.ts';

if (process.env.NODE_ENV === 'production') throw new Error('the demo resets the database; refusing to run in production');
const cfg = loadConfig({ ...process.env, NODE_ENV: 'development', MESSAGING_PROVIDER: 'mock', OFFER_CASCADE_SIZE: '1', CANCELLATION_POLL_MS: '0', SWEEP_INTERVAL_MS: '0', CANCELLATION_CONFIRMATIONS: '2', OUTLOOK_MCP_NOTIFY_URL: '', OUTLOOK_MCP_NOTIFY_SECRET: '' });
const root = join(import.meta.dirname, '..');
mkdirSync(join(root, '.data'), { recursive: true });
const logFile = join(root, '.data', 'demo.log');
const log = createLogger({ service: 'aar-demo' }, { level: 'info', sink: line => appendFileSync(logFile, line + '\n') });

const C = { b: '\x1b[1m', d: '\x1b[2m', g: '\x1b[32m', c: '\x1b[36m', y: '\x1b[33m', r: '\x1b[0m' };
const say = (s: string) => console.log(s);
const step = (n: number, s: string) => say(`\n${C.b}${C.c}[${n}] ${s}${C.r}`);

// ---- database
const db = createPool(cfg.databaseUrl);
await dropAll(db);
await migrate(db);
await seed(db, cfg.clinic.timezone);

// ---- calendar: real MCP + fake Graph when available
const mcpPath = [process.env.OUTLOOK_MCP_PATH, join(root, '..', 'outlook-calendar-lite-mcp', 'src', 'main.ts')].find(p => p && existsSync(p));
let fakeGraph: FakeGraph | null = null;
let calendar: CalendarPort;
let calendarLabel: string;
if (mcpPath && process.env.DEMO_CALENDAR !== 'mock') {
  fakeGraph = await startFakeGraph({ timezone: cfg.clinic.timezone, calendarName: cfg.clinic.calendarName || 'Bright Smile Clinic' });
  const client = new McpClient({ transport: 'stdio', stdio: { command: process.execPath, args: [mcpPath], env: fakeGraph.mcpEnv }, timeoutMs: 20000, log });
  calendar = new OutlookMcpCalendar(client, cfg.clinic.calendarName || 'Bright Smile Clinic');
  calendarLabel = `real outlook-calendar-lite-mcp (stdio) -> fake Microsoft Graph at ${fakeGraph.url}`;
} else {
  calendar = new MockCalendar();
  calendarLabel = 'in-memory mock calendar (MCP clone not found)';
}
const messaging = new MockMessaging();
let offsetMs = 0;
const app = await buildApp(cfg, { db, calendar, messaging, log, now: () => new Date(Date.now() + offsetMs) });
await app.server.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
const auth = { authorization: `Bearer ${cfg.adminApiToken}`, 'content-type': 'application/json' };

let printed = 0;
const showOutbox = () => {
  for (const m of messaging.sent.slice(printed)) say(`   ${C.g}clinic -> ${m.to.phoneNumber.slice(0, 6)}***${m.to.phoneNumber.slice(-3)}:${C.r} ${m.text}`);
  printed = messaging.sent.length;
};
let seq = 0;
const patientSays = async (phone: string, text: string, messageId = `DEMO${Date.now()}${++seq}`) => {
  say(`   ${C.y}patient ${phone.slice(0, 6)}***${phone.slice(-3)} ->${C.r} ${text}`);
  const payload = JSON.stringify(buildWaAkgWebhook({ sessionId: cfg.messaging.sessionId, messageId, fromJid: `${phone.slice(1)}@s.whatsapp.net`, text }));
  const r = await fetch(`${base}/webhooks/wa-akg`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-signature': signBody(cfg.messaging.webhookSecret, payload) }, body: payload });
  const body = await r.json() as { status: string };
  await app.tasks.idle();
  say(`   ${C.d}webhook -> HTTP ${r.status} ${body.status}${C.r}`);
  showOutbox();
};
const api = async (path: string, init: RequestInit = {}) => (await fetch(base + path, { ...init, headers: { ...auth, ...(init.headers ?? {}) } })).json() as Promise<any>;

say(`${C.b}Waitlist Fill Agent - end-to-end demo (synthetic data only)${C.r}`);
say(`${C.d}server: ${base} | calendar: ${calendarLabel} | WhatsApp: mock gateway | LLM: ${app.llm.name} | logs: .data/demo.log${C.r}`);

step(1, 'Load the synthetic clinic into the Outlook calendar (through MCP)');
const tools = await app.calendar.capabilities();
say(`   MCP tools discovered: ${tools.join(', ')}`);
const sync = await syncAppointmentsToCalendar(db, app.calendar, cfg.clinic.timezone, app.now());
say(`   calendar events created: ${sync.created} (already present: ${sync.present})`);

step(2, "Oliver's dental cleaning (tomorrow 2 PM) is deleted in Outlook; the poller detects it");
if (fakeGraph) fakeGraph.removeBySubjectToken('AAR-a0000001'); else (calendar as MockCalendar).removeByRef('AAR-a0000001');
let poll = await api('/dev/poll-cancellations', { method: 'POST', body: '{}' });
say(`   poll #1: suspected=${poll.suspected.length} confirmed=${poll.confirmed.length} (one miss is not enough)`);
poll = await api('/dev/poll-cancellations', { method: 'POST', body: '{}' });
say(`   poll #2: confirmed=${poll.confirmed.length} -> recovery workflow ${poll.confirmed[0]?.workflowId}`);
const wf1 = poll.confirmed[0].workflowId as string;
showOutbox();

step(3, 'Sarah asks for another day; the agent clarifies without inventing availability');
await patientSays('+447700900002', 'Can I come on Friday instead?');

step(4, 'Sarah declines; the workflow moves to the next eligible patient (James)');
await patientSays('+447700900002', 'No, thanks.');

step(5, 'James accepts; WA-AKG delivers the same webhook twice');
await patientSays('+447700900003', 'Yes, please.', 'DEMO-DUPLICATE-1');
await patientSays('+447700900003', 'Yes, please.', 'DEMO-DUPLICATE-1');
const d1 = await api(`/workflows/${wf1}`);
say(`   workflow: ${d1.workflow.status} | bookings: ${d1.bookings.map((b: any) => `${b.status} ${b.calendar_ref}`).join(', ')}`);
const events = fakeGraph ? fakeGraph.events.filter(e => e.subject.includes(d1.bookings[0].calendar_ref)).map(e => `${e.subject} @ ${e.start}`) : (calendar as MockCalendar).findByRef(d1.bookings[0].calendar_ref).map(e => `${e.title} @ ${e.start}`);
say(`   Outlook events for this booking: ${events.length} -> ${events.join(' | ')}`);

step(6, "Ethan's cleaning is cancelled manually (dev endpoint); Sarah gets the offer and lets it expire");
const t2 = await api('/dev/trigger-cancellation', { method: 'POST', body: JSON.stringify({ appointmentId: '33333333-0000-4000-8000-000000000005', removeFromCalendar: true }) });
say(`   workflow ${t2.workflowId}: ${t2.state} (waiting for ${t2.waitingFor})`);
showOutbox();
offsetMs += 31 * 60000;
say(`   ${C.d}(clock advanced 31 minutes)${C.r}`);
const sw = await api('/dev/sweep', { method: 'POST', body: '{}' });
say(`   sweeper: expired=${sw.expired}`);
showOutbox();

step(7, 'The next patient reports pain: human handoff, no medical advice');
await patientSays('+447700900006', 'I have severe tooth pain.');
const d2 = await api(`/workflows/${t2.workflowId}`);
say(`   workflow: ${d2.workflow.status} | handoffs: ${d2.handoffs.map((h: any) => `${h.reason} (notified=${h.notified})`).join(', ')}`);

step(8, 'Summary');
const wfs = await api('/workflows');
for (const w of wfs.workflows) say(`   ${w.treatment} ${w.local}: ${w.status} (${w.offers} offers)`);
const recovered = (await api('/appointments')).appointments.filter((a: any) => a.source === 'recovery');
say(`   recovered appointments: ${recovered.map((a: any) => `${a.patient} ${a.treatment} ${a.local} [${a.calendarRef}]`).join('; ')}`);
say(`   MCP calls: ${app.calendar.calls.length} (${app.calendar.calls.filter(c => !c.ok).length} failed) | WhatsApp messages sent: ${messaging.sent.length}`);

await app.close();
await db.end();
await fakeGraph?.close();
say(`\n${C.g}Demo complete.${C.r}`);
process.exit(0);
