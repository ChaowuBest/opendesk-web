import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

async function readJson(relativePath: string): Promise<Record<string, any>> {
    return JSON.parse(await readFile(path.join(projectRoot, relativePath), 'utf8')) as Record<string, any>;
}

/**
 * 内置插件按裸包名 import Plugin SDK，加载的是 packages/plugin-sdk/dist 产物。
 * 该产物由独立的 rollup 构建生成，不在 electron-vite / esbuild 的编译图里，
 * 因此必须由构建脚本显式重建，否则 SDK 源码新增的导出在运行时不存在，
 * 内置插件会以 "does not provide an export named ..." 加载失败。
 */
test('内置插件构建链路会重建 Plugin SDK 产物', async () => {
    const { scripts } = await readJson('package.json');

    assert.equal(scripts['build:plugin-sdk'], 'npm --prefix packages/plugin-sdk run build');
    // build:plugins 是 start / build / build-cli 的共同前置，SDK 重建挂在它上面即可全覆盖
    assert.match(scripts['build:plugins'], /npm run build:plugin-sdk/);
    for (const entry of ['start', 'build', 'build-cli']) {
        assert.match(scripts[entry], /npm run build:plugins/, `${entry} 应经由 build:plugins 重建内置插件与 SDK`);
    }
});

test('Plugin SDK 产物导出内置插件使用的全部 browser hint 契约', async () => {
    const distIndex = await readFile(path.join(projectRoot, 'packages/plugin-sdk/dist/index.js'), 'utf8');
    const exportLine = distIndex.split('\n').find((line) => line.startsWith('export {'));
    assert.ok(exportLine, 'SDK 产物应包含具名导出列表');

    for (const name of ['definePlugin', 'tool', 'textHint', 'actionHint']) {
        assert.match(exportLine, new RegExp(`\\b${name}\\b`), `SDK 产物缺少导出 ${name}`);
    }
    assert.match(distIndex, /'browser'/, 'SDK 产物的 capability 列表缺少 browser');
});
