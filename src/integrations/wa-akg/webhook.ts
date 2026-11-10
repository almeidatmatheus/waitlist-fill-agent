// WA-AKG webhook verification + parsing. Verified against WA-AKG src/lib/webhook.ts:
//  - body: { event, sessionId, timestamp, data }
//  - header X-Webhook-Signature: "sha256=" + hex(HMAC-SHA256(secret, raw body))
//  - message.received data: { key: { id, remoteJid, fromMe }, from, isGroup, chatType, type: "TEXT", content, ... }
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isObj } from '../../shared/validation.ts';
import type { ParsedWebhook } from './types.ts';

export function signBody(secret: string, rawBody: string | Buffer): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!secret || !header || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(signBody(secret, rawBody));
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

const MAX_TEXT = 2000;

export function parseWaAkgWebhook(body: unknown, expectedSessionId: string): ParsedWebhook {
  if (!isObj(body)) return { kind: 'ignored', reason: 'payload is not an object' };
  if (body.sessionId !== expectedSessionId) return { kind: 'ignored', reason: 'unexpected sessionId' };
  if (body.event !== 'message.received') return { kind: 'ignored', reason: `event ${String(body.event)} not handled` };
  const d = body.data;
  if (!isObj(d) || !isObj(d.key)) return { kind: 'ignored', reason: 'missing data.key' };
  const id = typeof d.key.id === 'string' ? d.key.id : '';
  if (!id || id.length > 200) return { kind: 'ignored', reason: 'missing message id' };
  // Never react to messages sent by the connected clinic account itself.
  if (d.key.fromMe === true) return { kind: 'ignored', reason: 'fromMe', externalMessageId: id };
  if (d.isGroup === true || (d.chatType !== undefined && d.chatType !== 'PERSONAL')) return { kind: 'ignored', reason: 'not a personal chat', externalMessageId: id };
  if (d.type !== undefined && d.type !== 'TEXT') return { kind: 'ignored', reason: `unsupported type ${String(d.type)}`, externalMessageId: id };
  const from = typeof d.from === 'string' ? d.from : typeof d.key.remoteJid === 'string' ? d.key.remoteJid : '';
  if (!/^\d{6,16}@s\.whatsapp\.net$/.test(from)) return { kind: 'ignored', reason: 'sender is not a phone JID', externalMessageId: id };
  const text = typeof d.content === 'string' ? d.content.trim() : '';
  if (!text) return { kind: 'ignored', reason: 'empty text', externalMessageId: id };
  const ts = typeof body.timestamp === 'string' ? new Date(body.timestamp) : new Date();
  return {
    kind: 'message',
    message: {
      provider: 'wa-akg',
      externalMessageId: id,
      fromJid: from,
      fromPhone: '+' + from.split('@')[0],
      text: text.slice(0, MAX_TEXT),
      timestamp: Number.isNaN(ts.getTime()) ? new Date() : ts,
    },
  };
}

/** Builds a WA-AKG-shaped webhook body (used by the mock gateway, demo and tests). */
export function buildWaAkgWebhook(opts: { sessionId: string; messageId: string; fromJid: string; text: string; fromMe?: boolean }) {
  return {
    event: 'message.received',
    sessionId: opts.sessionId,
    timestamp: new Date().toISOString(),
    data: {
      key: { id: opts.messageId, remoteJid: opts.fromJid, fromMe: opts.fromMe ?? false },
      pushName: 'Test Patient',
      messageTimestamp: Math.floor(Date.now() / 1000),
      from: opts.fromJid,
      receiver: '440000000000@s.whatsapp.net',
      sender: opts.fromJid,
      isGroup: false,
      chatType: 'PERSONAL',
      type: 'TEXT',
      content: opts.text,
    },
  };
}
