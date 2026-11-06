#!/usr/bin/env node
// A project's dev server for the Studio pictures e2e (e2e/studioPictures.e2e.ts): serves a small
// app on a free port and prints its address the way vite does, so Studio can find it and capture
// its pages. /settings shows its form only after a moment, for the shot's wait-for selector.
'use strict';

const http = require('node:http');

const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
body{margin:0;font:16px system-ui;background:#0f172a;color:#e2e8f0}
header{padding:24px 32px;background:#1e293b;font-weight:700;font-size:22px}
main{padding:32px}.card{background:#334155;border-radius:12px;padding:24px;max-width:520px}
button{background:#f97316;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:600}
</style></head><body><header>Shop</header><main>${body}</main></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/settings') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      page(
        'Settings',
        `<div id="root"></div><script>setTimeout(() => {
          document.getElementById('root').innerHTML =
            '<div class="card" id="settings-form"><h2>Settings</h2><p>Store name</p><button>Save</button></div>';
        }, 300);</script>`,
      ),
    );
    return;
  }
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(page('Home', '<div class="card"><h2>Welcome</h2></div>'));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  process.stdout.write('\n  VITE v9.0.0  ready in 120 ms\n\n');
  process.stdout.write(`  ➜  Local:   http://localhost:${port}/\n`);
});
