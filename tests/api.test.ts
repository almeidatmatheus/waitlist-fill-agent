import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, closeDb, ADMIN, IDS, testDb } from './support/harness.ts';
import { buildApp } from '../src/app.ts';
import { testConfig } from './support/harness.ts';
import { MockCalendar } from '../src/integrations/outlook-mcp/mock-calendar.ts';
import { MockMessaging } from '../src/integrations/wa-akg/mock-messaging.ts';
import { silentLogger } from '../src/shared/logger.ts';

after(closeDb);
const auth = { authorization: `Bearer ${ADMIN}` };

test('admin endpoints require the bearer token; /health is public and PII-free', async () => {
  const h = await createHarness();
  try {
    const s = h.app.server;
    for (const url of ['/appointments', '/waitlist', '/workflows', '/workflows/']) {
      assert.equal((await s.inject({ url })).statusCode, 401, url);
      assert.equal((await s.inject({ url, headers: { authorization: 'Bearer wrong' } })).statusCode, 401, url);
      assert.equal((await s.inject({ url, headers: auth })).statusCode, 200, url);
    }
    const health = await s.inject({ url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().db, 'up');
  } finally { await h.close(); }
});

test('responses never expose phone numbers, JIDs or full names', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    for (const url of ['/appointments', '/waitlist', '/workflows', `/workflows/${workflowId}`]) {
      const body = (await h.app.server.inject({ url, headers: auth })).body;
      assert.doesNotMatch(body, /7700900|whatsapp\.net|Mitchell|Bennett/, url);
    }
    const appts = (await h.app.server.inject({ url: '/appointments', headers: auth })).json();
    assert.ok(appts.appointments.some((a: any) => a.patient === 'Sarah M.'));
  } finally { await h.close(); }
});

test('the public .env.example placeholders are refused as soon as the app is reachable from outside', () => {
  const base = { ADMIN_API_TOKEN: 'change-me-to-a-long-random-string', WA_AKG_WEBHOOK_SECRET: 'change-me-webhook-secret' };
  assert.doesNotThrow(() => testConfig({ ...base, NODE_ENV: 'development' }), 'a local demo may keep them');
  const wa = { MESSAGING_PROVIDER: 'wa-akg', WA_AKG_API_KEY: 'k', WHATSAPP_ALLOWED_NUMBERS: '+447700900002' };
  const notify = { OUTLOOK_MCP_NOTIFY_URL: 'https://clinic.example.test/webhooks/graph', OUTLOOK_MCP_NOTIFY_SECRET: 'graph-client-state-0123456789' };
  const cases: Record<string, string>[] = [{ NODE_ENV: 'production' }, { HOST: '0.0.0.0' }, wa, notify];
  for (const exposed of cases) {
    assert.throws(() => testConfig({ ...base, ...exposed }), /ADMIN_API_TOKEN still has the .env.example placeholder[\s\S]*WA_AKG_WEBHOOK_SECRET still has/);
    assert.doesNotThrow(() => testConfig(exposed), 'real values pass');
  }
});

test('dev endpoints trigger the workflow in development/test and do not exist in production', async () => {
  const h = await createHarness();
  try {
    const r = await h.app.server.inject({ method: 'POST', url: '/dev/trigger-cancellation', headers: { ...auth, 'content-type': 'application/json' }, payload: { appointmentId: IDS.appt.oliverCleaning } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().waitingFor, 'patient');
    const bad = await h.app.server.inject({ method: 'POST', url: '/dev/trigger-cancellation', headers: { ...auth, 'content-type': 'application/json' }, payload: { appointmentId: 'nope' } });
    assert.equal(bad.statusCode, 400);
    const sim = await h.app.server.inject({ method: 'POST', url: '/dev/simulate-inbound', headers: { ...auth, 'content-type': 'application/json' }, payload: { phone: IDS.phone.sarah, text: 'Yes please' } });
    assert.equal(sim.json().webhookStatus, 202);
    assert.match(h.lastSent(IDS.phone.sarah)!, /confirmed/);
  } finally { await h.close(); }

  const prod = await buildApp(testConfig({ NODE_ENV: 'production' }), { db: testDb(), calendar: new MockCalendar(), messaging: new MockMessaging(), log: silentLogger });
  try {
    const r = await prod.server.inject({ method: 'POST', url: '/dev/trigger-cancellation', headers: { ...auth, 'content-type': 'application/json' }, payload: { appointmentId: IDS.appt.oliverCleaning } });
    assert.equal(r.statusCode, 404);
  } finally { await prod.server.close(); }
});
