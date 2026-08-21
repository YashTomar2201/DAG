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
    <div style={{ display: 'flex', width: '100vw', height: '100vh', background: '#020617', overflow: 'hidden' }}>
      <NodePalette />
      
      <main style={{ flex: 1, position: 'relative' }}>
        {/* Top Toolbar */}
        <div style={{
          position: 'absolute',
          top: 16,
          left: 16,
          zIndex: 10,
          display: 'flex',
          gap: 12,
          background: '#0f172a',
          padding: 8,
          borderRadius: 8,
          border: '1px solid #1e293b'
        }}>
          <button onClick={handleSave} style={btnStyle('#4f46e5')} disabled={!isDirty && !!workflowId}>
            {isDirty ? 'Save (Unsaved Changes)' : 'Saved'}
          </button>
          <button onClick={handleRun} style={btnStyle('#10b981')} disabled={isDirty || !versionId}>
            ▶ Run Pipeline
          </button>
          
          {activeRunId && (
            <div style={{
              display: 'flex', alignItems: 'center', padding: '0 12px',
              color: runStatus === 'RUNNING' ? '#facc15' : runStatus === 'SUCCEEDED' ? '#4ade80' : '#f87171',
              fontWeight: 600, fontSize: 13, background: '#1e293b', borderRadius: 4
            }}>
              Status: {runStatus}
            </div>
          )}
        </div>

        <RunHistory workflowId={workflowId} />

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
          <Background color="#334155" gap={16} />
          <Controls style={{ background: '#0f172a', border: '1px solid #1e293b' }} />
        </ReactFlow>

        <LogDrawer />
      </main>

      <ConfigPanel />
    </div>
  );
}

const btnStyle = (bg: string): React.CSSProperties => ({
  background: bg,
  color: '#fff',
  border: 'none',
  padding: '6px 16px',
  borderRadius: 6,
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
  opacity: 1
});
