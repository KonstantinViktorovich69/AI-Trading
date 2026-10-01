import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Fix for "ResizeObserver loop completed with undelivered notifications" and transient network errors
if (typeof window !== 'undefined') {
  const isIgnorableError = (msg: string) => {
    return (
      /ResizeObserver loop completed with undelivered notifications/.test(msg) ||
      msg.includes('Failed to fetch') ||
      msg.includes('NetworkError') ||
      msg.includes('Load failed') ||
      msg.includes('Network request failed') ||
      msg.includes('AbortError')
    );
  };

  window.addEventListener('error', (e) => {
    if (isIgnorableError(e.message || '')) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e?.reason?.message || String(e?.reason || '');
    if (isIgnorableError(reason)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
