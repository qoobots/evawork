// 纯 Node 把 PNG 转成标准多尺寸 Windows .ico（DIB/BMP 条目，32bit BGRA + AND 掩码）。
// 不用 PNG-in-ICO：实测单条目 1024px PNG 声明 256 会被 Windows 解析失败渲染成黑块。
// 用法: node scripts/png2ico.mjs <in.png> <out.ico>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import zlib from 'node:zlib';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node png2ico.mjs <in.png> <out.ico>');
  process.exit(1);
}
const png = readFileSync(resolve(inPath));
if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
  console.error('input is not a PNG');
  process.exit(1);
}

// ---------- PNG 解码（8bit / 非隔行 / gray|rgb|rgba） ----------
function decodePNG(buf) {
  let off = 8;
  let W = 0, H = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      W = data.readUInt32BE(0); H = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('unsupported bit depth ' + bitDepth);
  if (interlace !== 0) throw new Error('interlaced PNG not supported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error('unsupported color type ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = W * channels;
  const out = Buffer.alloc(W * H * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < H; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const cur = Buffer.from(raw.subarray(rowStart + 1, rowStart + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = cur[i];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[i] = v;
    }
    prev = cur;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4, s = x * channels;
      if (channels === 4) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = cur[s + 3]; }
      else if (channels === 3) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255; }
      else { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = 255; }
    }
  }
  return { width: W, height: H, rgba: out };
}

// ---------- 盒式缩放（区域平均，缩小质量优于最近邻） ----------
function resizeRGBA(src, W, H, s) {
  const dst = Buffer.alloc(s * s * 4);
  const sx = W / s, sy = H / s;
  for (let y = 0; y < s; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < s; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < H; yy++) {
        for (let xx = x0; xx < x1 && xx < W; xx++) {
          const o = (yy * W + xx) * 4;
          r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3]; n++;
        }
      }
      const o2 = (y * s + x) * 4;
      dst[o2] = Math.round(r / n); dst[o2 + 1] = Math.round(g / n);
      dst[o2 + 2] = Math.round(b / n); dst[o2 + 3] = Math.round(a / n);
    }
  }
  return dst;
}

// ---------- 单尺寸 DIB 条目（BITMAPINFOHEADER + 自底向上 BGRA + AND 掩码） ----------
function dibEntry(rgba, s) {
  const xorSize = s * s * 4;
  const andStride = ((s + 31) >> 5) << 2; // 1bpp 行按 4 字节对齐
  const h = Buffer.alloc(40);
  h.writeUInt32LE(40, 0);        // biSize
  h.writeInt32LE(s, 4);          // biWidth
  h.writeInt32LE(s * 2, 8);      // biHeight = XOR + AND
  h.writeUInt16LE(1, 12);        // biPlanes
  h.writeUInt16LE(32, 14);       // biBitCount
  h.writeUInt32LE(0, 16);        // BI_RGB
  h.writeUInt32LE(xorSize + andStride * s, 20);
  const xor = Buffer.alloc(xorSize);
  for (let y = 0; y < s; y++) {
    const srcRow = s - 1 - y; // 自底向上
    for (let x = 0; x < s; x++) {
      const o = (srcRow * s + x) * 4, d = (y * s + x) * 4;
      xor[d] = rgba[o + 2]; xor[d + 1] = rgba[o + 1]; xor[d + 2] = rgba[o]; xor[d + 3] = rgba[o + 3];
    }
  }
  return Buffer.concat([h, xor, Buffer.alloc(andStride * s)]); // AND 全 0：透明度由 alpha 通道表达
}

const { width, height, rgba } = decodePNG(png);
console.log(`source ${width}x${height}`);
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const images = SIZES.map((s) => dibEntry(resizeRGBA(rgba, width, height, s), s));

const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(SIZES.length, 4);
let offset = 6 + SIZES.length * 16;
const entries = SIZES.map((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s === 256 ? 0 : s, 0); // 256 在目录里写作 0
  e.writeUInt8(s === 256 ? 0 : s, 1);
  e.writeUInt16LE(1, 4);  // planes
  e.writeUInt16LE(32, 6); // bit count
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
writeFileSync(resolve(outPath), Buffer.concat([dir, ...entries, ...images]));
console.log(`wrote ${outPath} (${SIZES.join('/')})`);
