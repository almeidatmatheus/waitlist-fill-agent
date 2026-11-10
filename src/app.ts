// Composition root: wires configuration, database, integrations (real or test doubles), services,
// the LangGraph workflow and the HTTP server. Every external dependency can be injected.
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config/env.ts';
import { createPool, type Db } from './database/pool.ts';
import { migrate } from './database/migrate.ts';
import { createLogger, type Logger } from './shared/logger.ts';
import { TaskTracker } from './shared/tasks.ts';
import type { CalendarPort } from './integrations/outlook-mcp/types.ts';
import { McpClient } from './integrations/outlook-mcp/mcp-client.ts';
import { OutlookMcpCalendar } from './integrations/outlook-mcp/outlook-mcp-calendar.ts';
import { MockCalendar } from './integrations/outlook-mcp/mock-calendar.ts';
import { InstrumentedCalendar } from './integrations/outlook-mcp/instrumented-calendar.ts';
import type { MessagingPort } from './integrations/wa-akg/types.ts';
import { WaAkgClient } from './integrations/wa-akg/wa-akg-client.ts';
import { MockMessaging } from './integrations/wa-akg/mock-messaging.ts';
import { SafeMessaging } from './integrations/wa-akg/safe-messaging.ts';
import type { LlmPort } from './agents/types.ts';
import { OpenAiLlm } from './agents/openai-llm.ts';
import { RuleBasedLlm } from './agents/rule-based-llm.ts';
import { MessagingService } from './services/messaging-service.ts';
import { BookingService, type BookingConfig } from './services/booking-service.ts';
import { HandoffService } from './services/handoff-service.ts';
import { InboundService } from './services/inbound-service.ts';
import { PatientRequestService } from './services/patient-request-service.ts';
import { ToolAgent } from './agents/tool-agent.ts';
import { JevClient } from './agents/jev/client.ts';
import { JevInterpreter } from './agents/jev/jev-interpreter.ts';
import { JevConfirmationJudge, type ConfirmationJudge } from './agents/jev/confirmation.ts';
import OpenAI from 'openai';
import { CancellationDetector } from './services/cancellation-detector.ts';
import { CalendarNotifications } from './services/calendar-notifications.ts';
import { Sweeper } from './services/sweeper.ts';
import { buildRecoveryGraph } from './workflows/recovery-graph.ts';
import { WorkflowRunner } from './workflows/runner.ts';
import { buildServer } from './api/server.ts';

export interface AppOverrides {
  db?: Db;
  log?: Logger;
  now?: () => Date;
  calendar?: CalendarPort;
  messaging?: MessagingPort;
  llm?: LlmPort;
  checkpointer?: BaseCheckpointSaver;
  booking?: Partial<BookingConfig>;
  handoffFetch?: typeof fetch;
  /** Inject a (fake) OpenAI client to run the function-calling agent in tests. */
  agentClient?: Pick<OpenAI, 'chat'>;
  /** Inject a Jev client (tests/benchmarks); null forces Jev off. */
  jev?: JevClient | null;
}

export interface App {
  cfg: AppConfig;
  db: Db;
  log: Logger;
  now: () => Date;
  /** Raw adapters (tests/dev endpoints inspect the mocks). */
  calendarImpl: CalendarPort;
  messagingImpl: MessagingPort;
  calendar: InstrumentedCalendar;
  messagingPort: MessagingPort;
  llm: LlmPort;
  messaging: MessagingService;
  booking: BookingService;
  handoff: HandoffService;
  runner: WorkflowRunner;
  inbound: InboundService;
  requests: PatientRequestService;
  detector: CancellationDetector;
  notifications: CalendarNotifications;
  sweeper: Sweeper;
  tasks: TaskTracker;
  server: FastifyInstance;
  startLoops(): void;
  close(): Promise<void>;
}

