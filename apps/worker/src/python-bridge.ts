/**
 * Python Bridge — spawns Python scripts as child processes.
 *
 * Protocol:
 *   - Serialised input is written to the child's stdin as a single JSON line.
 *   - stdout is streamed line-by-line to the run log.
 *   - The final stdout line matching `::RESULT:: {json}` is the return value.
 *   - Non-zero exit → error with the tail of stderr attached.
 *   - A per-node timeout kills the whole child process group so orphan
 *     child-of-child processes don't keep running after a timeout.
 *
 * Why JSON over stdio rather than a REST call or shared DB table?
 *   REST calls require the script to know the API address and authenticate.
 *   Shared DB tables couple the Python code to the Prisma schema.
 *   Stdio is the Unix standard for IPC: language-neutral, requires zero
 *   extra network config, and the child can be tested independently with
 *   echo/cat. The `::RESULT::` sentinel is unambiguous — no confusion
 *   between log lines and the final output.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { logger } from './logger';
import { UnrecoverableError } from 'bullmq';

const PYTHON_DIR = path.resolve(process.cwd(), 'python');
const RESULT_PREFIX = '::RESULT::';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface PythonBridgeOptions {
  /** Absolute path to the .py file */
  scriptPath: string;
  /** JSON-serialisable input passed to the script via stdin */
  input: unknown;
  /** Max execution time in ms before SIGKILL. Default: 30 min */
  timeoutMs?: number;
  /** Aborted → SIGKILL the child process group and reject (roadmap B4). */
  signal?: AbortSignal;
  /** Called with each stdout line for live log streaming */
  onLog?: (line: string) => void;
}

/** Raised when `runPython` is aborted via its `signal` (a run cancellation). */
export class PythonCancelledError extends Error {
  constructor(scriptPath: string) {
    super(`Python script cancelled: ${scriptPath}`);
    this.name = 'PythonCancelledError';
  }
}

export async function runPython(opts: PythonBridgeOptions): Promise<unknown> {
  const { scriptPath, input, timeoutMs = DEFAULT_TIMEOUT_MS, signal, onLog } = opts;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PythonCancelledError(scriptPath));
      return;
    }
    const absPath = path.isAbsolute(scriptPath)
      ? scriptPath
      : path.join(PYTHON_DIR, scriptPath);

    logger.debug({ script: absPath }, 'Spawning Python process');

    const child = spawn('python3', [absPath], {
      // detached: true so we can kill the entire process GROUP on timeout
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // ── Write input to stdin ────────────────────────────────────────────────
    child.stdin.write(JSON.stringify(input) + '\n');
    child.stdin.end();

    // ── Stream stdout ────────────────────────────────────────────────────────
    let resultLine: string | null = null;
    let stdoutBuf = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop()!; // keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.replace(/\r$/, ''); // strip Windows \r\n
        if (trimmed.startsWith(RESULT_PREFIX)) {
          resultLine = trimmed.slice(RESULT_PREFIX.length).trim();
        } else if (trimmed) {
          onLog?.(trimmed);
          logger.debug({ line: trimmed }, '[python stdout]');
        }
      }
    });

    // ── Capture stderr for error messages ────────────────────────────────────
    const stderrLines: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line) stderrLines.push(line);
      }
    });

    /** SIGKILL the whole process group — negative PID reaches orphan grandchildren. */
    const killGroup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    // ── Timeout watchdog ─────────────────────────────────────────────────────
    const timer = setTimeout(() => {
      killGroup();
      reject(new Error(`Python script timed out after ${timeoutMs / 1000}s: ${absPath}`));
    }, timeoutMs);

    // ── Cancellation (roadmap B4) — same process-group kill as the timeout ────
    const onAbort = () => {
      clearTimeout(timer);
      killGroup();
      reject(new PythonCancelledError(absPath));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // ── Process exit ─────────────────────────────────────────────────────────
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      if (code !== 0) {
        const tail = stderrLines.slice(-20).join('\n');
        const msg = `Python script exited with code ${code}: ${absPath}\n${tail}`;
        logger.error({ code, script: absPath, stderr: tail }, 'Python process failed');

        // SyntaxError, ImportError, or "can't open file" (missing script) → unrecoverable
        const isUnrecoverable = stderrLines.some(
          (l) =>
            l.includes('SyntaxError') ||
            l.includes('ModuleNotFoundError') ||
            l.includes('ImportError') ||
            l.includes("can't open file") ||
            l.includes('No such file or directory'),
        );

        if (isUnrecoverable) {
          reject(new UnrecoverableError(msg));
        } else {
          reject(new Error(msg));
        }
        return;
      }

      if (!resultLine) {
        // Script exited 0 but produced no ::RESULT:: line — treat as unrecoverable
        reject(
          new UnrecoverableError(
            `Python script exited successfully but emitted no ::RESULT:: line: ${absPath}. ` +
              `Ensure the script ends with: print("::RESULT::", json.dumps(output))`,
          ),
        );
        return;
      }

      try {
        const output = JSON.parse(resultLine);
        resolve(output);
      } catch (e) {
        reject(
          new UnrecoverableError(
            `Failed to parse ::RESULT:: JSON from ${absPath}: ${resultLine}`,
          ),
        );
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // ENOENT = script file not found; definitely unrecoverable
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new UnrecoverableError(`Python script not found: ${absPath}`));
      } else {
        reject(err);
      }
    });
  });
}
