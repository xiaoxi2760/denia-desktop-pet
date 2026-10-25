// 娅娅桌面版 · 主进程
// 职责：透明置顶窗口 / 本地资源协议 / 托盘 / 拖拽 / 鼠标穿透 / 右键菜单
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, protocol, screen, shell, powerMonitor, session, desktopCapturer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createWhisperIdleController, createAsrCoordinator, waitReadyBounded, DEFAULT_IDLE_MS: WHISPER_IDLE_DEFAULT_MS } = require('./whisper-idle.cjs');

const SELF_TEST = process.env.PET_STANDALONE_SELFTEST === '1';

const ROOT = path.join(__dirname, '..');
const SCHEME = 'denia';
const DEV = process.argv.includes('--dev');
// 允许无人操作时自动播放她的语音
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── 她的大脑：Windows → pc 的 SSH 隧道 + 桥接控制台接口 ──────────────
function loadLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.local.json'), 'utf8'));
  } catch {
    return {};
  }
}
const localCfg = loadLocalConfig();
const TUNNEL_PORT = Number(localCfg.tunnelLocalPort) || 13100;
const BRIDGE_PORT = Number(localCfg.bridgePort) || 3100;
const SSH_HOST = String(localCfg.sshHost || 'pc');
const OWNER_QQ = String(localCfg.ownerQQ || '');
const CHAT_KEY = `private:${OWNER_QQ}`;
const BASE = `http://127.0.0.1:${TUNNEL_PORT}`;
let tunnelProc = null;
let tunnelReady = false;

// ── 独立模式（无大脑，朋友也能用）：设置页直连 OpenAI 兼容模型 + 本地语音 ──────
// 默认关闭：开着时 pet:say / pet:voice 不再走桥接，而是走这里。
// 语音引擎的出厂默认（可在设置页改；engine=sapi 为本机Windows语音，其余是"复刻声线"接口）
const STANDALONE_VOICE_DEFAULTS = {
  engine: 'sapi',                        // sapi | sovits | fish | openai | volcano
  sapiVoice: 'Microsoft Huihui Desktop',
  // GPT-SoVITS 本地服务（api_v2）——就是主机那边娅娅用的同款引擎
  sovitsUrl: 'http://127.0.0.1:9880',
  sovitsRef: '', sovitsPrompt: '', sovitsPromptLang: 'zh', sovitsLang: 'auto',
  sovitsGptWeights: '', sovitsSovitsWeights: '', sovitsSpeed: 1,
  // Fish Audio（fish.audio：网站上传音频复刻音色 → 得到音色 ID 填这里）
  fishUrl: 'https://api.fish.audio', fishKey: '', fishRefId: '', fishModel: 's1',
  // OpenAI 兼容 /v1/audio/speech（硅基流动 CosyVoice2 等）
  oaiUrl: 'https://api.siliconflow.cn/v1', oaiKey: '', oaiModel: 'FunAudioLLM/CosyVoice2-0.5B', oaiVoice: '',
  // 火山引擎（豆包）语音合成 / 声音复刻（AppID + Access Token + 声音ID S_xxx，集群默认 volcano_icl）
  volcanoUrl: 'https://openspeech.bytedance.com/api/v1/tts',
  volcanoAppId: '', volcanoToken: '', volcanoCluster: 'volcano_icl', volcanoVoiceId: '', volcanoSpeed: 1,
  // 火山引擎·新版控制台（V3 单向流式 SSE：只需 API Key；支持声音复刻2.0）
  volcano3Url: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',
  volcano3ApiKey: '', volcano3AppId: '', volcano3AccessKey: '',
  volcano3Resource: 'seed-icl-2.0', volcano3Speaker: '', volcano3SpeechRate: 0,
  // MiniMax（海螺）语音合成（音色快速复刻 → Voice ID；模型如 speech-2.8-hd）
  minimaxUrl: 'https://api.minimax.cn/v1/t2a_v2',
  minimaxKey: '', minimaxVoiceId: '', minimaxModel: 'speech-2.8-hd', minimaxSpeed: 1,
};

const STANDALONE = Object.assign({
  enabled: false,
  baseUrl: 'https://discovery-api.intern-ai.org.cn/v1',
  apiKey: '',
  model: 'deepseek-v4-flash-0731',
  persona: '',             // 留空 = 使用内置 assets/standalone-persona.md（鸣潮官方向达妮娅卡）
  ttsVoice: 'Microsoft Huihui Desktop',
  voice: {},
  historyLimit: 40,
  maxTokens: 2048,
}, (localCfg.standalone && typeof localCfg.standalone === 'object') ? localCfg.standalone : {});
STANDALONE.voice = Object.assign({}, STANDALONE_VOICE_DEFAULTS, (STANDALONE.voice && typeof STANDALONE.voice === 'object') ? STANDALONE.voice : {});
// 兼容更早的配置：声音名写在 ttsVoice 里
if (!STANDALONE.voice.sapiVoice) STANDALONE.voice.sapiVoice = STANDALONE.ttsVoice || STANDALONE_VOICE_DEFAULTS.sapiVoice;

function builtinStandalonePersona() {
  try {
    return fs.readFileSync(path.join(ROOT, 'assets', 'standalone-persona.md'), 'utf8').trim();
  } catch {
    return '你是《鸣潮》里的达妮娅，星炬学院的学生。';
  }
}

const STANDALONE_HISTORY = [];

// ── 无bot·本地"看屏幕 / 陪看"：本机截屏 + 视觉模型 ─────────────────────
// 桥接模式里这两项靠主机大脑抓屏；独立模式改为本地截屏、直接发给（朋友自己的）
// 视觉模型。要求对话模型支持"看图"（如 deepseek-v4-flash-vision）。
const STANDALONE_INBOX = [];   // 她的主动发言队列（renderer 轮询 pet:recent 来消费）

async function captureScreenJpeg(width = 1280, quality = 60) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height: Math.round((width * 9) / 16) } });
  if (!sources || !sources.length) throw new Error('抓不到屏幕（desktopCapturer 为空）');
  const img = sources[0].thumbnail;
  if (img.isEmpty()) throw new Error('抓屏结果是空图');
  return img.toJPEG(quality);
}

async function captureScreenBitmap(width = 320) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height: Math.round((width * 9) / 16) } });
  if (!sources || !sources.length) throw new Error('抓不到屏幕');
  const img = sources[0].thumbnail;
  if (img.isEmpty()) throw new Error('抓屏结果是空图');
  return img.toBitmap();
}

/** 两帧位图的粗略差异（采样比对 B 通道，返回百分比） */
function bitmapDiffPercent(a, b) {
  if (!a || !b || a.length !== b.length) return 100;
  let changed = 0;
  let count = 0;
  const step = 4 * 61;   // 每 61 个像素采样一次
  for (let i = 0; i < a.length; i += step) { count++; if (Math.abs(a[i] - b[i]) > 24) changed++; }
  return count ? (changed / count) * 100 : 0;
}

/** 单次"看图"（不带对话历史）：陪看/看屏专用，省 token 也不污染聊天上下文 */
async function standaloneVisionOnce(text, jpegBuf, maxTokens = 300) {
  if (!STANDALONE.apiKey) throw new Error('独立模式还没配 API Key');
  const sys = String(STANDALONE.persona || '').trim() || builtinStandalonePersona();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const res = await fetch(`${String(STANDALONE.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${STANDALONE.apiKey}` },
      body: JSON.stringify({
        model: STANDALONE.model,
        messages: [
          { role: 'system', content: sys },
          {
            role: 'user',
            content: [
              { type: 'text', text },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + jpegBuf.toString('base64') } },
            ],
          },
        ],
        max_tokens: Math.max(64, Number(maxTokens) || 300),
        stream: false,
      }),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const base = String(data?.error?.message || `HTTP ${res.status}`);
      return { ok: false, error: base + '（看屏幕需要支持"看图"的模型，换一个视觉模型再试）' };
    }
    const reply = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (!reply) return { ok: false, error: '模型没有返回内容（看屏幕需要支持"看图"的模型）' };
    return { ok: true, reply };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const WATCH_PROMPTS = {
  quiet: '（你正安静地陪主人看屏幕，偶尔瞄一眼。看到明显的变化、或者有意思的东西，就慵懒地轻声说一句，一个短句就好；没什么值得说的就只回复一个「…」。不要提问、不要罗列。）',
  chatty: '（你正陪主人看屏幕，话多一点：看到变化就随口念叨一句，一两句话就好，语气懒散一点。实在没什么可说的才回复一个「…」。不要提问、不要罗列。）',
};
const LOCAL_WATCH_PRESETS = {
  quiet: { intervalMs: 60000, diffPercent: 6, minGapMs: 240000, maxPerHour: 6 },
  chatty: { intervalMs: 30000, diffPercent: 2.5, minGapMs: 60000, maxPerHour: 30 },
};
let localWatch = null;

function startLocalWatch(mode) {
  const m = mode === 'chatty' ? 'chatty' : 'quiet';
  const p = LOCAL_WATCH_PRESETS[m];
  if (localWatch) clearInterval(localWatch.timer);
  else localWatch = { mode: m, lastBitmap: null, lastSpeakAt: 0, speaks: [], tickBusy: false };
  localWatch.mode = m;
  localWatch.timer = setInterval(() => { localWatchTick().catch(() => {}); }, p.intervalMs);
  // 开看她的时候先瞄一眼（略等几秒，等窗口/视线稳定）
  setTimeout(() => { if (localWatch) localWatchTick(true).catch(() => {}); }, 6000);
  console.log(`[watch-local] 陪看开始（${m}，每 ${Math.round(p.intervalMs / 1000)} 秒看一眼）`);
}

