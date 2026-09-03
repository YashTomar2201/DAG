/**
 * graphSlice — owns the React Flow canvas state.
 *
 * Why Zustand with narrow selectors?
 *   During a live run, node status updates arrive via SSE at ~1 event/s.
 *   If we stored status in React Context, every status update would cause
 *   every component that consumes the context to re-render — including all
 *   canvas nodes, all panel components, and all toolbar buttons. With 50 nodes,
 *   that's 50+ unnecessary re-renders per status tick. Zustand's selector
 *   pattern (`useStore(s => s.nodes)`) only re-renders components whose
 *   selected slice actually changed. A status tick on node "train" re-renders
 *   only the "train" CustomNode component and the RunStatus indicator.
 *
 * Why sliced stores?
 *   Graph state (nodes, edges, selection) and run state (run id, node statuses,
 *   logs) change at completely different frequencies and for different reasons.
 *   Slicing keeps each concern isolated: the graph slice never changes during a
 *   run (unless the user edits), and the run slice never changes at design time.
 *   This makes selector granularity straightforward and avoids accidental
 *   coupling between the two domains.
 */

import { create } from 'zustand';
import { applyNodeChanges, applyEdgeChanges, MarkerType } from '@xyflow/react';
import type { Node, Edge, NodeChange, EdgeChange, Connection } from '@xyflow/react';
import { detectCycle } from '@dag/graph-core';
import type { Graph, Condition } from '@dag/contracts';
import { serializeCondition } from '../lib/condition';

// ─── Types ────────────────────────────────────────────────────────────────────

export type NodeData = Record<string, unknown> & {
  label: string;
  nodeType: string; // 'data.source' | 'pandas.preprocess' | etc.
  config: Record<string, unknown>;
  status?: string;  // PENDING | QUEUED | RUNNING | SUCCEEDED | FAILED | SKIPPED
};

/**
 * Extra data carried on a React Flow edge. `condition`, when present, is the
 * B1.2 runtime gate authored in the edge inspector; `toGraph()` serialises it
 * back onto the `EdgeDef` and `graphToFlow()` restores it on open.
 */
export type DagEdgeData = { condition?: Condition };

/** A point-in-time copy of the graph topology, used for undo / redo. */
export interface GraphSnapshot {
  nodes: Node<NodeData>[];
  edges: Edge[];
}

/** One entry in a workflow's version history (D1.3). */
export interface VersionMeta {
  id: string;
  version: number;
  createdAt: string;
}

/** How many structural edits we remember. */
const HISTORY_LIMIT = 50;

