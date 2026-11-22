import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import sharp from 'sharp';

import { AssistantMessage, ChatContext, ToolCall, ToolCallMessagePart } from '../../../../main/aikernel/messages.js';
import {
    EXTERNALIZE_IMAGE_MIN_BYTES,
    externalizeToolResultImages,
    hydrateExternalizedToolImages,
    readExternalizedImageFile,
    withHydratedToolImages
} from '../../../../main/aikernel/task/image-externalization.js';
import { deserializeTaskData, forkTask } from '../../../../main/aikernel/task/serializer.js';
import { TaskManagerState, TaskState } from '../../../../main/aikernel/states/tasks.js';
import { getTaskArtifactDirectory, setCustomOpendeskDirectory } from '../../../../main/utils/setting.js';

/**
 * Issue #341 修复（阶段一）的工具结果图片外置：
 * - result_object.images 中的大 data URL 外置到 artifacts/<taskId>/images/，
 *   原位替换为缩略图 + externalized 标记；
 * - 模型请求构建前按需从磁盘回灌完整图片（活跃窗口内），内存只保留请求期瞬态；
 * - 旧任务文件在 load 后异步迁移（幂等），迁移后落盘体积显著下降。
 * 显示安全性：image_url 始终是合法 data URL（缩略图），任何既有渲染/回放消费方
 * 不需要大图即可正常显示；完整图片只在显式读取（点击查看/模型请求）时从磁盘加载。
 *
 * 缩略图由 jimp（纯 JS，真实执行不 mock）生成：png/jpeg/bmp/gif/tiff 可解码；
 * webp/avif/svg+xml 等解码失败走「保持内联」降级。
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

let dataDir: string | undefined;

function setDataDir(dir: string | undefined): void {
    dataDir = dir;
    setCustomOpendeskDirectory(dir);
}

before(() => {
    setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-image-externalization-')));
});

after(() => {
    if (dataDir && fs.existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
    setDataDir(undefined);
});

/** 生成带真随机噪点的 PNG（周期性模式会被 PNG 压缩到阈值以下，无法触发外置） */
async function createNoisyPng(width: number, height: number): Promise<Buffer> {
    const raw = crypto.randomBytes(width * height * 3);
    return await sharp(raw, { raw: { width, height, channels: 3 } })
        .png()
        .toBuffer();
}

function withImageDataUrl(buffer: Buffer): string {
    return `data:image/png;base64,${buffer.toString('base64')}`;
}

interface FixtureImageEntry {
    image_url: string;
    media_type?: string;
    source?: string;
    externalized?: Record<string, unknown>;
}

function buildImageResultObject(images: FixtureImageEntry[]): object {
    return { type: 'image', images };
}

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
 * 构造声明尺寸巨大、磁盘字节很小的 PNG（压缩炸弹画像）：IHDR 声明 width/height，
 * 内容由辅助 tEXt 块撑过外置阈值（16KB），IDAT 只有几个字节。解码器若按其声明
 * 尺寸分配位图会直接 OOM，必须由文件头像素上限挡在解码之前。
 */
function buildDeclaredDimensionPng(width: number, height: number, fillerBytes = 20 * 1024): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type: RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('tEXt', Buffer.alloc(fillerBytes, 0x61)),
        pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0]))),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

async function buildToolCallWithImages(images: FixtureImageEntry[]): Promise<{ call: ToolCall; taskId: string }> {
    const taskId = `img-ext-${Math.random().toString(36).slice(2, 8)}`;
    const call = new ToolCall(0, `call-${taskId}`, 'readImage', '{}');
    call.status = 'success';
    call.result_object = buildImageResultObject(images);
    await externalizeToolResultImages(taskId, call.result_object);
    return { call, taskId };
}

test('big inline data URLs are externalized to artifacts with a small thumbnail kept inline', async () => {
    const original = await createNoisyPng(600, 400);
    assert.ok(original.length > EXTERNALIZE_IMAGE_MIN_BYTES, 'fixture must exceed the externalize threshold');

    const { call, taskId } = await buildToolCallWithImages([
        { image_url: withImageDataUrl(original), media_type: 'image/png', source: 'fixture' }
    ]);

    const entry = (call.result_object as { images: FixtureImageEntry[] }).images[0];
    // 原位替换：image_url 变成合法的小缩略图 data URL
    assert.match(entry.image_url, /^data:image\/png;base64,/);
    const thumbnailBytes = Buffer.from(entry.image_url.slice(entry.image_url.indexOf(',') + 1), 'base64').length;
    assert.ok(
        thumbnailBytes < original.length * 0.2,
        `thumbnail ${thumbnailBytes}B should be much smaller than ${original.length}B`
    );

    // externalized 标记携带完整回溯信息
    assert.ok(entry.externalized, 'externalized marker must be present');
    assert.equal(entry.externalized?.version, 1);
    assert.equal(entry.externalized?.original_bytes, original.length);
    assert.equal(entry.externalized?.original_media_type, 'image/png');
    assert.equal(entry.externalized?.thumbnail_bytes, thumbnailBytes);
    assert.equal(entry.media_type, 'image/png', 'entry metadata must be preserved');
    assert.equal(entry.source, 'fixture');

    // 原始图片已写入 artifacts/<taskId>/images/，字节与原文一致
    const relativePath = entry.externalized?.relative_path as string;
    assert.match(relativePath, /^artifacts[/\\].*[/\\]images[/\\]/);
    const fullPath = path.join(dataDir!, relativePath);
    assert.ok(fs.existsSync(fullPath), 'externalized image file must exist');
    assert.ok(Buffer.compare(fs.readFileSync(fullPath), original) === 0, 'stored bytes must match the original');
    assert.equal(path.dirname(fullPath), path.join(getTaskArtifactDirectory(taskId, false), 'images'));
});

