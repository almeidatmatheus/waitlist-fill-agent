import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHarness, closeDb, testConfig, IDS, type Harness } from './support/harness.ts';
import { CalendarError } from '../src/shared/errors.ts';
import { ConfigError } from '../src/config/env.ts';
import { silentLogger } from '../src/shared/logger.ts';
import { McpClient } from '../src/integrations/outlook-mcp/mcp-client.ts';
import { OutlookMcpCalendar, parseNtfOutput } from '../src/integrations/outlook-mcp/outlook-mcp-calendar.ts';
import { startFakeGraph } from '../src/integrations/outlook-mcp/fake-graph.ts';
import { syncAppointmentsToCalendar } from '../src/services/calendar-sync.ts';

after(closeDb);

const NOTIFY_URL = 'https://clinic.example.test/webhooks/graph';
const NOTIFY_SECRET = 'test-graph-client-state-0123456789';
const ON = { OUTLOOK_MCP_NOTIFY_URL: NOTIFY_URL, OUTLOOK_MCP_NOTIFY_SECRET: NOTIFY_SECRET, CALENDAR_NOTIFY_DEBOUNCE_MS: '0' };

const item = (o: Record<string, unknown> = {}) => ({ subscriptionId: 'mock-subscription', clientState: NOTIFY_SECRET, changeType: 'deleted', resource: 'Users/u/Events/x', ...o });
const deleted = (graphId: string, o: Record<string, unknown> = {}) => item({ resourceData: { '@odata.type': '#Microsoft.Graph.Event', id: graphId }, ...o });

