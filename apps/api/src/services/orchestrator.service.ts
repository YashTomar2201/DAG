import * as fs from 'fs';
import * as path from 'path';
import {
  prisma,
  createRun,
  tryTransitionRun,
  tryTransitionNodeRun,
  findNodeRun,
  getNodeRunMap,
  allNodeRunsTerminal,
  appendRunEvent,
  createFanOutChildRun,
  countNonTerminalChildren,
  getRunTreeInfo,
  getChildRunSummary,
  getFanOutChildOutputs,
} from '@dag/db';
import type { Prisma, WorkflowVersion } from '@dag/db';
import {
  seedInDegrees,
  decrementInDegree,
  markParentActive,
  hasActiveParent,
  claimFanOutJoin,
  clearFanOutJoinClaim,
  clearDispatched,
  queueForType,
  createJobId,
  publishRunEvent,
} from '@dag/queue';
import { logger } from '../logger';
import { NotFoundError } from '../errors';
import { cancelChildRunsOf } from './cancel.service';
import type { Graph, NodeDef, NodeType, RunEventType, FlowMapConfig } from '@dag/contracts';
import type { NodeRun } from '@dag/db';
import {
  resolveNodeInputs,
  assertOutputSize,
  OutputTooLargeError,
  UnresolvedTemplateError,
} from '../context-resolver';
import { evaluateCondition, ConditionTypeError } from '../condition-evaluator';
import { nodeDurationSeconds } from '../metrics';

/**
 * Observes how long a NodeRun spent RUNNING before reaching a terminal
 * state. Called from both onNodeSucceeded and onNodeFailed — see
 * metrics.ts's dag_node_duration_seconds for why this must be observed at
 * transition time rather than derived later from a scrape-time query.
 */
function observeNodeDuration(startedAt: Date | null, nodeType: string, outcome: 'succeeded' | 'failed') {
  if (!startedAt) return; // defensive — should never happen for a node that reached RUNNING
  const seconds = (Date.now() - startedAt.getTime()) / 1000;
  nodeDurationSeconds.observe({ nodeType, outcome }, seconds);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getGraphFromVersion(version: WorkflowVersion): Graph {
  // Prisma Json types are tricky; safely cast it back to the Graph contract
  return version.graph as unknown as Graph;
}

function getNodeFromGraph(graph: Graph, nodeKey: string): NodeDef {
  const node = graph.nodes.find((n) => n.key === nodeKey);
  if (!node) throw new Error(`Node ${nodeKey} not found in graph`);
  return node;
}

function getChildren(graph: Graph, nodeKey: string): string[] {
  return graph.edges.filter((e) => e.from === nodeKey).map((e) => e.to);
}

// ─── Fan-out helpers (roadmap B3.2) ──────────────────────────────────────────

const DEFAULT_MAX_FAN_OUT = 1000;

/** Shared artifact volume — same path the workers mount. Read directly (like
 *  packages/queue reads REDIS_URL) so a missing var can't `process.exit` here. */
const ARTIFACT_DIR = process.env['ARTIFACT_DIR'] || './artifacts';

/** Subgraph nodes with no outgoing edge to another subgraph node (the leaves). */
function subgraphSinkKeys(graph: Graph, subgraphKeys: string[]): string[] {
  const set = new Set(subgraphKeys);
  const hasSubOut = new Set(
    graph.edges.filter((e) => set.has(e.from) && set.has(e.to)).map((e) => e.from),
  );
  return subgraphKeys.filter((k) => !hasSubOut.has(k));
}

/** The subgraph-internal edges and its root keys (no in-subgraph parent). */
function subgraphExecPlan(
  graph: Graph,
  subgraphKeys: string[],
): { subEdges: Graph['edges']; roots: string[] } {
  const set = new Set(subgraphKeys);
  const subEdges = graph.edges.filter((e) => set.has(e.from) && set.has(e.to));
  const hasParent = new Set(subEdges.map((e) => e.to));
  return { subEdges, roots: subgraphKeys.filter((k) => !hasParent.has(k)) };
}

/**
 * Node keys that belong to some `flow.map` node's `subgraph`. These run ONLY
 * inside child runs — the parent run gets no NodeRun for them, and its
 * in-degree seeding ignores every edge that touches one. Otherwise a subgraph
 * node would sit PENDING in the parent forever and the parent run could never
 * reach a terminal state.
 */
function fanOutSubgraphKeys(graph: Graph): Set<string> {
  const keys = new Set<string>();
  for (const n of graph.nodes) {
    if (n.type === 'flow.map') {
      for (const k of (n.config as FlowMapConfig).subgraph ?? []) keys.add(k);
    }
  }
  return keys;
}

/**
 * Resolves a `flow.map` `overSource` to an array: either a template that
 * resolved to an array, or a literal JSON array string (handy for small static
 * fan-outs and test fixtures). Returns null if it is neither.
 */
function asFanOutArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* not JSON — fall through */
    }
  }
  return null;
}