test('small images stay inline without touching the artifacts directory', async () => {
    const tiny = await sharp({
        create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } }
    })
        .png()
        .toBuffer();
    assert.ok(tiny.length < EXTERNALIZE_IMAGE_MIN_BYTES);

    const { call } = await buildToolCallWithImages([{ image_url: withImageDataUrl(tiny), media_type: 'image/png' }]);
    const entry = (call.result_object as { images: FixtureImageEntry[] }).images[0];
    assert.equal(entry.externalized, undefined, 'small image must stay inline');
    assert.equal(entry.image_url, withImageDataUrl(tiny));
});

test('corrupted image data keeps the entry inline instead of throwing', async () => {
    const corrupted = `data:image/png;base64,${Buffer.from('this is not an image at all').toString('base64')}`;
    const { call } = await buildToolCallWithImages([{ image_url: corrupted, media_type: 'image/png' }]);
    const entry = (call.result_object as { images: FixtureImageEntry[] }).images[0];
    assert.equal(entry.externalized, undefined, 'corrupted image must stay inline');
    assert.equal(entry.image_url, corrupted);
});

test('webp sources keep the entry inline (jimp cannot decode webp thumbnails)', async () => {
    // 缩略图由纯 JS 的 jimp 生成（不含 webp 解码器）：webp 源图走「解码失败 →
    // 保持内联」降级，无 externalized marker、image_url 原样保留
    const webpPayload = Buffer.from('RIFF....WEBPVP8 not really decodable here'.repeat(512));
    const webpDataUrl = `data:image/webp;base64,${webpPayload.toString('base64')}`;
    assert.ok(webpDataUrl.length > EXTERNALIZE_IMAGE_MIN_BYTES, 'fixture must exceed the externalize threshold');
    const { call, taskId } = await buildToolCallWithImages([{ image_url: webpDataUrl, media_type: 'image/webp' }]);
    const entry = (call.result_object as { images: FixtureImageEntry[] }).images[0];
    assert.equal(entry.externalized, undefined, 'webp source must stay inline');
    assert.equal(entry.image_url, webpDataUrl);
    assert.equal(
        fs.existsSync(path.join(getTaskArtifactDirectory(taskId, false), 'images'))
            ? fs.readdirSync(path.join(getTaskArtifactDirectory(taskId, false), 'images')).length
            : 0,
        0,
        'no artifact file may be written for a webp source'
    );
});

test('thumbnail data URL prefix always matches the encoded bytes (jpeg source keeps a jpeg thumbnail)', async () => {
    // 缩略图编码跟随源图：jpeg 源编码 JPEG（240px 照片缩略图只有 PNG 的零头体积，
    // 否则收益比判定会把一批中等 JPEG 挡在门外）；data URL 前缀必须与字节一致，
    // 依赖 MIME 标签而非内容嗅探的消费方才能正确解码
    const original = await sharp(crypto.randomBytes(1600 * 1200 * 3), {
        raw: { width: 1600, height: 1200, channels: 3 }
    })
        .jpeg({ quality: 95 })
        .toBuffer();
    assert.ok(original.length > EXTERNALIZE_IMAGE_MIN_BYTES, 'jpeg fixture must exceed the externalize threshold');
    const { call, taskId } = await buildToolCallWithImages([
        { image_url: `data:image/jpeg;base64,${original.toString('base64')}`, media_type: 'image/jpeg' }
    ]);
    const entry = (call.result_object as { images: FixtureImageEntry[] }).images[0];
    assert.ok(entry.externalized, 'large jpeg source must be externalized');
    assert.match(entry.image_url, /^data:image\/jpeg;base64,/);
    const jpegSignature = Buffer.from([0xff, 0xd8, 0xff]);
    const thumbnailBytes = Buffer.from(String(entry.image_url).split(',')[1], 'base64');
    assert.deepEqual(
        thumbnailBytes.subarray(0, jpegSignature.length),
        jpegSignature,
        'thumbnail payload must be JPEG bytes'
    );
    assert.equal(
        fs.readFileSync(
            path.join(
                getTaskArtifactDirectory(taskId, false),
                'images',
                path.basename(entry.externalized.relative_path)
            )
        ).length,
        entry.externalized.original_bytes
    );
});

test('a pixel bomb (tiny bytes, huge declared dimensions) stays inline instead of OOMing the decoder', async () => {
    // jimp 没有 sharp 的 limitInputPixels 兜底：声明 30000x30000 的 PNG 字节极小，
    // 但解码会按 width*height*4 分配 ~3.6GB 位图。文件头像素上限必须把它挡在解码之前
    const png = buildDeclaredDimensionPng(30000, 30000);
    assert.ok(png.length < EXTERNALIZE_IMAGE_MIN_BYTES * 4, 'fixture must stay small on disk');
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const { call, taskId } = await buildToolCallWithImages([{ image_url: dataUrl, media_type: 'image/png' }]);
    const entry = (call.result_object as { images: FixtureImageEntry[] }).images[0];
    assert.equal(entry.externalized, undefined, 'pixel bomb must stay inline');
    assert.equal(entry.image_url, dataUrl);
    assert.equal(
        fs.existsSync(path.join(getTaskArtifactDirectory(taskId, false), 'images'))
            ? fs.readdirSync(path.join(getTaskArtifactDirectory(taskId, false), 'images')).length
            : 0,
        0,
        'no artifact file may be written for a pixel bomb'
    );
});

