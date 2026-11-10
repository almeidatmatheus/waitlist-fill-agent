import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WaAkgClient } from '../src/integrations/wa-akg/wa-akg-client.ts';
import { SafeMessaging } from '../src/integrations/wa-akg/safe-messaging.ts';
import { MockMessaging } from '../src/integrations/wa-akg/mock-messaging.ts';
import { parseWaAkgWebhook, verifySignature, signBody, buildWaAkgWebhook } from '../src/integrations/wa-akg/webhook.ts';
import { silentLogger } from '../src/shared/logger.ts';
import { MessagingError } from '../src/shared/errors.ts';

test('WA-AKG client sends the documented request shape', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ status: true, message: 'ok', data: { key: { id: 'WAMID1' } } }), { status: 200 }); }) as unknown as typeof fetch;
  const c = new WaAkgClient({ baseUrl: 'http://gw.local/', apiKey: 'k-123', sessionId: 'clinic test', fetchImpl });
  const r = await c.sendText({ phoneNumber: '+447700900002', jid: null }, 'Hello');
  assert.equal(r.externalMessageId, 'WAMID1');
  assert.equal(seen!.url, 'http://gw.local/api/messages/clinic%20test/447700900002%40s.whatsapp.net/send');
  assert.equal((seen!.init.headers as Record<string, string>)['x-api-key'], 'k-123');
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { message: { text: 'Hello' } });
});

test('WA-AKG delivery errors are classified', async () => {
  const mk = (status: number) => new WaAkgClient({ baseUrl: 'http://gw', apiKey: 'k', sessionId: 's', fetchImpl: (async () => new Response(JSON.stringify({ status: false, message: 'nope' }), { status })) as unknown as typeof fetch });
  await assert.rejects(mk(401).sendText({ phoneNumber: '+447700900002', jid: null }, 'x'), (e: MessagingError) => e.kind === 'auth');
  await assert.rejects(mk(500).sendText({ phoneNumber: '+447700900002', jid: null }, 'x'), (e: MessagingError) => e.kind === 'transient');
  const down = new WaAkgClient({ baseUrl: 'http://gw', apiKey: 'k', sessionId: 's', fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
  await assert.rejects(down.sendText({ phoneNumber: '+447700900002', jid: null }, 'x'), (e: MessagingError) => e.kind === 'transient');
});

test('allow-list: a real gateway can only message explicitly configured test numbers', async () => {
  const inner = new MockMessaging();
  Object.defineProperty(inner, 'name', { value: 'wa-akg' });
  assert.throws(() => new SafeMessaging(inner, null, silentLogger), /allow-list/);
  const safe = new SafeMessaging(inner, ['+447700900002'], silentLogger);
  await safe.sendText({ phoneNumber: '+447700900002', jid: null }, 'ok', { correlationId: 'c' });
  await assert.rejects(safe.sendText({ phoneNumber: '+447700900003', jid: null }, 'no', { correlationId: 'c' }), (e: MessagingError) => e.kind === 'blocked');
  assert.equal(inner.sent.length, 1);
});

test('webhook HMAC verification (sha256=<hex> over the raw body)', () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifySignature('secret-secret-secret', body, signBody('secret-secret-secret', body)), true);
  assert.equal(verifySignature('secret-secret-secret', body, signBody('other-secret-123456', body)), false);
  assert.equal(verifySignature('secret-secret-secret', body, undefined), false);
  assert.equal(verifySignature('secret-secret-secret', Buffer.from('{"a":2}'), signBody('secret-secret-secret', body)), false);
});

test('webhook parsing ignores own messages, groups, other sessions and non-text', () => {
  const ok = buildWaAkgWebhook({ sessionId: 's1', messageId: 'M1', fromJid: '447700900002@s.whatsapp.net', text: ' Yes please ' });
  const p = parseWaAkgWebhook(ok, 's1');
  assert.equal(p.kind, 'message');
  if (p.kind === 'message') { assert.equal(p.message.text, 'Yes please'); assert.equal(p.message.fromPhone, '+447700900002'); }
  assert.deepEqual(parseWaAkgWebhook(buildWaAkgWebhook({ sessionId: 's1', messageId: 'M2', fromJid: '447700900002@s.whatsapp.net', text: 'x', fromMe: true }), 's1'), { kind: 'ignored', reason: 'fromMe', externalMessageId: 'M2' });
  assert.equal(parseWaAkgWebhook(ok, 'other').kind, 'ignored');
  assert.equal(parseWaAkgWebhook({ ...ok, event: 'message.sent' }, 's1').kind, 'ignored');
  assert.equal(parseWaAkgWebhook({ ...ok, data: { ...ok.data, isGroup: true, chatType: 'GROUP' } }, 's1').kind, 'ignored');
  assert.equal(parseWaAkgWebhook({ ...ok, data: { ...ok.data, type: 'IMAGE' } }, 's1').kind, 'ignored');
  assert.equal(parseWaAkgWebhook({ ...ok, data: { ...ok.data, from: '12345@lid' } }, 's1').kind, 'ignored');
});
