// MMDLoader morph 白名单（前置过滤）测试
//
// 覆盖：
//   1. 默认不传白名单 → 全部 morph 照旧生成（加载器默认行为兼容）
//   2. 白名单 → 只生成白名单里的 morph，且数值与默认构建逐字节一致
//   3. 空白名单 → 0 个 morph，主体几何仍在
//   4. 未知名字 → 0 个 morph，不抛错
//   5. group morph 仍按原始 data.morphs 索引取成员，且原始解析结果不被改写
//
// 数据：仓库里的真实 PMX（红/蓝两套），只用现有 mmdparser 只读解析，不加载纹理、不碰 DOM。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';

register('./morph-filter-three-hook.mjs', import.meta.url);

const { MMDLoader, GeometryBuilder } = await import('../app/lib/examples/jsm/loaders/MMDLoader.js');
const { MMDParser } = await import('../app/lib/examples/jsm/libs/mmdparser.module.js');

const ROOT = path.resolve(import.meta.dirname, '..');

// app/main.js 里实际使用的 16 个 morph 名
const APP_WHITELIST = [
	'まばたき', 'left', 'right', 'up', 'down',
	'あ', 'い', 'う', 'え', 'お',
	'口', 'にこり', '笑い', '照れ', 'びっくり', '笑い目',
];

function findPmx(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) findPmx(p, out);
		else if (e.name.toLowerCase().endsWith('.pmx')) out.push(p);
	}
	return out;
}

function readPmx(file) {
	const buf = fs.readFileSync(file);
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	return new MMDParser.Parser().parsePmx(ab, true);
}

function snapshotMorphs(data) {
	return data.morphs.map((m) => ({
		name: m.name,
		type: m.type,
		elements: m.elements.map((e) => ({ index: e.index, ratio: e.ratio })),
	}));
}

// ── 加载器 API：显式 opt-in，默认保持兼容 ────────────────────────────
{
	const loader = new MMDLoader();
	assert.equal(loader.morphWhitelist, null, '默认不应有白名单（保持旧行为）');
	assert.equal(loader.setMorphWhitelist([ 'a', 'b' ]), loader, 'setMorphWhitelist 应返回 this');
	assert.ok(loader.morphWhitelist instanceof Set);
	assert.equal(loader.morphWhitelist.size, 2);
	loader.setMorphWhitelist(null);
	assert.equal(loader.morphWhitelist, null, '传 null 应回到不过滤');
	loader.setMorphWhitelist(undefined);
	assert.equal(loader.morphWhitelist, null);
	console.log('✓ MMDLoader API：默认 null，显式 opt-in 生效');
}

const models = findPmx(path.join(ROOT, 'model'));
assert.ok(models.length > 0, 'model 目录下应至少有一个 PMX');