export function createCalendar(cfg: AppConfig, log: Logger): CalendarPort {
  if (cfg.calendar.provider === 'mock') return new MockCalendar({ file: join(process.cwd(), '.data', 'mock-calendar.json') });
  const client = cfg.calendar.transport === 'stdio'
    ? new McpClient({ transport: 'stdio', stdio: { command: cfg.calendar.command, args: [cfg.calendar.path], env: cfg.calendar.passthroughEnv }, timeoutMs: cfg.calendar.callTimeoutMs, log: log.child({ component: 'mcp' }) })
    : new McpClient({ transport: 'http', http: { url: cfg.calendar.url, bearerToken: cfg.calendar.bearerToken }, timeoutMs: cfg.calendar.callTimeoutMs, log: log.child({ component: 'mcp' }) });
  return new OutlookMcpCalendar(client, cfg.clinic.calendarName);
}

export function createMessaging(cfg: AppConfig): MessagingPort {
  if (cfg.messaging.provider === 'mock') return new MockMessaging();
  return new WaAkgClient({ baseUrl: cfg.messaging.baseUrl, apiKey: cfg.messaging.apiKey, sessionId: cfg.messaging.sessionId });
}

export function createLlm(cfg: AppConfig, log: Logger): LlmPort {
  if (cfg.llm.provider === 'mock') return new RuleBasedLlm();
  return new OpenAiLlm({ apiKey: cfg.llm.apiKey, model: cfg.llm.model, timeoutMs: cfg.llm.timeoutMs, priceInputPer1M: cfg.llm.priceInputPer1M, priceOutputPer1M: cfg.llm.priceOutputPer1M, log: log.child({ component: 'llm' }) });
}

