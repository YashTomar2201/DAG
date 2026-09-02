/**
 * Config Panel — rendered from the selected node's config fields.
 *
 * Form fields are driven by the node type's Zod schema field names, so
 * adding a new node type only requires updating the schema in contracts —
 * no bespoke form code needed here.
 */

import { useGraphStore } from '../store/graphSlice';
import { NODE_ICON, IconNode, IconClose, IconTrash } from './icons';

// Config field metadata per node type
// In a full implementation these would be derived from the Zod schema itself
const NODE_CONFIG_FIELDS: Record<string, Array<{ key: string; label: string; type: string; placeholder: string }>> = {
  'kaggle.download': [
    { key: 'datasetSlug', label: 'Dataset Slug', type: 'text', placeholder: 'username/dataset-name' },
    { key: 'outputDir',   label: 'Output Dir',   type: 'text', placeholder: 'artifacts/download' },
  ],
  'pandas.preprocess': [
    { key: 'scriptPath',   label: 'Script Path',     type: 'text',   placeholder: 'preprocess.py' },
    { key: 'csvPath',      label: 'CSV Path',        type: 'text',   placeholder: 'python/data/titanic.csv' },
    { key: 'targetColumn', label: 'Target Column',   type: 'text',   placeholder: 'Survived' },
    { key: 'testSize',     label: 'Test Size (0–1)', type: 'number', placeholder: '0.2' },
  ],
  'torch.train': [
    { key: 'scriptPath',         label: 'Script Path',            type: 'text',   placeholder: 'train.py' },
    { key: 'modelType',          label: 'Model (randomforest / logreg)', type: 'text', placeholder: 'randomforest' },
    { key: 'epochs',             label: 'Epochs (trees / iters)', type: 'number', placeholder: '10' },
    { key: 'trainPath',          label: 'Train Data Ref',         type: 'text',   placeholder: '{{ nodes.<preprocess>.output.trainPath }}' },
    { key: 'targetColumn',       label: 'Target Column Ref',      type: 'text',   placeholder: '{{ nodes.<preprocess>.output.targetColumn }}' },
    { key: 'outputWeightsPath',  label: 'Weights Output Path',    type: 'text',   placeholder: 'model.joblib' },
  ],
  'model.evaluate': [
    { key: 'scriptPath',   label: 'Script Path',         type: 'text',   placeholder: 'evaluate.py' },
    { key: 'weightsPath',  label: 'Model Ref',           type: 'text',   placeholder: '{{ nodes.<train>.output.weightsPath }}' },
    { key: 'testPath',     label: 'Test Data Ref',       type: 'text',   placeholder: '{{ nodes.<preprocess>.output.testPath }}' },
    { key: 'targetColumn', label: 'Target Column Ref',   type: 'text',   placeholder: '{{ nodes.<preprocess>.output.targetColumn }}' },
    { key: 'minAccuracy',  label: 'Min Accuracy (0–1)',  type: 'number', placeholder: '0.6' },
  ],
  'registry.deploy': [
    { key: 'registryUrl', label: 'Registry URL', type: 'text', placeholder: 'https://registry.example.com' },
    { key: 'modelTag',    label: 'Model Tag',    type: 'text', placeholder: 'my-model:v1' },
    { key: 'weightsPath', label: 'Weights Ref (optional)', type: 'text', placeholder: '{{ nodes.<train>.output.weightsPath }}' },
  ],
};

export function ConfigPanel() {
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const nodes = useGraphStore((s) => s.nodes);
  const updateNodeConfig = useGraphStore((s) => s.updateNodeConfig);
  const updateNodeLabel = useGraphStore((s) => s.updateNodeLabel);
  const removeNode = useGraphStore((s) => s.removeNode);
  const selectNode = useGraphStore((s) => s.selectNode);

  const node = nodes.find((n) => n.id === selectedNodeId);

  // Collapse entirely when nothing is selected so the canvas gets the full width
  // (standard inspector-panel behaviour). The panel slides back in on selection.
  if (!node) return null;

  const fields = NODE_CONFIG_FIELDS[node.data.nodeType] ?? [];
  const config = node.data.config ?? {};
  const Icon = NODE_ICON[node.data.nodeType] ?? IconNode;

  // Edits apply straight to the canvas store (which flips `isDirty`), so the
  // single "Save Changes" button in the header is the only save the user needs.
  // Values are held as raw strings while editing (so partial input like "0."
  // doesn't get mangled); graphSlice.sanitizeConfig coerces numeric fields to
  // real numbers when the graph is serialised for the API.
  function handleFieldChange(key: string, raw: string) {
    updateNodeConfig(node!.id, { ...config, [key]: raw });
  }

  return (
    <aside
      className="animate-in"
      style={{
        width: 300,
        flexShrink: 0,
        background: 'var(--color-surface-dark)',
        color: 'var(--color-on-dark)',
        borderLeft: '1px solid var(--color-surface-dark-soft)',
        padding: '20px 22px 24px',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            className="dag-node__icon"
            style={{ ['--node-accent' as string]: 'var(--color-primary)', width: 28, height: 28 }}
          >
            <Icon size={16} />
          </span>
          <span className="caption-uppercase" style={{ color: 'var(--color-on-dark-soft)', fontSize: 11 }}>
            Configure
          </span>
        </div>
        <button className="btn-ghost" style={{ color: 'var(--color-on-dark-soft)' }} onClick={() => selectNode(null)} aria-label="Close panel">
          <IconClose size={15} />
        </button>
      </div>

      {/* Node label */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <label className="caption" style={{ color: 'var(--color-on-dark-soft)' }}>Label</label>
        <input
          value={node.data.label}
          onChange={(e) => updateNodeLabel(node!.id, e.target.value)}
          className="input-dark"
          placeholder="Node label"
        />
        <span className="code" style={{ color: 'var(--color-on-dark-soft)', fontSize: 11, opacity: 0.55 }}>
          {node.data.nodeType}
        </span>
      </div>

      <div style={{ borderTop: '1px solid var(--color-surface-dark-soft)' }} />

      {/* Config fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {fields.map((field) => (
          <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="caption" style={{ color: 'var(--color-on-dark-soft)' }}>{field.label}</label>
            <input
              type={field.type}
              value={String(config[field.key] ?? '')}
              placeholder={field.placeholder}
              onChange={(e) => handleFieldChange(field.key, e.target.value)}
              className="input-dark"
            />
          </div>
        ))}
        {fields.length === 0 && (
          <div className="body-sm" style={{ color: 'var(--color-on-dark-soft)', opacity: 0.7 }}>
            No configuration fields for this node type.
          </div>
        )}
      </div>

      <div className="body-sm" style={{ color: 'var(--color-on-dark-soft)', opacity: 0.55, marginTop: 'auto', fontSize: 12 }}>
        Edits apply to the canvas as you type. Hit <strong>Save Changes</strong> in the header to store a new version.
      </div>

      <button
        onClick={() => removeNode(node!.id)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          background: 'transparent',
          border: '1px solid color-mix(in srgb, var(--color-error) 55%, transparent)',
          color: 'var(--color-error)',
          borderRadius: 'var(--radius-md)',
          padding: '9px 16px',
          cursor: 'pointer',
          fontSize: 13,
          fontFamily: 'var(--font-body)',
          fontWeight: 500,
          transition: 'background 0.15s',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'color-mix(in srgb, var(--color-error) 14%, transparent)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
      >
        <IconTrash size={15} />
        Delete node
      </button>
    </aside>
  );
}