for (const file of models) {
	const tag = path.basename(file);
	const data = readPmx(file);
	const names = data.morphs.map((m) => m.name);
	const vc = data.metadata.vertexCount;
	const gb = new GeometryBuilder();

	// ── 1. 默认：全部 morph ───────────────────────────────────────────
	const full = gb.build(data);
	assert.equal(full.morphTargets.length, data.metadata.morphCount, '默认应生成全部 morph');
	assert.equal(full.morphAttributes.position.length, data.metadata.morphCount);
	assert.deepEqual(full.morphTargets.map((t) => t.name), names, '默认顺序应与原始 morph 一致');
	for (const a of full.morphAttributes.position) {
		assert.equal(a.array.length, vc * 3, '每个 morph attribute 应为 vertexCount*3');
	}
	const fullStats = full.userData.MMD.morphStats;
	assert.equal(fullStats.sourceMorphCount, data.metadata.morphCount);
	assert.equal(fullStats.generatedMorphCount, data.metadata.morphCount);
	assert.equal(fullStats.filteredMorphCount, 0);
	assert.equal(fullStats.sourceBytes, data.metadata.morphCount * vc * 3 * 4);
	assert.equal(fullStats.generatedBytes, data.metadata.morphCount * vc * 3 * 4);

	const fullByName = new Map(full.morphTargets.map((t, i) => [ t.name, full.morphAttributes.position[ i ] ]));

	// ── 2. 白名单：只生成白名单里的 ───────────────────────────────────
	const before = snapshotMorphs(data);
	const kept = gb.build(data, new Set(APP_WHITELIST));
	const keptNames = kept.morphTargets.map((t) => t.name);
	assert.deepEqual(keptNames, names.filter((n) => APP_WHITELIST.includes(n)), '白名单结果应保持原始顺序');
	assert.ok(keptNames.length <= APP_WHITELIST.length);
	assert.equal(kept.morphAttributes.position.length, keptNames.length);
	assert.deepEqual(snapshotMorphs(data), before, '过滤不得改写原始 data.morphs');

	// 数值与默认构建完全一致（只是少了 morph，不是重算）
	for (let i = 0; i < kept.morphTargets.length; i ++) {
		const a = kept.morphAttributes.position[ i ].array;
		const b = fullByName.get(keptNames[ i ]).array;
		assert.equal(a.length, b.length);
		assert.deepEqual(a, b, `morph「${keptNames[ i ]}」的 attribute 应与默认构建一致`);
	}

	const keptStats = kept.userData.MMD.morphStats;
	assert.equal(keptStats.sourceMorphCount, data.metadata.morphCount);
	assert.equal(keptStats.generatedMorphCount, keptNames.length);
	assert.equal(keptStats.filteredMorphCount, data.metadata.morphCount - keptNames.length);
	assert.equal(keptStats.sourceBytes, data.metadata.morphCount * vc * 3 * 4);
	assert.equal(keptStats.generatedBytes, keptNames.length * vc * 3 * 4);
	assert.ok(keptStats.generatedBytes < keptStats.sourceBytes, '白名单后字节数应下降');

	// ── 2b. 白名单恰好 16 个 → 只生成 16 个 ──────────────────────────
	const first16 = names.slice(0, 16);
	assert.equal(first16.length, 16, '模型应至少有 16 个 morph');
	const sixteen = gb.build(data, new Set(first16));
	assert.equal(sixteen.morphTargets.length, 16, '16 个名字的白名单应只生成 16 个 morph');
	assert.equal(sixteen.morphAttributes.position.length, 16);
	assert.deepEqual(sixteen.morphTargets.map((t) => t.name), first16);
	assert.equal(sixteen.userData.MMD.morphStats.generatedMorphCount, 16);

	// ── 3. 空白名单 → 0 个 ────────────────────────────────────────────
	const empty = gb.build(data, new Set());
	assert.equal(empty.morphTargets.length, 0, '空白名单不应生成 morph');
	assert.equal(empty.morphAttributes.position.length, 0);
	assert.equal(empty.attributes.position.count, vc, '主体顶点不受影响');
	assert.equal(empty.userData.MMD.morphStats.generatedMorphCount, 0);
	assert.equal(empty.userData.MMD.morphStats.filteredMorphCount, data.metadata.morphCount);

	// ── 4. 未知名字 → 0 个且不抛错 ────────────────────────────────────
	const unknown = gb.build(data, new Set([ '__no_such_morph__', 'ZZZ_UNKNOWN' ]));
	assert.equal(unknown.morphTargets.length, 0, '未知名字不应生成 morph');

	// ── 5. group morph：仍按原始 data.morphs 索引取成员 ───────────────
	const groupIdx = data.morphs.map((m, i) => (m.type === 0 ? i : - 1)).filter((i) => i >= 0);
	if (groupIdx.length > 0) {
		const groupNames = groupIdx.map((i) => names[ i ]);
		const gOnly = gb.build(data, new Set(groupNames));
		assert.equal(gOnly.morphTargets.length, groupNames.length);
		for (let i = 0; i < gOnly.morphTargets.length; i ++) {
			const a = gOnly.morphAttributes.position[ i ].array;
			const b = fullByName.get(groupNames[ i ]).array;
			assert.deepEqual(a, b, `group morph「${groupNames[ i ]}」应与默认构建一致`);
		}
		// group 的成员索引仍指向原始数组
		for (const gi of groupIdx) {
			for (const el of data.morphs[ gi ].elements) {
				assert.ok(el.index >= 0 && el.index < data.morphs.length, 'group 成员索引应仍在原始范围内');
				assert.equal(data.morphs[ el.index ].name, data.morphs[ el.index ].name);
			}
		}
		console.log(`  · group morph ${groupIdx.length} 个：成员索引与数值均未变`);
	}

	// ── 统计输出（验收用）──────────────────────────────────────────────
	const appPresent = APP_WHITELIST.filter((n) => names.includes(n));
	console.log(`✓ ${tag}`);
	console.log(`   morph ${data.metadata.morphCount} → ${keptNames.length} 个；顶点 ${vc}；`
		+ `${(keptStats.sourceBytes / 1048576).toFixed(1)}MB → ${(keptStats.generatedBytes / 1048576).toFixed(1)}MB`);
	console.log(`   app 白名单 16 个名字在此模型命中 ${appPresent.length} 个`
		+ (appPresent.length === APP_WHITELIST.length ? '' : `（未命中：${APP_WHITELIST.filter((n) => !names.includes(n)).join(',')}）`));
}

console.log('\n全部 morph 过滤测试通过 ✅');
