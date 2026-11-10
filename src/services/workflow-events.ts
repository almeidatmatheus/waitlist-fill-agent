import type { Queryable } from '../database/pool.ts';

/** Append-only audit trail. Payloads carry ids and decisions, never phone numbers or message bodies. */
export async function recordEvent(q: Queryable, workflowId: string | null, eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
  await q.query('INSERT INTO workflow_events (workflow_id, event_type, payload) VALUES ($1, $2, $3)', [workflowId, eventType, JSON.stringify(payload)]);
}