test('externalization is idempotent: already externalized entries are never rewritten', async () => {
    const original = await createNoisyPng(600, 400);
    const { call, taskId } = await buildToolCallWithImages([
        { image_url: withImageDataUrl(original), media_type: 'image/png' }
    ]);
    const entry = (call.result_object as { images: FixtureImageEntry[] }).images[0];
    const externalizedBefore = { ...entry.externalized };
    const imageUrlBefore = entry.image_url;

    await externalizeToolResultImages(taskId, call.result_object);

    assert.deepEqual(entry.externalized, externalizedBefore);
    assert.equal(entry.image_url, imageUrlBefore);
});

test('remote http(s) image references are left untouched', async () => {
    const { call } = await buildToolCallWithImages([
        { image_url: 'https://example.com/picture.png', media_type: 'image/png' }
    ]);
    const entry = (call.result_object as { images: FixtureImageEntry[] }).images[0];
    assert.equal(entry.externalized, undefined);
    assert.equal(entry.image_url, 'https://example.com/picture.png');
});

test('hydration loads the full image from disk for externalized entries and falls back to the thumbnail', async () => {
    const original = await createNoisyPng(600, 400);
    const { call } = await buildToolCallWithImages([
        { image_url: withImageDataUrl(original), media_type: 'image/png', source: 'fixture' }
    ]);

    const context = new ChatContext();
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(call);
    assistant.content.push(part);
    context.appendMessage(assistant);

    const hydrated = await hydrateExternalizedToolImages(context);
    const hydratedImages = hydrated.get(call.id);
    assert.ok(hydratedImages && hydratedImages.length === 1, 'hydrated map must contain the toolcall images');
    assert.equal(hydratedImages[0].image_url, withImageDataUrl(original), 'full image must be restored from disk');

    // 磁盘文件丢失时降级为缩略图，不抛错
    const entry = (call.result_object as { images: FixtureImageEntry[] }).images[0];
    fs.unlinkSync(path.join(dataDir!, entry.externalized?.relative_path as string));
    const degraded = await hydrateExternalizedToolImages(context);
    const degradedImages = degraded.get(call.id);
    assert.ok(degradedImages && degradedImages.length === 1);
    assert.equal(degradedImages[0].image_url, entry.image_url, 'missing file must fall back to the inline thumbnail');
});

test('hydration ignores tasks without externalized images (no disk IO)', async () => {
    const context = new ChatContext();
    context.appendMessage(new AssistantMessage());
    const hydrated = await hydrateExternalizedToolImages(context);
    assert.equal(hydrated.size, 0);
});

test('hydration preserves inline and remote sibling images of an externalized entry', async () => {
    const original = await createNoisyPng(600, 400);
    const tiny = await sharp({
        create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } }
    })
        .png()
        .toBuffer();
    const { call } = await buildToolCallWithImages([
        { image_url: withImageDataUrl(original), media_type: 'image/png', source: 'big' },
        { image_url: withImageDataUrl(tiny), media_type: 'image/png', source: 'tiny-inline' },
        { image_url: 'https://example.com/remote.png', media_type: 'image/png', source: 'remote' }
    ]);

    // 回灌映射整体替换 getResultImages()，因此条目数与顺序必须与其完全一致
    const beforeHydration = call.getResultImages();
    assert.equal(beforeHydration.length, 3, 'fixture precondition: big + tiny + remote all visible');

    const context = new ChatContext();
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(call);
    assistant.content.push(part);
    context.appendMessage(assistant);

    const hydrated = await hydrateExternalizedToolImages(context);
    const hydratedImages = hydrated.get(call.id);
    assert.ok(hydratedImages, 'externalized toolcall must be hydrated');
    assert.equal(hydratedImages.length, beforeHydration.length, 'sibling images must not be dropped');
    assert.equal(hydratedImages[0].source, 'big');
    assert.equal(hydratedImages[0].image_url, withImageDataUrl(original), 'big image must be restored from disk');
    assert.equal(hydratedImages[1].source, 'tiny-inline');
    assert.equal(hydratedImages[1].image_url, withImageDataUrl(tiny), 'inline sibling must be passed through');
    assert.equal(hydratedImages[2].source, 'remote');
    assert.equal(
        hydratedImages[2].image_url,
        'https://example.com/remote.png',
        'remote sibling must be passed through'
    );
});

test('hydration skips toolcalls whose status is not success (mirrors getResultImages)', async () => {
    const original = await createNoisyPng(600, 400);
    const { call } = await buildToolCallWithImages([
        { image_url: withImageDataUrl(original), media_type: 'image/png' }
    ]);
    call.status = 'error';

    const context = new ChatContext();
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(call);
    assistant.content.push(part);
    context.appendMessage(assistant);

    const hydrated = await hydrateExternalizedToolImages(context);
    assert.equal(hydrated.size, 0, 'failed toolcalls must not be hydrated: getResultImages also returns nothing');
});

