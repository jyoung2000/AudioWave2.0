import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Every stylesheet, because the styleguide shows every element from both skins.
import '@now-playing/aqua-ui/window.css';
import '@now-playing/aqua-ui/media.css';
import '@now-playing/aqua-ui/now-playing.css';
import './styleguide.css';
import { Styleguide } from './Styleguide.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Styleguide />
  </StrictMode>,
);
