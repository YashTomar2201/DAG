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
  // Workflow CRUD (D1.1)
  listWorkflows,
  getWorkflowWithVersions,
  getWorkflowVersion,
  listWorkflowVersions,
  renameWorkflow,
  softDeleteWorkflow,
  // Run lifecycle
  createRun,
  findRunByIdempotencyKey,
  tryTransitionRun,
  allNodeRunsTerminal,
  // Fan-out run tree (B3)
  getChildRunSummary,
  listChildRuns,
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
  // Schedules & Triggers (B2)
  getLatestVersionId,
  workflowBelongsToTenant,
  createSchedule,
  listSchedulesForWorkflow,
  getScheduleById,
  listEnabledSchedules,
  updateSchedule,
  deleteSchedule,
  createTrigger,
  listTriggersForWorkflow,
  getTriggerByToken,
  getTriggerById,
  updateTrigger,
  deleteTrigger,
} from './repositories';

// Prisma-generated types (re-exported so consumers don't need a generated/ import)
export type {
  Run,
  NodeRun,
  WorkflowVersion,
  RunEvent,
  Tenant,
  Workflow,
  Schedule,
  Trigger,
} from './repositories';
export type { WorkflowListRow, ChildRunSummary } from './repositories';
export type { Prisma } from './generated/client';
