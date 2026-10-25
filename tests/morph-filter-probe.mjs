// 只读探针：用现有 mmdparser 看看真实 PMX 里有多少 morph、名字是什么。
// 不写文件、不加载纹理、不碰 DOM。
import fs from 'node:fs';
import path from 'node:path';
import { MMDParser } from '../app/lib/examples/jsm/libs/mmdparser.module.js';

const root = path.resolve(import.meta.dirname, '..');

function findPmx(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) findPmx(p, out);
		else if (e.name.toLowerCase().endsWith('.pmx')) out.push(p);
	}
	return out;
}

for (const p of findPmx(path.join(root, 'model'))) {
	const buf = fs.readFileSync(p);
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	const data = new MMDParser().parsePmx(ab, true);
	const types = {};
	for (const m of data.morphs) types[m.type] = (types[m.type] || 0) + 1;
	const groups = data.morphs.filter((m) => m.type === 0).map((m) => m.name);
	console.log(JSON.stringify({
		file: path.basename(p),
		morphCount: data.metadata.morphCount,
		vertexCount: data.metadata.vertexCount,
		typesByType: types,
		groupNames: groups,
		names: data.morphs.map((m) => m.name),
	}, null, 1));
}
