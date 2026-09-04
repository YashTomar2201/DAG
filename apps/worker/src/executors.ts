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
import { UnrecoverableError } from 'bullmq';
import type {
  DataSourceConfig,
  PandasPreprocessConfig,
  TorchTrainConfig,
  ModelEvaluateConfig,
  RegistryDeployConfig,
  FlowReduceConfig,
} from '@dag/contracts';
import type { ExecutorContext, ExecutorOutput, ExecutorRegistry } from './executor-types';
import { runPython } from './python-bridge';
import { logger } from './logger';
import { joinKey, readJson, readText, writeJson, sha256, sha256OfPath, pathExists } from './artifact-store';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Every executor's outputs live under this key prefix (roadmap C1.1). */
function prefix(ctx: ExecutorContext): string {
  return joinKey(ctx.runId, ctx.nodeKey);
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
  const raw = ctx.config as DataSourceConfig;
  // Prefer the resolved input: `csvPath` / `url` may be `{{ nodes.X.output.Y }}`
  // template refs, which the control plane substitutes into `ctx.input` — the
  // raw `ctx.config` still holds the un-substituted template.
  const config: DataSourceConfig = {
    csvPath: (ctx.input['csvPath'] as string | undefined) ?? raw.csvPath,
    url: (ctx.input['url'] as string | undefined) ?? raw.url,
  };
  const key = prefix(ctx);
  const csvKey = joinKey(key, 'data.csv');
  const resultKey = joinKey(key, 'result.json');

  // Idempotency: a prior attempt in this run already fetched + validated it.
  if (await ctx.store.exists(resultKey)) {
    logger.info({ runId: ctx.runId, nodeKey: ctx.nodeKey }, 'data.source: cache hit');
    return readJson(ctx.store, resultKey);
  }

  const destDir = await ctx.store.localPath(key);

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
    const onCancel = () => ac.abort();
    ctx.signal.addEventListener('abort', onCancel, { once: true }); // roadmap B4
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
      await ctx.store.put(csvKey, buf);
    } catch (err) {
      if (err instanceof UnrecoverableError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`data.source: fetch failed (retryable): ${msg}`);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onCancel);
    }
  } else {
    // A locally-configured or bundled CSV is an *external input*, not an
    // artifact this store manages — it lives on the worker's own disk (the
    // repo image or an operator-mounted path), so this is the one place an
    // executor still touches `fs` directly. It gets read into a buffer and
    // handed to `store.put()` immediately, so from here on it's a normal
    // store-managed artifact like the URL branch above.
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
    await ctx.store.put(csvKey, fs.readFileSync(src));
  }

  // ── Validate it parses as CSV ────────────────────────────────────────────
  const text = await readText(ctx.store, csvKey);
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
    csvPath: await ctx.store.localPath(csvKey),
    rows,
    columns,
    bytes: Buffer.byteLength(text, 'utf8'),
    checksum: await sha256(ctx.store, csvKey),
    sourceType,
    source,
    outputDir: destDir,
  };
  ctx.onLog(`[data.source] ${sourceType}: ${rows} rows x ${columns.length} cols`);
  await writeJson(ctx.store, resultKey, result);
  return result;
}

// ─── pandas.preprocess ───────────────────────────────────────────────────────

async function pandasPreprocess(ctx: ExecutorContext): Promise<ExecutorOutput> {
  const config = ctx.config as PandasPreprocessConfig;
  const key = prefix(ctx);
  const resultKey = joinKey(key, 'result.json');

  // Idempotency: if a previous run already wrote result.json, reuse it
  if (await ctx.store.exists(resultKey)) {
    logger.info({ runId: ctx.runId, nodeKey: ctx.nodeKey }, 'pandas.preprocess: cache hit');
    return readJson(ctx.store, resultKey);
  }

  const destDir = await ctx.store.localPath(key);

  const output = await runPython({
    scriptPath: config.scriptPath ?? 'preprocess.py',
    input: {
      ...ctx.input,
      kwargs: config.kwargs ?? {},
      outputDir: destDir,
    },
    signal: ctx.signal,
    onLog: ctx.onLog,
  });

  await writeJson(ctx.store, resultKey, output);
  return output as ExecutorOutput;
}

// ─── torch.train ─────────────────────────────────────────────────────────────

async function torchTrain(ctx: ExecutorContext): Promise<ExecutorOutput> {
  const config = ctx.config as TorchTrainConfig;
  const key = prefix(ctx);
  const resultKey = joinKey(key, 'result.json');

  // Idempotency: if weights exist, the training completed
  if (await ctx.store.exists(resultKey)) {
    logger.info({ runId: ctx.runId, nodeKey: ctx.nodeKey }, 'torch.train: cache hit');
    return readJson(ctx.store, resultKey);
  }

  const destDir = await ctx.store.localPath(key);
  const weightsPath = path.join(destDir, config.outputWeightsPath ?? 'model.pt');

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
      signal: ctx.signal,
      timeoutMs: 4 * 60 * 60 * 1000, // 4 hours max
      onLog: (line) => {
        ctx.onLog(line);
        // Forward progress updates from the script (e.g. "epoch 3/10")
        ctx.job.updateProgress(0).catch(() => {});
      },
    });

    await writeJson(ctx.store, resultKey, output);
    return output as ExecutorOutput;
  } finally {
    stopHeartbeat();
  }
}

// ─── model.evaluate ──────────────────────────────────────────────────────────

