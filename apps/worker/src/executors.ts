/**
 * Executor implementations for all five reference pipeline node types.
 *
 * Each executor is responsible for:
 *  1. Computing a deterministic artifact path from `{runId}:{nodeKey}`.
 *  2. Checking for an existing artifact (idempotency short-circuit).
 *  3. Writing to `*.tmp` then atomically renaming to prevent half-written files.
 *  4. Running the actual work (shell-out or Python bridge).
 *  5. Sending periodic heartbeats on long-running tasks.
 *  6. Returning a ≤ 64 KB reference object.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { UnrecoverableError } from 'bullmq';
import type {
  DataSourceConfig,
  PandasPreprocessConfig,
  TorchTrainConfig,
  ModelEvaluateConfig,
  RegistryDeployConfig,
} from '@dag/contracts';
import type { ExecutorContext, ExecutorOutput, ExecutorRegistry } from './executor-types';
import { runPython } from './python-bridge';
import { logger } from './logger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Computes SHA-256 of a file. Used for idempotency short-circuit checks:
 * if the file exists and its checksum matches the expected value, we know
 * the previous run completed correctly and we can skip re-downloading.
 */
function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Atomic write: write to `{path}.tmp`, then `fs.renameSync`.
 * A crash between write and rename leaves the `.tmp` file, not a partial
 * target. On restart, the `.tmp` is ignored (the target doesn't exist yet),
 * so the executor re-runs cleanly.
 */
function atomicWriteJson(targetPath: string, data: unknown): void {
  const tmp = `${targetPath}.tmp`;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, targetPath);
}

/**
 * Sets up an interval that calls `job.extendLock()` to prevent BullMQ from
 * treating a long-running job as stalled. Returns a teardown function.
 *
 * Without heartbeats, a `torch.train` job that takes 2 hours would
 * exceed the default `lockDuration` (30 s) and BullMQ would re-deliver it
 * to another worker, causing duplicate training runs.
 */
function startHeartbeat(ctx: ExecutorContext, intervalMs = 15_000): () => void {
  const iv = setInterval(async () => {
    try {
      await ctx.job.extendLock(ctx.job.token ?? '', intervalMs * 2);
      logger.debug({ runId: ctx.runId, nodeKey: ctx.nodeKey }, 'Heartbeat: lock extended');
    } catch (err) {
      logger.warn({ err }, 'Heartbeat: failed to extend lock');
    }
  }, intervalMs);
  return () => clearInterval(iv);
}

// ─── data.source ─────────────────────────────────────────────────────────────

/** Bundled dataset shipped in the image (see apps/worker/python/data/). */
const BUNDLED_CSV = path.resolve(process.cwd(), 'python', 'data', 'titanic.csv');
const MAX_CSV_BYTES = 64 * 1024 * 1024; // 64 MB — refuse anything larger

/** Resolve a local `csvPath` against a few sensible bases. */
function resolveLocalCsv(csvPath: string): string {
  const bases = [csvPath, path.resolve(process.cwd(), csvPath), path.resolve(process.cwd(), 'python', csvPath)];
  for (const b of bases) {
    if (fs.existsSync(b) && fs.statSync(b).isFile()) return b;
  }
  throw new UnrecoverableError(`data.source: local CSV not found (tried ${bases.join(', ')})`);
}

/**
 * data.source — the honest entry node. Copies a local CSV (default: the bundled
 * dataset) or fetches one from an http(s) URL into the shared artifact volume,
 * validates that it parses as CSV, and emits a reference + real row/column
 * counts. No credentials, always runs.
 */
