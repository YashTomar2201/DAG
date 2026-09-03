/**
 * Phase 7 — Context Resolver
 *
 * Resolves `{{ nodes.<nodeKey>.output.<dotted.path> }}` template strings in a
 * node's input config against the already-completed parent `NodeRun.output` values.
 *
 * Design choices explained inline and in docs/deep-dives/phase-07-context-passing.md:
 *  1. Resolution happens at **dispatch time** in the control plane, not inside the worker.
 *  2. Unresolved references are a **hard failure** — never silently `undefined`.
 *  3. The resolved input is **persisted** on the `NodeRun` row before enqueuing.
 *  4. Worker outputs are bounded to ≤ 64 KB JSON; large data travels by artifact reference.
 */

import type { Graph } from '@dag/contracts';
import type { NodeRun } from '@dag/db';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum allowed size (in bytes) for a worker's JSON output.
 * Large data (datasets, model weights) must be written to the artifact volume and
 * referenced by path. Passing a 2 GB tensor inline would:
 *   - Overflow Postgres' JSON column practical limits.
 *   - Bloat every NodeRun.output SELECT query in the run view.
 *   - Saturate the Redis pub/sub channel on the NODE_SUCCEEDED event publish.
 */
export const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB

// ─── Errors ───────────────────────────────────────────────────────────────────

export class UnresolvedTemplateError extends Error {
  constructor(
    public readonly template: string,
    public readonly nodeKey: string,
  ) {
    super(
      `Unresolved template "${template}" in node "${nodeKey}". ` +
        `The referenced parent node may not have succeeded yet, or the path is misspelled. ` +
        `Check the artifact convention: large data must travel by reference ` +
        `(e.g. { "metadataPath": "artifacts/{runId}/{nodeKey}/..." }) not by value.`,
    );
    this.name = 'UnresolvedTemplateError';
  }
}

export class OutputTooLargeError extends Error {
  constructor(
    public readonly nodeKey: string,
    public readonly actualBytes: number,
  ) {
    super(
      `Node "${nodeKey}" returned output of ${actualBytes} bytes, exceeding the ${MAX_OUTPUT_BYTES}-byte limit. ` +
        `Write large data to the artifact volume (ARTIFACT_DIR/{runId}/{nodeKey}/...) ` +
        `and return a reference object: { "path": "...", "rows": 123, "checksum": "sha256:..." }.`,
    );
    this.name = 'OutputTooLargeError';
  }
}

// ─── Template Pattern ─────────────────────────────────────────────────────────

/**
 * Matches `{{ nodes.preprocess.output.metadataPath }}` with optional whitespace.
 * Capture group 1 = the path inside: `nodes.preprocess.output.metadataPath`
 */
const TEMPLATE_RE = /\{\{\s*(nodes\.[a-zA-Z0-9_.-]+)\s*\}\}/g;

// ─── Path Resolution ──────────────────────────────────────────────────────────

/**
 * Resolves a dotted path like `nodes.preprocess.output.metadataPath`
 * against the map of completed NodeRun outputs.
 *
 * Returns the resolved value (any JSON-serialisable type), or `undefined` if
 * the path does not exist. The caller is responsible for turning `undefined`
 * into a hard failure.
 */
function resolvePath(
  path: string,
  nodeRunMap: Map<string, NodeRun>,
): unknown {
  // path must start with "nodes.<key>.output"
  const parts = path.split('.');
  // parts[0] = "nodes", parts[1] = nodeKey, parts[2] = "output", parts[3..] = field path
  if (parts[0] !== 'nodes' || parts[2] !== 'output') return undefined;

  const nodeKey = parts[1]!;
  const nr = nodeRunMap.get(nodeKey);
  if (!nr || nr.status !== 'SUCCEEDED') return undefined;

  const output = nr.output as Record<string, unknown>;
  if (!output || typeof output !== 'object') return undefined;

  // Walk the remaining dotted path
  const fieldParts = parts.slice(3);
  let current: unknown = output;
  for (const field of fieldParts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[field];
  }

  return current;
}

