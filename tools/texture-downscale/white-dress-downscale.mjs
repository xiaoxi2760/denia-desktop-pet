// 白裙形态贴图离线降档：把材质引用的大 PNG 缩到指定最大边（默认 1024，对齐红色形态档位）。
// 用法：node white-dress-downscale.mjs [目标最大边=1024] [--dry-run]
//   --dry-run 只统计与分类，不改任何文件、不写 result.json。
// 口径：
//   - 处理对象 = audit JSON 的 textureRefs 里、扩展名 .png（大小写不敏感）且 max(宽,高) ≥ 2048 的文件。
//   - TGA / BMP / 小于 2048 的 / 不在 textureRefs 里的一律不碰。
//   - beforeMiB / afterMiB = textureRefs 中【全部 PNG】的 宽×高×4 / 1048576（解码 RGBA 合计），
//     宽高从 PNG IHDR（偏移 16/20，大端）读取，不猜。
//   - 缩放走 PowerShell System.Drawing，InterpolationMode=HighQualityBicubic（参考 tools/make-icon.mjs），
//     另加 TileFlipXY 包边消低透明边缘彩边；先输出到临时目录再覆盖回 TEX/，失败不碰原件。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.resolve(HERE, '../model-adapt-2026-10-25/white-dress-audit.json');
const RESULT = path.join(HERE, 'white-dress-result.json');
// PMX 所在目录（TEX/ 与 PMX 同层）。必须是内存优化版工作副本，绝不是 D:/denia 下的原件。
const PMX_DIR =
  'D:/denia/娅娅桌宠-v1.0-内存优化版/model/' +
  '鸣潮_达妮娅_白裙绷带(修模绑骨后）_by_鸣潮_556e8ac6dabdfeb7db46131a387ec923/白裙绷带1.02';

const THRESHOLD = 2048; // 只缩 max(宽,高) ≥ 2048 的 PNG
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const MAX_EDGE = Number(args.find((a) => !a.startsWith('--')) ?? 1024);
if (!Number.isFinite(MAX_EDGE) || MAX_EDGE <= 0) {
  console.error(`非法目标尺寸: ${MAX_EDGE}`);
  process.exit(1);
}

// ---- 工具 ----
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngSize(file) {
  // 从 PNG IHDR 读宽高：文件头 8 字节签名 + 8 字节 chunk 头，宽在 16-19、高在 20-23（大端）
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(24);
    const n = fs.readSync(fd, head, 0, 24, 0);
    if (n < 24) return null;
    if (!head.subarray(0, 8).equals(PNG_SIG)) return null;
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}
const isPngName = (p) => path.extname(p).toLowerCase() === '.png';

// ---- 1) 取 textureRefs 并分类 ----
if (!PMX_DIR.includes('娅娅桌宠-v1.0-内存优化版')) {
  console.error('PMX_DIR 指向的不是内存优化版工作副本，拒绝执行。');
  process.exit(1);
}
const audit = JSON.parse(fs.readFileSync(AUDIT, 'utf8'));
const refs = audit.textureRefs;
if (!Array.isArray(refs) || refs.length === 0) {
  console.error(`audit JSON 无 textureRefs: ${AUDIT}`);
  process.exit(1);
}

const pngs = []; // { ref, abs, w, h }
const skipped = []; // { ref, reason, w?, h? }
for (const ref of refs) {
  const abs = path.resolve(PMX_DIR, String(ref).replace(/\\/g, '/'));
  if (!fs.existsSync(abs)) {
    skipped.push({ ref, reason: 'missing' });
    continue;
  }
  if (!isPngName(abs)) {
    skipped.push({ ref, reason: `not-png(${path.extname(abs)})` }); // TGA/BMP 不碰
    continue;
  }
  const size = pngSize(abs);
  if (!size) {
    skipped.push({ ref, reason: 'not-valid-png' });
    continue;
  }
  if (Math.max(size.w, size.h) < THRESHOLD) {
    skipped.push({ ref, reason: 'below-threshold', w: size.w, h: size.h });
    continue;
  }
  pngs.push({ ref, abs, w: size.w, h: size.h });
}

// textureRefs 全部 PNG 的解码 RGBA 合计（before 口径）
function rgbaMiBAllPngs() {
  let bytes = 0;
  let count = 0;
  for (const ref of refs) {
    const abs = path.resolve(PMX_DIR, String(ref).replace(/\\/g, '/'));
    if (!fs.existsSync(abs) || !isPngName(abs)) continue;
    const size = pngSize(abs);
    if (!size) continue;
    bytes += size.w * size.h * 4;
    count += 1;
  }
  return { mib: bytes / 1048576, count };
}
const before = rgbaMiBAllPngs();

