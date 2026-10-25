'use strict';

// 独立测试：electron/whisper-idle.cjs 的生命周期控制器
// 全部用**假时钟 + 假进程**跑：不起真实 whisper-server、不联网、不杀任何真实进程。
//
// 跑法：node --test tests/whisper-idle.test.cjs

const test = require('node:test');
const assert = require('node:assert');
const { createWhisperIdleController, createAsrCoordinator, waitReadyBounded, DEFAULT_IDLE_MS } = require('../electron/whisper-idle.cjs');

// ── 假时钟 ──────────────────────────────────────────────────────────────
function createFakeClock() {
  let current = 1_000_000;
  let seq = 0;
  const timers = new Map();
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    now: () => current,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: current + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
        }
        if (!next) break;
        timers.delete(next[0]);
        current = next[1].at;
        next[1].fn();
        await flush();
      }
      current = target;
      await flush();
    },
  };
}

// ── 假进程 ──────────────────────────────────────────────────────────────
// autoExit=false：kill() 之后**不**自动退出（模拟"端口还被占着"），
//                用来测「等旧进程真的退出才拉新的」。
function createFakeProcess(pid, opts = {}) {
  const autoExit = opts.autoExit !== false;
  const handlers = new Map();
  const p = {
    pid,
    exitCode: null,
    killed: false,
    stdout: { on() {} },
    stderr: { on() {} },
    on(ev, cb) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(cb);
      return p;
    },
    off(ev, cb) {
      const list = handlers.get(ev) || [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
      return p;
    },
    emit(ev, ...args) {
      for (const cb of (handlers.get(ev) || []).slice()) cb(...args);
    },
    kill() {
      p.killed = true;
      if (opts.killThrows) throw new Error('kill 失败（EPERM）');
      if (autoExit) p.exit(0);
      return true;
    },
    exit(code = 0) {
      if (p.exitCode !== null) return;
      p.exitCode = code;
      p.emit('exit', code);
    },
  };
  return p;
}

// ── 组装：控制器 + 假时钟 + 假进程 ──────────────────────────────────────
function setup(opts = {}) {
  const clock = createFakeClock();
  const spawned = [];
  const killed = [];
  let resolveReady = null;
  const ctl = createWhisperIdleController({
    idleMs: opts.idleMs !== undefined ? opts.idleMs : DEFAULT_IDLE_MS,
    maxAgeMs: opts.maxAgeMs,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    spawnServer: () => {
      const p = createFakeProcess(1000 + spawned.length, { autoExit: !opts.manualExit, killThrows: !!opts.killThrows });
      spawned.push(p);
      return p;
    },
    waitReady: async (p, ctx) => {
      if (opts.deferReady) {
        return new Promise((resolve) => { resolveReady = (v) => resolve(v); });
      }
      if (opts.ready === false) return false;
      return ctx.isCurrent();
    },
    killOwned: async (p) => { killed.push(p); try { p.kill(); } catch { /* 忽略 */ } },
  });
  return {
    clock,
    ctl,
    spawned,
    killed,
    releaseReady: (v = true) => { if (resolveReady) resolveReady(v); },
  };
}

// ── 用例 ────────────────────────────────────────────────────────────────

test('空闲到期会释放常驻服务（默认 5 分钟）', async () => {
  const { ctl, clock, spawned, killed } = setup();
  assert.equal(await ctl.ensure(), true, '服务应该启动成功');
  assert.equal(spawned.length, 1);
  assert.equal(ctl.getState().ready, true);
  assert.equal(ctl.getState().pid, spawned[0].pid);

  await clock.advance(DEFAULT_IDLE_MS - 1);
  assert.equal(killed.length, 0, '还没到空闲时间，不该杀');

  await clock.advance(1);
  assert.equal(killed.length, 1, '空闲到期应该释放服务');
  assert.equal(killed[0].pid, spawned[0].pid, '只能杀自己拉起来的那个进程');
  assert.equal(ctl.getState().ready, false);
  assert.equal(ctl.getState().hasProcess, false);
});

