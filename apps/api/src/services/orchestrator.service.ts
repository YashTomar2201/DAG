import {
  prisma,
  createRun,
  tryTransitionRun,
  tryTransitionNodeRun,
  findNodeRun,
  getNodeRunMap,
  allNodeRunsTerminal,
  appendRunEvent,
} from '@dag/db';
import type { Prisma, WorkflowVersion } from '@dag/db';
import {
  seedInDegrees,
  decrementInDegree,
  queueForType,
  createJobId,
  publishRunEvent,
} from '@dag/queue';
import { logger } from '../logger';
import { NotFoundError } from '../errors';
import type { Graph, NodeDef, NodeType, RunEventType } from '@dag/contracts';
import { resolveNodeInputs, assertOutputSize, OutputTooLargeError } from '../context-resolver';
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

export async function startRun(workflowVersionId: string, idempotencyKey?: string) {
  const version = await prisma.workflowVersion.findUnique({
    where: { id: workflowVersionId },
  });
  if (!version) throw new NotFoundError('WorkflowVersion', workflowVersionId);

  const graph = getGraphFromVersion(version);
  const nodeKeys = graph.nodes.map((n) => n.key);

  // 1. Create Run + NodeRuns (idempotent)
  const run = await createRun(workflowVersionId, 'api', nodeKeys, idempotencyKey);
  
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

  // 2. Seed in-degrees in Redis
  await seedInDegrees(run.id, graph.edges);

  // 3. Find initial ready set (in-degree 0) and dispatch
  const inDegreeCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    inDegreeCounts.set(edge.to, (inDegreeCounts.get(edge.to) || 0) + 1);
  }
  
  const initialNodes = graph.nodes.filter((n) => !inDegreeCounts.has(n.key));
  
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

  const children = getChildren(graph, nodeKey);

  // 2. Decrement in-degree for all children via atomic Lua script
  for (const childKey of children) {
    const shouldDispatch = await decrementInDegree(runId, childKey);
    // 3. Dispatch ONLY if Lua returned 1
    if (shouldDispatch) {
      await dispatchNode(runId, childKey, graph, version.id);
    }
  }

  // 4. Check if the entire run is complete
  if (await allNodeRunsTerminal(runId)) {
    const completed = await tryTransitionRun(runId, 'RUNNING', 'SUCCEEDED', { finishedAt: new Date() });
    if (completed) {
      logger.info({ runId }, 'Run succeeded');
      emitAndLog(runId, 'RUN_SUCCEEDED', { finishedAt: new Date() });
    }
  }
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
}
