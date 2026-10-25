'use strict';

// ── 常驻 whisper 转写服务的「空闲释放」生命周期控制器 ────────────────────
//
// 背景：whisper-server 一启动就把整个模型常驻内存（small 模型几百 MB），
//       但主人可能很久不说话，内存一直占着没必要。这里让它在**空闲一段时间后
//       主动退出**释放内存**，下一句话再按需拉起来（重新加载模型要花几秒，具体取决于模型大小和机器速度）。
//
// 为什么要单独一个模块：这一段逻辑最容易出竞态（进程还在启动就把服务杀了、
//       旧进程的 exit 事件把新进程状态清掉……），所以把它抽成**不依赖
//       electron / 不依赖真实进程**的纯逻辑模块，时钟、spawn、就绪探测、kill
//       全部可注入，这样能用假时钟 + 假进程独立测。
//
// 约定：
//   * idleMs = 0  → 禁用空闲释放（服务常驻到应用退出）。
//   * idleMs 未配置 → 默认 5 分钟。
//   * 只有**本 app 自己拉起来**的进程会被杀；绝不碰外部已在跑的 whisper-server。
//   * 请求进行中 / 排队中 / 服务启动中 —— 一律不杀。
//   * 旧进程延迟 exit 不会清掉新一代的 proc / ready 状态（generation 令牌）。
//
// 用法：
//   const ctl = createWhisperIdleController({ idleMs, spawnServer, waitReady, killOwned });
//   await ctl.ensure();          // 需要服务时调用（按需拉起）
//   const done = ctl.beginTask(); // 请求开始（占用期间不许释放）
//   try { ... } finally { done(); }
//   ctl.dispose();                // 应用退出：清 timer + 杀自己拉起来的进程

const DEFAULT_IDLE_MS = 5 * 60 * 1000;            // 默认空闲 5 分钟
const DEFAULT_MAX_AGE_MS = 12 * 3600 * 1000;       // 模型常驻满 12 小时后，下次使用时重载
                                                       //（注意：这是「模型刷新」，不是空闲释放）

