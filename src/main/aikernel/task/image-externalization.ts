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

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';

import { logger } from '../../utils/logger.js';
import { getOpendeskDirectory } from '../../utils/setting.js';
import type { AssistantMessage, ChatContext } from '../messages.js';
import type { ActiveContextView } from '../compaction/types.js';
import type { AdapterMessageBuildOptions } from '../adapters/context.js';
import type { TaskState } from '../states/tasks.js';

/**
 * 工具结果图片外置（issue #341 阶段一修复）。
 *
 * 背景：ToolCall.result_object.images 直接内联完整 base64 图片，恢复大任务历史时
 * 图片随 chat_context 常驻内存并随每次保存全量序列化，是 V8 OOM 崩溃的重要放大器。
 *
 * 设计约束：
 * - image_url 原地替换为 sharp 生成的 240px 缩略图 data URL——任何既有渲染/回放
 *   消费方不需要大图即可正常显示（显示安全性）；
 * - 完整图片写入 artifacts/<taskId>/images/（内容哈希命名，幂等 + 去重），只在
 *   显式消费（点击查看 / 模型请求回灌）时从磁盘按需读取；
 * - 任一步骤失败（sharp 解码失败、写盘失败等）都保持条目内联不动，不影响工具
 *   结果本身；已经外置的条目通过 externalized 标记保证幂等。
 */

export const EXTERNALIZED_IMAGE_VERSION = 1;

/** 低于该体积的图片不值得外置（缩略图自身也要占几十 KB）。 */
export const EXTERNALIZE_IMAGE_MIN_BYTES = 16 * 1024;

/** 缩略图最长边（与用户消息图片缩略图展示尺寸一致，见 ImageMessagePart.render）。 */
const THUMBNAIL_MAX_DIMENSION = 240;

/** 缩略图大于原图该比例时放弃外置（小图外置收益过低）。 */
const EXTERNALIZE_MAX_INLINE_RATIO = 0.8;

const DATA_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;

export interface ExternalizedToolResultImage {
    version: number;
    /** 相对 OpenDesk 数据根目录的完整原图路径（artifacts/<taskId>/images/<hash>.<ext>） */
    relative_path: string;
    original_bytes: number;
    original_media_type: string;
    thumbnail_bytes: number;
}

/** 与 ToolCall.getResultImages() 返回形状一致，供适配器消费。 */
export interface ToolResultImage {
    image_url: string;
    media_type?: string;
    source?: string;
    externalized?: ExternalizedToolResultImage;
}

export interface ExternalizedImagePayload {
    dataUrl: string;
    mediaType: string;
    byteLength: number;
}

const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/avif': 'avif'
};

const IMAGE_MIME_TYPE_BY_EXTENSION: Record<string, string> = Object.fromEntries(
    Object.entries(IMAGE_EXTENSION_BY_MIME_TYPE).map(([mime, extension]) => [extension, mime])
);

