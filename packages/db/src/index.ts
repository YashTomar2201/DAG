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

// Tenant context (roadmap C2.1) — every RLS-protected query goes through one
// of these instead of a bare `prisma.<model>.<op>()`. See tenant.ts's doc
// comment for why.
export { withTenant, withAdminContext } from './tenant';
export type { Db } from './tenant';

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
  createFanOutChildRun,
  countNonTerminalChildren,
  getRunTreeInfo,
  getFanOutChildOutputs,
  // NodeRun lifecycle
  tryTransitionNodeRun,
  findNodeRun,
  getNodeRunMap,
  setNodeRunError,
  // Audit log
  appendRunEvent,
  getRunEvents,
  // Observability (Phase 12)
  countNodeRunsByStatus,
  countRunsByStatus,
  // Schedules & Triggers (B2)
  getLatestVersionId,
  getWorkflowTenantId,
  workflowBelongsToTenant,
  runBelongsToTenant,
  resolveTenantForRun,
  getTenantConcurrencyLimit,
  // API Keys (A3)
  findActiveApiKeyByHash,
  createApiKey,
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
  ApiKey,
  Schedule,
  Trigger,
} from './repositories';
export type { WorkflowListRow, ChildRunSummary } from './repositories';
export type { Prisma } from './generated/client';
