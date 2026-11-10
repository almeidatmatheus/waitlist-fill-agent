// Starts and resumes recovery graphs. Executions of one thread are serialised twice:
//  - in-process: a promise chain per workflow id
//  - across processes: a short DB lease on recovery_workflows (no DB lock is held while the graph runs)
import { Command } from '@langchain/langgraph';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { withTx, type Db } from '../database/pool.ts';
import { errMsg } from '../shared/errors.ts';
import type { Logger } from '../shared/logger.ts';
import { newCorrelationId } from '../shared/ids.ts';
import { recordEvent } from '../services/workflow-events.ts';
import type { RecoveryGraph } from './recovery-graph.ts';
import type { RecoveryStateType, ResumeEvent, WaitingFor } from './state.ts';

export class LeaseBusyError extends Error {
  constructor(workflowId: string) {
    super(`workflow ${workflowId} is being executed by another worker`);
    this.name = 'LeaseBusyError';
  }
}

export interface RunResult {
  workflowId: string;
  state: RecoveryStateType;
  waitingFor: WaitingFor | null;
  finished: boolean;
}

const STATUS_BY_OUTCOME = { booked: 'booked', exhausted: 'exhausted', slot_unavailable: 'slot_unavailable', failed: 'failed', closed: 'closed' } as const;
const STATUS_BY_WAIT = { patient: 'awaiting_patient', human: 'awaiting_human', reconciliation: 'awaiting_reconciliation' } as const;

export class WorkflowRunner {
  private db: Db;
  private graph: RecoveryGraph;
  private log: Logger;
  private owner: string;
  private leaseMs: number;
  private chains = new Map<string, Promise<unknown>>();

  constructor(opts: { db: Db; graph: RecoveryGraph; log: Logger; owner: string; leaseMs?: number }) {
    this.db = opts.db;
    this.graph = opts.graph;
    this.log = opts.log;
    this.owner = opts.owner;
    this.leaseMs = opts.leaseMs ?? 120_000;
  }

  private cfg(workflowId: string) {
    return { configurable: { thread_id: workflowId }, recursionLimit: 200 };
  }

