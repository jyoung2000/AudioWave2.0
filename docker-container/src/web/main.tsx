import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '@now-playing/aqua-ui';
// The admin GUI is a framed window, so it loads the window chrome. It renders no toolbar media
// cluster and no 2010 page, so it loads neither of those stylesheets.
import '@now-playing/aqua-ui/window.css';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('The admin GUI needs a #root element');

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
