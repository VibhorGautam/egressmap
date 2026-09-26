import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

// Hosts a coding agent normally needs: model APIs, code hosts, package registries.
// ".example.com" matches example.com and every subdomain. "*.example.com" matches subdomains only.
export const DEFAULT_ALLOW = [
  '.anthropic.com', '.claude.ai', '.claude.com',
  '.openai.com', '.chatgpt.com',
  'generativelanguage.googleapis.com', 'oauth2.googleapis.com', 'aiplatform.googleapis.com',
  '.x.ai', '.mistral.ai', '.openrouter.ai', '.groq.com', '.deepseek.com', '.fireworks.ai', '.together.xyz',
  '.github.com', '.githubusercontent.com', '.githubassets.com', '.gitlab.com', '.bitbucket.org',
  '.npmjs.org', '.npmjs.com', '.yarnpkg.com', 'bun.sh', '.jsr.io', 'deno.land', '.nodejs.org',
  '.pypi.org', '.pythonhosted.org', '.crates.io', 'proxy.golang.org', 'sum.golang.org', 'index.golang.org',
  '.rubygems.org', 'repo.maven.apache.org', 'repo1.maven.org',
];

function normalize(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
}

// "api.x.com" or "api.x.com:8443". Without a port a rule only covers the
// default port (443 for tunnels, 80 for plain HTTP).
function splitPattern(pattern) {
  const p = normalize(pattern);
  const m = p.match(/^([^:]+):(\d+)$/);
  return m ? {host: m[1], port: Number(m[2])} : {host: p, port: null};
}

function matchesHost(p, host) {
  if (!p) return false;
  if (p.startsWith('*.')) return host.endsWith(p.slice(1));
  if (p.startsWith('.')) return host === p.slice(1) || host.endsWith(p);
  return host === p;
}

function matches(pattern, host, port, defaultPort) {
  const rule = splitPattern(pattern);
  if (!matchesHost(rule.host, host)) return false;
  if (port === undefined) return true;
  return rule.port === null ? port === defaultPort : port === rule.port;
}

export function createPolicy({allow = [], block = [], defaults = true, watch = false, cwd = process.cwd()} = {}) {
  const file = join(cwd, '.egressmap.json');
  let fromFile = {allow: [], block: []};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      fromFile = {allow: parsed.allow ?? [], block: parsed.block ?? []};
    } catch (err) {
      throw new Error(`could not parse ${file}: ${err.message}`);
    }
  }
  const allowList = [...(defaults ? DEFAULT_ALLOW : []), ...fromFile.allow, ...allow];
  const blockList = [...fromFile.block, ...block];

  return {
    mode: watch ? 'watch' : 'enforce',
    allowCount: allowList.length,
    policyFile: existsSync(file) ? file : null,
    // port and defaultPort are optional; without them only the host is checked.
    check(rawHost, port, defaultPort = 443) {
      const host = normalize(rawHost);
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return {allowed: true, rule: 'loopback'};
      const blockedBy = blockList.find((p) => matchesHost(splitPattern(p).host, host));
      if (blockedBy) return {allowed: watch, rule: `block ${blockedBy}`, listed: false};
      const allowedBy = allowList.find((p) => matches(p, host, port, defaultPort));
      if (allowedBy) return {allowed: true, rule: allowedBy, listed: true};
      if (allowList.some((p) => matchesHost(splitPattern(p).host, host))) return {allowed: watch, rule: `port ${port} not allowed`, listed: false};
      return {allowed: watch, rule: 'not in allowlist', listed: false};
    },
  };
}

// Registrable-ish domain, used to place a blocked host on the map without
// resolving its full name (a subdomain can carry exfiltrated data).
export function apexOf(rawHost) {
  const host = normalize(rawHost);
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const labels = host.split('.');
  const twoLevelSuffix = /^(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/;
  const n = twoLevelSuffix.test(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-n).join('.');
}