export interface GraphState {
  nodes: Node<NodeData>[];
  edges: Edge[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  isDirty: boolean;
  cycleHighlight: string[]; // node ids in a rejected cycle

  // ── Workflow identity (D1.2) ──────────────────────────────────────────────
  // Null workflowId = an unsaved new workflow. `workflowName` is what the
  // header shows and what the first save sends as the workflow name.
  workflowId: string | null;
  versionId: string | null;
  workflowName: string;

  // ── Version history (D1.3) ───────────────────────────────────────────────
  /** All versions of the open workflow, newest first. Empty until a save/open. */
  versions: VersionMeta[];
  /** True while viewing an old version — the canvas is frozen until restored. */
  isReadOnly: boolean;

  // Undo / redo history (structural edits only: add/remove node, add/remove
  // edge, move node). `past` is oldest→newest; `future` is what redo replays.
  past: GraphSnapshot[];
  future: GraphSnapshot[];

  // Actions
  setNodes: (nodes: Node<NodeData>[]) => void;
  setEdges: (edges: Edge[]) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => boolean; // returns false if cycle detected
  addNode: (type: string, label: string, position: { x: number; y: number }) => void;
  removeNode: (id: string) => void;
  removeEdge: (id: string) => void;
  selectNode: (id: string | null) => void;
  /** Persistently highlight a connecting edge. Pass the same id again to clear. */
  selectEdge: (id: string | null) => void;
  /** Set (or clear, with `null`) the runtime condition on an edge (B1.2). */
  updateEdgeCondition: (id: string, condition: Condition | null) => void;
  updateNodeConfig: (id: string, config: Record<string, unknown>) => void;
  updateNodeLabel: (id: string, label: string) => void;
  updateNodeStatus: (nodeKey: string, status: string) => void;
  clearCycleHighlight: () => void;
  markSaved: () => void;
  toGraph: () => Graph;

  // ── Workflow identity actions (D1.2) ──────────────────────────────────────
  /** Load a stored workflow: rebuild the canvas from `graph` and set identity. */
  fromGraph: (
    graph: Graph,
    meta: { workflowId: string; versionId: string; name: string; readOnly?: boolean },
  ) => void;
  /** Reset to the starter graph as a brand-new unsaved workflow. */
  newWorkflow: () => void;
  /** Record ids/name/read-only after a save, rename, or restore. */
  setWorkflowMeta: (
    meta: Partial<{ workflowId: string; versionId: string; name: string; isReadOnly: boolean }>,
  ) => void;
  /** Update the display name only (the actual rename is an API call). */
  setWorkflowName: (name: string) => void;

  // ── Version history actions (D1.3) ───────────────────────────────────────
  setVersions: (versions: VersionMeta[]) => void;

  /** Push a caller-captured snapshot onto the undo stack (used for node drags). */
  pushSnapshot: (snap: GraphSnapshot) => void;
  undo: () => void;
  redo: () => void;
}

// ─── Default positions ────────────────────────────────────────────────────────

let _nodeCounter = 0;
function nextId() { return `node-${++_nodeCounter}`; }

// ─── Starter graph ────────────────────────────────────────────────────────────
// The canvas opens with the reference ML pipeline from PROJECT_GUIDE.md §1 so a
// first-time visitor sees a real, runnable workflow instead of a blank page.
// It is pre-filled with valid config and marked clean (not dirty).

function starterGraph(): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const mk = (
    id: string,
    label: string,
    nodeType: string,
    config: Record<string, unknown>,
    x: number,
    y: number,
  ): Node<NodeData> => ({
    id,
    position: { x, y },
    type: 'dagNode',
    data: { label, nodeType, config, status: 'PENDING' },
  });

  _nodeCounter = 4;
  const nodes: Node<NodeData>[] = [
    mk('node-1', 'Data source', 'data.source',
      { csvPath: 'python/data/titanic.csv' }, 0, 120),
    mk('node-2', 'Preprocess', 'pandas.preprocess',
      { scriptPath: 'preprocess.py', csvPath: '{{ nodes.node-1.output.csvPath }}', targetColumn: 'Survived', testSize: 0.2 }, 260, 120),
    mk('node-3', 'Train model', 'torch.train',
      { scriptPath: 'train.py', modelType: 'randomforest', epochs: 10, outputWeightsPath: 'model.joblib',
        trainPath: '{{ nodes.node-2.output.trainPath }}',
        targetColumn: '{{ nodes.node-2.output.targetColumn }}' }, 520, 120),
    mk('node-4', 'Evaluate', 'model.evaluate',
      { scriptPath: 'evaluate.py', minAccuracy: 0.6,
        weightsPath: '{{ nodes.node-3.output.weightsPath }}',
        testPath: '{{ nodes.node-2.output.testPath }}',
        targetColumn: '{{ nodes.node-2.output.targetColumn }}' }, 780, 120),
  ];

  const edge = (from: string, to: string): Edge => ({
    id: `e-${from}-${to}`,
    source: from,
    target: to,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed },
  });

  const edges: Edge[] = [
    edge('node-1', 'node-2'),
    edge('node-2', 'node-3'),
    edge('node-3', 'node-4'),
  ];

  return { nodes, edges };
}

const _starter = starterGraph();

const DEFAULT_WORKFLOW_NAME = 'Untitled workflow';

/**
 * Inverse of `toGraph()` — rebuilds React Flow nodes/edges from a stored
 * `Graph`. Also resets `_nodeCounter` past the highest `node-N` id so the next
 * `addNode` can't collide with a loaded node.
 */
function graphToFlow(graph: Graph): { nodes: Node<NodeData>[]; edges: Edge[] } {
  let maxN = 0;
  const nodes: Node<NodeData>[] = graph.nodes.map((n) => {
    const m = /^node-(\d+)$/.exec(n.key);
    if (m) maxN = Math.max(maxN, Number(m[1]));
    return {
      id: n.key,
      position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
      type: 'dagNode',
      data: {
        label: n.label,
        nodeType: n.type,
        config: (n.config ?? {}) as Record<string, unknown>,
        status: 'PENDING',
      },
    };
  });
  _nodeCounter = maxN;

  const edges: Edge[] = graph.edges.map((e) => ({
    id: `e-${e.from}-${e.to}`,
    source: e.from,
    target: e.to,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed },
    ...(e.condition ? { data: { condition: e.condition } satisfies DagEdgeData } : {}),
  }));

  return { nodes, edges };
}

