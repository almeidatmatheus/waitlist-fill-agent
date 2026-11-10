import { createPool } from '../src/database/pool.ts';
import { migrate } from '../src/database/migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = createPool(url, 2);
const applied = await migrate(db);
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database already up to date');
await db.end();