/** `${parentRunId}:${mapNodeKey}:${index}` → its parts. Node keys can't contain ':'. */
function parseFanOutIdemKey(
  key: string | null,
): { parentRunId: string; mapNodeKey: string; index: number } | null {
  if (!key) return null;
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const index = Number(parts[2]);
  if (!Number.isInteger(index)) return null;
  return { parentRunId: parts[0]!, mapNodeKey: parts[1]!, index };
}

function emitAndLog(runId: string, type: RunEventType, payload: Record<string, unknown>, nodeKey?: string) {
  // 1. Fire and forget the Redis pub/sub for real-time UI
  publishRunEvent(runId, { runId, nodeKey, type, payload, ts: Date.now() })
    .catch((err: unknown) => logger.error({ err, runId }, 'Failed to publish event to redis'));
  
  // 2. Persist to Postgres audit log
  appendRunEvent(runId, type, payload as Prisma.InputJsonValue, nodeKey)
    .catch((err: unknown) => logger.error({ err, runId }, 'Failed to append event to DB'));
}

// (Phase 7 context resolver is in context-resolver.ts)

// ─── Start Run ────────────────────────────────────────────────────────────────

export async function startRun(
  workflowVersionId: string,
  idempotencyKey?: string,
  opts: { triggeredBy?: string; tenantId?: string } = {},
) {
  const version = await prisma.workflowVersion.findUnique({
    where: { id: workflowVersionId },
    include: { workflow: { select: { tenantId: true } } },
  });
  if (!version) throw new NotFoundError('WorkflowVersion', workflowVersionId);
  // Roadmap A3: `POST /runs` passes `tenantId` (the caller's verified
  // identity) so an authenticated caller can't start a run against a
  // workflowVersionId belonging to another tenant just by knowing its id.
  // `opts.tenantId` is omitted by internal callers (schedule/trigger fire
  // handlers) that already resolved this exact versionId through a
  // tenant-scoped lookup (`getLatestVersionId(workflowId, tenantId)`) before
  // ever reaching here — re-checking would be redundant, not unsafe to skip.
  if (opts.tenantId && version.workflow.tenantId !== opts.tenantId) {
    throw new NotFoundError('WorkflowVersion', workflowVersionId);
  }

  const graph = getGraphFromVersion(version);

  // Nodes that live inside a `flow.map` subgraph run only in child runs — the
  // parent run gets no NodeRun for them and ignores their edges (B3.2).
  const subgraphKeys = fanOutSubgraphKeys(graph);
  const controlNodes = graph.nodes.filter((n) => !subgraphKeys.has(n.key));
  const controlEdges = graph.edges.filter(
    (e) => !subgraphKeys.has(e.from) && !subgraphKeys.has(e.to),
  );
  const nodeKeys = controlNodes.map((n) => n.key);

  // 1. Create Run + NodeRuns (idempotent). `triggeredBy` records the origin:
  //    'api' (a POST /runs), 'schedule', 'webhook', or 'fanout' (a child run).
  const run = await createRun(
    workflowVersionId,
    opts.triggeredBy ?? 'api',
    nodeKeys,
    idempotencyKey,
  );
  
  // If the run was already started (idempotency hit), we don't re-seed
  if (run.status !== 'PENDING') {
    return run;
  }

  // Transition to RUNNING
  const startedAt = new Date();
  const transitioned = await tryTransitionRun(run.id, 'PENDING', 'RUNNING', { startedAt });
  if (!transitioned) return run; // someone else started it

  // `run` was captured from `createRun`, BEFORE the transition above — its
  // in-memory `.status` is still 'PENDING' even though the row is now
  // RUNNING in Postgres. Patch the object we return so callers (the
  // POST /runs route, tests, anything reading the return value) see the
  // state that actually landed, not a stale snapshot from before this
  // function did its job.
  run.status = 'RUNNING';
  run.startedAt = startedAt;

  logger.info({ runId: run.id }, 'Run started');
  emitAndLog(run.id, 'RUN_STARTED', { startedAt: new Date() });

  // 2. Seed in-degrees in Redis (control edges only)
  await seedInDegrees(run.id, controlEdges);

  // 3. Find initial ready set (in-degree 0) and dispatch
  const inDegreeCounts = new Map<string, number>();
  for (const edge of controlEdges) {
    inDegreeCounts.set(edge.to, (inDegreeCounts.get(edge.to) || 0) + 1);
  }

  const initialNodes = controlNodes.filter((n) => !inDegreeCounts.has(n.key));

  for (const node of initialNodes) {
    await dispatchNode(run.id, node.key, graph, version.id);
  }

  return run;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

export async function dispatchNode(
  runId: string,
  nodeKey: string,
  graph?: Graph,
  _versionId?: string
) {
  // 1. tryTransitionNodeRun(PENDING → QUEUED)
  const nr = await findNodeRun(runId, nodeKey);
  if (!nr) return; // shouldn't happen unless DB corrupted
  
  // We check `tryTransitionNodeRun` *before* enqueueing. If it returns false,
  // another actor (like a concurrent API process) already dispatched it.
  const claimed = await tryTransitionNodeRun(nr.id, 'PENDING', 'QUEUED');
  if (!claimed) return; // Lost the race, do nothing

  // Load graph if not provided (needed when dispatching from completion handler)
  if (!graph) {
    const run = await prisma.run.findUnique({ where: { id: runId }, select: { workflowVersionId: true } });
    const version = await prisma.workflowVersion.findUnique({ where: { id: run!.workflowVersionId } });
    if (!version) throw new NotFoundError('WorkflowVersion', run!.workflowVersionId);
    graph = getGraphFromVersion(version);
  }

  const node = getNodeFromGraph(graph, nodeKey);
  
  // Phase 7: Resolve templates in node input config against completed parent outputs
  const nodeRunMap = await getNodeRunMap(runId);
  const resolvedInput = resolveNodeInputs(graph, nodeKey, nodeRunMap);

  // Persist resolved inputs on the row before enqueuing
  await prisma.nodeRun.update({
    where: { id: nr.id },
    // Prisma's Json field expects InputJsonValue — cast through unknown, the
    // same pattern packages/db/src/repositories.ts uses for graph/topoOrder.
    data: { input: resolvedInput as unknown as Prisma.InputJsonValue },
  });

  // 2. Queue the job
  const jobId = createJobId(runId, nodeKey, nr.attempt);
  const queue = queueForType(node.type as NodeType);

  // Per-node retry policy (roadmap B5). `attempts` and the base `delay` go into
  // the BullMQ job options; `cap` rides the payload because the custom backoff
  // strategy can only read `job.data`, not the full opts.
  const rp = node.retryPolicy;
  const attempts = rp?.attempts ?? 3;
  const baseDelay = rp?.baseDelay ?? 2000;
  const cap = rp?.cap ?? 30_000;

  const payload = {
    runId,
    nodeKey,
    nodeRunId: nr.id,
    type: node.type as NodeType,
    config: node.config,
    input: resolvedInput,
    attempt: nr.attempt,
    retryCap: cap,
  };

  // 3. Add to BullMQ
  await queue.add(node.type, payload, {
    jobId,
    attempts,
    backoff: { type: 'exponentialJitter', delay: baseDelay },
  });

  logger.info({ runId, nodeKey, jobId, queue: queue.name, attempts, baseDelay, cap }, 'Dispatched node');
  emitAndLog(runId, 'NODE_QUEUED', { jobId, attempts }, nodeKey);
}

// ─── Completion Handlers ──────────────────────────────────────────────────────

export async function onNodeSucceeded(runId: string, nodeKey: string, output: unknown) {
  const nr = await findNodeRun(runId, nodeKey);
  if (!nr || nr.status !== 'RUNNING') return; // Might have been already completed or cancelled

  // Phase 7: Validate output size before persisting.
  // A worker returning a 2 GB tensor inline would bloat Postgres and Redis.
  try {
    assertOutputSize(nodeKey, output);
  } catch (err) {
    if (err instanceof OutputTooLargeError) {
      logger.error({ runId, nodeKey, err }, 'Node output too large — failing run');
      await onNodeFailed(runId, nodeKey, { message: err.message, taxonomy: 'unrecoverable' });
      return;
    }
    throw err;
  }

  // 1. Persist output and transition
  const success = await tryTransitionNodeRun(nr.id, 'RUNNING', 'SUCCEEDED', {
    output: output as Prisma.InputJsonValue,
    finishedAt: new Date(),
  });
  
  if (!success) return; // Lost update race

  logger.info({ runId, nodeKey }, 'Node succeeded');
  emitAndLog(runId, 'NODE_SUCCEEDED', { output }, nodeKey);

  // Load graph to find children
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { workflowVersionId: true } });
  const version = await prisma.workflowVersion.findUnique({ where: { id: run!.workflowVersionId } });
  if (!version) return;
  const graph = getGraphFromVersion(version);
  observeNodeDuration(nr.startedAt, getNodeFromGraph(graph, nodeKey).type, 'succeeded');

  // 2. Propagate. A `flow.map` node spawns child runs instead of propagating to
  //    its downstream node (that decrement is deferred to the fan-out join);
  //    every other node type propagates normally.
  try {
    const nodeRunMap = await getNodeRunMap(runId); // includes this node's just-persisted output
    if (getNodeFromGraph(graph, nodeKey).type === 'flow.map') {
      await spawnFanOut(runId, nodeKey, graph, version.id, nodeRunMap);
    } else {
      await propagateToChildren(runId, nodeKey, graph, version.id, nodeRunMap, /* parentActive */ true);
    }
  } catch (err) {
    if (err instanceof UnresolvedTemplateError || err instanceof ConditionTypeError) {
      logger.error({ runId, nodeKey, err: err.message }, 'Condition evaluation failed — aborting run');
      await abortRun(runId, err.message);
      return;
    }
    throw err;
  }

  // 4. Check if the entire run is complete
  if (await allNodeRunsTerminal(runId)) {
    const completed = await tryTransitionRun(runId, 'RUNNING', 'SUCCEEDED', { finishedAt: new Date() });
    if (completed) {
      logger.info({ runId }, 'Run succeeded');
      emitAndLog(runId, 'RUN_SUCCEEDED', { finishedAt: new Date() });
    }
  }

  // 5. If this is a fan-out child that just went terminal, maybe fire the join.
  await onFanOutChildTerminal(runId);
}

