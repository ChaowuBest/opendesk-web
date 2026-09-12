import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserManager } from '../../../common/embedBrowserUse/main.js';
import { BrowserScreenshotTool } from '../../../main/applications/browser/tools.js';
import { getTaskArtifactDirectory, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

/** 1x1 红色像素的合法 PNG */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 最小 BrowserController 替身：只实现 screenshot 链路真正用到的方法 */
function fakeController(options: { dataUri?: string; captureError?: Error }) {
    const calls = { switched: [] as number[], captured: 0 };
    const ctrl = {
        tabs: async (action: string, tabId?: number) => {
            if (action === 'switch' && tabId !== undefined) calls.switched.push(tabId);
            return {};
        },
        getPageInfo: async () => ({ url: 'https://example.com/page', title: 'Example' }),
        captureScreenshot: async () => {
            calls.captured += 1;
            if (options.captureError) throw options.captureError;
            return options.dataUri ?? `data:image/png;base64,${PNG_BASE64}`;
        }
    } as any;
    return { ctrl, calls };
}

const taskState = { task_id: 'task-shot' } as any;
const browserApp = {} as any;

/** 执行工具并取回其字符串结果（BaseTool.execute 返回 ToolResult 包装） */
async function runTool(
    tool: { execute(args: any, callback: undefined, taskState: unknown): Promise<{ result: string }> },
    args: unknown
): Promise<string> {
    const result = await tool.execute(args, undefined, taskState);
    return result.result;
}

describe('browser screenshot 工具', () => {
    let tempDir: string;
    let restoreController: () => void;

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-screenshot-test-'));
        setCustomOpendeskDirectory(tempDir);
    });

    afterAll(() => {
        restoreController?.();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('默认截取当前活动标签页，保存到任务 artifacts 目录并返回路径', async () => {
        const { ctrl, calls } = fakeController({});
        const spy = jest.spyOn(BrowserManager, 'getOrCreateController').mockReturnValue(ctrl);
        restoreController = () => spy.mockRestore();

        const output = await runTool(new BrowserScreenshotTool(browserApp), {});

        const parsed = JSON.parse(output);
        expect(parsed.success).toBe(true);
        expect(parsed.url).toBe('https://example.com/page');
        expect(parsed.title).toBe('Example');
        // 未指定 tabId 时不应切换标签页
        expect(calls.switched).toEqual([]);
        expect(calls.captured).toBe(1);

        // 文件落在任务的 artifacts 目录，内容与截图数据一致
        const artifactDir = getTaskArtifactDirectory(taskState.task_id, false);
        expect(path.dirname(parsed.path)).toBe(artifactDir);
        expect(path.basename(parsed.path)).toMatch(/^screenshot-.*\.png$/);
        expect(fs.existsSync(parsed.path)).toBe(true);
        expect(fs.readFileSync(parsed.path).toString('base64')).toBe(PNG_BASE64);
    });

    test('指定 tabId 时先切换标签页再截图', async () => {
        const { ctrl, calls } = fakeController({});
        const spy = jest.spyOn(BrowserManager, 'getOrCreateController').mockReturnValue(ctrl);
        restoreController = () => spy.mockRestore();

        const output = await runTool(new BrowserScreenshotTool(browserApp), { tabId: 7 });

        const parsed = JSON.parse(output);
        expect(parsed.success).toBe(true);
        expect(parsed.tabId).toBe(7);
        expect(calls.switched).toEqual([7]);
        expect(calls.captured).toBe(1);
    });

    test('截图失败时返回 success:false 与错误信息', async () => {
        const { ctrl, calls } = fakeController({ captureError: new Error('Empty capture') });
        const spy = jest.spyOn(BrowserManager, 'getOrCreateController').mockReturnValue(ctrl);
        restoreController = () => spy.mockRestore();

        const artifactDir = getTaskArtifactDirectory(taskState.task_id, false);
        const countBefore = fs.existsSync(artifactDir)
            ? fs.readdirSync(artifactDir).filter((name) => name.startsWith('screenshot-')).length
            : 0;

        const output = await runTool(new BrowserScreenshotTool(browserApp), {});

        expect(JSON.parse(output)).toEqual({ success: false, error: 'Empty capture' });
        // 失败时不应新增截图文件
        const countAfter = fs.existsSync(artifactDir)
            ? fs.readdirSync(artifactDir).filter((name) => name.startsWith('screenshot-')).length
            : 0;
        expect(countAfter).toBe(countBefore);
    });

    test('返回数据不是图片 data URI 时判定为失败', async () => {
        const { ctrl } = fakeController({ dataUri: 'data:text/plain;base64,aGVsbG8=' });
        const spy = jest.spyOn(BrowserManager, 'getOrCreateController').mockReturnValue(ctrl);
        restoreController = () => spy.mockRestore();

        const output = await runTool(new BrowserScreenshotTool(browserApp), {});

        const parsed = JSON.parse(output);
        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('data URI');
    });
});
