// Drops and recreates the schema, then reseeds. Refuses to run in production.
import { createPool } from '../src/database/pool.ts';
import { migrate, dropAll } from '../src/database/migrate.ts';
import { seed } from '../src/database/seed.ts';
import { rmSync } from 'node:fs';

if (process.env.NODE_ENV === 'production') throw new Error('db:reset is disabled in production');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = createPool(url, 2);
await dropAll(db);
const applied = await migrate(db);
await seed(db, process.env.CLINIC_TIMEZONE || 'Europe/London');
rmSync('.data/mock-calendar.json', { force: true });
console.log(`reset complete; migrations: ${applied.join(', ')}; synthetic seed loaded; mock calendar cleared`);
await db.end();