export interface NodeFailure {
  message: string;
  taxonomy?: 'retryable' | 'unrecoverable';
}

export async function onNodeFailed(runId: string, nodeKey: string, error: NodeFailure) {
  const nr = await findNodeRun(runId, nodeKey);
  if (!nr || nr.status !== 'RUNNING') return;

  // The worker stamps a `{ message, taxonomy, attempt, maxAttempts }` error on
  // the row before it throws (B5). Prefer that over the bare `failedReason`
  // string the BullMQ `failed` event carries.
  const stamped = nr.error as { taxonomy?: string } | null;
  const finalError = stamped?.taxonomy ? stamped : { ...error };

  const success = await tryTransitionNodeRun(nr.id, 'RUNNING', 'FAILED', {
    error: finalError as unknown as Prisma.InputJsonValue,
    finishedAt: new Date(),
  });

  if (!success) return;

  logger.error({ runId, nodeKey, error: finalError }, 'Node failed');
  emitAndLog(runId, 'NODE_FAILED', { error: finalError }, nodeKey);

  // BFS all descendants to SKIPPED
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { workflowVersionId: true } });
  const version = await prisma.workflowVersion.findUnique({ where: { id: run!.workflowVersionId } });
  if (!version) return;

  const graph = getGraphFromVersion(version);
  observeNodeDuration(nr.startedAt, getNodeFromGraph(graph, nodeKey).type, 'failed');

  // BFS queue
  const queue = [nodeKey];
  const visited = new Set<string>();
  const toSkip = new Set<string>();

  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (visited.has(curr)) continue;
    visited.add(curr);

    const children = getChildren(graph, curr);
    for (const child of children) {
      if (!toSkip.has(child)) {
        toSkip.add(child);
        queue.push(child);
      }
    }
  }

  // Transition all descendants to SKIPPED
  for (const skipKey of toSkip) {
    const childNr = await findNodeRun(runId, skipKey);
    if (childNr && ['PENDING', 'QUEUED'].includes(childNr.status)) {
      await tryTransitionNodeRun(childNr.id, childNr.status, 'SKIPPED', { finishedAt: new Date() });
      emitAndLog(runId, 'NODE_SKIPPED', { reason: `Ancestor ${nodeKey} failed` }, skipKey);
    }
  }

  // Run -> FAILED
  if (await allNodeRunsTerminal(runId)) {
    const failed = await tryTransitionRun(runId, 'RUNNING', 'FAILED', { finishedAt: new Date() });
    if (failed) {
      logger.info({ runId }, 'Run failed');
      emitAndLog(runId, 'RUN_FAILED', { finishedAt: new Date(), reason: `Node ${nodeKey} failed` });
    }
  }

  // A failed fan-out child still counts toward the join (B3.2 joins on a
  // summary; B3.4 adds the fail-fast policy).
  await onFanOutChildTerminal(runId);
}

