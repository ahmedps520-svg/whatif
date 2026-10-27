import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/global.css';
import { App } from './App';
import { initPersistence } from './store/persist';
import { initHistory } from './store/history';
import { initPrefs } from './store/prefs';
import { initActivity } from './store/activity';
import './experiments/extensions';

async function boot() {
  await initPersistence();
  initPrefs();
  initActivity();
  initHistory();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