test('请求进行中（busy）不触发释放', async () => {
  const { ctl, clock, killed } = setup();
  await ctl.ensure();
  const done = ctl.beginTask();          // 相当于一句话正在转写 / 排队中
  assert.equal(clock.pending(), 0, '占用期间不该挂着空闲定时器');

  await clock.advance(60 * 60 * 1000);    // 一小时
  assert.equal(killed.length, 0, '请求进行中不能杀服务');
  assert.equal(ctl.getState().ready, true);

  done();                                 // 最后一次 ASR 完成
  assert.equal(clock.pending(), 1, '请求结束后重新开始算空闲');
  await clock.advance(DEFAULT_IDLE_MS);
  assert.equal(killed.length, 1, '空闲到期才释放');
});

test('排队等待中的第二个请求也不触发释放', async () => {
  const { ctl, clock, killed } = setup();
  await ctl.ensure();
  const first = ctl.beginTask();          // 第一句在转写
  const second = ctl.beginTask();         // 第二句在排队
  await clock.advance(30 * 60 * 1000);
  assert.equal(killed.length, 0, '排队中不能杀服务');
  first();
  await clock.advance(30 * 60 * 1000);
  assert.equal(killed.length, 0, '排队的那句还没完，不能杀');
  second();
  await clock.advance(DEFAULT_IDLE_MS);
  assert.equal(killed.length, 1);
});

test('活动会顺延空闲窗口', async () => {
  const { ctl, clock, killed } = setup();
  await ctl.ensure();
  await clock.advance(DEFAULT_IDLE_MS - 1000);
  ctl.noteActivity();                     // 有新活动 → 空闲窗口往后推
  await clock.advance(DEFAULT_IDLE_MS - 1000);
  assert.equal(killed.length, 0, '活动后还没到新的空闲时间');
  await clock.advance(1000);
  assert.equal(killed.length, 1, '新的空闲时间到了才释放');
});

test('取消定时器：占用时撤掉、退出时清干净', async () => {
  const { ctl, clock, killed } = setup();
  await ctl.ensure();
  assert.equal(clock.pending(), 1, '就绪后应挂上空闲定时器');

  const done = ctl.beginTask();
  assert.equal(clock.pending(), 0, '占用期间定时器应被撤掉');

  done();
  assert.equal(clock.pending(), 1, '结束后重新挂上');

  ctl.dispose();
  assert.equal(clock.pending(), 0, 'dispose 后不该残留定时器');
  await clock.advance(60 * 60 * 1000);
  assert.equal(killed.length, 1, 'dispose 已经杀过一次，定时器不能再杀');
});

test('旧进程迟到的 exit 不会清掉新实例的进程/就绪状态', async () => {
  const { ctl, clock, spawned, killed } = setup({ maxAgeMs: 60 * 1000 });
  await ctl.ensure();
  const old = spawned[0];
  assert.equal(ctl.getState().pid, old.pid);

  // 模型常驻超过 maxAgeMs → 下次使用时重载（这跟空闲释放是两回事）
  await clock.advance(120 * 1000);
  await ctl.ensure();
  assert.equal(spawned.length, 2, '应该拉起新进程');
  const fresh = spawned[1];
  assert.equal(ctl.getState().pid, fresh.pid);
  assert.equal(ctl.getState().generation, 2);

  // 旧进程这时才退出（延迟 exit）
  old.emit('exit', 0);

  assert.equal(ctl.getState().ready, true, '旧进程 exit 不能把新实例的就绪状态清掉');
  assert.equal(ctl.getState().pid, fresh.pid, '旧进程 exit 不能把新实例的进程清掉');
  assert.equal(ctl.getState().hasProcess, true);
  assert.equal(killed.filter((p) => p.pid === fresh.pid).length, 0, '新实例不该被杀');

  // 新实例照常按空闲释放
  await clock.advance(DEFAULT_IDLE_MS);
  assert.equal(killed.filter((p) => p.pid === fresh.pid).length, 1);
});

