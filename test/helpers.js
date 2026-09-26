const u16 = (n) => Buffer.from([(n >> 8) & 255, n & 255]);
const u24 = (n) => Buffer.from([(n >> 16) & 255, (n >> 8) & 255, n & 255]);

// A minimal but well-formed TLS 1.2/1.3 ClientHello record, optionally with SNI.
export function clientHello(sni) {
  let exts = Buffer.alloc(0);
  if (sni) {
    const name = Buffer.from(sni, 'latin1');
    const entry = Buffer.concat([Buffer.from([0]), u16(name.length), name]);
    const list = Buffer.concat([u16(entry.length), entry]);
    exts = Buffer.concat([u16(0x0000), u16(list.length), list]);
  }
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(exts.length),
    exts,
  ]);
  const hs = Buffer.concat([Buffer.from([0x01]), u24(body.length), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(hs.length), hs]);
}
