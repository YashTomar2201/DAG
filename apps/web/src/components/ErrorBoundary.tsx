/**
 * Top-level error boundary. A render error in any child (a bad SSE payload, a
 * malformed run row) shows a recoverable panel instead of a blank white screen.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          height: '100vh',
          width: '100vw',
          background: 'var(--color-canvas)',
          color: 'var(--color-ink)',
          fontFamily: 'var(--font-body)',
          padding: 32,
          textAlign: 'center',
        }}
      >
        <div className="display-sm">Something went wrong</div>
        <div className="body-md" style={{ color: 'var(--color-muted)', maxWidth: 480 }}>
          The editor hit an unexpected error and stopped rendering. Reloading usually clears it.
        </div>
        <pre
          className="code"
          style={{
            fontSize: 12,
            color: 'var(--color-error)',
            background: 'var(--color-surface-card)',
            padding: '12px 16px',
            borderRadius: 'var(--radius-md)',
            maxWidth: 520,
            overflow: 'auto',
          }}
        >
          {error.message}
        </pre>
        <button className="btn-primary" onClick={() => window.location.reload()}>
          Reload editor
        </button>
      </div>
    );
  }
}