/**
 * Drops entries whose value is empty / null / undefined so optional config
 * fields (`z.string().min(1).optional()`) don't get rejected as empty strings,
 * and coerces the few numeric fields the API expects as real numbers rather
 * than the strings an <input> produces.
 */
const NUMERIC_CONFIG_KEYS = new Set(['epochs', 'minAccuracy', 'testSize', 'maxFanOut']);
/** Config fields the API expects as a string array but the UI edits as a comma list. */
const LIST_CONFIG_KEYS = new Set(['subgraph']);

function sanitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value === '' || value === null || value === undefined) continue;
    if (NUMERIC_CONFIG_KEYS.has(key) && typeof value === 'string') {
      const n = Number(value);
      if (!Number.isNaN(n)) out[key] = n;
      continue;
    }
    if (LIST_CONFIG_KEYS.has(key) && typeof value === 'string') {
      const items = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (items.length > 0) out[key] = items;
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ─── History helper ───────────────────────────────────────────────────────────

/**
 * Returns the `past` / `future` updates to merge into a `set` call that is about
 * to make a structural edit: pushes the current topology onto the undo stack
 * (trimmed to HISTORY_LIMIT) and discards any redo history.
 *
 * If the current topology is byte-for-byte the last thing we recorded (same
 * array refs — e.g. two drag-starts with no move between them), it returns an
 * empty patch so we don't stack redundant, no-op undo steps.
 */
function withHistory(s: GraphState): Partial<GraphState> {
  const last = s.past[s.past.length - 1];
  if (last && last.nodes === s.nodes && last.edges === s.edges) return {};
  return {
    past: [...s.past, { nodes: s.nodes, edges: s.edges }].slice(-HISTORY_LIMIT),
    future: [],
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: _starter.nodes,
  edges: _starter.edges,
  selectedNodeId: null,
  selectedEdgeId: null,
  isDirty: false,
  cycleHighlight: [],
  workflowId: null,
  versionId: null,
  workflowName: DEFAULT_WORKFLOW_NAME,
  versions: [],
  isReadOnly: false,
  past: [],
  future: [],

  setNodes: (nodes) => set({ nodes, isDirty: true }),
  setEdges: (edges) => set({ edges, isDirty: true }),

  /**
   * onNodesChange / onEdgesChange: React Flow calls these with a diff of
   * changes (move, select, remove). We must apply them through the store
   * — not directly on local component state — so Zustand stays the single
   * source of truth and any selector watching `nodes` sees the update.
   *
   * We only mark the canvas dirty for changes that actually mutate the graph
   * structure or positions. `select` and `dimensions` changes are cosmetic
   * and should NOT mark the workflow as needing a save — doing so would
   * disable the Run button every time the user clicks a node.
   */
  onNodesChange: (changes) =>
    set((s) => {
      const DIRTY_TYPES = new Set(['position', 'remove', 'add', 'reset']);
      const makesDirty = changes.some((c) => DIRTY_TYPES.has(c.type));
      // History for keyboard deletes is recorded once, up front, in
      // `onBeforeDelete` (App.tsx) — a node delete + its cascading edge deletes
      // arrive as separate change batches, so snapshotting here would split one
      // user action into two undo steps.
      return {
        nodes: applyNodeChanges(changes, s.nodes) as Node<NodeData>[],
        isDirty: s.isDirty || makesDirty,
      };
    }),

  onEdgesChange: (changes) =>
    set((s) => {
      const makesDirty = changes.some((c) => c.type !== 'select');
      // Drop the persistent highlight if its edge was removed.
      const removed = changes.some((c) => c.type === 'remove' && c.id === s.selectedEdgeId);
      return {
        edges: applyEdgeChanges(changes, s.edges),
        isDirty: s.isDirty || makesDirty,
        selectedEdgeId: removed ? null : s.selectedEdgeId,
      };
    }),

  /**
   * selectEdge: toggle a persistent highlight on a connecting edge. Unlike
   * React Flow's built-in selection (which clears the moment you click a node
   * or the pane), this stays lit until the same edge is clicked again, another
   * edge is picked, or the empty canvas is clicked.
   */
  selectEdge: (id) =>
    set((s) => {
      const next = s.selectedEdgeId === id ? null : id;
      // Node and edge inspectors are mutually exclusive — picking an edge
      // dismisses the node form so the edge inspector can take the panel.
      return { selectedEdgeId: next, selectedNodeId: next ? null : s.selectedNodeId };
    }),

  /**
   * updateEdgeCondition: attach, edit, or (with `null`) remove the runtime
   * gate on an edge. Read-only when viewing a historical version. Recorded in
   * undo history so Ctrl+Z reverts a condition edit like any structural change.
   */
  updateEdgeCondition: (id, condition) => {
    if (get().isReadOnly) return;
    set((s) => ({
      ...withHistory(s),
      edges: s.edges.map((e) => {
        if (e.id !== id) return e;
        const data = { ...(e.data as DagEdgeData | undefined) };
        if (condition) data.condition = condition;
        else delete data.condition;
        return { ...e, data };
      }),
      isDirty: true,
    }));
  },

  removeEdge: (id) => {
    if (get().isReadOnly) return;
    set((s) => ({
      ...withHistory(s),
      edges: s.edges.filter((e) => e.id !== id),
      selectedEdgeId: s.selectedEdgeId === id ? null : s.selectedEdgeId,
      isDirty: true,
    }));
  },

  /**
   * onConnect: called when the user draws an edge between two handles.
   *
   * Before accepting the connection we run the same `detectCycle` from
   * @dag/graph-core that the server runs on POST /workflows. This gives
   * instant visual feedback in the browser — the rejected cycle flashes red —
   * while the server remains the authority (it will also reject on save).
   *
   * Zero-dependency rule payoff: because graph-core has no Node.js APIs,
   * it runs in the browser without any bundler shim.
   */
  onConnect: (connection) => {
    if (get().isReadOnly) return false;
    const { nodes, edges } = get();
    const candidateEdges = [
      ...edges,
      { id: `e-${connection.source}-${connection.target}`, ...connection },
    ];

    // Build a minimal Graph to run cycle detection
    const graphForCycleCheck: Graph = {
      nodes: nodes.map((n) => ({
        key: n.id,
        label: n.data.label,
        // NodeData.nodeType/config are intentionally loosely typed
        // (Record<string, unknown>) since the canvas holds every node type
        // uniformly; Graph's per-type discriminated union can't be narrowed
        // from that shape without knowing which type it is ahead of time.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: n.data.nodeType as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: n.data.config as any,
        position: { x: n.position.x, y: n.position.y },
      })),
      edges: candidateEdges.map((e) => ({
        from: e.source!,
        to: e.target!,
      })),
    };

    const { hasCycle, path } = detectCycle(graphForCycleCheck);
    if (hasCycle && path) {
      set({ cycleHighlight: path });
      // Auto-clear after 2 s
      setTimeout(() => set({ cycleHighlight: [] }), 2000);
      return false; // caller should NOT add the edge
    }

    set((s) => ({
      ...withHistory(s),
      edges: [
        ...s.edges,
        {
          id: `e-${connection.source}-${connection.target}-${Date.now()}`,
          source: connection.source!,
          target: connection.target!,
          sourceHandle: connection.sourceHandle ?? undefined,
          targetHandle: connection.targetHandle ?? undefined,
          animated: false,
          type: 'smoothstep',
          markerEnd: { type: MarkerType.ArrowClosed },
        },
      ],
      isDirty: true,
    }));
    return true;
  },

  addNode: (type, label, position) => {
    if (get().isReadOnly) return;
    const id = nextId();
    const newNode: Node<NodeData> = {
      id,
      position,
      type: 'dagNode',
      data: { label, nodeType: type, config: {}, status: 'PENDING' },
    };
    set((s) => ({ ...withHistory(s), nodes: [...s.nodes, newNode], isDirty: true }));
  },

  selectNode: (id) =>
    set((s) => ({ selectedNodeId: id, selectedEdgeId: id ? null : s.selectedEdgeId })),

  /**
   * removeNode: removes a node and all edges that reference it.
   * Also clears selectedNodeId if the removed node was selected.
   */
  removeNode: (id) => {
    if (get().isReadOnly) return;
    set((s) => {
      const edges = s.edges.filter((e) => e.source !== id && e.target !== id);
      const stillHasSelectedEdge = edges.some((e) => e.id === s.selectedEdgeId);
      return {
        ...withHistory(s),
        nodes: s.nodes.filter((n) => n.id !== id),
        edges,
        selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
        selectedEdgeId: stillHasSelectedEdge ? s.selectedEdgeId : null,
        isDirty: true,
      };
    });
  },

  updateNodeConfig: (id, config) => {
    if (get().isReadOnly) return;
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, config } } : n,
      ),
      isDirty: true,
    }));
  },

  /**
   * updateNodeLabel: updates the visible label on a node.
   * Kept separate from updateNodeConfig because label is stored in
   * data.label (shown in the node header) whereas config holds
   * the execution parameters.
   */
  updateNodeLabel: (id, label) => {
    if (get().isReadOnly) return;
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, label } } : n,
      ),
      isDirty: true,
    }));
  },

  updateNodeStatus: (nodeKey, status) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeKey ? { ...n, data: { ...n.data, status } } : n,
      ),
    })),

  clearCycleHighlight: () => set({ cycleHighlight: [] }),
  markSaved: () => set({ isDirty: false }),

  // ── Workflow identity (D1.2) ────────────────────────────────────────────────

  fromGraph: (graph, meta) => {
    const { nodes, edges } = graphToFlow(graph);
    set({
      nodes,
      edges,
      workflowId: meta.workflowId,
      versionId: meta.versionId,
      workflowName: meta.name,
      isReadOnly: meta.readOnly ?? false,
      isDirty: false,
      selectedNodeId: null,
      selectedEdgeId: null,
      cycleHighlight: [],
      past: [],
      future: [],
    });
  },

  newWorkflow: () => {
    const fresh = starterGraph(); // also resets _nodeCounter to 4
    set({
      nodes: fresh.nodes,
      edges: fresh.edges,
      workflowId: null,
      versionId: null,
      workflowName: DEFAULT_WORKFLOW_NAME,
      versions: [],
      isReadOnly: false,
      isDirty: false,
      selectedNodeId: null,
      selectedEdgeId: null,
      cycleHighlight: [],
      past: [],
      future: [],
    });
  },

  setWorkflowMeta: (meta) =>
    set((s) => ({
      workflowId: meta.workflowId ?? s.workflowId,
      versionId: meta.versionId ?? s.versionId,
      workflowName: meta.name ?? s.workflowName,
      isReadOnly: meta.isReadOnly ?? s.isReadOnly,
    })),

  setWorkflowName: (name) => set({ workflowName: name }),

  setVersions: (versions) => set({ versions }),

  // ── Undo / redo ────────────────────────────────────────────────────────────

  pushSnapshot: (snap) =>
    set((s) => ({
      past: [...s.past, snap].slice(-HISTORY_LIMIT),
      future: [],
    })),

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return {};
      return {
        nodes: prev.nodes,
        edges: prev.edges,
        past: s.past.slice(0, -1),
        future: [{ nodes: s.nodes, edges: s.edges }, ...s.future].slice(0, HISTORY_LIMIT),
        selectedNodeId: null,
        selectedEdgeId: null,
        cycleHighlight: [],
        isDirty: true,
      };
    }),

  redo: () =>
    set((s) => {
      const next = s.future[0];
      if (!next) return {};
      return {
        nodes: next.nodes,
        edges: next.edges,
        past: [...s.past, { nodes: s.nodes, edges: s.edges }].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
        selectedNodeId: null,
        selectedEdgeId: null,
        cycleHighlight: [],
        isDirty: true,
      };
    }),

  /**
   * Serialise the canvas to the Graph contract shape for the API.
   */
  toGraph: (): Graph => {
    const { nodes, edges } = get();
    return {
      nodes: nodes.map((n) => ({
        key: n.id,
        label: n.data.label,
        // NodeData.nodeType/config are intentionally loosely typed
        // (Record<string, unknown>) since the canvas holds every node type
        // uniformly; Graph's per-type discriminated union can't be narrowed
        // from that shape without knowing which type it is ahead of time.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: n.data.nodeType as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: sanitizeConfig(n.data.config) as any,
        position: { x: n.position.x, y: n.position.y },
      })),
      edges: edges.map((e) => {
        const condition = serializeCondition((e.data as DagEdgeData | undefined)?.condition);
        return condition
          ? { from: e.source, to: e.target, condition }
          : { from: e.source, to: e.target };
      }),
    };
  },
}));
