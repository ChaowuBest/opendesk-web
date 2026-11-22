import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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

/** 拼一个合法的 PNG chunk（length + type + data + CRC32） */
function pngChunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBytes = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBytes, data])) >>> 0, 0);
    return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * 手写 store 级 PNG（IDAT 用 zlib level 0）：模拟 Electron capturePage 默认压缩
 * 产出的大截图——体积大、内容可压（平滑渐变）。jimp 的 compressionLevel 选项不
 * 生效，因此这里不用 jimp 生成 fixture，而是直接构造可压缩的大 PNG。
 */
function buildLargeStoreCompressedPng(): string {
    const width = 800;
    const height = 600;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type: RGB
    const rowStride = 1 + width * 3;
    const rows = Buffer.alloc(rowStride * height);
    for (let y = 0; y < height; y++) {
        const base = y * rowStride;
        rows[base] = 0; // filter: none
        for (let x = 0; x < width; x++) {
            const i = base + 1 + x * 3;
            // 平滑渐变：重复度高、重新编码的压缩收益明显
            rows[i] = (x >> 2) & 0xff;
            rows[i + 1] = (y >> 2) & 0xff;
            rows[i + 2] = 0x80;
        }
    }
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(rows, { level: 0 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
    return `data:image/png;base64,${png.toString('base64')}`;
}

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
        // 小截图（< 重编码阈值）保持原始字节不动
        expect(fs.readFileSync(parsed.path).toString('base64')).toBe(PNG_BASE64);
    });

    test('大截图落盘前重编码为更高压缩的 PNG，图像内容保持不变', async () => {
        const dataUri = buildLargeStoreCompressedPng();
        const originalBytes = Buffer.from(dataUri.split(',')[1], 'base64');
        // fixture 必须超过重编码阈值才能覆盖压缩路径
        expect(originalBytes.length).toBeGreaterThan(64 * 1024);

        const { ctrl } = fakeController({ dataUri });
        const spy = jest.spyOn(BrowserManager, 'getOrCreateController').mockReturnValue(ctrl);
        restoreController = () => spy.mockRestore();

        const output = await runTool(new BrowserScreenshotTool(browserApp), {});
        const parsed = JSON.parse(output);
        expect(parsed.success).toBe(true);

        const saved = fs.readFileSync(parsed.path);
        // 内容仍是合法 PNG（签名 + 可解码），且体积显著小于原始 store 级字节
        expect(saved.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        expect(saved.length).toBeLessThan(originalBytes.length);
        // IHDR 宽高不变（重编码不缩放图像；IHDR 数据位于签名 8B + length 4B + type 4B 之后）
        expect(saved.readUInt32BE(16)).toBe(800);
        expect(saved.readUInt32BE(20)).toBe(600);
        // 首次调用会惰性加载 jimp 模块，放宽超时（默认 5s 在并行全量跑批下不够）
    }, 30000);

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
