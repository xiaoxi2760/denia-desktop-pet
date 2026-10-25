// 生成 assets/icon.ico（多尺寸，Vista+ PNG-in-ICO 格式）。
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe tools/make-icon.mjs
// 源图 assets/tray.png（64×64）→ 缩放出 16/24/32/48/64 五档嵌入。
// 用途：启动器/设置窗的 BrowserWindow icon、发布目录的快捷方式图标、exe 内嵌图标。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'assets', 'tray.png');
const OUT = path.join(ROOT, 'assets', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaya-icon-'));

// 1) PowerShell System.Drawing 高质量缩放出各档 PNG
const ps = [
  'Add-Type -AssemblyName System.Drawing',
  `$src = [System.Drawing.Image]::FromFile('${SRC.replace(/\\/g, '\\\\').replace(/'/g, "''")}')`,
  ...SIZES.map((s) => [
    `$bmp = New-Object System.Drawing.Bitmap(${s}, ${s})`,
    `$g = [System.Drawing.Graphics]::FromImage($bmp)`,
    `$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic`,
    '$g.DrawImage($src, 0, 0, ' + s + ', ' + s + ')',
    `$bmp.Save('${(path.join(tmp, `i${s}.png`)).replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()',
  ].join('; ')),
  '$src.Dispose()',
].join('\n');
const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error('PowerShell 缩放失败：', r.stderr || r.stdout);
  process.exit(1);
}

// 2) 组装 ICO：ICONDIR + N×ICONDIRENTRY + PNG 数据（Vista+ 支持 PNG 压缩条目）
const pngs = SIZES.map((s) => fs.readFileSync(path.join(tmp, `i${s}.png`)));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(SIZES.length, 4);
let offset = 6 + 16 * SIZES.length;
const entries = [];
SIZES.forEach((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0); e.writeUInt8(s >= 256 ? 0 : s, 1);
  e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += pngs[i].length;
});
fs.writeFileSync(OUT, Buffer.concat([header, ...entries, ...pngs]));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`assets/icon.ico 已生成：${SIZES.join('/')} 共 ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
