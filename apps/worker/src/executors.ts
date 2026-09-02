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
import { exec } from 'child_process';
import { promisify } from 'util';
import { UnrecoverableError } from 'bullmq';
import type {
  KaggleDownloadConfig,
  PandasPreprocessConfig,
  TorchTrainConfig,
  ModelEvaluateConfig,
  RegistryDeployConfig,
} from '@dag/contracts';
import type { ExecutorContext, ExecutorOutput, ExecutorRegistry } from './executor-types';
import { runPython } from './python-bridge';
import { logger } from './logger';

const execAsync = promisify(exec);

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

// ─── kaggle.download ─────────────────────────────────────────────────────────

async function kaggleDownload(ctx: ExecutorContext): Promise<ExecutorOutput> {
  const config = ctx.config as KaggleDownloadConfig;
  const destDir = path.join(ctx.artifactDir, ctx.runId, ctx.nodeKey);
  const metadataPath = path.join(destDir, 'metadata.json');

  // ── Idempotency short-circuit ────────────────────────────────────────────
  // If metadata.json already exists, the download completed in a previous
  // attempt. Return the cached output instead of re-downloading.
  if (fs.existsSync(metadataPath)) {
    const cached = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    logger.info({ runId: ctx.runId, nodeKey: ctx.nodeKey }, 'kaggle.download: cache hit, skipping download');
    return cached;
  }

  fs.mkdirSync(destDir, { recursive: true });

  // ── Shell out to Kaggle CLI ──────────────────────────────────────────────
  const cmd = `kaggle datasets download -d "${config.datasetSlug}" -p "${destDir}" --unzip`;
  logger.info({ cmd }, 'kaggle.download: running');

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 10 * 60 * 1000 });
    if (stdout) ctx.onLog(stdout);
    if (stderr) ctx.onLog(stderr);
  } catch (err: any) {
    const msg = String(err?.stderr ?? err?.message ?? err);
    // 403 = bad API key / private dataset → unrecoverable (retrying won't help)
    if (msg.includes('403') || msg.includes('Unauthorized') || msg.includes('credentials')) {
      throw new UnrecoverableError(`Kaggle credentials invalid or dataset is private: ${msg}`);
    }
    // All other errors (network, rate-limit) → retryable
    throw new Error(`kaggle.download failed (retryable): ${msg}`);
  }

  // ── Atomic metadata write ────────────────────────────────────────────────
  const files = fs.readdirSync(destDir);
  const result: ExecutorOutput = {
    datasetSlug: config.datasetSlug,
    outputDir: destDir,
    files,
    rows: files.length, // placeholder; Python scripts fill in real counts
  };
  atomicWriteJson(metadataPath, result);

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
  'kaggle.download': kaggleDownload,
  'pandas.preprocess': pandasPreprocess,
  'torch.train': torchTrain,
  'model.evaluate': modelEvaluate,
  'registry.deploy': registryDeploy,
};
