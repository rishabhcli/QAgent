import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 41773);

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sample counter</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, sans-serif; }
      body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: #f4f7f5; color: #17221c; }
      main { width: min(28rem, calc(100% - 3rem)); border: 1px solid #cad5ce; border-radius: 8px; background: white; padding: 2rem; text-align: center; }
      output { display: block; margin: 1.25rem 0; font-size: 4rem; font-weight: 700; }
      button { border: 0; border-radius: 6px; background: #146c43; color: white; cursor: pointer; font: inherit; font-weight: 650; padding: 0.75rem 1rem; }
      button:focus-visible { outline: 3px solid #92c9aa; outline-offset: 3px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Counter</h1>
      <p>Each click should add exactly one.</p>
      <output id="count" aria-live="polite">0</output>
      <button id="increment" type="button">Increment</button>
    </main>
    <script type="module" src="/client.mjs"></script>
  </body>
</html>`;

createServer(async (request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
    return;
  }
  if (request.url === '/client.mjs' || request.url === '/counter.mjs') {
    const path = join(root, request.url.slice(1));
    response.writeHead(200, { 'content-type': mimeType(path) });
    response.end(await readFile(path));
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}).listen(port, '127.0.0.1', () => {
  console.log(`Sample counter listening on http://127.0.0.1:${port}`);
});

function mimeType(path) {
  return extname(path) === '.mjs' ? 'text/javascript; charset=utf-8' : 'text/plain';
}
