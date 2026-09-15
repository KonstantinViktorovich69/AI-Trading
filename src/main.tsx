import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Fix for "ResizeObserver loop completed with undelivered notifications"
// This error is mostly harmless and happens when ResizeObserver can't deliver 
// notification in the current frame.
if (typeof window !== 'undefined') {
  const resizeObserverError = /ResizeObserver loop completed with undelivered notifications/;
  window.addEventListener('error', (e) => {
    if (resizeObserverError.test(e.message)) {
      e.stopImmediatePropagation();
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
