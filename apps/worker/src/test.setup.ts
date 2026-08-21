/**
 * Vitest setup for worker tests — stubs required env vars so env.ts
 * doesn't call process.exit(1) during test collection.
 */
process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test';
process.env['REDIS_URL'] = 'redis://localhost:6379';
process.env['NODE_ENV'] = 'test';
process.env['ARTIFACT_DIR'] = '/tmp/dag-artifacts-test';
