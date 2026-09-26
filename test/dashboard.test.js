import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {createDashboard} from '../src/dashboard.js';

const get = (port, path, host = `127.0.0.1:${port}`) =>
  new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path, headers: {host}}, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });

async function start(t) {
  const geo = {fromIp: () => null, fromName: async () => null};
  const dash = createDashboard({events: new EventEmitter(), geo, home: {lat: 0, lng: 0, label: 'test'}, meta: {command: 'test'}, token: 'secret'});
  const port = await dash.listen(0);
  t.after(() => dash.close());
  return port;
}

test('a malformed path gets 400 and the dashboard keeps serving', async (t) => {
  const port = await start(t);
  assert.equal(await get(port, '/%E0%A4%A'), 400);
  assert.equal(await get(port, '/state?t=secret'), 200);
});

test('session data needs the token', async (t) => {
  const port = await start(t);
  assert.equal(await get(port, '/state'), 403);
  assert.equal(await get(port, '/state?t=wrong'), 403);
  assert.equal(await get(port, '/events?t=nope'), 403);
});

test('requests for another Host are refused (DNS rebinding)', async (t) => {
  const port = await start(t);
  assert.equal(await get(port, '/state?t=secret', `evil.example:${port}`), 403);
});

test('static files cannot escape the public folder', async (t) => {
  const port = await start(t);
  assert.equal(await get(port, '/..%2Fpackage.json'), 404);
  assert.equal(await get(port, '/app.js'), 200);
});
