import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { runPluginChatHeaders } from '../../../main/applications/pluginmgr/runtime/hooks.js';

const PLUGIN_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../resources/plugins/opencodego'
);

async function activatePlugin(): Promise<void> {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'opendesk.plugin.json'), 'utf-8')) as {
        id: string;
        entry: string;
    };
    const entryUrl = `${pathToFileURL(path.join(PLUGIN_DIR, manifest.entry)).href}?ts=${Date.now()}`;
    const mod = (await import(entryUrl)) as { default: unknown };
    await getPluginHost().activate(mod.default as any, { origin: `test:${manifest.id}` });
}

const SESSION_PATTERN = /^ses_[0-9a-f]{64}$/;

describe('opencodego 插件 chat.headers', () => {
    beforeEach(async () => {
        await getPluginHost().dispose();
    });

    afterEach(async () => {
        await getPluginHost().dispose();
    });

    test('Zen 端点注入 x-opencode-session 与 x-opencode-client', async () => {
        await activatePlugin();

        const headers = await runPluginChatHeaders({
            model: { provider: { baseUrl: 'https://opencode.ai/zen/go/v1' } }
        });
        expect(headers['x-opencode-session']).toMatch(SESSION_PATTERN);
        expect(headers['x-opencode-client']).toBe('opendesk');
    });

    test('调用方已提供会话头时不覆盖', async () => {
        await activatePlugin();

        const headers = await runPluginChatHeaders(
            { model: { provider: { baseUrl: 'https://opencode.ai/zen/go/v1' } } },
            { 'x-opencode-session': 'ses_' + crypto.randomBytes(32).toString('hex') }
        );
        expect(headers['x-opencode-session']).toMatch(SESSION_PATTERN);
    });

    test('非 Zen 端点不注入任何头', async () => {
        await activatePlugin();

        const headers = await runPluginChatHeaders({ model: { provider: { baseUrl: 'https://api.openai.com/v1' } } });
        expect(headers).toEqual({});
    });

    test('子域 opencode.ai 同样匹配', async () => {
        await activatePlugin();

        const headers = await runPluginChatHeaders({ model: { provider: { baseUrl: 'https://zen.opencode.ai/v1' } } });
        expect(headers['x-opencode-session']).toMatch(SESSION_PATTERN);
    });

    test('非法 base_url 安全跳过', async () => {
        await activatePlugin();

        const headers = await runPluginChatHeaders({ model: { provider: { baseUrl: '::not-a-url' } } });
        expect(headers).toEqual({});
    });

    test('相同 taskId 派生稳定会话 ID', async () => {
        await activatePlugin();

        const input = {
            taskId: 'task_mvfq7hjb_5gv3',
            model: { provider: { baseUrl: 'https://opencode.ai/zen/go/v1' } }
        };
        const first = await runPluginChatHeaders(input);
        const second = await runPluginChatHeaders(input);
        expect(first['x-opencode-session']).toMatch(SESSION_PATTERN);
        expect(second['x-opencode-session']).toBe(first['x-opencode-session']);
    });

    test('不同 taskId 派生不同会话 ID', async () => {
        await activatePlugin();

        const zen = { model: { provider: { baseUrl: 'https://opencode.ai/zen/go/v1' } } };
        const first = await runPluginChatHeaders({ ...zen, taskId: 'task_aaaa' });
        const second = await runPluginChatHeaders({ ...zen, taskId: 'task_bbbb' });
        expect(first['x-opencode-session']).not.toBe(second['x-opencode-session']);
    });

    test('无 taskId 时随机生成会话 ID', async () => {
        await activatePlugin();

        const first = await runPluginChatHeaders({ model: { provider: { baseUrl: 'https://opencode.ai/zen/go/v1' } } });
        const second = await runPluginChatHeaders({
            model: { provider: { baseUrl: 'https://opencode.ai/zen/go/v1' } }
        });
        expect(first['x-opencode-session']).toMatch(SESSION_PATTERN);
        expect(second['x-opencode-session']).toMatch(SESSION_PATTERN);
        expect(second['x-opencode-session']).not.toBe(first['x-opencode-session']);
    });
});
