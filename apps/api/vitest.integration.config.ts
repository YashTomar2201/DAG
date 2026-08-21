import { defineConfig } from 'vitest/config';

/**
 * Phase 12 — Testcontainers integration suite.
 *
 * Separate from vitest.config.ts (the fast, mocked unit suite) because these
 * tests: (a) need `globalSetup` to boot real containers, (b) spawn real
 * worker OS processes and wait on real Python subprocesses, and (c) must run
 * one file at a time — every file dispatches real nodes onto the SAME shared
 * `queue:io`/`queue:cpu`/`queue:gpu` BullMQ queues (one Postgres + one Redis
 * container for the whole run, started once in globalSetup). Running two
 * integration files concurrently would let one test's dispatch assertions
 * ("exactly one job in queue:cpu") observe another test's jobs.
 *
 * Run with: `pnpm --filter @dag/api test:integration`
 * Requires: Docker running locally (or in CI).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/integration/**/*.integration.test.ts'],
    globalSetup: ['./src/integration/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Vitest's default 'threads' pool runs each test file in a worker
    // THREAD, tearing down and recreating a V8 isolate in the same OS
    // process between files. Each file here opens real ioredis/BullMQ/
    // Prisma connections; a native callback firing after its isolate has
    // been torn down showed up as an intermittent Windows access violation
    // (exit code 3221225477 / 0xC0000005) partway through a run. 'forks'
    // gives every file a genuinely separate OS process instead — the
    // standard fix for native-module flakiness under worker_threads. Default
    // isolation for the 'forks' pool already spawns one process per test
    // file, which combined with fileParallelism:false runs them one real
    // process at a time.
    pool: 'forks',
  },
});
