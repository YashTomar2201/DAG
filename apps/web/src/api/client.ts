/// <reference types="vite/client" />
/**
 * API client — all HTTP calls to the DAG engine API.
 *
 * Response shapes here are aligned with the actual API contracts:
 *   POST /workflows        → { workflowId, versionId }
 *   POST /workflows/:id/versions → WorkflowVersion (Prisma row)
 *   POST /runs             → Run (Prisma row, no nodeRuns inline)
 *   GET  /runs/:id         → Run + nodeRuns[]
 *   GET  /runs/:id/events  → SSE stream
 *   POST /runs/:id/retry-failed
 */

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

/** Default tenant used by the single-tenant visual editor. */
const DEFAULT_TENANT_ID = 'default';

/**
 * Structured API error. Carries the HTTP status and the parsed JSON body so
 * callers can render a precise message (Zod issues, cycle path, …) instead of
 * string-matching a stringified Error.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`API ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /** A human-readable, multi-line message suitable for a UI banner. */
  toDisplayMessage(): string {
    const b = this.body as
      | { error?: string; issues?: { path: string; message: string }[]; cyclePath?: string[] }
      | undefined;

    if (b?.cyclePath?.length) {
      return `This graph contains a cycle: ${b.cyclePath.join(' → ')}. Remove one of those edges and try again.`;
    }
    if (b?.issues?.length) {
      const lines = b.issues.map((i) => `  • ${prettyPath(i.path)}: ${i.message}`);
      return `Some node settings are invalid:\n${lines.join('\n')}`;
    }
    if (this.status >= 500) {
      return `The server hit an unexpected error (HTTP ${this.status}). Check that the API and its database are running, then try again.`;
    }
    return b?.error ? `${b.error} (HTTP ${this.status})` : `Request failed (HTTP ${this.status}).`;
  }
}

/** Turns "nodes.0.config.minAccuracy" into "node 1 › minAccuracy". */
function prettyPath(path: string): string {
  const m = path.match(/^nodes\.(\d+)\.config\.(.+)$/);
  if (m) return `node ${Number(m[1]) + 1} › ${m[2]}`;
  const n = path.match(/^nodes\.(\d+)\.(.+)$/);
  if (n) return `node ${Number(n[1]) + 1} › ${n[2]}`;
  return path;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      ...init,
    });
  } catch {
    // Network-level failure (API down, CORS, DNS) — fetch rejects with a
    // TypeError that carries no useful detail. Give the user something actionable.
    throw new ApiError(0, {
      error: `Could not reach the API at ${API_BASE}. Make sure the control plane is running.`,
    });
  }
  if (!res.ok) {
    const body = await res.json().catch(() => res.text().catch(() => 'Unknown error'));
    throw new ApiError(res.status, body);
  }
  return res.json() as Promise<T>;
}

// ─── Workflows ────────────────────────────────────────────────────────────────

/**
 * Actual shape returned by POST /workflows (from repositories.ts createWorkflow).
 * NOT a full Workflow object — just the two IDs needed to proceed.
 */
export interface CreateWorkflowResult {
  workflowId: string;
  versionId: string;
}

/**
 * Full WorkflowVersion row returned by POST /workflows/:id/versions.
 */
export interface WorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  graph: unknown;
  topoOrder: unknown;
  createdAt: string;
}

/**
 * Creates a new workflow with its first version.
 * The API requires a tenantId — we use a fixed default for the visual editor.
 * Returns { workflowId, versionId } — not a full Workflow object.
 */
export async function createWorkflow(
  name: string,
  graph: unknown,
): Promise<CreateWorkflowResult> {
  return request<CreateWorkflowResult>('/workflows', {
    method: 'POST',
    body: JSON.stringify({ tenantId: DEFAULT_TENANT_ID, name, graph }),
  });
}

/**
 * Appends a new immutable version to an existing workflow.
 * Returns the full WorkflowVersion row.
 */