// ─── Dynamic fan-out — spawn & join (roadmap B3.2) ───────────────────────────

/**
 * Called from `onNodeSucceeded` when a `flow.map` node completes. Resolves the
 * `overSource` array, then for each element `i` creates a child run of the
 * node's `subgraph` with the element seeded as
 * `{{ nodes.<mapNodeKey>.output.item }}`. The downstream node's in-degree is
 * NOT touched here — that happens once, at `joinFanOut`, after every child is
 * terminal.
 *
 * Idempotency: each child's key is `${parentRunId}:${mapNodeKey}:${i}`, so a
 * crash mid-spawn that replays re-enters here and `createFanOutChildRun`
 * returns the already-created children untouched.
 */
export async function spawnFanOut(
  runId: string,
  mapNodeKey: string,
  graph: Graph,
  versionId: string,
  nodeRunMap: Map<string, NodeRun>,
): Promise<void> {
  const mapNode = getNodeFromGraph(graph, mapNodeKey);
  const config = mapNode.config as FlowMapConfig;

  // The executor only reported a count; re-resolve the array here (immutable
  // parent outputs make this deterministic, and it dodges the 64 KB output cap).
  const resolved = resolveNodeInputs(graph, mapNodeKey, nodeRunMap);
  const items = asFanOutArray(resolved['overSource']);
  if (!items) {
    await abortRun(runId, `flow.map "${mapNodeKey}": overSource did not resolve to an array`);
    return;
  }

  const maxFanOut = config.maxFanOut ?? DEFAULT_MAX_FAN_OUT;
  if (items.length > maxFanOut) {
    await abortRun(
      runId,
      `flow.map "${mapNodeKey}": fan-out of ${items.length} exceeds maxFanOut ${maxFanOut}`,
    );
    return;
  }

  const subgraphKeys = config.subgraph ?? [];
  const unknown = subgraphKeys.filter((k) => !graph.nodes.some((n) => n.key === k));
  if (unknown.length > 0) {
    await abortRun(runId, `flow.map "${mapNodeKey}": subgraph references unknown node(s) ${unknown.join(', ')}`);
    return;
  }
  if (subgraphKeys.includes(mapNodeKey)) {
    await abortRun(runId, `flow.map "${mapNodeKey}": subgraph cannot contain the map node itself`);
    return;
  }

  // Edges internal to the subgraph → child-run in-degrees.
  const { subEdges, roots } = subgraphExecPlan(graph, subgraphKeys);

  emitAndLog(runId, 'NODE_LOG', { line: `flow.map: fanning out over ${items.length} element(s)` }, mapNodeKey);
  emitAndLog(runId, 'RUN_SPAWNED', { mapNodeKey, total: items.length }, mapNodeKey);

  // Zero elements: nothing to run — join straight away with an empty summary.
  if (items.length === 0) {
    await joinFanOut(runId, mapNodeKey, graph, versionId);
    return;
  }

  for (let i = 0; i < items.length; i++) {
    // Fail-fast (B3.4) can abort the parent while we are still spawning — an
    // early child failure may already have run its course. Stop creating more
    // children into a run that is no longer RUNNING.
    const parentStatus = await prisma.run.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (parentStatus?.status !== 'RUNNING') {
      logger.info({ runId, mapNodeKey, spawned: i }, 'Fan-out spawn halted — parent no longer running');
      break;
    }

    const idempotencyKey = `${runId}:${mapNodeKey}:${i}`;
    const { run: child, created } = await createFanOutChildRun({
      workflowVersionId: versionId,
      parentRunId: runId,
      fanOutIndex: i,
      subgraphKeys,
      seedNodeKey: mapNodeKey,
      seedOutput: { item: items[i], index: i, count: items.length },
      idempotencyKey,
    });
    if (!created) continue; // replay — this child already exists (and may be running/done)

    await tryTransitionRun(child.id, 'PENDING', 'RUNNING', { startedAt: new Date() });
    await seedInDegrees(child.id, subEdges);
    for (const rootKey of roots) {
      await dispatchNode(child.id, rootKey, graph, versionId);
    }
  }

  // If a concurrent fail-fast aborted the parent while we spawned, a child
  // created in the race window between abortRun's cancel sweep and our loop's
  // status check can still be RUNNING — sweep it up.
  const finalStatus = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
  if (finalStatus?.status !== 'RUNNING') {
    await cancelChildRunsOf(runId);
    return;
  }

  // A replay after every child was already created still needs to check the
  // join — the crash may have happened after the last child finished.
  await maybeJoinAfterSpawn(runId, mapNodeKey, graph, versionId);
}

