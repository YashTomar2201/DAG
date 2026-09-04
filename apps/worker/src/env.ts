import { z } from 'zod';

/**
 * Zod-validated environment for each worker process.
 * Worker processes are spawned independently — each one validates at boot.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),
  REDIS_URL: z.string().url('REDIS_URL must be a valid Redis connection string'),
  ARTIFACT_DIR: z.string().min(1).default('./artifacts'),
  /** Which ArtifactStore backend to use (roadmap C1). */
  ARTIFACT_BACKEND: z.enum(['fs', 's3']).default('fs'),
  /** Required when ARTIFACT_BACKEND=s3 (validated below — S3ArtifactStore also checks at construction). */
  ARTIFACT_S3_BUCKET: z.string().min(1).optional(),
  /** S3-compatible endpoint (e.g. MinIO's http://minio:9000). Unset ⇒ real AWS S3. */
  ARTIFACT_S3_ENDPOINT: z.string().url().optional(),
  ARTIFACT_S3_REGION: z.string().min(1).default('us-east-1'),
  ARTIFACT_S3_ACCESS_KEY_ID: z.string().optional(),
  ARTIFACT_S3_SECRET_ACCESS_KEY: z.string().optional(),
  /**
   * Number of concurrent jobs this worker process will handle.
   * Recommended: io=8, cpu=4, gpu=1 (set differently per container)
   */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
}).refine((e) => e.ARTIFACT_BACKEND !== 's3' || !!e.ARTIFACT_S3_BUCKET, {
  message: 'ARTIFACT_S3_BUCKET is required when ARTIFACT_BACKEND=s3',
  path: ['ARTIFACT_S3_BUCKET'],
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Invalid environment variables — Worker cannot start:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

/** Strongly-typed, validated environment. Import this instead of process.env. */
export const env: Env = parsed.data;
