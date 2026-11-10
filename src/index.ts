import { loadConfig, ConfigError } from './config/env.ts';
import { buildApp } from './app.ts';
import { MockCalendar } from './integrations/outlook-mcp/mock-calendar.ts';
import { syncAppointmentsToCalendar } from './services/calendar-sync.ts';

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) { console.error(e.message); process.exit(1); }
  throw e;
}

const app = await buildApp(cfg);

// Offline mode: make sure the mock calendar mirrors the synthetic appointments.
if (app.calendarImpl instanceof MockCalendar) {
  const r = await syncAppointmentsToCalendar(app.db, app.calendar, cfg.clinic.timezone, app.now());
  app.log.info('mock_calendar.synced', r);
}

await app.server.listen({ port: cfg.port, host: cfg.host });
app.log.info('server.started', {
  url: `http://${cfg.host}:${cfg.port}`, env: cfg.nodeEnv, calendar: app.calendar.name, messaging: app.messagingPort.name, llm: app.llm.name,
});
app.startLoops();
// Pick up anything left pending by a previous run (webhooks, bookings, expired offers).
app.tasks.run(() => app.sweeper.sweep());

const shutdown = async (signal: string) => {
  app.log.info('server.stopping', { signal });
  await app.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