/** After a (possibly replayed) spawn, fire the join if every child is already terminal. */
async function maybeJoinAfterSpawn(
  parentRunId: string,
  mapNodeKey: string,
  graph: Graph,
  versionId: string,
): Promise<void> {
  const remaining = await countNonTerminalChildren(parentRunId);
  if (remaining === 0) {
    const total = (await getChildRunSummary(parentRunId)).total;
    if (total > 0) await joinFanOut(parentRunId, mapNodeKey, graph, versionId);
  }
}

/**
 * A fan-out child reached a terminal state. Two responsibilities (B3.4):
 *
 *   1. Failure policy — if this child FAILED and the number of failed children
 *      now exceeds the map node's `failureThreshold` (default 0 = fail-fast),
 *      cancel every still-running sibling and abort the parent run (which skips
 *      the downstream reduce node).
 *   2. Otherwise, fire the join once every sibling is terminal.
 */
async function onFanOutChildTerminal(childRunId: string): Promise<void> {
  const info = await getRunTreeInfo(childRunId);
  if (!info?.parentRunId) return;
  const parsed = parseFanOutIdemKey(info.idempotencyKey);
  if (!parsed) return;
  const { parentRunId, mapNodeKey } = parsed;

  const parent = await prisma.run.findUnique({
    where: { id: parentRunId },
    select: { workflowVersionId: true, status: true },
  });
  if (!parent || parent.status !== 'RUNNING') return; // parent already terminal — nothing to do
  const version = await prisma.workflowVersion.findUnique({ where: { id: parent.workflowVersionId } });
  if (!version) return;
  const graph = getGraphFromVersion(version);

  // Live progress for the UI (B3.5): one event per child reaching a terminal
  // state, carrying the running per-status totals.
  const summary = await getChildRunSummary(parentRunId);
  emitAndLog(
    parentRunId,
    'RUN_CHILD_COMPLETED',
    {
      mapNodeKey,
      childRunId,
      fanOutIndex: info.fanOutIndex,
      status: info.status,
      total: summary.total,
      succeeded: summary.succeeded,
      failed: summary.failed,
      cancelled: summary.cancelled,
    },
    mapNodeKey,
  );

  // 1. Failure policy.
  if (info.status === 'FAILED') {
    const config = getNodeFromGraph(graph, mapNodeKey).config as FlowMapConfig;
    const threshold = config.failureThreshold ?? 0;
    if (summary.failed > threshold) {
      logger.warn(
        { parentRunId, mapNodeKey, failed: summary.failed, threshold },
        'Fan-out failure threshold exceeded — cancelling siblings and failing the run',
      );
      emitAndLog(
        parentRunId,
        'NODE_LOG',
        { line: `flow.map: ${summary.failed} child run(s) failed (threshold ${threshold}) — aborting` },
        mapNodeKey,
      );
      // abortRun cancels the child-run subtree, skips the pending downstream
      // nodes, and fails the parent.
      await abortRun(
        parentRunId,
        `flow.map "${mapNodeKey}": ${summary.failed} child run(s) failed (threshold ${threshold})`,
      );
      return;
    }
  }

  // 2. Join once all siblings are terminal.
  if ((await countNonTerminalChildren(parentRunId)) > 0) return;
  await joinFanOut(parentRunId, mapNodeKey, graph, version.id);
}