function createWhisperIdleController(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setTimer = typeof options.setTimeout === 'function'
    ? options.setTimeout
    : (fn, ms) => setTimeout(fn, ms);
  const clearTimer = typeof options.clearTimeout === 'function'
    ? options.clearTimeout
    : (id) => clearTimeout(id);
  const spawnServer = typeof options.spawnServer === 'function' ? options.spawnServer : null;
  const waitReady = typeof options.waitReady === 'function' ? options.waitReady : null;
  const killOwned = typeof options.killOwned === 'function'
    ? options.killOwned
    : (p) => { try { p?.kill?.(); } catch { /* 忽略 */ } };
  const log = typeof options.log === 'function' ? options.log : () => {};
  const maxAgeMs = (() => {
    const n = Number(options.maxAgeMs);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_AGE_MS;
  })();
  // 杀进程后最多等多久等它真的退出（等不到也不能一直挂着）
  const exitWaitMs = (() => {
    const n = Number(options.exitWaitMs);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5000;
  })();

  let idleMs = normalizeIdleMs(options.idleMs);
  let proc = null;          // 当前这一代进程（一定是本 app 拉起来的）
  let generation = 0;       // 每拉起一次 +1：用来作废旧进程的 exit 事件
  let ready = false;
  let readyAt = 0;
  let starting = null;      // 正在启动中的 Promise
  let idleTimer = null;     // 空闲释放定时器
  let inflight = 0;         // 正在进行的请求数（含排队等待中的）
  let disposed = false;
  let stopping = null;      // 正在进行的「停止」（等进程真的退出）—— ensure() 要先等它
  const owned = new Set();  // 本 app 持有过的进程（只有这些会被杀）

  function normalizeIdleMs(v) {
    if (v === undefined || v === null || v === '') return DEFAULT_IDLE_MS;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_MS;
    return Math.floor(n);
  }

  // ── 空闲定时器 ──────────────────────────────────────────────────────
  function clearIdleTimer() {
    if (idleTimer !== null) {
      try { clearTimer(idleTimer); } catch { /* 忽略 */ }
      idleTimer = null;
    }
  }

  function armIdleTimer() {
    clearIdleTimer();
    if (disposed) return;
    if (!idleMs) return;                 // 0 = 禁用
    if (inflight > 0) return;            // 请求进行中/排队中：不安排释放
    if (!ready || !proc) return;         // 没起来就没得释放
    idleTimer = setTimer(() => {
      idleTimer = null;
      void onIdle();
    }, idleMs);
  }

  // 判断进程是不是**真的**退出了
  //   * 正常退出：exitCode 是数字
  //   * 被信号杀掉：exitCode 可能是 null，但 signalCode 非空（也算退出了）
  function hasExited(child) {
    if (!child) return true;
    if (typeof child.exitCode === 'number') return true;
    if (child.signalCode !== undefined && child.signalCode !== null) return true;
    return false;
  }

  // 等进程真的退出（最多 exitWaitMs）。**区分「真退出」和「等超时」**：
  //   * 真退出 → { exited: true }  → 可以交还所有权、可以拉新服务
  //   * 超时   → { exited: false } → 进程可能还活着（还占着端口）→ 保留所有权，
  //              后续 ensure() 不再拉新服务（退回单句转写兜底），退出时还能再杀一次
  function waitForExit(child) {
    if (!child) return Promise.resolve({ exited: true });
    if (hasExited(child)) return Promise.resolve({ exited: true });
    if (typeof child.on !== 'function') return Promise.resolve({ exited: false });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        try { clearTimer(timer); } catch { /* 忽略 */ }
        try { child.off?.('exit', onExit); } catch { /* 忽略 */ }
        resolve({ exited: !!exited });
      };
      const onExit = () => finish(true);
      try { child.on('exit', onExit); } catch { resolve({ exited: false }); return; }
      const timer = setTimer(() => finish(hasExited(child)), exitWaitMs);
    });
  }

  // 停掉一个「本 app 自己拉起来」的进程：发信号 + 等它真的退出。
  //
  // 为什么必须等退出（2026-10-22 修）：只 kill 不等的话，旧进程可能还占着
  // whisper 的端口，下一句就 spawn 新服务 → 新服务绑不上端口起不来，而就绪
  // 探测又会连到**旧**服务、把旧服务的健康当成新服务就绪（假就绪）。
  // 所有「停止」都登记到 stopping 上，ensure() 会先等它结束再拉新的。
  function stopProcess(child, reason) {
    if (!child) return Promise.resolve({ exited: true });
    const job = (async () => {
      try { await killOwned(child); } catch (e) { log('[whisper] ' + (reason || '停止服务') + '失败：' + e); }
      const r = await waitForExit(child);
      if (r.exited) {
        owned.delete(child);
      } else {
        // 没等到退出：进程可能还活着（还占着端口）→ **保留所有权**
        // （别把它当已经清干净：后续不再拉新服务，退出时还能再杀一次）
        log('[whisper] ' + (reason || '停止服务') + '：进程还没退出，保留所有权（下一句退回单句转写）');
      }
      return r;
    })();
    stopping = job;
    const clear = () => { if (stopping === job) stopping = null; };
    job.then(clear, clear);
    return job;
  }

  // 还有没有「不是当前实例」的进程没确认退出（可能还占着端口）
  function hasUnconfirmedOwned() {
    for (const p of owned) {
      if (p !== proc) return true;
    }
    return false;
  }

  // 空闲到期：只释放「本 app 自己拉起来」的那一个进程
  async function onIdle() {
    if (disposed) return;
    if (inflight > 0) { armIdleTimer(); return; }   // 刚好有人在说话：顺延，不杀
    if (!ready || !proc) return;
    const target = proc;
    // 先把状态摘掉（同步），这样这个进程迟到的 exit 事件不会误伤新实例
    proc = null;
    ready = false;
    readyAt = 0;
    log(`[whisper] 空闲 ${Math.round(idleMs / 1000)} 秒，释放常驻转写服务`);
    await stopProcess(target, '释放常驻服务');
  }

  // ── 进程生死 ────────────────────────────────────────────────────────
  function handleDeath(child, gen, confirmed = false) {
    // 只有**真的退出**了才交还所有权：
    //   * 'exit' 事件 → confirmed=true → 进程确实没了，可以放开端口
    //   * 'error' 事件 → 可能是 kill 失败之类，进程还活着 → 保留所有权，
    //     否则它还占着端口却没人管（退出时也杀不到）
    if (confirmed || hasExited(child)) owned.delete(child);
    if (gen !== generation) return;   // 旧一代：绝不动新一代的 proc / ready
    if (proc !== child) return;       // 已经不是当前进程了
    proc = null;
    ready = false;
    readyAt = 0;
    clearIdleTimer();
  }

  function attachDeathHandlers(child, gen) {
    if (!child || typeof child.on !== 'function') return;
    try {
      child.on('exit', () => handleDeath(child, gen, true));
      child.on('error', (err) => {
        log('[whisper] 常驻服务出错：' + err);
        handleDeath(child, gen);
      });
    } catch { /* 忽略 */ }
  }

  function isStale() {
    if (!readyAt) return false;
    return (now() - readyAt) >= maxAgeMs;   // 12 小时模型刷新（不是空闲释放）
  }

  // ── 启动 ────────────────────────────────────────────────────────────
  async function doStart() {
    if (!spawnServer || !waitReady) return false;
    if (disposed) return false;

    // 旧实例（只可能是我们自己拉起来的）先关掉
    const old = proc;
    if (old) {
      // 先把旧进程从状态里摘掉（同步）：这样它迟到的 exit 事件既匹配不上
      // proc（已是 null / 新实例），generation 也会在下面 +1 后对不上，不会误伤新实例。
      proc = null;
      ready = false;
      readyAt = 0;
      clearIdleTimer();
      // 等旧进程真的退出再拉新的（否则旧进程还占着端口 → 新服务起不来）
      await stopProcess(old, '关掉旧常驻服务');
      if (disposed) return false;
      if (hasUnconfirmedOwned()) return false;   // 旧实例没确认退出（还占着端口）→ 不拉新的
    }

    const gen = ++generation;
    let child = null;
    try { child = spawnServer(); } catch (e) { log('[whisper] 启动常驻服务失败：' + e); return false; }
    if (!child) return false;

    proc = child;
    ready = false;
    readyAt = 0;
    owned.add(child);
    attachDeathHandlers(child, gen);

    let ok = false;
    try {
      ok = !!(await waitReady(child, {
        generation: gen,
        isCurrent: () => gen === generation && proc === child,
      }));
    } catch (e) {
      log('[whisper] 就绪探测出错：' + e);
      ok = false;
    }

    if (!ok) {
      // 启动失败：清 timer + 杀掉我们刚拉起来的这个（只属于本 app）
      if (gen === generation && proc === child) {
        proc = null;
        ready = false;
        readyAt = 0;
      }
      clearIdleTimer();
      await stopProcess(child, '关掉启动失败的服务');
      return false;
    }

    if (gen !== generation || proc !== child) {
      // 启动期间被换掉 / 应用退出了：别把野进程留在后台
      await stopProcess(child, '清理被替换的服务');
      return false;
    }

    ready = true;
    readyAt = now();
    armIdleTimer();     // 从「启动完成」开始算空闲窗口
    return true;
  }

  function ensure() {
    if (disposed) return Promise.resolve(false);
    if (proc && ready && !proc.killed && !isStale()) return Promise.resolve(true);
    if (starting) return starting;
    // 有「不是当前实例」的进程还没确认退出（可能还占着端口）→ 不拉新服务，
    // 退回单句转写兜底；旧实例真的退出之后才允许再拉。
    if (hasUnconfirmedOwned() && !stopping) return Promise.resolve(false);
    const p = (async () => {
      // 上一轮「停止」还没真的结束（进程可能还占着端口）→ 先等它退出再拉新的，
      // 否则新服务绑不上端口，而就绪探测会连到旧服务 → 假就绪。
      const pendingStop = stopping;
      if (pendingStop) { try { await pendingStop; } catch { /* 忽略 */ } }
      if (disposed) return false;
      if (hasUnconfirmedOwned()) return false;   // 旧实例没确认退出 → 还是不拉新的
      return doStart();
    })();
    starting = p;
    const clear = () => { if (starting === p) starting = null; };
    p.then(clear, clear);
    return p;
  }

  // ── 活动 / 占用 ─────────────────────────────────────────────────────
  // 请求开始（包含排队等待）：占用期间绝不能释放服务
  function beginTask() {
    inflight += 1;
    clearIdleTimer();
    let ended = false;
    return function endTask() {
      if (ended) return;
      ended = true;
      inflight = Math.max(0, inflight - 1);
      if (inflight === 0) armIdleTimer();   // 从「最后一次 ASR 完成」开始算空闲
    };
  }

  // 有活动（说了一句话等）：把空闲窗口往后推
  function noteActivity() {
    if (disposed) return;
    if (inflight > 0) { clearIdleTimer(); return; }
    armIdleTimer();
  }

  // ── 退出清理 ────────────────────────────────────────────────────────
  function dispose() {
    disposed = true;
    clearIdleTimer();
    const list = Array.from(owned);
    owned.clear();
    proc = null;
    ready = false;
    readyAt = 0;
    for (const p of list) {
      try {
        const r = killOwned(p);
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch { /* 忽略 */ }
    }
    return list.length;
  }

  function setIdleMs(v) {
    idleMs = normalizeIdleMs(v);
    if (idleMs) armIdleTimer(); else clearIdleTimer();
    return idleMs;
  }

  function getState() {
    return {
      ready,
      inflight,
      idleMs,
      generation,
      hasProcess: !!proc,
      pid: proc?.pid ?? null,
      readyAt,
      disposed,
      timerActive: idleTimer !== null,
      ownedCount: owned.size,
    };
  }

  return {
    ensure,
    beginTask,
    noteActivity,
    dispose,
    setIdleMs,
    isReady: () => ready,
    isBusy: () => inflight > 0,
    getState,
  };
}

