import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

// Serves a file from `rootDir` for GET/HEAD requests. Returns true if it wrote a
// response, false if the caller should fall through (e.g. to a 404). Guards
// against path traversal by refusing any resolved path outside rootDir.
export async function serveStatic(req, res, pathname, rootDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  // Map "/" to the SPA entrypoint.
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const resolved = normalize(join(rootDir, rel));
  if (!resolved.startsWith(normalize(rootDir))) return false; // traversal attempt

  let info;
  try {
    info = await stat(resolved);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const type = CONTENT_TYPES[extname(resolved).toLowerCase()] || 'application/octet-stream';
  const data = await readFile(resolved);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    // Static assets are versioned by content during development; keep it simple.
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
  return true;
}
