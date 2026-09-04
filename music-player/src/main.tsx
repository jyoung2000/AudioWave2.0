import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '@now-playing/aqua-ui';
import { App } from './App.js';
import { PlayerProvider } from './state/context.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('The player needs a #root element');

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <PlayerProvider>
        <App />
      </PlayerProvider>
    </ToastProvider>
  </StrictMode>,
);
