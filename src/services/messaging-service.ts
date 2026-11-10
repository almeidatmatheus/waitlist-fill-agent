// Outbound messaging with persistence and idempotency: each logical message has an idempotency key,
// so graph re-execution, retries and restarts never send the same offer/confirmation twice
// (unless a previous attempt definitively failed).
import type { Db } from '../database/pool.ts';
import { errMsg, MessagingError } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import type { MessagingPort } from '../integrations/wa-akg/types.ts';

export interface OutboundRequest {
  patientId: string;
  conversationId: string | null;
  offerId: string | null;
  idempotencyKey: string;
  text: string;
  correlationId: string;
}

export type OutboundResult =
  | { ok: true; duplicate: boolean; externalMessageId: string | null; messageId: string }
  | { ok: false; error: string; kind: string; messageId: string };

export class MessagingService {
  private db: Db;
  private port: MessagingPort;
  private log: Logger;
  constructor(db: Db, port: MessagingPort, log: Logger) {
    this.db = db;
    this.port = port;
    this.log = log;
  }
  get providerName() { return this.port.name; }

  async send(req: OutboundRequest): Promise<OutboundResult> {
    const ins = await this.db.query(
      `INSERT INTO messages (conversation_id, patient_id, offer_id, direction, idempotency_key, content, delivery_status, correlation_id)
       VALUES ($1, $2, $3, 'outbound', $4, $5, 'pending', $6)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [req.conversationId, req.patientId, req.offerId, req.idempotencyKey, req.text, req.correlationId],
    );
    let messageId: string;
    if (ins.rowCount) messageId = ins.rows[0].id;
    else {
      const ex = await this.db.query('SELECT id, delivery_status, external_message_id FROM messages WHERE idempotency_key = $1', [req.idempotencyKey]);
      const row = ex.rows[0];
      messageId = row.id;
      if (row.delivery_status === 'sent') return { ok: true, duplicate: true, externalMessageId: row.external_message_id, messageId };
      // pending (crashed mid-send) or failed: claim it for a retry; concurrent callers lose the CAS.
      const claim = await this.db.query(`UPDATE messages SET delivery_status = 'pending' WHERE id = $1 AND (delivery_status = 'failed' OR (delivery_status = 'pending' AND created_at < now() - interval '2 minutes')) RETURNING id`, [messageId]);
      if (!claim.rowCount && row.delivery_status === 'pending') return { ok: true, duplicate: true, externalMessageId: null, messageId };
    }
    const p = await this.db.query('SELECT phone_number, whatsapp_jid FROM patients WHERE id = $1', [req.patientId]);
    if (!p.rowCount) throw new Error('patient not found');
    try {
      const r = await this.port.sendText({ phoneNumber: p.rows[0].phone_number, jid: p.rows[0].whatsapp_jid }, req.text, { correlationId: req.correlationId });
      await this.db.query(`UPDATE messages SET delivery_status = 'sent', external_message_id = $2, attempts = attempts + 1, error = NULL WHERE id = $1`, [messageId, r.externalMessageId]);
      return { ok: true, duplicate: false, externalMessageId: r.externalMessageId, messageId };
    } catch (e) {
      const kind = e instanceof MessagingError ? e.kind : 'transient';
      await this.db.query(`UPDATE messages SET delivery_status = 'failed', attempts = attempts + 1, error = $2 WHERE id = $1`, [messageId, errMsg(e).slice(0, 500)]);
      this.log.warn('whatsapp.delivery_failed', { correlationId: req.correlationId, messageId, kind, error: errMsg(e) });
      return { ok: false, error: errMsg(e), kind, messageId };
    }
  }

  /** Retries failed confirmation/notice messages a bounded number of times (called by the sweeper). */
  async retryFailed(maxAttempts = 3): Promise<number> {
    const r = await this.db.query(
      `SELECT id, patient_id, conversation_id, offer_id, idempotency_key, content, correlation_id FROM messages
        WHERE direction = 'outbound' AND delivery_status = 'failed' AND attempts < $1
          AND (idempotency_key LIKE 'confirmation:%' OR idempotency_key LIKE 'notice:%') LIMIT 20`,
      [maxAttempts],
    );
    let n = 0;
    for (const m of r.rows) {
      const out = await this.send({ patientId: m.patient_id, conversationId: m.conversation_id, offerId: m.offer_id, idempotencyKey: m.idempotency_key, text: m.content, correlationId: m.correlation_id ?? 'retry' });
      if (out.ok) n++;
    }
    return n;
  }
}
