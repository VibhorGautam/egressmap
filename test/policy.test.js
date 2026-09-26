import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apexOf, createPolicy} from '../src/policy.js';

const emptyDir = mkdtempSync(join(tmpdir(), 'egressmap-test-'));

test('default allowlist covers model APIs, code hosts and registries', () => {
  const p = createPolicy({cwd: emptyDir});
  for (const host of ['api.anthropic.com', 'api.openai.com', 'github.com', 'api.github.com', 'registry.npmjs.org', 'files.pythonhosted.org']) {
    assert.equal(p.check(host).allowed, true, host);
  }
});

test('unknown hosts are blocked in enforce mode', () => {
  const p = createPolicy({cwd: emptyDir});
  assert.equal(p.check('webhook.site').allowed, false);
  assert.equal(p.check('webhook.site').rule, 'not in allowlist');
});

test('suffix rules do not match look-alike domains', () => {
  const p = createPolicy({cwd: emptyDir});
  assert.equal(p.check('evilanthropic.com').allowed, false);
  assert.equal(p.check('anthropic.com.evil.net').allowed, false);
  assert.equal(p.check('api.anthropic.com.evil.net').allowed, false);
});

test('case and a trailing dot do not change the decision', () => {
  const p = createPolicy({cwd: emptyDir});
  assert.equal(p.check('API.Anthropic.COM').allowed, true);
  assert.equal(p.check('api.anthropic.com.').allowed, true);
  assert.equal(p.check('WEBHOOK.SITE.').allowed, false);
});

test('block rules win over allow rules', () => {
  const p = createPolicy({cwd: emptyDir, block: ['uploads.github.com']});
  assert.equal(p.check('uploads.github.com').allowed, false);
  assert.equal(p.check('api.github.com').allowed, true);
});

test('watch mode lets everything through but still labels it', () => {
  const p = createPolicy({cwd: emptyDir, watch: true});
  const d = p.check('webhook.site');
  assert.equal(d.allowed, true);
  assert.equal(d.listed, false);
});

test('--no-defaults starts from an empty allowlist', () => {
  const p = createPolicy({cwd: emptyDir, defaults: false, allow: ['api.anthropic.com']});
  assert.equal(p.check('api.anthropic.com').allowed, true);
  assert.equal(p.check('registry.npmjs.org').allowed, false);
});

test('host rules only cover the default port; host:port rules open others', () => {
  const p = createPolicy({cwd: emptyDir, allow: ['api.example.com:8443'], block: ['bad.example']});
  assert.equal(p.check('api.github.com', 443, 443).allowed, true);
  assert.equal(p.check('api.github.com', 22, 443).rule, 'port 22 not allowed');
  assert.equal(p.check('api.github.com', 80, 80).allowed, true);
  assert.equal(p.check('api.example.com', 8443, 443).allowed, true);
  assert.equal(p.check('api.example.com', 443, 443).allowed, false);
  assert.equal(p.check('bad.example', 8443, 443).allowed, false);
});

test('apexOf strips subdomains that could carry data', () => {
  assert.equal(apexOf('c2VjcmV0LWtleQ.attacker.com'), 'attacker.com');
  assert.equal(apexOf('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(apexOf('webhook.site'), 'webhook.site');
  assert.equal(apexOf('93.184.216.34'), '93.184.216.34');
});
