import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The page skin's stylesheet; the library's own (aqua.css) comes with the components.
import '@now-playing/aqua-ui/now-playing.css';
import { Gallery } from './Gallery.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