export function getTaskExternalizedImageRelativeDirectory(taskId: string): string {
    return path.join('artifacts', taskId, 'images');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 判定图片条目是否已经外置（幂等守卫）。 */
export function isExternalizedToolResultImage(image: unknown): image is ToolResultImage {
    return isRecord(image) && isRecord(image.externalized) && typeof image.externalized.relative_path === 'string';
}

function collectImageEntries(resultObject: object | undefined): Record<string, unknown>[] {
    if (!isRecord(resultObject) || resultObject.type !== 'image' || !Array.isArray(resultObject.images)) {
        return [];
    }
    return resultObject.images.filter((image): image is Record<string, unknown> => isRecord(image));
}

/**
 * 外置 result_object.images 中的大图片：原地替换条目（image_url → 缩略图 + 标记），
 * 原图写入 artifacts。任何单张图片失败都不影响其他图片与工具结果本身。
 *
 * @returns 本次实际新外置的图片数量（0 表示无需变更）
 */
export async function externalizeToolResultImages(taskId: string, resultObject: object | undefined): Promise<number> {
    let externalizedCount = 0;
    for (const image of collectImageEntries(resultObject)) {
        if (isExternalizedToolResultImage(image) || typeof image.image_url !== 'string') {
            continue;
        }
        const match = DATA_URL_PATTERN.exec(image.image_url);
        if (!match) {
            // 远程 http(s) 引用或非图片 data URL：保持原样
            continue;
        }
        try {
            if (await externalizeImageEntry(taskId, match[1], match[2], image)) {
                externalizedCount++;
            }
        } catch (error) {
            logger.warn(`failed to externalize tool result image for task ${taskId}: ${error}`);
        }
    }
    return externalizedCount;
}

async function externalizeImageEntry(
    taskId: string,
    mediaType: string,
    base64Payload: string,
    image: Record<string, unknown>
): Promise<boolean> {
    const original = Buffer.from(base64Payload, 'base64');
    if (original.length < EXTERNALIZE_IMAGE_MIN_BYTES) {
        return false;
    }

    // 只外置已知可回灌的格式：未知格式（svg+xml 等）外置后扩展名映射失败，
    // 回灌会产生损坏的 data URL，保持内联更安全。
    const extension = IMAGE_EXTENSION_BY_MIME_TYPE[mediaType];
    if (!extension) {
        return false;
    }

    const thumbnail = await createThumbnail(original, mediaType);
    if (!thumbnail || thumbnail.length >= original.length * EXTERNALIZE_MAX_INLINE_RATIO) {
        // 解码失败或缩略图收益过低：保持内联，显示不受影响
        return false;
    }
    // 内容哈希命名：同一张图片重复/并发外置收敛到同一文件，天然幂等 + 去重
    const digest = crypto.createHash('sha256').update(original).digest('hex').slice(0, 24);
    const relativePath = path.join(getTaskExternalizedImageRelativeDirectory(taskId), `${digest}.${extension}`);
    const fullPath = path.join(getOpendeskDirectory(), relativePath);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    try {
        // wx 保证并发写入时后到者不覆盖先到者；EEXIST 说明内容哈希相同的文件已在
        //（其他路径刚写完同一张图），直接复用即可
        await fs.promises.writeFile(fullPath, original, { flag: 'wx' });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
    }

    image.image_url = `data:image/png;base64,${thumbnail.toString('base64')}`;
    // 约定：外置后 image_url 始终是 PNG 缩略图 data URL（自带 MIME，任何消费方无需
    // 外部信息即可解码）；条目的 media_type/source 保持原值描述"原图"，原图的
    // media type 记录在 externalized.original_media_type 中，两者不要混用。
    image.externalized = {
        version: EXTERNALIZED_IMAGE_VERSION,
        relative_path: relativePath,
        original_bytes: original.length,
        original_media_type: mediaType,
        thumbnail_bytes: thumbnail.length
    };
    return true;
}

async function createThumbnail(original: Buffer, mediaType: string): Promise<Buffer | undefined> {
    try {
        const image = sharp(original, { failOn: 'none' });
        const metadata = await image.metadata();
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;
        if (width <= 0 || height <= 0) {
            return undefined;
        }
        const scale = Math.min(THUMBNAIL_MAX_DIMENSION / width, THUMBNAIL_MAX_DIMENSION / height, 1);
        const resized = image.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
            fit: 'fill'
        });
        // JPEG 缩略图用 JPEG（体积最小）；其余（含截图文本）用 PNG 保持锐利
        return mediaType === 'image/jpeg'
            ? await resized.jpeg({ quality: 85 }).toBuffer()
            : await resized.png({ compressionLevel: 9 }).toBuffer();
    } catch (error) {
        logger.warn(`thumbnail generation failed: ${error}`);
        return undefined;
    }
}

/**
 * 一个 toolcall 结果里模型应看到的图片条目：外置条目带 marker 待读盘回灌，
 * 内联/远程条目原样透传。
 */
interface HydratableImageItem {
    image: ToolResultImage;
    marker?: ExternalizedToolResultImage;
}

/**
 * 收集一个 toolcall 的全部可回灌图片条目。消费端（messages.ts / 各 adapter）会把
 * 该列表**整体替换** getResultImages()，因此过滤规则必须与 getResultImages 完全
 * 一致（status === 'success' + data:image/ 或 http(s) URL），否则替换会丢图或多图。
 * 无外置条目时返回空列表：该 toolcall 无需回灌，消费端走 getResultImages 默认路径。
 */
