// Minimal static server for dist/site (development / preview). Any static host works in production.
//   node scripts/serve.mjs [port]      default 3333 (or $PORT); address $HOST, default 127.0.0.1
// The site holds no data (diagrams live in each user's browser), so HOST=0.0.0.0 is safe for a LAN.
import { createServer } from 'node:http';
import { createReadStream, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../dist/site/', import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 3333);
const HOST = process.env.HOST || '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject'
};

const notFound = res => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); };

export function serve(port = PORT, root = ROOT, host = HOST) {
  const base = root.endsWith(sep) ? root : root + sep;
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
    if (path.endsWith('/')) path += 'index.html';
    // no hidden files, no NUL tricks; the real path (after symlinks) must stay inside the site
    if (path.includes('\0') || /(^|\/)\./.test(path)) return notFound(res);
    let file, st;
    try {
      file = realpathSync(normalize(join(root, path)));
      if (!file.startsWith(realpathSync(base))) return notFound(res);
      st = statSync(file);
    } catch { return notFound(res); }
    if (!st.isFile()) return notFound(res);
    // revalidation instead of re-downloading the 1–3 MB bundles on every load
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff'
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    if (req.method === 'HEAD') { res.writeHead(200, { ...headers, 'Content-Length': st.size }); return res.end(); }
    // the file can vanish between stat and open (a rebuild deletes dist/site): answer, never crash
    const stream = createReadStream(file);
    stream.once('error', () => {
      if (res.headersSent) res.destroy();
      else { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '1' }); res.end('temporarily unavailable'); }
    });
    stream.once('open', () => {
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      stream.pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let s;
  try {
    s = await serve();
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use` : err.message);
    process.exit(1);
  }
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST.includes(':') ? `[${HOST}]` : HOST;
  console.log(`BPMN Studio: http://${shown}:${s.address().port}/`);
  // run.sh: the server records its own PID once it listens (no wrapper process can be mistaken for it)
  const pidFile = process.env.STUDIO_PID_FILE;
  if (pidFile) {
    writeFileSync(pidFile, `${process.pid}\n`);
    process.on('exit', () => {
      try { if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) unlinkSync(pidFile); } catch { /* already gone */ }
    });
  }
  // stop cleanly on SIGTERM (run.sh stop) and SIGINT (Ctrl+C)
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      closeServer(s, sig);
    });
  }
  // started in the background by run.sh: survive the terminal closing. Node resets an inherited
  // "ignore SIGHUP" (nohup) at startup, so where setsid is missing (macOS) it has to be done here.
  if (process.env.STUDIO_DETACHED === '1') process.on('SIGHUP', () => console.log(`${new Date().toISOString()} SIGHUP ignored`));
}

function closeServer(s, sig) {
  console.log(`${new Date().toISOString()} ${sig}: stopping`);
  s.close(() => process.exit(0));
  s.closeAllConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
}
