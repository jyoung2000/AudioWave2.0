import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The gallery shows every component, so it is the one place that loads every stylesheet.
import '@now-playing/aqua-ui/window.css';
import '@now-playing/aqua-ui/media.css';
import '@now-playing/aqua-ui/now-playing.css';
import { Gallery } from './Gallery.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
