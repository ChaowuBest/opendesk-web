/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserManager } from '../../../common/embedBrowserUse/main.js';
import { BrowserDownloadTool } from '../../../main/applications/browser/tools.js';
import { normalizePath } from '../../../utils/path.js';

/** 构造可反复读取的 Response 替身（body 读取一次后真实 Response 会失效） */
function fakeResponse(body: Buffer, init: { status: number; contentType?: string }) {
    let readCount = 0;
    return {
        ok: init.status >= 200 && init.status < 300,
        status: init.status,
        headers: {
            get: (name: string) => (name.toLowerCase() === 'content-type' ? (init.contentType ?? null) : null)
        },
        arrayBuffer: async () => {
            readCount += 1;
            return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
        }
    } as unknown as Response;
}

const browserApp = {} as any;
/** taskState 桩：getWorkspace 返回临时目录作为相对路径基准 */
let taskState: any;

/** 执行工具并取回其字符串结果（BaseTool.execute 返回 ToolResult 包装） */
async function runTool(tool: BrowserDownloadTool, args: unknown): Promise<string> {
    const result = await tool.execute(args as any, undefined, taskState);
    return result.result;
}

describe('browser download 工具', () => {
    let tempDir: string;
    let restoreSession: () => void;

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-download-tool-test-'));
        taskState = { task_id: 'task-dl', getWorkspace: () => tempDir };
    });

    beforeEach(() => {
        const fetchSpy = jest.fn();
        const fakeSession = { fetch: fetchSpy as unknown };
        const spy = jest.spyOn(BrowserManager, 'browserSession', 'get').mockReturnValue(fakeSession as any);
        restoreSession = () => spy.mockRestore();
    });

    afterEach(() => {
        restoreSession?.();
    });

    test('下载成功：二进制内容落盘到指定完整路径并返回字节大小', async () => {
        const content = Buffer.from('attachment-bytes-123');
        const fetchSpy = jest.fn().mockResolvedValue(fakeResponse(content, { status: 200 }));
        jest.spyOn(BrowserManager, 'browserSession', 'get').mockReturnValue({ fetch: fetchSpy } as any);

        const target = path.join(tempDir, 'nested', 'file.bin');
        const output = await runTool(new BrowserDownloadTool(browserApp), {
            url: 'https://example.com/files/file.bin',
            path: target
        });

        const parsed = JSON.parse(output);
        expect(parsed.success).toBe(true);
        // 实现统一以正斜杠形式返回路径，与 path.resolve 的平台差异无关
        expect(parsed.path).toBe(normalizePath(path.resolve(target)));
        expect(parsed.size).toBe(content.length);
        // 目录不存在时自动创建
        expect(fs.existsSync(target)).toBe(true);
        expect(fs.readFileSync(target)).toEqual(content);
        // 请求经由浏览器共享 session 发出（携带登录 cookies）
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/files/file.bin');
    });

    test('非 2xx 响应报错并附带状态码，不写文件', async () => {
        const body = Buffer.from('{"error_code":401}');
        const fetchSpy = jest.fn().mockResolvedValue(fakeResponse(body, { status: 401 }));
        jest.spyOn(BrowserManager, 'browserSession', 'get').mockReturnValue({ fetch: fetchSpy } as any);

        const target = path.join(tempDir, 'missing.bin');
        const output = await runTool(new BrowserDownloadTool(browserApp), {
            url: 'https://example.com/protected.zip',
            path: target
        });

        const parsed = JSON.parse(output);
        expect(parsed.success).toBe(false);
        expect(parsed.error).toContain('401');
        expect(fs.existsSync(target)).toBe(false);
    });

    test('非法 URL（非 http/https）直接报错', async () => {
        const fetchSpy = jest.fn();
        jest.spyOn(BrowserManager, 'browserSession', 'get').mockReturnValue({ fetch: fetchSpy } as any);

        const output = await runTool(new BrowserDownloadTool(browserApp), {
            url: 'file:///etc/passwd',
            path: path.join(tempDir, 'x.bin')
        });

        const parsed = JSON.parse(output);
        expect(parsed.success).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test('path 指向已存在的目录时直接报错，不写文件', async () => {
        const fetchSpy = jest.fn().mockResolvedValue(fakeResponse(Buffer.from('x'), { status: 200 }));
        jest.spyOn(BrowserManager, 'browserSession', 'get').mockReturnValue({ fetch: fetchSpy } as any);

        const output = await runTool(new BrowserDownloadTool(browserApp), {
            url: 'https://example.com/f.bin',
            path: tempDir
        });

        const parsed = JSON.parse(output);
        expect(parsed.success).toBe(false);
    });

    test('写入失败（如父路径为文件）时返回 success:false', async () => {
        const blocker = path.join(tempDir, 'blocker');
        fs.writeFileSync(blocker, 'not a dir');
        const fetchSpy = jest.fn().mockResolvedValue(fakeResponse(Buffer.from('y'), { status: 200 }));
        jest.spyOn(BrowserManager, 'browserSession', 'get').mockReturnValue({ fetch: fetchSpy } as any);

        const output = await runTool(new BrowserDownloadTool(browserApp), {
            url: 'https://example.com/f.bin',
            path: path.join(blocker, 'sub', 'f.bin')
        });

        const parsed = JSON.parse(output);
        expect(parsed.success).toBe(false);
    });

    test('getDeclaredPermissions 声明目标路径的文件写权限', async () => {
        const target = path.join(tempDir, 'perm', 'a.zip');
        const tool = new BrowserDownloadTool(browserApp);
        const perms = tool.getDeclaredPermissions({ url: 'https://example.com/a.zip', path: target } as any, taskState);

        expect(perms).toHaveLength(1);
        expect(perms[0]).toEqual({
            resourceType: 'file',
            action: 'write',
            resourcePath: normalizePath(path.resolve(target))
        });
    });
});
