import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DemoApp } from './lib/app';
import { DemoProvider } from './state';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
root.render(<p className="center muted" data-testid="demo-loading">デモを準備しています…（鍵の生成と lab への接続）</p>);

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
    root.render(
      <div className="center" data-testid="demo-error">
        <h1>デモを始められませんでした</h1>
        <p className="error">{err.message}</p>
        <p className="muted">docker compose の lab（proxy-shopping-go で <code>docker compose up -d --build</code>）が動いているか確かめてください。</p>
      </div>,
    );
  },
);
