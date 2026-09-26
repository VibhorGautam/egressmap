// Just enough TLS parsing to read the server name (SNI) a client asks for.
// Used to make sure a CONNECT tunnel to an allowed host really talks TLS to that host.

export function parseClientHello(buf) {
  if (buf.length === 0) return {tls: false, complete: false, sni: null};
  if (buf[0] !== 0x16) return {tls: false, complete: true, sni: null};
  if (buf.length < 5) return {tls: true, complete: false, sni: null};
  const end = 5 + buf.readUInt16BE(3);
  if (buf.length < end) return {tls: true, complete: false, sni: null};
  const record = buf.subarray(0, end);
  try {
    let p = 5;
    if (record[p] !== 0x01) return {tls: true, complete: true, sni: null, unreadable: true};
    p += 4 + 2 + 32; // handshake header, client version, random
    p += 1 + record[p]; // session id
    p += 2 + record.readUInt16BE(p); // cipher suites
    p += 1 + record[p]; // compression methods
    const unreadable = {tls: true, complete: true, sni: null, unreadable: true};
    const extEnd = p + 2 + record.readUInt16BE(p);
    if (extEnd > end) return unreadable;
    p += 2;
    // Every length is checked against its container, and a hello that names
    // more than 1 server is rejected, so upstream can't read it differently.
    let sni = null;
    let sawSni = false;
    while (p < extEnd) {
      if (p + 4 > extEnd) return unreadable;
      const type = record.readUInt16BE(p);
      const len = record.readUInt16BE(p + 2);
      p += 4;
      if (p + len > extEnd) return unreadable;
      if (type === 0x0000) {
        if (sawSni || len < 2) return unreadable;
        sawSni = true;
        const listEnd = p + 2 + record.readUInt16BE(p);
        if (listEnd !== p + len) return unreadable;
        let q = p + 2;
        while (q < listEnd) {
          if (q + 3 > listEnd) return unreadable;
          const nameLen = record.readUInt16BE(q + 1);
          if (q + 3 + nameLen > listEnd) return unreadable;
          if (record[q] === 0) {
            if (sni !== null) return unreadable;
            sni = record.toString('latin1', q + 3, q + 3 + nameLen);
          }
          q += 3 + nameLen;
        }
        if (sni === null) return unreadable;
      }
      p += len;
    }
    return {tls: true, complete: true, sni};
  } catch {
    // A ClientHello split across records, or garbage: we can't vouch for it.
    return {tls: true, complete: true, sni: null, unreadable: true};
  }
}

// Collects the first TLS record from a client (max 16 KB, 5 s) and pauses the
// socket, so nothing is forwarded upstream until the caller has checked it.
export function readClientHello(socket, head) {
  return new Promise((resolve) => {
    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.pause();
      resolve({...result, data: buf});
    };
    const check = () => {
      const r = parseClientHello(buf);
      if (r.complete) finish(r);
      else if (buf.length >= 16384) finish({tls: r.tls, complete: true, sni: null, unreadable: true});
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      check();
    };
    const onClose = () => finish({tls: false, complete: true, sni: null, closed: true});
    const timer = setTimeout(() => finish({tls: false, complete: true, sni: null}), 5000);
    socket.on('data', onData);
    socket.on('close', onClose);
    if (buf.length) check();
  });
}
