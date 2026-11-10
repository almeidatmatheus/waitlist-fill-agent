// Human handoff. A handoff row is always created (visible via GET /workflows). An external notification
// is only attempted when HUMAN_HANDOFF_WEBHOOK_URL is configured; `notified` reflects what actually happened,
// and patient-facing wording depends on it (we never claim someone was told when nobody was).
import type { Db } from '../database/pool.ts';
import { errMsg } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import { recordEvent } from './workflow-events.ts';

export interface HandoffRequest {
  workflowId: string | null;
  conversationId: string | null;
  patientId: string | null;
  reason: string;
}

export class HandoffService {
  private db: Db;
  private webhookUrl: string;
  private log: Logger;
  private fetchImpl: typeof fetch;
  constructor(db: Db, webhookUrl: string, log: Logger, fetchImpl: typeof fetch = fetch) {
    this.db = db;
    this.webhookUrl = webhookUrl;
    this.log = log;
    this.fetchImpl = fetchImpl;
  }

  get configured() { return !!this.webhookUrl; }

  async open(req: HandoffRequest): Promise<{ handoffId: string; notified: boolean; existing?: boolean }> {
    const existing = req.patientId
      ? await this.db.query(`SELECT id, notified FROM human_handoffs WHERE patient_id = $1 AND status = 'open' AND workflow_id IS NOT DISTINCT FROM $2`, [req.patientId, req.workflowId])
      : { rowCount: 0, rows: [] as any[] };
    if (existing.rowCount) return { handoffId: existing.rows[0].id, notified: existing.rows[0].notified, existing: true };
    const r = await this.db.query(
      `INSERT INTO human_handoffs (workflow_id, conversation_id, patient_id, reason) VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.workflowId, req.conversationId, req.patientId, req.reason],
    );
    const handoffId = r.rows[0].id as string;
    let notified = false;
    if (this.webhookUrl) {
      try {
        // Ids only: staff look the patient up in the clinic system.
        const res = await this.fetchImpl(this.webhookUrl, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'human_handoff', handoffId, workflowId: req.workflowId, conversationId: req.conversationId, reason: req.reason }),
          signal: AbortSignal.timeout(5000),
        });
        notified = res.ok;
      } catch (e) {
        this.log.warn('handoff.notify_failed', { handoffId, error: errMsg(e) });
      }
      if (notified) await this.db.query('UPDATE human_handoffs SET notified = true WHERE id = $1', [handoffId]);
    }
    await recordEvent(this.db, req.workflowId, 'human_handoff_opened', { handoffId, reason: req.reason, notified });
    this.log.info('handoff.opened', { handoffId, workflowId: req.workflowId, conversationId: req.conversationId, reason: req.reason, notified });
    return { handoffId, notified };
  }

  async hasOpen(patientId: string): Promise<boolean> {
    return ((await this.db.query(`SELECT 1 FROM human_handoffs WHERE patient_id = $1 AND status = 'open' LIMIT 1`, [patientId])).rowCount ?? 0) > 0;
  }

  async resolveForWorkflow(workflowId: string) {
    await this.db.query(`UPDATE human_handoffs SET status = 'resolved', resolved_at = now() WHERE workflow_id = $1 AND status = 'open'`, [workflowId]);
  }
}
