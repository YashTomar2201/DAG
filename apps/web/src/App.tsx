/**
 * Main application layout.
 * Assembles the React Flow canvas, node palette, config panel, run history, and log drawer.
 */

import { useCallback, useState } from 'react';
import { ReactFlow, Background, Controls, type Connection } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useGraphStore } from './store/graphSlice';
import { useRunStore } from './store/runSlice';
import { CustomNode } from './components/CustomNode';
import { NodePalette } from './components/NodePalette';
import { ConfigPanel } from './components/ConfigPanel';
import { LogDrawer } from './components/LogDrawer';
import { RunHistory } from './components/RunHistory';

import { createWorkflow, saveWorkflowVersion, startRun, openRunEventStream } from './api/client';

const nodeTypes = {
  dagNode: CustomNode,
};

export function App() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const isDirty = useGraphStore((s) => s.isDirty);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const onConnectStore = useGraphStore((s) => s.onConnect);
  const addNode = useGraphStore((s) => s.addNode);
  const markSaved = useGraphStore((s) => s.markSaved);
  const toGraph = useGraphStore((s) => s.toGraph);

  const activeRunId = useRunStore((s) => s.activeRunId);
  const runStatus = useRunStore((s) => s.runStatus);
  const startListening = useRunStore((s) => s.startListening);
  const applyEvent = useRunStore((s) => s.applyEvent);

  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);

  const onConnect = useCallback(
    (connection: Connection) => onConnectStore(connection),
    [onConnectStore]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData('application/dag-node-type');
      const label = event.dataTransfer.getData('application/dag-node-label');
      
      if (!type) return;

      // Simplistic drop position calculation
      const position = {
        x: event.clientX - 250, // offset for palette and node center
        y: event.clientY - 40,
      };

      addNode(type, label, position);
    },
    [addNode]
  );

  async function handleSave() {
    try {
      const graph = toGraph();
      if (!workflowId) {
        const wf = await createWorkflow('My Pipeline', graph);
        setWorkflowId(wf.id);
        setVersionId(wf.versions[0]?.id ?? null);
      } else {
        const v = await saveWorkflowVersion(workflowId, graph);
        setVersionId(v.id);
      }
      markSaved();
    } catch (err) {
      alert(`Save failed: ${err}`);
    }
  }

  async function handleRun() {
    if (!versionId) return alert('Save the workflow first!');
    if (isDirty) return alert('You have unsaved changes. Save before running.');

    try {
      const run = await startRun(versionId);
      
      const cleanup = openRunEventStream(
        run.id,
        undefined,
        (type, data) => applyEvent(type, data),
        (err) => console.error('SSE Error:', err)
      );

      startListening(run.id, cleanup);
    } catch (err) {
      alert(`Run failed: ${err}`);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100vh', background: 'var(--color-canvas)', overflow: 'hidden' }}>
      {/* Top Navigation */}
      <header style={{
        height: '64px',
        backgroundColor: 'var(--color-canvas)',
        color: 'var(--color-ink)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 32px',
        borderBottom: '1px solid var(--color-hairline)',
        zIndex: 100,
        flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* Anthropic-style radial spike mark */}
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M16 0L18.4 13.6L32 16L18.4 18.4L16 32L13.6 18.4L0 16L13.6 13.6L16 0Z" fill="var(--color-ink)"/>
            <path d="M6 6L14.5 14.5L16 12L7.5 3.5L6 6Z" fill="var(--color-ink)"/>
            <path d="M26 6L17.5 14.5L16 12L24.5 3.5L26 6Z" fill="var(--color-ink)"/>
            <path d="M26 26L17.5 17.5L16 20L24.5 28.5L26 26Z" fill="var(--color-ink)"/>
            <path d="M6 26L14.5 17.5L16 20L7.5 28.5L6 26Z" fill="var(--color-ink)"/>
          </svg>
          <span style={{ fontSize: 26, fontWeight: 400, fontFamily: 'var(--font-display)', letterSpacing: '-0.5px', color: 'var(--color-ink)', transform: 'translateY(1px)' }}>
            NexusFlow
          </span>
          <nav style={{ display: 'flex', gap: 28, marginLeft: 40 }}>
            <a href="#" className="text-link" style={{ fontSize: '14px', fontWeight: 500, color: 'var(--color-ink)' }}>Design Analysis</a>
            <a href="#" className="text-link" style={{ fontSize: '14px', fontWeight: 500, color: 'var(--color-muted)' }}>Workflows</a>
            <a href="#" className="text-link" style={{ fontSize: '14px', fontWeight: 500, color: 'var(--color-muted)' }}>Settings</a>
          </nav>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button className="btn-secondary" onClick={handleSave} disabled={!isDirty && !!workflowId}>
            {isDirty ? 'Save Changes' : 'Saved'}
          </button>
          <button className="btn-primary" onClick={handleRun} disabled={isDirty || !versionId}>
            ▶ Run Pipeline
          </button>
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <NodePalette />

        <main style={{ flex: 1, position: 'relative', background: 'var(--color-canvas)' }}>
          {/* Run Status Indicator */}
          {activeRunId && (
            <div style={{
              position: 'absolute',
              top: 24,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 10,
              display: 'flex', alignItems: 'center', padding: '6px 16px',
              color: runStatus === 'RUNNING' ? 'var(--color-warning)' : runStatus === 'SUCCEEDED' ? 'var(--color-success)' : 'var(--color-error)',
              fontWeight: 600, fontSize: 13, background: 'var(--color-surface-dark)', borderRadius: 'var(--radius-pill)',
              border: '1px solid var(--color-surface-dark-elevated)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
            }}>
              Status: {runStatus}
            </div>
          )}

          <RunHistory workflowId={workflowId} />

          {/* Product Surface: DAG Canvas */}
          <div style={{ width: '100%', height: '100%', background: 'var(--color-surface-dark)', borderRadius: 'var(--radius-lg)', margin: '24px', overflow: 'hidden', border: '1px solid var(--color-surface-dark-elevated)' }}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              onDragOver={onDragOver}
              onDrop={onDrop}
              fitView
            >
              <Background color="var(--color-surface-dark-soft)" gap={16} />
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

