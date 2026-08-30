/// <reference types="vite/client" />
/**
 * API client — all HTTP calls to the DAG engine API.
 * Keeps fetch boilerplate in one place and provides typed responses.
 */

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';


async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ─── Workflows ────────────────────────────────────────────────────────────────

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  graph: unknown;
  topoOrder: unknown;
  createdAt: string;
}

export interface Workflow {
  id: string;
  name: string;
  versions: WorkflowVersion[];
}

export async function listWorkflows(): Promise<Workflow[]> {
  return request<Workflow[]>('/workflows');
}

export async function createWorkflow(name: string, graph: unknown): Promise<Workflow> {
  return request<Workflow>('/workflows', {
    method: 'POST',
    body: JSON.stringify({ name, graph }),
  });
}

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

export interface RunSummary {
  id: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  nodeRuns: NodeRunSummary[];
}

export async function startRun(workflowVersionId: string): Promise<RunSummary> {
  return request<RunSummary>('/runs', {
    method: 'POST',
    body: JSON.stringify({ workflowVersionId }),
  });
}

export async function getRun(runId: string): Promise<RunSummary> {
  return request<RunSummary>(`/runs/${runId}`);
}

export async function listRuns(workflowId: string): Promise<RunSummary[]> {
  return request<RunSummary[]>(`/workflows/${workflowId}/runs`);
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

  const handler = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      onEvent(e.type || 'message', data);
    } catch {
      // Ignore parse errors
    }
  };

  // Listen to all named event types
  const EVENT_TYPES = [
    'RUN_STARTED', 'RUN_SUCCEEDED', 'RUN_FAILED', 'RUN_CANCELLED',
    'NODE_QUEUED', 'NODE_RUNNING', 'NODE_SUCCEEDED', 'NODE_FAILED',
    'NODE_SKIPPED', 'NODE_CANCELLED', 'NODE_LOG', 'NODE_LOG_BATCH',
  ];
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, handler as EventListener);
  }
  es.addEventListener('message', handler as EventListener);

  if (onError) es.onerror = onError;

  return () => es.close();
}
