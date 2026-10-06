import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The hub is the window design/frontends/origin/airwave-hub.html draws. Its two stylesheets are generated
// from that file: the kit it shares with the companion first, then the hub's own rules. What the
// design leaves to its script (and the few states it does not draw) is in styles.css.
import '@now-playing/aqua-ui/airwave-window.css';
import '@now-playing/aqua-ui/airwave-hub.css';
import './styles.css';
import { installAquaArt } from '@now-playing/aqua-ui/airwave-art';
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) throw new Error('The admin GUI needs a #root element');

// Buttons, pop-ups and checkboxes are drawings handed to CSS as custom properties; without them
// every control is an empty box, so they are installed before the first render.
installAquaArt();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
