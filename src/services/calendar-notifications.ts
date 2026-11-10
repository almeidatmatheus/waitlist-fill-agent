// Microsoft Graph change notifications for the clinic calendar.
//  - The calendar MCP owns the subscription (`ntf`); this service asks it to create/renew it and
//    receives what Graph posts to /webhooks/graph.
//  - A notification is only a trigger: it makes the cancellation detector list the calendar now instead of
//    at the next polling tick. Nothing is cancelled from the notification payload alone.
//  - Every notification must carry our secret as clientState; anything else is dropped.
//  - While the subscription is healthy the polling loop slows down to a safety net; if it cannot be
//    created or renewed, polling runs at its normal rate.
import { timingSafeEqual } from 'node:crypto';
import type { Db } from '../database/pool.ts';
import { errMsg } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import type { TaskTracker } from '../shared/tasks.ts';
import type { InstrumentedCalendar } from '../integrations/outlook-mcp/instrumented-calendar.ts';
import type { CalendarSubscription } from '../integrations/outlook-mcp/types.ts';
import type { CancellationDetector } from './cancellation-detector.ts';
import { recordEvent } from './workflow-events.ts';

export interface NotificationReceipt {
  /** Items whose clientState matched. */
  accepted: number;
  rejected: number;
  malformed: boolean;
}

export interface CalendarNotificationsDeps {
  db: Db;
  calendar: InstrumentedCalendar;
  detector: CancellationDetector;
  tasks: TaskTracker;
  log: Logger;
  now: () => Date;
  /** Empty secret = notifications off. */
  secret: string;
  /** Renew when the subscription has less than this left. */
  renewBeforeMs: number;
  /** Notifications arriving within this window share one calendar listing. */
  debounceMs: number;
  /** Polling interval while the subscription is healthy. */
  fallbackPollMs: number;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class CalendarNotifications {
  private d: CalendarNotificationsDeps;
  private secret: Buffer;
  private sub: CalendarSubscription | null = null;
  private failures = 0;
  private retryAt = 0;
  private ensuring: Promise<void> | null = null;
  private pollQueued = false;

  constructor(d: CalendarNotificationsDeps) {
    this.d = d;
    this.secret = Buffer.from(d.secret);
  }

  get enabled() { return this.secret.length > 0; }

  private healthy() { return !!this.sub && this.sub.expiresAt.getTime() > this.d.now().getTime(); }

  status(): 'off' | 'active' | 'degraded' { return !this.enabled ? 'off' : this.healthy() ? 'active' : 'degraded'; }

  /** Polling tick: at the normal rate without a healthy subscription, at the fallback rate with one. */
  pollDue(): boolean {
    return !this.healthy() || Date.now() - this.d.detector.lastPollAt >= this.d.fallbackPollMs;
  }

  /** Creates the subscription or renews it when it is close to expiring. Safe to call often. */
  ensure(force = false): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.ensuring ??= this.doEnsure(force).finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  private async doEnsure(force: boolean) {
    const now = this.d.now().getTime();
    if (!force) {
      if (this.sub && this.sub.expiresAt.getTime() - now > this.d.renewBeforeMs) return;
      if (Date.now() < this.retryAt) return;
    }
    try {
      this.sub = await this.d.calendar.ensureSubscription();
      this.failures = 0; this.retryAt = 0;
      this.d.log.info('calendar.subscription_ready', { subscriptionId: this.sub.id, expiresAt: this.sub.expiresAt.toISOString() });
    } catch (e) {
      // Back off (1, 2, 4 ... 15 min). The old subscription, if any, stays valid until it expires.
      this.failures++;
      this.retryAt = Date.now() + Math.min(60000 * 2 ** (this.failures - 1), 15 * 60000);
      const kind = (e as { kind?: string }).kind;
      this.d.log.warn('calendar.subscription_failed', { error: errMsg(e), kind, failures: this.failures });
      if (this.failures === 1) await recordEvent(this.d.db, null, 'calendar_subscription_failed', { error: errMsg(e).slice(0, 200), kind });
    }
  }

  private trusted(clientState: unknown): boolean {
    if (typeof clientState !== 'string') return false;
    const got = Buffer.from(clientState);
    return got.length === this.secret.length && timingSafeEqual(got, this.secret);
  }

  /** Handles one POST from Graph. Returns quickly: the calendar listing runs in the background. */
  receive(body: unknown): NotificationReceipt {
    const items = (body as { value?: unknown } | null)?.value;
    if (!Array.isArray(items)) return { accepted: 0, rejected: 0, malformed: true };
    const r: NotificationReceipt = { accepted: 0, rejected: 0, malformed: false };
    let poll = false, renew = false, deleted = 0;
    for (const raw of items.slice(0, 200)) {
      const n = (raw ?? {}) as { clientState?: unknown; changeType?: unknown; lifecycleEvent?: unknown; resourceData?: { id?: unknown } };
      if (!this.trusted(n.clientState)) { r.rejected++; continue; }
      r.accepted++;
      if (typeof n.lifecycleEvent === 'string') {
        // reauthorizationRequired / subscriptionRemoved: renew or recreate. missed: we may have lost changes.
        this.d.log.warn('calendar.subscription_lifecycle', { event: n.lifecycleEvent });
        if (n.lifecycleEvent === 'missed') poll = true; else renew = true;
        continue;
      }
      const id = n.resourceData?.id;
      if (n.changeType === 'deleted' && typeof id === 'string' && id) { this.d.detector.hintDeleted(id); deleted++; }
      poll = true;
    }
    if (r.accepted) this.d.log.info('calendar.notification', { accepted: r.accepted, deleted, poll, renew });
    if (r.rejected) this.d.log.warn('calendar.notification_rejected', { rejected: r.rejected });
    if (renew) this.d.tasks.run(() => this.ensure(true));
    if (poll || renew) this.schedulePoll();
    return r;
  }

  private schedulePoll() {
    if (this.pollQueued) return;
    this.pollQueued = true;
    this.d.tasks.run(async () => {
      if (this.d.debounceMs > 0) await sleep(this.d.debounceMs);
      this.pollQueued = false;
      // The detector runs one poll at a time; wait for a running one so this change is not missed.
      for (let i = 0; i < 40; i++) {
        const report = await this.d.detector.poll();
        if (report.skippedReason !== 'poll already running') return;
        await sleep(250);
      }
    });
  }
}
