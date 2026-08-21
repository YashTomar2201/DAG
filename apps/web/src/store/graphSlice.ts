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
import type { Graph } from '@dag/contracts';

// ─── Types ────────────────────────────────────────────────────────────────────

export type NodeData = Record<string, unknown> & {
  label: string;
  nodeType: string; // 'kaggle.download' | 'pandas.preprocess' | etc.
  config: Record<string, unknown>;
  status?: string;  // PENDING | QUEUED | RUNNING | SUCCEEDED | FAILED | SKIPPED
};

export interface GraphState {
  nodes: Node<NodeData>[];
  edges: Edge[];
  selectedNodeId: string | null;
  isDirty: boolean;
  cycleHighlight: string[]; // node ids in a rejected cycle

  // Actions
  setNodes: (nodes: Node<NodeData>[]) => void;
  setEdges: (edges: Edge[]) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => boolean; // returns false if cycle detected
  addNode: (type: string, label: string, position: { x: number; y: number }) => void;
  selectNode: (id: string | null) => void;
  updateNodeConfig: (id: string, config: Record<string, unknown>) => void;
  updateNodeStatus: (nodeKey: string, status: string) => void;
  clearCycleHighlight: () => void;
  markSaved: () => void;
  toGraph: () => Graph;
}

// ─── Default positions ────────────────────────────────────────────────────────

let _nodeCounter = 0;
function nextId() { return `node-${++_nodeCounter}`; }

// ─── Store ────────────────────────────────────────────────────────────────────

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,
  isDirty: false,
  cycleHighlight: [],

  setNodes: (nodes) => set({ nodes, isDirty: true }),
  setEdges: (edges) => set({ edges, isDirty: true }),

  /**
   * onNodesChange / onEdgesChange: React Flow calls these with a diff of
   * changes (move, select, remove). We must apply them through the store
   * — not directly on local component state — so Zustand stays the single
   * source of truth and any selector watching `nodes` sees the update.
   */
  onNodesChange: (changes) =>
    set((s) => ({
      nodes: applyNodeChanges(changes, s.nodes) as Node<NodeData>[],
      isDirty: true,
    })),

  onEdgesChange: (changes) =>
    set((s) => ({
      edges: applyEdgeChanges(changes, s.edges),
      isDirty: true,
    })),

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
    const id = nextId();
    const newNode: Node<NodeData> = {
      id,
      position,
      type: 'dagNode',
      data: { label, nodeType: type, config: {}, status: 'PENDING' },
    };
    set((s) => ({ nodes: [...s.nodes, newNode], isDirty: true }));
  },

  selectNode: (id) => set({ selectedNodeId: id }),

  updateNodeConfig: (id, config) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, config } } : n,
      ),
      isDirty: true,
    })),

  updateNodeStatus: (nodeKey, status) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeKey ? { ...n, data: { ...n.data, status } } : n,
      ),
    })),

  clearCycleHighlight: () => set({ cycleHighlight: [] }),
  markSaved: () => set({ isDirty: false }),

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
        config: n.data.config as any,
        position: { x: n.position.x, y: n.position.y },
      })),
      edges: edges.map((e) => ({ from: e.source, to: e.target })),
    };
  },
}));
