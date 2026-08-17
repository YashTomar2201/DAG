/**
 * Infrastructure acceptance check — Phase 0
 *
 * Connects to Postgres and Redis using the same URLs that apps/api and apps/worker
 * will use at runtime. Fails loudly with exit code 1 if either is unreachable.
 *
 * Run: pnpm check:infra  (from repo root, after docker compose up -d)
 */

import { Client as PgClient } from 'pg';
import Redis from 'ioredis';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://dag:dag_secret@localhost:5432/dag_engine';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

async function checkPostgres(): Promise<void> {
  const client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
  const result = await client.query<{ result: number }>('SELECT 1 AS result');
  const row = result.rows[0];
  if (!row || row.result !== 1) throw new Error('Unexpected Postgres response');
  await client.end();
  console.warn('✅  PostgreSQL — connected and responding (SELECT 1 passed)');
}

async function checkRedis(): Promise<void> {
  const redis = new Redis(REDIS_URL, {
    // Fail fast — don't retry during the acceptance check
    maxRetriesPerRequest: 0,
    lazyConnect: true,
  });
  await redis.connect();
  const pong = await redis.ping();
  if (pong !== 'PONG') throw new Error(`Unexpected Redis response: ${pong}`);
  await redis.quit();
  console.warn('✅  Redis     — connected and responding (PING → PONG)');
}

async function main(): Promise<void> {
  console.warn('\n── DAG Engine Infrastructure Check ──────────────────────────');
  console.warn(`   DATABASE_URL: ${DATABASE_URL}`);
  console.warn(`   REDIS_URL:    ${REDIS_URL}`);
  console.warn('─────────────────────────────────────────────────────────────\n');

  try {
    await Promise.all([checkPostgres(), checkRedis()]);
    console.warn('\n🎉  All infrastructure checks passed — Phase 0 acceptance check complete.\n');
  } catch (err) {
    console.error('\n❌  Infrastructure check FAILED:', err);
    console.error('    Ensure docker compose is running: docker compose -f infra/docker-compose.yml up -d\n');
    process.exit(1);
  }
}

main();
