/**
 * @dag/contracts — single source of truth for all wire formats in the DAG engine.
 *
 * Rule: NEVER hand-write a TypeScript interface that duplicates one of these schemas.
 *       Always use `z.infer<typeof XSchema>` to derive the type.
 *
 * Packages that import from here:
 *   - apps/api    (validates incoming HTTP bodies, caches topoOrder)
 *   - apps/worker (receives JobPayload off the queue, validates executor output)
 *   - apps/web    (validates graph before sending to API, parses SSE events)
 */

// Status enums
export {
  NodeStatusSchema,
  RunStatusSchema,
  TERMINAL_NODE_STATUSES,
  TERMINAL_RUN_STATUSES,
} from './status';
export type { NodeStatus, RunStatus } from './status';

// Node type discriminated union + per-type configs
export {
  NodeDefSchema,
  RetryPolicySchema,
  NODE_TYPES,
  DataSourceConfigSchema,
  PandasPreprocessConfigSchema,
  TorchTrainConfigSchema,
  ModelEvaluateConfigSchema,
  RegistryDeployConfigSchema,
} from './node-types';
export type {
  NodeDef,
  NodeType,
  RetryPolicy,
  DataSourceConfig,
  PandasPreprocessConfig,
  TorchTrainConfig,
  ModelEvaluateConfig,
  RegistryDeployConfig,
} from './node-types';

// Graph schema with structural refinements (also exports EdgeDefSchema, EdgeDef)
export { GraphSchema, EdgeDefSchema, ConditionSchema, ConditionOpSchema, MAX_NODES } from './graph';
export type { Graph, EdgeDef, Condition, ConditionOp } from './graph';

// BullMQ job payload
export { JobPayloadSchema } from './job';
export type { JobPayload } from './job';

// Run event envelope + error taxonomy
export {
  RunEventSchema,
  ErrorTaxonomySchema,
  RUN_EVENT_TYPES,
} from './events';
export type { RunEvent, RunEventType, ErrorTaxonomy } from './events';