function stopLocalWatch() {
  if (!localWatch) return;
  clearInterval(localWatch.timer);
  localWatch = null;
  console.log('[watch-local] 陪看结束');
}

async function localWatchTick(force = false) {
  if (!STANDALONE.enabled || !localWatch || localWatch.tickBusy) return null;
  localWatch.tickBusy = true;
  try {
    const bitmap = await captureScreenBitmap(320);
    const diff = bitmapDiffPercent(localWatch.lastBitmap, bitmap);
    localWatch.lastBitmap = bitmap;
    const p = LOCAL_WATCH_PRESETS[localWatch.mode];
    const now = Date.now();
    localWatch.speaks = localWatch.speaks.filter((t) => now - t < 3600000);
    const canSpeak = now - localWatch.lastSpeakAt >= p.minGapMs && localWatch.speaks.length < p.maxPerHour;
    if (!force && !(diff >= p.diffPercent && canSpeak)) return { diff: Math.round(diff), spoke: false, queued: STANDALONE_INBOX.length };
    const jpeg = await captureScreenJpeg(960, 55);
    const r = await standaloneVisionOnce(WATCH_PROMPTS[localWatch.mode], jpeg, 220);
    if (!r.ok) return { diff: Math.round(diff), spoke: false, error: r.error, queued: STANDALONE_INBOX.length };
    const t = String(r.reply || '').trim();
    if (!t || /^[.。…，,~～\s]{0,4}$/.test(t)) return { diff: Math.round(diff), spoke: false, skipped: true, queued: STANDALONE_INBOX.length };
    localWatch.lastSpeakAt = now;
    localWatch.speaks.push(now);
    STANDALONE_INBOX.push({ ts: now, text: t });
    return { diff: Math.round(diff), spoke: true, reply: t, queued: STANDALONE_INBOX.length };
  } catch (e) {
    return { spoke: false, error: String(e?.message || e) };
  } finally {
    localWatch.tickBusy = false;
  }
}

async function standaloneReply(text) {
  if (!STANDALONE.apiKey) return { ok: false, error: '独立模式还没配 API Key（托盘 → 独立 AI 设置）' };
  const sys = String(STANDALONE.persona || '').trim() || builtinStandalonePersona();
  // 无bot 版的"看屏幕 / 陪看"：本地截屏（原来这两项靠主机大脑）
  const wantLook = /^看看屏幕$/.test(text);
  if (/^陪我看会儿$/.test(text)) startLocalWatch('quiet');   // 默认安静档；renderer 随后会用 watchPreset 校正档位
  if (/^别看了$/.test(text)) stopLocalWatch();
  let imageJpeg = null;
  if (wantLook) {
    try { imageJpeg = await captureScreenJpeg(1280, 60); }
    catch (e) { return { ok: false, error: '抓屏失败：' + String(e?.message || e) }; }
  }
  const userMsg = imageJpeg
    ? {
      role: 'user',
      content: [
        { type: 'text', text: '（给你看了一眼我现在的屏幕，随便看看，懒散地说一两句就行，不要提问。）' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageJpeg.toString('base64') } },
      ],
    }
    : null;
  STANDALONE_HISTORY.push({ role: 'user', content: imageJpeg ? '（她看了一眼我现在的屏幕）' : text });
  const keep = Math.max(2, Number(STANDALONE.historyLimit) || 40);
  while (STANDALONE_HISTORY.length > keep) STANDALONE_HISTORY.shift();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const res = await fetch(`${String(STANDALONE.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${STANDALONE.apiKey}` },
      body: JSON.stringify({
        model: STANDALONE.model,
        messages: userMsg
          ? [{ role: 'system', content: sys }, ...STANDALONE_HISTORY.slice(0, -1), userMsg]
          : [{ role: 'system', content: sys }, ...STANDALONE_HISTORY],
        max_tokens: Math.max(64, Number(STANDALONE.maxTokens) || 2048),
        stream: false,
      }),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      STANDALONE_HISTORY.pop();
      const base = String(data?.error?.message || data?.base_resp?.status_msg || `HTTP ${res.status}`);
      // 常见填错的人话提示（实测：漏 /v1 → 404；Key 不对 → 401 login fail）
      const hint = res.status === 404
        ? '——检查「接口地址」是否只填到 /v1 结尾（后面的 /chat/completions 会自动接上，不要再带别的路径）'
        : (res.status === 401 || res.status === 403)
          ? '——检查 API Key 是否为该平台的 Key（部分平台"按量付费 Key"和"订阅 Key"是分开的）'
          : '';
      return { ok: false, error: base + hint + (wantLook ? '（看屏幕需要模型支持"看图"）' : '') };
    }
    // 有的平台旧式接口会 200 + base_resp 报错（如 MiniMax 系列）
    if (data?.base_resp && Number(data.base_resp.status_code) !== 0) {
      STANDALONE_HISTORY.pop();
      return { ok: false, error: '接口返回错误：' + String(data.base_resp.status_msg || data.base_resp.status_code) };
    }
    const reply = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (!reply) {
      STANDALONE_HISTORY.pop();
      return { ok: false, error: '模型没有返回内容（检查模型名是不是这个平台支持的）' + (wantLook ? '（看屏幕需要模型支持"看图"）' : '') };
    }
    STANDALONE_HISTORY.push({ role: 'assistant', content: reply });
    return { ok: true, reply, standalone: true };
  } catch (err) {
    STANDALONE_HISTORY.pop();
    return { ok: false, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function pingBridge(timeoutMs = 1200) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`${BASE}/api/status`, {
      headers: { 'x-console-token': localCfg.consoleToken || '' },
      signal: ctl.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureTunnel() {
  if (await pingBridge()) {
    tunnelReady = true;
    return true;
  }
  if (!localCfg.consoleToken) return false;
  if (tunnelProc && !tunnelProc.killed) {
    // 进程还在但没通，等它一下
    await new Promise((r) => setTimeout(r, 1500));
    tunnelReady = await pingBridge();
    return tunnelReady;
  }
  tunnelProc = spawn('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=20',
    '-N',
    '-L', `${TUNNEL_PORT}:127.0.0.1:${BRIDGE_PORT}`,
    SSH_HOST,
  ], { windowsHide: true, stdio: 'ignore' });
  tunnelProc.on('exit', () => { tunnelProc = null; tunnelReady = false; });
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await pingBridge()) { tunnelReady = true; return true; }
  }
  return false;
}

async function bridgeGet(pathname, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      headers: { 'x-console-token': localCfg.consoleToken || '' },
      signal: ctl.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function bridgePost(pathname, body, timeoutMs = 90000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': localCfg.consoleToken || '' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

let win = null;
let tray = null;
let dragging = false;
let dragOrigin = { cursor: { x: 0, y: 0 }, window: { x: 0, y: 0 } };
let hitRect = null;          // 渲染层报上来的"她的矩形"（窗口坐标）
let interactive = null;      // 是否允许鼠标落在她身上
let alwaysOnTop = true;
let anchorY = 0;             // 站姿时的窗口 y（拖动会更新它）
let poseWindowDy = 0;        // 当前姿势带来的下移量
let freeRoam = true;         // 自由活动开关
let posLocked = false;       // 锁定位置（防误拖）——由渲染层同步（pet:ui-state）
let voiceMode = 'hold';      // 'hold' 按住说话 | 'hands' 免提对话

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // 必须有这个，跨 host（app ↔ model）的 fetch 才不会被拦
      corsEnabled: true,
      stream: true,
    },
  },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tga': 'image/x-tga',
  '.gif': 'image/gif',
  '.pmx': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/** 大小写不敏感地解析路径：模型里写 tex/ 而磁盘上是 TEX/ */
function resolveUnderRoot(urlPath) {
  const parts = decodeURIComponent(urlPath).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..');
  let cur = ROOT;
  for (const part of parts) {
    let entries;
    try {
      entries = fs.readdirSync(cur);
    } catch {
      return null;
    }
    const hit = entries.find((e) => e.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    cur = path.join(cur, hit);
  }
  return cur;
}

function registerProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const sub = url.hostname ? `/${url.hostname}${url.pathname}` : url.pathname;
    const file = resolveUnderRoot(sub);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return new Response('not found: ' + sub, { status: 404 });
    }
    const body = fs.readFileSync(file);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        // 页面在 denia://app，模型在 denia://model —— 跨 origin，必须放开 CORS
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  });
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  // 窗口尺寸：原来 420×780 太窄 —— 横向可视范围只有 7.5 个单位，而她张开手臂（含大袖子）
  // 有 8.8 个单位宽，手和袖口会被切在框外；说话"摊手"这类手势还会再往外 2 个单位。
  // 加宽到 660、高度 860，并留出余量，手和袖子就不会出框了。
  const width = 660;
  const height = 860;

  win = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 20,
    y: workArea.y + workArea.height - height + 10,    // 脚底大致落在任务栏上方
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: true,
    movable: true,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    alwaysOnTop,
    show: false,
    title: '娅娅',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  interactive = false;
  anchorY = win.getPosition()[1];

  win.once('ready-to-show', () => {
    win.showInactive();
    if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.loadURL(`${SCHEME}://app/index.html`);
  win.on('closed', () => { win = null; });
}

function applyHitTest() {
  if (!win || dragging) return;
  const cursor = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const inside = !!hitRect
    && cursor.x >= bounds.x + hitRect.x
    && cursor.x <= bounds.x + hitRect.x + hitRect.w
    && cursor.y >= bounds.y + hitRect.y
    && cursor.y <= bounds.y + hitRect.y + hitRect.h;
  if (inside !== interactive) {
    interactive = inside;
    win.setIgnoreMouseEvents(!inside, { forward: true });
    try { win.webContents.send('pet:command', inside ? 'cursor:over' : 'cursor:out'); } catch { /* 忽略 */ }
  }
}

function buildTrayIcon() {
  const iconPath = path.join(ROOT, 'assets', 'tray.png');
  if (fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: win && win.isVisible() ? '藏起来' : '出来吧', click: toggleVisible },
    { label: '置顶', type: 'checkbox', checked: alwaysOnTop, click: (item) => setAlwaysOnTop(item.checked) },
    { type: 'separator' },
    { label: '大一点', click: () => scaleWindow(1.1) },
    { label: '小一点', click: () => scaleWindow(1 / 1.1) },
    { label: '回到右下角', click: moveToCorner },
    { label: '锁定位置（防误拖）', type: 'checkbox', checked: posLocked, click: () => { if (win) win.webContents.send('pet:command', 'lock:toggle'); } },
    { type: 'separator' },
    { label: '⚙️ 独立 AI 设置…', click: () => openSettingsWindow() },
    { type: 'separator' },
    {
      label: '开机自动出现',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: [] }),
    },
    { label: '开发者工具', click: () => win && win.webContents.toggleDevTools() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('娅娅');
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else win.showInactive();
  refreshTrayMenu();
}

