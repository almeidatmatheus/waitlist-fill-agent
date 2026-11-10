// Mock gateway: records outbound messages; can inject failures. Never contacts anyone.
import { randomBytes } from 'node:crypto';
import { MessagingError } from '../../shared/errors.ts';
import type { MessagingPort, Recipient, SendResult } from './types.ts';

export interface SentMessage { to: Recipient; text: string; externalMessageId: string; at: Date }

export class MockMessaging implements MessagingPort {
  readonly name = 'mock-messaging';
  readonly sent: SentMessage[] = [];
  private faults: MessagingError[] = [];
  onSend?: (m: SentMessage) => void;

  failNext(error = new MessagingError('transient', 'mock gateway unavailable'), times = 1) {
    for (let i = 0; i < times; i++) this.faults.push(error);
  }

  async sendText(to: Recipient, text: string): Promise<SendResult> {
    const f = this.faults.shift();
    if (f) throw f;
    const m = { to, text, externalMessageId: `MOCK${randomBytes(6).toString('hex').toUpperCase()}`, at: new Date() };
    this.sent.push(m);
    this.onSend?.(m);
    return { externalMessageId: m.externalMessageId };
  }

  to(phone: string) { return this.sent.filter(m => m.to.phoneNumber === phone); }
}
