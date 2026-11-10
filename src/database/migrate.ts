// Plain SQL migration runner: applies migrations/NNN_*.sql in order, each in its own transaction.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './pool.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  const files = readdirSync(dir).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      // Serialise concurrent migrators.
      await c.query('SELECT pg_advisory_xact_lock(727274)');
      const again = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
      if (!again.rowCount) {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        applied.push(f);
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    } finally {
      c.release();
    }
  }
  return applied;
}

/** Drops every application object (public schema + LangGraph checkpoint schema). Dev/test only. */
export async function dropAll(db: Db): Promise<void> {
  await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS langgraph CASCADE;');
}
