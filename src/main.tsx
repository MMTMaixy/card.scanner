import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './styles.css';

declare global {
  interface Window {
    /** Boot-Diagnose aus index.html: schreibt Fehler sichtbar auf die Seite. */
    __showBootError?: (msg: string) => void;
  }
}

function reportBootError(prefix: string, err: unknown) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  window.__showBootError?.(`${prefix}: ${msg}`);
}

// Service Worker: macht die App offline-fähig und installierbar.
// Fehler hier dürfen den App-Start nie verhindern.
try {
  registerSW({
    immediate: true,
    onRegisterError: (err) => reportBootError('Service-Worker-Registrierung fehlgeschlagen', err),
  });
} catch (err) {
  reportBootError('Service-Worker-Setup fehlgeschlagen', err);
}

// IndexedDB vor automatischer Bereinigung durch den Browser schützen,
// damit die Scan-Liste einen Neustart sicher überlebt.
try {
  navigator.storage?.persist?.().catch(() => {});
} catch {
  // optionales Feature
}

/** Fängt Renderfehler der React-Komponenten und zeigt sie als lesbaren Text an. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    reportBootError('Fehler in der Oberfläche', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', color: '#e8eaf0' }}>
          <h1 style={{ fontSize: '1.2rem' }}>Die App ist abgestürzt</h1>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#ff9c9c' }}>
            {this.state.error.stack ?? this.state.error.message}
          </pre>
          <button onClick={() => location.reload()} style={{ padding: '10px 16px' }}>
            Neu laden
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

try {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
} catch (err) {
  reportBootError('App konnte nicht starten', err);
  throw err;
}
