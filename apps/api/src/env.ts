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
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
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