/**
 * The join. Merges a `{ childCount, succeeded, failed }` summary onto the map
 * node's output, then propagates to the downstream node through the normal
 * atomic in-degree path — so it fires exactly once, after all children.
 */
async function joinFanOut(
  parentRunId: string,
  mapNodeKey: string,
  graph: Graph,
  versionId: string,
): Promise<void> {
  if (!(await claimFanOutJoin(parentRunId, mapNodeKey))) return; // another finisher won

  // A fail-fast abort (B3.4) can land between the claim and here; never resume
  // a run that is no longer RUNNING.
  const parentStatus = await prisma.run.findUnique({
    where: { id: parentRunId },
    select: { status: true },
  });
  if (parentStatus?.status !== 'RUNNING') {
    await clearFanOutJoinClaim(parentRunId, mapNodeKey);
    return;
  }

  const summary = await getChildRunSummary(parentRunId);

  // B3.3: if a `flow.reduce` node is downstream, collect every child's sink
  // output (ordered by fanOutIndex) into a results file on the artifact volume
  // and hand the reduce node its path. The array never touches the map node's
  // own output, so a 1000-child fan-out can't blow the 64 KB cap.
  const mergedOutput: Record<string, unknown> = {
    fanOut: {
      childCount: summary.total,
      succeeded: summary.succeeded,
      failed: summary.failed,
      cancelled: summary.cancelled,
    },
  };

  const hasReduceDownstream = getChildren(graph, mapNodeKey).some(
    (k) => getNodeFromGraph(graph, k).type === 'flow.reduce',
  );
  if (hasReduceDownstream) {
    const mapConfig = getNodeFromGraph(graph, mapNodeKey).config as FlowMapConfig;
    const sinks = subgraphSinkKeys(graph, mapConfig.subgraph ?? []);
    const rows = await getFanOutChildOutputs(parentRunId, sinks);
    const elements = rows.map((r) => r.element); // ordered by fanOutIndex, null for a failed child

    const resultsPath = path.join(ARTIFACT_DIR, parentRunId, mapNodeKey, 'results.json');
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    fs.writeFileSync(`${resultsPath}.tmp`, JSON.stringify(elements));
    fs.renameSync(`${resultsPath}.tmp`, resultsPath);

    mergedOutput['resultsPath'] = resultsPath;
    mergedOutput['resultsCount'] = elements.length;
  }

  const mapNr = await findNodeRun(parentRunId, mapNodeKey);
  if (mapNr) {
    const prev = (mapNr.output ?? {}) as Record<string, unknown>;
    await prisma.nodeRun.update({
      where: { id: mapNr.id },
      data: { output: { ...prev, ...mergedOutput } as unknown as Prisma.InputJsonValue },
    });
  }

  emitAndLog(
    parentRunId,
    'NODE_LOG',
    { line: `flow.map: joined — ${summary.succeeded}/${summary.total} child run(s) succeeded` },
    mapNodeKey,
  );

  try {
    const nodeRunMap = await getNodeRunMap(parentRunId); // now carries the merged fanOut summary
    await propagateToChildren(parentRunId, mapNodeKey, graph, versionId, nodeRunMap, /* parentActive */ true);
  } catch (err) {
    if (err instanceof UnresolvedTemplateError || err instanceof ConditionTypeError) {
      await abortRun(parentRunId, err.message);
      return;
    }
    throw err;
  }

  if (await allNodeRunsTerminal(parentRunId)) {
    const done = await tryTransitionRun(parentRunId, 'RUNNING', 'SUCCEEDED', { finishedAt: new Date() });
    if (done) {
      logger.info({ runId: parentRunId }, 'Run succeeded');
      emitAndLog(parentRunId, 'RUN_SUCCEEDED', { finishedAt: new Date() });
    }
  }
}

