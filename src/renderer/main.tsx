import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { App } from './app';
import { PreferencesProvider } from './i18n';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <PreferencesProvider><ReactFlowProvider><App /></ReactFlowProvider></PreferencesProvider>,
);