console.log(`audit: ${path.relative(process.cwd(), AUDIT) || AUDIT}`);
console.log(`textureRefs 总数 ${refs.length}，其中 PNG ${before.count} 个`);
console.log(`待缩放（PNG 且 max边≥${THRESHOLD}）：${pngs.length} 个，目标最大边 ${MAX_EDGE}`);
for (const p of pngs) console.log(`  [big ] ${p.ref}  ${p.w}x${p.h}`);
for (const s of skipped) console.log(`  [skip] ${s.ref}  ${s.reason}${s.w ? ` ${s.w}x${s.h}` : ''}`);
console.log(`beforeMiB（textureRefs 全部 PNG 宽×高×4）= ${before.mib.toFixed(2)} MiB`);

if (dryRun) {
  console.log('--dry-run：未修改任何文件。');
  process.exit(0);
}

// ---- 2) 生成清单，PowerShell System.Drawing 缩到临时目录 ----
const plan = pngs.map((p, i) => {
  const f = MAX_EDGE / Math.max(p.w, p.h);
  return { ...p, id: i, newW: Math.max(1, Math.round(p.w * f)), newH: Math.max(1, Math.round(p.h * f)) };
});
if (plan.some((p) => p.newW > p.w || p.newH > p.h)) {
  console.error('出现放大项，中止（本脚本只缩不放）。');
  process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaya-white-tex-'));
const manifest = path.join(tmp, 'manifest.json');
// UTF-8 带 BOM，保证 Windows PowerShell 5.1 按 UTF-8 读（路径含中文）
fs.writeFileSync(manifest, '\uFEFF' + JSON.stringify({
  items: plan.map((p) => ({ id: p.id, src: p.abs, out: path.join(tmp, `out${p.id}.png`), w: p.newW, h: p.newH })),
}));

const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$m = [System.IO.File]::ReadAllText('${manifest.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8) | ConvertFrom-Json
foreach ($item in $m.items) {
  try {
    $src = [System.Drawing.Image]::FromFile($item.src)
    $bmp = New-Object System.Drawing.Bitmap($item.w, $item.h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $ia = New-Object System.Drawing.Imaging.ImageAttributes
    $ia.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $item.w, $item.h)
    $g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $ia)
    $g.Dispose(); $src.Dispose()
    $bmp.Save($item.out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ('OK ' + $item.id)
  } catch {
    Write-Output ('FAIL ' + $item.id + ' ' + $_.Exception.Message)
    exit 1
  }
}
`.trim();
const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error('PowerShell 缩放失败：\n' + (r.stdout || '') + (r.stderr || ''));
  process.exit(1);
}

// ---- 3) 校验临时产物（PNG 签名 + 尺寸），再覆盖回 TEX/ ----
const resized = [];
for (const p of plan) {
  const out = path.join(tmp, `out${p.id}.png`);
  const size = pngSize(out);
  if (!size || size.w !== p.newW || size.h !== p.newH) {
    console.error(`产物校验失败: ${p.ref} 期望 ${p.newW}x${p.newH}，实际 ${size ? size.w + 'x' + size.h : '非PNG'}`);
    process.exit(1);
  }
  const bytesBefore = fs.statSync(p.abs).size;
  fs.copyFileSync(out, p.abs); // 原文件名覆盖
  const size2 = pngSize(p.abs);
  if (!size2 || size2.w !== p.newW || size2.h !== p.newH) {
    console.error(`覆盖后校验失败: ${p.ref}`);
    process.exit(1);
  }
  resized.push({
    ref: p.ref,
    file: p.abs,
    oldW: p.w, oldH: p.h,
    newW: size2.w, newH: size2.h,
    fileBytesBefore: bytesBefore,
    fileBytesAfter: fs.statSync(p.abs).size,
  });
  console.log(`已缩放: ${p.ref}  ${p.w}x${p.h} -> ${size2.w}x${size2.h}`);
}
fs.rmSync(tmp, { recursive: true, force: true });

// ---- 4) after 口径 + 结果 JSON ----
const after = rgbaMiBAllPngs();
const result = {
  generatedAt: new Date().toISOString(),
  form: 'white',
  auditSource: 'research/model-adapt-2026-10-25/white-dress-audit.json (textureRefs)',
  pmxDir: PMX_DIR,
  threshold: THRESHOLD,
  targetMaxEdge: MAX_EDGE,
  metric: 'textureRefs 中全部 PNG 的 宽×高×4 / 1048576（解码 RGBA），宽高读自 PNG IHDR 偏移16/20',
  pngRefCount: after.count,
  beforeMiB: Number(before.mib.toFixed(2)),
  afterMiB: Number(after.mib.toFixed(2)),
  resizedCount: resized.length,
  resized,
  skipped,
};
fs.writeFileSync(RESULT, JSON.stringify(result, null, 2) + '\n');
console.log(`afterMiB（同口径）= ${after.mib.toFixed(2)} MiB，节省 ${(before.mib - after.mib).toFixed(2)} MiB`);
console.log(`结果清单已写入 ${RESULT}`);
