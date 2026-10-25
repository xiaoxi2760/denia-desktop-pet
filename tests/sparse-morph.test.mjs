// 稀疏 morph 候选模块的合成数据测试（不依赖 three / 不装新包 / 不碰真实模型）
// 跑法：node --test tests/sparse-morph.test.mjs
//
// 覆盖：两个 morph 的绝对坐标 / 相对坐标、负权重与权重和 > 1、归零回基础、
//       重复 update 不重复写、以及各类「不支持」的输入必须返回 null 且
//       **不破坏原 geometry**。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSparseMorphController, DYNAMIC_DRAW_USAGE } from '../app/lib/SparseMorphController.js';

// ── 轻量 BufferAttribute 桩 ─────────────────────────────────────────────
function makeAttr(count, itemSize = 3) {
  return {
    array: new Float32Array(count * itemSize),
    itemSize,
    count,
    usage: 35044,                     // StaticDrawUsage
    needsUpdate: false,
    isInterleavedBufferAttribute: false,
    setUsage(u) { this.usage = u; return this; },
  };
}

// ── 合成 mesh ────────────────────────────────────────────────────────────
// base：第 i 个顶点在 (i, 0, 0)
// morphA：顶点 5..14 抬到 y+1
// morphB：顶点 50..59 抬到 z+2
const VERTEX_COUNT = 100;
function buildTargets(relative) {
  const a = new Float32Array(VERTEX_COUNT * 3);
  const b = new Float32Array(VERTEX_COUNT * 3);
  if (!relative) {
    // 绝对坐标：target 存完整位置
    for (let i = 0; i < VERTEX_COUNT; i++) { a[i * 3] = i; b[i * 3] = i; }
  }
  // 相对坐标：target 只存 delta（其余为 0）
  for (let v = 5; v < 15; v++) a[v * 3 + 1] = 1;      // morphA：y 偏移 1
  for (let v = 50; v < 60; v++) b[v * 3 + 2] = 2;     // morphB：z 偏移 2
  return [a, b];
}

function makeMesh(opts = {}) {
  const relative = !!opts.relative;
  const geometry = {
    attributes: { position: opts.position || makeAttr(VERTEX_COUNT) },
    morphAttributes: {},
    morphTargetDictionary: { smile: 0, blink: 1 },
  };
  const pos = geometry.attributes.position;
  for (let i = 0; i < VERTEX_COUNT; i++) pos.array[i * 3] = i;      // base 位置

  if (opts.noMorph) {
    // 不放任何 morph
  } else {
    const targets = buildTargets(relative);
    const attrs = targets.map((arr) => {
      const t = makeAttr(VERTEX_COUNT);
      t.array.set(arr);
      return t;
    });
    geometry.morphAttributes.position = attrs;
  }
  if (opts.extraMorph) geometry.morphAttributes.normal = [makeAttr(VERTEX_COUNT)];

  const mesh = {
    geometry,
    morphTargetInfluences: [0, 0],
    morphTargetDictionary: geometry.morphTargetDictionary,
  };
  geometry.morphTargetsRelative = relative;
  return mesh;
}

const xyz = (arr, v) => [arr[v * 3], arr[v * 3 + 1], arr[v * 3 + 2]];

test('小数权重保持不变时不重复上传，格式不完整时保留 dense', () => {
  const mesh = makeMesh();
  const controller = createSparseMorphController(mesh);
  mesh.morphTargetInfluences[0] = 0.1;
  assert.equal(controller.update(), true);
  assert.equal(controller.update(), false);
  const invalid = makeMesh();
  const attributes = invalid.geometry.morphAttributes.position;
  attributes[0].array = new Float32Array(1);
  assert.equal(createSparseMorphController(invalid), null);
  assert.equal(invalid.geometry.morphAttributes.position, attributes);
});

// ── 用例 ────────────────────────────────────────────────────────────────

test('绝对坐标两个 morph：抽出稀疏数据，dense 通道被移除，stats 合理', () => {
  const mesh = makeMesh();
  const ctl = createSparseMorphController(mesh);
  assert.ok(ctl, '应该能建出控制器');

  assert.equal(mesh.geometry.morphAttributes.position, undefined, '预计算完成后要删掉 dense morph 通道');
  assert.equal(mesh.geometry.attributes.position.usage, DYNAMIC_DRAW_USAGE, 'position 要改成动态用法');
  assert.equal(ctl.stats.mode, 'sparse');
  assert.equal(ctl.stats.morphCount, 2);
  assert.equal(ctl.stats.affectedVertices, 20, '两个目标各影响 10 个顶点');
  assert.equal(ctl.stats.denseBytes, 2 * VERTEX_COUNT * 3 * 4);
  assert.ok(ctl.stats.sparseBytes < ctl.stats.denseBytes, '稀疏数据应该比 dense 小');

  // 原 influences 数组 / 字典不能被改
  assert.deepEqual(mesh.morphTargetInfluences, [0, 0]);
  assert.deepEqual(Object.keys(mesh.morphTargetDictionary), ['smile', 'blink']);
});

