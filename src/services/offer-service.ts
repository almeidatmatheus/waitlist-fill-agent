// Offer lifecycle + conversation association. Offer creation is idempotent per (slot, waitlist entry).
import { withTx, isUniqueViolation, type Db, type Queryable } from '../database/pool.ts';
import type { SlotInfo } from './waitlist-matching.ts';
import { recordEvent } from './workflow-events.ts';

export type OfferStatus = 'pending' | 'accepted' | 'confirmed' | 'declined' | 'expired' | 'send_failed' | 'handoff' | 'slot_unavailable' | 'failed' | 'superseded';

export interface OfferRow {
  id: string;
  workflowId: string;
  slotReference: string;
  waitlistId: string;
  patientId: string;
  status: OfferStatus;
  expiresAt: Date;
  createdAt: Date;
  respondedAt: Date | null;
}

const mapOffer = (x: any): OfferRow => ({
  id: x.id, workflowId: x.workflow_id, slotReference: x.appointment_slot_reference, waitlistId: x.waitlist_id, patientId: x.patient_id,
  status: x.status, expiresAt: x.expires_at, createdAt: x.created_at, respondedAt: x.responded_at,
});

export async function getOffer(q: Queryable, id: string): Promise<OfferRow | null> {
  const r = await q.query('SELECT * FROM appointment_offers WHERE id = $1', [id]);
  return r.rowCount ? mapOffer(r.rows[0]) : null;
}

export type CreateOfferResult =
  | { ok: true; offer: OfferRow; conversationId: string; created: boolean }
  | { ok: false; reason: 'patient_has_live_offer' };

export async function createOffer(db: Db, slot: SlotInfo, cand: { waitlistId: string; patientId: string }, now: Date, ttlMinutes: number): Promise<CreateOfferResult> {
  try {
    return await withTx(db, async tx => {
      const expiresAt = new Date(now.getTime() + ttlMinutes * 60000);
      const ins = await tx.query(
        `INSERT INTO appointment_offers (appointment_slot_reference, workflow_id, waitlist_id, patient_id, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)
         ON CONFLICT (appointment_slot_reference, waitlist_id) DO NOTHING RETURNING *`,
        [slot.slotReference, slot.workflowId, cand.waitlistId, cand.patientId, expiresAt, now],
      );
      const created = !!ins.rowCount;
      const offer = created ? mapOffer(ins.rows[0]) : mapOffer((await tx.query('SELECT * FROM appointment_offers WHERE appointment_slot_reference = $1 AND waitlist_id = $2', [slot.slotReference, cand.waitlistId])).rows[0]);
      // One open conversation per patient; point it at this offer and workflow thread.
      const conv = await tx.query(
        `INSERT INTO conversations (patient_id, active_offer_id, thread_id, status) VALUES ($1, $2, $3, 'open')
         ON CONFLICT (patient_id) WHERE status IN ('open', 'handoff')
         DO UPDATE SET active_offer_id = EXCLUDED.active_offer_id, thread_id = EXCLUDED.thread_id, status = 'open', updated_at = now()
         RETURNING id`,
        [cand.patientId, offer.id, slot.workflowId],
      );
      if (created) await recordEvent(tx, slot.workflowId, 'offer_created', { offerId: offer.id, waitlistId: cand.waitlistId, expiresAt: offer.expiresAt });
      return { ok: true as const, offer, conversationId: conv.rows[0].id as string, created };
    });
  } catch (e) {
    if (isUniqueViolation(e, 'offers_one_live_per_patient_uq')) return { ok: false, reason: 'patient_has_live_offer' };
    throw e;
  }
}

/** Compare-and-set transition; returns true when this call performed it. */
export async function transitionOffer(q: Queryable, offerId: string, from: OfferStatus[], to: OfferStatus, now: Date): Promise<boolean> {
  const r = await q.query(
    `UPDATE appointment_offers SET status = $3, responded_at = COALESCE(responded_at, $4) WHERE id = $1 AND status = ANY($2::text[])`,
    [offerId, from, to, now],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Expires a pending offer only if its deadline really passed (clock injected for tests). */
export async function expireOfferIfDue(q: Queryable, offerId: string, now: Date): Promise<boolean> {
  const r = await q.query(`UPDATE appointment_offers SET status = 'expired' WHERE id = $1 AND status = 'pending' AND expires_at <= $2`, [offerId, now]);
  return (r.rowCount ?? 0) > 0;
}

export async function closeConversation(q: Queryable, conversationId: string | null, status: 'closed' | 'handoff' = 'closed') {
  if (!conversationId) return;
  await q.query(`UPDATE conversations SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'closed'`, [conversationId, status]);
}

/** Workflows waiting for patients whose offer should now be widened to one more patient. */
export async function dueWidenings(q: Queryable, now: Date): Promise<string[]> {
  const r = await q.query(`SELECT id FROM recovery_workflows WHERE status = 'awaiting_patient' AND widen_at <= $1 ORDER BY widen_at LIMIT 50`, [now]);
  return r.rows.map(x => x.id as string);
}

export async function dueOffers(q: Queryable, now: Date): Promise<OfferRow[]> {
  const r = await q.query(`SELECT * FROM appointment_offers WHERE status = 'pending' AND expires_at <= $1 ORDER BY expires_at LIMIT 50`, [now]);
  return r.rows.map(mapOffer);
}
