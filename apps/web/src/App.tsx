import { useCallback, useState, useRef, useEffect, useMemo, type DragEvent } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MarkerType,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useGraphStore, type GraphSnapshot } from './store/graphSlice';
import { useRunStore } from './store/runSlice';
import { CustomNode } from './components/CustomNode';
import { NodePalette } from './components/NodePalette';
import { ConfigPanel } from './components/ConfigPanel';
import { LogDrawer } from './components/LogDrawer';
import { RunHistory } from './components/RunHistory';

import { createWorkflow, saveWorkflowVersion, startRun, openRunEventStream, ApiError } from './api/client';
import { LogoMark, IconPlay, IconSpinner, IconCheck, IconAlert, IconClose, IconUndo, IconRedo } from './components/icons';

type Notice = { kind: 'error' | 'success'; text: string };

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.toDisplayMessage();
  if (err instanceof Error) return err.message;
  return String(err);
}

const nodeTypes = {
  dagNode: CustomNode,
};

// ─── Inner canvas component (must be inside ReactFlowProvider) ─────────────────

function AppCanvas() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const selectedEdgeId = useGraphStore((s) => s.selectedEdgeId);
  const selectEdge = useGraphStore((s) => s.selectEdge);
  const isDirty = useGraphStore((s) => s.isDirty);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const onConnectStore = useGraphStore((s) => s.onConnect);
  const selectNode = useGraphStore((s) => s.selectNode);
  const addNode = useGraphStore((s) => s.addNode);
  const markSaved = useGraphStore((s) => s.markSaved);
  const toGraph = useGraphStore((s) => s.toGraph);
  const undo = useGraphStore((s) => s.undo);
  const redo = useGraphStore((s) => s.redo);
  const pushSnapshot = useGraphStore((s) => s.pushSnapshot);
  const canUndo = useGraphStore((s) => s.past.length > 0);
  const canRedo = useGraphStore((s) => s.future.length > 0);

  const activeRunId = useRunStore((s) => s.activeRunId);
  const runStatus = useRunStore((s) => s.runStatus);
  const startListening = useRunStore((s) => s.startListening);
  const applyEvent = useRunStore((s) => s.applyEvent);
  const addRun = useRunStore((s) => s.addRun);

  // Access the ReactFlow instance for accurate coordinate conversion
  const { screenToFlowPosition, fitView } = useReactFlow();
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  // The `fitView` prop runs once on mount, sometimes before the flex layout has
  // given the canvas its final size. Re-fit when the canvas element actually
  // changes size (ResizeObserver), which also covers window resizes — but only
  // once it has a non-zero box, so React Flow never computes a NaN transform.
  useEffect(() => {
    const el = reactFlowWrapper.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width < 1 || rect.height < 1) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fitView({ padding: 0.2, duration: 200 }));
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [fitView]);

  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Auto-dismiss success toasts; errors stay until the user acts or dismisses.
  useEffect(() => {
    if (notice?.kind === 'success') {
      const t = setTimeout(() => setNotice(null), 4000);
      return () => clearTimeout(t);
    }
  }, [notice]);

  // Undo / redo keyboard shortcuts. Ignored while typing in a form field so
  // Ctrl+Z still works normally inside the config panel inputs.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  const onConnect = useCallback(
    (connection: Connection) => onConnectStore(connection),
    [onConnectStore]
  );

  // Click an edge to keep it lit; click it again or click empty canvas to clear.
  const onEdgeClick = useCallback<EdgeMouseHandler>(
    (_evt, edge) => selectEdge(edge.id),
    [selectEdge],
  );
  const onPaneClick = useCallback(() => {
    selectEdge(null);
    selectNode(null);
  }, [selectEdge, selectNode]);

  // Node drags: capture the topology on drag-start, and only push it onto the
  // undo stack on drag-stop if a position actually changed — so a plain click
  // on a node never pollutes history or clears the redo stack.
  const preDragRef = useRef<GraphSnapshot | null>(null);
  const onNodeDragStart = useCallback(() => {
    const { nodes, edges } = useGraphStore.getState();
    preDragRef.current = { nodes, edges };
  }, []);
  const onNodeDragStop = useCallback(() => {
    const before = preDragRef.current;
    preDragRef.current = null;
    if (before && before.nodes !== useGraphStore.getState().nodes) {
      pushSnapshot(before);
    }
  }, [pushSnapshot]);

  // Keyboard delete (Backspace/Delete): React Flow removes the node and its
  // connected edges in separate change batches. Record ONE history snapshot of
  // the whole graph here, before any of it is applied, so a single undo brings
  // the node and its edges back together.
  const onBeforeDelete = useCallback(async () => {
    const { nodes, edges } = useGraphStore.getState();
    pushSnapshot({ nodes, edges });
    return true;
  }, [pushSnapshot]);

  // Apply the persistent highlight to whichever edge is selected. Done here
  // (not in the store) so it's a pure view concern and never marks the graph dirty.
  const displayEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) =>
        e.id === selectedEdgeId
          ? {
              ...e,
              animated: true,
              zIndex: 10,
              // Concrete hex, not a CSS var — SVG marker fill won't resolve var().
              style: { ...e.style, stroke: '#cc785c', strokeWidth: 2.5 },
              markerEnd: { type: MarkerType.ArrowClosed, color: '#cc785c' },
            }
          : e,
      ),
    [edges, selectedEdgeId],
  );

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();

      const type = event.dataTransfer.getData('application/dag-node-type');
      const label = event.dataTransfer.getData('application/dag-node-label');

      if (!type) return;

      // screenToFlowPosition correctly accounts for pan, zoom, and the
      // canvas container's offset — unlike raw clientX/Y with hardcoded offsets.
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      addNode(type, label, position);
    },
    [addNode, screenToFlowPosition]
  );

  /**
   * Required config fields per node type — mirrors the server-side Zod schemas
   * in packages/contracts/src/node-types.ts. Checked client-side so the user
   * gets a clear, immediate error instead of a raw 400 from the API.
   */
  const REQUIRED_CONFIG: Record<string, string[]> = {
    'kaggle.download':   ['datasetSlug', 'outputDir'],
    'registry.deploy':   ['registryUrl', 'modelTag'],
  };

  function validateGraphForSave(): string | null {
    if (nodes.length === 0) {
      return 'Add at least one node to the canvas before saving.';
    }

    const errors: string[] = [];
    for (const node of nodes) {
      const required = REQUIRED_CONFIG[node.data.nodeType] ?? [];
      const missing = required.filter(
        (field) => !node.data.config[field] || String(node.data.config[field]).trim() === ''
      );
      if (missing.length > 0) {
        errors.push(`"${node.data.label}" is missing: ${missing.join(', ')}`);
      }
    }

    return errors.length > 0
      ? `Fix these nodes before saving:\n${errors.map(e => `  • ${e}`).join('\n')}`
      : null;
  }

  async function handleSave() {
    if (isSaving) return;
    setNotice(null);

    const validationError = validateGraphForSave();
    if (validationError) {
      setNotice({ kind: 'error', text: validationError });
      return;
    }

    setIsSaving(true);
    try {
      const graph = toGraph();
      if (!workflowId) {
        // POST /workflows → { workflowId, versionId }
        const result = await createWorkflow('My Pipeline', graph);
        setWorkflowId(result.workflowId);
        setVersionId(result.versionId);
        setNotice({ kind: 'success', text: 'Pipeline saved.' });
      } else {
        // POST /workflows/:id/versions → full WorkflowVersion row
        const version = await saveWorkflowVersion(workflowId, graph);
        setVersionId(version.id);
        setNotice({ kind: 'success', text: `Saved as version ${version.version}.` });
      }
      markSaved();
    } catch (err) {
      setNotice({ kind: 'error', text: describeError(err) });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRun() {
    if (isRunning) return;
    if (!versionId) {
      setNotice({ kind: 'error', text: 'Save the pipeline first, then run it.' });
      return;
    }
    if (isDirty) {
      setNotice({ kind: 'error', text: 'You have unsaved changes — save them before running.' });
      return;
    }

    setNotice(null);
    setIsRunning(true);
    try {
      // POST /runs → bare RunRecord (no nodeRuns inline)
      const run = await startRun(versionId);

      // Push run into the store so RunHistory panel shows it immediately
      addRun(run);

      // IMPORTANT: call startListening BEFORE opening the SSE stream.
      let sseCleanup = () => {};
      startListening(run.id, () => sseCleanup());

      sseCleanup = openRunEventStream(
        run.id,
        undefined,
        (type, data) => applyEvent(type, data),
        (err) => console.error('SSE Error:', err),
      );
      setNotice({ kind: 'success', text: 'Run started — watch the nodes light up.' });
    } catch (err) {
      setNotice({ kind: 'error', text: describeError(err) });
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100vh', background: 'var(--color-canvas)', overflow: 'hidden' }}>
      {/* Top Navigation */}
      <header style={{
        height: '60px',
        backgroundColor: 'var(--color-canvas)',
        color: 'var(--color-ink)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px 0 24px',
        borderBottom: '1px solid var(--color-hairline)',
        zIndex: 100,
        flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
          <LogoMark size={30} />
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.05 }}>
            <span style={{ fontSize: 22, fontWeight: 500, fontFamily: 'var(--font-display)', letterSpacing: '-0.3px', color: 'var(--color-ink)' }}>
              Nexus<span style={{ color: 'var(--color-primary)' }}>Flow</span>
            </span>
            <span className="caption-uppercase" style={{ fontSize: 9.5, color: 'var(--color-muted-soft)', letterSpacing: '1.6px' }}>
              Visual DAG Orchestrator
            </span>
          </div>
          <nav style={{ display: 'flex', gap: 24, marginLeft: 36, alignItems: 'center' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-ink)', borderBottom: '2px solid var(--color-primary)', paddingBottom: 4 }}>Editor</span>
          </nav>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginRight: 4 }}>
            <button
              className="btn-ghost"
              style={{ width: 32, height: 32, color: 'var(--color-body)' }}
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
            >
              <IconUndo size={17} />
            </button>
            <button
              className="btn-ghost"
              style={{ width: 32, height: 32, color: 'var(--color-body)' }}
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl+Shift+Z)"
              aria-label="Redo"
            >
              <IconRedo size={17} />
            </button>
          </div>
          <button
            className="btn-secondary"
            onClick={handleSave}
            disabled={isSaving || (!isDirty && !!workflowId)}
          >
            {isSaving && <IconSpinner size={15} />}
            {!isSaving && !isDirty && !!workflowId && <IconCheck size={15} />}
            {isSaving
              ? 'Saving…'
              : !workflowId
              ? 'Save pipeline'
              : isDirty
              ? 'Save changes'
              : 'Saved'}
          </button>
          <button
            className="btn-primary"
            onClick={handleRun}
            disabled={isRunning || isDirty || !versionId}
            title={!versionId ? 'Save the workflow first' : isDirty ? 'Save changes before running' : 'Run pipeline'}
          >
            {isRunning ? <IconSpinner size={16} /> : <IconPlay size={15} />}
            {isRunning ? 'Starting…' : 'Run pipeline'}
          </button>
        </div>
      </header>

      {/* Inline notice banner — errors (persistent) and success toasts (auto-dismiss) */}
      {notice && (
        <div
          className="animate-in"
          style={{
            background: notice.kind === 'error' ? 'var(--color-error-soft)' : 'var(--color-success-soft)',
            color: notice.kind === 'error' ? 'var(--color-error)' : '#3a7a48',
            borderBottom: `1px solid ${notice.kind === 'error' ? 'color-mix(in srgb, var(--color-error) 30%, transparent)' : 'color-mix(in srgb, var(--color-success) 35%, transparent)'}`,
            padding: '10px 24px',
            fontSize: 13,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 16,
            flexShrink: 0,
            whiteSpace: 'pre-line',
            lineHeight: 1.6,
            fontWeight: 500,
          }}
        >
          <span style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
            <span style={{ flexShrink: 0, marginTop: 1 }}>
              {notice.kind === 'error' ? <IconAlert size={15} /> : <IconCheck size={15} />}
            </span>
            {notice.text}
          </span>
          <button
            className="btn-ghost"
            style={{ color: 'inherit', width: 22, height: 22 }}
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
          >
            <IconClose size={14} />
          </button>
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <NodePalette />

        <main style={{ flex: 1, minWidth: 0, position: 'relative', background: 'var(--color-canvas)', padding: 20, display: 'flex' }}>
          {/* Run Status Indicator */}
          {activeRunId && (
            <div
              className="animate-in"
              style={{
                position: 'absolute',
                top: 22,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 10,
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '7px 16px',
                color: 'var(--color-on-dark)',
                fontWeight: 600,
                fontSize: 12,
                letterSpacing: '0.04em',
                background: 'var(--color-surface-dark)',
                borderRadius: 'var(--radius-pill)',
                border: '1px solid var(--color-surface-dark-elevated)',
                boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background:
                    runStatus === 'RUNNING'
                      ? 'var(--color-warning)'
                      : runStatus === 'SUCCEEDED'
                      ? 'var(--color-success)'
                      : runStatus === 'FAILED'
                      ? 'var(--color-error)'
                      : 'var(--color-muted-soft)',
                  animation: runStatus === 'RUNNING' ? 'pulse 1.2s ease-in-out infinite' : 'none',
                }}
              />
              {runStatus === 'RUNNING' ? 'Running' : runStatus === 'SUCCEEDED' ? 'Succeeded' : runStatus === 'FAILED' ? 'Failed' : String(runStatus ?? '')}
            </div>
          )}

          <RunHistory workflowId={workflowId} />

          {/* Product Surface: DAG Canvas */}
          <div
            ref={reactFlowWrapper}
            style={{
              flex: 1,
              minWidth: 0,
              position: 'relative',
              background: 'var(--color-surface-dark)',
              borderRadius: 'var(--radius-xl)',
              overflow: 'hidden',
              border: '1px solid var(--color-surface-dark-elevated)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03), 0 12px 40px rgba(20,20,19,0.10)',
            }}
          >
            <ReactFlow
              nodes={nodes}
              edges={displayEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onEdgeClick={onEdgeClick}
              onPaneClick={onPaneClick}
              onNodeDragStart={onNodeDragStart}
              onNodeDragStop={onNodeDragStop}
              onBeforeDelete={onBeforeDelete}
              nodeTypes={nodeTypes}
              onDragOver={onDragOver}
              onDrop={onDrop}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              nodeOrigin={[0.5, 0.5]}
              deleteKeyCode={['Backspace', 'Delete']}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="var(--color-surface-dark-elevated)" gap={18} size={1.5} />
              <Controls style={{ background: 'var(--color-surface-dark)', border: '1px solid var(--color-surface-dark-elevated)' }} />
            </ReactFlow>
          </div>

          <LogDrawer />
        </main>

        <ConfigPanel />
      </div>
    </div>
  );
}

// ─── Root export: wraps everything in ReactFlowProvider ───────────────────────

/**
 * App wraps AppCanvas in ReactFlowProvider.
 *
 * Why ReactFlowProvider here and not in main.tsx?
 *   useReactFlow() (used inside AppCanvas for screenToFlowPosition) can only
 *   be called inside a component that is a descendant of ReactFlowProvider.
 *   Placing the provider at the App level is the minimum wrapping scope
 *   and keeps main.tsx clean.
 */
export function App() {
  return (
    <ReactFlowProvider>
      <AppCanvas />
    </ReactFlowProvider>
  );
}