// ── ASR 排队协调（纯逻辑，可单测）──────────────────────────────────────
//
// 一次只转写一句；后来的排到队里，队满就**挤掉最旧的那条**。
// 关键点：被挤掉的那条**必须 settle**（返回「被挤掉」的结果）——
// 旧实现是 asrQueue.shift() 直接把 resolve 丢掉，那一句的 Promise 永远
// 不 settle，它的「占用计数」也永远还不上 → 空闲释放再也触发不了，
// 而且这次 ASR 调用本身也永远挂着（2026-10-22 修）。
function createAsrQueue(limit = 1) {
  const max = (() => {
    const n = Number(limit);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  })();
  let running = false;
  const waiting = [];   // { resolve }

  function acquire() {
    if (!running) {
      running = true;
      return Promise.resolve({ granted: true });
    }
    return new Promise((resolve) => {
      // 队满：挤掉最旧的一条 —— 一定要让它 settle，不能只丢掉它的 resolve
      while (waiting.length >= max) {
        const old = waiting.shift();
        if (old) old.resolve({ granted: false, reason: 'superseded' });
      }
      waiting.push({ resolve });
    });
  }

  function release() {
    running = false;
    const next = waiting.shift();
    if (next) {
      running = true;
      next.resolve({ granted: true });
    }
  }

  return {
    acquire,
    release,
    isBusy: () => running,
    pending: () => waiting.length,
  };
}