function setAlwaysOnTop(value) {
  alwaysOnTop = value;
  if (win) win.setAlwaysOnTop(value, 'screen-saver');
  refreshTrayMenu();
}

function scaleWindow(factor) {
  if (!win) return;
  const b = win.getBounds();
  let w = Math.round(b.width * factor);
  let h = Math.round(b.height * factor);
  w = Math.max(200, Math.min(2400, w));
  // 坐姿的头顶留白（sitTallExtra）不跟着一起缩放：先按"减掉补偿的原高"缩放，
  // 再按新宽度重算留白 —— 否则坐着反复缩放会把留白越缩越小 / 越放越大（头顶被切或空一大块）。
  if (sitTallExtra > 0) {
    const baseH = Math.max(1, b.height - sitTallExtra);
    sitTallExtra = Math.round((w / 660) * 200);
    h = Math.round(baseH * factor) + sitTallExtra;
  }
  h = Math.max(260, Math.min(3200, h));
  win.setBounds({ x: Math.round(b.x + (b.width - w) / 2), y: Math.round(b.y + (b.height - h)), width: w, height: h });
  anchorY = win.getPosition()[1] - poseWindowDy;
}

// 恢复默认大小（660×860）贴右下角（2026-10-11 用户点单：快速调大小）
function resetSize() {
  if (!win) return;
  const { workArea } = screen.getPrimaryDisplay();
  // 坐着的时候保留头顶留白（和 setSitTall 约定的一致：按宽度折算，660 宽时是 200）
  const extra = sitTallExtra > 0 ? 200 : 0;
  const h = 860 + extra;
  win.setBounds({ x: workArea.x + workArea.width - 660 - 20, y: workArea.y + workArea.height - h + 10, width: 660, height: h });
  sitTallExtra = extra;
  anchorY = win.getPosition()[1] - poseWindowDy;
}

// 「看看屏幕」时：缩小到 70%（只缩不放）并挪去右下角，别挡你看（2026-10-11 用户点单）
function peekCorner() {
  if (!win) return;
  const { workArea } = screen.getPrimaryDisplay();
  const b = win.getBounds();
  const targetW = Math.round(660 * 0.7);
  let w = b.width;
  let h = b.height;
  if (w > targetW) {
    const k = targetW / w;
    w = targetW;
    // 同样：缩放的是"原高"，头顶留白按新宽度重算
    const baseH = sitTallExtra > 0 ? Math.max(1, b.height - sitTallExtra) : b.height;
    if (sitTallExtra > 0) sitTallExtra = Math.round((w / 660) * 200);
    h = Math.round(baseH * k) + (sitTallExtra > 0 ? sitTallExtra : 0);
  }
  win.setBounds({ x: workArea.x + workArea.width - w - 20, y: workArea.y + workArea.height - h + 10, width: w, height: h });
  anchorY = win.getPosition()[1] - poseWindowDy;
}

// 坐姿窗口加高（2026-10-11 用户点单：透明框拉高一点，给头顶留空间）——底边保持不动，往上长
let sitTallExtra = 0;
function setSitTall(on) {
  if (!win) return;
  const b = win.getBounds();
  if (on && !sitTallExtra) {
    sitTallExtra = Math.round((b.width / 660) * 200);
    win.setBounds({ x: b.x, y: b.y - sitTallExtra, width: b.width, height: b.height + sitTallExtra });
    anchorY -= sitTallExtra;
  } else if (!on && sitTallExtra) {
    const d = sitTallExtra;
    sitTallExtra = 0;
    win.setBounds({ x: b.x, y: b.y + d, width: b.width, height: Math.max(260, b.height - d) });
    anchorY += d;
  }
}
ipcMain.on('pet:sit-tall', (_e, on) => setSitTall(!!on));

ipcMain.on('pet:scale', (_e, factor) => {
  const f = Number(factor);
  if (Number.isFinite(f) && f >= 0.5 && f <= 2) scaleWindow(f);
});
ipcMain.on('pet:peek', () => peekCorner());
// 陪看两档（2026-10-11 用户点单：话痨 / 安静）——走控制台接口给陪看换参数（她那边零改动）
const WATCH_PRESETS = {
  quiet: { minGapMs: 25000, maxGapMs: 45000, changeThreshold: 8, sameWindowCooldownMs: 420000, speakMinGapMs: 240000, quietAfterOwnerMs: 120000, maxInjectsPerHour: 6 },
  chatty: { minGapMs: 5000, maxGapMs: 9000, changeThreshold: 1.5, sameWindowCooldownMs: 30000, speakMinGapMs: 20000, quietAfterOwnerMs: 5000, maxInjectsPerHour: 60 },
};
ipcMain.on('pet:watch-preset', async (_e, mode) => {
  if (STANDALONE.enabled) {
    // 无bot·本地陪看：起停/换档都在本地（截屏 + 你的视觉模型）
    if (mode === 'quiet' || mode === 'chatty') startLocalWatch(mode);
    else stopLocalWatch();
    return;
  }
  const preset = WATCH_PRESETS[mode === 'chatty' ? 'chatty' : 'quiet'];
  if (!(await ensureTunnel())) return;
  try {
    await bridgePost('/api/socialV2/screen-permission', { watch: true, minutes: 30, ...preset });
  } catch { /* 换档失败就沿用默认档 */ }
});
ipcMain.on('pet:ui-state', (_e, st) => {
  if (!st) return;
  if (typeof st.locked === 'boolean') posLocked = st.locked;
  if (st.voiceMode === 'hold' || st.voiceMode === 'hands') voiceMode = st.voiceMode;
});

function moveToCorner() {
  if (!win) return;
  const { workArea } = screen.getPrimaryDisplay();
  const b = win.getBounds();
  win.setPosition(workArea.x + workArea.width - b.width - 20, workArea.y + workArea.height - b.height + 120);
}

function createTray() {
  tray = new Tray(buildTrayIcon());
  refreshTrayMenu();
  tray.on('click', toggleVisible);
}

function listMotions() {
  try {
    return fs.readdirSync(path.join(ROOT, 'motions'))
      .filter((f) => f.toLowerCase().endsWith('.vmd'))
      .sort();
  } catch {
    return [];
  }
}

// 投喂：把光标位置换算成窗口内坐标，交给渲染层做"食物飞过去"的动画
function feedHer(kind) {
  if (!win) return;
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  win.webContents.send('pet:feed', {
    kind,
    x: Math.round(c.x - b.x),
    y: Math.round(c.y - b.y),
  });
}

