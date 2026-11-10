// Tracks fire-and-forget background work so shutdown and tests can wait for it.
import type { Logger } from './logger.ts';
import { errMsg } from './errors.ts';

export class TaskTracker {
  private inflight = new Set<Promise<unknown>>();
  private log: Logger;
  constructor(log: Logger) { this.log = log; }

  run(fn: () => Promise<unknown>) {
    const p = fn().catch(e => this.log.error('task.failed', { error: errMsg(e) }));
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
  }

  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }
}
