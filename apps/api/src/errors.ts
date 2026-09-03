/**
 * Custom error classes for the DAG Engine control plane.
 *
 * Rules:
 *   - All thrown errors in services must be one of these types so the central
 *     error handler can map them to the correct HTTP status code.
 *   - Never throw raw strings or generic `new Error()` in services.
 */

// ─── CycleError ──────────────────────────────────────────────────────────────

/**
 * Thrown when a submitted graph contains a cycle.
 * Maps to HTTP 422 Unprocessable Entity.
 * The `path` field carries the exact cycle so the UI can highlight the edges.
 */
export class CycleError extends Error {
  readonly path: string[];

  constructor(path: string[]) {
    super(`Graph contains a cycle: ${path.join(' → ')}`);
    this.name = 'CycleError';
    this.path = path;
  }
}

// ─── NotFoundError ────────────────────────────────────────────────────────────

/**
 * Thrown when a requested resource (workflow, run, etc.) does not exist.
 * Maps to HTTP 404.
 */
export class NotFoundError extends Error {
  readonly resource: string;
  readonly id: string;

  constructor(resource: string, id: string) {
    super(`${resource} "${id}" not found`);
    this.name = 'NotFoundError';
    this.resource = resource;
    this.id = id;
  }
}

// ─── ValidationError ──────────────────────────────────────────────────────────

/**
 * Thrown for semantic validation failures that Zod cannot catch.
 * Maps to HTTP 400.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ─── UnauthorizedError ───────────────────────────────────────────────────────

/**
 * Thrown when a request fails authentication — currently only a webhook
 * trigger whose HMAC signature is missing or does not match.
 * Maps to HTTP 401.
 */
export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

// ─── ConflictError ────────────────────────────────────────────────────────────

/**
 * Thrown when an operation conflicts with existing state (e.g. idempotent run
 * already exists but caller expects a fresh one).
 * Maps to HTTP 409.
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
