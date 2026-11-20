import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { toPosix } from './fs-utils.js';

const CONTENT_TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
  }),
);

/**
 * A deliberately small static file server.
 *
 * Purpose: serve the example applications over real HTTP so the browser sees a
 * normal origin, without adding a dependency or needing a build step. It is not
 * intended for production use, and it refuses anything outside `root`.
 *
 * @param {{root: string, host?: string, port?: number}} options
 */
export async function startStaticServer({ root, host = '127.0.0.1', port = 0 }) {
  const resolvedRoot = path.resolve(root);

  const server = http.createServer((req, res) => {
    handleRequest(req, res, resolvedRoot).catch((error) => {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(`Internal server error: ${error.message}`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const origin = `http://${host}:${address.port}`;

  return {
    origin,
    port: address.port,
    /** Resolve a served path to its absolute URL. */
    urlFor(pathname) {
      return new URL(pathname, `${origin}/`).toString();
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function handleRequest(req, res, root) {
  // Cache-Control: no-store keeps repeat runs byte-identical; a cached stylesheet
  // would make screenshots depend on previous runs.
  res.setHeader('cache-control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('allow', 'GET, HEAD');
    res.end('Method not allowed');
    return;
  }

  const requestUrl = new URL(req.url ?? '/', 'http://localhost');
  let pathname = decodeURIComponent(requestUrl.pathname);

  const target = path.resolve(root, `.${pathname}`);

  // Reject any path that escapes the served root.
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let filePath = target;
  let info = await statOrNull(filePath);
  if (info?.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    info = await statOrNull(filePath);
  }

  if (!info?.isFile()) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(`Not found: ${toPosix(pathname)}`);
    return;
  }

  res.statusCode = 200;
  res.setHeader('content-type', CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream');
  res.setHeader('content-length', info.size);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

async function statOrNull(target) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}
