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
        width: 300,
        background: 'var(--color-canvas)',
        borderLeft: '1px solid var(--color-hairline)',
        padding: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--color-muted)',
        fontSize: 14,
        textAlign: 'center',
        fontStyle: 'italic'
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
      width: 300,
      background: 'var(--color-surface-dark)',
      color: 'var(--color-on-dark)',
      borderLeft: '1px solid var(--color-surface-dark-soft)',
      padding: '32px 24px',
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 24,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div className="caption-uppercase" style={{ color: 'var(--color-on-dark-soft)' }}>
          Node Configuration
        </div>
        <button onClick={() => selectNode(null)} style={closeBtn}>✕</button>
      </div>

      {/* Node label */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label className="caption" style={{ color: 'var(--color-on-dark-soft)' }}>Label</label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => updateNodeConfig(node.id, { ...localConfig })}
          className="code"
          style={inputStyle}
          placeholder="Node label"
        />
      </div>

      <div className="code" style={{ color: 'var(--color-on-dark-soft)', fontSize: 11, opacity: 0.6 }}>
        type: {node.data.nodeType}
      </div>
      <div style={{ borderTop: '1px solid var(--color-surface-dark-soft)', margin: '8px 0' }} />

      {/* Config fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {fields.map((field) => (
          <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="caption" style={{ color: 'var(--color-on-dark-soft)' }}>{field.label}</label>
            <input
              type={field.type}
              value={String(localConfig[field.key] ?? '')}
              placeholder={field.placeholder}
              onChange={(e) => handleFieldChange(field.key, e.target.value)}
              className="code"
              style={inputStyle}
            />
          </div>
        ))}
      </div>

      {fields.length === 0 && (
        <div className="body-sm" style={{ color: 'var(--color-on-dark-soft)', opacity: 0.7 }}>No configuration fields for this node type.</div>
      )}

      <button onClick={handleSave} className="btn-primary" style={{ marginTop: 'auto' }}>Save Config</button>
    </aside>
  );
}


const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--color-surface-dark-soft)',
  border: '1px solid var(--color-surface-dark-elevated)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--color-on-dark)',
  fontSize: 13,
  padding: '8px 12px',
  outline: 'none',
  boxSizing: 'border-box',
};


const closeBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--color-on-dark-soft)',
  cursor: 'pointer',
  fontSize: 14,
  padding: 4,
};
