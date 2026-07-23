import '@fontsource-variable/fraunces';
import '@fontsource-variable/source-sans-3';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './renderer/app.js';
import './renderer/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('QAgent renderer root was not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
