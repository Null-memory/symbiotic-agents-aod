import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve(process.cwd());
const distRoot = resolve(root, 'dist');
const indexPath = resolve(distRoot, 'index.html');
const backend = new URL(process.env.AOD_BACKEND_URL || 'http://127.0.0.1:4830');
const host = process.env.AOD_PREVIEW_HOST || '127.0.0.1';
const port = Number(process.env.AOD_PREVIEW_PORT || 4173);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

if (!existsSync(indexPath)) {
  console.error('mobile/dist is missing. Run: npx expo export --platform web');
  process.exit(1);
}

function proxyApi(request, response) {
  const upstream = httpRequest({
    protocol: backend.protocol,
    hostname: backend.hostname,
    port: backend.port,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, host: backend.host },
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstream.on('error', error => {
    if (response.headersSent) return response.destroy(error);
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: `AOD backend is unavailable: ${error.message}` }));
  });
  request.pipe(upstream);
}

function staticPath(pathname) {
  const candidate = resolve(distRoot, `.${decodeURIComponent(pathname)}`);
  if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${sep}`)) return null;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return indexPath;
}

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) return proxyApi(request, response);

  const path = staticPath(url.pathname);
  if (!path) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return response.end('Forbidden');
  }
  response.writeHead(200, {
    'content-type': mimeTypes[extname(path).toLowerCase()] || 'application/octet-stream',
    'cache-control': path === indexPath ? 'no-store' : 'public, max-age=3600',
  });
  createReadStream(path).pipe(response);
});

server.listen(port, host, () => {
  console.log(`AOD Mobile preview: http://${host}:${port}`);
  console.log(`AOD backend: ${backend.origin}`);
  console.log(`Android emulator URL: http://10.0.2.2:${port}`);
});