test('启动失败：清定时器 + 杀掉刚拉起来的进程', async () => {
  const { ctl, clock, spawned, killed } = setup({ ready: false });
  assert.equal(await ctl.ensure(), false, '启动失败应该返回 false');
  assert.equal(killed.length, 1, '启动失败的进程要被杀掉');
  assert.equal(killed[0].pid, spawned[0].pid);
  assert.equal(ctl.getState().ready, false);
  assert.equal(ctl.getState().hasProcess, false);
  assert.equal(clock.pending(), 0, '失败后不该留定时器');
  await clock.advance(60 * 60 * 1000);
  assert.equal(killed.length, 1, '失败后不该再有定时器动作');
});

test('启动过程中不会被空闲定时器杀掉', async () => {
  const { ctl, clock, spawned, killed, releaseReady } = setup({ deferReady: true });
  const pending = ctl.ensure();          // 还没就绪
  await clock.advance(60 * 60 * 1000);
  assert.equal(killed.length, 0, '启动中不能杀');
  assert.equal(clock.pending(), 0, '启动中不该挂空闲定时器');
  releaseReady(true);
  assert.equal(await pending, true);
  assert.equal(ctl.getState().ready, true);
});

test('应用退出：清定时器 + 只杀本 app 持有的进程', async () => {
  const { ctl, clock, spawned, killed } = setup();
  await ctl.ensure();
  const p = spawned[0];
  assert.equal(clock.pending(), 1);

  ctl.dispose();
  assert.equal(clock.pending(), 0, '退出后不该残留定时器');
  assert.equal(killed.length, 1, '退出要杀掉自己拉起来的进程');
  assert.equal(killed[0].pid, p.pid);
  assert.equal(ctl.getState().disposed, true);

  await clock.advance(60 * 60 * 1000);
  assert.equal(killed.length, 1, '退出后不该再杀');

  // 退出后再调 ensure：不再拉起新进程
  assert.equal(await ctl.ensure(), false);
  assert.equal(spawned.length, 1);
});

test('idleMs = 0 表示禁用空闲释放', async () => {
  const { ctl, clock, killed } = setup({ idleMs: 0 });
  await ctl.ensure();
  assert.equal(clock.pending(), 0, '禁用时不该挂定时器');
  await clock.advance(24 * 60 * 60 * 1000);
  assert.equal(killed.length, 0, '禁用时永不自动释放');
});

test('永远不会杀没有经过本控制器拉起的进程', async () => {
  const { ctl, clock, spawned, killed } = setup();
  await ctl.ensure();
  await clock.advance(DEFAULT_IDLE_MS);
  for (const p of killed) {
    assert.ok(spawned.includes(p), '只能杀本 app 拉起来的进程');
  }
  assert.equal(killed.length, 1);
});