test('legacy task files shrink after load-time migration and stay loadable', async () => {
    const imageA = await createNoisyPng(600, 400);
    const imageB = await createNoisyPng(500, 380);
    const inlineBytes = imageA.length + imageB.length;

    const manager = new TaskManagerState();
    const task = new TaskState(manager);
    task.task_id = 'img-migration-legacy';
    task.task_name = 'legacy with inline images';
    task.task_status = 'failed';
    const call = new ToolCall(0, 'call-legacy-0', 'readImage', '{}');
    call.status = 'success';
    // 旧任务真实画像：文本结果已被压缩接管（result_storage 在册），图片仍内联
    call.result_storage = { result_id: 'result-legacy-0', storage_version: 1 };
    call.result_object = buildImageResultObject([
        { image_url: withImageDataUrl(imageA), media_type: 'image/png', source: 'a' },
        { image_url: withImageDataUrl(imageB), media_type: 'image/png', source: 'b' }
    ]);
    // 同任务里的未压缩条目：迁移必须保持其图片内联（活跃窗口内每轮请求都要发送，
    // 外置只会引入请求构建期的回灌读盘）
    const freshCall = new ToolCall(1, 'call-legacy-1', 'readImage', '{}');
    freshCall.status = 'success';
    freshCall.result_object = buildImageResultObject([
        { image_url: withImageDataUrl(imageA), media_type: 'image/png', source: 'fresh' }
    ]);
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(call, freshCall);
    assistant.content.push(part);
    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(assistant);
    manager.tasks.push(task);
    manager.saveSync();

    const taskFile = path.join(dataDir!, 'tasks', `${task.task_id}.json`);
    const legacyBytes = fs.statSync(taskFile).size;
    assert.ok(legacyBytes > inlineBytes, 'legacy file must contain the inline image bytes');

    // 模拟实机恢复路径：懒加载索引 + ensureLoaded（applyTaskJson 触发迁移）
    const reloaded = TaskManagerState.load()!;
    const restored = reloaded.getTask('img-migration-legacy')!;
    await restored.pendingImageMigration();

    reloaded.saveSync();
    const migratedBytes = fs.statSync(taskFile).size;
    // 迁移后已压缩条目的图片仅剩缩略图内联：体积必须显著低于旧文件
    assert.ok(
        migratedBytes < legacyBytes * 0.75,
        `migrated file ${migratedBytes}B should be well below legacy ${legacyBytes}B`
    );

    // 迁移结果必须可重新加载且图片条目带完整标记
    const secondLoad = TaskManagerState.load()!;
    const secondTask = secondLoad.getTask('img-migration-legacy')!;
    const migratedCalls = (secondTask.chat_context.messages[0] as AssistantMessage).content.find(
        (part) => part.type === 'tool_call'
    )!.toolcalls;
    const images = (migratedCalls[0].result_object as { images: FixtureImageEntry[] }).images;
    assert.equal(images.length, 2);
    for (const entry of images) {
        assert.ok(entry.externalized, 'migrated entries must be externalized');
        assert.match(entry.image_url, /^data:image\/png;base64,/);
        assert.ok(fs.existsSync(path.join(dataDir!, entry.externalized?.relative_path as string)));
    }
    // 未压缩条目的图片保持内联
    const freshImages = (migratedCalls[1].result_object as { images: FixtureImageEntry[] }).images;
    assert.equal(freshImages[0].externalized, undefined, 'uncompressed entries must stay inline');
    assert.equal(freshImages[0].image_url, withImageDataUrl(imageA));
});

test('readExternalizedImageFile rejects paths outside the task image directory', async () => {
    const original = await createNoisyPng(600, 400);
    const { taskId } = await buildToolCallWithImages([
        { image_url: withImageDataUrl(original), media_type: 'image/png' }
    ]);

    const imagesDir = path.join(getTaskArtifactDirectory(taskId, false), 'images');
    const stored = fs.readdirSync(imagesDir)[0];
    const ok = await readExternalizedImageFile(taskId, path.join('artifacts', taskId, 'images', stored));
    assert.ok(ok.dataUrl.startsWith('data:image/png;base64,'));

    await assert.rejects(
        () => readExternalizedImageFile(taskId, path.join('artifacts', taskId, 'images', '..', '..', 'task_list.json')),
        /outside/
    );
    await assert.rejects(() => readExternalizedImageFile(taskId, 'etc/passwd'), /outside/);
    await assert.rejects(
        () => readExternalizedImageFile(taskId, path.join('artifacts', 'other-task', 'images', stored)),
        /outside/
    );
});

test('readExternalizedImageFile rejects malformed task ids before building the directory fence', async () => {
    // 围栏基准不能被被校验方决定：IPC 只保证 taskId 是非空字符串，含 `..` 的 taskId
    // 会把 expectedPrefix 抬到数据根之外；形状校验必须先于路径解析
    await assert.rejects(
        () => readExternalizedImageFile('../evil', path.join('artifacts', 'x', 'images', 'a.png')),
        /malformed task id/
    );
});

