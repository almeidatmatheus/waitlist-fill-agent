// Test harness: real PostgreSQL (TEST_DATABASE_URL) + the real LangGraph workflow, with every external
// dependency replaced by an in-process double (mock calendar, mock WhatsApp gateway, rule-based LLM).
// No network, no WhatsApp session, no Outlook account, no paid OpenAI calls.
import { loadConfig, type AppConfig } from '../../src/config/env.ts';
import { buildApp, type App, type AppOverrides } from '../../src/app.ts';
import { createPool, type Db } from '../../src/database/pool.ts';
import { dropAll, migrate } from '../../src/database/migrate.ts';
import { seed, truncateAll } from '../../src/database/seed.ts';
import { silentLogger, createLogger } from '../../src/shared/logger.ts';
import { MockCalendar } from '../../src/integrations/outlook-mcp/mock-calendar.ts';
import { MockMessaging } from '../../src/integrations/wa-akg/mock-messaging.ts';
import { RuleBasedLlm } from '../../src/agents/rule-based-llm.ts';
import { buildWaAkgWebhook, signBody } from '../../src/integrations/wa-akg/webhook.ts';
import { syncAppointmentsToCalendar } from '../../src/services/calendar-sync.ts';
import type { LlmPort } from '../../src/agents/types.ts';

export const ADMIN = 'test-admin-token-0123456789';
export const SECRET = 'test-webhook-secret-0123456789';

export const IDS = {
  appt: { oliverCleaning: '33333333-0000-4000-8000-000000000001', noahFilling: '33333333-0000-4000-8000-000000000002', isla: '33333333-0000-4000-8000-000000000003', ethanCleaning: '33333333-0000-4000-8000-000000000005' },
  patient: { oliver: '22222222-0000-4000-8000-000000000001', sarah: '22222222-0000-4000-8000-000000000002', james: '22222222-0000-4000-8000-000000000003', isla: '22222222-0000-4000-8000-000000000006', grace: '22222222-0000-4000-8000-000000000008', mia: '22222222-0000-4000-8000-000000000010' },
  waitlist: { sarah: '44444444-0000-4000-8000-000000000001', james: '44444444-0000-4000-8000-000000000002', grace: '44444444-0000-4000-8000-000000000003', mia: '44444444-0000-4000-8000-000000000005', leo: '44444444-0000-4000-8000-000000000006', isla: '44444444-0000-4000-8000-000000000007' },
  phone: { oliver: '+447700900001', sarah: '+447700900002', james: '+447700900003', isla: '+447700900006', grace: '+447700900008', mia: '+447700900010', noah: '+447700900005' },
};

export function testConfig(over: Record<string, string> = {}): AppConfig {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required for tests (see .env.example)');
  return loadConfig({
    NODE_ENV: 'test', DATABASE_URL: url, ADMIN_API_TOKEN: ADMIN, WA_AKG_WEBHOOK_SECRET: SECRET, WA_AKG_SESSION_ID: 'clinic-test',
    LLM_PROVIDER: 'mock', CALENDAR_PROVIDER: 'mock', MESSAGING_PROVIDER: 'mock', CLINIC_TIMEZONE: 'Europe/London',
    CANCELLATION_POLL_MS: '0', SWEEP_INTERVAL_MS: '0', OFFER_TTL_MINUTES: '30', OFFER_CASCADE_SIZE: '1', OFFER_WIDEN_AFTER_MINUTES: '0', MIN_LEAD_TIME_MINUTES: '60', MAX_CLARIFICATION_TURNS: '2',
    CANCELLATION_CONFIRMATIONS: '2', LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'error',
    ...over,
  });
}

let schemaReady: Promise<void> | null = null;
let sharedDb: Db | null = null;

export function testDb(): Db {
  sharedDb ??= createPool(process.env.TEST_DATABASE_URL!, 10);
  return sharedDb;
}

/** Fresh schema once per test process, then truncate + seed per harness. */
export async function resetDb(): Promise<Db> {
  const db = testDb();
  schemaReady ??= (async () => { await dropAll(db); await migrate(db); })();
  await schemaReady;
  await truncateAll(db);
  await seed(db, 'Europe/London');
  return db;
}

export interface Harness {
  app: App;
  db: Db;
  calendar: MockCalendar;
  messaging: MockMessaging;
  clock: { now: Date };
  trigger(appointmentId: string): Promise<{ workflowId: string; created: boolean }>;
  reply(phone: string, text: string, messageId?: string): Promise<{ status: number; body: any }>;
  advance(minutes: number): void;
  sent(phone: string): string[];
  lastSent(phone: string): string | undefined;
  workflow(workflowId: string): Promise<any>;
  offers(workflowId: string): Promise<any[]>;
  close(): Promise<void>;
}

let msgSeq = 0;

export async function createHarness(opts: { llm?: LlmPort; overrides?: Partial<AppOverrides>; config?: Record<string, string> } = {}): Promise<Harness> {
  const db = await resetDb();
  const calendar = new MockCalendar();
  const messaging = new MockMessaging();
  const clock = { now: new Date() };
  const cfg = testConfig(opts.config);
  const app = await buildApp(cfg, {
    db, calendar, messaging, llm: opts.llm ?? new RuleBasedLlm(), now: () => new Date(clock.now),
    log: process.env.TEST_LOG_LEVEL ? createLogger({}, { level: process.env.TEST_LOG_LEVEL as any }) : silentLogger,
    booking: { baseBackoffMs: 0, staleClaimMs: 60_000 },
    ...opts.overrides,
  });
  await syncAppointmentsToCalendar(db, calendar, cfg.clinic.timezone, clock.now);
  calendar.createCalls = 0;
  calendar.listCalls = 0;
  app.calendar.calls.length = 0;

  const h: Harness = {
    app, db, calendar, messaging, clock,
    async trigger(appointmentId) {
      const r = await app.runner.startForCancellation({ appointmentId, source: 'manual', observation: 'manual' });
      return { workflowId: r.workflowId, created: r.created };
    },
    async reply(phone, text, messageId) {
      const id = messageId ?? `TESTMSG${process.pid}${++msgSeq}`;
      const payload = JSON.stringify(buildWaAkgWebhook({ sessionId: 'clinic-test', messageId: id, fromJid: `${phone.replace(/\D/g, '')}@s.whatsapp.net`, text }));
      const res = await app.server.inject({ method: 'POST', url: '/webhooks/wa-akg', payload, headers: { 'content-type': 'application/json', 'x-webhook-signature': signBody(SECRET, payload) } });
      await app.tasks.idle();
      return { status: res.statusCode, body: res.json() };
    },
    advance(minutes) { clock.now = new Date(clock.now.getTime() + minutes * 60000); },
    sent(phone) { return messaging.to(phone).map(m => m.text); },
    lastSent(phone) { const s = messaging.to(phone); return s[s.length - 1]?.text; },
    async workflow(id) { return (await db.query('SELECT * FROM recovery_workflows WHERE id = $1', [id])).rows[0]; },
    async offers(id) { return (await db.query('SELECT * FROM appointment_offers WHERE workflow_id = $1 ORDER BY created_at', [id])).rows; },
    async close() { await app.tasks.idle(); await app.server.close(); },
  };
  return h;
}

export async function closeDb() {
  if (sharedDb) { await sharedDb.end(); sharedDb = null; schemaReady = null; }
}
