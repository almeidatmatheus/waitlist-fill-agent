// Periodic recovery work (no external queue/scheduler required for the MVP):
//  - expire overdue offers and move their workflows on
//  - widen an unanswered offer to one more patient (offer cascade)
//  - reconcile partially completed bookings (retry / adopt / finalize)
//  - re-process webhook events left pending (crash, lease contention)
//  - continue workflows that stopped mid-run (crash/restart)
//  - retry failed confirmation messages
import type { Db } from '../database/pool.ts';
import { errMsg } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import { newCorrelationId } from '../shared/ids.ts';
import type { WorkflowRunner } from '../workflows/runner.ts';
import type { BookingService } from './booking-service.ts';
import type { InboundService } from './inbound-service.ts';
import type { MessagingService } from './messaging-service.ts';
import type { PatientRequestService } from './patient-request-service.ts';
import { dueOffers, dueWidenings } from './offer-service.ts';

export interface SweepReport { expired: number; widened: number; reconciled: number; inboundRetried: number; resumed: number; messagesRetried: number; requestsRetried: number; errors: string[] }

export class Sweeper {
  private running = false;
  private o: { db: Db; runner: WorkflowRunner; booking: BookingService; inbound: InboundService; messaging: MessagingService; requests: PatientRequestService; log: Logger; now: () => Date };
  constructor(o: Sweeper['o']) { this.o = o; }

  async sweep(): Promise<SweepReport> {
    const rep: SweepReport = { expired: 0, widened: 0, reconciled: 0, inboundRetried: 0, resumed: 0, messagesRetried: 0, requestsRetried: 0, errors: [] };
    if (this.running) return rep;
    this.running = true;
    const { db, runner, booking, inbound, messaging, requests, log, now } = this.o;
    const safe = async (what: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { rep.errors.push(`${what}: ${errMsg(e)}`); log.warn('sweeper.error', { what, error: errMsg(e) }); } };
    try {
      for (const o of await dueOffers(db, now())) {
        await safe(`expire ${o.id}`, async () => { await runner.resume(o.workflowId, { type: 'offer_expired', offerId: o.id, correlationId: newCorrelationId() }); rep.expired++; });
      }
      for (const id of await dueWidenings(db, now())) {
        await safe(`widen ${id}`, async () => { await runner.resume(id, { type: 'widen', correlationId: newCorrelationId() }); rep.widened++; });
      }
      for (const b of await booking.dueForReconciliation()) {
        await safe(`reconcile ${b.id}`, async () => { if (await runner.kick(b.workflowId)) rep.reconciled++; });
      }
      for (const id of await inbound.pendingEventIds(5000)) {
        await safe(`inbound ${id}`, async () => { await inbound.process(id); rep.inboundRetried++; });
      }
      const stuck = await db.query(`SELECT id FROM recovery_workflows WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now()) AND updated_at < now() - interval '30 seconds' LIMIT 20`);
      for (const w of stuck.rows) await safe(`kick ${w.id}`, async () => { if (await runner.kick(w.id)) rep.resumed++; });
      for (const id of await requests.dueForRetry()) await safe(`request ${id}`, async () => { await requests.execute(id); rep.requestsRetried++; });
      await safe('messages', async () => { rep.messagesRetried = await messaging.retryFailed(); });
    } finally {
      this.running = false;
    }
    if (rep.expired || rep.widened || rep.reconciled || rep.inboundRetried || rep.resumed || rep.messagesRetried || rep.requestsRetried || rep.errors.length) log.info('sweeper.run', { ...rep });
    return rep;
  }
}