/**
 * Re-spawns ONLY the FAILED / CANCELLED child runs of each `flow.map` node in a
 * run (roadmap B3.4). Called by `retryFailedNodesService` after it has reset the
 * parent's own FAILED / SKIPPED nodes and flipped the run back to RUNNING.
 *
 * Each bad child is reset in place — its subgraph NodeRuns go back to PENDING
 * (attempt++), the pre-SUCCEEDED map-seed NodeRun is left untouched, its Redis
 * dispatch state is cleared and in-degrees re-seeded, and its roots are
 * re-dispatched. The map node's join claim is released so the join fires again
 * once every child (old survivors + retried ones) is terminal.
 */
export async function retryFanOutChildren(parentRunId: string, versionId: string): Promise<number> {
  const version = await prisma.workflowVersion.findUnique({ where: { id: versionId } });
  if (!version) return 0;
  const graph = getGraphFromVersion(version);
  const mapNodes = graph.nodes.filter((n) => n.type === 'flow.map');
  if (mapNodes.length === 0) return 0;

  let respawned = 0;
  for (const mapNode of mapNodes) {
    const subgraphKeys = (mapNode.config as FlowMapConfig).subgraph ?? [];
    const { subEdges, roots } = subgraphExecPlan(graph, subgraphKeys);

    const badChildren = await prisma.run.findMany({
      where: {
        parentRunId,
        idempotencyKey: { startsWith: `${parentRunId}:${mapNode.key}:` },
        status: { in: ['FAILED', 'CANCELLED'] },
      },
      select: { id: true },
    });
    if (badChildren.length === 0) continue;

    for (const child of badChildren) {
      const nrs = await prisma.nodeRun.findMany({
        where: { runId: child.id, nodeKey: { in: subgraphKeys } },
        select: { id: true, attempt: true },
      });
      for (const nr of nrs) {
        await prisma.nodeRun.update({
          where: { id: nr.id },
          data: {
            status: 'PENDING',
            attempt: nr.attempt + 1,
            error: undefined,
            startedAt: null,
            finishedAt: null,
          },
        });
      }
      await prisma.run.update({
        where: { id: child.id },
        data: { status: 'RUNNING', startedAt: new Date(), finishedAt: null },
      });
      await clearDispatched(child.id);
      await seedInDegrees(child.id, subEdges);
      for (const rootKey of roots) {
        try {
          await dispatchNode(child.id, rootKey, graph, versionId);
        } catch (err) {
          logger.error({ childRunId: child.id, rootKey, err }, 'retry: fan-out child root dispatch failed');
        }
      }
      respawned += 1;
    }

    await clearFanOutJoinClaim(parentRunId, mapNode.key);
  }

  if (respawned > 0) logger.info({ parentRunId, respawned }, 'Re-spawned failed fan-out children');
  return respawned;
}

