// WA-AKG REST client. Verified against WA-AKG source (src/app/api/messages/[sessionId]/[jid]/send/route.ts):
//   POST {base}/api/messages/{sessionId}/{urlencoded jid}/send
//   headers: X-API-Key, body: { "message": { "text": "..." } }
//   200 -> { status: true, message, data: <Baileys send result, data.key.id> }
import { MessagingError, withTimeout } from '../../shared/errors.ts';
import type { MessagingPort, Recipient, SendResult } from './types.ts';

export const jidFromPhone = (phone: string) => `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

export class WaAkgClient implements MessagingPort {
  readonly name = 'wa-akg';
  private baseUrl: string;
  private apiKey: string;
  private sessionId: string;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(opts: { baseUrl: string; apiKey: string; sessionId: string; timeoutMs?: number; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.sessionId = opts.sessionId;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async sendText(to: Recipient, text: string): Promise<SendResult> {
    const jid = to.jid ?? jidFromPhone(to.phoneNumber);
    const url = `${this.baseUrl}/api/messages/${encodeURIComponent(this.sessionId)}/${encodeURIComponent(jid)}/send`;
    let res: Response;
    try {
      res = await withTimeout(
        this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
          body: JSON.stringify({ message: { text } }),
        }),
        this.timeoutMs,
        () => new MessagingError('timeout', `WA-AKG send timed out after ${this.timeoutMs}ms`),
      );
    } catch (e) {
      if (e instanceof MessagingError) throw e;
      throw new MessagingError('transient', `WA-AKG unreachable: ${(e as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: { key?: { id?: string } } };
    if (res.status === 401 || res.status === 403) throw new MessagingError('auth', `WA-AKG ${res.status}: ${body.message ?? 'unauthorized'}`);
    if (res.status === 400) throw new MessagingError('rejected', `WA-AKG rejected message: ${body.message ?? 'bad request'}`);
    if (!res.ok || body.status !== true) throw new MessagingError('transient', `WA-AKG ${res.status}: ${body.message ?? 'send failed'}`);
    return { externalMessageId: typeof body.data?.key?.id === 'string' ? body.data.key.id : null };
  }
}
