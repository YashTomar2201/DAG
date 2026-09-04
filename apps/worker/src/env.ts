import { z } from 'zod';

/**
 * Zod-validated environment for each worker process.
 * Worker processes are spawned independently — each one validates at boot.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),
  REDIS_URL: z.string().url('REDIS_URL must be a valid Redis connection string'),
  ARTIFACT_DIR: z.string().min(1).default('./artifacts'),
  /** Which ArtifactStore backend to use (roadmap C1). Only 'fs' exists until C1.2 adds 's3'. */
  ARTIFACT_BACKEND: z.enum(['fs']).default('fs'),
  /**
   * Number of concurrent jobs this worker process will handle.
   * Recommended: io=8, cpu=4, gpu=1 (set differently per container)
   */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
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