// ─── Conditional-edge propagation (B1.1) ──────────────────────────────────────

/**
 * Walks the outgoing edges of `parentKey` after it reached a terminal state.
 *
 * For each edge:
 *   - the edge is "active" iff `parentActive` AND (no condition OR it passes);
 *   - an active edge marks `parentKey` as an active parent of the child (Redis);
 *   - the child's in-degree is decremented **regardless** (a skipped branch
 *     must never leave the subgraph hanging);
 *   - when the child's in-degree hits zero, it is dispatched if it has any
 *     active parent, otherwise SKIPPED (which recurses through here with
 *     `parentActive = false`).
 *
 * Cycle-free graphs guarantee this recursion terminates.
 */
async function propagateToChildren(
  runId: string,
  parentKey: string,
  graph: Graph,
  versionId: string,
  nodeRunMap: Map<string, NodeRun>,
  parentActive: boolean,
): Promise<void> {
  for (const childKey of getChildren(graph, parentKey)) {
    const edge = graph.edges.find((e) => e.from === parentKey && e.to === childKey);
    const edgeActive =
      parentActive && (!edge?.condition || evaluateCondition(edge.condition, nodeRunMap, parentKey));

    if (edgeActive) await markParentActive(runId, childKey, parentKey);

    const ready = await decrementInDegree(runId, childKey);
    if (!ready) continue;

    if (await hasActiveParent(runId, childKey)) {
      await dispatchNode(runId, childKey, graph, versionId);
    } else {
      await skipNode(runId, childKey, graph, versionId, nodeRunMap);
    }
  }
}

/** Marks one node SKIPPED (no active branch reached it) and cascades downstream. */
async function skipNode(
  runId: string,
  nodeKey: string,
  graph: Graph,
  versionId: string,
  nodeRunMap: Map<string, NodeRun>,
): Promise<void> {
  const nr = await findNodeRun(runId, nodeKey);
  if (!nr || !['PENDING', 'QUEUED'].includes(nr.status)) return;

  const ok = await tryTransitionNodeRun(nr.id, nr.status, 'SKIPPED', { finishedAt: new Date() });
  if (!ok) return;

  emitAndLog(runId, 'NODE_SKIPPED', { reason: 'no active branch reached this node' }, nodeKey);
  await propagateToChildren(runId, nodeKey, graph, versionId, nodeRunMap, /* parentActive */ false);
}

/**
 * Aborts a run: cancels its fan-out child-run subtree (B3.4), skips every
 * still-pending node, and transitions the run to FAILED. Used for an
 * unevaluable condition (the user's graph bug, surfaced loudly) and for a
 * fan-out that breached its failure threshold.
 */
async function abortRun(runId: string, reason: string): Promise<void> {
  await cancelChildRunsOf(runId);

  const nodeRunMap = await getNodeRunMap(runId);
  for (const [key, nr] of nodeRunMap) {
    if (nr.status === 'PENDING' || nr.status === 'QUEUED') {
      const ok = await tryTransitionNodeRun(nr.id, nr.status, 'SKIPPED', { finishedAt: new Date() });
      if (ok) emitAndLog(runId, 'NODE_SKIPPED', { reason }, key);
    }
  }
  const failed = await tryTransitionRun(runId, 'RUNNING', 'FAILED', { finishedAt: new Date() });
  if (failed) {
    logger.info({ runId, reason }, 'Run aborted');
    emitAndLog(runId, 'RUN_FAILED', { finishedAt: new Date(), reason });
  }

  // Second child sweep AFTER the FAILED transition: a concurrent `spawnFanOut`
  // sees FAILED on its per-iteration status check and stops, but may have
  // created one more child in the window since the first sweep — catch it here
  // (and `spawnFanOut`'s own post-loop sweep is the third backstop).
  await cancelChildRunsOf(runId);

  // An aborted fan-out child is still terminal — let the parent's join proceed.
  await onFanOutChildTerminal(runId);
}