test('绝对坐标：权重累加正确，归零回基础，负权重与权重和 > 1 也对', () => {
  const mesh = makeMesh();
  const ctl = createSparseMorphController(mesh);
  const pos = mesh.geometry.attributes.position.array;

  assert.equal(ctl.update([1, 0]), true);
  assert.deepEqual(xyz(pos, 5), [5, 1, 0], 'morphA 的 y 偏移');
  assert.deepEqual(xyz(pos, 50), [50, 0, 0], 'morphB 权重为 0 → 保持基础');
  assert.deepEqual(xyz(pos, 0), [0, 0, 0], '没受影响的顶点不动');
  assert.equal(mesh.geometry.attributes.position.needsUpdate, true);

  assert.equal(ctl.update([0.5, 0.25]), true);
  assert.deepEqual(xyz(pos, 5), [5, 0.5, 0]);
  assert.deepEqual(xyz(pos, 50), [50, 0, 0.5]);

  assert.equal(ctl.update([-0.5, 1.5]), true, '负权重与权重和 > 1 要照算');
  assert.deepEqual(xyz(pos, 5), [5, -0.5, 0]);
  assert.deepEqual(xyz(pos, 50), [50, 0, 3]);

  assert.equal(ctl.update([0, 0]), true, '归零也要算一次变化');
  assert.deepEqual(xyz(pos, 5), [5, 0, 0], '归零后恢复基础位置');
  assert.deepEqual(xyz(pos, 50), [50, 0, 0]);
  assert.deepEqual(xyz(pos, 0), [0, 0, 0]);
});

test('重复 update：权重没变就不重写（返回 false，数组内容不变）', () => {
  const mesh = makeMesh();
  const ctl = createSparseMorphController(mesh);
  const pos = mesh.geometry.attributes.position.array;

  assert.equal(ctl.update([0.5, 0.25]), true);
  const snapshot = Float32Array.from(pos);
  assert.equal(ctl.update([0.5, 0.25]), false, '权重没变 → 不该再算一遍');
  assert.deepEqual(Array.from(pos), Array.from(snapshot), '数组内容不能被重复 update 搞乱');
});

test('不传权重时读 mesh.morphTargetInfluences（原数组不被改写）', () => {
  const mesh = makeMesh();
  const ctl = createSparseMorphController(mesh);
  const pos = mesh.geometry.attributes.position.array;

  mesh.morphTargetInfluences[0] = 1;              // 调用方直接改原数组
  assert.equal(ctl.update(), true);
  assert.deepEqual(xyz(pos, 5), [5, 1, 0]);
  assert.deepEqual(mesh.morphTargetInfluences, [1, 0], 'influences 数组内容不能被控制器改写');
});

test('相对模式（morphTargetsRelative）：target 直接当 delta 用', () => {
  const mesh = makeMesh({ relative: true });
  const ctl = createSparseMorphController(mesh);
  const pos = mesh.geometry.attributes.position.array;

  assert.equal(ctl.stats.affectedVertices, 20);
  assert.equal(ctl.update([1, 0]), true);
  assert.deepEqual(xyz(pos, 5), [5, 1, 0], '相对模式：base + delta');
  assert.deepEqual(xyz(pos, 50), [50, 0, 0]);
  assert.equal(ctl.update([0, 1]), true);
  assert.deepEqual(xyz(pos, 5), [5, 0, 0], '切走第一个目标要恢复基础');
  assert.deepEqual(xyz(pos, 50), [50, 0, 2]);
});

test('不支持的情况一律返回 null，且不破坏原 geometry', () => {
  // 1) 完全没有 morph
  const none = makeMesh({ noMorph: true });
  assert.equal(createSparseMorphController(none), null);
  assert.equal(none.geometry.morphAttributes.position, undefined);
  assert.equal(none.geometry.attributes.position.usage, 35044, 'usage 不能被改');

  // 2) 还有 normal / color 等其它 morph 通道
  const extra = makeMesh({ extraMorph: true });
  const extraTargets = extra.geometry.morphAttributes.position;
  assert.equal(createSparseMorphController(extra), null);
  assert.equal(extra.geometry.morphAttributes.position, extraTargets, 'dense 通道不能被删');
  assert.equal(extra.geometry.attributes.position.usage, 35044);

  // 3) interleaved 的 position
  const inter = makeMesh();
  const interTargets = inter.geometry.morphAttributes.position;
  inter.geometry.attributes.position = {
    count: VERTEX_COUNT, itemSize: 3, isInterleavedBufferAttribute: true, needsUpdate: false,
  };
  assert.equal(createSparseMorphController(inter), null);
  assert.equal(inter.geometry.morphAttributes.position, interTargets, 'dense 通道不能被删');

  // 4) 格式不合规：itemSize 不是 3
  const bad = makeMesh();
  const badTargets = bad.geometry.morphAttributes.position;
  bad.geometry.attributes.position = makeAttr(VERTEX_COUNT, 2);
  assert.equal(createSparseMorphController(bad), null);
  assert.equal(bad.geometry.morphAttributes.position, badTargets, 'dense 通道不能被删');

  // 5) morph 顶点数和 base 对不上
  const mismatch = makeMesh();
  const mismatchTargets = mismatch.geometry.morphAttributes.position;
  mismatchTargets[1] = makeAttr(VERTEX_COUNT - 1);
  assert.equal(createSparseMorphController(mismatch), null);
  assert.equal(mismatch.geometry.morphAttributes.position, mismatchTargets, 'dense 通道不能被删');
});
