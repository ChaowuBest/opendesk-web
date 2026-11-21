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

import path from 'node:path';
import type { AdminFeedbackItem } from '../../utils/admin-stats.js';

/** downloadAttachmentToFile 的返回契约（AdminResult 的最小子集），避免反向依赖 app.ts；
 * data 形态由调用方保证为 { filePath }（AdminResult<T = unknown>），helper 内做安全收窄 */
export type AttachmentDownloadResult = {
    status: string;
    data?: unknown;
    message?: string;
};

export interface StageFeedbackAttachmentsDeps {
    /** 已取到的反馈详情（正文与附件清单） */
    item: AdminFeedbackItem;
    /** 下载单个附件到 destPath；失败返回非 ok 状态而不抛错（附件是辅助信息，逐个降级） */
    downloadAttachment: (attachmentId: number, destPath: string) => Promise<AttachmentDownloadResult>;
    /** 本次暂存的唯一目录：<dataDir>/task-compose/<type>-<id>/<timestamp-rand>，
     * 每次调用都应返回一个新目录，不能复用旧目录 */
    resolveStageDir: () => string;
    /** 创建暂存目录（mkdir -p 语义） */
    ensureDir: (dir: string) => Promise<void>;
}

export interface FeedbackStageResult {
    item: AdminFeedbackItem;
    /** 下载成功的附件绝对路径：保持 item.attachments 的相对顺序，失败项被跳过 */
    attachmentPaths: string[];
    /** 下载失败的附件原始文件名（供 UI 提示降级情况） */
    failedFilenames: string[];
}

/**
 * 暂存目录保留时长：任务侧附件只保存路径引用（FileMessagePart(path)）不复制文件，
 * 因此历史任务会长期引用这里的附件，不能像早期实现那样每次点击 rm -rf 同一目录，
 * 否则旧任务的附件卡片会指向已被删除或被覆盖的文件。
 */
export const COMPOSE_STAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface StageDirEntry {
    name: string;
    mtimeMs: number;
}

/** 选出超过保留期、可以安全删除的暂存目录名（纯函数，供 app 侧 prune 使用） */
export function selectExpiredStageDirs(
    entries: StageDirEntry[],
    nowMs: number,
    maxAgeMs = COMPOSE_STAGE_RETENTION_MS
): string[] {
    return entries
        .filter((entry) => typeof entry?.name === 'string' && Number.isFinite(entry.mtimeMs))
        .filter((entry) => nowMs - entry.mtimeMs >= maxAgeMs)
        .map((entry) => entry.name);
}

/** Windows 保留设备名：同名（含带扩展名形式 con.txt）无法创建文件 */
const WINDOWS_RESERVED_FILENAMES = new Set<string>([
    'con',
    'prn',
    'aux',
    'nul',
    ...Array.from({ length: 9 }, (_value, index) => `com${index + 1}`),
    ...Array.from({ length: 9 }, (_value, index) => `lpt${index + 1}`)
]);

/** Windows 不允许出现于文件名中的字符（路径分隔符在取末段时已剥离） */
const ILLEGAL_FILENAME_CHARS = /[<>:"|?*]/g;

/** 控制字符（0x00-0x1f、0x7f）在 Windows 上同样非法，逐个替换而非写进正则（避免 no-control-regex） */
function replaceControlChars(value: string): string {
    let result = '';
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        result += code < 0x20 || code === 0x7f ? '_' : char;
    }
    return result;
}

/** 单段文件名 UTF-8 字节上限：多数文件系统限制 255 字节，这里留出目录与前缀去重的余量 */
const MAX_ATTACHMENT_FILENAME_BYTES = 180;

/** 按 UTF-8 字节截断文件名，尽量保留扩展名（多字节字符不会被截半） */
function truncateFilenameBytes(name: string, maxBytes: number): string {
    if (Buffer.byteLength(name, 'utf8') <= maxBytes) {
        return name;
    }
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot) : '';
    const stem = dot > 0 ? name.slice(0, dot) : name;
    // 扩展名本身超预算（异常输入）时放弃保留扩展名，整体截断
    const keepExtension = Buffer.byteLength(extension, 'utf8') <= maxBytes / 2;
    const budget = keepExtension ? maxBytes - Buffer.byteLength(extension, 'utf8') : maxBytes;
    let truncated = '';
    for (const char of stem) {
        if (Buffer.byteLength(truncated + char, 'utf8') > budget) {
            break;
        }
        truncated += char;
    }
    if (!truncated) {
        truncated = 'attachment';
    }
    return keepExtension ? `${truncated}${extension}` : truncated;
}

