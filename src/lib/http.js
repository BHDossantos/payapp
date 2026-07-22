// Minimal HTTP helpers built on the Node core `http` module: JSON body parsing,
// JSON responses, a typed error, and a tiny path-pattern router.

export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function readJsonBody(req, limitBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Converts "/wallet/:id/history" into a regex capturing named params. Each path
// segment is handled independently: ":name" becomes a capture group, everything
// else is escaped as a literal.
function compile(pattern) {
  const names = [];
  const regexStr = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${regexStr}/?$`), names };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  // Signatures: add(method, pattern, handler) or add(method, pattern, opts, handler).
  add(method, pattern, optsOrHandler, maybeHandler) {
    const hasOpts = typeof optsOrHandler === 'object' && optsOrHandler !== null;
    const opts = hasOpts ? optsOrHandler : {};
    const handler = hasOpts ? maybeHandler : optsOrHandler;
    this.routes.push({ method, ...compile(pattern), handler, opts });
    return this;
  }

  get(p, o, h) { return this.add('GET', p, o, h); }
  post(p, o, h) { return this.add('POST', p, o, h); }
  patch(p, o, h) { return this.add('PATCH', p, o, h); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      return { handler: route.handler, params, opts: route.opts || {} };
    }
    return null;
  }
}
