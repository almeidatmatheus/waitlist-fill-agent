import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseLsOutput, parseCrOutput, parseEdOutput, classifyMcpError, OutlookMcpCalendar } from '../src/integrations/outlook-mcp/outlook-mcp-calendar.ts';
import { McpClient } from '../src/integrations/outlook-mcp/mcp-client.ts';
import { startFakeGraph } from '../src/integrations/outlook-mcp/fake-graph.ts';
import { silentLogger } from '../src/shared/logger.ts';
import { CalendarError } from '../src/shared/errors.ts';

// Permanent Graph ids are long base64 strings.
const GID = ['AAMkAGI2THVSAAA1=', 'AAMkAGI2THVSAAA2=', 'AAMkAGI2THVSAAA3='].map(x => x + 'x'.repeat(100));
const LS = `#agenda ter 11-10 → qua 11-11 (Europe/London) · agora: dom 11-08 11:18
id|dia|ini|fim|titulo|local|org|resp|on|rec|disp
${GID[0]}|ter 11-10|14:00|14:30|AAR-a0000001 · Dental cleaning · Oliver B.|-|eu|org|0|0|ocup
${GID[1]}|ter 11-10|15:00|15:30|[cancelado] AAR-a0000005 · Dental cleaning · Ethan W.|-|eu|org|0|0|ocup
${GID[2]}|qua 11-11|dia todo|-|Staff training|-|eu|org|0|0|livre`;

test('ls output: rows, cancelled marker, refs, all-day and year inference', () => {
  const r = parseLsOutput(LS, '2026-11-10', '2026-11-11');
  assert.equal(r.complete, true);
  assert.equal(r.events.length, 3);
  assert.deepEqual(r.events[0], { ref: 'AAR-a0000001', title: 'AAR-a0000001 · Dental cleaning · Oliver B.', start: '2026-11-10T14:00', end: '2026-11-10T14:30', allDay: false, cancelled: false, showAs: 'busy', graphId: GID[0] });
  assert.equal(r.events[1].cancelled, true);
  assert.equal(r.events[1].ref, 'AAR-a0000005');
  assert.equal(r.events[2].allDay, true);
  assert.equal(r.events[2].showAs, 'free');
  assert.equal(r.events[2].ref, null);
});

test('cr output: the created event id is returned as graphId', () => {
  assert.deepEqual(parseCrOutput(`criado:${GID[0]}|ter 11-10 14:00–14:30 (30 min)`), { status: 'created', graphId: GID[0], raw: `criado:${GID[0]}|ter 11-10 14:00–14:30 (30 min)` });
});

test('ls output: "+mais" marks truncated listings and "0 eventos" is an empty, complete listing', () => {
  assert.equal(parseLsOutput(LS.replace('· agora', '· +mais (use qtd ou de/ate) · agora'), '2026-11-10', '2026-11-11').complete, false);
  assert.deepEqual(parseLsOutput('#agenda ter 11-10 → ter 11-10 (Europe/London) · agora: x\n0 eventos', '2026-11-10', '2026-11-10'), { events: [], complete: true });
  assert.throws(() => parseLsOutput('something else', '2026-11-10', '2026-11-10'), CalendarError);
});

test('ed output: updated vs confirmation required', () => {
  assert.deepEqual(parseEdOutput('alterado|qua 12-02 10:00–10:45 (45 min)'), { status: 'updated' });
  assert.equal(parseEdOutput('ALTERAR "x"\n\nCONFIRMAÇÃO NECESSÁRIA: ... cf="abc123".').status, 'approval_required');
});

test('cr output: created vs confirmation required (never auto-confirmed)', () => {
  assert.equal(parseCrOutput(`criado:${GID[1]}|ter 11-10 14:00–14:30 (30 min)`).status, 'created');
  const r = parseCrOutput('CRIAR "x" ter 11-10\nconvite para: a@b.com\n\nCONFIRMAÇÃO NECESSÁRIA: mostre isto ao usuário; se ele aprovar, repita a chamada idêntica com cf="abc123".');
  assert.equal(r.status, 'approval_required');
});

test('MCP errors are classified (auth / transient / protocol)', () => {
  assert.equal(classifyMcpError('erro: login necessário: abra https://microsoft.com/devicelogin').kind, 'auth');
  assert.equal(classifyMcpError('erro: graph 503 ServiceUnavailable: down').kind, 'transient');
  assert.equal(classifyMcpError('erro: calendário desconhecido: Clinic').kind, 'protocol');
});