test('adapter buildMessages uses hydrated full images over inline thumbnails', async () => {
    const { AnthropicAdapter } = await import('../../../../main/aikernel/adapters/anthropic.js');
    const original = await createNoisyPng(600, 400);
    const { call } = await buildToolCallWithImages([
        { image_url: withImageDataUrl(original), media_type: 'image/png', source: 'fixture' }
    ]);
    const entry = (call.result_object as { images: FixtureImageEntry[] }).images[0];

    const context = new ChatContext();
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(call);
    assistant.content.push(part);
    context.appendMessage(assistant);

    // 无回灌：工具结果里的图片是缩略图
    const withoutHydration = AnthropicAdapter.buildMessages(context, true) as {
        messages: Array<{ content: unknown }>;
    };
    const toolResultPart = findAnthropicImageBlock(withoutHydration.messages);
    assert.ok(toolResultPart, 'tool_result image block must exist');
    assert.equal(toolResultPart.source?.data, entry.image_url.slice(entry.image_url.indexOf(',') + 1));

    // 有回灌：发给模型的是完整原图
    const hydrated = await hydrateExternalizedToolImages(context);
    const withHydration = AnthropicAdapter.buildMessages(context, true, {
        hydratedToolImages: hydrated
    }) as { messages: Array<{ content: unknown }> };
    const hydratedBlock = findAnthropicImageBlock(withHydration.messages);
    assert.ok(hydratedBlock, 'hydrated image block must exist');
    assert.equal(hydratedBlock.source?.data, original.toString('base64'));
});

/** anthropic image block 嵌在 tool_result.content 内，递归查找 */
function findAnthropicImageBlock(messages: Array<{ content: unknown }>): { source?: { data?: string } } | undefined {
    for (const message of messages) {
        const blocks = Array.isArray(message.content) ? message.content : [];
        for (const block of blocks) {
            const record = block as Record<string, unknown>;
            if (record.type === 'image') {
                return record as { source?: { data?: string } };
            }
            if (record.type === 'tool_result' && Array.isArray(record.content)) {
                for (const nested of record.content) {
                    const nestedRecord = nested as Record<string, unknown>;
                    if (nestedRecord.type === 'image') {
                        return nestedRecord as { source?: { data?: string } };
                    }
                }
            }
        }
    }
    return undefined;
}

test('withHydratedToolImages passes options through when nothing is externalized', async () => {
    const context = new ChatContext();
    context.appendMessage(new AssistantMessage());
    const options = { requestTailText: 'hi' };
    const result = await withHydratedToolImages(context, true, options);
    assert.equal(result, options, 'no externalized images: the same options object is returned without IO');
    // 非视觉模型：直接透传
    const visionOff = await withHydratedToolImages(context, false, options);
    assert.equal(visionOff, options);
});

test('withHydratedToolImages attaches the hydrated map for externalized entries', async () => {
    const original = await createNoisyPng(600, 400);
    const { call } = await buildToolCallWithImages([
        { image_url: withImageDataUrl(original), media_type: 'image/png', source: 'fixture' }
    ]);
    const context = new ChatContext();
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(call);
    assistant.content.push(part);
    context.appendMessage(assistant);

    const result = await withHydratedToolImages(context, true, {});
    assert.ok(result.hydratedToolImages);
    assert.equal(result.hydratedToolImages.get(call.id)![0].image_url, withImageDataUrl(original));
});

test('OpenAI buildMessages sends hydrated full images over inline thumbnails', async () => {
    const { OpenAIAdapter } = await import('../../../../main/aikernel/adapters/openai.js');
    const original = await createNoisyPng(600, 400);
    const { call } = await buildToolCallWithImages([
        { image_url: withImageDataUrl(original), media_type: 'image/png', source: 'fixture' }
    ]);
    const context = new ChatContext();
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(call);
    assistant.content.push(part);
    context.appendMessage(assistant);

    const hydrated = await hydrateExternalizedToolImages(context);
    const messages = OpenAIAdapter.buildMessages(context, true, { hydratedToolImages: hydrated }) as Array<{
        role: string;
        content: unknown;
    }>;
    const imageParts = messages
        .filter((message) => message.role === 'user' && Array.isArray(message.content))
        .flatMap((message) => message.content as Array<Record<string, unknown>>)
        .filter((block) => block.type === 'image_url') as Array<{ image_url: { url: string } }>;
    assert.ok(imageParts.length === 1, 'one image part must be attached to the follow-up user message');
    assert.equal(imageParts[0].image_url.url, withImageDataUrl(original));
});

test('exportTaskJsonToFile keeps thumbnails and markers without mutating the live task', async () => {
    const { exportTaskJsonToFile } = await import('../../../../main/utils/export.js');
    const original = await createNoisyPng(600, 400);
    const manager = new TaskManagerState();
    const task = new TaskState(manager);
    task.task_id = 'img-export-thumbnail';
    task.task_status = 'failed';
    const call = new ToolCall(0, 'call-export-0', 'readImage', '{}');
    call.status = 'success';
    // 迁移只外置已压缩条目：fixture 按「已压缩 + 内联大图」真实画像构造
    call.result_storage = { result_id: 'result-export-0', storage_version: 1 };
    call.result_object = buildImageResultObject([
        { image_url: withImageDataUrl(original), media_type: 'image/png', source: 'fixture' }
    ]);
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(call);
    assistant.content.push(part);
    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(assistant);
    manager.tasks.push(task);
    manager.saveSync();
    // 打开任务触发外置迁移
    const reloaded = TaskManagerState.load()!;
    reloaded.getTask('img-export-thumbnail');
    await reloaded.tasks[0].pendingImageMigration();

    const liveEntry = (reloaded.tasks[0].chat_context.messages[0] as AssistantMessage).content.find(
        (item) => item.type === 'tool_call'
    )!.toolcalls[0].result_object as { images: FixtureImageEntry[] };
    assert.ok(liveEntry.images[0].externalized, 'live task must stay externalized');
    const marker = liveEntry.images[0].externalized;

    const exportFile = path.join(dataDir!, 'img-export-thumbnail.task.json');
    await exportTaskJsonToFile(reloaded.tasks[0], exportFile);
    const exportedJson = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    const exportedImages = exportedJson.chat_context.messages[0].content[0].toolcalls[0].result_object.images;
    // 导出只保留缩略图 + 外置标记：回填原图需要深拷贝 + 全量读盘，对大任务会直接
    // OOM（issue #341）；显示安全性由缩略图保证，完整原图只存在于源机器 artifacts。
    assert.equal(exportedImages[0].image_url, liveEntry.images[0].image_url, 'export must keep the inline thumbnail');
    assert.ok(exportedImages[0].externalized, 'export must keep the externalized marker');
    assert.equal(exportedImages[0].externalized.relative_path, marker?.relative_path);
    assert.ok(
        !fs.readFileSync(exportFile, 'utf8').includes(original.toString('base64')),
        'export must not embed the full image bytes'
    );
    // 内存任务保持外置状态未被导出污染
    assert.ok(liveEntry.images[0].externalized, 'live task must not be mutated by export');
});

