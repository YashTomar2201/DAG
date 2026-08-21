/**
 * Phase 12 — Testcontainers global setup.
 *
 * Runs ONCE for the entire integration test run (shared by every
 * `*.integration.test.ts` file — see vitest.integration.config.ts). Starts a
 * real `postgres:16` container and a real `redis:7-alpine` container (the
 * same images infra/docker-compose.yml uses), pushes the Prisma schema onto
 * the fresh database, and hands the resulting connection strings to every
 * test file.
 *
 * Why Testcontainers instead of pointing tests at the already-running
 * docker-compose services?
 *   1. Isolation — each CI run (and each local run) gets a throwaway database
 *      and a throwaway Redis. Tests can never see leftover state from a
 *      previous run or collide with a developer's local dev data.
 *   2. Portability — `pnpm --filter @dag/api test:integration` works on a
 *      clean checkout with nothing but Docker installed. No manual
 *      `docker compose up` step, no "did you forget to start infra" failures.
 *   3. It is what proves the claims. Mocking Redis/Postgres in these tests
 *      would make Lua atomicity, conditional-UPDATE row locking, and BullMQ's
 *      real lock/stall behaviour untestable — those are exactly the
 *      mechanisms Phase 12 exists to verify (see decisions_log.md).
 *
 * How connection strings reach the test files:
 *   `@dag/db` and `@dag/queue` both read DATABASE_URL / REDIS_URL from
 *   `process.env` at MODULE-LOAD time (singleton PrismaClient / ioredis
 *   connections — see packages/db/src/client.ts, packages/queue/src/redis.ts).
 *   Vitest's `globalSetup` runs in its own process, so we cannot simply set
 *   `process.env` here and expect a test file's `import` to see it — ESM/CJS
 *   static imports are hoisted and evaluate before any test code runs.
 *
 *   Fix: write the resolved URLs to a small JSON file. Every integration test
 *   file reads that file FIRST (synchronously, before importing @dag/db or
 *   @dag/queue), sets `process.env`, and only THEN uses a dynamic `import()`
 *   to load the singletons. See ./test-env.ts.
 *
 * Worker processes: spawned ONCE here, shared by every test file.
 *   Earlier versions of this suite had each test file spawn its own worker
 *   process(es). On this Windows dev box that meant 5+ separate `tsx`-plus-
 *   `python3` process trees getting forked over the life of one `vitest run`
 *   — occasionally slow enough to blow past a test's wait budget, and once
 *   observed to bring down the whole run with a native access violation
 *   (Windows exit code 3221225477 / 0xC0000005). Spawning exactly TWO worker
 *   processes once, here, and leaving them running for the whole suite (torn
 *   down in the same function that stops the containers) reproduces Phase
 *   8's "2 worker processes" acceptance check exactly once instead of five
 *   times, and removed the flakiness entirely in practice. It's also closer
 *   to the real deployment shape: a fleet of long-lived workers serving many
 *   runs, not one worker spun up and torn down per run.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnWorkerProcess, waitForWorkerReady, type SpawnedWorker } from './worker-process';

const REPO_ROOT = path.resolve(__dirname, '../../../../');
const HANDOFF_DIR = path.join(os.tmpdir(), 'dag-engine-testcontainers');
export const HANDOFF_FILE = path.join(HANDOFF_DIR, 'env.json');

export default async function globalSetup() {
  console.warn('[testcontainers] starting postgres:16 and redis:7-alpine ...');

  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  const databaseUrl = pg.getConnectionUri();
  const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dag-it-artifacts-'));

  console.warn(`[testcontainers] postgres ready at ${pg.getHost()}:${pg.getMappedPort(5432)}`);
  console.warn(`[testcontainers] redis ready at ${redis.getHost()}:${redis.getMappedPort(6379)}`);

  // Push the Prisma schema onto the fresh, empty database. `db push` (not
  // `migrate deploy`) because packages/db has no committed migration history
  // yet — see decisions_log.md "Known gap: no Prisma migration files".
  const schemaPath = path.join(REPO_ROOT, 'packages', 'db', 'prisma', 'schema.prisma');
  console.warn('[testcontainers] pushing Prisma schema onto the test database ...');
  execFileSync(
    'pnpm',
    ['--filter', '@dag/db', 'exec', 'prisma', 'db', 'push', `--schema=${schemaPath}`, '--skip-generate', '--accept-data-loss'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
      // Windows resolves `pnpm` to pnpm.cmd, a batch shim — execFileSync
      // needs `shell: true` to invoke it (matches the shell:true used for
      // the same reason in worker-process.ts's spawn() calls).
      shell: true,
    },
  );

  fs.mkdirSync(HANDOFF_DIR, { recursive: true });
  fs.writeFileSync(HANDOFF_FILE, JSON.stringify({ databaseUrl, redisUrl, artifactDir }, null, 2));

  console.warn('[testcontainers] spawning 2 shared worker processes ...');
  const workerEnv = { DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, ARTIFACT_DIR: artifactDir };
  const workers: SpawnedWorker[] = [
    spawnWorkerProcess({ ...workerEnv, WORKER_ID: 'worker-a' }, 'worker-a'),
    spawnWorkerProcess({ ...workerEnv, WORKER_ID: 'worker-b' }, 'worker-b'),
  ];
  await Promise.all(workers.map((w) => waitForWorkerReady(w)));

  console.warn('[testcontainers] ready.');

  // Vitest calls this returned function once after ALL integration test
  // files have finished (teardown).
  return async () => {
    console.warn('[testcontainers] tearing down ...');
    await Promise.all(workers.map((w) => w.stop()));
    await stop(pg, redis, artifactDir);
  };
}

async function stop(
  pg: StartedPostgreSqlContainer,
  redis: StartedRedisContainer,
  artifactDir: string,
) {
  await Promise.allSettled([pg.stop(), redis.stop()]);
  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.rmSync(HANDOFF_FILE, { force: true });
}
