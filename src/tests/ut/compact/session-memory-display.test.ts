import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs, { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as memory from '../../../main/aikernel/compaction/session-memory-compact.js';
import { parseMarkdownSafe } from '../../../main/aikernel/messages.js';
import { getTaskSessionMemoryPath } from '../../../main/utils/setting.js';

type RenderCache = Map<string, { content: string; rendered: string }>;
const taskId = 'shared-session-memory-display';
const source = ts.createSourceFile(
    'main.ts',
    readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
);

function loadElectronHandler(cache: RenderCache) {
    let handler: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (
            ts.isCallExpression(node) &&
            node.expression.getText(source) === 'ipcMain.handle' &&
            ts.isStringLiteral(node.arguments[0]) &&
            node.arguments[0].text === 'taskManager:getSessionMemory'
        ) {
            handler = node.arguments[1];
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    expect(handler).toBeDefined();
    return runInNewContext(
        ts.transpileModule(`(${handler!.getText(source)})`, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 }
        }).outputText,
        {
            ...memory,
            parseMarkdownSafe,
            sessionMemoryRenderCache: cache
        }
    ) as (_event: object, taskId: string) => Promise<unknown>;
}

describe('shared session memory display', () => {
    let cache: RenderCache;

    beforeEach(() => {
        cache = new Map();
    });

    afterEach(async () => {
        await fs.promises.rm(getTaskSessionMemoryPath(taskId, false), { force: true });
    });

    test('missing files release only the requested task cache', async () => {
        cache.set(taskId, { content: 'old', rendered: 'old' });
        cache.set('other-task', { content: 'other', rendered: 'other' });

        expect(await memory.readTaskSessionMemoryForDisplay(taskId, cache)).toBeNull();
        expect(cache.has(taskId)).toBe(false);
        expect(cache.has('other-task')).toBe(true);
    });

    test('real memory renders once and reuses the host-owned cache when unchanged', async () => {
        const content = '# 会话结论\n\n保留 **中文** 与 emoji 📝';
        await memory.writeTaskSessionMemory(taskId, content);

        const first = await memory.readTaskSessionMemoryForDisplay(taskId, cache);
        expect(first?.raw).toBe(content);
        expect(first?.rendered).toContain('<strong>中文</strong>');
        expect(cache.get(taskId)?.content).toBe(content);
        cache.set(taskId, { content, rendered: '<p>cached-render</p>' });

        expect(await memory.readTaskSessionMemoryForDisplay(taskId, cache)).toEqual({
            raw: content,
            rendered: '<p>cached-render</p>'
        });
    });

    test('changed content replaces the render cache', async () => {
        cache.set(taskId, { content: 'old', rendered: 'old' });
        await memory.writeTaskSessionMemory(taskId, '# Updated\n\nNew decision.');

        const result = await memory.readTaskSessionMemoryForDisplay(taskId, cache);
        expect(result?.raw).toContain('New decision.');
        expect(result?.rendered).toContain('<h1>Updated</h1>');
        expect(cache.get(taskId)?.rendered).toBe(result?.rendered);
    });

    test.each(['', memory.DEFAULT_SESSION_MEMORY_TEMPLATE])(
        'empty or template content releases stale rendering',
        async (content) => {
            cache.set(taskId, { content: 'old conclusion', rendered: '<p>old conclusion</p>' });
            await memory.writeTaskSessionMemory(taskId, content);

            expect(await memory.readTaskSessionMemoryForDisplay(taskId, cache)).toBeNull();
            expect(cache.has(taskId)).toBe(false);
        }
    );

    test('the actual Electron handler shares display and invalidation behavior', async () => {
        const invoke = loadElectronHandler(cache);
        await memory.writeTaskSessionMemory(taskId, '# Actual handler\n\nShared result.');
        const response = JSON.parse(JSON.stringify(await invoke({}, taskId)));
        expect(response.status).toBe('ok');
        expect(response.data.raw).toContain('Shared result.');
        expect(cache.has(taskId)).toBe(true);

        await memory.writeTaskSessionMemory(taskId, memory.DEFAULT_SESSION_MEMORY_TEMPLATE);
        expect(await invoke({}, taskId)).toEqual({ status: 'ok', data: null });
        expect(cache.has(taskId)).toBe(false);
    });
});
