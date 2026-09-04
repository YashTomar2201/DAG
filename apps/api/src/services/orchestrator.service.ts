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
  queueForType,
  createJobId,
  publishRunEvent,
} from '@dag/queue';
import { logger } from '../logger';
import { NotFoundError } from '../errors';
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
  opts: { triggeredBy?: string } = {},
) {
  const version = await prisma.workflowVersion.findUnique({
    where: { id: workflowVersionId },
  });
  if (!version) throw new NotFoundError('WorkflowVersion', workflowVersionId);

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
  
  const payload = {
    runId,
    nodeKey,
    nodeRunId: nr.id,
    type: node.type as NodeType,
    config: node.config,
    input: resolvedInput,
    attempt: nr.attempt,
  };

  // 3. Add to BullMQ
  // Retries/backoff are handled by the queue default options we set in queues.ts
  await queue.add(node.type, payload, { jobId });

  logger.info({ runId, nodeKey, jobId, queue: queue.name }, 'Dispatched node');
  emitAndLog(runId, 'NODE_QUEUED', { jobId }, nodeKey);
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
  await checkFanOutJoinIfChild(runId);
}

export interface NodeFailure {
  message: string;
  taxonomy?: 'retryable' | 'unrecoverable';
}

export async function onNodeFailed(runId: string, nodeKey: string, error: NodeFailure) {
  const nr = await findNodeRun(runId, nodeKey);
  if (!nr || nr.status !== 'RUNNING') return;

  const success = await tryTransitionNodeRun(nr.id, 'RUNNING', 'FAILED', {
    error: error as unknown as Prisma.InputJsonValue,
    finishedAt: new Date(),
  });
  
  if (!success) return;

  logger.error({ runId, nodeKey, error }, 'Node failed');
  emitAndLog(runId, 'NODE_FAILED', { error }, nodeKey);

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
  await checkFanOutJoinIfChild(runId);
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
  const items = resolved['overSource'];
  if (!Array.isArray(items)) {
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
  const subEdges = graph.edges.filter(
    (e) => subgraphKeys.includes(e.from) && subgraphKeys.includes(e.to),
  );
  const inDeg = new Map<string, number>();
  for (const e of subEdges) inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  const roots = subgraphKeys.filter((k) => !inDeg.has(k));

  emitAndLog(runId, 'NODE_LOG', { line: `flow.map: fanning out over ${items.length} element(s)` }, mapNodeKey);

  // Zero elements: nothing to run — join straight away with an empty summary.
  if (items.length === 0) {
    await joinFanOut(runId, mapNodeKey, graph, versionId);
    return;
  }

  for (let i = 0; i < items.length; i++) {
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
 * A fan-out child reached a terminal state. If no siblings remain non-terminal,
 * fire the join exactly once (Redis `claimFanOutJoin` picks the single winner
 * among simultaneous last-finishers).
 */
async function checkFanOutJoinIfChild(childRunId: string): Promise<void> {
  const info = await getRunTreeInfo(childRunId);
  if (!info?.parentRunId) return;
  const parsed = parseFanOutIdemKey(info.idempotencyKey);
  if (!parsed) return;
  const { parentRunId, mapNodeKey } = parsed;

  if (await countNonTerminalChildren(parentRunId) > 0) return;

  const parent = await prisma.run.findUnique({
    where: { id: parentRunId },
    select: { workflowVersionId: true, status: true },
  });
  if (!parent) return;
  const version = await prisma.workflowVersion.findUnique({ where: { id: parent.workflowVersionId } });
  if (!version) return;

  await joinFanOut(parentRunId, mapNodeKey, getGraphFromVersion(version), version.id);
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
 * Aborts a run when a condition can't be evaluated (unresolved ref / type
 * error). Skips every still-pending node and transitions the run to FAILED —
 * a broken condition is the user's graph bug, surfaced loudly, not silently
 * treated as false.
 */
async function abortRun(runId: string, reason: string): Promise<void> {
  const nodeRunMap = await getNodeRunMap(runId);
  for (const [key, nr] of nodeRunMap) {
    if (nr.status === 'PENDING' || nr.status === 'QUEUED') {
      const ok = await tryTransitionNodeRun(nr.id, nr.status, 'SKIPPED', { finishedAt: new Date() });
      if (ok) emitAndLog(runId, 'NODE_SKIPPED', { reason }, key);
    }
  }
  const failed = await tryTransitionRun(runId, 'RUNNING', 'FAILED', { finishedAt: new Date() });
  if (failed) {
    logger.info({ runId, reason }, 'Run failed (condition error)');
    emitAndLog(runId, 'RUN_FAILED', { finishedAt: new Date(), reason });
  }

  // An aborted fan-out child is still terminal — let the parent's join proceed.
  await checkFanOutJoinIfChild(runId);
}