// 把「占用常驻服务 + 排队」串成一条流程：petAsr 走的就是它。
// 占用从**排队那一刻**开始，到**彻底收尾**才结束 —— 排队/转写全程都不许
// 释放常驻服务；被挤掉的那条也会把占用还回去（否则占用永远降不下来）。
function createAsrCoordinator(controller, options = {}) {
  if (!controller || typeof controller.beginTask !== 'function') {
    throw new TypeError('createAsrCoordinator 需要一个带 beginTask 的控制器');
  }
  const queue = createAsrQueue(options.queueLimit);
  async function run(fn) {
    const end = controller.beginTask();
    try {
      const slot = await queue.acquire();
      if (!slot.granted) {
        return { ok: false, skipped: true, reason: slot.reason || 'superseded' };
      }
      try {
        return { ok: true, value: await fn() };
      } finally {
        queue.release();
      }
    } finally {
      end();   // 一定还回去：否则 inflight 永远 > 0，空闲释放永远不触发
    }
  }
  return { run, queue };
}

// ── 有界的就绪探测 ────────────────────────────────────────────────────
//
// 旧实现只有「外层 25 秒总期限」，但单次 fetch 没有超时：一旦 fetch 挂住
// （连接建了但没回数据），await 永远不返回 → 外层期限形同虚设 → ensure()
// 永远不 settle → 整条 ASR 链路卡死。这里给**单次**探测加超时（并且用
// race 兜底：就算 fetch 不理 AbortSignal，也到点就走）。
async function waitReadyBounded(options = {}) {
  const url = options.url;
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const totalMs = (() => { const n = Number(options.totalMs); return Number.isFinite(n) && n > 0 ? n : 25000; })();
  const attemptTimeoutMs = (() => { const n = Number(options.attemptTimeoutMs); return Number.isFinite(n) && n > 0 ? n : 1500; })();
  const intervalMs = (() => { const n = Number(options.intervalMs); return Number.isFinite(n) && n >= 0 ? n : 400; })();
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setT = typeof options.setTimeout === 'function' ? options.setTimeout : (fn, ms) => setTimeout(fn, ms);
  const clearT = typeof options.clearTimeout === 'function' ? options.clearTimeout : (id) => clearTimeout(id);
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
  const isAlive = typeof options.isAlive === 'function' ? options.isAlive : () => true;
  if (!url || typeof fetchImpl !== 'function') return false;

  const deadline = now() + totalMs;
  const sleep = (ms) => new Promise((r) => setT(r, ms));

  while (now() < deadline && isCurrent() && isAlive()) {
    // 单次探测的超时**不能超过总期限**：否则最后一次探测会拖过总期限
    const attemptMs = Math.max(1, Math.min(attemptTimeoutMs, deadline - now()));
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setT(() => {
        try { ac?.abort(); } catch { /* 忽略 */ }
        resolve(false);
      }, attemptMs);
    });
    let alive = false;
    try {
      alive = await Promise.race([
        Promise.resolve()
          .then(() => fetchImpl(url, { method: 'GET', signal: ac?.signal }))
          .then(() => true, () => false),
        timeout,
      ]);
    } catch {
      alive = false;
    } finally {
      if (timer !== null) { try { clearT(timer); } catch { /* 忽略 */ } }
    }
    if (alive) return isCurrent() && isAlive();
    const remain = deadline - now();
    if (remain <= 0) break;
    await sleep(Math.min(intervalMs, remain));
  }
  return false;
}

module.exports = {
  createWhisperIdleController,
  createAsrQueue,
  createAsrCoordinator,
  waitReadyBounded,
  DEFAULT_IDLE_MS,
  DEFAULT_MAX_AGE_MS,
};
