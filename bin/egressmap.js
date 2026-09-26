#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createPolicy} from '../src/policy.js';
import {DATA_DIR, createGeo, ensureDb, homeLocation} from '../src/geo.js';
import {createProxy} from '../src/proxy.js';
import {createDashboard} from '../src/dashboard.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `egressmap ${pkg.version}
See every server your AI coding agent talks to, live on a globe. Block the ones you didn't allow.

usage
  egressmap [options] <command> [args...]
  egressmap [options] -- <command> [args...]

examples
  egressmap claude
  egressmap --allow api.stripe.com codex
  egressmap --watch -- npm install

options
  --allow <hosts>   extra hosts to allow, comma separated ("api.x.com", ".x.com" for subdomains)
  --block <hosts>   hosts to always block
  --watch           observe only, never block
  --no-defaults     start from an empty allowlist instead of the built-in dev/AI one
  --port <n>        dashboard port (default 7070)
  --no-open         don't open the dashboard in a browser
  --keep            keep the dashboard running after the command exits
  --home <lat,lng>  where arcs start (default: your timezone's city)
  --label <text>    name shown in the dashboard (default: the command)
  -h, --help        show this help
  -v, --version     show the version

A .egressmap.json in the current folder can add {"allow": [...], "block": [...]}.
`;

function parseArgs(argv) {
  const opts = {allow: [], block: [], watch: false, defaults: true, port: 7070, open: true, keep: false, home: null};
  let i = 0;
  const value = (name) => {
    const v = argv[++i];
    if (v === undefined) throw new Error(`${name} needs a value`);
    return v;
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-')) break;
    if (a === '--allow') opts.allow.push(...value(a).split(',').filter(Boolean));
    else if (a === '--block') opts.block.push(...value(a).split(',').filter(Boolean));
    else if (a === '--watch') opts.watch = true;
    else if (a === '--no-defaults') opts.defaults = false;
    else if (a === '--port') opts.port = Number(value(a));
    else if (a === '--no-open') opts.open = false;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--home') opts.home = value(a);
    else if (a === '--label') opts.label = value(a);
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else throw new Error(`unknown option ${a}`);
  }
  opts.command = argv.slice(i);
  return opts;
}

const log = (msg) => process.stderr.write(`\x1b[38;5;45megressmap\x1b[0m ${msg}\n`);

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const p = spawn(cmd, args, {stdio: 'ignore', detached: true});
  p.on('error', () => {});
  p.unref();
}

const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

function printSummary(snap, seconds) {
  const hosts = [...snap.hosts].sort((a, b) => (a.kind === b.kind ? b.count - a.count : a.kind === 'block' ? -1 : 1));
  const out = [`\n\x1b[1megressmap\x1b[0m  ${snap.meta.command}  ran ${seconds}s`];
  for (const h of hosts) {
    const where = h.geo ? `${h.geo.city ? h.geo.city + ', ' : ''}${h.geo.country}` : '';
    if (h.kind === 'block') {
      out.push(`  \x1b[31m✗ ${h.host.padEnd(34)}\x1b[0m blocked x${h.count}  ${h.procs[0] ? '← ' + h.procs[0] : ''}`);
    } else {
      out.push(`  \x1b[32m✓\x1b[0m ${h.host.padEnd(34)} ${where.padEnd(24)} ${String(h.count).padStart(4)} conn  ${fmtBytes(h.up)} up  ${fmtBytes(h.down)} down`);
    }
  }
  const blockedHosts = hosts.filter((h) => h.kind === 'block').length;
  out.push(`  ${hosts.length} servers · ${snap.totals.connections} connections · ${blockedHosts} blocked\n`);
  process.stderr.write(out.join('\n') + '\n');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    log(err.message);
    process.exit(2);
  }
  if (opts.version) return console.log(pkg.version);
  if (opts.help || opts.command.length === 0) {
    process.stdout.write(HELP);
    process.exit(opts.help ? 0 : 1);
  }

  const policy = createPolicy(opts);
  const geo = createGeo(await ensureDb(log));
  const home = homeLocation(opts.home);
  const proxy = createProxy({policy});
  const proxyPort = await proxy.listen();

  const sessionFile = join(DATA_DIR, 'sessions', `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  mkdirSync(join(DATA_DIR, 'sessions'), {recursive: true});
  proxy.events.on('event', (ev) => {
    const {id, t, kind, host, port, method, rule, ip, proc, error} = ev;
    appendFileSync(sessionFile, JSON.stringify({id, t, kind, host, port, method, rule, ip, proc, error}) + '\n');
  });

  const command = opts.label || opts.command.join(' ').split('\n')[0].slice(0, 80);
  const meta = {command, startedAt: Date.now(), mode: policy.mode, allowCount: policy.allowCount, version: pkg.version};
  // Other local processes shouldn't be able to read the session, so the data needs a token.
  const token = randomBytes(16).toString('hex');
  const dash = createDashboard({events: proxy.events, geo, home, meta, token});
  const dashPort = await dash.listen(opts.port);
  const url = `http://127.0.0.1:${dashPort}/?t=${token}`;
  log(`radar on ${url} · ${policy.mode} · ${policy.allowCount} allow rules${policy.policyFile ? ' + .egressmap.json' : ''}`);
  if (opts.open) {
    openBrowser(url);
    await new Promise((r) => setTimeout(r, 1200));
  }

  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const noProxy = 'localhost,127.0.0.1,::1';
  const env = {
    ...process.env,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: '1',
    npm_config_proxy: proxyUrl,
    npm_config_https_proxy: proxyUrl,
    EGRESSMAP: '1',
  };

  const [cmd, ...args] = opts.command;
  const child = spawn(cmd, args, {stdio: 'inherit', env});
  meta.pid = child.pid;
  // Ctrl+C goes to the whole foreground process group; let the agent handle it.
  process.on('SIGINT', () => {});
  child.on('error', (err) => {
    log(`could not start ${cmd}: ${err.message}`);
    process.exit(127);
  });
  child.on('exit', async (code, signal) => {
    // Give the proxy a moment to see the child's sockets close and finish process
    // lookups, so the summary has every event and final byte counts.
    await new Promise((r) => setTimeout(r, 250));
    await proxy.drain(1500);
    dash.markExit(code ?? signal);
    printSummary(dash.snapshot(), Math.round((Date.now() - meta.startedAt) / 1000));
    log(`session log: ${sessionFile}`);
    if (opts.keep) {
      log(`dashboard still running on ${url}, press Ctrl+C to quit`);
      process.removeAllListeners('SIGINT');
      process.on('SIGINT', () => process.exit(code ?? 0));
    } else {
      setTimeout(() => process.exit(code ?? 1), 300);
    }
  });
}

main();
