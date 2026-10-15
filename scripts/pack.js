"use strict";
/*
 * Pack src/ into an uncompressed (STORED) .piplug archive under dist/.
 *
 * PI-Desktop's installer only accepts store-mode zips, so every entry uses
 * method=0 (STORED), forward-slash paths and no directory entries. Timestamps
 * are fixed (1980-01-01) so repeated packs of identical content are
 * byte-identical.
 *
 * Usage:  node scripts/pack.js
 * Output: dist/<id>-<version>.piplug
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
fs.mkdirSync(DIST, { recursive: true });
const OUT = path.join(DIST, `${manifest.id}-${manifest.version}.piplug`);

// Files to pack, forward-slash relative paths. Directories get no own entry.
const FILES = ["main.js", "manifest.json", "renderer/index.html", "renderer/panel.css", "renderer/panel.js"];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

// Hand-written minimal ZIP (all STORED) so method=0 is guaranteed regardless
// of any zip library's compression heuristics.
const chunks = [];
const central = [];
let offset = 0;
const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01, fixed to avoid byte drift between packs

for (const rel of FILES) {
  const abs = path.join(SRC, ...rel.split("/"));
  const data = fs.readFileSync(abs);
  const nameBuf = Buffer.from(rel, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method 0 = STORED
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); // compressed size
  local.writeUInt32LE(data.length, 22); // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra len
  chunks.push(local, nameBuf, data);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); // central directory signature
  cen.writeUInt16LE(20, 4); // version made by
  cen.writeUInt16LE(20, 6); // version needed
  cen.writeUInt16LE(0, 8); // flags
  cen.writeUInt16LE(0, 10); // method STORED
  cen.writeUInt16LE(DOS_TIME, 12);
  cen.writeUInt16LE(DOS_DATE, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt16LE(0, 30); // extra
  cen.writeUInt16LE(0, 32); // comment
  cen.writeUInt16LE(0, 34); // disk #
  cen.writeUInt16LE(0, 36); // internal attrs
  cen.writeUInt32LE(0, 38); // external attrs
  cen.writeUInt32LE(offset, 42); // local header offset
  central.push(Buffer.concat([cen, nameBuf]));

  offset += local.length + nameBuf.length + data.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(FILES.length, 8);
eocd.writeUInt16LE(FILES.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const out = Buffer.concat([...chunks, centralBuf, eocd]);
fs.writeFileSync(OUT, out);
console.log("wrote " + path.relative(ROOT, OUT) + "  " + out.length + "B  entries=" + FILES.length);
