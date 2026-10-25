// 通用贴图降档：把目录下 max(宽,高) ≥ 阈值 的 PNG 离线缩到目标最大边（保纵横比、原名覆盖、PNG 进 PNG 出）。
// 用法：ELECTRON_RUN_AS_NODE=1 electron.exe tools/texture-downscale/downscale-pngs.mjs <目录> [--max-edge=1024] [--threshold=2048] [--dry-run]
// 递归扫描目录（跳过 AONMPB/、spa/、extra/——MMD 插件/编辑器数据，运行时不用）。
// 缩放引擎：PowerShell System.Drawing HighQualityBicubic（写法对齐 tools/make-icon.mjs）。
// 宽高从 PNG IHDR 读（偏移 16/20，大端）。回滚 = 从 D:/denia 根目录原件重拷。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const args = process.argv.slice(2);
const DIR = args[0];
const getOpt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const MAX_EDGE = getOpt('max-edge', 1024);
const THRESHOLD = getOpt('threshold', 2048);
const DRY = args.includes('--dry-run');
if (!DIR) { console.error('用法: downscale-pngs.mjs <目录> [--max-edge=1024] [--threshold=2048] [--dry-run]'); process.exit(2); }

const SKIP_DIRS = new Set(['AONMPB', 'spa', 'extra']);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const f = path.join(d, e.name);
  if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : walk(f);
  return e.name.toLowerCase().endsWith('.png') ? [f] : [];
});

const pngSize = (f) => {
  const b = fs.readFileSync(f);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

const targets = [];
let sumBefore = 0, sumAfter = 0;
for (const f of walk(DIR)) {
  const s = pngSize(f);
  if (!s) continue;
  const px = s.w * s.h * 4;
  const ref = targets.length;
  if (Math.max(s.w, s.h) >= THRESHOLD) {
    const scale = MAX_EDGE / Math.max(s.w, s.h);
    targets.push({ f, w: s.w, h: s.h, nw: Math.max(1, Math.round(s.w * scale)), nh: Math.max(1, Math.round(s.h * scale)) });
    sumBefore += px; sumAfter += targets[targets.length - 1].nw * targets[targets.length - 1].nh * 4;
  } else {
    sumBefore += px; sumAfter += px;
  }
}

console.log(`目录：${DIR}`);
console.log(`≥${THRESHOLD}px 的 PNG：${targets.length} 张；全目录解码 RGBA：${(sumBefore / 1048576).toFixed(1)} → ${(sumAfter / 1048576).toFixed(1)} MiB`);
for (const t of targets) console.log(`  ${path.basename(t.f)}  ${t.w}x${t.h} → ${t.nw}x${t.nh}`);
if (DRY) { console.log('（dry-run，未写文件）'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-down-'));
let done = 0, fail = 0;
for (const t of targets) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    `$src = [System.Drawing.Image]::FromFile('${t.f.replace(/\\/g, '\\\\').replace(/'/g, "''")}')`,
    `$bmp = New-Object System.Drawing.Bitmap(${t.nw}, ${t.nh})`,
    `$g = [System.Drawing.Graphics]::FromImage($bmp)`,
    '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    `$g.DrawImage($src, 0, 0, ${t.nw}, ${t.nh})`,
    `$out = '${path.join(tmp, 'o.png').replace(/\\/g, '\\\\')}'`,
    '$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$g.Dispose(); $bmp.Dispose(); $src.Dispose()',
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  if (r.status === 0) {
    fs.copyFileSync(path.join(tmp, 'o.png'), t.f);
    done++;
  } else {
    fail++;
    console.error(`  ✗ ${t.f}: ${(r.stderr || r.stdout || '').trim().slice(0, 120)}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`完成：${done} 张缩放，${fail} 张失败。`);
process.exit(fail ? 1 : 0);