// ---- Integration with the REAL outlook-calendar-lite-mcp process (stdio), backed by the fake Graph.
const candidates = [process.env.OUTLOOK_MCP_TEST_PATH, process.env.OUTLOOK_MCP_PATH, join(import.meta.dirname, '..', '..', 'outlook-calendar-lite-mcp', 'src', 'main.ts')].filter(Boolean) as string[];
const mcpPath = candidates.find(p => existsSync(p));

test('real Outlook MCP over stdio: discovery, create, list, cancellation marker, Graph failure', { skip: mcpPath ? false : 'outlook-calendar-lite-mcp not found (set OUTLOOK_MCP_TEST_PATH)' }, async () => {
  const fg = await startFakeGraph({ timezone: 'Europe/London', calendarName: 'Bright Smile Clinic' });
  const client = new McpClient({ transport: 'stdio', stdio: { command: process.execPath, args: [mcpPath!], env: fg.mcpEnv }, timeoutMs: 15000, log: silentLogger });
  const cal = new OutlookMcpCalendar(client, 'Bright Smile Clinic');
  after(async () => { await cal.close(); await fg.close(); });
  const tools = await cal.capabilities();
  assert.deepEqual(['ls', 'rd', 'find', 'free', 'cr', 'ed', 'rm', 'rsp', 'cx'].filter(t => !tools.includes(t)), []);
  const created = await cal.createEvent({ ref: 'AAR-0badcafe', title: 'AAR-0badcafe · Dental cleaning · Test P.', start: '2026-12-01T14:00', durationMinutes: 30, description: 'synthetic' });
  assert.equal(created.status, 'created');
  assert.equal(fg.events.length, 1);
  assert.equal(fg.events[0].calendarId, 'cal-clinic', 'event goes to the dedicated clinic calendar');
  let listing = await cal.listEvents('2026-11-30', '2026-12-02');
  assert.equal(listing.events[0].ref, 'AAR-0badcafe');
  assert.equal(listing.events[0].start, '2026-12-01T14:00');
  fg.cancelBySubjectToken('AAR-0badcafe');
  listing = await cal.listEvents('2026-12-01', '2026-12-01');
  assert.equal(listing.events[0].cancelled, true);
  fg.failNext(500);
  await assert.rejects(cal.listEvents('2026-12-01', '2026-12-01'), (e: CalendarError) => e.kind === 'transient');
  // updateEvent without a stored id: list the day -> find our ref -> `ed` by its Graph id (no confirmation needed)
  await cal.createEvent({ ref: 'AAR-0badbeef', title: 'AAR-0badbeef · Filling · Test P.', start: '2026-12-02T10:00', durationMinutes: 45, description: 'synthetic' });
  assert.deepEqual(await cal.updateEvent({ ref: 'AAR-0badbeef', date: '2026-12-02', title: '[CANCELLED] AAR-0badbeef · Filling · Test P.', free: true }), { status: 'updated' });
  const e = fg.events.find(x => x.subject.includes('AAR-0badbeef'))!;
  assert.equal(e.showAs, 'free');
  assert.match(e.subject, /^\[CANCELLED\]/);
  assert.deepEqual(await cal.updateEvent({ ref: 'AAR-deadbeef', date: '2026-12-02', free: true }), { status: 'not_found' });

  // cr returns the Graph id, ls shows it, ed accepts it directly.
  const c2 = await cal.createEvent({ ref: 'AAR-0cafe001', title: 'AAR-0cafe001 · Check-up · Test P.', start: '2026-12-03T09:00', durationMinutes: 30, description: 'synthetic' });
  const g2 = fg.events.find(x => x.subject.includes('AAR-0cafe001'))!;
  assert.equal(c2.status === 'created' && c2.graphId, g2.id, 'cr returns the permanent Graph id');
  assert.equal((await cal.listEvents('2026-12-03', '2026-12-03')).events[0].graphId, g2.id);
  g2.subject = 'Check-up (renamed by staff)'; // the AAR ref is gone from the title
  assert.deepEqual(await cal.updateEvent({ ref: 'AAR-0cafe001', graphId: g2.id, date: '2026-12-03', free: true }), { status: 'updated' }, 'edited by id even without the ref');
  assert.equal(g2.showAs, 'free');
  // A stale id falls back to the ref lookup.
  await cal.createEvent({ ref: 'AAR-0cafe002', title: 'AAR-0cafe002 · Check-up · Test P.', start: '2026-12-04T09:00', durationMinutes: 30, description: 'synthetic' });
  assert.deepEqual(await cal.updateEvent({ ref: 'AAR-0cafe002', graphId: 'AAMkSTALE' + 'y'.repeat(60), date: '2026-12-04', free: true }), { status: 'updated' });
  assert.equal(fg.events.find(x => x.subject.includes('AAR-0cafe002'))!.showAs, 'free');
});
