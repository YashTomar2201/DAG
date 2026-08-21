/**
 * Vitest setup — provide minimal env vars so env.ts doesn't call process.exit(1)
 * during test collection. Tests run in-process with vi.mock for @dag/db.
 */

// These are placeholder values — the API never actually connects during tests
// because all DB calls are mocked via vi.mock('@dag/db', ...) in the test files.
process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test';
process.env['REDIS_URL'] = 'redis://localhost:6379';
process.env['NODE_ENV'] = 'test';