ipcMain.on('pet:hit-rect', (_e, rect) => { hitRect = rect; });
ipcMain.on('pet:set-interactive', (_e, value) => {
  if (dragging) return;
  if (interactive === value) return;
  interactive = value;
  if (win) win.setIgnoreMouseEvents(!value, { forward: true });
});
ipcMain.on('pet:context-menu', () => {
  if (!win) return;
  Menu.buildFromTemplate([
    { label: '跟她说句话…', click: () => { if (win) { win.focus(); win.webContents.send('pet:command', 'chat'); } } },
    { label: '语音说一句…（按住🎤说话）', click: () => { if (win) { win.focus(); win.webContents.send('pet:command', 'chat:voice'); } } },
    {
      label: '语音模式',
      submenu: [
        { label: '按住说话（默认）', type: 'radio', checked: voiceMode === 'hold', click: () => { if (win) win.webContents.send('pet:command', 'voice:mode:hold'); } },
        { label: '免提对话（点🎤开关，直接说）', type: 'radio', checked: voiceMode === 'hands', click: () => { if (win) win.webContents.send('pet:command', 'voice:mode:hands'); } },
      ],
    },
    // 2026-10-11 用户点单：看屏幕接入（复用 pet-chat：桥接会现拍全分辨率桌面挂给她）
    { label: '看看屏幕', click: () => { if (win) win.webContents.send('pet:command', 'screen:look'); } },
    {
      label: '陪看',
      submenu: [
        { label: '陪我看会儿·安静版（30 分钟）', click: () => { if (win) win.webContents.send('pet:command', 'screen:watch:quiet'); } },
        { label: '陪我看会儿·话痨版（30 分钟）', click: () => { if (win) win.webContents.send('pet:command', 'screen:watch:chatty'); } },
        { label: '别看了（停陪看）', click: () => { if (win) win.webContents.send('pet:command', 'screen:stop'); } },
        { type: 'separator' },
        { label: '允许她看 30 分钟', click: () => { if (win) win.webContents.send('pet:command', 'screen:allow30'); } },
      ],
    },
    // 2026-10-11 用户点单：投喂（食物从鼠标处飞到她嘴边 → 嚼一嚼 → 告诉她）
    {
      label: '投喂',
      submenu: [
        { label: '🍰 小蛋糕', click: () => feedHer('cake') },
        { label: '🍓 草莓', click: () => feedHer('strawberry') },
        { label: '🥣 温汤', click: () => feedHer('soup') },
        { type: 'separator' },
        { label: '随便来一口（随机）', click: () => feedHer('random') },
      ],
    },
    {
      label: '大小',
      submenu: [
        { label: '变大', click: () => scaleWindow(1.1) },
        { label: '变小', click: () => scaleWindow(1 / 1.1) },
        { label: '恢复默认大小', click: () => resetSize() },
      ],
    },
    { label: '锁定位置（防误拖）', type: 'checkbox', checked: posLocked, click: () => { if (win) win.webContents.send('pet:command', 'lock:toggle'); } },
    { type: 'separator' },
    {
      label: '换个姿势',
      submenu: [
        { label: '站着', click: () => win.webContents.send('pet:command', 'pose:stand') },
        { label: '坐着', click: () => win.webContents.send('pet:command', 'pose:sit') },
        { label: '侧身倚靠', click: () => win.webContents.send('pet:command', 'pose:lie') },
        // 2026-10-10 用户点单：趴着 → 「困」（站着打瞌睡，没动静自动触发）；蹲着删除
        { label: '困', click: () => win.webContents.send('pet:command', 'pose:drowsy') },
        { label: '靠着', click: () => win.webContents.send('pet:command', 'pose:lean') },
      ],
    },
    {
      label: '做个动作',
      submenu: listMotions().length
        ? listMotions().map((f) => ({
          label: f.replace(/\.vmd$/i, ''),
          click: () => win.webContents.send('pet:command', 'motion:' + f),
        }))
        : [{ label: '（把 .vmd 放进 motions 文件夹）', enabled: false }],
    },
    {
      label: '自由活动',
      type: 'checkbox',
      checked: true,
      click: (item) => { if (win) win.webContents.send('pet:command', 'free:toggle'); freeRoam = item.checked; },
    },
    {
      label: '衣服头发飘动',
      submenu: [
        { label: '裙摆 + 头发（推荐）', click: () => win.webContents.send('pet:command', 'phys:safe') },
        { label: '只裙摆（头发就不飘了）', click: () => win.webContents.send('pet:command', 'phys:skirt') },
        { label: '全部都飘（容易穿模）', click: () => win.webContents.send('pet:command', 'phys:full') },
        { label: '关掉', click: () => win.webContents.send('pet:command', 'phys:off') },
        { type: 'separator' },
        { label: '飘动力度：轻（35%）', click: () => win.webContents.send('pet:command', 'phys:blend0.35') },
        { label: '飘动力度：中（55%）', click: () => win.webContents.send('pet:command', 'phys:blend0.55') },
        { label: '飘动力度：足（80%）', click: () => win.webContents.send('pet:command', 'phys:blend0.8') },
      ],
    },
    { type: 'separator' },
    { label: '让她歇会儿', click: () => win.webContents.send('pet:command', 'rest') },
    { label: '打个招呼', click: () => win.webContents.send('pet:command', 'wave') },
    { type: 'separator' },
    { label: '⚙️ 独立 AI 设置…', click: () => openSettingsWindow() },
    { label: '藏起来', click: toggleVisible },
    { label: '退出', click: () => app.quit() },
  ]).popup({ window: win });
});

// ── 独立 AI 设置页（新窗口 + 读写 config.local.json 的 standalone 段）────────
let settingsWin = null;
function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 780,
    title: '娅娅 · 独立 AI 设置',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.on('closed', () => { settingsWin = null; });
  settingsWin.loadURL(`${SCHEME}://app/settings.html`);
}

ipcMain.handle('pet:standalone-get', () => ({ ...STANDALONE }));
ipcMain.handle('pet:standalone-save', (_e, cfg) => {
  try {
    const vin = (cfg?.voice && typeof cfg.voice === 'object') ? cfg.voice : {};
    const s = (x, n) => String(x || '').trim().slice(0, n);
    const voice = {
      engine: ['sapi', 'sovits', 'fish', 'openai', 'volcano', 'volcano3', 'minimax'].includes(s(vin.engine, 20)) ? s(vin.engine, 20) : 'sapi',
      sapiVoice: s(vin.sapiVoice, 120) || STANDALONE_VOICE_DEFAULTS.sapiVoice,
      sovitsUrl: s(vin.sovitsUrl, 300) || STANDALONE_VOICE_DEFAULTS.sovitsUrl,
      sovitsRef: s(vin.sovitsRef, 500),
      sovitsPrompt: s(vin.sovitsPrompt, 500),
      sovitsPromptLang: s(vin.sovitsPromptLang, 10) || 'zh',
      sovitsLang: s(vin.sovitsLang, 10) || 'auto',
      sovitsGptWeights: s(vin.sovitsGptWeights, 500),
      sovitsSovitsWeights: s(vin.sovitsSovitsWeights, 500),
      sovitsSpeed: Math.min(3, Math.max(0.3, Number(vin.sovitsSpeed) || 1)),
      fishUrl: s(vin.fishUrl, 300) || STANDALONE_VOICE_DEFAULTS.fishUrl,
      fishKey: s(vin.fishKey, 300),
      fishRefId: s(vin.fishRefId, 300),
      fishModel: s(vin.fishModel, 60) || 's1',
      oaiUrl: s(vin.oaiUrl, 300) || STANDALONE_VOICE_DEFAULTS.oaiUrl,
      oaiKey: s(vin.oaiKey, 300),
      oaiModel: s(vin.oaiModel, 200),
      oaiVoice: s(vin.oaiVoice, 200) || 'alloy',
      volcanoUrl: s(vin.volcanoUrl, 300) || STANDALONE_VOICE_DEFAULTS.volcanoUrl,
      volcanoAppId: s(vin.volcanoAppId, 80),
      volcanoToken: s(vin.volcanoToken, 300),
      volcanoCluster: s(vin.volcanoCluster, 60) || 'volcano_icl',
      volcanoVoiceId: s(vin.volcanoVoiceId, 120),
      volcanoSpeed: Math.min(3, Math.max(0.2, Number(vin.volcanoSpeed) || 1)),
      volcano3Url: s(vin.volcano3Url, 300) || STANDALONE_VOICE_DEFAULTS.volcano3Url,
      volcano3ApiKey: s(vin.volcano3ApiKey, 300),
      volcano3AppId: s(vin.volcano3AppId, 80),
      volcano3AccessKey: s(vin.volcano3AccessKey, 300),
      volcano3Resource: s(vin.volcano3Resource, 60) || 'seed-icl-2.0',
      volcano3Speaker: s(vin.volcano3Speaker, 120),
      volcano3SpeechRate: Math.min(100, Math.max(-50, Number(vin.volcano3SpeechRate) || 0)),
      minimaxUrl: s(vin.minimaxUrl, 300) || STANDALONE_VOICE_DEFAULTS.minimaxUrl,
      minimaxKey: s(vin.minimaxKey, 300),
      minimaxVoiceId: s(vin.minimaxVoiceId, 120),
      minimaxModel: s(vin.minimaxModel, 80) || 'speech-2.8-hd',
      minimaxSpeed: Math.min(3, Math.max(0.2, Number(vin.minimaxSpeed) || 1)),
    };
    const next = {
      enabled: !!cfg?.enabled,
      baseUrl: String(cfg?.baseUrl || '').trim() || 'https://discovery-api.intern-ai.org.cn/v1',
      apiKey: String(cfg?.apiKey || '').trim(),
      model: String(cfg?.model || '').trim() || 'deepseek-v4-flash-0731',
      persona: String(cfg?.persona || '').trim(),
      ttsVoice: voice.sapiVoice,     // 老字段，保留同步
      voice,
      historyLimit: Math.min(200, Math.max(2, Number(cfg?.historyLimit) || 40)),
      maxTokens: Math.min(16384, Math.max(64, Number(cfg?.maxTokens) || 2048)),
    };
    Object.assign(STANDALONE, next);
    const cur = loadLocalConfig();
    cur.standalone = next;
    fs.writeFileSync(path.join(ROOT, 'config.local.json'), JSON.stringify(cur, null, 2) + '\n');
    return { ok: true, standalone: next };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});
ipcMain.on('pet:drag-start', () => {
  if (!win) return;
  dragging = true;
  dragOrigin = { cursor: screen.getCursorScreenPoint(), window: win.getPosition() };
  const p = win.getPosition();
  dragOrigin.window = { x: p[0], y: p[1] };
});
ipcMain.on('pet:drag-end', () => {
  dragging = false;
  if (win) anchorY = win.getPosition()[1] - poseWindowDy;   // 拖动后重新记锚点
});
// 坐/趴/蹲 时把窗口整体下移（下半身落到任务栏下面），坐标以"站姿锚点"为基准
ipcMain.on('pet:window-offset', (_e, dy) => {
  if (!win || dragging) return;
  const offset = Number(dy) || 0;
  if (Math.abs(offset - poseWindowDy) < 2) return;
  poseWindowDy = offset;
  const p = win.getPosition();
  const ny = Math.round(anchorY + offset);
  if (Number.isFinite(ny) && Math.abs(ny) <= 0x7fffffff && Number.isFinite(p[0])) {
    try { win.setPosition(p[0], ny); } catch { /* 忽略这一帧 */ }
  }
});

// ── 屏幕信息 / 走位 ────────────────────────────────────────────────
let walkTimer = null;

ipcMain.handle('pet:get-screen', () => {
  const d = screen.getPrimaryDisplay();
  return { workArea: d.workArea, bounds: win ? win.getBounds() : null, walking: !!walkTimer };
});

// ── 环境：鼠标 + 前台窗口（她"看见"你在忙什么就看这个）────────────────
let fgCache = { at: 0, value: null };

function readForeground() {
  return new Promise((resolve) => {
    const exe = path.join(ROOT, 'tools', 'foreground.exe');
    if (!fs.existsSync(exe)) return resolve(null);
    const p = spawn(exe, [], { windowsHide: true });
    let out = '';
    let done = false;
    // ⚠️ 超时必杀（2026-10-11）：这个子进程在"没有控制台窗口"的情况下会用 Console API 卡住，
    //    老代码没有超时 ⇒ 每次轮询（约 9 秒一次）漏一个僵尸进程，几分钟就攒十几个。
    //    现在 4 秒还没退出就杀掉，宁可这一轮拿不到前台信息。
    const finish = (v) => { if (!done) { done = true; clearTimeout(killTimer); resolve(v); } };
    const killTimer = setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } finish(null); }, 4000);
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.on('error', () => finish(null));
    p.on('exit', () => {
      try { finish(JSON.parse(out.trim())); } catch { finish(null); }
    });
  });
}

