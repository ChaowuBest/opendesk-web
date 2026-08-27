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

/**
 * 用户反馈上报：向服务端 /api/feedback/submit 提交 feature / bug 反馈。
 *
 * 放在 main 侧而非 renderer 的原因：
 *   - renderer 页面以 file:// 加载，跨源 POST 的 Origin 为 null，依赖服务端 CORS；
 *   - 走 getPlatform().fetch 才能继承 OpenDesk 的代理与 no_ssl 网络配置（与心跳上报一致）；
 *   - 日志与任务文件读取、超限截断都需要 Node 文件系统能力。
 *
 * 本模块只依赖 fs/path，网络实现、日志目录、任务目录与告警输出全部由调用方注入，
 * 便于单测覆盖，也避免在模块顶层拉起 Electron / winston 等重依赖。
 *
 * 服务端约定（见 opendesk-pages src/server/routes/feedback.js）：
 *   multipart/form-data，字段 type（feature|bug）、content（必填）、contact（可选）、
 *   attachments（可选，可多个文件）；最多 5 个附件，单个附件不超过 1MB。
 */

import fs from 'fs';

export const FEEDBACK_SERVER_URL = 'https://opendesk.matrix.openharmony.cn';
export const FEEDBACK_ENDPOINT = `${FEEDBACK_SERVER_URL}/api/feedback/submit`;

/** 单次提交超时：网络异常时主动放弃，避免界面长期等待 */
export const FEEDBACK_TIMEOUT_MS = 20 * 1000;

/**
 * 单个附件的字节预算。服务端单附件上限 1MB，但整个 multipart 请求体
 * 还要经过 Cloudflare Pages Functions，两个附件叠加后曾触发 HTTP 413，
 * 因此把单附件压到 400KB，两个附件加正文也远低于任何一层的限制。
 */
export const FEEDBACK_ATTACHMENT_BUDGET_BYTES = 400 * 1024;

/** 消息数组序列化时逗号等分隔符的余量，避免逐条累加后恰好越界 */
const MESSAGE_SEPARATOR_RESERVE_BYTES = 1024;

export const SYSTEM_LOG_ATTACHMENT_NAME = 'opendesk-system.log';
export const TASK_JSON_ATTACHMENT_NAME = 'opendesk-task.json';

export type FeedbackType = 'feature' | 'bug';

export interface FeedbackSubmission {
    type: FeedbackType;
    /** 反馈正文。feature 类型由需求名称与需求内容拼装后传入 */
    content: string;
    /** 是否附加系统日志 */
    includeSystemLog?: boolean;
    /** 是否附加当前任务的 .task.json */
    includeTaskJson?: boolean;
    /** 当前任务 id，includeTaskJson 为 true 时必需 */
    taskId?: string | null;
}

export interface FeedbackAttachment {
    name: string;
    contentType: string;
    content: string;
}

export interface FeedbackDeps {
    /** 网络实现。main 侧传 getPlatform().fetch 以继承代理与 no_ssl 配置 */
    fetchImpl: typeof fetch;
    /** 系统日志文件路径 */
    resolveLogPath: () => string;
    /** 任务数据文件路径 */
    resolveTaskPath: (taskId: string) => string;
    timeoutMs?: number;
    /** 附件读取或提交失败时的告警输出 */
    onWarn?: (message: string) => void;
    /** 提交成功时的信息输出 */
    onInfo?: (message: string) => void;
}

/** collectFeedbackAttachments 只需要路径解析与告警，不需要网络 */
export type FeedbackAttachmentDeps = Pick<FeedbackDeps, 'resolveLogPath' | 'resolveTaskPath' | 'onWarn'>;

export interface FeedbackResult {
    ok: boolean;
    /** 服务端返回的反馈记录 id */
    id?: number | null;
    message?: string;
}

/**
 * 读取文本文件，超出预算时只保留尾部并在开头标注截断。
 * 日志的价值集中在末尾（最近发生的事），因此截断保留尾部而非头部。
 * 文件不存在或不是普通文件时返回 null，由调用方决定跳过。
 */
async function readTailWithinBudget(filePath: string): Promise<string | null> {
    let stat: fs.Stats;
    try {
        stat = await fs.promises.stat(filePath);
    } catch {
        return null;
    }
    if (!stat.isFile()) {
        return null;
    }
    const buf = await fs.promises.readFile(filePath);
    if (buf.length <= FEEDBACK_ATTACHMENT_BUDGET_BYTES) {
        return buf.toString('utf8');
    }
    return tailWithNotice(buf, stat.size);
}

