import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AssistantMessage, ChatContext, ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import { resolveVisibleToolResultContent } from '../../../main/aikernel/tool-result-content.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

/**
 * 已压缩工具结果的原始 result 剥离（issue #341 阶段二）。
 *
 * 背景：tool result 压缩（compact 主流程 / tool-result budget）都会把原始结果
 * 落盘到 artifacts/<taskId>/tool_results/<resultId>.txt，但落盘后的 task JSON
 * 里仍保留原始 result 副本——大历史的全量序列化峰值与文件体积因此被成倍放大。
 *
 * 剥离契约（ToolCall.toJSON）：
 * - result 与 result_storage.replacement_text 相比没有增量（compact 主流程在内存
 *   里已原地替换）→ 直接剥离；
 * - result 是被保留的原始文本（budget 流）→ 只有 artifacts 原文文件真实存在
 *   （可恢复）时才剥离；
 * - 原文文件缺失（旧 JSON 拷贝到没有 artifacts 的机器 / best-effort 落盘失败）→
 *   保持内联，绝不丢数据（向后兼容硬保证）；
 * - 没有 replacement_text 的普通结果 → 完全不受影响。
 *
 * 加载端兼容：所有模型可见内容走 resolveVisibleToolResultContent（替代文本优先），
 * 缺失 result 时返回替代文本而非原始文本，序列化前后内容保持一致。
 */

const replacementText = `工具输出摘要 ${'preview '.repeat(40)}\n完整输出已保存至: /artifacts/t1/tool_results/r1.txt\n若需完整内容请通过读文件方式获取。`;

let dataDir: string | undefined;

beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-strip-ut-'));
    setCustomOpendeskDirectory(dataDir);
});

afterAll(() => {
    setCustomOpendeskDirectory(undefined);
    if (dataDir && fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
    dataDir = undefined;
});

function buildCompressedCall(options: {
    result: string;
    /** 旧格式：自由文本替代文本 */
    replacement?: string;
    /** 新格式：结构化预览（与 relativePath 配对，模型可见文本由边界渲染） */
    preview?: string;
    relativePath?: string;
    artifactContent?: string;
}): ToolCall {
    const call = new ToolCall(0, 'call-1', 'web_search', '{}');
    call.status = 'success';
    call.result = options.result;
    if (options.replacement !== undefined || options.preview !== undefined) {
        call.setResultStorage({
            result_id: 'result-1',
            ...(options.relativePath !== undefined ? { relative_path: options.relativePath } : {}),
            ...(options.preview !== undefined ? { replacement_preview: options.preview } : {}),
            ...(options.replacement !== undefined ? { replacement_text: options.replacement } : {})
        });
    }
    if (options.artifactContent !== undefined) {
        // relativePath 是相对 opendesk 目录的路径，按需在临时目录里落地原文文件
        const fullPath = path.join(dataDir!, options.relativePath!);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, options.artifactContent, 'utf8');
    }
    return call;
}

