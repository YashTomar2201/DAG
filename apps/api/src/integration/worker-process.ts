/**
 * Spawns `apps/worker` as a genuine, separate OS process pointed at the
 * Testcontainers Postgres/Redis — not an in-process import.
 *
 * This is deliberate: apps/api and apps/worker are two independently
 * deployed processes in this architecture (control plane vs. data plane,
 * see PROJECT_GUIDE.md §4). Importing the worker's code directly into the
 * API test process would blur that boundary and let a test pass for reasons
 * that don't hold in production (e.g. accidentally sharing a Prisma
 * singleton). Spawning the real `tsx src/index.ts` entry point — the exact
 * command Phase 13's Dockerfile.worker will run — means a passing
 * integration test is evidence the *deployed* topology works, not just the
 * code.
 *
 * This same helper is reused by scripts/scale-test.ts to spawn N worker
 * processes for the horizontal-scaling proof.
 */
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const REPO_ROOT = path.resolve(__dirname, '../../../../');
const WORKER_DIR = path.join(REPO_ROOT, 'apps', 'worker');

/**
 * Kills `pid` and every descendant it spawned.
 *
 * Why not just `proc.kill()`: this worker is spawned with `shell: true` (the
 * resolved tsx binary is a `.CMD` shim on Windows, which needs a shell to
 * run). `proc` on Windows is then the `cmd.exe` **shell**, not the `node.exe`
 * process the shim eventually execs — `child.kill()` only signals that
 * shell. The shell has already exited by the time `node.exe` is actually
 * running, so nothing is listening for the signal and the real worker
 * process is orphaned, still holding its Postgres connection pool and its
 * BullMQ Redis connection. This is exactly what happened during Phase 12's
 * scale test: every prior test run's "stopped" worker was, in fact, still
 * running, and by the fourth or fifth run Postgres's `max_connections` was
 * exhausted before the benchmark even started. `taskkill /T` kills the
 * whole process tree in one call; POSIX gets the equivalent via a negative
 * PID (kills the process group) since `python-bridge.ts` already relies on
 * the same trick for the worker's own child processes.
 */
function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already dead, or never had children — not an error worth surfacing.
  }
}

/**
 * Resolves the `tsx` binary straight out of apps/worker's own
 * node_modules/.bin, instead of shelling out through `pnpm --filter
 * @dag/worker exec tsx ...`. Every `pnpm exec` re-runs pnpm's own workspace
 * resolution before it even starts your command; spawned five-plus times in
 * one test run (one or two workers per integration test file) that adds up
 * to real, and on this Windows dev box occasionally *slow enough to blow
 * past the test's own wait budget*, wall-clock overhead for no benefit —
 * the binary tsx resolves to is identical either way.
 */
function resolveTsxBin(): string {
  const candidate = process.platform === 'win32' ? 'tsx.CMD' : 'tsx';
  const binPath = path.join(WORKER_DIR, 'node_modules', '.bin', candidate);
  if (!fs.existsSync(binPath)) {
    throw new Error(`tsx binary not found at ${binPath} — run "pnpm install" first`);
  }
  return binPath;
}

export interface SpawnedWorker {
  proc: ChildProcess;
  label: string;
  stop: () => Promise<void>;
}

export function spawnWorkerProcess(
  extraEnv: Record<string, string>,
  label = 'worker',
): SpawnedWorker {
  const proc = spawn(
    resolveTsxBin(),
    ['src/index.ts'],
    {
      cwd: WORKER_DIR,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      // The resolved path is a .CMD shim on Windows — needs a shell to run.
      shell: true,
    },
  );

  proc.stdout?.on('data', (d: Buffer) => {
    if (process.env['DAG_TEST_VERBOSE']) process.stdout.write(`[${label}] ${d}`);
  });
  proc.stderr?.on('data', (d: Buffer) => {
    process.stderr.write(`[${label}:err] ${d}`);
  });

  const stop = () =>
    new Promise<void>((resolve) => {
      if (proc.exitCode !== null || !proc.pid) return resolve();
      // Not `proc.kill('SIGTERM')` then wait-and-see — see killTree()'s
      // comment for why that alone silently leaves the real worker running.
      // `taskkill /T` reliably reaches it via Windows' own recorded
      // parent-PID chain even though the immediate `proc` (the shell) may
      // already be gone, so there's nothing worth waiting on here.
      killTree(proc.pid);
      resolve();
    });

  return { proc, label, stop };
}

/**
 * Resolves once the worker has logged "Worker started" for all three queues
 * (io, cpu, gpu) — i.e. it is actually polling Redis and ready to accept jobs.
 * Without this, tests that dispatch immediately after spawn can race the
 * worker's own boot time (tsx compile + BullMQ connection handshake).
 */
export function waitForWorkerReady(worker: SpawnedWorker, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let readyCount = 0;
    const timer = setTimeout(() => {
      worker.proc.stdout?.off('data', onData);
      reject(new Error(`Worker "${worker.label}" did not report ready within ${timeoutMs}ms`));
    }, timeoutMs);

    function onData(chunk: Buffer) {
      const text = chunk.toString();
      const matches = text.match(/Worker started/g);
      if (matches) readyCount += matches.length;
      if (readyCount >= 3) {
        clearTimeout(timer);
        worker.proc.stdout?.off('data', onData);
        resolve();
      }
    }

    worker.proc.stdout?.on('data', onData);
  });
}
