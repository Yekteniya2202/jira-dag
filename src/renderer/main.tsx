import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { App } from './app';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <ReactFlowProvider><App /></ReactFlowProvider>,
);
