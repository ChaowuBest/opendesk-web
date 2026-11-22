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

import { logger } from '../../utils/logger.js';
import { getOpendeskDirectory } from '../../utils/setting.js';
import { isSafeArtifactRelativePath } from '../../utils/artifact-relative-path.js';
import { readImageDimensions } from '../../utils/image-dimensions.js';
import { jimpLoader } from '../../loader/jimp.js';
import type { AssistantMessage, ChatContext } from '../messages.js';
import { ToolCall } from '../messages.js';
import { isToolCallResultCompressed } from '../tool-result-content.js';
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
 * - 只外置已被压缩接管（result_storage / microcompact / legacy compress_id）条目的
 *   图片：压缩后模型可见内容不再依赖 result 本体，外置才是纯收益。未压缩条目保持
 *   内联——活跃窗口内的图片本就要随每次请求发给模型，外置会让请求构建期的回灌
 *   读盘成为常态；条目被压缩接管后由请求准备收尾（migrateInlineToolResultImages）
 *   与提交接缝补外置；
 * - image_url 原地替换为 240px 缩略图 data URL（纯 JS 的 jimp 生成，见 createThumbnail，
 *   不引入原生依赖；JPEG 源编码 JPEG、其余编码 PNG，前缀 MIME 与字节一致）——任何
 *   既有渲染/回放消费方不需要大图即可正常显示（显示安全性）；
 * - 完整图片写入 artifacts/<taskId>/images/（内容哈希命名，幂等 + 去重），只在
 *   显式消费（点击查看 / 模型请求回灌）时从磁盘按需读取；
 * - 解码前按文件头做像素上限判断（jimp 无 sharp 的 limitInputPixels 兜底），
 *   超限保持内联，避免压缩炸弹把本模块要消灭的 OOM 换个形态带回来；
 * - 任一步骤失败（解码失败、写盘失败等）都保持条目内联不动，不影响工具
 *   结果本身；已经外置的条目通过 externalized 标记保证幂等，外置失败的条目
 *   记入进程内 WeakSet 不再重试（条目生命周期内不会变得可外置）。
 */

export const EXTERNALIZED_IMAGE_VERSION = 1;

/** 低于该体积的图片不值得外置（缩略图自身也要占几十 KB）。 */
export const EXTERNALIZE_IMAGE_MIN_BYTES = 16 * 1024;

/** 缩略图最长边（与用户消息图片缩略图展示尺寸一致，见 ImageMessagePart.render）。 */
const THUMBNAIL_MAX_DIMENSION = 240;

/** 缩略图大于原图该比例时放弃外置（小图外置收益过低）。 */
const EXTERNALIZE_MAX_INLINE_RATIO = 0.8;

/** 解码前的像素上限（对齐 filemgr 的 MAX_IMAGE_PIXELS）：超限图片保持内联。 */
const THUMBNAIL_MAX_PIXELS = 100_000_000;

/** 外置失败/收益不足的图片条目：条目生命周期内不再重试（WeakSet 不阻止回收）。 */
const externalizationSkipped = new WeakSet<object>();

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

// jimp 可解码 png/jpeg/bmp/gif/tiff（webp/avif 解码失败走「保持内联」降级，含读取
// 回灌兼容旧版生成的 webp artifacts，映射表保留）。未知格式（svg+xml 等）同样保持内联。
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

/**
 * 只外置已压缩工具调用（result 已被 compact 主流程 / budget / microcompact / legacy
 * compress_id 接管）的大图，未压缩条目一律内联：活跃窗口内的图片本就要随每次请求
 * 发给模型，外置会让请求构建期的回灌读盘成为常态；压缩后模型可见内容不再依赖
 * result 本体，外置才是纯收益。
 */
async function externalizeCompressedToolCallImages(taskId: string, toolCall: ToolCall): Promise<number> {
    if (!isToolCallResultCompressed(toolCall)) {
        return 0;
    }
    return externalizeToolResultImages(taskId, toolCall.result_object);
}

