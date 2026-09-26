import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPolicy} from '../src/policy.js';
import {createProxy} from '../src/proxy.js';
import {clientHello} from './helpers.js';

const cwd = mkdtempSync(join(tmpdir(), 'egressmap-test-'));

async function startProxy(t, opts = {}) {
  const proxy = createProxy({policy: createPolicy({cwd, ...opts})});
  const port = await proxy.listen();
  t.after(() => proxy.close());
  const events = [];
  proxy.events.on('event', (e) => events.push(e));
  // Events are emitted once the process lookup finishes, so wait for them.
  const nextEvent = () => (events.length ? Promise.resolve(events[0]) : new Promise((r) => proxy.events.once('event', r)));
  return {proxy, port, events, nextEvent};
}

function rawConnect(port, target) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = '';
    const onData = (d) => {
      buf += d;
      if (buf.includes('\r\n\r\n')) {
        s.off('data', onData);
        resolve({socket: s, head: buf});
      }
    };
    s.on('data', onData);
    s.on('error', reject);
  });
}

async function echoServer(t, host = '127.0.0.1') {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => (host ? echo.listen(0, host, r) : echo.listen(0, r)));
  t.after(() => echo.close());
  return echo.address().port;
}

const closed = (socket) => new Promise((r) => (socket.destroyed ? r() : socket.once('close', r)));

test('a blocked CONNECT gets 403 and never opens an upstream socket', async (t) => {
  const {port, events, nextEvent} = await startProxy(t);
  const {socket, head} = await rawConnect(port, 'exfil.invalid:443');
  t.after(() => socket.destroy());
  assert.match(head, /^HTTP\/1\.1 403/);
  const ev = await nextEvent();
  assert.equal(events.length, 1);
  assert.equal(ev.kind, 'block');
  assert.equal(ev.ip, undefined);
});

test('a TLS tunnel to an allowed host passes bytes both ways and counts them', async (t) => {
  const echoPort = await echoServer(t);
  const {port, nextEvent} = await startProxy(t);
  const {socket, head} = await rawConnect(port, `127.0.0.1:${echoPort}`);
  t.after(() => socket.destroy());
  assert.match(head, /^HTTP\/1\.1 200/);
  const hello = clientHello(null);
  const reply = await new Promise((resolve) => {
    let got = Buffer.alloc(0);
    socket.on('data', (d) => {
      got = Buffer.concat([got, d]);
      if (got.length >= hello.length) resolve(got);
    });
    socket.write(hello);
  });
  assert.equal(reply.length, hello.length);
  const ev = await nextEvent();
  assert.equal(ev.kind, 'allow');
  assert.equal(ev.up, hello.length);
  assert.equal(ev.down, hello.length);
});

test('a tunnel whose TLS name differs from the CONNECT host is blocked', async (t) => {
  const echoPort = await echoServer(t);
  const {port, nextEvent} = await startProxy(t);
  const {socket} = await rawConnect(port, `127.0.0.1:${echoPort}`);
  socket.write(clientHello('evil.example'));
  await closed(socket);
  const ev = await nextEvent();
  assert.equal(ev.kind, 'block');
  assert.match(ev.rule, /evil\.example does not match/);
  assert.equal(ev.up, 0);
});

test('a tunnel to a hostname with no TLS server name is blocked', async (t) => {
  const echoPort = await echoServer(t, null);
  const {port, nextEvent} = await startProxy(t);
  const {socket} = await rawConnect(port, `localhost:${echoPort}`);
  socket.write(clientHello(null));
  await closed(socket);
  const ev = await nextEvent();
  assert.equal(ev.kind, 'block');
  assert.equal(ev.rule, 'TLS hello has no server name');
});

test('a tunnel that is not TLS is blocked', async (t) => {
  const echoPort = await echoServer(t);
  const {port, nextEvent} = await startProxy(t);
  const {socket} = await rawConnect(port, `127.0.0.1:${echoPort}`);
  socket.write('SSH-2.0-OpenSSH_9.9\r\n');
  await closed(socket);
  const ev = await nextEvent();
  assert.equal(ev.kind, 'block');
  assert.equal(ev.rule, 'tunnel is not TLS');
});

test('CONNECT to a non-default port of an allowed host is refused', async (t) => {
  const {port, nextEvent} = await startProxy(t);
  const {socket, head} = await rawConnect(port, 'api.github.com:22');
  t.after(() => socket.destroy());
  assert.match(head, /^HTTP\/1\.1 403/);
  const ev = await nextEvent();
  assert.equal(ev.rule, 'port 22 not allowed');
});

test('plain HTTP is routed by the checked URL, not the client Host header', async (t) => {
  let seenHost = null;
  const upstream = http.createServer((req, res) => {
    seenHost = req.headers.host;
    res.end('ok');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const upPort = upstream.address().port;
  const {port} = await startProxy(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method: 'GET', path: `http://127.0.0.1:${upPort}/x`, headers: {host: 'evil.example'}, agent: false}, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 200);
  assert.equal(seenHost, `127.0.0.1:${upPort}`);
});

test('plain HTTP to a blocked host gets 403', async (t) => {
  const {port} = await startProxy(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method: 'GET', path: 'http://exfil.invalid/x', headers: {host: 'exfil.invalid'}, agent: false}, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('an out-of-range port gets 400 and the proxy keeps serving', async (t) => {
  const {port} = await startProxy(t);
  const bad = await rawConnect(port, 'api.github.com:99999');
  t.after(() => bad.socket.destroy());
  assert.match(bad.head, /^HTTP\/1\.1 400/);
  const next = await rawConnect(port, 'exfil.invalid:443');
  t.after(() => next.socket.destroy());
  assert.match(next.head, /^HTTP\/1\.1 403/);
});

test('a request that is not a proxy request gets 400', async (t) => {
  const {port} = await startProxy(t);
  const status = await new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path: '/', agent: false}, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 400);
});