// ─── Value Walker ─────────────────────────────────────────────────────────────

/**
 * Recursively walks a JSON value, resolving all `{{ ... }}` template strings.
 * - If the entire string value is a template (and nothing else), it is replaced
 *   with the resolved value (which can be any type, including objects/arrays).
 * - If a template appears as part of a larger string, it is replaced with the
 *   string coercion of the resolved value.
 */
export function walkAndResolve(
  value: unknown,
  nodeRunMap: Map<string, NodeRun>,
  ownerNodeKey: string,
): unknown {
  if (typeof value === 'string') {
    // Check if the *entire* string is exactly one template — if so, replace with
    // the native type of the resolved value (enables passing arrays/objects).
    const wholeMatch = value.match(/^\{\{\s*(nodes\.[a-zA-Z0-9_.-]+)\s*\}\}$/);
    if (wholeMatch) {
      const path = wholeMatch[1]!;
      const resolved = resolvePath(path, nodeRunMap);
      if (resolved === undefined) {
        throw new UnresolvedTemplateError(value, ownerNodeKey);
      }
      return resolved;
    }

    // Otherwise, do string interpolation for templates embedded in larger strings.
    let result = value;
    let match: RegExpExecArray | null;
    TEMPLATE_RE.lastIndex = 0; // reset stateful regex

    while ((match = TEMPLATE_RE.exec(value)) !== null) {
      const template = match[0]!;
      const path = match[1]!;
      const resolved = resolvePath(path, nodeRunMap);
      if (resolved === undefined) {
        throw new UnresolvedTemplateError(template, ownerNodeKey);
      }
      result = result.replace(template, String(resolved));
    }
    return result;
  }

  if (Array.isArray(value)) {
    return value.map((item) => walkAndResolve(item, nodeRunMap, ownerNodeKey));
  }

  if (value !== null && typeof value === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = walkAndResolve(v, nodeRunMap, ownerNodeKey);
    }
    return resolved;
  }

  // Primitives (number, boolean, null) pass through unchanged
  return value;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolves all template references in a node's input config.
 *
 * Called by `dispatchNode` just before enqueueing to BullMQ. The result is
 * persisted on the `NodeRun.input` column so every future re-run, audit, or
 * debug session sees the exact literal values the worker received — not the
 * template that was written by the user.
 *
 * @param graph       The full workflow graph (used to get the node's input config)
 * @param nodeKey     The key of the node being dispatched
 * @param nodeRunMap  All NodeRuns in this run, keyed by nodeKey
 * @returns           The fully resolved input object (no remaining templates)
 * @throws            UnresolvedTemplateError if any reference cannot be resolved
 */
export function resolveNodeInputs(
  graph: Graph,
  nodeKey: string,
  nodeRunMap: Map<string, NodeRun>,
): Record<string, unknown> {
  const node = graph.nodes.find((n) => n.key === nodeKey);
  if (!node) throw new Error(`Node "${nodeKey}" not found in graph`);

  // `node.config` is where the user writes their templates.
  // For nodes with no config (e.g. a passthrough), return empty object.
  const raw = (node.config ?? {}) as Record<string, unknown>;

  return walkAndResolve(raw, nodeRunMap, nodeKey) as Record<string, unknown>;
}

// ─── Output Size Guard ────────────────────────────────────────────────────────

/**
 * Validates that a worker's output JSON does not exceed MAX_OUTPUT_BYTES.
 * Called by `onNodeSucceeded` before persisting and forwarding the output.
 *
 * Throws `OutputTooLargeError` if the limit is exceeded. The orchestrator
 * should catch this and call `onNodeFailed` so the run fails cleanly with
 * a useful error message instead of silently storing a truncated blob.
 */
export function assertOutputSize(nodeKey: string, output: unknown): void {
  const serialised = JSON.stringify(output);
  const bytes = Buffer.byteLength(serialised, 'utf8');
  if (bytes > MAX_OUTPUT_BYTES) {
    throw new OutputTooLargeError(nodeKey, bytes);
  }
}