async function externalizeImageEntry(
    taskId: string,
    mediaType: string,
    base64Payload: string,
    image: Record<string, unknown>
): Promise<boolean> {
    // 外置失败的条目不再重试：解码失败/收益不足的图片在条目的生命周期内不会变得可外置，
    // 重复尝试只会在每轮请求准备路径上白付 jimp 解码成本（WeakSet 随条目对象回收）
    if (externalizationSkipped.has(image)) {
        return false;
    }
    const original = Buffer.from(base64Payload, 'base64');
    if (original.length < EXTERNALIZE_IMAGE_MIN_BYTES) {
        externalizationSkipped.add(image);
        return false;
    }

    // 只外置已知可回灌的格式：未知格式（svg+xml 等）外置后扩展名映射失败，
    // 回灌会产生损坏的 data URL，保持内联更安全。
    const extension = IMAGE_EXTENSION_BY_MIME_TYPE[mediaType];
    if (!extension) {
        externalizationSkipped.add(image);
        return false;
    }

    const thumbnail = await createThumbnail(original, mediaType);
    if (!thumbnail || thumbnail.bytes.length >= original.length * EXTERNALIZE_MAX_INLINE_RATIO) {
        // 解码失败或缩略图收益过低：保持内联，显示不受影响
        externalizationSkipped.add(image);
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

    image.image_url = `data:${thumbnail.mimeType};base64,${thumbnail.bytes.toString('base64')}`;
    // 约定：外置后 image_url 是缩略图 data URL，前缀 MIME 与缩略图字节编码一致
    // （jpeg 源编码 JPEG、其余编码 PNG）；条目的 media_type/source 保持原值描述"原图"，
    // 原图的 media type 记录在 externalized.original_media_type 中，两者不要混用。
    image.externalized = {
        version: EXTERNALIZED_IMAGE_VERSION,
        relative_path: relativePath,
        original_bytes: original.length,
        original_media_type: mediaType,
        thumbnail_bytes: thumbnail.bytes.length
    };
    return true;
}

async function createThumbnail(
    original: Buffer,
    mediaType: string
): Promise<{ bytes: Buffer; mimeType: string } | undefined> {
    try {
        // 解码前先按文件头做像素上限判断：压缩炸弹类图片字节很小但声明尺寸巨大，
        // 一旦进入 jimp 解码就会按 width*height*4 分配位图（sharp 默认有
        // limitInputPixels 兜底，纯 JS 的 jimp 没有），正是本模块要避免的 OOM 形态。
        // 文件头无法识别（如损坏数据）时交给下面的 jimp 解码失败路径处理
        const dimensions = readImageDimensions(original, mediaType);
        if (dimensions !== undefined && dimensions.width * dimensions.height > THUMBNAIL_MAX_PIXELS) {
            return undefined;
        }
        // 纯 JS 解码（jimp，与 filemgr/processImageWithJimp 同一套惰性加载）；
        // jimp 不支持 webp/avif，这两类源图在此处解码失败后由调用方保持内联
        const Jimp = await jimpLoader.ensure();
        const image = await Jimp.read(original);
        const width = image.width;
        const height = image.height;
        if (width <= 0 || height <= 0) {
            return undefined;
        }
        const scale = Math.min(THUMBNAIL_MAX_DIMENSION / width, THUMBNAIL_MAX_DIMENSION / height, 1);
        image.resize({
            w: Math.max(1, Math.round(width * scale)),
            h: Math.max(1, Math.round(height * scale))
        });
        // 缩略图编码跟随源图：JPEG 源用 JPEG（240px 照片缩略图只有 PNG 的零头体积，
        // 否则收益比判定会把一批中等 JPEG 直接挡在门外）；其余用 PNG 保持锐利。
        // 编码结果与 image_url 前缀 MIME 必须一致，见 externalizeImageEntry。
        if (mediaType === 'image/jpeg') {
            return { bytes: await image.getBuffer('image/jpeg', { quality: 85 }), mimeType: 'image/jpeg' };
        }
        return { bytes: await image.getBuffer('image/png'), mimeType: 'image/png' };
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
 *
 * 安全（路径穿越防护）：relative_path 随任务 JSON 持久化，可被恶意导入包构造成
 * 指向数据根之外的穿越/绝对路径；回灌读取会把文件内容 base64 进 data URL 发给
 * 模型服务（本机文件外泄通道）。因此每个条目读取前必须通过目录校验：
 * - 请求携带 taskId（正常任务请求构建链路必然携带）→ 必须落在当前任务的
 *   artifacts/<taskId>/images/ 内；
 * - 无 taskId（理论兜底）→ 至少通过 artifacts/<taskId>/images/ 的形状校验。
 */
export async function hydrateExternalizedToolImages(
    chatContext: ChatContext,
    options?: { activeContext?: ActiveContextView; taskId?: string }
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
                    dataUrl = (await readExternalizedImageForHydration(item.marker.relative_path, options?.taskId))
                        .dataUrl;
                } catch (error) {
                    logger.warn(`failed to load externalized image ${item.marker.relative_path}: ${error}`);
                    // 磁盘文件丢失或路径越界：dataUrl 保持条目内的内联缩略图（显示安全兜底）
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
    assertExternalizedImagePathWithinTask(getOpendeskDirectory(), taskId, relativePath);
    return readExternalizedImageByRelativePath(relativePath);
}

/**
 * 校验 relative_path 解析后必须落在当前任务的 artifacts/<taskId>/images/ 目录内
 * （同步、无副作用，IPC 显示与模型回灌两条读取路径共用）。
 */
function assertExternalizedImagePathWithinTask(dataRoot: string, taskId: string, relativePath: string): void {
    // 围栏基准不能被被校验方决定：taskId 随 IPC 载荷传入，含 `..` 会把 expectedPrefix
    // 抬升到数据根之外（先过与产物路径一致的 id 形状校验）
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) {
        throw new Error(`externalized image request has malformed task id: ${JSON.stringify(taskId)}`);
    }
    const resolved = path.resolve(dataRoot, relativePath);
    const expectedPrefix = path.resolve(dataRoot, getTaskExternalizedImageRelativeDirectory(taskId)) + path.sep;
    if (!resolved.startsWith(expectedPrefix)) {
        throw new Error(`externalized image path is outside the task image directory: ${relativePath}`);
    }
}

/**
 * 模型回灌读取入口：与 IPC 显示路径同一套穿越防护。
 * - 请求携带 taskId → 严格限制在当前任务的 images 目录；
 * - 无 taskId（兜底）→ 至少要求 artifacts/<taskId>/images/ 形状合法，
 *   拒绝任何穿越段与绝对路径。
 */
async function readExternalizedImageForHydration(
    relativePath: string,
    taskId?: string
): Promise<ExternalizedImagePayload> {
    if (taskId !== undefined) {
        assertExternalizedImagePathWithinTask(getOpendeskDirectory(), taskId, relativePath);
    } else if (!isSafeArtifactRelativePath(relativePath, 'images')) {
        throw new Error(`externalized image path failed the artifact path shape check: ${relativePath}`);
    }
    return readExternalizedImageByRelativePath(relativePath);
}

async function readExternalizedImageByRelativePath(relativePath: string): Promise<ExternalizedImagePayload> {
    // 最后一道保险：无论上游校验如何，读取目标必须在数据根的 artifacts/ 内
    const dataRoot = getOpendeskDirectory();
    const fullPath = path.resolve(dataRoot, relativePath);
    const artifactsRoot = path.resolve(dataRoot, 'artifacts') + path.sep;
    if (!fullPath.startsWith(artifactsRoot)) {
        throw new Error(`externalized image path is outside the artifacts directory: ${relativePath}`);
    }
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
 * 已压缩工具调用中仍内联的大图补外置（幂等，issue #341）。
 *
 * 未压缩条目不外置——活跃窗口内的图片本就要随每次请求发给模型，外置只会让请求
 * 构建期产生回灌读盘；条目被压缩接管后模型可见内容不再依赖 result 本体，此时外置
 * 才是纯收益。两个触发时机共用本函数：
 * - 旧任务文件 load 后的迁移（applyTaskJson 末尾 fire-and-forget）；
 * - 请求准备（budget/microcompact/compact）刚压缩接管条目后的补外置（completion.ts）。
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
                    migrated += await externalizeCompressedToolCallImages(task.task_id, toolCall);
                } catch (error) {
                    logger.warn(
                        `compressed tool result image externalization failed for task ${task.task_id} ` +
                            `toolcall ${toolCall.id}: ${error}`
                    );
                }
            }
        }
    }
    if (migrated > 0) {
        logger.info(`externalized ${migrated} inline tool result image(s) for task ${task.task_id}`);
        // 防泄漏：任务已不在 manager（正在被移除）时不再标记脏任务，避免重载后
        // 指向已删除任务的落盘写入
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
