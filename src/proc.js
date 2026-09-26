import {execFile} from 'node:child_process';

function run(cmd, args, timeout = 800) {
  return new Promise((resolve) => {
    execFile(cmd, args, {timeout}, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)));
  });
}

// Finds which local process owns the client end of a proxy connection, so the
// dashboard can say "node collect.js" instead of just a port number.
export async function whoOwns(clientPort) {
  if (process.platform === 'win32') return null;
  const out = await run('lsof', ['-nP', `-iTCP:${clientPort}`, '-sTCP:ESTABLISHED', '-Fpc']);
  let pid = null, name = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c') && pid && pid !== process.pid) {
      name = line.slice(1);
      break;
    }
  }
  if (!pid || pid === process.pid || !name) return null;
  const cmd = (await run('ps', ['-o', 'command=', '-p', String(pid)])).trim();
  return {pid, name, cmd: shorten(cmd)};
}

function shorten(cmd) {
  // Drop absolute paths from the executable and script so the feed stays readable.
  const parts = cmd.split(/\s+/).slice(0, 6).map((p, i) => (i < 2 && p.includes('/') ? p.split('/').pop() : p));
  const s = parts.join(' ');
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}