ipcMain.handle('pet:env', async () => {
  const d = screen.getPrimaryDisplay();
  const mouse = screen.getCursorScreenPoint();
  // 2026-10-25：前台窗口缓存 3s → 15s。渲染层每 9s 来问一次 pet:env，原 3s TTL
  // 等于每次都过期 → 每 9 秒新起一个 foreground.exe 子进程。"她在看什么"这种
  // 环境感知 15 秒的陈旧度毫无影响；拿不到值（null）时仍然立即重试，不受影响。
  if (!fgCache.value || Date.now() - fgCache.at > 15000) {
    fgCache = { at: Date.now(), value: await readForeground() };
  }
  return {
    mouse,
    workArea: d.workArea,
    bounds: win ? win.getBounds() : null,
    fg: fgCache.value,
    walking: !!walkTimer,
  };
});

ipcMain.on('pet:walk-to', (_e, payload) => {
  if (!win) return;
  // 坐标保险丝（2026-10-11）：NaN / ±Infinity / 超出 int32 的值一律不放行。
  // 之前只挡了 NaN（`|| 0`）；一旦野值进来，setPosition 会抛
  // "conversion failure …" 把主进程打断弹框（桌宠看起来就"卡死"）。
  const finInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && Math.abs(n) <= 0x7fffffff ? Math.round(n) : null;
  };
  const to = { x: finInt(payload?.x), y: finInt(payload?.y) };
  if (to.x === null || to.y === null) return;   // 坏坐标：这趟就不走
  const duration = Math.max(150, Number(payload?.durationMs) || 900);
  const from = win.getBounds();
  const t0 = Date.now();
  if (walkTimer) clearInterval(walkTimer);
  walkTimer = setInterval(() => {
    if (!win) { clearInterval(walkTimer); walkTimer = null; return; }
    const t = Math.min(1, (Date.now() - t0) / duration);
    const nx = Math.round(from.x + (to.x - from.x) * t);
    const ny = Math.round(from.y + (to.y - from.y) * t);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || Math.abs(nx) > 0x7fffffff || Math.abs(ny) > 0x7fffffff) {
      clearInterval(walkTimer); walkTimer = null;   // 帧内算坏：停下，不喂给 setPosition
      return;
    }
    try { win.setPosition(nx, ny); } catch { clearInterval(walkTimer); walkTimer = null; }
    if (t >= 1) {
      clearInterval(walkTimer);
      walkTimer = null;
      anchorY = win.getPosition()[1];
    }
  }, 16);
});

ipcMain.on('pet:walk-stop', () => {
  if (walkTimer) { clearInterval(walkTimer); walkTimer = null; }
  if (win) anchorY = win.getPosition()[1];
});

ipcMain.on('pet:quit', () => app.quit());
// 鼠标/键盘"没动静"的秒数（整个系统，Windows 走 GetLastInputInfo）：
// 渲染层每秒问一次，用来看她要不要开始打瞌睡（见 app/main.js 的 tickDrowsy）
ipcMain.handle('pet:idle', () => {
  try { return powerMonitor.getSystemIdleTime(); } catch { return null; }
});
ipcMain.handle('pet:info', () => ({
  bounds: win ? win.getBounds() : null,
  interactive,
  alwaysOnTop,
  dev: DEV,
}));

// 跟她说话：走桥接的 pet-chat（QQ 私聊同一条对话）
ipcMain.handle('pet:say', async (_e, text) => {
  const msg = String(text || '').trim();
  if (!msg) return { ok: false, error: '空消息' };
  if (STANDALONE.enabled) return standaloneReply(msg);
  if (!(await ensureTunnel())) return { ok: false, error: '连不上她（SSH 隧道没通）' };
  try {
    const data = await bridgePost('/api/socialV2/pet-chat', { key: CHAT_KEY, text: msg });
    return data;
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// 拉她在 QQ 私聊里的最新消息（她主动找你时就从这里冒泡）
ipcMain.handle('pet:recent', async () => {
  if (STANDALONE.enabled) {
    // 她主动说的话（本地陪看的点评）：renderer 每 4 秒轮询，取走并冒泡
    const out = STANDALONE_INBOX.splice(0, 20).map((m) => ({ ts: m.ts, text: m.text, self: true }));
    return { ok: true, messages: out };
  }
  if (!(await ensureTunnel())) return { ok: false, error: '隧道没通' };
  try {
    return await bridgeGet(`/api/socialV2/recent?key=${encodeURIComponent(CHAT_KEY)}&limit=20`);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('pet:bridge-status', async () => {
  if (STANDALONE.enabled) return { ok: true, mode: 'standalone' };
  const ready = await ensureTunnel();
  if (!ready) return { ok: false };
  try {
    const st = await bridgeGet('/api/status');
    return { ok: true, mode: st.mode, role: st.role, dshReady: st.dshReady };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});

// 她的声音：让桥接用她自己的音色合成，再取回本机播放
const VOICE_DIR = path.join(ROOT, 'voice');
function pruneVoiceDir(keep = 40) {
  try {
    const files = fs.readdirSync(VOICE_DIR)
      .filter((f) => f.endsWith('.mp3') || f.endsWith('.wav'))
      .map((f) => ({ f, t: fs.statSync(path.join(VOICE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) fs.unlinkSync(path.join(VOICE_DIR, f));
  } catch { /* 目录不存在就算了 */ }
}

function copyFromHost(remote, local) {
  return new Promise((resolve, reject) => {
    const p = spawn('scp', ['-q', '-o', 'BatchMode=yes', `${SSH_HOST}:${remote}`, local], { windowsHide: true });
    let settled = false;
    // 同样要超时：scp 卡住时这个 Promise 永远不落地 ⇒ 那次"她说话"会一直转圈，
    // 后面排队的语音也全堵住（2026-10-11 统一给所有一次性子进程补超时）。
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(killTimer); fn(v); } };
    const killTimer = setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } done(reject, new Error('取音频超时（scp 30 秒没回来）')); }, 30000);
    p.on('error', (e) => done(reject, e));
    p.on('exit', (code) => (code === 0 ? done(resolve, true) : done(reject, new Error('取音频失败（scp ' + code + '）'))));
  });
}

function synthSapi(text, outWav, voice) {
  return new Promise((resolve, reject) => {
    const script = [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      'try { $s.SelectVoice($env:PET_VOICE) } catch {};',
      '$s.SetOutputToWaveFile($env:PET_OUT);',
      '$s.Speak($env:PET_TEXT);',
      '$s.Dispose();',
    ].join(' ');
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, PET_TEXT: text, PET_OUT: outWav, PET_VOICE: voice || '' },
    });
    let settled = false;
    // ⚠️ 超时必须**在这里就 settle**，光 kill 是不够的（2026-10-15 修）：
    //    杀掉之后 `exit` 事件不一定来（进程树残留 / 权限不足都可能卡住），
    //    只 kill 不 reject ⇒ 这个 Promise 永远挂着 ⇒ 那一次「她说话」永远转圈。
    //    这个教训本文件在 copyFromHost（下面）里已经总结过一次，这里当时漏了。
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { p.kill(); } catch { /* 忽略 */ }
      reject(new Error('本地语音合成超时（30 秒没返回，已终止）'));
    }, 30000);
    p.on('error', (e) => { if (settled) return; settled = true; clearTimeout(killTimer); reject(e); });
    p.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (code === 0 && fs.existsSync(outWav)) resolve(outWav);
      else reject(new Error('本地语音合成失败（code=' + code + '）'));
    });
  });
}

// ── 复刻声线接口（GPT-SoVITS / Fish Audio / OpenAI 兼容语音）──────────────
// 目的：没有 bot 的朋友也能用"像娅娅的声音"——在复刻网站上传一段音频拿到音色，
// 或本机跑 GPT-SoVITS（和主机那边同款引擎），把地址/参数填进设置页即可。
let sovitsLoadedWeights = '';

