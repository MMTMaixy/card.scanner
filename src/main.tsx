import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './styles.css';

// Service Worker: macht die App offline-fähig und installierbar.
// Updates werden automatisch beim nächsten Start übernommen.
registerSW({ immediate: true });

// IndexedDB vor automatischer Bereinigung durch den Browser schützen,
// damit die Scan-Liste einen Neustart sicher überlebt.
if (navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
