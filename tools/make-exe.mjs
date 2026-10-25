// 打包脚本：把当前项目打成「双击即用」的 娅娅.exe 发布目录。
// 用法（项目根目录）：
//   双击 打包成exe.cmd（内部执行：ELECTRON_RUN_AS_NODE=1 electron.exe tools/make-exe.mjs）
// 产物：发布/娅娅桌宠/娅娅.exe（含全部运行库、源码与模型，可整体搬走）
//
// 布局 = 标准 Electron 应用结构：
//   娅娅.exe（electron.exe 改名）+ 运行库 dll + resources/app/{源码,model,...}
// main.cjs 的 ROOT = resources/app，因此 model/ 放 resources/app/model。
// userData 仍按 package.json 的 name（denia-desktop）走 %APPDATA%，与开发目录共用配置。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SRC = path.resolve(import.meta.dirname, '..');
const OUT = path.join(SRC, '发布', '娅娅桌宠');
const APP = path.join(OUT, 'resources', 'app');
const DIST = path.join(SRC, 'node_modules', 'electron', 'dist');

const copyDir = (from, to) => fs.cpSync(from, to, { recursive: true });
const sizeMb = (p) => {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else total += fs.statSync(f).size;
    }
  };
  try { walk(p); } catch { return 0; }
  return (total / 1048576).toFixed(1);
};

// —— ico（Vista+ 支持在 ico 里直接嵌 PNG；给快捷方式「更改图标」用）——
function pngToIco(pngPath, icoPath) {
  const png = fs.readFileSync(pngPath);
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); // ico, 1 张图
  const entry = Buffer.alloc(16);
  entry.writeUInt8(w >= 256 ? 0 : w, 0); entry.writeUInt8(h >= 256 ? 0 : h, 1);
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);       // 1 个调色板位？0；32bpp
  entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12); // 数据长度；偏移 = 6+16
  fs.writeFileSync(icoPath, Buffer.concat([header, entry, png]));
}

console.log('[1/6] 清理并创建输出目录 …');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });

console.log('[2/6] 复制 Electron 运行库 …');
if (!fs.existsSync(path.join(DIST, 'electron.exe'))) {
  console.error('  找不到 node_modules/electron/dist/electron.exe —— 先在项目目录 npm install');
  process.exit(1);
}
copyDir(DIST, OUT);

console.log('[3/6] 复制应用源码 …');
for (const name of ['electron', 'app', 'assets', 'tools', 'motions', 'docs']) {
  copyDir(path.join(SRC, name), path.join(APP, name));
}
for (const name of ['package.json', 'package-lock.json', 'config.example.json', 'README.md', 'CHANGELOG.md']) {
  const f = path.join(SRC, name);
  if (fs.existsSync(f)) fs.copyFileSync(f, path.join(APP, name));
}

console.log('[4/6] 复制模型（较大，稍等）…');
copyDir(path.join(SRC, 'model'), path.join(APP, 'model'));

console.log('[5/6] 改名 exe + 图标 …');
fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, '娅娅.exe'));
// 快捷方式图标：优先用 tools/make-icon.mjs 生成的多尺寸 icon.ico；没有就单尺寸兜底
const iconSrc = fs.existsSync(path.join(SRC, 'assets', 'icon.ico'))
  ? path.join(SRC, 'assets', 'icon.ico') : null;
if (iconSrc) {
  fs.copyFileSync(iconSrc, path.join(OUT, '娅娅.ico'));
} else {
  pngToIco(path.join(SRC, 'assets', 'tray.png'), path.join(OUT, '娅娅.ico'));
}
// exe 内嵌图标（rcedit）：文件管理器/任务栏里就不是 Electron 默认图标了。
// 工具随仓库带（tools/rcedit-x64.exe，GitHub releases v2.0.0）；没有就跳过并提示。
const rcedit = path.join(SRC, 'tools', 'rcedit-x64.exe');
const icoForExe = path.join(OUT, '娅娅.ico');
if (fs.existsSync(rcedit)) {
  const r = spawnSync(rcedit, [path.join(OUT, '娅娅.exe'), '--set-icon', icoForExe], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log('  exe 图标已内嵌。');
  } else {
    console.log('  ⚠ rcedit 失败（图标未内嵌，快捷方式仍可用 娅娅.ico）：', (r.stderr || r.stdout || '').trim().slice(0, 200));
  }
} else {
  console.log('  ⚠ 缺 tools/rcedit-x64.exe，跳过 exe 内嵌图标（不影响功能）。');
}

fs.writeFileSync(path.join(OUT, '使用说明.txt'), [
  '娅娅 · 桌面宠物（免安装版）',
  '',
  '· 双击「娅娅.exe」启动：先出启动器，选形态（白娅娅 / 黑娅娅 / Solar5娅娅 / 白裙绷带娅娅）、',
  '  窗口大小、画质和物理再叫她出来。启动器启动后会缩到后台，托盘菜单、右键她本人、',
  '  或再双击一次娅娅.exe 都能重新唤出来（换形态 / 重启 / 关闭都在里面）。',
  '· 她是透明置顶窗口，不进任务栏（桌宠的常态）。',
  '· 藏起来 / 叫出来：Ctrl+Alt+Y，或再双击一次娅娅.exe，或点任务栏托盘图标',
  '  （Win11 可能把它收在任务栏右下角的 ^ 溢出区里，可以拖出来固定）。',
  '· 开机自启：托盘菜单勾「开机自动出现」，或 Win+R 输入 shell:startup，',
  '  把娅娅.exe 的快捷方式放进去。',
  '· 桌面快捷方式想换图标：右键快捷方式 → 属性 → 更改图标 → 选本目录的 娅娅.ico。',
  '· 整个文件夹可以整体搬走/复制到别的机器（模型已内置；配置在 %APPDATA%/denia-desktop）。',
  '· 模型版权归广州库洛科技（鸣潮二次创作素材），禁止再配布与商用——',
  '  这个文件夹只能自己用，不要发给别人。',
  '',
].join('\r\n'));

console.log('[6/6] 完成。');
console.log(`  产物目录：${OUT}`);
console.log(`  总大小：约 ${sizeMb(OUT)} MB（含 Electron 运行库与模型）`);
console.log('  双击 娅娅.exe 启动；整个文件夹可整体搬走。');
