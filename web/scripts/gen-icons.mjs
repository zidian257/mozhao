// 生成 PWA 图标：极暗底 + 同心细波纹 + 中心微光，无文字。
// 纯 Node 实现（zlib 内置），不引入任何依赖。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0; // filter: none
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * stride + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function render(size, { maskable = false } = {}) {
  const px = new Uint8Array(size * size * 4);
  const bg = [10, 15, 20]; // #0a0f14
  const accent = [111, 179, 201]; // #6fb3c9
  const shrink = maskable ? 0.72 : 1;
  const rings = [0.17, 0.27, 0.37].map((r) => r * shrink);
  const ringAlpha = [0.55, 0.33, 0.19];
  const glowSigma = 0.1 * shrink;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5 - size / 2) / size;
      const ny = (y + 0.5 - size / 2) / size;
      const r = Math.hypot(nx, ny);
      const lift = Math.max(0, 1 - r * 2.4) * 5;
      let cr = bg[0] + lift;
      let cg = bg[1] + lift;
      let cb = bg[2] + lift;
      let a = Math.exp(-((r / glowSigma) ** 2)) * 0.5;
      for (let i = 0; i < rings.length; i += 1) {
        const d = (r - rings[i]) / 0.0045;
        a += Math.exp(-d * d) * ringAlpha[i];
      }
      a = Math.min(1, a);
      const i4 = (y * size + x) * 4;
      px[i4] = Math.round(cr + (accent[0] - cr) * a);
      px[i4 + 1] = Math.round(cg + (accent[1] - cg) * a);
      px[i4 + 2] = Math.round(cb + (accent[2] - cb) * a);
      px[i4 + 3] = 255;
    }
  }
  return px;
}

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, {}],
];

for (const [name, size, opts] of targets) {
  writeFileSync(join(outDir, name), encodePng(size, render(size, opts)));
  console.log(`wrote ${name} (${size}x${size})`);
}

// 32×32 favicon：ICO 容器内嵌 PNG（Vista+ 规范，现代浏览器全支持），放 public 根
function encodeIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(1, 4); // image count
  const entry = Buffer.alloc(16);
  entry[0] = size; // width
  entry[1] = size; // height
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // payload size
  entry.writeUInt32LE(22, 12); // payload offset = 6 + 16
  return Buffer.concat([header, entry, png]);
}
writeFileSync(join(outDir, '..', 'favicon.ico'), encodeIco(encodePng(32, render(32)), 32));
console.log('wrote favicon.ico (32x32)');