function collectHydratableImageItems(toolCall: {
    status?: unknown;
    result_object?: object | undefined;
}): HydratableImageItem[] {
    if (toolCall.status !== 'success') {
        return [];
    }
    const items: HydratableImageItem[] = [];
    let hasExternalized = false;
    for (const image of collectImageEntries(toolCall.result_object)) {
        const url = image.image_url;
        if (typeof url !== 'string' || (!url.startsWith('data:image/') && !/^https?:\/\//i.test(url))) {
            continue;
        }
        const entry: ToolResultImage = {
            image_url: url,
            ...(typeof image.media_type === 'string' ? { media_type: image.media_type } : {}),
            ...(typeof image.source === 'string' ? { source: image.source } : {})
        };
        if (isExternalizedToolResultImage(image)) {
            hasExternalized = true;
            items.push({ image: entry, marker: image.externalized });
        } else {
            items.push({ image: entry });
        }
    }
    return hasExternalized ? items : [];
}

/**
 * 请求构建前按需回灌外置图片：只处理给定消息范围内的条目（活跃窗口），
 * 返回 toolCallId → 完整图片列表 的瞬态映射，供适配器整体替换 getResultImages()。
 * 列表包含该 toolcall 的全部图片（外置的从磁盘读回、内联/远程的原样透传），
 * 仅存活于单次请求构建期间，不会常驻内存。
 * 磁盘文件缺失时降级为内联缩略图，不阻塞请求。
 */
export async function hydrateExternalizedToolImages(
    chatContext: ChatContext,
    options?: { activeContext?: ActiveContextView }
): Promise<Map<string, ToolResultImage[]>> {
    const pending: { toolCallId: string; items: HydratableImageItem[] }[] = [];
    const messages = options?.activeContext?.messages ?? chatContext.messages;
    for (const message of messages) {
        if ((message as AssistantMessage).role !== 'assistant') {
            continue;
        }
        const assistant = message as AssistantMessage;
        for (const part of assistant.content) {
            if (part.type !== 'tool_call') {
                continue;
            }
            for (const toolCall of part.toolcalls) {
                const items = collectHydratableImageItems(toolCall);
                if (items.length > 0) {
                    pending.push({ toolCallId: toolCall.id, items });
                }
            }
        }
    }
    if (pending.length === 0) {
        return new Map();
    }

    const hydrated = new Map<string, ToolResultImage[]>();
    for (const { toolCallId, items } of pending) {
        const loaded: ToolResultImage[] = [];
        for (const item of items) {
            let dataUrl = item.image.image_url;
            if (item.marker) {
                try {
                    dataUrl = (await readExternalizedImageByRelativePath(item.marker.relative_path)).dataUrl;
                } catch (error) {
                    logger.warn(`failed to load externalized image ${item.marker.relative_path}: ${error}`);
                    // 磁盘文件丢失：dataUrl 保持条目内的内联缩略图（显示安全兜底）
                }
            }
            loaded.push({ ...item.image, image_url: dataUrl });
        }
        hydrated.set(toolCallId, loaded);
    }
    return hydrated;
}

/**
 * 请求构建入口的统一回灌：adapter 的 complete/stream 等入口在调用 buildMessages 前
 * 通过本函数把外置图片按需读回（仅 supportsVision 且活跃窗口存在外置条目时产生 IO；
 * 无外置条目时只做一次同步遍历，无磁盘访问）。
 */
export async function withHydratedToolImages(
    chatContext: ChatContext,
    supportsVision: boolean,
    options: AdapterMessageBuildOptions = {}
): Promise<AdapterMessageBuildOptions> {
    if (!supportsVision) {
        return options;
    }
    const hydratedToolImages = await hydrateExternalizedToolImages(chatContext, options);
    if (hydratedToolImages.size === 0) {
        return options;
    }
    return { ...options, hydratedToolImages };
}

/** 校验 relative_path 落在 artifacts/<taskId>/images/ 内并读取完整图片。 */
export async function readExternalizedImageFile(
    taskId: string,
    relativePath: string
): Promise<ExternalizedImagePayload> {
    const dataRoot = getOpendeskDirectory();
    const resolved = path.resolve(dataRoot, relativePath);
    const expectedPrefix = path.resolve(dataRoot, getTaskExternalizedImageRelativeDirectory(taskId)) + path.sep;
    if (!resolved.startsWith(expectedPrefix)) {
        throw new Error(`externalized image path is outside the task image directory: ${relativePath}`);
    }
    return readExternalizedImageByRelativePath(relativePath);
}

async function readExternalizedImageByRelativePath(relativePath: string): Promise<ExternalizedImagePayload> {
    const fullPath = path.join(getOpendeskDirectory(), relativePath);
    const input = await fs.promises.readFile(fullPath);
    // 文件名由外置流程以 media type 对应的扩展名生成，回灌时直接取扩展名
    const extension = path.extname(relativePath).slice(1).toLowerCase();
    const mediaType = IMAGE_MIME_TYPE_BY_EXTENSION[extension] ?? 'image/png';
    return {
        dataUrl: `data:${mediaType};base64,${input.toString('base64')}`,
        mediaType,
        byteLength: input.length
    };
}

/**
 * 旧任务文件迁移：把 chat_context 中仍内联的大图片外置（幂等）。
 * load 路径是同步的（JSON.parse 全量文件），因此迁移以 fire-and-forget 方式
 * 在 applyTaskJson 末尾触发，完成后标记脏任务等待下一次落盘瘦身。
 */
export async function migrateInlineToolResultImages(task: TaskState): Promise<number> {
    if (!task.task_id) {
        return 0;
    }
    let migrated = 0;
    for (const message of task.chat_context.messages) {
        if ((message as AssistantMessage).role !== 'assistant') {
            continue;
        }
        const assistant = message as AssistantMessage;
        for (const part of assistant.content) {
            if (part.type !== 'tool_call') {
                continue;
            }
            for (const toolCall of part.toolcalls) {
                try {
                    migrated += await externalizeToolResultImages(task.task_id, toolCall.result_object);
                } catch (error) {
                    logger.warn(`image migration failed for task ${task.task_id} toolcall ${toolCall.id}: ${error}`);
                }
            }
        }
    }
    if (migrated > 0) {
        logger.info(`externalized ${migrated} inline tool result image(s) for task ${task.task_id}`);
        if (task.task_manager_state.tasks.includes(task)) {
            task.persistLater();
        }
    }
    return migrated;
}

export interface ExternalizedImageRewireResult {
    /** 改写为本任务命名空间的 marker 数量 */
    rewritten: number;
    /** 改写后在本任务 images/ 目录就位的文件数（新复制或本已存在） */
    present: number;
    /** 源文件缺失、只改写未复制的 marker 数量（如跨机器导入的悬空引用） */
    missing: number;
}

/**
 * fork 等 chat_context 跨任务克隆的收尾（copy-on-fork）：继承的外置图片 marker
 * 指向源任务的 artifacts/<源taskId>/images/，直接使用有两个问题——源任务删除时
 * cleanup() 会连同 artifacts 一起清掉（原图悬空），且 IPC 读取的路径围栏只放行
 * 本任务目录（点击查看必然报错）。本函数把 marker 全部改写到目标任务自己的
 * images/ 命名空间并复制源文件；内容哈希命名使同名即同内容，跨任务去重天然成立。
 *
 * 源文件缺失（跨机器导入的悬空引用）时只改写不复制，行为与改写前一致
 * （回灌降级为内联缩略图）。同步复制：fork 本身已是同步重操作，且图片字节数
 * 不会超过任务 JSON 已驻留内存的字节数。
 */
export function rewireExternalizedImagesForTask(
    chatContext: ChatContext,
    taskId: string
): ExternalizedImageRewireResult {
    const result: ExternalizedImageRewireResult = { rewritten: 0, present: 0, missing: 0 };
    const dataRoot = getOpendeskDirectory();
    const ownRelativeDirectory = getTaskExternalizedImageRelativeDirectory(taskId);
    for (const message of chatContext.messages) {
        if ((message as AssistantMessage).role !== 'assistant') {
            continue;
        }
        const assistant = message as AssistantMessage;
        for (const part of assistant.content) {
            if (part.type !== 'tool_call') {
                continue;
            }
            for (const toolCall of part.toolcalls) {
                for (const image of collectImageEntries(toolCall.result_object)) {
                    if (!isExternalizedToolResultImage(image) || !image.externalized) {
                        continue;
                    }
                    const marker = image.externalized;
                    // 文件名是内容哈希，跨任务同名即同内容；只改写目录归属
                    const targetRelative = path.join(ownRelativeDirectory, path.basename(marker.relative_path));
                    const sourceAbsolute = path.resolve(dataRoot, marker.relative_path);
                    const targetAbsolute = path.join(dataRoot, targetRelative);
                    if (sourceAbsolute === targetAbsolute) {
                        continue;
                    }
                    marker.relative_path = targetRelative;
                    result.rewritten++;
                    try {
                        fs.mkdirSync(path.dirname(targetAbsolute), { recursive: true });
                        // EXCL 防止并发/重复 fork 覆盖；EEXIST 说明目标已有同内容文件
                        fs.copyFileSync(sourceAbsolute, targetAbsolute, fs.constants.COPYFILE_EXCL);
                        result.present++;
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                            result.present++;
                        } else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                            result.missing++;
                        } else {
                            result.missing++;
                            logger.warn(
                                `failed to copy externalized image ${marker.relative_path} for task ${taskId}: ${error}`
                            );
                        }
                    }
                }
            }
        }
    }
    return result;
}