async function synthVoiceApi(text) {
  const v = STANDALONE.voice || STANDALONE_VOICE_DEFAULTS;
  const engine = String(v.engine || 'sapi');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 150000);
  try {
    if (engine === 'sovits') {
      const base = String(v.sovitsUrl || '').trim().replace(/\/+$/, '');
      if (!base) throw new Error('还没填 GPT-SoVITS 服务地址');
      const q = (x) => encodeURIComponent(String(x));
      const wanted = `${v.sovitsGptWeights || ''}|${v.sovitsSovitsWeights || ''}`;
      if (wanted !== '|' && sovitsLoadedWeights !== wanted) {
        if (v.sovitsGptWeights) {
          const r = await fetch(`${base}/set_gpt_weights?weights_path=${q(v.sovitsGptWeights)}`, { signal: ctl.signal });
          if (!r.ok) throw new Error(`GPT-SoVITS 加载 GPT 权重失败 HTTP ${r.status}：${(await r.text().catch(() => '')).slice(0, 120)}`);
        }
        if (v.sovitsSovitsWeights) {
          const r = await fetch(`${base}/set_sovits_weights?weights_path=${q(v.sovitsSovitsWeights)}`, { signal: ctl.signal });
          if (!r.ok) throw new Error(`GPT-SoVITS 加载 SoVITS 权重失败 HTTP ${r.status}：${(await r.text().catch(() => '')).slice(0, 120)}`);
        }
        sovitsLoadedWeights = wanted;
      }
      // 和主机那边同一条规则：含假名按日语念（不少模型是日语素材训练的）
      const hasKana = /[\u3040-\u309F\u30A0-\u30FF]/.test(text);
      const lang = String(v.sovitsLang || 'auto') === 'auto' ? (hasKana ? 'ja' : 'zh') : String(v.sovitsLang);
      const res = await fetch(`${base}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          text_lang: lang,
          ref_audio_path: String(v.sovitsRef || ''),
          prompt_text: String(v.sovitsPrompt || ''),
          prompt_lang: String(v.sovitsPromptLang || 'zh'),
          text_split_method: 'cut5',
          speed_factor: Number(v.sovitsSpeed) || 1,
          media_type: 'wav',
          streaming_mode: false,
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`GPT-SoVITS 合成失败 HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 2000) throw new Error(`GPT-SoVITS 返回音频过小（${buf.length} 字节），检查参考音频/文本/语言参数`);
      return { buf, ext: 'wav', engine: 'sovits' };
    }
    if (engine === 'fish') {
      const base = String(v.fishUrl || '').trim().replace(/\/+$/, '');
      if (!v.fishKey) throw new Error('还没填 Fish Audio 的 API Key');
      const res = await fetch(`${base}/v1/tts`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${String(v.fishKey).trim()}`,
          model: String(v.fishModel || 's1'),
        },
        body: JSON.stringify({
          text,
          format: 'mp3',
          mp3_bitrate: 128,
          chunk_length: 200,
          normalize: true,
          reference_id: String(v.fishRefId || '') || undefined,
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`Fish Audio 合成失败 HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error(`Fish Audio 返回音频过小（${buf.length} 字节）`);
      return { buf, ext: 'mp3', engine: 'fish' };
    }
    if (engine === 'openai') {
      const base = String(v.oaiUrl || '').trim().replace(/\/+$/, '');
      if (!v.oaiKey) throw new Error('还没填语音接口的 API Key');
      const res = await fetch(`${base}/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${String(v.oaiKey).trim()}` },
        body: JSON.stringify({
          model: String(v.oaiModel || ''),
          input: text,
          voice: String(v.oaiVoice || 'alloy'),
          response_format: 'mp3',
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`语音接口合成失败 HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error(`语音接口返回音频过小（${buf.length} 字节）`);
      return { buf, ext: 'mp3', engine: 'openai' };
    }
    if (engine === 'volcano') {
      // 火山引擎（豆包）语音合成 HTTP 接口：请求格式已对真实端点核过（假凭证返回 code 3001 属正常）
      const url = String(v.volcanoUrl || '').trim() || 'https://openspeech.bytedance.com/api/v1/tts';
      if (!v.volcanoAppId || !v.volcanoToken) throw new Error('还没填火山引擎的 AppID / Access Token（语音技术 → 应用管理里拿）');
      if (!v.volcanoVoiceId) throw new Error('还没填火山引擎的「声音 ID」');
      const token = String(v.volcanoToken).trim();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer;${token}` },
        body: JSON.stringify({
          app: { appid: String(v.volcanoAppId).trim(), token, cluster: String(v.volcanoCluster || 'volcano_icl') },
          user: { uid: 'denia-desktop' },
          audio: { voice_type: String(v.volcanoVoiceId).trim(), encoding: 'mp3', speed_ratio: Number(v.volcanoSpeed) || 1 },
          request: { reqid: crypto.randomUUID(), text, operation: 'query' },
        }),
        signal: ctl.signal,
      });
      const j = await res.json().catch(() => null);
      if (!j || Number(j.code) !== 3000 || !j.data) {
        throw new Error(`火山引擎合成失败（code ${j?.code ?? res.status}）：${String(j?.message || '').slice(0, 200)}`);
      }
      const buf = Buffer.from(String(j.data), 'base64');
      if (buf.length < 1000) throw new Error(`火山引擎返回音频过小（${buf.length} 字节）`);
      return { buf, ext: 'mp3', engine: 'volcano' };
    }
    if (engine === 'volcano3') {
      // 火山引擎·新版控制台（豆包语音大模型 V3 单向流式 SSE）：X-Api-Key 直连；支持声音复刻 2.0
      const url = String(v.volcano3Url || '').trim() || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse';
      const headers = { 'content-type': 'application/json', 'X-Api-Request-Id': crypto.randomUUID() };
      if (v.volcano3ApiKey) {
        headers['X-Api-Key'] = String(v.volcano3ApiKey).trim();
      } else if (v.volcano3AppId && v.volcano3AccessKey) {
        headers['X-Api-App-Id'] = String(v.volcano3AppId).trim();
        headers['X-Api-Access-Key'] = String(v.volcano3AccessKey).trim();
      } else {
        throw new Error('还没填火山引擎的 API Key（新版控制台），或 AppID + Access Key（旧版控制台）');
      }
      headers['X-Api-Resource-Id'] = String(v.volcano3Resource || 'seed-icl-2.0').trim();
      if (!v.volcano3Speaker) throw new Error('还没填火山引擎的「音色 ID」（speaker）');
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          user: { uid: 'denia-desktop' },
          req_params: {
            text,
            speaker: String(v.volcano3Speaker).trim(),
            audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: Number(v.volcano3SpeechRate) || 0 },
          },
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`火山V3 HTTP ${res.status}：${String(t).slice(0, 200)}`);
      }
      // 解析 SSE：data: {"code":0,"data":"<base64 音频块>"}，拼接各块
      const reader = res.body.getReader();
      let sse = '';
      const chunks = [];
      let lastErr = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sse += Buffer.from(value).toString('utf8');
        let idx;
        while ((idx = sse.indexOf('\n')) >= 0) {
          const line = sse.slice(0, idx).trim();
          sse = sse.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const j = JSON.parse(line.slice(5).trim());
            if (Number(j?.code) === 0 && j?.data) chunks.push(Buffer.from(String(j.data), 'base64'));
            else if (j?.code && Number(j.code) !== 0 && Number(j.code) !== 20000000) lastErr = `code ${j.code}: ${j.message || ''}`;
          } catch { /* 非 JSON 行忽略 */ }
        }
      }
      const buf = Buffer.concat(chunks);
      if (buf.length < 1000) throw new Error(`火山V3 没拿到音频${lastErr ? '——' + lastErr : ''}`);
      return { buf, ext: 'mp3', engine: 'volcano3' };
    }
    if (engine === 'minimax') {
      // MiniMax（海螺）t2a_v2：Bearer 直连（无需 GroupId）；音频为 hex；错误走 200 + base_resp
      const url = String(v.minimaxUrl || '').trim() || 'https://api.minimax.cn/v1/t2a_v2';
      if (!v.minimaxKey) throw new Error('还没填 MiniMax 的 API Key');
      if (!v.minimaxVoiceId) throw new Error('还没填 MiniMax 的「音色 ID」（Voice ID）');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${String(v.minimaxKey).trim()}` },
        body: JSON.stringify({
          model: String(v.minimaxModel || 'speech-2.8-hd'),
          text,
          stream: false,
          voice_setting: { voice_id: String(v.minimaxVoiceId).trim(), speed: Number(v.minimaxSpeed) || 1, vol: 1, pitch: 0 },
          audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
        }),
        signal: ctl.signal,
      });
      const j = await res.json().catch(() => null);
      const code = Number(j?.base_resp?.status_code);
      if (!j || (Number.isFinite(code) && code !== 0) || !j?.data?.audio) {
        throw new Error(`MiniMax 合成失败（${j?.base_resp?.status_code ?? res.status}）：${String(j?.base_resp?.status_msg || '').slice(0, 200)}`);
      }
      const buf = Buffer.from(String(j.data.audio), 'hex');
      if (buf.length < 1000) throw new Error(`MiniMax 返回音频过小（${buf.length} 字节）`);
      return { buf, ext: 'mp3', engine: 'minimax' };
    }
    throw new Error('未知语音引擎：' + engine);
  } catch (e) {
    const m = String(e?.message || e);
    if (/ECONNREFUSED|fetch failed|ECONNRESET|aborted|abort/i.test(m)) {
      throw new Error(`连不上语音服务（${engine}）：${m}——确认地址、Key 和服务的启动状态`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 抽成函数：IPC 和"独立模式自检"共用同一条代码路径（和 petAsr 同理）
async function petVoice(text) {
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, error: '空文本' };
  if (STANDALONE.enabled) {
    const engine = String(STANDALONE.voice?.engine || 'sapi');
    try {
      fs.mkdirSync(VOICE_DIR, { recursive: true });
      if (engine !== 'sapi') {
        const { buf, ext, engine: used } = await synthVoiceApi(clean.slice(0, 500));
        const name = `tts-api-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
        fs.writeFileSync(path.join(VOICE_DIR, name), buf);
        pruneVoiceDir();
        return { ok: true, url: `denia://voice/${encodeURIComponent(name)}`, engine: used, kb: Math.round(buf.length / 1024) };
      }
      const name = `tts-standalone-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.wav`;
      const dest = path.join(VOICE_DIR, name);
      await synthSapi(clean.slice(0, 500), dest, STANDALONE.voice?.sapiVoice || STANDALONE.ttsVoice);
      pruneVoiceDir();
      return { ok: true, url: `denia://voice/${encodeURIComponent(name)}`, engine: 'sapi' };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
  return petVoiceViaBridge(clean);
}

