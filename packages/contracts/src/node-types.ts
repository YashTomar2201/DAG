import { z } from 'zod';

// ─── Per-type config schemas ────────────────────────────────────────────────
// Each node type carries its own strictly-typed config.
// The discriminated union on `type` gives compile-time exhaustiveness:
// adding a new type without a matching executor case fails typecheck in the worker.

export const KaggleDownloadConfigSchema = z.object({
  /** Kaggle dataset slug, e.g. "username/dataset-name" */
  datasetSlug: z.string().min(1),
  /** Destination path inside the shared artifact volume */
  outputDir: z.string().min(1),
});

export const PandasPreprocessConfigSchema = z.object({
  /** Path to the Python script (relative to the python/ directory) */
  scriptPath: z.string().min(1).default('preprocess.py'),
  /**
   * Path to the input CSV. Relative paths resolve against the worker's
   * `python/` directory; when omitted the script falls back to the bundled
   * `data/titanic.csv` so a graph that sets nothing still runs.
   */
  csvPath: z.string().min(1).optional(),
  /** Label column held out of feature encoding (script default: "Survived"). */
  targetColumn: z.string().min(1).optional(),
  /** Held-out fraction for the train/test split, exclusive of 0 and 1. */
  testSize: z.number().gt(0).lt(1).optional(),
  /** Additional keyword args forwarded to the script via stdin */
  kwargs: z.record(z.unknown()).optional(),
});

export const TorchTrainConfigSchema = z.object({
  scriptPath: z.string().min(1).default('train.py'),
  /** Iteration budget — trees for randomforest, solver iterations for logreg */
  epochs: z.coerce.number().int().positive().default(10),
  /** Path to save model weights (relative to ARTIFACT_DIR) */
  outputWeightsPath: z.string().min(1).optional(),
  /** Estimator to fit. Defaults to randomforest in the script. */
  modelType: z.enum(['randomforest', 'logreg']).optional(),
  /**
   * Template ref to the training split from preprocess, e.g.
   * "{{ nodes.preprocess.output.trainPath }}". Resolved by the control plane.
   */
  trainPath: z.string().min(1).optional(),
  /**
   * Template ref to the label column, e.g.
   * "{{ nodes.preprocess.output.targetColumn }}". Falls back to the parquet's
   * last column (which preprocess writes as the target).
   */
  targetColumn: z.string().min(1).optional(),
  kwargs: z.record(z.unknown()).optional(),
});

export const ModelEvaluateConfigSchema = z.object({
  scriptPath: z.string().min(1).default('evaluate.py'),
  /** Minimum accuracy threshold; the executor fails the node if not met */
  minAccuracy: z.number().min(0).max(1).optional(),
  /**
   * Template ref to the trained model, e.g.
   * "{{ nodes.train.output.weightsPath }}". Resolved by the control plane.
   */
  weightsPath: z.string().min(1).optional(),
  /**
   * Template ref to the held-out split, e.g.
   * "{{ nodes.preprocess.output.testPath }}".
   */
  testPath: z.string().min(1).optional(),
  /**
   * Template ref to the label column, e.g.
   * "{{ nodes.preprocess.output.targetColumn }}". Falls back to the parquet's
   * last column.
   */
  targetColumn: z.string().min(1).optional(),
  kwargs: z.record(z.unknown()).optional(),
});

export const RegistryDeployConfigSchema = z.object({
  /** Target model registry URL */
  registryUrl: z.string().url(),
  /** Model name/tag to register the artifact under */
  modelTag: z.string().min(1),
  /**
   * Optional template reference to the trained weights so the deploy step can
   * record a checksum, e.g. "{{ nodes.train.output.weightsPath }}".
   * Resolved by the control plane's context-resolver at dispatch time.
   */
  weightsPath: z.string().min(1).optional(),
});

// ─── Node type discriminated union ─────────────────────────────────────────
// Using z.discriminatedUnion so TypeScript narrows the config type when you
// switch/match on `node.type`. The worker's executor registry switches on this
// field; every branch is exhaustively typed at compile time.

export const NODE_TYPES = [
  'kaggle.download',
  'pandas.preprocess',
  'torch.train',
  'model.evaluate',
  'registry.deploy',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

// ─── Retry policy ──────────────────────────────────────────────────────────

export const RetryPolicySchema = z.object({
  /** Total number of attempts (including the first try) */
  attempts: z.number().int().min(1).max(10).default(3),
  /** Base delay in ms for exponential backoff */
  baseDelay: z.number().int().positive().default(2000),
  /** Maximum delay cap in ms (prevents unbounded backoff) */
  cap: z.number().int().positive().default(30_000),
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

// ─── NodeDef base (fields common to all node types) ───────────────────────

const NodeDefBaseSchema = z.object({
  /**
   * Stable, user-facing identifier — used as the Redis hash key and the
   * template interpolation key: `{{ nodes.preprocess.output.metadataPath }}`.
   * Must be lowercase alphanumeric + hyphens/underscores, no spaces.
   */
  key: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_-]*$/, 'key must start with a letter and contain only a-z, 0-9, _ or -'),
  label: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }),
  retryPolicy: RetryPolicySchema.optional(),
});

// ─── Full discriminated NodeDef union ──────────────────────────────────────

export const NodeDefSchema = z.discriminatedUnion('type', [
  NodeDefBaseSchema.extend({
    type: z.literal('kaggle.download'),
    config: KaggleDownloadConfigSchema,
  }),
  NodeDefBaseSchema.extend({
    type: z.literal('pandas.preprocess'),
    config: PandasPreprocessConfigSchema,
  }),
  NodeDefBaseSchema.extend({
    type: z.literal('torch.train'),
    config: TorchTrainConfigSchema,
  }),
  NodeDefBaseSchema.extend({
    type: z.literal('model.evaluate'),
    config: ModelEvaluateConfigSchema,
  }),
  NodeDefBaseSchema.extend({
    type: z.literal('registry.deploy'),
    config: RegistryDeployConfigSchema,
  }),
]);

export type NodeDef = z.infer<typeof NodeDefSchema>;

// Re-export config types for convenience
export type KaggleDownloadConfig = z.infer<typeof KaggleDownloadConfigSchema>;
export type PandasPreprocessConfig = z.infer<typeof PandasPreprocessConfigSchema>;
export type TorchTrainConfig = z.infer<typeof TorchTrainConfigSchema>;
export type ModelEvaluateConfig = z.infer<typeof ModelEvaluateConfigSchema>;
export type RegistryDeployConfig = z.infer<typeof RegistryDeployConfigSchema>;
