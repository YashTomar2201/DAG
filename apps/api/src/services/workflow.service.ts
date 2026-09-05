import { GraphSchema } from '@dag/contracts';
import type { Graph } from '@dag/contracts';
import { detectCycle, topologicalSort } from '@dag/graph-core';
import type { TopologicalSortResult } from '@dag/graph-core';
import {
  createWorkflow,
  createWorkflowVersion,
  listWorkflows,
  getWorkflowWithVersions,
  getWorkflowVersion,
  listWorkflowVersions,
  renameWorkflow,
  softDeleteWorkflow,
  workflowBelongsToTenant,
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

// ─── Workflow CRUD (D1.1) ────────────────────────────────────────────────────

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 25;

/** Tenant-scoped, newest-first, cursor-paginated workflow list. */
export async function listWorkflowsService(
  tenantId: string,
  opts: { limit?: number; cursor?: string } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  return listWorkflows(tenantId, { limit, cursor: opts.cursor });
}

/** A workflow + its versions. 404 if missing or soft-deleted. */
export async function getWorkflowService(id: string, tenantId: string) {
  const wf = await getWorkflowWithVersions(id, tenantId);
  if (!wf) throw new NotFoundError('Workflow', id);
  return wf;
}

/** The version list for a workflow (D1.3). 404 if missing or soft-deleted. */
export async function listWorkflowVersionsService(id: string, tenantId: string) {
  const versions = await listWorkflowVersions(id, tenantId);
  if (versions === null) throw new NotFoundError('Workflow', id);
  return versions;
}

/** One full version (graph + topoOrder). 404 if it doesn't belong to the workflow/tenant. */
export async function getWorkflowVersionService(
  workflowId: string,
  versionId: string,
  tenantId: string,
) {
  const version = await getWorkflowVersion(workflowId, versionId, tenantId);
  if (!version) throw new NotFoundError('WorkflowVersion', versionId);
  return version;
}

/** Rename. 404 if missing or soft-deleted. */
export async function renameWorkflowService(id: string, tenantId: string, name: string) {
  const updated = await renameWorkflow(id, tenantId, name);
  if (!updated) throw new NotFoundError('Workflow', id);
  return updated;
}

/** Soft delete. 404 if there was nothing (non-deleted) to delete. */
export async function deleteWorkflowService(id: string, tenantId: string) {
  const ok = await softDeleteWorkflow(id, tenantId);
  if (!ok) throw new NotFoundError('Workflow', id);
}

// ─── WorkflowVersion (append a new version) ──────────────────────────────────

export interface CreateVersionInput {
  workflowId: string;
  tenantId: string;
  graph: unknown;
}

/**
 * Validates the graph and appends a new immutable version to an existing workflow.
 * Returns HTTP 422 (via CycleError) if the graph has a cycle.
 * Returns HTTP 404 (via NotFoundError) if the workflow doesn't exist OR
 * belongs to a different tenant — this used to check existence only, which
 * meant any authenticated caller could append a version to ANY workflow by
 * id, not just their own (roadmap A3 caught this as part of "every path must
 * filter by tenant, not just look up by id").
 */
export async function createVersionService(input: CreateVersionInput) {
  if (!(await workflowBelongsToTenant(input.workflowId, input.tenantId))) {
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
