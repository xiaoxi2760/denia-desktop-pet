// 形态截图工具：启动桌宠（dev 运行库）→ 加载指定形态 → 铺品红背景 → 截图存盘 → 优雅退出。
// 用途：视觉回归验证（半透明材质在品红底上一眼可见；正常材质完全不透底色）。
// 用法：node tools/capture-form.mjs <red|blue|solar5|white> <输出.png> [端口=9410]
// 注意：会临时改写 userData/launcher.json（结束时还原）；需要独占运行（单实例锁）。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FORM = process.argv[2];
const OUT = process.argv[3];
const PORT = Number(process.argv[4]) || 9410;
const CFG = path.join(process.env.APPDATA || '', 'denia-desktop', 'launcher.json');
if (!FORM || !OUT) { console.error('用法: node tools/capture-form.mjs <form> <out.png> [port]'); process.exit(2); }

// launcher.json 备份 → 临时写入直启配置
let backup = null;
try { backup = fs.readFileSync(CFG, 'utf8'); } catch { /* 原本就没有 */ }
try { fs.mkdirSync(path.dirname(CFG), { recursive: true }); } catch {}
fs.writeFileSync(CFG, JSON.stringify({ form: FORM, size: 'standard', dpr: 2, phys: 'off', skip: true }));

const ENV = Object.fromEntries(Object.entries(process.env).filter(
  ([k]) => !/^CHROME/i.test(k) && !/^ELECTRON_/i.test(k) && k !== 'NODE_OPTIONS',
));
const proc = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  [`--remote-debugging-port=${PORT}`, ROOT], { cwd: ROOT, env: ENV });

const getJson = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const restore = () => {
  try { if (backup === null) fs.rmSync(CFG, { force: true }); else fs.writeFileSync(CFG, backup); } catch { /* 尽力 */ }
};
let restoreBg = null;   // 关闭前把品红底还原（即使 Browser.close 失败，残留实例也不是紫的）
const cleanup = async (graceful) => {
  try { if (restoreBg) await restoreBg(); } catch { /* 尽力 */ }
  if (graceful) {
    try {
      const ver = await getJson('/json/version');
      await new Promise((res) => {
        const bws = new WebSocket(ver.webSocketDebuggerUrl);
        bws.onopen = () => { bws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); setTimeout(res, 4000); };
        bws.onerror = () => res();
      });
    } catch { /* 忽略 */ }
  }
  for (let i = 0; i < 10 && proc.exitCode === null; i++) await sleep(1000);
  if (proc.exitCode === null) { try { proc.kill('SIGKILL'); } catch {} }
  restore();
};

try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    if (proc.exitCode !== null) throw new Error('应用提前退出，exit=' + proc.exitCode);
    const list = await getJson('/json/list').catch(() => []);
    page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || null;
    if (!page) await sleep(1000);
  }
  if (!page) throw new Error('60 秒内没等到桌宠页');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  // 2026-10-25：把窗口挪到主屏右侧屏幕外再截——之前品红底窗口会在用户桌面上
  // 挂几十秒，被当成"桌宠出 bug 了"。挪出可视区后整个截图流程对用户无感。
  try {
    const scr = await send('Runtime.evaluate', { expression: 'window.pet.getScreen().then((s) => JSON.stringify(s.workArea))', awaitPromise: true, returnByValue: true });
    const wa = JSON.parse(scr?.result?.result?.value || '{}');
    if (wa && typeof wa.x === 'number' && typeof wa.width === 'number') {
      const win = await send('Browser.getWindowForTarget', {});
      const windowId = win?.result?.windowId;
      if (windowId !== undefined) {
        await send('Browser.setWindowBounds', { windowId, bounds: { left: wa.x + wa.width + 80, top: wa.y + 120 } });
      }
    }
  } catch { /* 挪不出去就照常截，只是会被看见一会儿 */ }

  let loaded = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (proc.exitCode !== null) throw new Error('加载期间应用退出');
    const r = await send('Runtime.evaluate', { expression: 'JSON.stringify({mesh:!!window.__mesh, status:window.__status})', returnByValue: true });
    try { loaded = !!JSON.parse(r?.result?.result?.value).mesh; } catch { loaded = false; }
    if (loaded) break;
  }
  if (!loaded) throw new Error('模型 60 秒内没加载完');
  await sleep(2500);   // 等表情/姿态稳定

  // 铺品红底：alpha 画布透出 body 背景，半透明材质会透出品红，正常材质完全不透。
  // （试过 CDP Emulation.setDefaultBackgroundColorOverride，会被透明画布压成黑，不如 CSS 直铺）
  await send('Runtime.evaluate', { expression: "document.body.style.background='#ff00ff'" });
  restoreBg = () => send('Runtime.evaluate', { expression: "document.body.style.background=''" });
  await sleep(800);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const b64 = shot?.result?.data;
  if (!b64) throw new Error('截图失败');
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
  console.log(`OK ${FORM} → ${OUT}（${(b64.length / 1024).toFixed(0)} KB b64，exit 后见文件）`);
  await cleanup(true);
  process.exit(0);
} catch (e) {
  console.error('FAIL:', e?.message || e);
  await cleanup(false);
  process.exit(1);
}