export async function buildApp(cfg: AppConfig, o: AppOverrides = {}): Promise<App> {
  const log = o.log ?? createLogger({ service: 'aar' }, { level: cfg.logLevel });
  const now = o.now ?? (() => new Date());
  const db = o.db ?? createPool(cfg.databaseUrl);
  await migrate(db);

  let checkpointer = o.checkpointer;
  if (!checkpointer) {
    // LangGraph checkpoints live in their own schema, separate from operational business tables.
    const saver = new PostgresSaver(db, undefined, { schema: 'langgraph' });
    await saver.setup();
    checkpointer = saver;
  }

  const calendarImpl = o.calendar ?? createCalendar(cfg, log);
  const calendar = new InstrumentedCalendar(calendarImpl, log.child({ component: 'calendar' }));
  const messagingImpl = o.messaging ?? createMessaging(cfg);
  // Real gateways are always restricted to the explicit allow-list; the mock never contacts anyone.
  const messagingPort = new SafeMessaging(messagingImpl, messagingImpl.name === 'mock-messaging' ? null : cfg.messaging.allowedNumbers, log.child({ component: 'whatsapp' }));
  const baseLlm = o.llm ?? createLlm(cfg, log);
  // Jev (when configured) makes the typed decisions; the LLM stays as fallback and for text/tools.
  const jev = o.jev !== undefined ? o.jev : cfg.jev.enabled
    ? new JevClient({ apiKey: cfg.jev.apiKey, model: cfg.jev.model, url: cfg.jev.url, timeoutMs: cfg.jev.timeoutMs, priceInputPer1M: cfg.jev.priceInputPer1M })
    : null;
  const llm = jev ? new JevInterpreter({ jev, fallback: baseLlm, minConfidence: cfg.jev.minConfidence, minAcceptConfidence: cfg.jev.minAcceptConfidence, log: log.child({ component: 'jev' }) }) : baseLlm;
  const confirmation: ConfirmationJudge | undefined = jev ? new JevConfirmationJudge({ jev, minConfidence: cfg.jev.minAcceptConfidence, log: log.child({ component: 'jev' }) }) : undefined;

  const messaging = new MessagingService(db, messagingPort, log);
  const booking = new BookingService(db, calendar, { timezone: cfg.clinic.timezone, maxAttempts: 5, staleClaimMs: 120_000, baseBackoffMs: 5_000, ...o.booking }, log.child({ component: 'booking' }), now);
  const handoff = new HandoffService(db, cfg.handoffWebhookUrl, log, o.handoffFetch);
  const graph = buildRecoveryGraph({ db, cfg, log, now, llm, messaging, booking, handoff }, checkpointer);
  const runner = new WorkflowRunner({ db, graph, log, owner: `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}` });
  const requests = new PatientRequestService({ db, calendar, runner, messaging, handoff, log: log.child({ component: 'requests' }), now, tz: cfg.clinic.timezone, openingHours: cfg.clinic.openingHours, minLeadMinutes: cfg.clinic.minLeadTimeMinutes, ttlMinutes: cfg.clinic.requestTtlMinutes, clinicPhone: cfg.clinic.phoneDisplay, confirmation });
  // Real tool-calling agent whenever OpenAI is configured (or a test injects a client).
  const agent = o.agentClient || cfg.llm.provider === 'openai'
    ? new ToolAgent({
        client: o.agentClient ?? new OpenAI({ apiKey: cfg.llm.apiKey, timeout: cfg.llm.timeoutMs, maxRetries: 1 }), model: cfg.llm.model || 'test-model',
        requests, handoff, log: log.child({ component: 'agent' }), now, tz: cfg.clinic.timezone, clinicName: cfg.clinic.name, clinicPhone: cfg.clinic.phoneDisplay, openingHours: cfg.clinic.openingHours,
      })
    : null;
  const inbound = new InboundService({ db, runner, messaging, handoff, llm, requests, agent, log, now, timezone: cfg.clinic.timezone, clinicPhone: cfg.clinic.phoneDisplay, clinicName: cfg.clinic.name });
  const detector = new CancellationDetector(db, calendar, runner, log, now, { timezone: cfg.clinic.timezone, lookaheadDays: cfg.loops.cancellationLookaheadDays, confirmations: cfg.loops.cancellationConfirmations });
  const sweeper = new Sweeper({ db, runner, booking, inbound, messaging, requests, log, now });
  const tasks = new TaskTracker(log);
  const nt = cfg.calendar.notifications;
  const notifications = new CalendarNotifications({
    db, calendar, detector, tasks, log: log.child({ component: 'notifications' }), now, secret: nt.enabled ? nt.secret : '',
    renewBeforeMs: 24 * 3600000, debounceMs: nt.debounceMs, fallbackPollMs: cfg.loops.cancellationFallbackPollMs,
  });

  const timers: NodeJS.Timeout[] = [];
  const app: App = {
    cfg, db, log, now, calendarImpl, messagingImpl, calendar, messagingPort, llm, messaging, booking, handoff, runner, inbound, requests, detector, notifications, sweeper, tasks,
    server: undefined as unknown as FastifyInstance,
    startLoops() {
      if (cfg.loops.sweepIntervalMs > 0) timers.push(setInterval(() => tasks.run(() => sweeper.sweep()), cfg.loops.sweepIntervalMs));
      // With healthy change notifications the poll is only a safety net and runs at the slower fallback rate.
      if (cfg.loops.cancellationPollMs > 0) timers.push(setInterval(() => { if (notifications.pollDue()) tasks.run(() => detector.poll()); }, cfg.loops.cancellationPollMs));
      if (notifications.enabled) {
        // Called after the server is listening: Graph validates the URL while the subscription is created.
        tasks.run(() => notifications.ensure());
        timers.push(setInterval(() => tasks.run(() => notifications.ensure()), 60000));
      }
    },
    async close() {
      for (const t of timers) clearInterval(t);
      await app.server.close();
      await tasks.idle();
      await calendar.close();
      if (!o.db) await db.end();
    },
  };
  app.server = buildServer(app);
  return app;
}
