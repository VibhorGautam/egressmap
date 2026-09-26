import http from 'node:http';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {whoOwns} from './proc.js';
import {readClientHello} from './tls.js';

let nextId = 1;

function splitHostPort(value, defaultPort) {
  const s = String(value);
  const m = s.match(/^\[([^\]]+)\](?::(\d+))?$/) || s.match(/^([^:]+)(?::(\d+))?$/);
  if (!m) return {host: s, port: defaultPort};
  return {host: m[1], port: m[2] === undefined ? defaultPort : Number(m[2])};
}

const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;
const sameHost = (a, b) => String(a).toLowerCase().replace(/\.$/, '') === String(b).toLowerCase().replace(/\.$/, '');

// A plain forward proxy. HTTPS is tunnelled with CONNECT, so TLS is never
// intercepted: egressmap sees the destination host and byte counts, not content.
export function createProxy({policy}) {
  const events = new EventEmitter();
  const open = new Set();
  const pending = new Set();

  const record = (fields) => ({id: nextId++, t: Date.now(), up: 0, down: 0, ...fields});
  // Process lookup (lsof) runs alongside the upstream connect so it never adds latency.
  const lookup = (socket) => {
    const p = whoOwns(socket.remotePort).catch(() => null);
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  };

  async function handleHttp(req, res) {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400, {'content-type': 'text/plain'}).end('egressmap proxy: expected an absolute URL\n');
      return;
    }
    const host = url.hostname;
    const port = url.port ? Number(url.port) : 80;
    if (url.protocol !== 'http:' || !validPort(port)) {
      res.writeHead(400, {'content-type': 'text/plain'}).end('egressmap proxy: unsupported target\n');
      return;
    }
    const procP = lookup(req.socket);
    const decision = policy.check(host, port, 80);
    const ev = record({host, port, method: req.method, rule: decision.rule, kind: decision.allowed ? 'allow' : 'block'});
    if (!decision.allowed) {
      // Look the process up before answering: once the socket closes, lsof can't see it.
      ev.proc = await procP;
      req.resume();
      res.writeHead(403, {'content-type': 'text/plain', 'x-egressmap': 'blocked'});
      res.end(`blocked by egressmap: ${host} (${decision.rule})\n`);
      events.emit('event', ev);
      return;
    }
    const headers = {...req.headers};
    for (const h of ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']) delete headers[h];
    // Route by the URL we checked, never by a Host header the client chose.
    headers.host = url.host;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (open.delete(ev)) events.emit('close', ev);
    };
    const upstream = http.request({host, port, method: req.method, path: url.pathname + url.search, headers}, async (upRes) => {
      ev.ip = upRes.socket.remoteAddress;
      open.add(ev);
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.on('data', (c) => (ev.down += c.length));
      upRes.pipe(res);
      upRes.on('end', finish);
      ev.proc = await procP;
      events.emit('event', ev);
    });
    // If the client goes away, stop the upstream request too.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
      finish();
    });
    req.on('data', (c) => (ev.up += c.length));
    upstream.on('error', async (err) => {
      if (!res.headersSent) res.writeHead(502, {'content-type': 'text/plain'});
      res.end();
      if (open.has(ev)) {
        finish();
        return;
      }
      ev.error = err.code || err.message;
      ev.proc = await procP;
      events.emit('event', ev);
    });
    req.pipe(upstream);
  }

  async function handleConnect(req, client, head) {
    client.on('error', () => {});
    const {host, port} = splitHostPort(req.url, 443);
    if (!host || !validPort(port)) {
      client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const procP = lookup(client);
    const decision = policy.check(host, port, 443);
    const ev = record({host, port, method: 'CONNECT', rule: decision.rule, kind: decision.allowed ? 'allow' : 'block'});
    if (!decision.allowed) {
      ev.proc = await procP;
      client.end(
        'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nX-Egressmap: blocked\r\nConnection: close\r\n\r\n' +
          `blocked by egressmap: ${host}:${port} (${decision.rule})\n`,
      );
      events.emit('event', ev);
      return;
    }
    const upstream = net.connect({host, port});
    let connected = false;
    let closed = false;
    upstream.on('error', async (err) => {
      if (connected) {
        client.destroy();
        return;
      }
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      ev.error = err.code || err.message;
      ev.proc = await procP;
      events.emit('event', ev);
    });
    upstream.once('connect', async () => {
      connected = true;
      ev.ip = upstream.remoteAddress;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // Nothing reaches the server until the TLS ClientHello names the host we allowed.
      const hello = await readClientHello(client, head);
      ev.proc = await procP;
      // The client left before sending anything: record the attempt, forward nothing.
      if (hello.closed || closed) {
        events.emit('event', ev);
        return;
      }
      // A hostname target needs a matching SNI. Only IP targets may omit it.
      const reason = !hello.tls
        ? 'tunnel is not TLS'
        : hello.unreadable
          ? 'unreadable TLS ClientHello'
          : !hello.sni
            ? net.isIP(host)
              ? null
              : 'TLS hello has no server name'
            : !sameHost(hello.sni, host)
              ? `TLS name ${hello.sni} does not match`
              : null;
      if (reason) {
        ev.kind = 'block';
        ev.rule = reason;
        upstream.destroy();
        client.destroy();
        events.emit('event', ev);
        return;
      }
      ev.up += hello.data.length;
      upstream.write(hello.data);
      client.on('data', (c) => (ev.up += c.length));
      upstream.on('data', (c) => (ev.down += c.length));
      client.pipe(upstream);
      upstream.pipe(client);
      open.add(ev);
      events.emit('event', ev);
    });
    const done = () => {
      closed = true;
      if (open.delete(ev)) events.emit('close', ev);
      upstream.destroy();
      client.destroy();
    };
    client.on('close', done);
    upstream.on('close', done);
  }

  // A bad request must only ever cost its own connection, never the proxy the agent depends on.
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  server.on('connect', (req, client, head) => {
    handleConnect(req, client, head).catch(() => client.destroy());
  });
  server.on('clientError', (err, socket) => socket.destroy());

  // Live byte counts for long-lived tunnels (streaming model responses).
  const ticker = setInterval(() => {
    for (const ev of open) {
      if (ev.up !== ev.lastUp || ev.down !== ev.lastDown) {
        ev.lastUp = ev.up;
        ev.lastDown = ev.down;
        events.emit('bytes', ev);
      }
    }
  }, 1000);
  ticker.unref();

  return {
    events,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      }),
    // Waits (bounded) for in-flight process lookups, so late events aren't lost.
    drain: (ms) => Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, ms))]).then(() => new Promise((r) => setImmediate(r))),
    close: () => server.close(),
  };
}