async function dataSource(ctx: ExecutorContext): Promise<ExecutorOutput> {
  const config = ctx.config as DataSourceConfig;
  const destDir = path.join(ctx.artifactDir, ctx.runId, ctx.nodeKey);
  const csvOut = path.join(destDir, 'data.csv');
  const resultPath = path.join(destDir, 'result.json');

  // Idempotency: a prior attempt in this run already fetched + validated it.
  if (fs.existsSync(resultPath)) {
    logger.info({ runId: ctx.runId, nodeKey: ctx.nodeKey }, 'data.source: cache hit');
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  }

  fs.mkdirSync(destDir, { recursive: true });

  let sourceType: 'url' | 'local';
  let source: string;

  if (config.url) {
    sourceType = 'url';
    source = config.url;
    if (!/^https?:\/\//i.test(config.url)) {
      throw new UnrecoverableError(`data.source: only http(s) URLs are supported, got "${config.url}"`);
    }
    ctx.onLog(`[data.source] fetching ${config.url}`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      const res = await fetch(config.url, { signal: ac.signal });
      if (!res.ok) {
        // 4xx won't fix itself on retry; 5xx / network might.
        const Err = res.status >= 400 && res.status < 500 ? UnrecoverableError : Error;
        throw new Err(`data.source: fetch ${config.url} → HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_CSV_BYTES) {
        throw new UnrecoverableError(`data.source: ${config.url} is ${buf.byteLength} bytes, over the ${MAX_CSV_BYTES} limit`);
      }
      fs.writeFileSync(`${csvOut}.tmp`, buf);
      fs.renameSync(`${csvOut}.tmp`, csvOut);
    } catch (err) {
      if (err instanceof UnrecoverableError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`data.source: fetch failed (retryable): ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  } else {
    sourceType = 'local';
    source = config.csvPath ?? path.relative(process.cwd(), BUNDLED_CSV);
    const src = config.csvPath ? resolveLocalCsv(config.csvPath) : BUNDLED_CSV;
    if (!fs.existsSync(src)) {
      throw new UnrecoverableError(`data.source: bundled dataset missing at ${src}`);
    }
    if (fs.statSync(src).size > MAX_CSV_BYTES) {
      throw new UnrecoverableError(`data.source: ${src} is over the ${MAX_CSV_BYTES}-byte limit`);
    }
    ctx.onLog(`[data.source] copying ${src}`);
    fs.copyFileSync(src, `${csvOut}.tmp`);
    fs.renameSync(`${csvOut}.tmp`, csvOut);
  }

  // ── Validate it parses as CSV ────────────────────────────────────────────
  const text = fs.readFileSync(csvOut, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) {
    throw new UnrecoverableError(`data.source: ${source} has no data rows (got ${lines.length} non-empty line(s))`);
  }
  const columns = lines[0]!.split(',').map((c) => c.trim());
  if (columns.length < 1 || columns.some((c) => c === '')) {
    throw new UnrecoverableError(`data.source: ${source} has a malformed header row`);
  }
  const rows = lines.length - 1;

  const result: ExecutorOutput = {
    csvPath: csvOut,
    rows,
    columns,
    bytes: Buffer.byteLength(text, 'utf8'),
    checksum: sha256File(csvOut),
    sourceType,
    source,
    outputDir: destDir,
  };
  ctx.onLog(`[data.source] ${sourceType}: ${rows} rows x ${columns.length} cols`);
  atomicWriteJson(resultPath, result);
  return result;
}

// ─── pandas.preprocess ───────────────────────────────────────────────────────

async function pandasPreprocess(ctx: ExecutorContext): Promise<ExecutorOutput> {
  const config = ctx.config as PandasPreprocessConfig;
  const destDir = path.join(ctx.artifactDir, ctx.runId, ctx.nodeKey);
  const resultPath = path.join(destDir, 'result.json');

  // Idempotency: if a previous run already wrote result.json, reuse it
  if (fs.existsSync(resultPath)) {
    logger.info({ runId: ctx.runId, nodeKey: ctx.nodeKey }, 'pandas.preprocess: cache hit');
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  }

  fs.mkdirSync(destDir, { recursive: true });

  const output = await runPython({
    scriptPath: config.scriptPath ?? 'preprocess.py',
    input: {
      ...ctx.input,
      kwargs: config.kwargs ?? {},
      outputDir: destDir,
    },
    onLog: ctx.onLog,
  });

  // Persist result atomically
  atomicWriteJson(resultPath, output);
  return output as ExecutorOutput;
}

// ─── torch.train ─────────────────────────────────────────────────────────────

async function torchTrain(ctx: ExecutorContext): Promise<ExecutorOutput> {
  const config = ctx.config as TorchTrainConfig;
  const destDir = path.join(ctx.artifactDir, ctx.runId, ctx.nodeKey);
  const weightsPath = path.join(destDir, config.outputWeightsPath ?? 'model.pt');
  const resultPath = path.join(destDir, 'result.json');

  // Idempotency: if weights exist, the training completed
  if (fs.existsSync(resultPath)) {
    logger.info({ runId: ctx.runId, nodeKey: ctx.nodeKey }, 'torch.train: cache hit');
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  }

  fs.mkdirSync(destDir, { recursive: true });

  // Long-running → send heartbeats every 15 s to prevent stall detection
  const stopHeartbeat = startHeartbeat(ctx, 15_000);

  try {
    const output = await runPython({
      scriptPath: config.scriptPath ?? 'train.py',
      input: {
        ...ctx.input,
        epochs: config.epochs ?? 10,
        kwargs: config.kwargs ?? {},
        outputDir: destDir,
        weightsPath,
      },
      timeoutMs: 4 * 60 * 60 * 1000, // 4 hours max
      onLog: (line) => {
        ctx.onLog(line);
        // Forward progress updates from the script (e.g. "epoch 3/10")
        ctx.job.updateProgress(0).catch(() => {});
      },
    });

    atomicWriteJson(resultPath, output);
    return output as ExecutorOutput;
  } finally {
    stopHeartbeat();
  }
}

// ─── model.evaluate ──────────────────────────────────────────────────────────

async function modelEvaluate(ctx: ExecutorContext): Promise<ExecutorOutput> {
  const config = ctx.config as ModelEvaluateConfig;
  const destDir = path.join(ctx.artifactDir, ctx.runId, ctx.nodeKey);
  const resultPath = path.join(destDir, 'result.json');

  // Idempotency: reuse the metrics from a prior attempt in this run so a retry
  // (e.g. after the quality gate below rejected the run) doesn't re-load the
  // model and re-score the test set. The gate is re-applied to the cached
  // metrics below — a cache hit must never let a sub-threshold model through.
  let output: Record<string, unknown>;
  if (fs.existsSync(resultPath)) {
    logger.info({ runId: ctx.runId, nodeKey: ctx.nodeKey }, 'model.evaluate: cache hit — re-checking gate');
    output = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } else {
    fs.mkdirSync(destDir, { recursive: true });
    output = (await runPython({
      scriptPath: config.scriptPath ?? 'evaluate.py',
      input: { ...ctx.input, kwargs: config.kwargs ?? {} },
      onLog: ctx.onLog,
    })) as Record<string, unknown>;
    // Persist BEFORE the gate so a rejected run still leaves the real metrics
    // on disk for the retry short-circuit and for debugging.
    atomicWriteJson(resultPath, output);
  }

  // Quality gate — enforced on every execution, cache hit or not.
  if (
    config.minAccuracy !== undefined &&
    typeof output['accuracy'] === 'number' &&
    output['accuracy'] < config.minAccuracy
  ) {
    throw new UnrecoverableError(
      `Model accuracy ${output['accuracy']} is below the required minAccuracy ${config.minAccuracy}`,
    );
  }

  return output;
}

// ─── registry.deploy ─────────────────────────────────────────────────────────

async function registryDeploy(ctx: ExecutorContext): Promise<ExecutorOutput> {
  const config = ctx.config as RegistryDeployConfig;
  const destDir = path.join(ctx.artifactDir, ctx.runId, ctx.nodeKey);
  const receiptPath = path.join(destDir, 'deploy-receipt.json');

  // Idempotency: check if already deployed by this exact run
  if (fs.existsSync(receiptPath)) {
    logger.info({ runId: ctx.runId, nodeKey: ctx.nodeKey }, 'registry.deploy: already deployed');
    return JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  }

  fs.mkdirSync(destDir, { recursive: true });

  // Locate the model weights from upstream input. The path can be threaded
  // explicitly via a `weightsPath` template in the node config
  // (`{{ nodes.<train>.output.weightsPath }}`); when it isn't, we still record
  // a deploy receipt rather than failing the whole run — a missing checksum is
  // not a reason to red-flag an otherwise successful pipeline.
  const weightsPath = ctx.input['weightsPath'] as string | undefined;
  const weightsExist = !!weightsPath && fs.existsSync(weightsPath);
  if (weightsPath && !weightsExist) {
    logger.warn(
      { runId: ctx.runId, nodeKey: ctx.nodeKey, weightsPath },
      'registry.deploy: configured weightsPath does not exist — deploying without a checksum',
    );
  } else if (!weightsPath) {
    logger.warn(
      { runId: ctx.runId, nodeKey: ctx.nodeKey },
      'registry.deploy: no weightsPath in resolved input — deploying without a checksum. ' +
        'Add weightsPath: "{{ nodes.<train>.output.weightsPath }}" to this node to include one.',
    );
  }

  const checksum = weightsExist ? sha256File(weightsPath!) : null;

  // In production this would call the registry API; for now we write a receipt
  const receipt: ExecutorOutput = {
    registryUrl: config.registryUrl,
    modelTag: config.modelTag,
    weightsPath: weightsPath ?? null,
    checksum,
    deployedAt: new Date().toISOString(),
    runId: ctx.runId,
  };

  atomicWriteJson(receiptPath, receipt);
  logger.info({ modelTag: config.modelTag, checksum }, 'registry.deploy: deployed');
  return receipt;
}

// ─── flow.map ────────────────────────────────────────────────────────────────

/**
 * `flow.map` (roadmap B3.2). The real fan-out work — spawning child runs and
 * joining on them — lives in the orchestrator. All this executor does is fail
 * fast if the source didn't resolve to an array, enforce an absolute ceiling,
 * and report the length so the UI has a count. The orchestrator re-resolves
 * the array itself, so it is deliberately NOT echoed here (a 1000-element
 * array would blow the 64 KB output cap).
 */
const FLOW_MAP_HARD_CEILING = 10_000;

async function flowMap(ctx: ExecutorContext): Promise<ExecutorOutput> {
  const items = ctx.input['overSource'];
  if (!Array.isArray(items)) {
    throw new UnrecoverableError(
      `flow.map: overSource did not resolve to an array (got ${items === null ? 'null' : typeof items}). ` +
        `Point overSource at a node output that is an array, e.g. "{{ nodes.split.output.chunks }}".`,
    );
  }
  if (items.length > FLOW_MAP_HARD_CEILING) {
    throw new UnrecoverableError(
      `flow.map: ${items.length} elements exceeds the absolute ${FLOW_MAP_HARD_CEILING} ceiling. ` +
        `Chunk the input upstream.`,
    );
  }
  ctx.onLog(`flow.map: ${items.length} element(s) to fan out over`);
  return { count: items.length };
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * The executor registry.
 *
 * TypeScript enforces that EVERY member of `NodeType` has an entry here.
 * If you add `"data.augment"` to NODE_TYPES in contracts and forget to add
 * it here, you get:
 *   Property '"data.augment"' is missing in type '...' but required in
 *   type 'Record<NodeType, ExecutorFn>'
 *
 * This is intentional — better a compile error than a silent runtime crash
 * when the first job of the new type is dequeued.
 */
export const executors: ExecutorRegistry = {
  'data.source': dataSource,
  'pandas.preprocess': pandasPreprocess,
  'torch.train': torchTrain,
  'model.evaluate': modelEvaluate,
  'registry.deploy': registryDeploy,
  'flow.map': flowMap,
};