async function modelEvaluate(ctx: ExecutorContext): Promise<ExecutorOutput> {
  const config = ctx.config as ModelEvaluateConfig;
  const key = prefix(ctx);
  const resultKey = joinKey(key, 'result.json');

  // Idempotency: reuse the metrics from a prior attempt in this run so a retry
  // (e.g. after the quality gate below rejected the run) doesn't re-load the
  // model and re-score the test set. The gate is re-applied to the cached
  // metrics below — a cache hit must never let a sub-threshold model through.
  let output: Record<string, unknown>;
  if (await ctx.store.exists(resultKey)) {
    logger.info({ runId: ctx.runId, nodeKey: ctx.nodeKey }, 'model.evaluate: cache hit — re-checking gate');
    output = await readJson(ctx.store, resultKey);
  } else {
    output = (await runPython({
      scriptPath: config.scriptPath ?? 'evaluate.py',
      input: { ...ctx.input, kwargs: config.kwargs ?? {} },
      signal: ctx.signal,
      onLog: ctx.onLog,
    })) as Record<string, unknown>;
    // Persist BEFORE the gate so a rejected run still leaves the real metrics
    // on disk for the retry short-circuit and for debugging.
    await writeJson(ctx.store, resultKey, output);
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
  const receiptKey = joinKey(prefix(ctx), 'deploy-receipt.json');

  // Idempotency: check if already deployed by this exact run
  if (await ctx.store.exists(receiptKey)) {
    logger.info({ runId: ctx.runId, nodeKey: ctx.nodeKey }, 'registry.deploy: already deployed');
    return readJson(ctx.store, receiptKey);
  }

  // Locate the model weights from upstream input. The path can be threaded
  // explicitly via a `weightsPath` template in the node config
  // (`{{ nodes.<train>.output.weightsPath }}`); when it isn't, we still record
  // a deploy receipt rather than failing the whole run — a missing checksum is
  // not a reason to red-flag an otherwise successful pipeline.
  const weightsPath = ctx.input['weightsPath'] as string | undefined;
  const weightsExist = !!weightsPath && (await pathExists(weightsPath));
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

  const checksum = weightsExist ? await sha256OfPath(weightsPath!) : null;

  // In production this would call the registry API; for now we write a receipt
  const receipt: ExecutorOutput = {
    registryUrl: config.registryUrl,
    modelTag: config.modelTag,
    weightsPath: weightsPath ?? null,
    checksum,
    deployedAt: new Date().toISOString(),
    runId: ctx.runId,
  };

  await writeJson(ctx.store, receiptKey, receipt);
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
  const raw = ctx.input['overSource'];
  let items: unknown[] | null = Array.isArray(raw) ? raw : null;
  if (!items && typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      /* not a JSON array literal */
    }
  }
  if (!items) {
    throw new UnrecoverableError(
      `flow.map: overSource did not resolve to an array (got ${raw === null ? 'null' : typeof raw}). ` +
        `Point overSource at a node output that is an array, e.g. "{{ nodes.split.output.chunks }}", ` +
        `or give it a JSON array literal.`,
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

// ─── flow.reduce ─────────────────────────────────────────────────────────────

/** Walk a dot-path into a value; returns undefined if any segment is missing. */
function dotGet(value: unknown, dotPath: string | undefined): unknown {
  if (!dotPath) return value;
  let cur: unknown = value;
  for (const seg of dotPath.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

/**
 * `flow.reduce` (roadmap B3.3). Reads the ordered results file the orchestrator
 * wrote at the fan-out join and folds it: `concat` flattens into one array
 * (written back by reference, never inline), `sum`/`mean` aggregate a numeric
 * `field` (dot-path) across the elements.
 */
async function flowReduce(ctx: ExecutorContext): Promise<ExecutorOutput> {
  const config = ctx.config as FlowReduceConfig;
  const resultsPath = ctx.input['over'];
  if (typeof resultsPath !== 'string') {
    throw new UnrecoverableError(
      `flow.reduce: "over" did not resolve to a results-file path (got ${typeof resultsPath}). ` +
        `Set it to "{{ nodes.<map>.output.resultsPath }}".`,
    );
  }
  // The orchestrator (apps/api) wrote this file directly under the same
  // shared ARTIFACT_DIR root at the fan-out join — recover it as a store key
  // rather than touching `fs`, so it goes through the same idempotency/read
  // path as everything else here.
  const resultsKey = path.relative(ctx.artifactDir, resultsPath).split(path.sep).join('/');
  if (!(await ctx.store.exists(resultsKey))) {
    throw new UnrecoverableError(`flow.reduce: results file not found at ${resultsPath}`);
  }
  const elements = await readJson<unknown[]>(ctx.store, resultsKey);
  ctx.onLog(`flow.reduce(${config.mode}): folding ${elements.length} element(s)`);

  if (config.mode === 'concat') {
    const flat = elements.flatMap((el) => (Array.isArray(el) ? el : [el]));
    const outKey = joinKey(prefix(ctx), 'reduced.json');
    await writeJson(ctx.store, outKey, flat);
    return { mode: 'concat', count: flat.length, resultsPath: await ctx.store.localPath(outKey) };
  }

  const nums: number[] = [];
  for (const el of elements) {
    const n = asNumber(dotGet(el, config.field));
    if (n !== undefined) nums.push(n);
  }
  if (nums.length === 0) {
    throw new UnrecoverableError(
      `flow.reduce(${config.mode}): found no numeric values` +
        (config.field ? ` at field "${config.field}"` : '') +
        ` across ${elements.length} element(s).`,
    );
  }
  const sum = nums.reduce((a, b) => a + b, 0);
  const value = config.mode === 'sum' ? sum : sum / nums.length;
  return { mode: config.mode, field: config.field ?? null, value, count: nums.length };
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
  'flow.reduce': flowReduce,
};