  /** Records a confirmed cancellation and starts exactly one recovery workflow for it (idempotent). */
  async startForCancellation(input: { appointmentId: string; source: 'calendar_poll' | 'manual' | 'patient'; observation: 'missing' | 'cancelled' | 'manual' | 'patient_cancel' | 'patient_reschedule'; details?: Record<string, unknown>; correlationId?: string; finalStatus?: 'cancelled' | 'rescheduled' }): Promise<{ workflowId: string; created: boolean; result: RunResult | null }> {
    const correlationId = input.correlationId ?? newCorrelationId();
    const { workflowId, created } = await withTx(this.db, async tx => {
      const a = await tx.query(`SELECT id, status, treatment_id, starts_at, ends_at FROM appointments WHERE id = $1 FOR UPDATE`, [input.appointmentId]);
      if (!a.rowCount) throw new Error('appointment not found');
      const existing = await tx.query('SELECT id FROM recovery_workflows WHERE cancelled_appointment_id = $1', [input.appointmentId]);
      if (existing.rowCount) return { workflowId: existing.rows[0].id as string, created: false };
      if (a.rows[0].status !== 'scheduled') throw new Error(`appointment is ${a.rows[0].status}, not scheduled`);
      await tx.query(
        `INSERT INTO cancellation_events (appointment_id, source, observation, details) VALUES ($1, $2, $3, $4) ON CONFLICT (appointment_id) DO NOTHING`,
        [input.appointmentId, input.source, input.observation, JSON.stringify(input.details ?? {})],
      );
      await tx.query(`UPDATE appointments SET status = $2, updated_at = now() WHERE id = $1`, [input.appointmentId, input.finalStatus ?? 'cancelled']);
      const w = await tx.query(
        `INSERT INTO recovery_workflows (cancelled_appointment_id, slot_reference, treatment_id, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.appointmentId, `slot:${input.appointmentId}`, a.rows[0].treatment_id, a.rows[0].starts_at, a.rows[0].ends_at],
      );
      await recordEvent(tx, w.rows[0].id, 'cancellation_detected', { appointmentId: input.appointmentId, source: input.source, observation: input.observation, correlationId });
      return { workflowId: w.rows[0].id as string, created: true };
    });
    this.log.info('workflow.cancellation_recorded', { workflowId, appointmentId: input.appointmentId, created, source: input.source, correlationId });
    if (!created) return { workflowId, created, result: null };
    const result = await this.run(workflowId, { workflowId, correlationId, status: 'cancellation_detected' }, correlationId);
    return { workflowId, created, result };
  }

  resume(workflowId: string, event: ResumeEvent): Promise<RunResult> {
    return this.run(workflowId, new Command({ resume: event }), event.correlationId);
  }

  /** Continues a thread that is not waiting on anything (e.g. crashed mid-run) or retries a pending booking. */
  async kick(workflowId: string): Promise<RunResult | null> {
    const snap = await this.graph.getState(this.cfg(workflowId));
    if (!snap.next.length) return null;
    const waiting = this.waitingFrom(snap);
    if (waiting === 'reconciliation') {
      const bookingId = (snap.values as RecoveryStateType).bookingId!;
      return this.resume(workflowId, { type: 'retry_booking', bookingId, correlationId: newCorrelationId() });
    }
    if (waiting) return null;
    return this.run(workflowId, null, newCorrelationId());
  }

  async snapshot(workflowId: string) {
    const snap = await this.graph.getState(this.cfg(workflowId));
    return { values: snap.values as RecoveryStateType, next: snap.next, waitingFor: this.waitingFrom(snap) };
  }

  private waitingFrom(snap: { tasks?: { interrupts?: { value?: unknown }[] }[] }): WaitingFor | null {
    for (const t of snap.tasks ?? []) for (const i of t.interrupts ?? []) {
      const w = (i.value as { waitingFor?: WaitingFor } | undefined)?.waitingFor;
      if (w) return w;
    }
    return null;
  }

  private serialize<T>(workflowId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(workflowId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.chains.set(workflowId, next);
    next.finally(() => { if (this.chains.get(workflowId) === next) this.chains.delete(workflowId); }).catch(() => {});
    return next;
  }

  private run(workflowId: string, input: unknown, correlationId: string): Promise<RunResult> {
    return this.serialize(workflowId, async () => {
      const lease = await this.db.query(
        `UPDATE recovery_workflows SET lease_owner = $2, lease_expires_at = now() + make_interval(secs => $3)
          WHERE id = $1 AND (lease_expires_at IS NULL OR lease_expires_at < now() OR lease_owner = $2) RETURNING id`,
        [workflowId, this.owner, this.leaseMs / 1000],
      );
      if (!lease.rowCount) throw new LeaseBusyError(workflowId);
      const t0 = Date.now();
      try {
        // Detach from any ambient LangGraph context. A workflow can be started from inside the patient agent's
        // own graph (a tool cancels an appointment -> the freed slot starts recovery). Without this, LangGraph
        // treats the recovery graph as a nested subgraph and its interrupt() escapes as an exception.
        await AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () => this.graph.invoke(input as any, this.cfg(workflowId)));
        const snap = await this.graph.getState(this.cfg(workflowId));
        const state = snap.values as RecoveryStateType;
        const waitingFor = this.waitingFrom(snap);
        const finished = snap.next.length === 0;
        const status = finished ? STATUS_BY_OUTCOME[state.outcome ?? 'failed'] : waitingFor ? STATUS_BY_WAIT[waitingFor] : 'running';
        await this.db.query(
          `UPDATE recovery_workflows SET status = $2, current_state = $3, widen_at = $4, last_error = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1`,
          [workflowId, status, waitingFor && snap.next[0] ? snap.next[0] : state.status, waitingFor === 'patient' ? state.widenAt ?? null : null],
        );
        this.log.info('workflow.run', { workflowId, correlationId, status, state: waitingFor && snap.next[0] ? snap.next[0] : state.status, waitingFor, durationMs: Date.now() - t0 });
        return { workflowId, state, waitingFor, finished };
      } catch (e) {
        await this.db.query(`UPDATE recovery_workflows SET last_error = $2, lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1`, [workflowId, errMsg(e).slice(0, 500)]).catch(() => {});
        await recordEvent(this.db, workflowId, 'workflow_error', { error: errMsg(e).slice(0, 300), correlationId }).catch(() => {});
        this.log.error('workflow.run_failed', { workflowId, correlationId, error: errMsg(e), durationMs: Date.now() - t0 });
        throw e;
      }
    });
  }
}
