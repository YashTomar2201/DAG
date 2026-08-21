import { PrismaClient } from './generated/client';

/**
 * Bounds this process's Prisma connection pool.
 *
 * Why this exists (Phase 12): the scale test's 4-worker pass hit real
 * Postgres exhaustion — `FATAL: sorry, too many clients already` — because
 * every worker PROCESS gets its own `PrismaClient`, and Prisma's default
 * pool size (`num_cpus * 2 + 1`) is sized for ONE process assuming it owns
 * the whole connection budget. With N worker processes + the API process +
 * `postgres:16`'s default `max_connections = 100`, that assumption breaks
 * fast: 4 workers x an ~9-connection default pool already gets close to 100
 * before the API or any ad-hoc tooling connects at all.
 *
 * `connection_limit` (and `pool_timeout`, so a starved caller fails fast
 * with a clear error instead of hanging) are appended to the connection
 * string Prisma actually uses — this is how Prisma's own docs recommend
 * bounding pool size per client. Default of 5 is deliberately small: this
 * workload is mostly single-row conditional UPDATEs (`tryTransitionNodeRun`),
 * not wide parallel query fan-out within one process, so 5 concurrent
 * connections is plenty per worker while leaving headroom for N workers to
 * coexist under the default `max_connections = 100`. Override via
 * `DB_POOL_SIZE` for a benchmark or a bigger box.
 */
function boundedDatabaseUrl(): string | undefined {
  const raw = process.env['DATABASE_URL'];
  if (!raw) return undefined;
  const poolSize = process.env['DB_POOL_SIZE'] ?? '5';
  const url = new URL(raw);
  if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', poolSize);
  if (!url.searchParams.has('pool_timeout')) url.searchParams.set('pool_timeout', '10');
  return url.toString();
}

/**
 * Singleton PrismaClient.
 *
 * Rules:
 *   - Import `prisma` from '@dag/db', never instantiate PrismaClient directly in apps/.
 *   - Do not call prisma.$disconnect() mid-run; only on process exit.
 */
export const prisma = new PrismaClient({
  log: process.env['NODE_ENV'] === 'development'
    ? ['query', 'warn', 'error']
    : ['warn', 'error'],
  ...(boundedDatabaseUrl() ? { datasources: { db: { url: boundedDatabaseUrl()! } } } : {}),
});
