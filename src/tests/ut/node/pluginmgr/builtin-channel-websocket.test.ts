import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

async function readPluginFile(relativePath: string): Promise<string> {
    return readFile(path.join(projectRoot, 'resources/plugins', relativePath), 'utf8');
}

/**
 * Node 的全局 WebSocket 由 undici 提供，而 OpenHarmony 版 Electron 主进程无法加载 undici
 * （见 src/platforms/electron.ts 中的说明）。渠道插件的长连接必须走 ws 包，与 devicemgr
 * 网关保持同一套跨平台实现，否则插件在鸿蒙端会连不上并陷入重连退避。
 */
test('飞书插件通过 ws 包建立长连接，不依赖 undici 支撑的全局 WebSocket', async () => {
    const source = await readPluginFile('feishu/feishu.mjs');

    assert.match(source, /^import WebSocket from 'ws';$/m, '应显式 import ws，而不是使用全局 WebSocket');
    // 去掉注释后不应再出现裸用的全局 WebSocket 名（import 绑定后的引用都指向 ws）
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/globalThis\.WebSocket|window\.WebSocket/.test(codeOnly), false);
});

test('飞书插件把 ws 声明为运行时依赖', async () => {
    const packageJson = JSON.parse(await readPluginFile('feishu/package.json')) as {
        dependencies?: Record<string, string>;
    };

    assert.ok(packageJson.dependencies?.ws, 'ws 必须出现在 dependencies 中，否则构建时不会安装、bundle 无法内联');
});
