/**
 * Static file server for examples/demo, shared by `npm run demo` and the privacy
 * test.
 *
 * Extracted so the test can start its own server rather than assuming one is
 * already listening — that assumption made the suite pass locally only because a
 * dev server happened to be running, and it would have failed on a clean checkout
 * and in CI.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/demo');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** Resolves once listening. Call the returned function to shut down. */
export function startServer(port = 5173) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
    const file = path.join(ROOT, rel);

    // Never serve outside the demo directory.
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store', // always pick up a fresh bundle
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      resolve(() => new Promise((done) => server.close(done)));
    });
  });
}
