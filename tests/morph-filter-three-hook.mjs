// Node 侧解析裸导入 'three'：项目没有 npm 安装 three（用的是 app/lib/three.module.js）。
// 这个 hook 只在测试进程里把 'three' 指到本地那份，不改 node_modules、不改业务代码。
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const THREE_URL = pathToFileURL(
	path.resolve(import.meta.dirname, '..', 'app', 'lib', 'three.module.js')
).href;

export function resolve(specifier, context, nextResolve) {
	if (specifier === 'three') {
		return { url: THREE_URL, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
