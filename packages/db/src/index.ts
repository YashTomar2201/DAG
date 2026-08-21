/**
 * @dag/db — Prisma ORM client and repository helpers.
 *
 * Architecture rule: apps/api and apps/worker must NEVER import from
 * `@prisma/client` or `@dag/db/src/generated/client` directly.
 * All database access goes through the helpers exported here so that:
 *   1. The conditional-update pattern is consistently applied.
 *   2. Tests can stub at the repository boundary, not at the SQL level.
 *   3. Prisma's generated client path never leaks into consuming packages.
 */

// Singleton client
export { prisma } from './client';

// Repository helpers — one function per operation, named after the action
export {
  // Workflow
  createWorkflow,
  createWorkflowVersion,
  // Run lifecycle
  createRun,
  tryTransitionRun,
  allNodeRunsTerminal,
  // NodeRun lifecycle
  tryTransitionNodeRun,
  findNodeRun,
  getNodeRunMap,
  // Audit log
  appendRunEvent,
  getRunEvents,
  // Observability (Phase 12)
  countNodeRunsByStatus,
  countRunsByStatus,
} from './repositories';

// Prisma-generated types (re-exported so consumers don't need a generated/ import)
export type {
  Run,
  NodeRun,
  WorkflowVersion,
  RunEvent,
  Tenant,
  Workflow,
} from './repositories';
