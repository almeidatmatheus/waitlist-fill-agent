import pg from 'pg';

// timestamptz -> Date (default); bigint (bigserial ids) -> number for JSON friendliness.
pg.types.setTypeParser(20, v => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000, application_name: 'aar' });
  // Idle client errors (e.g. server restart) must not crash the process.
  pool.on('error', () => {});
  return pool;
}

/** Runs fn inside a transaction; rolls back on error. Keep these short: never call external APIs inside. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint?: string };
  return err?.code === '23505' && (!constraint || err.constraint === constraint);
}