describe('compressed tool result original stripping', () => {
    test('result identical to replacement text is stripped without touching the artifact', () => {
        // compact 主流程落盘前的内存态：result 已被原地替换为替代文本
        const call = buildCompressedCall({ result: replacementText, replacement: replacementText });
        const json = call.toJSON() as Record<string, unknown>;
        expect(json.result).toBeUndefined();
        expect(json.result_storage).toBeDefined();
    });

    test('retained original is stripped only when the artifact file exists', () => {
        const original = `RAW_${'original '.repeat(4000)}`;
        const relativePath = path.join('artifacts', 't1', 'tool_results', 'r1.txt');
        const call = buildCompressedCall({
            result: original,
            replacement: replacementText,
            relativePath,
            artifactContent: original
        });
        const json = call.toJSON() as Record<string, unknown>;
        expect(json.result).toBeUndefined();
    });

    test('retained original stays inline when the artifact file is missing (old-file compat)', () => {
        // 老任务 JSON 被拷贝到没有 artifacts 的机器 / 压缩时 best-effort 落盘失败：
        // 剥离会永久丢数据，必须保持内联
        const original = `RAW_${'original '.repeat(4000)}`;
        const call = buildCompressedCall({
            result: original,
            replacement: replacementText,
            relativePath: path.join('artifacts', 't1', 'tool_results', 'missing.txt')
        });
        const json = call.toJSON() as Record<string, unknown>;
        expect(json.result).toBe(original);
    });

    test('retained original stays inline when result_storage has no relative_path', () => {
        const original = `RAW_${'original '.repeat(4000)}`;
        const call = buildCompressedCall({ result: original, replacement: replacementText });
        const json = call.toJSON() as Record<string, unknown>;
        expect(json.result).toBe(original);
    });

    test('results without replacement metadata are never touched', () => {
        const result = `plain ${'result '.repeat(4000)}`;
        const call = buildCompressedCall({ result });
        const json = call.toJSON() as Record<string, unknown>;
        expect(json.result).toBe(result);
    });

    test('a shorter-but-different result is never treated as the replacement copy', () => {
        // 内容相等才允许免检剥离：更短但内容不同的 result 不是替代文本的副本，
        // 即使替代文本已在 result_storage 里持久化，也不能凭长度假设把它剥掉
        const differentShorter = 'different but shorter';
        const call = buildCompressedCall({ result: differentShorter, replacement: replacementText });
        const json = call.toJSON() as Record<string, unknown>;
        expect(json.result).toBe(differentShorter);
    });

    test('a malformed relative_path never participates in the artifact existence probe', () => {
        // 安全（路径穿越防护）：relative_path 随任务 JSON 持久化，可被恶意导入包构造成
        // 指向数据根内任意文件的路径；形状不合法时即使文件真实存在也必须保持内联，
        // 否则序列化行为就成了「任意文件存在性探测」并放大丢数据面
        const original = `RAW_${'original '.repeat(4000)}`;
        const probeFile = path.join(dataDir!, 'escape-probe.txt');
        fs.writeFileSync(probeFile, 'exists');
        try {
            const call = buildCompressedCall({
                result: original,
                replacement: replacementText,
                relativePath: 'escape-probe.txt'
            });
            const json = call.toJSON() as Record<string, unknown>;
            expect(json.result).toBe(original);
        } finally {
            fs.rmSync(probeFile, { force: true });
        }
    });

    test('error results render the replacement text through the resolver after reload', async () => {
        // afterToolCall 大结果压缩不区分成功/失败；错误条目重载后 result 已剥离，
        // 错误体必须经 resolver 显示替代文本而非空串
        const relativePath = path.join('artifacts', 't3', 'tool_results', 'err.txt');
        const call = buildCompressedCall({
            result: `RAW_${'error '.repeat(3000)}`,
            replacement: replacementText,
            relativePath,
            artifactContent: `RAW_${'error '.repeat(3000)}`
        });
        call.status = 'error';
        const rendered = await call.render();
        expect(rendered).toContain('完整输出已保存至');
    });

    test('stripped serialization keeps model-visible content identical through a JSON round trip', () => {
        const original = `RAW_${'original '.repeat(2000)}`;
        const relativePath = path.join('artifacts', 't2', 'tool_results', 'r2.txt');
        const call = buildCompressedCall({
            result: original,
            replacement: replacementText,
            relativePath,
            artifactContent: original
        });
        const part = new ToolCallMessagePart();
        part.push(call);
        const assistant = new AssistantMessage();
        assistant.appendToolCallPart(part);
        const context = new ChatContext();
        context.appendMessage(assistant);

        const restored = ChatContext.assign(JSON.parse(JSON.stringify(context)));
        const restoredCall = (restored.messages[0] as AssistantMessage).content[0] as ToolCallMessagePart;
        const strippedCall = restoredCall.toolcalls[0];
        expect(strippedCall.result).toBeUndefined();
        // 模型可见内容前后一致：替代文本优先于（已缺失的）原始文本
        expect(resolveVisibleToolResultContent(strippedCall)).toBe(replacementText);
        expect(resolveVisibleToolResultContent(call)).toBe(replacementText);
    });

    test('legacy files with inline originals keep loading and rendering the replacement', () => {
        // 旧版 JSON（result 原始文本 + replacement 并存）反序列化后的行为不变
        const original = `RAW_${'original '.repeat(2000)}`;
        const legacy = {
            id: 'call-legacy',
            index: 0,
            tool_name: 'web_search',
            status: 'success',
            result: original,
            result_storage: {
                result_id: 'result-legacy',
                replacement_text: replacementText
            }
        };
        const restored = ToolCall.assign(JSON.parse(JSON.stringify(legacy)));
        expect(restored.result).toBe(original);
        expect(resolveVisibleToolResultContent(restored)).toBe(replacementText);
    });

    test('lazy render backfill restores the replacement only when a custom render is triggered', async () => {
        // 自定义渲染器直接消费 result 本体（如 parseToolResult 的 JSON.parse），
        // 已剥离条目须在真正触发自定义渲染时回填替代文本；未触发时 result 保持
        // undefined，不产生回填内存（GUI 尾部加载/极简模式未展开的调用不回填）
        const original = `RAW_${'original '.repeat(2000)}`;
        const relativePath = path.join('artifacts', 't4', 'tool_results', 'r4.txt');
        const call = buildCompressedCall({
            result: original,
            replacement: replacementText,
            relativePath,
            artifactContent: original
        });
        const part = new ToolCallMessagePart();
        part.push(call);
        const assistant = new AssistantMessage();
        assistant.appendToolCallPart(part);
        const context = new ChatContext();
        context.appendMessage(assistant);

        // 序列化往返模拟重载画像：result 已剥离
        const restored = ChatContext.assign(JSON.parse(JSON.stringify(context)));
        const restoredPart = (restored.messages[0] as AssistantMessage).content[0] as ToolCallMessagePart;
        const strippedCall = restoredPart.toolcalls[0];
        expect(strippedCall.result).toBeUndefined();

        // 挂一个消费 result 本体的自定义渲染器
        const rendererCalls: string[] = [];
        const customRenderer = {
            renderToolCall: async (toolcall: ToolCall) => {
                rendererCalls.push(toolcall.result ?? '');
                return `<div>custom ${toolcall.result?.length ?? 0}</div>`;
            }
        };
        (strippedCall as unknown as { setTool: (tool: unknown) => void }).setTool(customRenderer);

        // 回填只发生在渲染触发时：渲染前 result 仍为 undefined
        expect(strippedCall.result).toBeUndefined();
        const rendered = await strippedCall.render();
        expect(rendered).toContain('custom');
        expect(rendererCalls[0]).toBe(replacementText);
        expect(strippedCall.result).toBe(replacementText);

        // 未压缩条目回填是 no-op：原始 result 不被替代文本覆盖
        const plain = buildCompressedCall({ result: original });
        const plainRenderer = {
            renderToolCall: async () => undefined
        };
        (plain as unknown as { setTool: (tool: unknown) => void }).setTool(plainRenderer);
        await plain.render();
        expect(plain.result).toBe(original);
    });

    test('structured preview renders an absolute locator at the boundary (legacy text passes through)', () => {
        // 新格式：存储层只有「预览正文 + 相对产物路径」，模型可见文本由 resolver 按本机
        // 数据根渲染，路径可直接读取且跨机器永不过期
        const relativePath = path.join('artifacts', 't6', 'tool-results', 'r6.txt');
        const call = buildCompressedCall({ result: 'RAW', preview: '输出预览', relativePath });
        expect(resolveVisibleToolResultContent(call)).toBe(
            `输出预览\n\n完整输出已保存至: ${path.join(dataDir!, relativePath)}\n若需完整内容请通过读文件方式获取。`
        );

        // 旧格式（自由文本内嵌绝对路径）原样透传：接受"源机路径不可用"的降级，不做解析
        const legacyAbsolute = `完整输出已保存至: ${path.join(dataDir!, relativePath)}`;
        const legacyCall = buildCompressedCall({ result: 'RAW', replacement: legacyAbsolute, relativePath });
        expect(resolveVisibleToolResultContent(legacyCall)).toBe(legacyAbsolute);
    });

    test('a backfilled (rendered) replacement copy is still stripped on serialization', async () => {
        // 渲染回填得到的是按本机数据根渲染的文本：与 resolver 输出等价，序列化时按纯冗余副本剥离
        const relativePath = path.join('artifacts', 't7', 'tool-results', 'r7.txt');
        const call = buildCompressedCall({ result: 'RAW', preview: '输出预览', relativePath });
        // 模拟剥离后的重载画像：result 缺失时渲染才会触发回填
        delete (call as { result?: string }).result;
        const renderer = { renderToolCall: async () => undefined };
        (call as unknown as { setTool: (tool: unknown) => void }).setTool(renderer);
        await call.render();
        expect(call.result).toContain(path.join(dataDir!, relativePath));
        const json = call.toJSON() as Record<string, unknown>;
        expect(json.result).toBeUndefined();
    });

    test('lazy render backfill also covers custom error cards (renderToolCallOnError)', async () => {
        // MCP 类工具 renderToolCallOnError = true：错误正文由自定义渲染器读
        // toolcall.result 输出，压缩不区分成功/失败，剥离后的错误体同样要回填
        // （与统一错误卡片 renderError 的 resolver 行为一致）
        const original = `RAW_ERROR_${'error '.repeat(3000)}`;
        const relativePath = path.join('artifacts', 't5', 'tool_results', 'r5.txt');
        const call = buildCompressedCall({
            result: original,
            replacement: replacementText,
            relativePath,
            artifactContent: original
        });
        const part = new ToolCallMessagePart();
        part.push(call);
        const assistant = new AssistantMessage();
        assistant.appendToolCallPart(part);
        const context = new ChatContext();
        context.appendMessage(assistant);

        const restored = ChatContext.assign(JSON.parse(JSON.stringify(context)));
        const errorCall = (restored.messages[0] as AssistantMessage).content[0] as ToolCallMessagePart;
        const strippedError = errorCall.toolcalls[0];
        strippedError.status = 'error';
        expect(strippedError.result).toBeUndefined();

        const errorRenderer = {
            // 与 MCP 工具一致：错误态保留自定义渲染（否则统一错误卡片先接管）
            renderToolCallOnError: true,
            renderToolCall: async (toolcall: ToolCall) => `<div class="error-card">${toolcall.result ?? ''}</div>`
        };
        (strippedError as unknown as { setTool: (tool: unknown) => void }).setTool(errorRenderer);
        const rendered = await strippedError.render();
        expect(rendered).toContain('error-card');
        expect(rendered).toContain(replacementText.slice(0, 16));
        expect(strippedError.result).toBe(replacementText);
    });

    test('microcompact local_clear renders at the boundary and its inline copy is stripped', async () => {
        // microcompact 只保存结构化清理状态，产物路径复用 result_storage.relative_path；
        // 模型可见文本按当前数据根渲染，写入时 result 被替换成渲染文本，序列化时按纯冗余副本剥离
        const { renderMicrocompactReplacementText } =
            await import('../../../main/aikernel/compaction/microcompact-render.js');
        const hint = path.join('artifacts', 't9', 'tool-results', 'r9.txt');
        const call = new ToolCall(0, 'call-mc', 'readFile', '{"file_path":"/tmp/a.txt"}');
        call.status = 'success';
        call.setResultStorage({ result_id: 'r9', relative_path: hint });
        call.microcompact = {
            strategy: 'local_clear',
            cleared_at: '2026-01-01T00:00:00.000Z',
            original_chars: 500,
            original_lines: 5
        };
        const renderedText = renderMicrocompactReplacementText(call, hint);
        call.result = renderedText;

        // 边界渲染：绝对路径 + 工具/文件信息；与写入时的文本逐字节一致
        expect(renderedText).toContain(path.join(dataDir!, hint));
        expect(resolveVisibleToolResultContent(call)).toBe(renderedText);
        // 内联副本被剥离（结构化状态可独立还原）
        const json = call.toJSON() as Record<string, unknown>;
        expect(json.result).toBeUndefined();

        // 重载后无 result 也能渲染出同一文本
        const restored = ToolCall.assign(JSON.parse(JSON.stringify(json)));
        expect(resolveVisibleToolResultContent(restored)).toBe(renderedText);
    });
});