test('imported task JSON is not migrated before staging (deterministic import content)', async () => {
    const original = await createNoisyPng(600, 400);
    const manager = new TaskManagerState();
    const json = {
        task_id: 'img-import-staging',
        task_status: 'failed',
        created_at: '2026-11-09T09:00:00.000Z',
        chat_context: { messages: [] }
    };
    const imported = deserializeTaskData(json as never, manager);
    const call = new ToolCall(0, 'call-import-0', 'readImage', '{}');
    call.status = 'success';
    call.result_object = buildImageResultObject([{ image_url: withImageDataUrl(original), media_type: 'image/png' }]);
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(call);
    assistant.content.push(part);
    imported.chat_context.appendMessage(assistant);

    // 未 attach 到 manager：不允许触发迁移（导出 staging 内容必须与源一致）
    await new Promise((resolve) => setTimeout(resolve, 60));
    const entry = (imported.chat_context.messages[0] as AssistantMessage).content[0].toolcalls[0].result_object as {
        images: FixtureImageEntry[];
    };
    assert.equal(entry.images[0].externalized, undefined, 'unattached task must not be migrated');
    assert.equal(entry.images[0].image_url, withImageDataUrl(original));
});

test('unload defers while image migration is in flight and proceeds afterwards', async () => {
    const original = await createNoisyPng(600, 400);
    const manager = new TaskManagerState();
    const task = new TaskState(manager);
    task.task_id = 'img-unload-guard';
    task.task_status = 'failed';
    const call = new ToolCall(0, 'call-unload-0', 'readImage', '{}');
    call.status = 'success';
    call.result_storage = { result_id: 'result-unload-0', storage_version: 1 };
    call.result_object = buildImageResultObject([{ image_url: withImageDataUrl(original), media_type: 'image/png' }]);
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(call);
    assistant.content.push(part);
    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(assistant);
    manager.tasks.push(task);
    manager.saveSync();

    const reloaded = TaskManagerState.load()!;
    const restored = reloaded.getTask('img-unload-guard')!;
    // 迁移刚被 getTask 触发，仍在进行中：unload 必须让位
    assert.equal(restored.unload(), false, 'unload must be deferred while migration is in flight');
    await restored.pendingImageMigration();
    assert.equal(restored.unload(), true, 'unload proceeds after migration completes');
});

test('unknown image formats such as svg+xml stay inline', async () => {
    const svgPayload = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'.padEnd(32768, 'x')).toString('base64');
    const { call } = await buildToolCallWithImages([{ image_url: `data:image/svg+xml;base64,${svgPayload}` }]);
    const entry = (call.result_object as { images: FixtureImageEntry[] }).images[0];
    assert.equal(entry.externalized, undefined, 'svg must stay inline to avoid broken round-trips');
    assert.match(entry.image_url, /^data:image\/svg\+xml;base64,/);
});

test('request-prep externalization only touches compressed toolcalls and stays idempotent', async () => {
    const original = await createNoisyPng(600, 400);
    const manager = new TaskManagerState();
    const task = new TaskState(manager);
    task.task_id = 'img-prep-ext';
    task.task_status = 'failed';

    // 已压缩条目：请求准备接管 result 后内联大图应被补外置
    const compressed = new ToolCall(0, 'call-prep-0', 'browser-screenshot', '{"seq":1}');
    compressed.status = 'success';
    compressed.result_storage = { result_id: 'result-prep-0', storage_version: 1 };
    compressed.result_object = buildImageResultObject([
        { image_url: withImageDataUrl(original), media_type: 'image/png' }
    ]);
    // 未压缩条目：活跃窗口内每轮请求都要发送完整图片，必须保持内联
    const fresh = new ToolCall(1, 'call-prep-1', 'browser-screenshot', '{"seq":2}');
    fresh.status = 'success';
    fresh.result_object = buildImageResultObject([{ image_url: withImageDataUrl(original), media_type: 'image/png' }]);
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(compressed, fresh);
    assistant.content.push(part);
    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(assistant);
    manager.tasks.push(task);

    const { migrateInlineToolResultImages } = await import('../../../../main/aikernel/task/image-externalization.js');
    const externalized = await migrateInlineToolResultImages(task);
    assert.equal(externalized, 1, 'only the compressed toolcall gains an externalized image');

    const calls = (task.chat_context.messages[0] as AssistantMessage).content.find(
        (item) => item.type === 'tool_call'
    )!.toolcalls;
    const compressedEntry = (calls[0].result_object as { images: FixtureImageEntry[] }).images[0];
    const freshEntry = (calls[1].result_object as { images: FixtureImageEntry[] }).images[0];
    assert.ok(compressedEntry.externalized, 'compressed toolcall must be externalized');
    assert.ok(fs.existsSync(path.join(dataDir!, compressedEntry.externalized?.relative_path as string)));
    assert.equal(freshEntry.externalized, undefined, 'uncompressed toolcall must stay inline');
    assert.equal(freshEntry.image_url, withImageDataUrl(original));

    // 幂等：重复执行不再产生新外置
    assert.equal(await migrateInlineToolResultImages(task), 0);

    // 已外置的压缩条目回灌可读回完整原图
    const hydrated = await hydrateExternalizedToolImages(task.chat_context);
    assert.equal(hydrated.get(compressed.id)![0].image_url, withImageDataUrl(original));
});

