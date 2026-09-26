import test from 'node:test';
import assert from 'node:assert/strict';
import {parseClientHello} from '../src/tls.js';
import {clientHello} from './helpers.js';

test('reads the server name from a ClientHello', () => {
  const r = parseClientHello(clientHello('api.anthropic.com'));
  assert.deepEqual([r.tls, r.complete, r.sni], [true, true, 'api.anthropic.com']);
});

test('a ClientHello without SNI parses with sni null', () => {
  const r = parseClientHello(clientHello(null));
  assert.deepEqual([r.tls, r.complete, r.sni, r.unreadable], [true, true, null, undefined]);
});

test('waits for the rest of a record that arrived in pieces', () => {
  const full = clientHello('github.com');
  assert.equal(parseClientHello(full.subarray(0, 3)).complete, false);
  assert.equal(parseClientHello(full.subarray(0, 20)).complete, false);
  assert.equal(parseClientHello(full).sni, 'github.com');
});

test('plain text is not TLS', () => {
  const r = parseClientHello(Buffer.from('GET / HTTP/1.1\r\n'));
  assert.deepEqual([r.tls, r.complete], [false, true]);
});

test('a hello that names the server twice is unreadable', () => {
  assert.equal(parseClientHello(clientHello('github.com', {twice: true})).unreadable, true);
});

test('an SNI list that claims more bytes than it has is unreadable', () => {
  assert.equal(parseClientHello(clientHello('github.com', {badListLength: true})).unreadable, true);
});

test('a TLS header with garbage inside is unreadable, not trusted', () => {
  const junk = Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0x00, 0x08]), Buffer.from([0x01, 0, 0, 4, 9, 9, 9, 9])]);
  const r = parseClientHello(junk);
  assert.equal(r.unreadable, true);
});
