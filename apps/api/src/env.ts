import { z } from 'zod';

/**
 * Zod-validated environment for the API process.
 * Crashes at boot with a clear error message if any required variable is missing or malformed.
 * This is intentional — a misconfigured API must never silently start.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),
  REDIS_URL: z.string().url('REDIS_URL must be a valid Redis connection string'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  ARTIFACT_DIR: z.string().min(1).default('./artifacts'),
  /**
   * Mirrors apps/worker/src/env.ts's artifact-store config (roadmap C1.2) —
   * the API needs its own S3 client to mint presigned download links for
   * `GET /runs/:id/nodes/:nodeKey/artifacts/:field/download`. Kept as a
   * separate copy rather than a shared import: apps/api and apps/worker are
   * independently deployable, each validating its own env at boot.
   */
  ARTIFACT_BACKEND: z.enum(['fs', 's3']).default('fs'),
  ARTIFACT_S3_BUCKET: z.string().min(1).optional(),
  ARTIFACT_S3_ENDPOINT: z.string().url().optional(),
  /**
   * The endpoint a BROWSER can reach, used only when signing download URLs.
   * Inside Docker, `ARTIFACT_S3_ENDPOINT` is the internal service name (e.g.
   * `http://minio:9000`) — a presigned URL embedding that host is unusable
   * outside the compose network. Defaults to `ARTIFACT_S3_ENDPOINT` (correct
   * for real AWS S3, which has one publicly-resolvable endpoint).
   */
  ARTIFACT_S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  ARTIFACT_S3_REGION: z.string().min(1).default('us-east-1'),
  ARTIFACT_S3_ACCESS_KEY_ID: z.string().optional(),
  ARTIFACT_S3_SECRET_ACCESS_KEY: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
}).refine((e) => e.ARTIFACT_BACKEND !== 's3' || !!e.ARTIFACT_S3_BUCKET, {
  message: 'ARTIFACT_S3_BUCKET is required when ARTIFACT_BACKEND=s3',
  path: ['ARTIFACT_S3_BUCKET'],
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Invalid environment variables — API cannot start:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

/** Strongly-typed, validated environment. Import this instead of process.env. */
export const env: Env = parsed.data;
