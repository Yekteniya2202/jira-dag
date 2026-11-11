import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import { App } from './app';
import { PreferencesProvider } from './i18n';
import './fonts.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <PreferencesProvider><App /></PreferencesProvider>,
);
