// 稀疏表情：只保留实际修改的顶点，供现有表情权重与动画使用。
//
// 背景：three.js 的 morphTarget 默认保留 N 份**全身绝对坐标**的 Float32 属性
//       （典型 16 个 morph × 全身顶点 × 3 float），渲染端还会生成对应纹理。
//       dense 路径的纹理主要在初始化时创建，之后通过权重控制变形。
//
// 这里压成稀疏形式：预计算时逐目标 / 顶点比较 target 与 base，只记下**有变化
// 的顶点**（Uint32 索引 + Float32 xyz 差值），并存下所有受影响顶点的并集
// （union）及其 base 坐标；预计算**完成后**才删掉 geometry.morphAttributes
// .position（dense 数据随之释放）并把 position 标成 DynamicDrawUsage。
// update()：权重没变就什么都不做；变了才把 union 顶点恢复成 base，再按 weight
// 累加各目标的 delta，然后置 position.needsUpdate。
//
// 前提（不满足就返回 null，且**完全不改动原 geometry**）：position 是普通
// Float32BufferAttribute（itemSize 3，不能 interleaved）；morphAttributes
// .position 是 Float32 属性数组且顶点数一致；没有其它 morph 通道（normal /
// color 等）。geometry.morphTargetsRelative = true 时 target 就是 delta。
//
// 导出：createSparseMorphController(mesh) → { update, stats } | null

const DYNAMIC_DRAW_USAGE = 35048;   // THREE.DynamicDrawUsage
const ITEM_SIZE = 3;

// ── 前置校验：普通 Float32 属性（不是 interleaved）──────────────────────
function isPlainFloatAttr(attr, expectCount) {
  if (!attr || typeof attr !== 'object') return false;
  if (attr.isInterleavedBufferAttribute === true) return false;   // interleaved：没有自己的连续数组
  if (!attr.array || attr.array.constructor !== Float32Array) return false;
  if (attr.itemSize !== ITEM_SIZE) return false;
  if (attr.normalized || attr.array.length !== attr.count * ITEM_SIZE) return false;
  if (typeof attr.count === 'number' && expectCount >= 0 && attr.count !== expectCount) return false;
  return true;
}

// ── 预计算：从 dense morph 抽出稀疏数据，然后才动原 geometry ────────────
function prepare(mesh) {
  const geometry = mesh && mesh.geometry;
  if (!geometry) return null;
  const morphMap = geometry.morphAttributes;
  if (!morphMap || typeof morphMap !== 'object') return null;

  const channels = Object.keys(morphMap);
  if (channels.length === 0) return null;                       // 没有 morph
  for (const c of channels) {
    if (c !== 'position') return null;                          // 还有 normal / color 等其它通道 → 不支持
  }

  const targets = morphMap.position;
  if (!Array.isArray(targets) || targets.length === 0) return null;

  const base = geometry.attributes && geometry.attributes.position;
  if (!isPlainFloatAttr(base, -1)) return null;
  const vertexCount = base.count;
  if (!Number.isInteger(vertexCount) || vertexCount <= 0) return null;
  for (const t of targets) {
    if (!isPlainFloatAttr(t, vertexCount)) return null;
  }
  if (!Array.isArray(mesh.morphTargetInfluences) || mesh.morphTargetInfluences.length !== targets.length) return null;

  const relative = !!geometry.morphTargetsRelative;

  // 逐目标：只留「和 base 不一样」的顶点
  const mask = new Uint8Array(vertexCount);
  const sparse = [];
  for (const t of targets) {
    const ta = t.array;
    const ba = base.array;
    const indices = [];
    const deltas = [];
    for (let v = 0; v < vertexCount; v++) {
      const o = v * ITEM_SIZE;
      const dx = relative ? ta[o] : ta[o] - ba[o];
      const dy = relative ? ta[o + 1] : ta[o + 1] - ba[o + 1];
      const dz = relative ? ta[o + 2] : ta[o + 2] - ba[o + 2];
      if (dx !== 0 || dy !== 0 || dz !== 0) {
        indices.push(v);
        deltas.push(dx, dy, dz);
        mask[v] = 1;
      }
    }
    sparse.push({ indices: Uint32Array.from(indices), deltas: Float32Array.from(deltas) });
  }

  // union：所有受影响顶点 + 它们的 base 坐标（只存 union，不存整份 base）
  const unionList = [];
  for (let v = 0; v < vertexCount; v++) if (mask[v]) unionList.push(v);
  const unionIndices = Uint32Array.from(unionList);
  const unionBase = new Float32Array(unionList.length * ITEM_SIZE);
  for (let i = 0; i < unionList.length; i++) {
    const o = unionList[i] * ITEM_SIZE;
    unionBase[i * ITEM_SIZE] = base.array[o];
    unionBase[i * ITEM_SIZE + 1] = base.array[o + 1];
    unionBase[i * ITEM_SIZE + 2] = base.array[o + 2];
  }

  const denseBytes = targets.length * vertexCount * ITEM_SIZE * 4;
  let sparseBytes = unionIndices.byteLength + unionBase.byteLength;
  for (const s of sparse) sparseBytes += s.indices.byteLength + s.deltas.byteLength;

  // —— 到这里预计算全部完成，才动原 geometry ——
  delete morphMap.position;
  if (typeof base.setUsage === 'function') base.setUsage(DYNAMIC_DRAW_USAGE);

  // 只把「数据」交给控制器闭包：不再持有任何 dense morph 属性 / 数组
  return {
    posArray: base.array,
    posAttr: base,
    influences: mesh.morphTargetInfluences,
    sparse,
    unionIndices,
    unionBase,
    morphCount: targets.length,
    denseBytes,
    sparseBytes,
  };
}