async function post(h: Harness, body: unknown, query = '') {
  const res = await h.app.server.inject({ method: 'POST', url: `/webhooks/graph${query}`, payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  await h.app.tasks.idle();
  return res;
}
const workflows = async (h: Harness) => (await h.db.query('SELECT count(*)::int n FROM recovery_workflows')).rows[0].n as number;

test('the webhook is off without configuration and answers the Graph validation handshake when on', async () => {
  const off = await createHarness();
  try {
    assert.equal((await post(off, { value: [deleted('x')] })).statusCode, 404);
    assert.equal((await off.app.server.inject({ method: 'GET', url: '/health' })).json().calendarNotifications, 'off');
  } finally { await off.close(); }

  const h = await createHarness({ config: ON });
  try {
    const res = await h.app.server.inject({ method: 'POST', url: '/webhooks/graph?validationToken=abc%20123%3Cb%3E', headers: { 'content-type': 'text/plain; charset=utf-8' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'abc 123<b>', 'the token comes back unchanged');
    assert.match(String(res.headers['content-type']), /^text\/plain/);
    assert.equal(h.calendar.listCalls, 0, 'the handshake does not touch the calendar');
  } finally { await h.close(); }
});

test('a deleted notification makes the first listing confirm the cancellation and start one workflow', async () => {
  const h = await createHarness({ config: ON });
  try {
    const ev = h.calendar.findByRef('AAR-a0000001')[0];
    h.calendar.removeByRef('AAR-a0000001');
    const res = await post(h, { value: [deleted(ev.graphId)] });
    assert.equal(res.statusCode, 202);
    assert.equal(h.calendar.listCalls, 1, 'one listing, not CANCELLATION_CONFIRMATIONS of them');
    assert.equal(await workflows(h), 1);
    assert.match(h.lastSent(IDS.phone.sarah)!, /^Hi Sarah!/);
    const ce = (await h.db.query('SELECT source, observation, details FROM cancellation_events')).rows[0];
    assert.deepEqual([ce.source, ce.observation, ce.details.deletedNotification], ['calendar_poll', 'missing', true]);
    // Graph delivers at least once: the same notification again changes nothing.
    assert.equal((await post(h, { value: [deleted(ev.graphId)] })).statusCode, 202);
    assert.equal(await workflows(h), 1);
    assert.equal(h.sent(IDS.phone.sarah).filter(t => t.startsWith('Hi Sarah')).length, 1);
  } finally { await h.close(); }
});

test('a notification without the right clientState is rejected and does nothing', async () => {
  const h = await createHarness({ config: ON });
  try {
    const ev = h.calendar.findByRef('AAR-a0000001')[0];
    h.calendar.removeByRef('AAR-a0000001');
    for (const clientState of ['wrong-secret', NOTIFY_SECRET + 'x', undefined, 42]) {
      assert.equal((await post(h, { value: [deleted(ev.graphId, { clientState })] })).statusCode, 401);
    }
    assert.equal((await post(h, { nothing: true })).statusCode, 400);
    assert.equal((await post(h, { value: [] })).statusCode, 401);
    assert.equal(h.calendar.listCalls, 0, 'no listing was triggered');
    // The forged "deleted" left no hint behind: a normal poll still needs its consecutive confirmations.
    const r = await h.app.detector.poll();
    assert.deepEqual([r.suspected, r.confirmed.length], [[IDS.appt.oliverCleaning], 0]);
    assert.equal(await workflows(h), 0);
  } finally { await h.close(); }
});

test('the notification alone cancels nothing: the event must also be missing from the calendar', async () => {
  const h = await createHarness({ config: ON });
  try {
    const ev = h.calendar.findByRef('AAR-a0000001')[0];
    // "deleted" for an event that is still there, and for an id we do not know.
    assert.equal((await post(h, { value: [deleted(ev.graphId), deleted('AAMkUNKNOWN')] })).statusCode, 202);
    assert.equal(h.calendar.listCalls, 1);
    assert.equal(await workflows(h), 0);
    // "updated" triggers a listing but is not a deletion hint: a missing event stays only suspected.
    h.calendar.removeByRef('AAR-a0000005');
    const ethan = (await h.db.query('SELECT outlook_event_id FROM appointments WHERE id = $1', [IDS.appt.ethanCleaning])).rows[0].outlook_event_id;
    await post(h, { value: [deleted(ethan, { changeType: 'updated' })] });
    assert.equal(h.calendar.listCalls, 2);
    assert.equal(await workflows(h), 0);
    assert.equal((await h.db.query('SELECT calendar_missing_count n FROM appointments WHERE id = $1', [IDS.appt.ethanCleaning])).rows[0].n, 1);
  } finally { await h.close(); }
});

test('calendar failures and the mass-disappearance guard still win over a deleted notification', async () => {
  const h = await createHarness({ config: ON });
  try {
    const ev = h.calendar.findByRef('AAR-a0000001')[0];
    h.calendar.removeByRef('AAR-a0000001');
    h.calendar.inject('list', { kind: 'error', error: new CalendarError('transient', 'graph 503') });
    await post(h, { value: [deleted(ev.graphId)] });
    assert.equal(await workflows(h), 0, 'a failed listing concludes nothing');
    h.calendar.inject('list', { kind: 'incomplete' });
    await h.app.detector.poll();
    assert.equal(await workflows(h), 0, 'a truncated listing concludes nothing');
    // The hint survives the failures: the next good listing confirms it.
    const r = await h.app.detector.poll();
    assert.deepEqual(r.confirmed.map(c => c.appointmentId), [IDS.appt.oliverCleaning]);
  } finally { await h.close(); }

  const g = await createHarness({ config: ON });
  try {
    const ids = g.calendar.events.map(e => e.graphId);
    g.calendar.events = [];
    await post(g, { value: ids.map(id => deleted(id)) });
    assert.equal(await workflows(g), 0, 'everything vanishing at once is an anomaly, notifications or not');
  } finally { await g.close(); }
});

test('several notifications in one request share one listing; lifecycle events renew or re-list', async () => {
  const h = await createHarness({ config: ON });
  try {
    await post(h, { value: [deleted('a', { changeType: 'updated' }), deleted('b', { changeType: 'updated' }), deleted('c', { changeType: 'updated' })] });
    assert.equal(h.calendar.listCalls, 1);
    await h.app.notifications.ensure();
    assert.equal(h.calendar.subscribeCalls, 1);
    await post(h, { value: [item({ changeType: undefined, lifecycleEvent: 'reauthorizationRequired' })] });
    assert.equal(h.calendar.subscribeCalls, 2, 'reauthorizationRequired renews at once');
    await post(h, { value: [item({ changeType: undefined, lifecycleEvent: 'subscriptionRemoved' })] });
    assert.equal(h.calendar.subscribeCalls, 3, 'subscriptionRemoved recreates');
    const before = h.calendar.listCalls;
    await post(h, { value: [item({ changeType: undefined, lifecycleEvent: 'missed' })] });
    assert.equal(h.calendar.listCalls, before + 1, 'missed notifications cause a listing');
    assert.equal(h.calendar.subscribeCalls, 3);
  } finally { await h.close(); }
});

test('subscription upkeep: created once, renewed a day before it expires, polling slows only while it is healthy', async () => {
  const h = await createHarness({ config: ON });
  try {
    const n = h.app.notifications;
    h.calendar.subscriptionNow = () => h.clock.now.getTime();
    assert.equal(n.status(), 'degraded');
    assert.equal(n.pollDue(), true, 'no subscription yet: poll at the normal rate');
    await n.ensure();
    assert.equal(n.status(), 'active');
    assert.equal((await h.app.server.inject({ method: 'GET', url: '/health' })).json().calendarNotifications, 'active');
    await n.ensure(); await n.ensure();
    assert.equal(h.calendar.subscribeCalls, 1, 'not renewed while more than a day is left');
    await h.app.detector.poll();
    assert.equal(n.pollDue(), false, 'healthy subscription and a recent poll: the tick is skipped');
    h.advance(25 * 60); // 23 h left of the 2 days
    await n.ensure();
    assert.equal(h.calendar.subscribeCalls, 2, 'renewed inside the last day');

    // Renewal starts failing: the app backs off, and once the subscription expires polling is back to normal.
    h.calendar.subscriptionError = new CalendarError('transient', 'Graph could not validate the notification URL');
    h.advance(30 * 60);
    await n.ensure(); await n.ensure(); await n.ensure();
    assert.equal(h.calendar.subscribeCalls, 3, 'failures are retried with a back-off, not on every tick');
    assert.equal(n.status(), 'active', 'the old subscription is still valid');
    h.advance(48 * 60);
    assert.equal(n.status(), 'degraded');
    assert.equal(n.pollDue(), true);
    assert.equal((await h.db.query(`SELECT count(*)::int n FROM workflow_events WHERE event_type = 'calendar_subscription_failed'`)).rows[0].n, 1);
  } finally { await h.close(); }
});

test('a calendar provider without notifications leaves the app polling', async () => {
  const h = await createHarness({ config: ON });
  try {
    h.calendar.subscriptionError = new CalendarError('not_supported', 'MCP server has no ntf tool');
    await h.app.notifications.ensure();
    assert.equal(h.app.notifications.status(), 'degraded');
    assert.equal(h.app.notifications.pollDue(), true);
  } finally { await h.close(); }
});

test('configuration: URL and secret go together, the URL is this app over HTTPS, the secret has a sane length', () => {
  assert.equal(testConfig().calendar.notifications.enabled, false);
  assert.equal(testConfig(ON).calendar.notifications.enabled, true);
  assert.throws(() => testConfig({ OUTLOOK_MCP_NOTIFY_URL: NOTIFY_URL }), ConfigError);
  assert.throws(() => testConfig({ OUTLOOK_MCP_NOTIFY_SECRET: NOTIFY_SECRET }), ConfigError);
  assert.throws(() => testConfig({ ...ON, OUTLOOK_MCP_NOTIFY_URL: 'http://clinic.example.test/webhooks/graph' }), /HTTPS/);
  assert.throws(() => testConfig({ ...ON, OUTLOOK_MCP_NOTIFY_URL: 'https://clinic.example.test/other' }), /webhooks\/graph/);
  assert.throws(() => testConfig({ ...ON, OUTLOOK_MCP_NOTIFY_SECRET: 'short' }), /16 to 128/);
  assert.throws(() => testConfig({ ...ON, OUTLOOK_MCP_NOTIFY_SECRET: 'x'.repeat(129) }), /16 to 128/);
});

test('ntf output: subscription id and expiry, not configured, unexpected text', () => {
  const s = parseNtfOutput('ligado:sub-123|expira:2026-11-12T08:00:00Z');
  assert.deepEqual([s.id, s.expiresAt.toISOString()], ['sub-123', '2026-11-12T08:00:00.000Z']);
  assert.throws(() => parseNtfOutput('notificações não configuradas (defina OUTLOOK_MCP_NOTIFY_URL e OUTLOOK_MCP_NOTIFY_SECRET)'), (e: CalendarError) => e.kind === 'not_supported');
  assert.throws(() => parseNtfOutput('sem assinatura'), (e: CalendarError) => e.kind === 'protocol');
  assert.throws(() => parseNtfOutput('ligado:sub-1|expira:amanhã'), (e: CalendarError) => e.kind === 'protocol');
});

// ---- End to end with the REAL outlook-calendar-lite-mcp process (stdio) and the fake Graph:
// app -> MCP `ntf ligar` -> Graph validates our webhook -> staff deletes an event -> Graph notifies -> workflow.
const candidates = [process.env.OUTLOOK_MCP_TEST_PATH, process.env.OUTLOOK_MCP_PATH, join(import.meta.dirname, '..', '..', 'outlook-calendar-lite-mcp', 'src', 'main.ts')].filter(Boolean) as string[];
const mcpPath = candidates.find(p => existsSync(p));

test('real Outlook MCP + fake Graph: subscribe with URL validation, renew, deleted event starts the recovery', { skip: mcpPath ? false : 'outlook-calendar-lite-mcp not found (set OUTLOOK_MCP_TEST_PATH)' }, async () => {
  let h: Harness | undefined;
  const delivered: unknown[] = [];
  const fg = await startFakeGraph({
    timezone: 'Europe/London', calendarName: 'Bright Smile Clinic',
    // There is no public HTTPS endpoint in a test: hand Graph's calls to the app in-process.
    deliver: async (url, body) => {
      const u = new URL(url);
      assert.equal(`${u.origin}${u.pathname}`, NOTIFY_URL, 'Graph calls the configured URL');
      if (body !== undefined) delivered.push(body);
      const res = await h!.app.server.inject({ method: 'POST', url: `${u.pathname}${u.search}`, ...(body === undefined ? {} : { payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
      return { status: res.statusCode, text: res.body };
    },
  });
  const client = new McpClient({ transport: 'stdio', stdio: { command: process.execPath, args: [mcpPath!], env: { ...fg.mcpEnv, OUTLOOK_MCP_NOTIFY_URL: NOTIFY_URL, OUTLOOK_MCP_NOTIFY_SECRET: NOTIFY_SECRET } }, timeoutMs: 15000, log: silentLogger });
  const cal = new OutlookMcpCalendar(client, 'Bright Smile Clinic');
  h = await createHarness({ config: ON, overrides: { calendar: cal } });
  try {
    await syncAppointmentsToCalendar(h.db, h.app.calendar, 'Europe/London', h.clock.now);
    const n = h.app.notifications;
    await n.ensure();
    assert.equal(n.status(), 'active');
    assert.equal(fg.subscriptions.length, 1);
    const s = fg.subscriptions[0];
    assert.deepEqual([s.resource, s.changeType, s.notificationUrl, s.clientState], ['me/calendars/cal-clinic/events', 'updated,deleted', NOTIFY_URL, NOTIFY_SECRET]);
    await n.ensure(true);
    assert.equal(fg.subscriptions.length, 1, 'renewing extends the same subscription');

    assert.equal(await fg.deleteBySubjectToken('AAR-a0000001'), 1);
    await h.app.tasks.idle();
    assert.equal(delivered.length, 1);
    const wf = (await h.db.query('SELECT cancelled_appointment_id FROM recovery_workflows')).rows;
    assert.deepEqual(wf.map(w => w.cancelled_appointment_id), [IDS.appt.oliverCleaning], 'the id in the notification is the id we stored');
    assert.equal((await h.db.query('SELECT details FROM cancellation_events')).rows[0].details.deletedNotification, true);
    assert.match(h.lastSent(IDS.phone.sarah)!, /^Hi Sarah!/);
  } finally {
    await h.close(); await cal.close(); await fg.close();
  }
});
