import { createPool } from '../src/database/pool.ts';
import { migrate } from '../src/database/migrate.ts';
import { seed } from '../src/database/seed.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const tz = process.env.CLINIC_TIMEZONE || 'Europe/London';
const db = createPool(url, 2);
await migrate(db);
await seed(db, tz);
const counts = await db.query(`SELECT (SELECT count(*) FROM patients) patients, (SELECT count(*) FROM treatments) treatments,
  (SELECT count(*) FROM appointments) appointments, (SELECT count(*) FROM waitlist) waitlist`);
console.log('seeded (synthetic data only):', counts.rows[0]);
await db.end();