// ── 控制器闭包：只认稀疏数据，不碰原 geometry 的结构 ────────────────────
function makeController(data) {
  const { posArray, posAttr, influences, sparse, unionIndices, unionBase, morphCount } = data;
  // 只上传脸部受影响区间；合并很短的间隙以减少 WebGL 调用。
  const uploadRanges = [];
  for (const vertex of unionIndices) {
    const lastRange = uploadRanges[uploadRanges.length - 1];
    if (lastRange && vertex * 3 <= lastRange.start + lastRange.count + 32 * 3) {
      lastRange.count = vertex * 3 + 3 - lastRange.start;
    } else uploadRanges.push({ start: vertex * 3, count: 3 });
  }
  // 权重本身是 JS double；用 Float32 缓存会让 0.1 等静止权重也反复变脏。
  const last = new Float64Array(morphCount);
  let applied = false;
  const weightAt = (w, i) => Number.isFinite(Number(w[i])) ? Number(w[i]) : 0;

  function sameWeights(w) {
    for (let i = 0; i < morphCount; i++) {
      if (weightAt(w, i) !== last[i]) return false;
    }
    return true;
  }

  // weights 省略时用 mesh.morphTargetInfluences（实时读，原数组不被改写）
  function update(weights) {
    const w = (weights && weights.length) ? weights : (influences || []);
    if (applied && sameWeights(w)) return false;   // 权重没变 → 什么都不做

    // 1) 把 union 顶点恢复成 base 坐标
    for (let i = 0; i < unionIndices.length; i++) {
      const o = unionIndices[i] * ITEM_SIZE;
      const s = i * ITEM_SIZE;
      posArray[o] = unionBase[s];
      posArray[o + 1] = unionBase[s + 1];
      posArray[o + 2] = unionBase[s + 2];
    }

    // 2) 累加每个目标的 weight * delta（负权重、和 > 1 都照算）
    for (let t = 0; t < morphCount; t++) {
      const weight = weightAt(w, t);
      if (weight === 0) continue;
      const idx = sparse[t].indices;
      const del = sparse[t].deltas;
      for (let k = 0; k < idx.length; k++) {
        const o = idx[k] * ITEM_SIZE;
        const d = k * ITEM_SIZE;
        posArray[o] += weight * del[d];
        posArray[o + 1] += weight * del[d + 1];
        posArray[o + 2] += weight * del[d + 2];
      }
    }

    for (let i = 0; i < morphCount; i++) last[i] = weightAt(w, i);
    applied = true;
    if (typeof posAttr.clearUpdateRanges === 'function' && typeof posAttr.addUpdateRange === 'function') {
      posAttr.clearUpdateRanges();
      for (const range of uploadRanges) posAttr.addUpdateRange(range.start, range.count);
    }
    posAttr.needsUpdate = true;
    return true;
  }

  const stats = {
    mode: 'sparse',
    affectedVertices: unionIndices.length,
    morphCount,
    denseBytes: data.denseBytes,
    sparseBytes: data.sparseBytes + last.byteLength,
    uploadRanges: uploadRanges.length,
    uploadBytes: uploadRanges.reduce((n, range) => n + range.count * 4, 0),
  };

  return { update, stats };
}

// ── 对外入口 ────────────────────────────────────────────────────────────
export function createSparseMorphController(mesh) {
  const data = prepare(mesh);
  return data ? makeController(data) : null;
}
export { DYNAMIC_DRAW_USAGE };
