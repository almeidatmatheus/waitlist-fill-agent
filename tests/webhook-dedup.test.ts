import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, closeDb, IDS, SECRET } from './support/harness.ts';
import { buildWaAkgWebhook, signBody } from '../src/integrations/wa-akg/webhook.ts';

after(closeDb);

test('the same webhook delivered 3 times is processed once (one booking, one confirmation)', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    const r1 = await h.reply(IDS.phone.sarah, 'Yes please', 'WAMSG-DUP-1');
    const r2 = await h.reply(IDS.phone.sarah, 'Yes please', 'WAMSG-DUP-1');
    const r3 = await h.reply(IDS.phone.sarah, 'Yes please', 'WAMSG-DUP-1');
    assert.deepEqual([r1.status, r2.body.status, r3.body.status], [202, 'duplicate', 'duplicate']);
    assert.equal((await h.db.query(`SELECT count(*)::int n FROM inbound_events WHERE external_message_id = 'WAMSG-DUP-1'`)).rows[0].n, 1);
    assert.equal((await h.db.query(`SELECT count(*)::int n FROM messages WHERE external_message_id = 'WAMSG-DUP-1'`)).rows[0].n, 1);
    assert.equal((await h.db.query(`SELECT count(*)::int n FROM bookings WHERE workflow_id = $1`, [workflowId])).rows[0].n, 1);
    assert.equal(h.calendar.createCalls, 1);
    assert.equal(h.sent(IDS.phone.sarah).filter(t => t.includes('is confirmed for')).length, 1);
  } finally { await h.close(); }
});

test('concurrent duplicate deliveries race safely', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    const rs = await Promise.all([1, 2, 3, 4].map(() => h.reply(IDS.phone.sarah, 'Yes please', 'WAMSG-RACE')));
    assert.equal(rs.filter(r => r.status === 202).length, 1);
    assert.equal((await h.db.query(`SELECT count(*)::int n FROM bookings WHERE workflow_id = $1`, [workflowId])).rows[0].n, 1);
  } finally { await h.close(); }
});

test('webhook authentication and filtering', async () => {
  const h = await createHarness();
  try {
    const payload = JSON.stringify(buildWaAkgWebhook({ sessionId: 'clinic-test', messageId: 'X1', fromJid: '447700900002@s.whatsapp.net', text: 'Yes' }));
    const bad = await h.app.server.inject({ method: 'POST', url: '/webhooks/wa-akg', payload, headers: { 'content-type': 'application/json', 'x-webhook-signature': signBody('wrong-secret-wrong-secret', payload) } });
    assert.equal(bad.statusCode, 401);
    const none = await h.app.server.inject({ method: 'POST', url: '/webhooks/wa-akg', payload, headers: { 'content-type': 'application/json' } });
    assert.equal(none.statusCode, 401);
    const fromMe = JSON.stringify(buildWaAkgWebhook({ sessionId: 'clinic-test', messageId: 'X2', fromJid: '447700900002@s.whatsapp.net', text: 'Hi Sarah!', fromMe: true }));
    const r = await h.app.server.inject({ method: 'POST', url: '/webhooks/wa-akg', payload: fromMe, headers: { 'content-type': 'application/json', 'x-webhook-signature': signBody(SECRET, fromMe) } });
    assert.deepEqual(r.json(), { status: 'ignored', reason: 'fromMe' });
    const broken = await h.app.server.inject({ method: 'POST', url: '/webhooks/wa-akg', payload: '{not json', headers: { 'content-type': 'application/json', 'x-webhook-signature': signBody(SECRET, '{not json') } });
    assert.equal(broken.statusCode, 400);
  } finally { await h.close(); }
});

test('a webhook left pending (crash before processing) is picked up by the sweeper', async () => {
  const h = await createHarness();
  try {
    const { workflowId } = await h.trigger(IDS.appt.oliverCleaning);
    const r = await h.app.inbound.ingest({ provider: 'wa-akg', externalMessageId: 'PENDING-1', fromJid: '447700900002@s.whatsapp.net', fromPhone: '+447700900002', text: 'Yes please', timestamp: new Date() }, {});
    assert.equal(r.status, 'accepted');
    await h.db.query(`UPDATE inbound_events SET received_at = now() - interval '1 minute'`);
    const rep = await h.app.sweeper.sweep();
    assert.equal(rep.inboundRetried, 1);
    assert.equal((await h.workflow(workflowId)).status, 'booked');
  } finally { await h.close(); }
});
