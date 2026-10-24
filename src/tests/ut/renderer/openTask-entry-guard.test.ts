// 回归：openTask 是所有打开任务路径的单一入口（侧边栏/主页/iframe/主进程命令等），
// 入口必须拦截非法 taskId（undefined 序列化成的字符串 "undefined"、空串、非字符串类型），
// 统一回退到主页语义，避免其创建 task_id 非法的 task-view 后 getFullTask 报
// "task undefined not found" 卡白屏（主页首条消息 bug 的同类防御）。
// 测试参照 startup-shell.test.ts：vm 抽取 index.html 内联脚本，注入最小宿主桩。
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const rendererHtml = readFileSync(new URL('../../../renderer/index.html', import.meta.url), 'utf8');

function sourceBetween(source: string, start: string, end: string): string {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    return source.slice(startIndex, endIndex);
}

function makeElementStub(tag: string, createdViews: any[]): any {
    const el: any = {
        tagName: tag,
        style: { cssText: '' },
        attributes: {} as Record<string, string>,
        setAttribute(name: string, value: string) {
            this.attributes[name] = String(value);
        },
        removeAttribute(name: string) {
            delete this.attributes[name];
        },
        getAttribute(name: string) {
            return this.attributes[name] ?? null;
        },
        hasAttribute(name: string) {
            return name in this.attributes;
        },
        listeners: {} as Record<string, (ev?: unknown) => void>,
        addEventListener(name: string, fn: (ev?: unknown) => void) {
            (this.listeners[name] ||= []).push(fn);
            // content-loading-view 等待 task-view 的首屏就绪信号；桩视图直接就绪，
            // 让 openTask 的 await contentReady 立即通过
            if (name === 'task-view-content-ready') fn();
        },
        removeEventListener() {},
        appendChild() {},
        remove() {}
    };
    if (tag === 'task-view') {
        el.markViewShown = () => undefined;
        createdViews.push(el);
    }
    return el;
}

function makeShell(createdViews: any[], errors: string[]): vm.Context {
    const document: any = Object.assign(new EventTarget(), {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: (tag: string) => makeElementStub(tag, createdViews)
    });
    const shell = vm.createContext({
        document,
        console: { error: (msg: string) => errors.push(msg) },
        setTimeout,
        clearTimeout,
        Date,
        Promise,
        Object,
        CustomEvent,
        window: {
            applicationRegistryAPI: {
                ensureFullyLoaded: async () => undefined,
                call: async () => undefined
            }
        }
    });
    vm.runInContext(
        `
        var nonAppSlot = { appendChild() {}, style: { display: '' }, parentElement: null };
        var appFramesContainer = { style: { display: '' } };
        var taskViewCache = {};
        var taskViewLastAccess = {};
        var currentNonAppContent = '';
        var currentOpenAppBundleName = null;
        function ensureSlots() {}
        function hideAllNonAppChildren() {}
        function clearNonTaskContent() {}
        function closeAllEditorOverlays() {}
        function showNonApp() {}
        function sweepExcessTaskViews() {}
        function openHomePage() {}
        `,
        shell
    );
    vm.runInContext(
        sourceBetween(rendererHtml, 'async function openTask(taskId) {', 'async function needsWizard() {'),
        shell
    );
    return shell;
}

describe('index.html openTask entry guard', () => {
    test('非法 taskId（undefined 字符串/空串/非字符串）不创建 task-view，并记录错误', async () => {
        for (const bad of ['undefined', '', 123, undefined]) {
            const createdViews: any[] = [];
            const errors: string[] = [];
            const shell = makeShell(createdViews, errors);

            await (shell as any).openTask(bad);

            expect(createdViews).toHaveLength(0);
            // 非 null 的非法值必须在入口报错，便于调用方定位传参 bug
            expect(errors.length).toBeGreaterThan(0);
        }
    });

    test('null 仍是合法的主页语义，不报错也不创建 task-view', async () => {
        const createdViews: any[] = [];
        const errors: string[] = [];
        const shell = makeShell(createdViews, errors);

        await (shell as any).openTask(null);

        expect(createdViews).toHaveLength(0);
        expect(errors).toHaveLength(0);
    });

    test('合法 taskId 正常创建 task-view 并写入 task_id 与缓存', async () => {
        const createdViews: any[] = [];
        const errors: string[] = [];
        const shell = makeShell(createdViews, errors);

        await (shell as any).openTask('task_real_1');
        await (shell as any).openTask('task_real_2');

        expect(createdViews).toHaveLength(2);
        expect(createdViews[0].attributes['task_id']).toBe('task_real_1');
        expect(createdViews[1].attributes['task_id']).toBe('task_real_2');
        const cacheKeys: string[] = JSON.parse(
            (await vm.runInContext('JSON.stringify(Object.keys(taskViewCache))', shell)) as string
        );
        expect(cacheKeys).toEqual(['task_real_1', 'task_real_2']);
        expect(errors).toHaveLength(0);
    });
});
