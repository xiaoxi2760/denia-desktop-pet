// solar5 形态贴图降档：把材质实际引用的 PNG 大图（max(宽,高) >= 2048）离线缩到最大边 1024，
// 对齐红色形态贴图档位，降低显存/解码内存。
// 缩放引擎：PowerShell System.Drawing，HighQualityBicubic（写法对齐 tools/make-icon.mjs）。
// 只改工作副本 model/达妮娅_Solar5打歌服（领带uv修正）/达妮娅_Solar5打歌服1.12/TEX/，
// 绝不动原件 D:/denia/达妮娅_Solar5打歌服（领带uv修正）。回滚 = 从原件重拷。
//
// 用法（系统 PATH 无 node）：
//   C:/Users/Administrator/AppData/Local/hermes/node/node.exe solar5-downscale.mjs [--max-edge=1024] [--dry-run]
//   --max-edge   目标最大边，默认 1024；以后想换档位传别的值重跑（已缩过的图不会放大）
//   --threshold  缩放阈值：仅 max(宽,高) >= threshold 的 PNG 才缩，默认 2048
//   --dry-run    只测量 beforeMiB、列出缩放计划，不写任何文件
//
// 宽高一律从 PNG IHDR 读（文件头偏移 16-19 宽、20-23 高，大端），不信任 audit 里的缓存值。
// MiB 口径：材质引用的全部 PNG 按 解码RGBA = 宽×高×4 合计 / 1048576，前后同口径。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

