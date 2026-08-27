import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    FEEDBACK_ATTACHMENT_BUDGET_BYTES,
    FEEDBACK_ENDPOINT,
    SYSTEM_LOG_ATTACHMENT_NAME,
    TASK_JSON_ATTACHMENT_NAME,
    collectFeedbackAttachments,
    submitFeedback,
    trimTaskJson
} from '../../../main/utils/feedback.ts';

let tmpDir: string;
let logPath: string;
let taskPath: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-feedback-'));
    logPath = path.join(tmpDir, 'app-2026-08-27.log');
    taskPath = path.join(tmpDir, 'task-1.json');
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 收集一个可断言的假 fetch，记录最后一次请求 */
function createFetchSpy(response: { ok?: boolean; status?: number; body?: unknown } = {}) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init: unknown) => {
        calls.push({ url: String(url), init: init as RequestInit });
        return {
            ok: response.ok ?? true,
            status: response.status ?? 200,
            json: async () => response.body ?? { ok: true, id: 7 }
        } as unknown as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
}

describe('collectFeedbackAttachments', () => {
    it('feature 类型不勾选任何附件时不产生附件', async () => {
        const attachments = await collectFeedbackAttachments(
            { type: 'feature', content: 'x' },
            { resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );
        expect(attachments).toEqual([]);
    });

    it('勾选系统日志时附加日志文件', async () => {
        fs.writeFileSync(logPath, 'hello log');
        const attachments = await collectFeedbackAttachments(
            { type: 'bug', content: 'x', includeSystemLog: true },
            { resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );
        expect(attachments).toHaveLength(1);
        expect(attachments[0].name).toBe(SYSTEM_LOG_ATTACHMENT_NAME);
        expect(attachments[0].content).toBe('hello log');
    });

    it('勾选当前任务时附加该任务的 .task.json', async () => {
        fs.writeFileSync(taskPath, '{"task_id":"task-1"}');
        const attachments = await collectFeedbackAttachments(
            { type: 'bug', content: 'x', includeTaskJson: true, taskId: 'task-1' },
            { resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );
        expect(attachments).toHaveLength(1);
        expect(attachments[0].name).toBe(TASK_JSON_ATTACHMENT_NAME);
        expect(attachments[0].content).toContain('task-1');
    });

    it('勾选当前任务但没有任务 id 时跳过，不报错', async () => {
        const attachments = await collectFeedbackAttachments(
            { type: 'bug', content: 'x', includeTaskJson: true, taskId: null },
            { resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );
        expect(attachments).toEqual([]);
    });

    it('文件不存在时静默跳过，不阻断提交', async () => {
        const attachments = await collectFeedbackAttachments(
            { type: 'bug', content: 'x', includeSystemLog: true, includeTaskJson: true, taskId: 'task-1' },
            { resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );
        expect(attachments).toEqual([]);
    });

    it('超出附件预算的日志只取尾部，并保留截断说明', async () => {
        // 头部写入可识别标记，确认最终未包含头部内容
        const head = 'HEAD_MARKER';
        const filler = 'x'.repeat(FEEDBACK_ATTACHMENT_BUDGET_BYTES);
        fs.writeFileSync(logPath, `${head}${filler}TAIL_MARKER`);

        const attachments = await collectFeedbackAttachments(
            { type: 'bug', content: 'x', includeSystemLog: true },
            { resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );

        expect(attachments).toHaveLength(1);
        const body = attachments[0].content;
        expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(FEEDBACK_ATTACHMENT_BUDGET_BYTES);
        expect(body).toContain('TAIL_MARKER');
        expect(body).not.toContain(head);
        // 截断需留下痕迹，便于服务端判断日志不完整
        expect(body).toMatch(/truncated/i);
    });

    it('同时勾选两项时按「日志、任务」顺序附加两个文件', async () => {
        fs.writeFileSync(logPath, 'log body');
        fs.writeFileSync(taskPath, '{}');
        const attachments = await collectFeedbackAttachments(
            { type: 'bug', content: 'x', includeSystemLog: true, includeTaskJson: true, taskId: 'task-1' },
            { resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );
        expect(attachments.map((a) => a.name)).toEqual([SYSTEM_LOG_ATTACHMENT_NAME, TASK_JSON_ATTACHMENT_NAME]);
    });

    it('附件预算为 400KB 量级，避免整体请求体超出服务端上限', () => {
        expect(FEEDBACK_ATTACHMENT_BUDGET_BYTES).toBe(400 * 1024);
    });

    it('两个附件同时上传时各自都在预算内', async () => {
        fs.writeFileSync(logPath, 'x'.repeat(FEEDBACK_ATTACHMENT_BUDGET_BYTES * 3));
        fs.writeFileSync(taskPath, JSON.stringify(buildBigTask()));

        const attachments = await collectFeedbackAttachments(
            { type: 'bug', content: 'x', includeSystemLog: true, includeTaskJson: true, taskId: 'task-1' },
            { resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );

        expect(attachments).toHaveLength(2);
        for (const attachment of attachments) {
            expect(Buffer.byteLength(attachment.content, 'utf8')).toBeLessThanOrEqual(FEEDBACK_ATTACHMENT_BUDGET_BYTES);
        }
    });

    it('任务附件走结构化裁剪，产物仍是可解析的 JSON', async () => {
        fs.writeFileSync(taskPath, JSON.stringify(buildBigTask()));

        const attachments = await collectFeedbackAttachments(
            { type: 'bug', content: 'x', includeTaskJson: true, taskId: 'task-1' },
            { resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );

        expect(attachments).toHaveLength(1);
        expect(() => JSON.parse(attachments[0].content)).not.toThrow();
    });
});

/** 构造一个超预算的任务文件：元数据 + 巨大的 chat_context.messages */
function buildBigTask(messageCount = 12) {
    const hugeText = 'y'.repeat(200 * 1024);
    return {
        task_id: 'task-1',
        task_name: '很大的任务',
        task_status: 'stopped',
        model: 'demo-model',
        workspace: '/work/demo',
        created_at: '2026-08-27T00:00:00.000Z',
        updated_at: '2026-08-27T01:00:00.000Z',
        chat_context: {
            system_prompt: { text: 'z'.repeat(40 * 1024) },
            messages: Array.from({ length: messageCount }, (_, index) => ({
                role: index % 2 === 0 ? 'user' : 'assistant',
                message_id: `m-${index}`,
                timestamp: `2026-08-27T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
                content: [
                    { type: 'text', text: `msg-${index}`, rendered: hugeText },
                    {
                        type: 'toolcalls',
                        toolcalls: [
                            {
                                id: `call-${index}`,
                                tool_name: 'demo-tool',
                                status: 'success',
                                args_string: hugeText,
                                args_object: { big: hugeText },
                                result: hugeText,
                                rendered: hugeText
                            }
                        ]
                    }
                ]
            }))
        }
    };
}

describe('trimTaskJson', () => {
    it('体积在预算内时原样返回', () => {
        const small = JSON.stringify({ task_id: 't', chat_context: { messages: [] } });
        expect(trimTaskJson(small)).toBe(small);
    });

    it('超预算时产出合法 JSON 且不超过预算', () => {
        const trimmed = trimTaskJson(JSON.stringify(buildBigTask()));

        expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThanOrEqual(FEEDBACK_ATTACHMENT_BUDGET_BYTES);
        expect(() => JSON.parse(trimmed)).not.toThrow();
    });

    it('保留任务元数据字段，便于定位问题', () => {
        const parsed = JSON.parse(trimTaskJson(JSON.stringify(buildBigTask())));

        expect(parsed.task_id).toBe('task-1');
        expect(parsed.task_name).toBe('很大的任务');
        expect(parsed.task_status).toBe('stopped');
        expect(parsed.model).toBe('demo-model');
        expect(parsed.workspace).toBe('/work/demo');
    });

    it('标注裁剪信息：原始体积与保留的消息条数', () => {
        // 裁剪后单条消息很小，需要足够多的消息才会触发丢弃最旧消息
        const original = JSON.stringify(buildBigTask(400));
        const parsed = JSON.parse(trimTaskJson(original));

        expect(parsed._feedback_trimmed).toBeDefined();
        expect(parsed._feedback_trimmed.original_bytes).toBe(Buffer.byteLength(original, 'utf8'));
        expect(parsed._feedback_trimmed.messages_total).toBe(400);
        expect(parsed._feedback_trimmed.messages_kept).toBeLessThan(400);
    });

    it('消息条数在裁剪后仍装得下时全部保留', () => {
        const parsed = JSON.parse(trimTaskJson(JSON.stringify(buildBigTask(12))));

        expect(parsed._feedback_trimmed.messages_total).toBe(12);
        expect(parsed._feedback_trimmed.messages_kept).toBe(12);
    });

    it('保留的是最近的消息（尾部），而非最早的消息', () => {
        const parsed = JSON.parse(trimTaskJson(JSON.stringify(buildBigTask(400))));
        const kept = parsed.chat_context.messages;

        expect(kept.length).toBeGreaterThan(0);
        // 最后一条必然是原始消息序列的最后一条
        expect(kept.at(-1).message_id).toBe('m-399');
        // 不应包含最早的消息
        expect(kept.some((m: { message_id: string }) => m.message_id === 'm-0')).toBe(false);
    });

    it('丢弃 system_prompt：体积大且与具体问题无关', () => {
        const parsed = JSON.parse(trimTaskJson(JSON.stringify(buildBigTask())));
        expect(parsed.chat_context.system_prompt).toBeUndefined();
    });

    it('剥离 rendered 与工具调用大字段，保留工具名与状态', () => {
        const parsed = JSON.parse(trimTaskJson(JSON.stringify(buildBigTask())));
        const serialized = JSON.stringify(parsed);

        // rendered / args_object / 原始 result 属于渲染与中间产物，不应保留
        expect(serialized).not.toContain('"rendered"');
        expect(serialized).not.toContain('"args_object"');
        // 工具名与状态是定位问题的关键信息，必须保留
        expect(serialized).toContain('demo-tool');
        expect(serialized).toContain('success');
    });

    it('单条消息本身超预算时也能产出合法 JSON', () => {
        const single = {
            task_id: 'task-1',
            chat_context: {
                messages: [
                    {
                        role: 'assistant',
                        message_id: 'only',
                        content: [{ type: 'text', text: 'q'.repeat(FEEDBACK_ATTACHMENT_BUDGET_BYTES * 2) }]
                    }
                ]
            }
        };
        const trimmed = trimTaskJson(JSON.stringify(single));

        expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThanOrEqual(FEEDBACK_ATTACHMENT_BUDGET_BYTES);
        expect(() => JSON.parse(trimmed)).not.toThrow();
    });

    it('无法解析的内容回退为尾部截断，不抛异常', () => {
        const broken = `{"task_id":"x", ${'b'.repeat(FEEDBACK_ATTACHMENT_BUDGET_BYTES * 2)}`;
        const trimmed = trimTaskJson(broken);

        expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThanOrEqual(FEEDBACK_ATTACHMENT_BUDGET_BYTES);
        expect(trimmed).toMatch(/truncated/i);
    });

    it('没有 chat_context 的任务文件同样能被裁剪到预算内', () => {
        const noContext = { task_id: 'x', blob: 'k'.repeat(FEEDBACK_ATTACHMENT_BUDGET_BYTES * 2) };
        const trimmed = trimTaskJson(JSON.stringify(noContext));

        expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThanOrEqual(FEEDBACK_ATTACHMENT_BUDGET_BYTES);
        expect(() => JSON.parse(trimmed)).not.toThrow();
    });
});

describe('submitFeedback', () => {
    it('以 multipart/form-data POST 到反馈接口，并携带 type 与 content', async () => {
        const { calls, fetchImpl } = createFetchSpy();

        const result = await submitFeedback(
            { type: 'feature', content: '希望支持分屏' },
            { fetchImpl, resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );

        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(FEEDBACK_ENDPOINT);
        expect(calls[0].init.method).toBe('POST');

        const form = calls[0].init.body as FormData;
        expect(form.get('type')).toBe('feature');
        expect(form.get('content')).toBe('希望支持分屏');
    });

    it('勾选的附件以 attachments 字段随表单提交', async () => {
        fs.writeFileSync(logPath, 'log body');
        const { calls, fetchImpl } = createFetchSpy();

        await submitFeedback(
            { type: 'bug', content: '崩溃了', includeSystemLog: true },
            { fetchImpl, resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );

        const form = calls[0].init.body as FormData;
        const files = form.getAll('attachments');
        expect(files).toHaveLength(1);
        expect((files[0] as File).name).toBe(SYSTEM_LOG_ATTACHMENT_NAME);
    });

    it('content 为空时直接失败，不发起请求', async () => {
        const { calls, fetchImpl } = createFetchSpy();

        const result = await submitFeedback(
            { type: 'bug', content: '   ' },
            { fetchImpl, resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );

        expect(result.ok).toBe(false);
        expect(calls).toHaveLength(0);
    });

    it('type 非法时直接失败，不发起请求', async () => {
        const { calls, fetchImpl } = createFetchSpy();

        const result = await submitFeedback(
            { type: 'other' as 'bug', content: '内容' },
            { fetchImpl, resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );

        expect(result.ok).toBe(false);
        expect(calls).toHaveLength(0);
    });

    it('服务端返回非 2xx 时返回失败并带上状态码', async () => {
        const { fetchImpl } = createFetchSpy({ ok: false, status: 400 });

        const result = await submitFeedback(
            { type: 'bug', content: '内容' },
            { fetchImpl, resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );

        expect(result.ok).toBe(false);
        expect(result.message).toContain('400');
    });

    it('网络异常时返回失败而非抛出异常', async () => {
        const fetchImpl = (async () => {
            throw new Error('network down');
        }) as unknown as typeof fetch;

        const result = await submitFeedback(
            { type: 'bug', content: '内容' },
            { fetchImpl, resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );

        expect(result.ok).toBe(false);
        expect(result.message).toContain('network down');
    });

    it('content 提交前做 trim，避免首尾空白入库', async () => {
        const { calls, fetchImpl } = createFetchSpy();

        await submitFeedback(
            { type: 'bug', content: '  有问题  ' },
            { fetchImpl, resolveLogPath: () => logPath, resolveTaskPath: () => taskPath }
        );

        const form = calls[0].init.body as FormData;
        expect(form.get('content')).toBe('有问题');
    });
});
