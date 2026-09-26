import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import dns from 'node:dns/promises';
import {isIP} from 'node:net';
import {Reader} from 'mmdb-lib';

export const DATA_DIR = join(homedir(), '.egressmap');
const DB_FILE = join(DATA_DIR, 'dbip-city-ipv4.mmdb');
const DB_PACKAGE = '@ip-location-db/dbip-city-mmdb';

// Downloads the DB-IP City Lite database (CC BY 4.0) once, into ~/.egressmap.
export async function ensureDb(log = () => {}) {
  if (existsSync(DB_FILE)) return new Reader(readFileSync(DB_FILE));
  mkdirSync(DATA_DIR, {recursive: true});
  try {
    const meta = await (await fetch(`https://registry.npmjs.org/${DB_PACKAGE}/latest`)).json();
    const url = meta.dist.tarball;
    log(`downloading the geo database once (DB-IP City Lite, CC BY 4.0, about 64 MB)...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tmp = join(DATA_DIR, 'tmp');
    mkdirSync(tmp, {recursive: true});
    const tgz = join(tmp, 'db.tgz');
    const buf = Buffer.from(await res.arrayBuffer());
    // Check the tarball against the hash npm publishes for it.
    const [algo, expected] = String(meta.dist.integrity || '').split('-');
    if (!algo || createHash(algo).update(buf).digest('base64') !== expected) throw new Error('integrity check failed');
    writeFileSync(tgz, buf);
    execFileSync('tar', ['-xzf', tgz, '-C', tmp, 'package/dbip-city-ipv4.mmdb']);
    renameSync(join(tmp, 'package', 'dbip-city-ipv4.mmdb'), DB_FILE);
    rmSync(tmp, {recursive: true, force: true});
    return new Reader(readFileSync(DB_FILE));
  } catch (err) {
    log(`geo database unavailable (${err.message}); the feed still works, the globe will have no arcs`);
    return null;
  }
}

export function createGeo(reader) {
  const cache = new Map();

  function fromIp(ip) {
    if (!reader || isIP(ip) !== 4) return null;
    const rec = reader.get(ip);
    if (!rec || rec.latitude == null) return null;
    return {ip, lat: rec.latitude, lng: rec.longitude, city: (rec.city || '').replace(/\s*\(.*\)$/, ''), country: rec.country_code || ''};
  }

  return {
    fromIp,
    // Only called for names that are safe to resolve (allowed hosts, or the
    // apex of a blocked host). Never called with a full blocked hostname.
    async fromName(name) {
      if (cache.has(name)) return cache.get(name);
      let geo = null;
      try {
        const ip = isIP(name) ? name : (await dns.lookup(name, {family: 4})).address;
        geo = fromIp(ip);
      } catch {}
      cache.set(name, geo);
      return geo;
    },
  };
}

// Where arcs start. Uses the IANA timezone's principal city from zone1970.tab,
// so no network call is needed to guess the user's location.
export function homeLocation(flag) {
  if (flag) {
    const [lat, lng] = flag.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return {lat, lng, label: 'home'};
  }
  // zone1970.tab only lists canonical names; some systems still report the old ones.
  const LEGACY = {'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Rangoon': 'Asia/Yangon', 'Europe/Kiev': 'Europe/Kyiv', 'America/Buenos_Aires': 'America/Argentina/Buenos_Aires', 'Asia/Dacca': 'Asia/Dhaka', 'US/Pacific': 'America/Los_Angeles', 'US/Eastern': 'America/New_York', 'US/Central': 'America/Chicago', 'US/Mountain': 'America/Denver'};
  const reported = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tz = LEGACY[reported] || reported;
  for (const file of ['/usr/share/zoneinfo/zone1970.tab', '/usr/share/zoneinfo/zone.tab']) {
    if (!existsSync(file)) continue;
    const line = readFileSync(file, 'utf8').split('\n').find((l) => l.split('\t')[2] === tz);
    if (!line) continue;
    const m = line.split('\t')[1].match(/^([+-]\d{4,6})([+-]\d{5,7})$/);
    if (!m) continue;
    const dms = (s, degDigits) => {
      const sign = s[0] === '-' ? -1 : 1;
      const d = s.slice(1);
      const deg = +d.slice(0, degDigits), min = +d.slice(degDigits, degDigits + 2), sec = +(d.slice(degDigits + 2) || 0);
      return sign * (deg + min / 60 + sec / 3600);
    };
    return {lat: dms(m[1], 2), lng: dms(m[2], 3), label: tz.split('/').pop().replace(/_/g, ' ')};
  }
  return {lat: 20, lng: 0, label: 'home'};
}
