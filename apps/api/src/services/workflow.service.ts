import { GraphSchema } from '@dag/contracts';
import type { Graph } from '@dag/contracts';
import { detectCycle, topologicalSort } from '@dag/graph-core';
import type { TopologicalSortResult } from '@dag/graph-core';
import {
  prisma,
  createWorkflow,
  createWorkflowVersion,
} from '@dag/db';
import { CycleError, NotFoundError } from '../errors';

// ─── Schema helpers ───────────────────────────────────────────────────────────

/**
 * Parses and structurally validates a raw graph payload (Zod),
 * then runs semantic validation (cycle detection, topo sort).
 *
 * Returns the parsed Graph and its cached topoOrder on success.
 * Throws CycleError if a cycle is found; ZodError if schema is invalid.
 */
export function validateAndProcessGraph(rawGraph: unknown): {
  graph: Graph;
  topoOrder: TopologicalSortResult;
} {
  // Step 1: Schema validation (node keys unique, no dangling edges, etc.)
  const graph = GraphSchema.parse(rawGraph);

  // Step 2: Cycle detection — Zod cannot do graph traversal
  const cycleResult = detectCycle(graph);
  if (cycleResult.hasCycle) {
    throw new CycleError(cycleResult.path ?? []);
  }

  // Step 3: Topological sort — cached on the version row so the scheduler
  // never recomputes it under load (see PROJECT_GUIDE.md §7 decision rationale)
  const topoOrder = topologicalSort(graph);

  return { graph, topoOrder };
}

// ─── Workflow CRUD ────────────────────────────────────────────────────────────

export interface CreateWorkflowInput {
  tenantId: string;
  name: string;
  graph: unknown;
}

/**
 * Creates a new Workflow + initial WorkflowVersion in one transaction.
 * Validates and processes the graph before persisting.
 */
export async function createWorkflowService(input: CreateWorkflowInput) {
  const { graph, topoOrder } = validateAndProcessGraph(input.graph);

  return createWorkflow(input.tenantId, input.name, graph, topoOrder);
}

// ─── WorkflowVersion (append a new version) ──────────────────────────────────

export interface CreateVersionInput {
  workflowId: string;
  graph: unknown;
}

/**
 * Validates the graph and appends a new immutable version to an existing workflow.
 * Returns HTTP 422 (via CycleError) if the graph has a cycle.
 * Returns HTTP 404 (via NotFoundError) if the workflow doesn't exist.
 */
export async function createVersionService(input: CreateVersionInput) {
  // Verify the workflow exists before creating a version
  const workflow = await prisma.workflow.findUnique({
    where: { id: input.workflowId },
    select: { id: true },
  });
  if (!workflow) {
    throw new NotFoundError('Workflow', input.workflowId);
  }

  const { graph, topoOrder } = validateAndProcessGraph(input.graph);

  return createWorkflowVersion(input.workflowId, graph, topoOrder);
}

// ─── Dry-run validation ───────────────────────────────────────────────────────

/**
 * Validates a graph without persisting anything.
 * Used by the editor for live feedback as the user draws connections.
 * Returns a structured result rather than throwing so the response always
 * has a consistent shape.
 */
export function validateGraphService(rawGraph: unknown): {
  valid: boolean;
  topoOrder?: TopologicalSortResult;
  error?: string;
  cyclePath?: string[];
  zodIssues?: Array<{ path: string; message: string }>;
} {
  // Zod parse
  const parsed = GraphSchema.safeParse(rawGraph);
  if (!parsed.success) {
    return {
      valid: false,
      zodIssues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }

  // Cycle detection
  const cycleResult = detectCycle(parsed.data);
  if (cycleResult.hasCycle) {
    return {
      valid: false,
      error: 'Graph contains a cycle',
      cyclePath: cycleResult.path,
    };
  }

  // Topo sort
  const topoOrder = topologicalSort(parsed.data);

  return { valid: true, topoOrder };
}
