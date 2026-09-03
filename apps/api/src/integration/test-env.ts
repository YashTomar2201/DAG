/**
 * Shared bootstrap for every `*.integration.test.ts` file.
 *
 * Reads the connection strings written by global-setup.ts, sets them on
 * `process.env` BEFORE anything imports `@dag/db` or `@dag/queue`, then
 * dynamically imports every module the test needs. This ordering is the
 * whole trick — see the comment block in global-setup.ts.
 *
 * Vitest's default `test.isolate: true` gives each test FILE a fresh module
 * registry, so this dynamic-import dance is safe to repeat per file without
 * one file's environment leaking into another's.
 */
import * as fs from 'fs';
import { HANDOFF_FILE } from './global-setup';

export interface TestEnv {
  databaseUrl: string;
  redisUrl: string;
  artifactDir: string;
}

export function readTestEnv(): TestEnv {
  const raw = fs.readFileSync(HANDOFF_FILE, 'utf8');
  return JSON.parse(raw) as TestEnv;
}

/**
 * Sets DATABASE_URL / REDIS_URL / ARTIFACT_DIR on process.env and dynamically
 * imports every workspace package the integration tests touch. Call this
 * ONCE per test file, before any other import of @dag/db / @dag/queue /
 * the orchestrator services.
 */
export async function bootstrapTestEnv() {
  const env = readTestEnv();
  process.env['DATABASE_URL'] = env.databaseUrl;
  process.env['REDIS_URL'] = env.redisUrl;
  process.env['ARTIFACT_DIR'] = env.artifactDir;
  process.env['NODE_ENV'] = 'test';

  const db = await import('@dag/db');
  const queue = await import('@dag/queue');
  const orchestrator = await import('../services/orchestrator.service');
  const runService = await import('../services/run.service');
  const workerEvents = await import('../worker-events');

  return { env, db, queue, orchestrator, runService, workerEvents };
}

/**
 * Closes every connection `bootstrapTestEnv()` opened. Each integration test
 * file gets a FRESH `@dag/queue` module (Vitest's default `isolate: true`),
 * which means a fresh `ioQueue`/`cpuQueue`/`gpuQueue`/`connection` — each
 * BullMQ `Queue` holds its own Redis connection in addition to the shared
 * one, so all three need an explicit `.close()` or the process is left with
 * dangling sockets after the test file finishes (harmless to test results,
 * but it's what makes `vitest run` hang for ~10s on exit instead of
 * finishing cleanly — see the "close timed out" warning without this).
 */
export async function teardownTestEnv(ctx: Awaited<ReturnType<typeof bootstrapTestEnv>>) {
  await Promise.allSettled([
    ctx.queue.ioQueue.close(),
    ctx.queue.cpuQueue.close(),
    ctx.queue.gpuQueue.close(),
    ctx.queue.schedulerQueue.close(),
  ]);
  await ctx.db.prisma.$disconnect();
  await ctx.queue.connection.quit().catch(() => {});
}
