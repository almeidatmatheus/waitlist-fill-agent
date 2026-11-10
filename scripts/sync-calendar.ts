// Pushes the synthetic scheduled appointments into the configured clinic calendar (mock or real MCP).
// Use once after `npm run db:seed` when CALENDAR_PROVIDER=mcp, so the poller has events to compare against.
import { loadConfig } from '../src/config/env.ts';
import { createCalendar } from '../src/app.ts';
import { createPool } from '../src/database/pool.ts';
import { createLogger } from '../src/shared/logger.ts';
import { syncAppointmentsToCalendar } from '../src/services/calendar-sync.ts';

const cfg = loadConfig();
const log = createLogger({ service: 'aar-sync' }, { level: cfg.logLevel });
const db = createPool(cfg.databaseUrl, 2);
const calendar = createCalendar(cfg, log);
try {
  console.log('tools:', (await calendar.capabilities()).join(', '));
  const r = await syncAppointmentsToCalendar(db, calendar, cfg.clinic.timezone, new Date());
  console.log('calendar sync:', r);
  if (r.approvalRequired) console.log('Some events need approval in the MCP client (they were NOT confirmed automatically).');
} finally {
  await calendar.close();
  await db.end();
}