// ---------- CLI ----------
const argMap = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([A-Za-z-]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const MAX_EDGE = Number(argMap['max-edge'] ?? 1024);
const THRESHOLD = Number(argMap['threshold'] ?? 2048);
const AUDIT = String(argMap['audit'] ?? 'D:/denia/research/model-adapt-2026-10-25/solar5-audit.json');
const MODEL_DIR = String(
  argMap['model-dir'] ??
    'D:/denia/娅娅桌宠-v1.0-内存优化版/model/达妮娅_Solar5打歌服（领带uv修正）/达妮娅_Solar5打歌服1.12'
);
const ORIGINAL_DIR = 'D:/denia/达妮娅_Solar5打歌服（领带uv修正）';
const RESULT = String(argMap['result'] ?? 'D:/denia/research/texture-downscale-2026-10-25/solar5-result.json');
const DRY_RUN = !!argMap['dry-run'];

if (!Number.isFinite(MAX_EDGE) || MAX_EDGE < 16) {
  console.error(`非法 --max-edge：${argMap['max-edge']}`);
  process.exit(1);
}

// ---------- PNG IHDR ----------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function readPngHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(24);
    const n = fs.readSync(fd, head, 0, 24, 0);
    if (n < 24) throw new Error('文件不足 24 字节，读不到 IHDR');
    if (!head.subarray(0, 8).equals(PNG_SIG)) throw new Error('PNG 签名不符');
    if (head.toString('latin1', 12, 16) !== 'IHDR') throw new Error('第一个 chunk 不是 IHDR');
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- 主流程 ----------
const audit = JSON.parse(fs.readFileSync(AUDIT, 'utf8'));
// 依据说明：solar5-audit.json 里没有 textureRefs 字段（grep 计数 0），
// 材质引用贴图清单取 textures[].ref（相对 PMX 所在目录），resolved 为 audit 已验证的归一路径。
const texRefs = audit.textures;
if (!Array.isArray(texRefs) || texRefs.length === 0) {
  console.error('audit JSON 里没有 textures 清单，无法继续');
  process.exit(1);
}

const entries = [];
const missing = [];
for (const t of texRefs) {
  const file = path.join(MODEL_DIR, t.resolved);
  if (!fs.existsSync(file)) {
    missing.push({ ref: t.ref, resolved: t.resolved, file });
    continue;
  }
  const isPng = /\.png$/i.test(t.resolved);
  const e = { ref: t.ref, resolved: t.resolved, file, isPng, oldW: null, oldH: null, err: null };
  if (isPng) {
    try {
      const { width, height } = readPngHeader(file);
      e.oldW = width;
      e.oldH = height;
    } catch (err) {
      e.err = err.message;
    }
  }
  entries.push(e);
}
if (missing.length > 0) {
  console.error(`工作副本缺文件 ${missing.length} 个，中止（不缩一半）:`);
  for (const m of missing) console.error(`  ${m.resolved}`);
  process.exit(1);
}

const decodeMiB = (px) => (px * 4) / 1048576;
const badPng = entries.filter((e) => e.isPng && e.err);
if (badPng.length > 0) {
  console.error(`有 PNG 读不出 IHDR，中止:`);
  for (const e of badPng) console.error(`  ${e.resolved}: ${e.err}`);
  process.exit(1);
}

// before：textureRefs 全部 PNG 的 宽×高×4 合计（缩放前实测）
const beforePx = entries.reduce((s, e) => (e.isPng ? s + e.oldW * e.oldH : s), 0);
const beforeMiB = decodeMiB(beforePx);

// 缩放计划：PNG 且 max(宽,高) >= threshold
const jobs = [];
const skipped = [];
for (const e of entries) {
  if (!e.isPng) {
    skipped.push({ ref: e.ref, resolved: e.resolved, reason: '非PNG(不碰)' });
    continue;
  }
  const maxEdge = Math.max(e.oldW, e.oldH);
  if (maxEdge < THRESHOLD) {
    skipped.push({ ref: e.ref, resolved: e.resolved, w: e.oldW, h: e.oldH, reason: `max边${maxEdge}<${THRESHOLD}(不碰)` });
    continue;
  }
  if (maxEdge <= MAX_EDGE) {
    skipped.push({ ref: e.ref, resolved: e.resolved, w: e.oldW, h: e.oldH, reason: `max边${maxEdge}已<=目标${MAX_EDGE}(不放大)` });
    continue;
  }
  const scale = MAX_EDGE / maxEdge;
  const nw = Math.max(1, Math.round(e.oldW * scale));
  const nh = Math.max(1, Math.round(e.oldH * scale));
  jobs.push({ index: jobs.length, src: e.file, dst: `${e.file}.downscale-tmp.png`, w: e.oldW, h: e.oldH, nw, nh, entry: e });
}

console.log(`[计划] 材质引用贴图 ${entries.length} 项（PNG ${entries.filter((e) => e.isPng).length} / 非PNG ${skipped.filter((s) => s.reason.startsWith('非PNG')).length}）`);
console.log(`[计划] beforeMiB = ${beforeMiB.toFixed(2)}（${entries.filter((e) => e.isPng).length} 张 PNG 解码RGBA 合计）`);
console.log(`[计划] 待缩放 ${jobs.length} 张 → 最大边 ${MAX_EDGE}；跳过 ${skipped.length} 张`);
for (const j of jobs) console.log(`  缩: ${path.basename(j.src)}  ${j.w}x${j.h} -> ${j.nw}x${j.nh}`);
for (const s of skipped) console.log(`  跳: ${s.resolved}  ${s.reason}`);

if (DRY_RUN) {
  console.log('[dry-run] 未写任何文件');
  process.exit(0);
}

if (jobs.length === 0) {
  writeResult({ beforeMiB, afterMiB: beforeMiB, resized: [], skipped, missing: [], error: null });
  console.log(`无可缩放项，result 已写 ${RESULT}`);
  process.exit(0);
}

// ---------- PowerShell System.Drawing 批量缩放（HighQualityBicubic，写法对齐 tools/make-icon.mjs） ----------
const psJobs = jobs.map(({ index, src, dst, w, h, nw, nh }) => ({ index, src, dst, w, h, nw, nh }));
const jobsJson = path.join(os.tmpdir(), `solar5-downscale-jobs-${process.pid}.json`);
const ps1 = path.join(os.tmpdir(), `solar5-downscale-${process.pid}.ps1`);
fs.writeFileSync(jobsJson, JSON.stringify(psJobs), 'utf8');
// ps1 里只写 ASCII；含中文的路径全部经 jobsJson（UTF-8）传入
fs.writeFileSync(
  ps1,
  [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    'Add-Type -AssemblyName System.Drawing',
    "$jobs = ConvertFrom-Json (Get-Content -Raw -Encoding UTF8 $args[0])",
    'foreach ($j in $jobs) {',
    '  try {',
    '    $bytes = [System.IO.File]::ReadAllBytes($j.src)',
    '    $ms = New-Object System.IO.MemoryStream (,$bytes)',
    '    $src = [System.Drawing.Image]::FromStream($ms)',
    '    $bmp = New-Object System.Drawing.Bitmap ([int]$j.nw), ([int]$j.nh)',
    '    $g = [System.Drawing.Graphics]::FromImage($bmp)',
    '    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality',
    '    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality',
    '    $g.DrawImage($src, 0, 0, [int]$j.nw, [int]$j.nh)',
    '    $bmp.Save($j.dst, [System.Drawing.Imaging.ImageFormat]::Png)',
    '    $g.Dispose(); $bmp.Dispose(); $src.Dispose(); $ms.Dispose()',
    '    Write-Output ("OK {0} {1}x{2}->{3}x{4}" -f $j.index, $j.w, $j.h, $j.nw, $j.nh)',
    '  } catch {',
    '    Write-Output ("FAIL {0} {1}" -f $j.index, $_.Exception.Message)',
    '  }',
    '}',
  ].join('\r\n'),
  'utf8'
);

const ps = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, jobsJson],
  { encoding: 'utf8', windowsHide: true }
);
fs.rmSync(jobsJson, { force: true });
fs.rmSync(ps1, { force: true });

