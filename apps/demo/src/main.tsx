import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initLang, msg } from './i18n';
import { DemoApp } from './lib/app';
import { DemoProvider } from './state';
import './styles.css';

initLang();
const root = createRoot(document.getElementById('root')!);
root.render(<p className="center muted" data-testid="demo-loading">{msg().app.loading}</p>);

DemoApp.create().then(
  (app) => {
    root.render(
      <StrictMode>
        <DemoProvider app={app} initialTab={app.localRoles[0] ?? 'shopper'}>
          <App />
        </DemoProvider>
      </StrictMode>,
    );
  },
  (err: Error) => {
    console.error(err);
    const m = msg();
    root.render(
      <div className="center" data-testid="demo-error">
        <h1>{m.app.startFailed}</h1>
        <p className="error">{err.message}</p>
        <p className="muted">{m.app.startFailedBefore}<code>docker compose up -d --build</code>{m.app.startFailedAfter}</p>
      </div>,
    );
  },
);
