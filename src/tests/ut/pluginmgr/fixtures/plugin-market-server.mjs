/**
 * 伪造的插件市场（registry），用于在本地把「插件中心 → 插件市场」整条链路跑起来。
 *
 * 用法（在仓库根目录）：
 *   node src/tests/ut/node/pluginmgr/fixtures/plugin-market-server.mjs [port]
 *
 * 启动后会打印清单地址，例如：
 *   http://127.0.0.1:8317/category/plugins.json
 *
 * 三种接入方式：
 * 1. 环境变量覆盖官方市场（推荐手动验证时用）：
 *      OPENDESK_PLUGIN_CATEGORY=http://127.0.0.1:8317/category/plugins.json npm run start
 * 2. 设置 → 插件渠道 → 添加插件渠道，地址填上面的清单地址；
 * 3. 单元 / 端到端测试见同目录的 ../market-registry-e2e.test.ts（自带服务器，不依赖本脚本）。
 *
 * 提供的插件包都是可直接安装的最小插件（index.js 里只有一个空 setup）。
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const DEFAULT_PORT = 8317;

/** 市场自述的分类：插件卡片上的 category 与这里的取值对应 */
const CATEGORIES = ['鸿蒙PC兼容', '开发工具', '效率'];

/** 演示插件：category 决定它出现在哪个分类下，未声明的只出现在「全部插件」 */
const PLUGINS = [
    {
        id: 'market-demo-ohos',
        displayName: { 'zh-CN': '鸿蒙调试助手', 'en-US': 'HarmonyOS Debug Helper' },
        description: {
            'zh-CN': '在鸿蒙设备上抓日志、看布局的一份演示插件。',
            'en-US': 'Demo plugin for HarmonyOS logs.'
        },
        category: ['鸿蒙PC兼容', '开发工具']
    },
    {
        id: 'market-demo-notes',
        displayName: { 'zh-CN': '每日速记', 'en-US': 'Daily Scratchpad' },
        description: { 'zh-CN': '把零散想法快速记成一条笔记。', 'en-US': 'Capture quick notes from your desktop.' },
        category: ['效率']
    },
    {
        id: 'market-demo-plain',
        displayName: '未分类演示插件',
        description: 'A demo plugin without any category.',
        category: []
    }
];

function buildArchive(plugin) {
    const zip = new AdmZip();
    zip.addFile(
        'package.json',
        Buffer.from(JSON.stringify({ name: plugin.id, version: '1.0.0', type: 'module' }, null, 2))
    );
    zip.addFile(
        'opendesk.plugin.json',
        Buffer.from(
            JSON.stringify({
                entry: 'index.js',
                apiVersion: 1,
                displayName: plugin.displayName,
                description: plugin.description,
                version: '1.0.0',
                capabilities: [],
                category: plugin.category
            })
        )
    );
    zip.addFile(
        'index.js',
        Buffer.from(
            [
                `export default {`,
                `    id: '${plugin.id}',`,
                `    displayName: ${JSON.stringify(plugin.displayName)},`,
                `    description: ${JSON.stringify(plugin.description)},`,
                `    version: '1.0.0',`,
                `    category: ${JSON.stringify(plugin.category)},`,
                `    async setup() { return {}; }`,
                `};`,
                ''
            ].join('\n')
        )
    );
    return zip.toBuffer();
}

function createServer() {
    const archives = new Map(PLUGINS.map((plugin) => [plugin.id, buildArchive(plugin)]));
    let baseUrl = '';

    const server = http.createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/category/plugins.json' || url.pathname === '/plugins.json') {
            const body = JSON.stringify(
                {
                    categories: CATEGORIES,
                    plugins: PLUGINS.map((plugin) => ({
                        id: plugin.id,
                        displayName: plugin.displayName,
                        description: plugin.description,
                        version: '1.0.0',
                        apiVersion: 1,
                        // 只声明当前桌面端支持的平台里的一部分，用来演示「平台不匹配不上架」
                        platforms: ['win32', 'darwin', 'linux'],
                        category: plugin.category,
                        author: {
                            name: { 'zh-CN': 'OpenDesk fixture', 'en-US': 'OpenDesk fixture' },
                            institution: { 'zh-CN': '本地测试', 'en-US': 'Local fixture' }
                        },
                        downloadUrl: `${baseUrl}/plugins/${plugin.id}-1.0.0.zip`
                    }))
                },
                null,
                2
            );
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(body);
            return;
        }
        const matched = /^\/plugins\/([a-zA-Z0-9._-]+)-1\.0\.0\.zip$/.exec(url.pathname);
        if (matched && archives.has(matched[1])) {
            const buffer = archives.get(matched[1]);
            response.writeHead(200, {
                'content-type': 'application/zip',
                // 故意给出长度，插件市场才能显示百分比进度
                'content-length': buffer.byteLength
            });
            response.end(buffer);
            return;
        }
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
    });

    server.on('listening', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        console.log(`[plugin-market-fixture] catalog: ${baseUrl}/category/plugins.json`);
        console.log(`[plugin-market-fixture] plugins: ${PLUGINS.map((plugin) => plugin.id).join(', ')}`);
    });
    return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const port = Number(process.argv[2]) || DEFAULT_PORT;
    const server = createServer();
    server.listen(port, '127.0.0.1');
}

export { createServer, CATEGORIES, PLUGINS };