const psLines = `${ps.stdout || ''}`.split(/\r?\n/).filter(Boolean);
const psFail = psLines.filter((l) => l.startsWith('FAIL'));
if (ps.status !== 0) {
  console.error(`PowerShell 异常退出 status=${ps.status}\n${ps.stderr || ps.stdout}`);
  for (const j of jobs) fs.rmSync(j.dst, { force: true });
  process.exit(1);
}

// ---------- 校验 + 覆盖 ----------
const resized = [];
const failed = [];
for (const j of jobs) {
  const line = psLines.find((l) => l.startsWith(`OK ${j.index} `) || l.startsWith(`FAIL ${j.index} `));
  if (!line || line.startsWith('FAIL')) {
    failed.push({ ref: j.entry.ref, resolved: j.entry.resolved, psLine: line ?? 'PS 无输出行' });
    fs.rmSync(j.dst, { force: true });
    continue;
  }
  // 独立复核：从临时文件 IHDR 读回实际尺寸，不符不覆盖
  let actual;
  try {
    actual = readPngHeader(j.dst);
  } catch (err) {
    failed.push({ ref: j.entry.ref, resolved: j.entry.resolved, psLine: line, verify: err.message });
    fs.rmSync(j.dst, { force: true });
    continue;
  }
  if (actual.width !== j.nw || actual.height !== j.nh) {
    failed.push({
      ref: j.entry.ref,
      resolved: j.entry.resolved,
      psLine: line,
      verify: `IHDR 实际 ${actual.width}x${actual.height} != 期望 ${j.nw}x${j.nh}`,
    });
    fs.rmSync(j.dst, { force: true });
    continue;
  }
  const bytesBefore = fs.statSync(j.src).size;
  fs.copyFileSync(j.dst, j.src); // 原文件名覆盖（PNG 进 PNG 出）
  fs.rmSync(j.dst, { force: true });
  const bytesAfter = fs.statSync(j.src).size;
  resized.push({
    ref: j.entry.ref,
    resolved: j.entry.resolved,
    file: j.src,
    oldW: j.w,
    oldH: j.h,
    newW: j.nw,
    newH: j.nh,
    bytesBefore,
    bytesAfter,
  });
}

if (failed.length > 0) {
  console.error(`${failed.length} 张缩放/校验失败（未覆盖这些文件）:`);
  for (const f of failed) console.error(`  ${f.resolved}: ${JSON.stringify(f)}`);
}

// ---------- after：同口径重测 ----------
const afterPx = entries.reduce((s, e) => {
  if (!e.isPng) return s;
  const { width, height } = readPngHeader(e.file); // 已覆盖的读新尺寸
  return s + width * height;
}, 0);
const afterMiB = decodeMiB(afterPx);

writeResult({ beforeMiB, afterMiB, resized, skipped, missing: [], failed, error: failed.length > 0 ? `${failed.length} 张失败` : null });

console.log(`[结果] 缩放 ${resized.length} 张`);
for (const r of resized) {
  console.log(`  ${r.resolved}: ${r.oldW}x${r.oldH} -> ${r.newW}x${r.newH}（磁盘 ${(r.bytesBefore / 1024).toFixed(0)}KB -> ${(r.bytesAfter / 1024).toFixed(0)}KB）`);
}
console.log(`[结果] beforeMiB=${beforeMiB.toFixed(2)}  afterMiB=${afterMiB.toFixed(2)}  省 ${ (beforeMiB - afterMiB).toFixed(2) } MiB（解码RGBA 口径）`);
console.log(`[结果] result 已写 ${RESULT}`);
if (failed.length > 0) process.exit(2);

function writeResult(data) {
  const out = {
    form: 'solar5',
    generatedAt: new Date().toISOString(),
    auditPath: AUDIT,
    auditFieldNote:
      'solar5-audit.json 无 textureRefs 字段（grep 计数 0）；按 textures[].ref（相对 PMX 所在目录，20 项）取材质实际引用贴图清单',
    modelDirWork: MODEL_DIR,
    originalDirRollback: ORIGINAL_DIR,
    targetMaxEdge: MAX_EDGE,
    thresholdMaxEdge: THRESHOLD,
    mibScope: 'textureRefs 全部 PNG 的 宽×高×4（解码RGBA）合计 / 1048576，宽高从 PNG IHDR 实读',
    beforeMiB: Number(data.beforeMiB.toFixed(2)),
    afterMiB: Number(data.afterMiB.toFixed(2)),
    savedMiB: Number((data.beforeMiB - data.afterMiB).toFixed(2)),
    resizedCount: data.resized.length,
    resized: data.resized,
    skipped: data.skipped,
    failed: data.failed ?? [],
    missing: data.missing ?? [],
    error: data.error ?? null,
  };
  fs.mkdirSync(path.dirname(RESULT), { recursive: true });
  fs.writeFileSync(RESULT, JSON.stringify(out, null, 2), 'utf8');
}
