// Safety boundary wrapped around ANY messaging provider: only explicitly allow-listed numbers can be
// contacted through a real gateway, so development can never message unknown or real patients.
import { MessagingError } from '../../shared/errors.ts';
import type { Logger } from '../../shared/logger.ts';
import type { MessagingPort, Recipient } from './types.ts';

export class SafeMessaging implements MessagingPort {
  private inner: MessagingPort;
  private allowed: Set<string> | null;
  private log: Logger;
  /** allowedNumbers = null disables the allow-list (only permitted for the mock provider). */
  constructor(inner: MessagingPort, allowedNumbers: string[] | null, log: Logger) {
    this.inner = inner;
    this.allowed = allowedNumbers ? new Set(allowedNumbers) : null;
    this.log = log;
    if (inner.name !== 'mock-messaging' && !this.allowed) throw new Error('a real messaging provider requires an explicit allow-list');
  }
  get name() { return this.inner.name; }

  async sendText(to: Recipient, text: string, meta: { correlationId: string }) {
    if (this.allowed && !this.allowed.has(to.phoneNumber)) {
      this.log.warn('whatsapp.blocked_recipient', { correlationId: meta.correlationId, phone: to.phoneNumber });
      throw new MessagingError('blocked', 'recipient is not in WHATSAPP_ALLOWED_NUMBERS');
    }
    if (text.length > 1000) throw new MessagingError('rejected', 'message too long');
    const t0 = Date.now();
    try {
      const r = await this.inner.sendText(to, text, meta);
      this.log.info('whatsapp.send', { correlationId: meta.correlationId, provider: this.inner.name, ok: true, durationMs: Date.now() - t0, phone: to.phoneNumber });
      return r;
    } catch (e) {
      this.log.warn('whatsapp.send', { correlationId: meta.correlationId, provider: this.inner.name, ok: false, durationMs: Date.now() - t0, error: (e as Error).message, kind: (e as MessagingError).kind });
      throw e;
    }
  }
}
