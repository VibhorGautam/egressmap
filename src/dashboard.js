import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {apexOf} from './policy.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/json', '.svg': 'image/svg+xml'};

// Aggregates proxy events per host and streams them to the browser over SSE.
// The data endpoints need the per-session token that is printed with the URL.
export function createDashboard({events, geo, home, meta, token}) {
  const tokenOk = (value) => {
    const a = Buffer.from(String(value || ''));
    const b = Buffer.from(String(token));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const hosts = new Map();
  const feed = [];
  const clients = new Set();
  const totals = {connections: 0, blocked: 0, up: 0, down: 0};

  const broadcast = (msg) => {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) res.write(line);
  };
  const view = (h) => ({host: h.host, kind: h.kind, count: h.count, up: h.up, down: h.down, geo: h.geo, procs: h.procs, rule: h.rule, first: h.first, last: h.last});

  const addBytes = (ev) => {
    const h = hosts.get(ev.host);
    if (!h) return;
    const du = ev.up - (ev.countedUp || 0);
    const dd = ev.down - (ev.countedDown || 0);
    ev.countedUp = ev.up;
    ev.countedDown = ev.down;
    h.up += du;
    h.down += dd;
    totals.up += du;
    totals.down += dd;
    broadcast({type: 'bytes', host: h.host, up: h.up, down: h.down, totals});
  };

  events.on('event', (ev) => onEvent(ev).catch(() => {}));
  async function onEvent(ev) {
    totals.connections++;
    if (ev.kind === 'block') totals.blocked++;
    let h = hosts.get(ev.host);
    if (!h) {
      h = {host: ev.host, kind: ev.kind, count: 0, up: 0, down: 0, geo: null, procs: [], rule: ev.rule, first: ev.t};
      hosts.set(ev.host, h);
    }
    h.count++;
    h.last = ev.t;
    if (ev.kind === 'block') h.kind = 'block';
    if (ev.proc?.cmd && !h.procs.includes(ev.proc.cmd)) h.procs.push(ev.proc.cmd);
    if (!h.geo) {
      if (ev.ip) h.geo = geo.fromIp(ev.ip);
      // A blocked name is never resolved in full: its subdomain may carry stolen data.
      if (!h.geo && ev.kind === 'block') h.geo = await geo.fromName(apexOf(ev.host));
      // Allowed hosts were resolved by the proxy anyway; this covers IPv6 and failed connects.
      else if (!h.geo) h.geo = await geo.fromName(ev.host);
    }
    const item = {id: ev.id, t: ev.t, kind: ev.kind, host: ev.host, port: ev.port, method: ev.method, rule: ev.rule, proc: ev.proc, error: ev.error, geo: h.geo};
    feed.push(item);
    if (feed.length > 300) feed.shift();
    broadcast({type: 'event', event: item, host: view(h), totals});
    if (ev.up || ev.down) addBytes(ev);
  }
  events.on('bytes', addBytes);
  events.on('close', addBytes);

  const snapshot = () => ({type: 'snapshot', meta, home, totals, hosts: [...hosts.values()].map(view), feed: feed.slice(-80)});

  let port = 0;
  const server = http.createServer((req, res) => {
    serve(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
  });

  async function serve(req, res) {
    // Only answer requests addressed to the loopback name we bound, to stop DNS rebinding.
    const hostHeader = req.headers.host || '';
    if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if ((url.pathname === '/events' || url.pathname === '/state') && !tokenOk(url.searchParams.get('t'))) {
      res.writeHead(403).end();
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'});
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      res.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/state') {
      res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(snapshot()));
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {'content-type': TYPES[extname(file)] || 'application/octet-stream'}).end(body);
    } catch {
      res.writeHead(404).end();
    }
  }

  return {
    snapshot,
    close() {
      for (const res of clients) res.end();
      clients.clear();
      server.close();
    },
    markExit(code) {
      meta.exitCode = code;
      meta.endedAt = Date.now();
      broadcast({type: 'exit', meta});
    },
    listen: (preferred) =>
      new Promise((resolvePort, reject) => {
        const attempt = (p, triesLeft) => {
          server.once('error', (err) => {
            if (err.code === 'EADDRINUSE' && triesLeft > 0) attempt(p + 1, triesLeft - 1);
            else reject(err);
          });
          server.listen(p, '127.0.0.1', () => {
            port = server.address().port;
            resolvePort(port);
          });
        };
        attempt(preferred, 20);
      }),
  };
}