export async function saveWorkflowVersion(
  workflowId: string,
  graph: unknown,
): Promise<WorkflowVersion> {
  return request<WorkflowVersion>(`/workflows/${workflowId}/versions`, {
    method: 'POST',
    body: JSON.stringify({ graph }),
  });
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export interface NodeRunSummary {
  id: string;
  nodeKey: string;
  status: string;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  workerId: string | null;
  output: unknown;
  error: unknown;
}

/**
 * Bare Run row returned by POST /runs.
 * Does NOT include nodeRuns — fetch GET /runs/:id for the full picture.
 */
export interface RunRecord {
  id: string;
  workflowVersionId: string;
  status: string;
  triggeredBy: string;
  /** The API's Run row has no createdAt column; present only on some paths. */
  createdAt?: string;
  startedAt: string | null;
  finishedAt: string | null;
  idempotencyKey: string | null;
}

/**
 * Full Run returned by GET /runs/:id — includes all nodeRuns.
 */
export interface RunSummary extends RunRecord {
  nodeRuns: NodeRunSummary[];
}

/**
 * Starts a new run. Returns the bare Run row (no nodeRuns inline).
 * The frontend uses the run.id immediately to open the SSE stream.
 */
export async function startRun(workflowVersionId: string): Promise<RunRecord> {
  return request<RunRecord>('/runs', {
    method: 'POST',
    body: JSON.stringify({ workflowVersionId }),
  });
}

export async function getRun(runId: string): Promise<RunSummary> {
  return request<RunSummary>(`/runs/${runId}`);
}

/**
 * Lists past runs for the Run History panel.
 * NOTE: There is no GET /workflows/:id/runs route on the API.
 * We work around this by fetching individual runs via the run store,
 * which already tracks runs from SSE events. This function is kept for
 * future use if a list endpoint is added; the RunHistory component
 * is updated to use the Zustand run store directly instead.
 */
export async function getRuns(runIds: string[]): Promise<RunSummary[]> {
  return Promise.all(runIds.map((id) => getRun(id)));
}

export async function retryFailed(runId: string): Promise<unknown> {
  return request(`/runs/${runId}/retry-failed`, { method: 'POST' });
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

/**
 * Opens the SSE stream for a run and calls `onEvent` for each event.
 * Returns a teardown function that closes the EventSource.
 */
export function openRunEventStream(
  runId: string,
  lastEventId: string | undefined,
  onEvent: (type: string, data: unknown) => void,
  onError?: (err: Event) => void,
): () => void {
  const url = `${API_BASE}/runs/${runId}/events`;
  const es = new EventSource(url);

  const TERMINAL = new Set(['RUN_SUCCEEDED', 'RUN_FAILED', 'RUN_CANCELLED']);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    es.close();
  };

  const handler = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      const type = e.type || 'message';
      onEvent(type, data);
      // Once the run reaches a terminal state there is nothing more to stream.
      // Closing here stops the browser from silently reconnecting forever.
      if (TERMINAL.has(type)) close();
    } catch {
      // Ignore parse errors
    }
  };

  // Listen to all named event types the server emits
  const EVENT_TYPES = [
    'RUN_STARTED', 'RUN_SUCCEEDED', 'RUN_FAILED', 'RUN_CANCELLED',
    'NODE_QUEUED', 'NODE_RUNNING', 'NODE_SUCCEEDED', 'NODE_FAILED',
    'NODE_SKIPPED', 'NODE_CANCELLED', 'NODE_LOG', 'NODE_LOG_BATCH',
  ];
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, handler as EventListener);
  }
  es.addEventListener('message', handler as EventListener);

  es.onerror = (err) => {
    // EventSource auto-reconnects on transient errors; only report if the
    // connection is actually dead (readyState CLOSED) and we didn't close it.
    if (!closed && es.readyState === EventSource.CLOSED && onError) onError(err);
  };

  return close;
}