async function petVoiceViaBridge(clean) {
  if (!(await ensureTunnel())) return { ok: false, error: '隧道没通' };
  try {
    const r = await bridgePost('/api/socialV2/voice-preview', { text: clean }, 180000);
    if (!r?.ok || !r.file) return { ok: false, error: r?.error || '合成失败' };
    fs.mkdirSync(VOICE_DIR, { recursive: true });
    const name = path.basename(r.file);
    const dest = path.join(VOICE_DIR, name);
    await copyFromHost(r.file, dest);
    pruneVoiceDir();
    return { ok: true, url: `denia://voice/${encodeURIComponent(name)}`, ms: r.ms, kb: r.kb, label: r.label };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
ipcMain.handle('pet:voice', (_e, text) => petVoice(text));

// ── 她的"耳朵"：本地 whisper.cpp 转写（2026-10-11 语音对讲）───────────
// 桌宠把录好的 16k 单声道 WAV 传过来；这里落盘 → whisper-cli 转写 → 读完就删。
// 路径支持"相对本目录"写法（朋友包把 whisper 装进 tools\whisper\ 就能直接用，不必改绝对路径）
function resolveLocalPath(p, fallback) {
  const s = String(p || '').trim();
  if (!s) return fallback;
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
}
const WHISPER_EXE = resolveLocalPath(localCfg.whisperExe, 'E:\\beifen\\whisper\\bin\\Release\\whisper-cli.exe');
const WHISPER_SERVER = resolveLocalPath(localCfg.whisperServerExe, path.join(path.dirname(WHISPER_EXE), 'whisper-server.exe'));
const WHISPER_MODEL = resolveLocalPath(localCfg.whisperModel, 'E:\\beifen\\whisper\\ggml-small.bin');
const WHISPER_PROMPT = String(localCfg.whisperPrompt || '以下是普通话的句子，请用简体中文转写。');
const WHISPER_PORT = Number(localCfg.whisperPort) || 8181;
// 常驻转写服务的空闲释放：最后一次 ASR 结束后空闲满这个时间就退出服务、释放内存，
// 下一句再按需拉起来（0 = 禁用，常驻到应用退出）。只**读**配置里的 whisperIdleMs，
// 不写 config.local.json。默认 5 分钟。
const WHISPER_IDLE_MS = (() => {
  const raw = localCfg.whisperIdleMs;
  if (raw === undefined || raw === null || raw === '') return WHISPER_IDLE_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return WHISPER_IDLE_DEFAULT_MS;
  return Math.floor(n);
})();
const ASR_TMP = path.join(os.tmpdir(), 'denia-asr');
let whisperLogTail = '';
let asrCliStrikes = 0;          // whisper-cli（兜底通道）连着崩了几次
let asrCliCooldownUntil = 0;    // 崩到 2 次就先停用 10 分钟，别一直撞

// 常驻转写服务：模型只加载一次，之后每句只要 1~3 秒（失败就退回 whisper-cli 每句加载）
//
// 生命周期交给 whisper-idle 控制器管（2026-10-22 加的空闲释放）：
//   * 请求进行中 / 排队中 / 服务启动中 —— 一律不杀；
//   * 空闲满 WHISPER_IDLE_MS（默认 5 分钟）→ 退出服务释放内存，下一句再按需拉起；
//   * 只杀**本 app 自己拉起来**的进程（按进程对象杀，不 taskkill /IM），不碰外部服务；
//   * 旧进程迟到的 exit 事件不会清掉新一代的进程 / 就绪状态（generation 令牌）。
const whisperIdle = createWhisperIdleController({
  idleMs: WHISPER_IDLE_MS,
  spawnServer: () => {
    // 注意：whisper 对**模型文件的绝对路径**里有中文时会直接崩（0xC0000409）。
    // 规避：用相对的模型文件名 + 把工作目录设在模型旁边 —— 实测中文目录也能正常加载。
    const p = spawn(WHISPER_SERVER, ['-m', path.basename(WHISPER_MODEL), '-l', 'zh', '-t', '6', '-nt',
      '--prompt', WHISPER_PROMPT, '--port', String(WHISPER_PORT)], { windowsHide: true, cwd: path.dirname(WHISPER_MODEL) });
    const onLine = (b) => { whisperLogTail = (whisperLogTail + b.toString()).slice(-800); };
    try { p.stdout?.on('data', onLine); p.stderr?.on('data', onLine); } catch { /* 忽略 */ }
    return p;
  },
  // 就绪判定：直接轮询端口（不看日志文案 —— 曾经因为它不肯刷那行字白等 60 秒才回退）
  // 单次探测有超时（waitReadyBounded）：不然 fetch 挂住时外层 25 秒期限形同虚设，
  // ensure() 永远不返回 → 整条 ASR 链路卡死。
  waitReady: async (p, ctx) => waitReadyBounded({
    url: `http://127.0.0.1:${WHISPER_PORT}/`,
    totalMs: 25000,
    attemptTimeoutMs: 1500,
    isCurrent: () => ctx.isCurrent(),
    isAlive: () => p.exitCode === null,
  }),
  // 只杀我们自己拉起来的那个进程（按对象杀，绝不 taskkill /IM）
  killOwned: async (p) => { try { p?.kill?.(); } catch { /* 忽略 */ } },
  log: (m) => { whisperLogTail = (whisperLogTail + String(m) + '\n').slice(-800); },
});

// ASR 排队协调：同一时刻只转写一句，后来的排到队里（只留最新一条）。
// 排队等待期间**也算占用**常驻服务（整个请求期间不许释放它）；被挤掉的那条
// 也会把占用还回去（2026-10-22 修：旧实现丢掉队列项的 resolve → 那句永远
// 挂着、占用永远降不下来 → 空闲释放再也不触发）。
const asrCoordinator = createAsrCoordinator(whisperIdle, { queueLimit: 1 });

function ensureWhisperServer() {
  if (!fs.existsSync(WHISPER_SERVER)) return Promise.resolve(false);
  return whisperIdle.ensure();
}

// ── 转写结果的"胡话过滤"（2026-10-11 实测抓到）──────────────────────────
// whisper 在**没人说话 / 只有杂音 / 极短音频**时，会把我们喂给它的提示词**原样吐回来**
// （实测：一段 1.3 秒的静音录成了整句「请用简体中文转写。」），还有几种常见幻觉词。
// 这些都不是人话，必须当"没听清"丢掉 —— 否则她会收到一句莫名其妙的"你说的"话并认真回答，
// 看起来就像"语音坏了"。命中就返回空串，由渲染层统一显示"（没听清你说啥，再来一次？）"。
function isAsrGarbage(rawText) {
  const s = String(rawText || '').trim();
  if (!s) return true;
  const compact = s.replace(/[\s,，。.、！!？?…~～:：;；"'“”()（）\[\]【】-]/g, '');
  if (!compact) return true;
  // 单字只认"确实像在回答"的那几个（"好/嗯/行"…），别的单字多半是噪声切出来的
  if (compact.length === 1 && !'好嗯行对是要来走喂在'.includes(compact)) return true;
  if (/以下是普通话的句子|请用简体中文转写|简体中文转写|请用简体中文/.test(compact)) return true;
  if (/^(谢谢观看|感谢观看|谢谢大家观看|字幕由|字幕组|请不吝点赞|请点赞订阅|订阅转发打赏|明镜与点点栏目|MINGPAOCANADA|请点赞订阅转发打赏支持明镜与点点栏目)/.test(compact)) return true;
  return false;
}

async function asrViaServer(wavBuf) {
  const ok = await ensureWhisperServer();
  if (!ok) return null;
  const fd = new FormData();
  fd.append('file', new Blob([wavBuf]), 'a.wav');
  fd.append('language', 'zh');
  fd.append('response_format', 'json');
  fd.append('prompt', WHISPER_PROMPT);
  // （提示词回声的过滤见 isAsrGarbage：whisper 在"没人说话/只有杂音"时会把上面的
  //   prompt 原样吐回来 —— 实测整句 "请用简体中文转写。" 被她当成主人说的话回过。）
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const res = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, { method: 'POST', body: fd, signal: ctl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    const text = String(j?.text || '')
      .replace(/\[\d{2}:\d{2}:\d{2}\.\d{3} --> [^\]]*\]/g, '')
      .replace(/\s+/g, ' ').trim();
    if (isAsrGarbage(text)) return { text: '' };   // 提示词回声/幻觉：当没听清
    return { text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 转写逻辑拆成函数：IPC 和"独立模式自检"共用同一条代码路径
//
// 排队 + 占用常驻服务都交给 asrCoordinator（见 whisper-idle.cjs）：
//   * 上一句还在认字时，新的一句排队等它（只留最新一条）—— 免提模式连说两句
//     以前第二句会被吞掉，表现就是"语音时好时坏"；
//   * 排队等待期间**也算占用**：整个请求期间不许释放常驻服务；
//   * 队满时挤掉最旧的那条 —— 挤掉的那句会正常收尾（不会再永远挂着）。
async function petAsr(wavBytes) {
  const buf = Buffer.from(wavBytes || []);
  if (!buf.length || buf.length < 1000) return { ok: false, error: '录音太短' };
  if (!fs.existsSync(WHISPER_EXE)) return { ok: false, error: '找不到 whisper-cli：' + WHISPER_EXE };
  if (!fs.existsSync(WHISPER_MODEL)) return { ok: false, error: '找不到 whisper 模型：' + WHISPER_MODEL };
  const outcome = await asrCoordinator.run(() => transcribeWav(buf));
  if (outcome.skipped) {
    return { ok: false, error: '说得太快了，上一句还没听清，请等她听完再说一遍' };
  }
  return outcome.value;
}

// 真正干活的部分：写文件 → 转写 → 清理（不含排队 / 占用）
async function transcribeWav(buf) {
  const stamp = Date.now();
  const wavPath = path.join(ASR_TMP, 'in-' + stamp + '.wav');
  const outBase = path.join(ASR_TMP, 'in-' + stamp);
  try {
    fs.mkdirSync(ASR_TMP, { recursive: true });
    fs.writeFileSync(wavPath, buf);
    const t0 = Date.now();
    let text = '';
    let engine = 'server';
    const srv = await asrViaServer(buf);
    if (srv) {
      text = srv.text;
    } else {
      engine = 'cli';
      // 兜底通道连着崩过就别再撞了：先把常驻服务拉起来（它才是主路），这 10 分钟直接说"耳朵没起来"
      if (Date.now() < asrCliCooldownUntil) {
        ensureWhisperServer().catch(() => {});
        return { ok: false, error: '耳朵正在重启（兜底通道刚才崩过两次），过十秒再说一遍就行' };
      }
      const r = await new Promise((resolve) => {
        const p = spawn(WHISPER_EXE, ['-m', path.basename(WHISPER_MODEL), '-f', wavPath, '-l', 'zh', '-t', '6',
          '-np', '-nt', '-otxt', '-of', outBase, '--prompt', WHISPER_PROMPT], { windowsHide: true, cwd: path.dirname(WHISPER_MODEL) });
        let err = '';
        let settled = false;
        // 同样加超时：whisper-cli 万一卡住（模型加载/磁盘异常），没有超时的话这条
        // 转写会永远不结束 —— 队列和占用都收不回来，等于麦克风从此哑掉。
        const done = (v) => { if (!settled) { settled = true; clearTimeout(killTimer); resolve(v); } };
        const killTimer = setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } done({ code: -2, err: 'whisper-cli 超过 90 秒没返回，已杀掉' }); }, 90000);
        p.stderr.on('data', (d) => { err += d.toString(); });
        p.on('error', (e) => done({ code: -1, err: String(e?.message || e) }));
        p.on('exit', (code) => done({ code, err }));
      });
      try { text = fs.readFileSync(outBase + '.txt', 'utf8'); } catch { /* 没写出来 */ }
      text = String(text || '')
        .replace(/\[\d{2}:\d{2}:\d{2}\.\d{3} --> [^\]]*\]/g, '')
        .replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean).join(' ');
      if (!text && r.code !== 0) {
        asrCliStrikes += 1;
        if (asrCliStrikes >= 2) {
          asrCliCooldownUntil = Date.now() + 10 * 60 * 1000;
          asrCliStrikes = 0;
          ensureWhisperServer().catch(() => {});   // 顺手把主路（常驻服务）拉起来
        }
        return { ok: false, error: 'whisper 退出码 ' + r.code + (r.err ? '：' + r.err.slice(-200) : ''), ms: Date.now() - t0 };
      }
      asrCliStrikes = 0;
    }
    if (isAsrGarbage(text)) text = '';   // 提示词回声/幻觉：当没听清（两条通道统一）
    return { ok: true, text, ms: Date.now() - t0, engine };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    // 队列的推进 / 占用的归还由 asrCoordinator 统一管（这里只清临时文件）
    for (const f of [wavPath, outBase + '.txt']) { try { fs.unlinkSync(f); } catch { /* 清不掉就算了 */ } }
  }
}
ipcMain.handle('pet:asr', (_e, wavBytes) => petAsr(wavBytes));

// ── 命中测试 + 拖拽跟随轮询 ─────────────────────────────────────────
// 2026-10-25：16ms → 32ms。这个常驻定时器是主进程最大的周期性唤醒源（原先 62Hz 永不
// 停）；32ms（约 31Hz）对光标命中判定和窗口拖拽跟手度都无感，主进程唤醒数直接减半。
// 再往上调（如 50ms+）拖拽会开始看出滞后，别贪。
setInterval(() => {
  if (dragging && win) {
    const c = screen.getCursorScreenPoint();
    // ⚠️ 夹住范围：拖拽时至少留 1/3 窗口在屏幕里。
    //    没有这层保护时，如果渲染层漏了 mouseup（鼠标在窗口外松开），
    //    这里会拿着旧偏移每 32ms 钉住窗口 —— 实测把她钉到 y=−784（屏幕外），
    //    表现就是"坐/趴/蹲看着沉下去了"。
    const b = win.getBounds();
    const wa = screen.getPrimaryDisplay().workArea;
    const nx = dragOrigin.window.x + (c.x - dragOrigin.cursor.x);
    const ny = dragOrigin.window.y + (c.y - dragOrigin.cursor.y);
    const minX = wa.x - b.width * 0.66;
    const maxX = wa.x + wa.width - b.width * 0.34;
    const minY = wa.y - b.height * 0.55;
    const maxY = wa.y + wa.height - b.height * 0.34;
    const rx = Math.round(Math.min(Math.max(nx, minX), maxX));
    const ry = Math.round(Math.min(Math.max(ny, minY), maxY));
    if (Number.isFinite(rx) && Number.isFinite(ry) && Math.abs(rx) <= 0x7fffffff && Math.abs(ry) <= 0x7fffffff) {
      try { win.setPosition(rx, ry); } catch { /* 忽略这一帧 */ }
    }
  } else {
    applyHitTest();
  }
}, 32);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.showInactive(); } });
  app.on('will-quit', () => {
    try { whisperIdle.dispose(); } catch { /* 忽略 */ }
    // 2026-10-25：退出时杀掉自己拉的 SSH 隧道。原先只清 whisper，
    // `ssh -N -L` 隧道没有会话使命也不会自己退，会留孤儿进程占着端口转发。
    try { if (tunnelProc && !tunnelProc.killed) tunnelProc.kill(); } catch { /* 忽略 */ }
  });
  // 上一版遗留的僵尸 foreground.exe（老版本没超时保护，卡住就不再退出）：启动时清一遍。
  // 它是"看你在忙什么"用的小工具，只在需要时按需启动，清掉不会有副作用。
  try { spawn('taskkill', ['/F', '/IM', 'foreground.exe'], { windowsHide: true }); } catch { /* 忽略 */ }
  app.whenReady().then(() => {
    if (SELF_TEST) {
      return;   // 自检模式：不建窗口/托盘
    }
    // 语音对讲（2026-10-11）：只给自己的窗口放行麦克风
    try {
      const ses = session.defaultSession;
      ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'));
      ses.setPermissionCheckHandler((_wc, permission) => permission === 'media');
    } catch { /* 权限接口异常也不该拦启动 */ }
    registerProtocol();
    createWindow();
    createTray();
  });
  app.on('window-all-closed', () => app.quit());
}

