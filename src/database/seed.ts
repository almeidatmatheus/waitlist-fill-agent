import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './pool.ts';

export const SEED_FILE = join(import.meta.dirname, '..', '..', 'seeds', 'seed.sql');

export async function seed(db: Db, clinicTz: string): Promise<void> {
  const sql = readFileSync(SEED_FILE, 'utf8');
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('aar.clinic_tz', $1, true)`, [clinicTz]);
    await c.query(sql);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Removes all operational/workflow rows, keeping the schema. Dev/test only. */
export async function truncateAll(db: Db): Promise<void> {
  await db.query(`TRUNCATE workflow_events, human_handoffs, bookings, inbound_events, messages, conversations,
    appointment_offers, recovery_workflows, cancellation_events, waitlist, appointments, treatments, patients RESTART IDENTITY CASCADE`);
  await db.query(`DO $$ BEGIN
    IF to_regclass('langgraph.checkpoints') IS NOT NULL THEN
      EXECUTE 'TRUNCATE langgraph.checkpoints, langgraph.checkpoint_blobs, langgraph.checkpoint_writes';
    END IF; END $$;`);
}
