/**
 * Issue #217 回归测试：createSubTask 结果渲染不得阻塞主进程事件循环。
 *
 * 故障链：子任务把超大内容（如整个 JSON 转储）塞进 attemptCompletion 结果，
 * createSubTask 渲染卡片时对无上限的 result 文本做 marked.parse。marked 的
 * link/reflink 内联正则在"单行 + 大量未闭合 [x](y 片段"的输入上呈 O(k·n)
 * 平方级回溯：400KB 实测同步阻塞事件循环约 1s，数 MB 输入即表现为
 * "进程卡死、无 log 输出、主进程不结束"（调试堆栈稳定停在 RegExp.exec → link）。
 *
 * 修复后：渲染走结构感知分块 + 超限降级，单次同步解析的耗时有上界，
 * 事件循环在块间被让出，任何输入下都不再出现秒级阻塞。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { TextMessagePart, ToolCall } from '../../../main/aikernel/messages.js';
import { CreateSubTaskTool } from '../../../main/aikernel/planning/tools.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

jest.setTimeout(30_000);

/**
 * 构造病态输入：单行 JSON（子任务结果转储的典型形态），内嵌大量未闭合的
 * markdown 链接片段。marked 对每个 [ 都会以剩余全文做一次失败的 link.exec，
 * 单行无空行导致无法分块规避，整体呈平方级耗时。
 */
function pathologicalResult(sizeBytes: number): string {
    const unit = '[模块](src/module.ts) 与 [核心](src/core.ts) ';
    const repeat = Math.ceil(sizeBytes / unit.length);
    return '{"success":true,"result":"分析完成。' + unit.repeat(repeat) + '"}';
}

/** 事件循环阻塞探针：固定间隔心跳，记录两次 tick 之间的最大间隔 */
function startEventLoopProbe(intervalMs = 10): { maxBlockMs(): number; stop(): void } {
    let maxBlock = 0;
    let last = Date.now();
    const timer = setInterval(() => {
        const now = Date.now();
        maxBlock = Math.max(maxBlock, now - last);
        last = now;
    }, intervalMs);
    return {
        maxBlockMs: () => maxBlock,
        stop: () => clearInterval(timer)
    };
}

describe('issue #217: 大体量 createSubTask result 渲染不冻结事件循环', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-issue217-'));
        setCustomOpendeskDirectory(tempDir);
        Setting.updateInstanceData({
            default_model: 'mock-model'
        });
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('400KB 病态 result 渲染期间事件循环单次阻塞不超过 300ms', async () => {
        const tool = new CreateSubTaskTool();
        const toolCall = new ToolCall(0, 'tc-issue217', 'createSubTask', JSON.stringify({ title: '分析代码库' }));
        toolCall.args_object = { title: '分析代码库', objective: '分析大型 NestJS 项目' };
        toolCall.status = 'success';
        toolCall.result = pathologicalResult(400 * 1024);
        toolCall.setTool(tool);

        const probe = startEventLoopProbe();
        const t0 = Date.now();
        try {
            const html = await tool.renderToolCall(toolCall);
            const elapsed = Date.now() - t0;

            expect(html).toBeDefined();
            // 内容不丢失：降级或正常渲染都必须保留原文可读内容
            expect(html).toContain('src/module.ts');
            // 病态单行输入超限，必须走降级纯文本块而不是完整 markdown 解析
            expect(html).toContain('od-md-raw-block');
            // 渲染整体耗时有界
            expect(elapsed).toBeLessThan(10_000);
            // 核心断言：任何单次事件循环阻塞都不得超过 300ms
            expect(probe.maxBlockMs()).toBeLessThan(300);
        } finally {
            probe.stop();
        }
    });

    test('正常体量的多段落报告仍按完整 markdown 渲染', async () => {
        const tool = new CreateSubTaskTool();
        const toolCall = new ToolCall(
            0,
            'tc-issue217-normal',
            'createSubTask',
            JSON.stringify({ title: '分析代码库' })
        );
        toolCall.args_object = { title: '分析代码库', objective: '分析大型 NestJS 项目' };
        toolCall.status = 'success';
        // 约 40KB 的正常报告：多段落 + 标题 + 链接（段落间有空行，可正常分块）
        const section =
            '## 规则详情\n\n证据: [src/module/file.ts](src/module/file.ts) 与 [src/other.ts](src/other.ts)。\n\n这是规则说明段落，包含多个句子的正常中文与英文混排内容。\n\n';
        toolCall.result = JSON.stringify({ success: true, result: section.repeat(60) });
        toolCall.setTool(tool);

        const probe = startEventLoopProbe();
        try {
            const html = await tool.renderToolCall(toolCall);
            expect(html).toContain('<h2');
            expect(html).toContain('od-file-pill');
            // 正常内容不应被降级
            expect(html).not.toContain('od-md-raw-block');
            expect(probe.maxBlockMs()).toBeLessThan(300);
        } finally {
            probe.stop();
        }
    });

    test('TextMessagePart 渲染病态大文本同样有界', async () => {
        const part = new TextMessagePart(pathologicalResult(400 * 1024));
        const probe = startEventLoopProbe();
        try {
            const html = await part.render();
            expect(html).toContain('src/module.ts');
            expect(html).toContain('od-md-raw-block');
            expect(probe.maxBlockMs()).toBeLessThan(300);
        } finally {
            probe.stop();
        }
    });
});
