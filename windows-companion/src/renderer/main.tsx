import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '@now-playing/aqua-ui';
// The companion is a framed window, so it loads the window chrome (the hub does the same).
import '@now-playing/aqua-ui/window.css';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('The companion needs a #root element');

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