/** 取 buffer 尾部并在开头加上截断说明，整体控制在预算内 */
function tailWithNotice(buf: Buffer, originalSize: number): string {
    const notice = `[truncated] original size ${originalSize} bytes, keeping the last ${FEEDBACK_ATTACHMENT_BUDGET_BYTES} bytes\n`;
    const tailBytes = FEEDBACK_ATTACHMENT_BUDGET_BYTES - Buffer.byteLength(notice, 'utf8');
    return notice + buf.subarray(buf.length - tailBytes).toString('utf8');
}

/** 读取文件全文；文件不存在或不是普通文件时返回 null */
async function readFileIfExists(filePath: string): Promise<string | null> {
    try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) {
            return null;
        }
    } catch {
        return null;
    }
    return (await fs.promises.readFile(filePath)).toString('utf8');
}

/** 消息 content 里体积最大、且对定位问题无用的渲染与中间产物字段 */
const DROPPED_PART_FIELDS = new Set(['rendered', 'image_url', 'source']);
const DROPPED_TOOLCALL_FIELDS = new Set(['rendered', 'args_object', 'result_storage', 'metadata']);

/** 单个字符串字段在裁剪后允许保留的最大长度，超出部分以省略号标记 */
const FIELD_CLAMP_CHARS = 2000;

function clampText(value: unknown): unknown {
    if (typeof value !== 'string' || value.length <= FIELD_CLAMP_CHARS) {
        return value;
    }
    return `${value.slice(0, FIELD_CLAMP_CHARS)}…[+${value.length - FIELD_CLAMP_CHARS} chars]`;
}

/**
 * 精简单个工具调用：保留工具名、状态、入参与结果摘要，
 * 丢弃 rendered / args_object 等渲染与副本字段。
 */
function slimToolCall(call: Record<string, unknown>): Record<string, unknown> {
    const slim: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(call)) {
        if (DROPPED_TOOLCALL_FIELDS.has(key)) continue;
        slim[key] = clampText(value);
    }
    return slim;
}

/** 精简消息 content 中的单个段落 */
function slimContentPart(part: unknown): unknown {
    if (!part || typeof part !== 'object') {
        return clampText(part);
    }
    const slim: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(part as Record<string, unknown>)) {
        if (DROPPED_PART_FIELDS.has(key)) continue;
        if (key === 'toolcalls' && Array.isArray(value)) {
            slim[key] = value.map((call) =>
                call && typeof call === 'object' ? slimToolCall(call as Record<string, unknown>) : call
            );
            continue;
        }
        slim[key] = clampText(value);
    }
    return slim;
}

/** 精简一条消息：保留角色与时间戳等定位信息，正文按字段裁剪 */
function slimMessage(message: unknown): unknown {
    if (!message || typeof message !== 'object') {
        return message;
    }
    const source = message as Record<string, unknown>;
    const slim: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
        if (key === 'content') {
            slim[key] = Array.isArray(value) ? value.map(slimContentPart) : clampText(value);
            continue;
        }
        slim[key] = clampText(value);
    }
    return slim;
}

/**
 * 对任务 JSON 做结构化裁剪：保留任务元数据，丢弃体积巨大且与问题定位
 * 无关的 system_prompt 与渲染字段，消息从最近一条往前保留到预算用尽。
 *
 * 相比直接按字节截尾，结构化裁剪的产物仍是合法 JSON，服务端与人工都能直接解析。
 * 内容无法解析为对象时回退为尾部截断，保证始终能产出附件。
 */
