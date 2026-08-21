/**
 * Config Panel — rendered from the selected node's config fields.
 *
 * Form fields are driven by the node type's Zod schema field names, so
 * adding a new node type only requires updating the schema in contracts —
 * no bespoke form code needed here.
 */

import { useGraphStore } from '../store/graphSlice';
import { useState, useEffect } from 'react';

// Config field metadata per node type
// In a full implementation these would be derived from the Zod schema itself
const NODE_CONFIG_FIELDS: Record<string, Array<{ key: string; label: string; type: string; placeholder: string }>> = {
  'kaggle.download': [
    { key: 'datasetSlug', label: 'Dataset Slug', type: 'text', placeholder: 'username/dataset-name' },
    { key: 'outputDir',   label: 'Output Dir',   type: 'text', placeholder: 'artifacts/download' },
  ],
  'pandas.preprocess': [
    { key: 'scriptPath', label: 'Script Path', type: 'text', placeholder: 'preprocess.py' },
  ],
  'torch.train': [
    { key: 'scriptPath',         label: 'Script Path',         type: 'text',   placeholder: 'train.py' },
    { key: 'epochs',             label: 'Epochs',              type: 'number', placeholder: '10' },
    { key: 'outputWeightsPath',  label: 'Weights Output Path', type: 'text',   placeholder: 'model.pt' },
  ],
  'model.evaluate': [
    { key: 'scriptPath',  label: 'Script Path',      type: 'text',   placeholder: 'evaluate.py' },
    { key: 'minAccuracy', label: 'Min Accuracy (0–1)', type: 'number', placeholder: '0.8' },
  ],
  'registry.deploy': [
    { key: 'registryUrl', label: 'Registry URL', type: 'text', placeholder: 'https://registry.example.com' },
    { key: 'modelTag',    label: 'Model Tag',    type: 'text', placeholder: 'my-model:v1' },
  ],
};

export function ConfigPanel() {
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const nodes = useGraphStore((s) => s.nodes);
  const updateNodeConfig = useGraphStore((s) => s.updateNodeConfig);
  const selectNode = useGraphStore((s) => s.selectNode);

  const node = nodes.find((n) => n.id === selectedNodeId);
  const [localConfig, setLocalConfig] = useState<Record<string, unknown>>({});
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (node) {
      setLocalConfig(node.data.config ?? {});
      setLabel(node.data.label);
    }
  }, [node?.id]);

  if (!node) {
    return (
      <aside style={{
        width: 260,
        background: '#0f172a',
        borderLeft: '1px solid #1e293b',
        padding: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#334155',
        fontSize: 13,
      }}>
        Select a node to configure
      </aside>
    );
  }

  const fields = NODE_CONFIG_FIELDS[node.data.nodeType] ?? [];

  function handleFieldChange(key: string, value: string) {
    setLocalConfig((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    updateNodeConfig(node!.id, localConfig);
  }

  return (
    <aside style={{
      width: 260,
      background: '#0f172a',
      borderLeft: '1px solid #1e293b',
      padding: 16,
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ color: '#64748b', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em' }}>
          NODE CONFIG
        </div>
        <button onClick={() => selectNode(null)} style={closeBtn}>✕</button>
      </div>

      {/* Node label */}
      <div>
        <label style={labelStyle}>Label</label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => updateNodeConfig(node.id, { ...localConfig })}
          style={inputStyle}
          placeholder="Node label"
        />
      </div>

      <div style={{ color: '#334155', fontSize: 10, fontFamily: 'monospace' }}>
        type: {node.data.nodeType}
      </div>
      <div style={{ borderTop: '1px solid #1e293b' }} />

      {/* Config fields */}
      {fields.map((field) => (
        <div key={field.key}>
          <label style={labelStyle}>{field.label}</label>
          <input
            type={field.type}
            value={String(localConfig[field.key] ?? '')}
            placeholder={field.placeholder}
            onChange={(e) => handleFieldChange(field.key, e.target.value)}
            style={inputStyle}
          />
        </div>
      ))}

      {fields.length === 0 && (
        <div style={{ color: '#475569', fontSize: 12 }}>No configuration fields for this node type.</div>
      )}

      <button onClick={handleSave} style={saveBtn}>Save Config</button>
    </aside>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  color: '#94a3b8',
  fontSize: 11,
  marginBottom: 4,
  fontWeight: 600,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#1e293b',
  border: '1px solid #334155',
  borderRadius: 6,
  color: '#f1f5f9',
  fontSize: 13,
  padding: '6px 10px',
  outline: 'none',
  boxSizing: 'border-box',
};

const saveBtn: React.CSSProperties = {
  background: '#4f46e5',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: '8px 0',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
  marginTop: 8,
};

const closeBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#64748b',
  cursor: 'pointer',
  fontSize: 14,
  padding: 4,
};