// ── 2026-10-22 修：连续说三句时，被挤掉的那句也必须收尾 ────────────────
//
// 旧实现：asrQueue.shift() 把排队的 resolve 直接丢掉 → 那一句的 Promise
// 永远不 settle → 它的「占用计数」永远还不上 → inflight 永远 > 0 →
// 空闲释放再也触发不了（而且那次 ASR 调用本身也永远挂着）。
test('连续说三句：被挤掉的那句要正常收尾，占用归零后能正常空闲释放', async () => {
  const { ctl, clock, spawned, killed } = setup();
  await ctl.ensure();
  const coordinator = createAsrCoordinator(ctl, { queueLimit: 1 });

  const order = [];
  let releaseFirst = null;
  const gate = new Promise((r) => { releaseFirst = r; });
  const p1 = coordinator.run(async () => { order.push('1-start'); await gate; order.push('1-end'); return { ok: true, text: '一' }; });
  const p2 = coordinator.run(async () => { order.push('2-start'); return { ok: true, text: '二' }; });
  const p3 = coordinator.run(async () => { order.push('3-start'); return { ok: true, text: '三' }; });

  assert.equal(ctl.getState().inflight, 3, '三句都算占用（含排队等待中的）');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['1-start'], '同一时刻只转写一句');

  const r2 = await p2;   // 第二句被第三句挤掉：必须 settle，不能永远挂着
  assert.equal(r2.ok, false);
  assert.equal(r2.skipped, true, '被挤掉的那句要正常收尾');
  assert.equal(ctl.getState().inflight, 2, '被挤掉的那句要把占用还回来');

  releaseFirst();
  const r1 = await p1;
  const r3 = await p3;
  assert.equal(r1.value.text, '一');
  assert.equal(r3.value.text, '三');
  assert.deepEqual(order, ['1-start', '1-end', '3-start'], '被挤掉的那句不能插队执行');

  assert.equal(ctl.getState().inflight, 0, '全部收尾后占用必须归零');
  assert.equal(clock.pending(), 1, '空闲窗口要重新开始算');
  await clock.advance(DEFAULT_IDLE_MS);
  assert.equal(killed.length, 1, '占用归零后闲置到期要能释放常驻服务');
});

test('排队中的请求不会让常驻服务被提前释放', async () => {
  const { ctl, clock, killed } = setup();
  await ctl.ensure();
  const coordinator = createAsrCoordinator(ctl, { queueLimit: 1 });
  let releaseFirst = null;
  const gate = new Promise((r) => { releaseFirst = r; });
  const p1 = coordinator.run(async () => { await gate; return { ok: true }; });
  const p2 = coordinator.run(async () => ({ ok: true }));
  await clock.advance(30 * 60 * 1000);
  assert.equal(killed.length, 0, '排队等待期间不能杀服务');
  releaseFirst();
  await p1; await p2;
  assert.equal(ctl.getState().inflight, 0);
});

// ── 2026-10-22 修：释放后要等旧进程真的退出，才拉新服务 ────────────────
//
// 旧实现：killOwned 只发信号不等退出 → 旧进程可能还占着 whisper 端口，
// 下一句就 spawn 新服务 → 新服务绑不上端口起不来，而就绪探测又会连到
// **旧**服务 → 把旧服务的健康当成新服务就绪（假就绪）。
test('空闲释放后：等旧进程真的退出，才拉起新服务（不能抢端口）', async () => {
  const { ctl, clock, spawned, killed } = setup({ manualExit: true });
  await ctl.ensure();
  const old = spawned[0];

  await clock.advance(DEFAULT_IDLE_MS);        // 空闲到期 → 释放
  assert.equal(killed.length, 1, '空闲到期要释放旧服务');
  assert.equal(old.killed, true);
  assert.equal(old.exitCode, null, '旧进程还没退出（它还占着端口）');

  const pending = ctl.ensure();               // 下一句：应该等旧进程退出
  await new Promise((r) => setImmediate(r));
  assert.equal(spawned.length, 1, '旧进程还没退出，不能拉新服务');

  old.exit(0);                                // 旧进程这时才真的退出
  assert.equal(await pending, true, '旧进程退出后要能拉起新服务');
  assert.equal(spawned.length, 2);
  assert.equal(ctl.getState().pid, spawned[1].pid);
  assert.equal(ctl.getState().generation, 2, '新实例要拿到新的 generation');
});