export function trimTaskJson(raw: string): string {
    if (Buffer.byteLength(raw, 'utf8') <= FEEDBACK_ATTACHMENT_BUDGET_BYTES) {
        return raw;
    }

    let parsed: Record<string, unknown>;
    try {
        const candidate = JSON.parse(raw);
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            throw new Error('not an object');
        }
        parsed = candidate as Record<string, unknown>;
    } catch {
        return tailWithNotice(Buffer.from(raw, 'utf8'), Buffer.byteLength(raw, 'utf8'));
    }

    const originalBytes = Buffer.byteLength(raw, 'utf8');
    const chatContext = (parsed.chat_context ?? null) as Record<string, unknown> | null;
    const messages = Array.isArray(chatContext?.messages) ? (chatContext.messages as unknown[]) : [];

    // 元数据 = 除 chat_context 外的所有顶层字段，各字段值同样做长度收敛，
    // 避免个别超长字段（如 custom_system_prompt）撑爆预算
    const meta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (key === 'chat_context') continue;
        meta[key] = clampText(value);
    }

    const buildOutput = (keptMessages: unknown[]): string =>
        JSON.stringify({
            ...meta,
            _feedback_trimmed: {
                original_bytes: originalBytes,
                messages_total: messages.length,
                messages_kept: keptMessages.length,
                note: 'structurally trimmed for feedback upload: system_prompt and rendered fields dropped, oldest messages removed'
            },
            chat_context: { messages: keptMessages }
        });

    // 先按实际的元数据与裁剪说明开销确定消息可用额度，避免后续反复重建输出
    const envelopeBytes = Buffer.byteLength(buildOutput([]), 'utf8');
    const budget = FEEDBACK_ATTACHMENT_BUDGET_BYTES - envelopeBytes - MESSAGE_SEPARATOR_RESERVE_BYTES;

    // 从最近一条消息往前累加，直到触及预算上限
    const kept: unknown[] = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const slim = slimMessage(messages[i]);
        const size = Buffer.byteLength(JSON.stringify(slim) ?? '', 'utf8');
        if (used + size > budget) break;
        kept.unshift(slim);
        used += size;
    }

    let output = buildOutput(kept);
    // 兜底：元数据自身过大或估算偏差时，逐步丢弃最旧消息直至达标
    while (Buffer.byteLength(output, 'utf8') > FEEDBACK_ATTACHMENT_BUDGET_BYTES && kept.length > 0) {
        kept.shift();
        output = buildOutput(kept);
    }
    if (Buffer.byteLength(output, 'utf8') <= FEEDBACK_ATTACHMENT_BUDGET_BYTES) {
        return output;
    }
    // 极端情况：仅元数据就超预算，退化为只保留最关键的少量字段
    return JSON.stringify({
        task_id: parsed.task_id ?? null,
        task_name: clampText(parsed.task_name ?? null),
        task_status: parsed.task_status ?? null,
        model: parsed.model ?? null,
        workspace: clampText(parsed.workspace ?? null),
        _feedback_trimmed: {
            original_bytes: originalBytes,
            messages_total: messages.length,
            messages_kept: 0,
            note: 'metadata alone exceeded the attachment budget; only key fields are kept'
        }
    });
}

/**
 * 按用户勾选收集附件。任何单个附件读取失败都只跳过该附件，
 * 不阻断反馈正文的提交——附件是辅助信息，正文才是主体。
 */
export async function collectFeedbackAttachments(
    submission: FeedbackSubmission,
    deps: FeedbackAttachmentDeps
): Promise<FeedbackAttachment[]> {
    const attachments: FeedbackAttachment[] = [];

    if (submission.includeSystemLog) {
        try {
            const content = await readTailWithinBudget(deps.resolveLogPath());
            if (content !== null) {
                attachments.push({
                    name: SYSTEM_LOG_ATTACHMENT_NAME,
                    contentType: 'text/plain;charset=utf-8',
                    content
                });
            }
        } catch (error: unknown) {
            deps.onWarn?.(`[feedback] 读取系统日志失败: ${String(error)}`);
        }
    }

    if (submission.includeTaskJson && submission.taskId) {
        try {
            // 任务文件走结构化裁剪：直接按字节截尾会破坏 JSON 结构，无法解析
            const raw = await readFileIfExists(deps.resolveTaskPath(submission.taskId));
            if (raw !== null) {
                attachments.push({
                    name: TASK_JSON_ATTACHMENT_NAME,
                    contentType: 'application/json;charset=utf-8',
                    content: trimTaskJson(raw)
                });
            }
        } catch (error: unknown) {
            deps.onWarn?.(`[feedback] 读取任务文件失败: ${String(error)}`);
        }
    }

    return attachments;
}

/**
 * 提交一次用户反馈。失败只返回结果对象，不抛出异常，由界面提示用户。
 */
export async function submitFeedback(submission: FeedbackSubmission, deps: FeedbackDeps): Promise<FeedbackResult> {
    if (submission.type !== 'feature' && submission.type !== 'bug') {
        return { ok: false, message: `invalid feedback type: ${String(submission.type)}` };
    }
    const content = submission.content?.trim() ?? '';
    if (!content) {
        return { ok: false, message: 'content is required' };
    }

    const attachments = await collectFeedbackAttachments(submission, deps);

    const form = new FormData();
    form.append('type', submission.type);
    form.append('content', content);
    for (const attachment of attachments) {
        form.append('attachments', new Blob([attachment.content], { type: attachment.contentType }), attachment.name);
    }

    try {
        const response = await deps.fetchImpl(FEEDBACK_ENDPOINT, {
            method: 'POST',
            body: form,
            // 超时后主动放弃，避免网络异常长期挂起提交按钮
            signal: AbortSignal.timeout(deps.timeoutMs ?? FEEDBACK_TIMEOUT_MS)
        });
        if (!response.ok) {
            deps.onWarn?.(`[feedback] 提交失败: HTTP ${response.status}`);
            return { ok: false, message: `HTTP ${response.status}` };
        }
        const data = (await response.json().catch(() => null)) as { id?: number } | null;
        deps.onInfo?.(`[feedback] 已提交 ${submission.type} 反馈 (attachments=${attachments.length})`);
        return { ok: true, id: data?.id ?? null };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        deps.onWarn?.(`[feedback] 提交异常: ${message}`);
        return { ok: false, message };
    }
}
