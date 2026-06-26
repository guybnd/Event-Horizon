import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * FLUX-776: top-level error boundary. The portal is the sole UI, and React unmounts the entire
 * tree on any uncaught render-time throw (a malformed/hand-edited ticket, a null in a list, a bad
 * data shape) — leaving a blank white screen with no message or recovery (this has shipped before,
 * FLUX-176). This boundary degrades that into a readable, recoverable fallback.
 *
 * The fallback is rendered with INLINE styles on purpose: it must work even when the theme/CSS is
 * itself what broke, so it cannot depend on the app's stylesheet or design tokens.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface for debugging; the UI shows a recoverable fallback rather than a blank screen.
    console.error('[FLUX] Unhandled render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background: '#0b0b0f',
            color: '#e5e7eb',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <div style={{ maxWidth: 540, width: '100%', textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 8px' }}>Something went wrong</h1>
            <p style={{ fontSize: 14, lineHeight: 1.5, color: '#9ca3af', margin: '0 0 16px' }}>
              The interface hit an unexpected error and stopped rendering. Your tickets are safe on
              disk — reloading usually recovers. If it persists, the detail below helps diagnose it.
            </p>
            <pre
              style={{
                textAlign: 'left',
                fontSize: 12,
                lineHeight: 1.5,
                background: '#16171d',
                color: '#f87171',
                border: '1px solid rgba(255,255,255,0.08)',
                padding: 12,
                borderRadius: 8,
                overflow: 'auto',
                maxHeight: 180,
                margin: '0 0 16px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
            </pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                background: '#aa3bff',
                color: '#fff',
                border: 'none',
                borderRadius: 8,
                padding: '10px 22px',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
