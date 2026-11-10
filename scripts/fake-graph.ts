// Runs the fake Microsoft Graph standalone so `npm start` can use the REAL outlook-calendar-lite-mcp
// without a Microsoft account. Prints the OUTLOOK_MCP_* variables to use. Development only.
import { startFakeGraph } from '../src/integrations/outlook-mcp/fake-graph.ts';

const fg = await startFakeGraph({
  timezone: process.env.CLINIC_TIMEZONE || 'Europe/London',
  calendarName: process.env.CLINIC_CALENDAR_NAME || 'Bright Smile Clinic',
  port: Number(process.env.FAKE_GRAPH_PORT || 4010),
});
console.log(`fake Microsoft Graph listening on ${fg.url} (no real Microsoft calls)`);
console.log('Start the app in another terminal with:');
console.log(`  CALENDAR_PROVIDER=mcp OUTLOOK_MCP_PATH=/path/to/outlook-calendar-lite-mcp/src/main.ts \\`);
console.log('  ' + Object.entries(fg.mcpEnv).map(([k, v]) => `${k}=${v}`).join(' ') + ' npm start');
process.on('SIGINT', () => fg.close().then(() => process.exit(0)));
