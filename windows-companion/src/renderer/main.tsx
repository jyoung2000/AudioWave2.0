import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The window is the design's: its stylesheet, copied verbatim from design/frontends/origin/airwave-companion.html.
import '@now-playing/aqua-ui/airwave-window.css';
import './styles.css';
import { installAquaArt } from '@now-playing/aqua-ui/airwave-art';
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) throw new Error('The companion needs a #root element');

// The design's push buttons, pop-ups and checkboxes are drawings; they must exist before anything wears them.
installAquaArt();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