test('microcompact-cleared toolcalls qualify as compressed for externalization', async () => {
    const original = await createNoisyPng(600, 400);
    const manager = new TaskManagerState();
    const task = new TaskState(manager);
    task.task_id = `img-ext-${Math.random().toString(36).slice(2, 8)}`;
    task.task_status = 'failed';
    // microcompact 本地清除：result 已被替代文本接管，无 result_storage，同样视为已压缩
    const call = new ToolCall(0, `call-${task.task_id}`, 'readImage', '{}');
    call.status = 'success';
    call.result_object = buildImageResultObject([{ image_url: withImageDataUrl(original), media_type: 'image/png' }]);
    call.microcompact = {
        strategy: 'local_clear',
        cleared_at: new Date().toISOString(),
        original_chars: original.length,
        original_lines: 3,
        replacement_text: '[旧结果已被清理]'
    };
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(call);
    assistant.content.push(part);
    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(assistant);
    manager.tasks.push(task);

    const { migrateInlineToolResultImages } = await import('../../../../main/aikernel/task/image-externalization.js');
    assert.equal(await migrateInlineToolResultImages(task), 1);
    const entry = (call.result_object as { images: FixtureImageEntry[] }).images[0];
    assert.ok(entry.externalized, 'microcompact-only toolcall must be externalized');
    assert.ok(fs.existsSync(path.join(dataDir!, entry.externalized?.relative_path as string)));
});

test('forked tasks own their externalized images: markers are rewired and files copied', async () => {
    const original = await createNoisyPng(600, 400);
    const tiny = await sharp({
        create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } }
    })
        .png()
        .toBuffer();
    const manager = new TaskManagerState();
    const task = new TaskState(manager);
    task.task_id = 'img-fork-source';
    task.task_status = 'failed';

    // 正常外置图 + 一个指向"不存在源文件"的 marker（模拟跨机器导入的悬空引用）
    const call = new ToolCall(0, 'call-fork-0', 'readImage', '{}');
    call.status = 'success';
    call.result_storage = { result_id: 'result-fork-0', storage_version: 1 };
    call.result_object = buildImageResultObject([
        { image_url: withImageDataUrl(original), media_type: 'image/png', source: 'fixture' }
    ]);
    await externalizeToolResultImages('img-fork-source', call.result_object);
    const dangling = new ToolCall(1, 'call-fork-1', 'readImage', '{}');
    dangling.status = 'success';
    dangling.result_object = buildImageResultObject([
        {
            image_url: withImageDataUrl(tiny),
            media_type: 'image/png',
            externalized: {
                version: 1,
                relative_path: path.join('artifacts', 'ghost-task', 'images', 'deadbeefcafe.png'),
                original_bytes: tiny.length,
                original_media_type: 'image/png',
                thumbnail_bytes: tiny.length
            }
        }
    ]);

    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(call, dangling);
    assistant.content.push(part);
    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(assistant);
    manager.tasks.push(task);

    const forked = forkTask(task);
    const forkId = forked.task_id;
    assert.notEqual(forkId, 'img-fork-source');

    const forkedCalls = (forked.chat_context.messages[0] as AssistantMessage).content.find(
        (item) => item.type === 'tool_call'
    )!.toolcalls;
    const rewired = (forkedCalls[0].result_object as { images: FixtureImageEntry[] }).images[0].externalized;
    const rewiredDangling = (forkedCalls[1].result_object as { images: FixtureImageEntry[] }).images[0]
        .externalized as { relative_path: string };

    // marker 全部改写到 fork 自己的命名空间（含悬空引用，保持任务内一致）
    assert.match(rewired?.relative_path as string, new RegExp(`^artifacts[/\\\\]${forkId}[/\\\\]images[/\\\\]`));
    assert.match(rewiredDangling.relative_path, new RegExp(`^artifacts[/\\\\]${forkId}[/\\\\]images[/\\\\]`));

    // 文件已复制到 fork 目录且字节一致；源任务文件不受影响
    const forkedFile = path.join(dataDir!, rewired?.relative_path as string);
    assert.ok(fs.existsSync(forkedFile), 'forked task must own a copy of the image file');
    assert.ok(Buffer.compare(fs.readFileSync(forkedFile), original) === 0, 'copied bytes must match the original');
    const sourceFile = path.join(dataDir!, 'artifacts', 'img-fork-source', 'images');
    assert.ok(
        fs.existsSync(path.join(sourceFile, path.basename(rewired?.relative_path as string))),
        'source must stay untouched'
    );
    assert.ok(
        !fs.existsSync(path.join(dataDir!, rewiredDangling.relative_path)),
        'dangling marker must not gain a file'
    );

    // IPC 路径围栏现在接受 fork 任务自己的 marker（修复前必然拒绝跨任务路径）
    const payload = await readExternalizedImageFile(forkId, rewired?.relative_path as string);
    assert.ok(payload.dataUrl.startsWith('data:image/png;base64,'));

    // 模型回灌：fork 上下文中外置图仍可从磁盘读回完整原图
    const hydrated = await hydrateExternalizedToolImages(forked.chat_context);
    assert.equal(hydrated.get(forkedCalls[0].id)![0].image_url, withImageDataUrl(original));
});