/**
 * 反馈附件文件名消毒：仅保留最后一段文件名（同时处理两种路径分隔符），
 * 替换 Windows 非法字符与尾随点/空格，规避保留设备名，超长名按字节截断，
 * 非法/空名退化为 attachment-<index>。服务端附件名可控但不可信，防御写盘失败与穿越。
 */
export function sanitizeAttachmentFilename(filename: unknown, index: number): string {
    const raw = String(filename ?? '');
    const lastSegment = raw.split(/[\\/]/).pop() ?? '';
    // 控制字符与 <>:"|?* 在 Windows 上无法创建，替换为下划线后仍可辨认原意
    let cleaned = replaceControlChars(lastSegment).replace(ILLEGAL_FILENAME_CHARS, '_').trim();
    // Windows 不允许文件名以点或空格结尾（TrimEnd 掉后 'log..' 才能落盘）
    cleaned = cleaned.replace(/[. ]+$/, '');
    if (!cleaned || cleaned === '.' || cleaned === '..') {
        return `attachment-${index}`;
    }
    // 保留设备名检查按主名（第一个点之前）进行：con / NUL.txt 都被 Windows 拒绝
    const stem = cleaned.split('.')[0].toLowerCase();
    if (WINDOWS_RESERVED_FILENAMES.has(stem)) {
        cleaned = `_${cleaned}`;
    }
    return truncateFilenameBytes(cleaned, MAX_ATTACHMENT_FILENAME_BYTES);
}

/** 判重后返回最终文件名：冲突时加 "<n>_" 前缀重试，直到没有下一次冲突；
 * 按小写比较以覆盖 Windows/macOS 大小写不敏感文件系统上的同名覆盖 */
function uniqueFilename(candidate: string, used: Set<string>): string {
    let name = candidate;
    let counter = 0;
    while (used.has(name.toLowerCase())) {
        counter += 1;
        name = truncateFilenameBytes(`${counter}_${candidate}`, MAX_ATTACHMENT_FILENAME_BYTES);
    }
    used.add(name.toLowerCase());
    return name;
}

/**
 * 「一键开发/一键修复」的附件暂存：在本次唯一暂存目录中逐个下载附件
 * （失败的跳过并记录）→ 返回正文 item 与本地附件路径。
 * 调用方（app.prepareTaskCompose）把 attachmentPaths 交给渲染层，作为新任务的附件 pill。
 */
export async function stageFeedbackAttachments(deps: StageFeedbackAttachmentsDeps): Promise<FeedbackStageResult> {
    const item = deps.item;
    const stageDir = deps.resolveStageDir();
    await deps.ensureDir(stageDir);

    const attachmentPaths: string[] = [];
    const failedFilenames: string[] = [];
    const usedNames = new Set<string>();
    // 服务端返回的 attachments 不可信：非数组（如异常字符串）会让逐字符遍历并产生一堆假失败
    const attachments = Array.isArray(item.attachments) ? item.attachments : [];
    for (let i = 0; i < attachments.length; i += 1) {
        const attachment = attachments[i];
        const displayName = typeof attachment?.filename === 'string' ? attachment.filename : '';
        const filename = uniqueFilename(sanitizeAttachmentFilename(displayName, i), usedNames);
        const destPath = path.join(stageDir, filename);
        // 服务端 attachment_id 不可信：非法 id 由 downloadAttachment 侧返回 error 并计入失败
        const result = await deps.downloadAttachment(Number(attachment?.attachment_id), destPath);
        const data = result?.data as { filePath?: string } | null | undefined;
        if (result?.status === 'ok' && data?.filePath) {
            attachmentPaths.push(data.filePath);
        } else {
            failedFilenames.push(displayName || filename);
        }
    }
    return { item, attachmentPaths, failedFilenames };
}