// 独立模式自检（PET_STANDALONE_SELFTEST=1 时跑完即退出；正常使用不会触发）
if (SELF_TEST) {
  app.whenReady().then(async () => {
    const out = [];
    try {
      const r1 = await standaloneReply('只回复两个字：可用');
      out.push('CHAT1: ' + JSON.stringify(r1));
      const r2 = await standaloneReply('你叫什么名字？简短一点');
      out.push('CHAT2: ' + JSON.stringify(r2));
      const voice = await petVoice('你好呀，我是娅娅。');
      out.push('VOICE: ' + JSON.stringify(voice));
      if (voice.ok && String(voice.url || '').endsWith('.wav')) {
        const dest = path.join(VOICE_DIR, decodeURIComponent(String(voice.url).split('/').pop()));
        const asr = await petAsr(new Uint8Array(fs.readFileSync(dest)));
        out.push('ASR: ' + JSON.stringify(asr));
      }
      // 无bot·本地看屏幕 / 陪看
      const look = await standaloneReply('看看屏幕');
      out.push('SCREEN: ' + JSON.stringify(look));
      startLocalWatch('chatty');
      const tick = await localWatchTick(true);
      stopLocalWatch();
      out.push('WATCH: ' + JSON.stringify(tick));
      out.push('INBOX: ' + JSON.stringify(STANDALONE_INBOX.splice(0).map((m) => m.text)));
    } catch (e) {
      out.push('FAIL: ' + String(e?.message || e));
    }
    try { fs.writeFileSync(path.join(ROOT, 'selftest-result.txt'), out.join('\n'), 'utf8'); } catch {}
    setTimeout(() => process.exit(0), 500);
  });
}