function buildHydrationContextWithMarker(markerPath: string): {
    context: ChatContext;
    call: ToolCall;
    thumbnail: string;
} {
    const thumbnail =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const call = new ToolCall(0, `call-evil-${Math.random().toString(36).slice(2, 8)}`, 'readImage', '{}');
    call.status = 'success';
    call.result_object = buildImageResultObject([
        {
            image_url: thumbnail,
            media_type: 'image/png',
            externalized: {
                version: 1,
                relative_path: markerPath,
                original_bytes: 1024,
                original_media_type: 'image/png',
                thumbnail_bytes: 96
            }
        }
    ]);
    const context = new ChatContext();
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(call);
    assistant.content.push(part);
    context.appendMessage(assistant);
    return { context, call, thumbnail };
}

test('hydration never reads paths escaping the artifacts directory (traversal / absolute)', async () => {
    // 数据目录之外放置一个真实文件：若穿越被读出，dataUrl 会变成该文件内容
    const outsideFile = path.join(path.dirname(dataDir!), `outside-secret-${process.pid}.png`);
    fs.writeFileSync(outsideFile, 'SECRET-OUTSIDE-CONTENT');
    try {
        for (const markerPath of [
            path.join('..', path.basename(dataDir!), '..', path.basename(outsideFile)),
            '../outside-secret.png',
            outsideFile,
            path.join('artifacts', 't1', 'images', '..', '..', '..', 'outside-secret.png')
        ]) {
            const { context, call, thumbnail } = buildHydrationContextWithMarker(markerPath);
            const hydrated = await hydrateExternalizedToolImages(context);
            const images = hydrated.get(call.id)!;
            assert.equal(
                images[0].image_url,
                thumbnail,
                `marker ${markerPath} must not escape the artifacts directory`
            );
            // 带 taskId 的严格校验同样拒绝
            const strict = await hydrateExternalizedToolImages(context, { taskId: 't1' });
            assert.equal(strict.get(call.id)![0].image_url, thumbnail, `strict mode must reject ${markerPath}`);
        }
    } finally {
        fs.rmSync(outsideFile, { force: true });
    }
});

test('hydration with taskId restricts reads to the current task image directory', async () => {
    const original = await createNoisyPng(600, 400);
    // 两个任务各自外置一张真实图片
    const buildMarkerFor = async (taskId: string) => {
        const call = new ToolCall(0, `call-${taskId}`, 'readImage', '{}');
        call.status = 'success';
        call.result_object = buildImageResultObject([
            { image_url: withImageDataUrl(original), media_type: 'image/png', source: 'fixture' }
        ]);
        await externalizeToolResultImages(taskId, call.result_object);
        const entry = (call.result_object as { images: FixtureImageEntry[] }).images[0];
        // 回灌输入的 image_url 收敛为内联缩略图（模拟已落盘瘦身的重载画像）
        const thumbnail = entry.image_url;
        const relativePath = entry.externalized?.relative_path as string;
        entry.image_url = thumbnail;
        return { call, thumbnail, relativePath };
    };

    const ownerTaskId = `img-owner-${Math.random().toString(36).slice(2, 8)}`;
    const otherTaskId = `img-other-${Math.random().toString(36).slice(2, 8)}`;
    const own = await buildMarkerFor(ownerTaskId);
    const other = await buildMarkerFor(otherTaskId);

    const context = new ChatContext();
    const assistant = new AssistantMessage();
    const part = new ToolCallMessagePart();
    part.toolcalls.push(own.call, other.call);
    assistant.content.push(part);
    context.appendMessage(assistant);

    // 带当前任务 id：本任务图片读回全图，另一任务的合法路径被拒绝并回退缩略图
    const strict = await hydrateExternalizedToolImages(context, { taskId: ownerTaskId });
    assert.equal(strict.get(own.call.id)![0].image_url, withImageDataUrl(original));
    assert.equal(
        strict.get(other.call.id)![0].image_url,
        other.thumbnail,
        'another task image must not be readable under a foreign taskId'
    );

    // 不带 taskId：形状校验兜底（合法 images 布局可读——UUID 不可猜 + 导入清洗防植入）
    const loose = await hydrateExternalizedToolImages(context);
    assert.equal(loose.get(own.call.id)![0].image_url, withImageDataUrl(original));
    assert.equal(loose.get(other.call.id)![0].image_url, withImageDataUrl(original));
});