// ── 2026-10-22 修：就绪探测必须有界 ────────────────────────────────────
//
// 旧实现只有「外层 25 秒总期限」，但单次 fetch 没有超时：fetch 一挂住，
// await 永远不返回 → 外层期限形同虚设 → ensure() 永远不 settle。
test('就绪探测有界：单次 fetch 挂住时也会在期限内返回', async () => {
  const t0 = Date.now();
  const ok = await waitReadyBounded({
    url: 'http://127.0.0.1:1/',
    fetchImpl: () => new Promise(() => {}),   // 永远不返回，也不理 AbortSignal
    totalMs: 300,
    attemptTimeoutMs: 50,
    intervalMs: 10,
  });
  assert.equal(ok, false, '挂住的探测不能被当成就绪');
  assert.ok(Date.now() - t0 < 5000, '探测必须有界返回（不能无限等）');
});

test('就绪探测：失败就继续试，通了才算就绪', async () => {
  let n = 0;
  const ok = await waitReadyBounded({
    url: 'http://127.0.0.1:1/',
    fetchImpl: async () => { n += 1; if (n < 3) throw new Error('还没起来'); return { ok: true }; },
    totalMs: 2000,
    attemptTimeoutMs: 200,
    intervalMs: 10,
  });
  assert.equal(ok, true);
  assert.equal(n, 3, '前两次失败要继续试');
});

// ── 2026-10-22 修：停止失败的边界（进程一直不退出 / kill 失败）────────────
//
// 旧行为：waitForExit 计时满就无条件 resolve，stopProcess 随后无条件
// owned.delete → 旧进程可能还活着、还占着端口，却已经被当成清干净了。
// 现在：区分「真退出」和「超时」——超时保留所有权，后续 ensure 不再拉新
// 服务（退回单句转写兜底），旧实例真的退出后才允许再拉。
test('旧进程一直不退出：不拉新服务（退回单句转写），所有权保留，迟到退出后才能再拉', async () => {
  const { ctl, clock, spawned, killed } = setup({ manualExit: true });
  await ctl.ensure();
  const old = spawned[0];

  await clock.advance(DEFAULT_IDLE_MS);      // 空闲到期 → 释放（进程不退）
  assert.equal(killed.length, 1, '空闲到期要尝试释放');
  assert.equal(old.exitCode, null, '旧进程还没退出');

  await clock.advance(6000);                 // 超过 exitWaitMs（5 秒）还是没退出
  assert.equal(ctl.getState().ownedCount, 1, '没确认退出前要保留所有权');
  assert.equal(ctl.getState().hasProcess, false);

  // 后续 ensure 不能拉新服务（旧进程可能还占着端口）→ 走既有 CLI 兜底
  assert.equal(await ctl.ensure(), false, '旧进程没确认退出时不能拉新服务');
  assert.equal(spawned.length, 1, '不能 spawn 第二个实例');

  // 旧进程后来真的退出了 → 才能再拉新实例
  old.exit(0);
  await new Promise((r) => setImmediate(r));
  assert.equal(ctl.getState().ownedCount, 0, '确认退出后要交还所有权');
  assert.equal(await ctl.ensure(), true, '旧实例退出后可以拉新服务');
  assert.equal(spawned.length, 2);
  assert.equal(ctl.getState().generation, 2);

  // dispose 仍然要杀掉自己持有的进程
  ctl.dispose();
  assert.equal(killed.length, 2, 'dispose 要杀掉新实例');
});

test('kill 抛错（进程可能还活着）：不丢所有权、不拉新服务，退出时还能再杀一次', async () => {
  const { ctl, clock, spawned, killed } = setup({ manualExit: true, killThrows: true });
  await ctl.ensure();
  const old = spawned[0];

  await clock.advance(DEFAULT_IDLE_MS);
  await clock.advance(6000);
  assert.equal(ctl.getState().ownedCount, 1, 'kill 失败不能把所有权丢掉（进程可能还活着）');
  assert.equal(await ctl.ensure(), false, '不能拉新服务');
  assert.equal(spawned.length, 1, '不能 spawn 第二个实例');

  ctl.dispose();
  assert.equal(killed.length, 2, 'dispose 要再杀一次这个还活着的进程');
  assert.equal(ctl.getState().ownedCount, 0, 'dispose 要清掉所有权');
});
