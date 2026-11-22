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

import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { crc32 } from 'node:zlib';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import yazl from 'yazl';
import { buildAtomicWriteTmpPath, getTempDir } from './temp.js';
import { jsonChunksAsBuffers } from './json-stream-write.js';
import { getOpendeskDirectory } from './setting.js';
import { isForbiddenWindowsFileName, isSafeArtifactRelativePath } from './artifact-relative-path.js';
import { logger } from './logger.js';

import { TaskTransferError } from './task-transfer-error.js';
export { TaskTransferError, type TaskTransferErrorCode } from './task-transfer-error.js';

export type TaskJson = Record<string, any>;
export interface TaskImportEntry {
    id: string;
    name: string;
    parentId: string | null;
    messageCount: number;
    readJson(): Promise<TaskJson>;
}

/** 随包携带的任务产物文件：entryName 一律 `artifacts/<taskId>/<子路径>`，段间用 / 分隔。 */
export interface TaskBundleArtifactFile {
    entryName: string;
    /** 磁盘上的源文件绝对路径（写侧由 exportTaskBundle 枚举） */
    diskPath: string;
}

export interface TaskBundleArtifactsRestoreResult {
    restored: number;
    /** 逐文件 best-effort：失败不使导入失败，仅记录并按悬空引用降级 */
    failed: number;
}

export interface TaskImportPreview {
    entries: TaskImportEntry[];
    /**
     * 把 zip 内 artifacts 条目按 oldId→newId 还原到本机数据目录（v2 bundle 携带；
     * 单文件 .json 导入为空操作）。必须在 dispose 之前、任务提交成功之后调用。
     */
    restoreArtifacts(ids: ReadonlyMap<string, string>): Promise<TaskBundleArtifactsRestoreResult>;
    dispose(): Promise<void>;
}

/** zip 内 artifacts 条目名白名单：`artifacts/<taskId>/` + 若干安全段（无 ..、无反斜杠、无隐藏文件） */
const ARTIFACT_ENTRY_PATTERN =
    /^artifacts\/([a-zA-Z0-9_-]{1,128})\/([A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/;
// 目录条目白名单（重新打包的 zip 常见）：tasks/、artifacts/、artifacts/<id>/… 各级目录
const ARCHIVE_DIRECTORY_PATTERN = /^(tasks|artifacts)(\/[A-Za-z0-9][A-Za-z0-9._-]*)*\/$/;

/** 导入侧 artifacts 恢复上限：单文件 / 整包总量 / 条目数（防 zip 炸弹，正常任务远低于此） */
const MAX_ARTIFACT_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_ENTRY_COUNT = 20_000;
// indexArchive 的整体条目白名单由三部分拼出：manifest、tasks 目录/任务 json、artifacts 条目（复用上方 pattern）
const ARCHIVE_ENTRY_PATTERN = new RegExp(
    `^(manifest\\.json|tasks\\/|tasks\\/[a-zA-Z0-9_-]{1,128}\\.json|${ARTIFACT_ENTRY_PATTERN.source.slice(1, -1)})$`
);

interface TaskBundleArtifactEntry {
    taskId: string;
    entryName: string;
    entry: Entry;
}

const safeId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const isObject = (value: unknown): value is TaskJson => !!value && typeof value === 'object' && !Array.isArray(value);

function validMessage(message: unknown): boolean {
    if (!isObject(message)) return false;
    if (message.role === 'compact_separator') return typeof message.summary === 'string';
    if (!['user', 'assistant'].includes(message.role) || !Array.isArray(message.content)) return false;
    const allowed =
        message.role === 'user' ? ['text', 'file', 'image_url'] : ['text', 'reasoning', 'tool_call', 'error'];
    return message.content.every((part: any) => {
        if (!isObject(part) || !allowed.includes(part.type)) return false;
        if (part.type === 'text') return typeof part.text === 'string';
        if (part.type === 'file') return typeof part.path === 'string';
        if (part.type === 'tool_call') return Array.isArray(part.toolcalls) && part.toolcalls.every(isObject);
        return true;
    });
}

function parseTask(raw: string, id?: string): TaskJson {
    try {
        const json = JSON.parse(raw);
        if (
            !isObject(json) ||
            !safeId(json.task_id) ||
            (id && json.task_id !== id) ||
            !isObject(json.chat_context) ||
            !Array.isArray(json.chat_context.messages) ||
            !['waiting', 'running', 'stopped', 'failed', 'completed'].includes(json.task_status) ||
            json.chat_context.messages.some((message: unknown) => !validMessage(message))
        ) {
            throw new TaskTransferError('invalidTask');
        }
        return json;
    } catch (error) {
        if (error instanceof TaskTransferError) throw error;
        throw new TaskTransferError('invalidTask', error);
    }
}

async function previewEntry(read: () => Promise<TaskJson>): Promise<TaskImportEntry> {
    const json = await read();
    return {
        id: json.task_id,
        name: typeof json.task_name === 'string' ? json.task_name : '',
        parentId: typeof json.parent_id === 'string' ? json.parent_id : null,
        messageCount: json.chat_context.messages.length,
        readJson: read
    };
}

function archiveError(error: unknown, entry?: string): TaskTransferError {
    const systemError = error as NodeJS.ErrnoException;
    const code =
        systemError?.code === 'ERR_STRING_TOO_LONG'
            ? 'taskExceedsRuntimeCapacity'
            : systemError?.syscall && systemError?.errno !== undefined
              ? 'writeFailed'
              : 'corruptArchive';
    return new TaskTransferError(code, error, 'readImportFile', entry);
}

async function indexArchive(zip: ZipFile): Promise<Map<string, Entry>> {
    const entries = new Map<string, Entry>();
    try {
        for await (const entry of zip.eachEntry()) {
            const name = String(entry.fileName);
            // 目录条目没有内容：用户把 bundle 解开后用系统/第三方工具重新打包会写入
            // 目录条目（zip -r、资源管理器、macOS 归档），不应因此拒绝整包——按白名单
            // 前缀校验后直接丢弃，不参与后续 files.size 校验
            if (name.endsWith('/')) {
                if (!ARCHIVE_DIRECTORY_PATTERN.test(name) || entry.isEncrypted()) {
                    throw new TaskTransferError('invalidBundle');
                }
                continue;
            }
            if (
                entries.has(name) ||
                // artifacts 条目是否被接受由 manifest version 决定（v2 起携带），这里先做语法校验
                !ARCHIVE_ENTRY_PATTERN.test(name) ||
                // 条目名按段过一遍 Windows 文件名归一化约束：保留设备名会被解析为设备，
                // 段尾 `.`/空格会被 Win32 静默剥离，均导致写入落到非预期位置
                name.split('/').slice(1).some(isForbiddenWindowsFileName) ||
                entry.isEncrypted() ||
                (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) ||
                ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
            ) {
                throw new TaskTransferError('invalidBundle');
            }
            entries.set(name, entry);
        }
    } catch (error) {
        throw error instanceof TaskTransferError ? error : archiveError(error);
    }
    return entries;
}

async function readArchiveEntry(zip: ZipFile, entry: Entry): Promise<string> {
    let stream: Readable | undefined;
    try {
        stream = await zip.openReadStreamPromise(entry);
        const decoder = new StringDecoder('utf8');
        let result = '';
        let checksum = 0;
        // yauzl validates the decoded size. It does not validate the CRC.
        for await (const chunk of stream) {
            checksum = crc32(chunk, checksum);
            result += decoder.write(chunk);
        }
        if (checksum !== entry.crc32) throw new Error('ZIP entry CRC does not match');
        return result + decoder.end();
    } catch (error) {
        stream?.destroy();
        throw archiveError(error, String(entry.fileName));
    }
}

async function previewArchive(
    zip: ZipFile
): Promise<{ entries: TaskImportEntry[]; artifacts: TaskBundleArtifactEntry[] }> {
    const files = await indexArchive(zip);
    const manifestFile = files.get('manifest.json');
    if (!manifestFile) throw new TaskTransferError('invalidBundle');
    const raw = await readArchiveEntry(zip, manifestFile);
    let manifest: unknown;
    try {
        manifest = JSON.parse(raw);
    } catch (error) {
        throw new TaskTransferError('invalidBundle', error);
    }
    if (!isObject(manifest) || manifest.format !== 'opendesk-task-bundle') throw new TaskTransferError('invalidBundle');
    // v2 = 携带 artifacts 条目；v1 包里出现 artifacts 条目会落入下方 files.size 检查被拒绝
    if (manifest.version !== 1 && manifest.version !== 2) throw new TaskTransferError('unsupportedVersion');
    if (!Array.isArray(manifest.tasks) || !manifest.tasks.length) throw new TaskTransferError('invalidBundle');
    files.delete('manifest.json');
    files.delete('tasks/');
    const tasks = manifest.tasks.map((item: unknown) => {
        if (!isObject(item) || !safeId(item.id) || item.path !== `tasks/${item.id}.json`) {
            throw new TaskTransferError('invalidBundle');
        }
        const entry = files.get(item.path);
        if (!entry) throw new TaskTransferError('invalidBundle');
        files.delete(item.path);
        return { id: item.id, entry };
    });
    const taskIds = new Set(tasks.map(({ id }) => id));
    const artifacts: TaskBundleArtifactEntry[] = [];
    // 仅 v2 消费 artifacts 条目：v1 包里残留的 artifacts 条目落入下方 files.size 检查被拒绝
    if (manifest.version === 2) {
        let artifactBytes = 0;
        for (const [name, entry] of [...files]) {
            const match = ARTIFACT_ENTRY_PATTERN.exec(name);
            if (!match) continue;
            // artifacts 条目必须归属 manifest 声明的任务，防止为未知任务夹带文件
            if (!taskIds.has(match[1])) throw new TaskTransferError('invalidBundle');
            // 声明尺寸预检（yauzl 默认校验解压尺寸与声明一致）：防止高压缩比条目把
            // 导入变成 zip 炸弹写盘。上限刻意放宽——正常任务产物（原图 + 工具结果原文）
            // 量级在数百 MB，上限只拦异常构造。
            if (entry.uncompressedSize > MAX_ARTIFACT_ENTRY_BYTES) throw new TaskTransferError('invalidBundle');
            artifactBytes += entry.uncompressedSize;
            if (artifactBytes > MAX_ARTIFACT_TOTAL_BYTES) throw new TaskTransferError('invalidBundle');
            if (artifacts.length >= MAX_ARTIFACT_ENTRY_COUNT) throw new TaskTransferError('invalidBundle');
            artifacts.push({ taskId: match[1], entryName: name, entry });
            files.delete(name);
        }
    }
    if (files.size) throw new TaskTransferError('invalidBundle');

    const result: TaskImportEntry[] = [];
    for (const { id, entry } of tasks) {
        result.push(await previewEntry(async () => parseTask(await readArchiveEntry(zip, entry), id)));
    }
    const parentIds = new Map(result.map(({ id, parentId }) => [id, parentId]));
    const checked = new Set<string>();
    for (const { id } of result) {
        const chain = new Set<string>();
        let current: string | null | undefined = id;
        while (current && !checked.has(current)) {
            if (chain.has(current)) throw new TaskTransferError('invalidTask');
            chain.add(current);
            current = parentIds.get(current);
        }
        for (const ancestor of chain) checked.add(ancestor);
    }
    return { entries: result, artifacts };
}

export async function readTaskImportFile(filePath: string): Promise<TaskImportPreview> {
    if (!(await fs.promises.stat(filePath)).isFile()) throw new TaskTransferError('invalidBundle');
    const directory = await fs.promises.mkdtemp(path.join(getTempDir(), 'opendesk-task-preview-'));
    const snapshot = path.join(directory, 'snapshot');
    let zip: ZipFile | undefined;
    let artifactEntries: TaskBundleArtifactEntry[] = [];
    const noArtifacts = async () => ({ restored: 0, failed: 0 });
    const dispose = async () => {
        try {
            if (zip?.isOpen) {
                const closed = once(zip, 'close');
                zip.close();
                await closed;
            }
        } finally {
            await fs.promises.rm(directory, { recursive: true, force: true });
        }
    };
    try {
        // Keep the reviewed bytes stable across preview, selection and retries.
        await fs.promises.copyFile(filePath, snapshot, fs.constants.COPYFILE_FICLONE);
        if (path.extname(filePath).toLowerCase() === '.json') {
            const entry = await previewEntry(async () => {
                const raw = await fs.promises.readFile(snapshot, 'utf8').catch((error: NodeJS.ErrnoException) => {
                    if (error.code === 'ERR_FS_FILE_TOO_LARGE' || error.code === 'ERR_STRING_TOO_LONG') {
                        throw new TaskTransferError('taskExceedsRuntimeCapacity', error, 'readImportFile');
                    }
                    throw error;
                });
                return parseTask(raw);
            });
            return { entries: [entry], restoreArtifacts: noArtifacts, dispose };
        }
        zip = await yauzl.openPromise(snapshot, { autoClose: false, decodeStrings: false }).catch((error) => {
            throw archiveError(error);
        });
        const previewed = await previewArchive(zip);
        artifactEntries = previewed.artifacts;
        return {
            entries: previewed.entries,
            restoreArtifacts: (ids) => restoreTaskBundleArtifacts(zip!, artifactEntries, ids),
            dispose
        };
    } catch (error) {
        await dispose().catch(() => {});
        throw error;
    }
}

/** 边写入目标文件边计算 CRC32：yauzl 只校验解压尺寸，条目完整性须自行比对。 */
class CrcVerifyingTransform extends Transform {
    checksum = 0;
    override _transform(
        chunk: Buffer,
        _encoding: string,
        callback: (error: Error | null, data?: Buffer) => void
    ): void {
        this.checksum = crc32(chunk, this.checksum);
        callback(null, chunk);
    }
}

/**
 * 把 zip 内 artifacts 条目按 oldId→newId 还原到本机数据目录 `<dataRoot>/artifacts/<newId>/<子路径>`。
 * 逐文件 best-effort：失败记录并计入 failed，不抛错——任务本体已导入，单文件失败只影响
 * 该文件的原文可恢复性，下游对外置图片（回退缩略图）与已剥离原文（回退替代文本）均有降级路径。
 */
async function restoreTaskBundleArtifacts(
    zip: ZipFile,
    artifacts: TaskBundleArtifactEntry[],
    ids: ReadonlyMap<string, string>
): Promise<TaskBundleArtifactsRestoreResult> {
    const dataRoot = getOpendeskDirectory();
    let restored = 0;
    let failed = 0;
    for (const { taskId, entryName, entry } of artifacts) {
        const newId = ids.get(taskId);
        if (!newId) continue; // 未勾选导入的任务：其 artifacts 条目一并跳过
        const targetPath = path.join(dataRoot, 'artifacts', newId, ...entryName.split('/').slice(2));
        try {
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
            const stream = await zip.openReadStreamPromise(entry);
            const verifier = new CrcVerifyingTransform();
            await pipeline(stream, verifier, fs.createWriteStream(targetPath, { flags: 'wx' }));
            if (verifier.checksum !== entry.crc32) throw new Error('ZIP entry CRC does not match');
            restored++;
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
                // 同名文件已存在（fresh UUID 下不应发生；大小写不敏感文件系统上仅大小写
                // 不同的条目会命中这里）：尺寸一致才视为已具备，否则按失败降级，避免
                // "报告成功但留下的是另一份内容"
                const existing = await fs.promises.stat(targetPath).catch(() => null);
                if (existing && existing.size === entry.uncompressedSize) {
                    restored++;
                } else {
                    failed++;
                    logger.warn(`task import: artifact entry conflicts with an existing file: ${entryName}`);
                }
            } else {
                failed++;
                // 写入中途失败可能留下半截文件：清理后按悬空引用降级
                await fs.promises.rm(targetPath, { force: true }).catch(() => {});
                logger.warn(`task import: artifact entry failed to restore: ${entryName}`, error);
            }
        }
    }
    return { restored, failed };
}

export async function writeTaskBundle(
    filePath: string,
    ids: Iterable<string>,
    snapshot: (id: string) => TaskJson | Promise<TaskJson>,
    artifacts: TaskBundleArtifactFile[] = []
): Promise<void> {
    const uniqueIds = new Set<string>();
    const tasks: { id: string; path: string }[] = [];
    for (const id of ids) {
        if (!safeId(id) || uniqueIds.has(id)) throw new TaskTransferError('invalidTask');
        uniqueIds.add(id);
        tasks.push({ id, path: `tasks/${id}.json` });
    }
    if (!tasks.length) throw new TaskTransferError('invalidTask');

    // 携带 artifacts 的 bundle 用 v2 标记：旧版本导入会得到显式 unsupportedVersion
    // （提示升级），而非误导入一个带悬空引用的任务；无产物的 bundle 维持 v1 跨版本兼容。
    const version = artifacts.length > 0 ? 2 : 1;
    const exportedAt = new Date().toISOString();
    const zip = new yazl.ZipFile();
    const temporary = buildAtomicWriteTmpPath(filePath);
    let active: Readable | undefined;
    const stream = zip.outputStream as Readable;
    zip.on('error', (error) => stream.destroy(error));
    const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    const writing = pipeline(stream, output);
    // yazl calls this loader only when the previous ZIP entry has been written.
    const addJson = (name: string, load: () => TaskJson | Promise<TaskJson>) => {
        zip.addReadStreamLazy(name, (callback) => {
            void Promise.resolve()
                .then(load)
                .then((json) => {
                    if (stream.destroyed) return;
                    // 流式产出 JSON（与 JSON.stringify(json, null, 4) 字节一致），
                    // 大任务条目不在内存物化整个输出串（issue #341 导出内存防护）
                    active = Readable.from(jsonChunksAsBuffers(json, 4));
                    callback(null, active);
                })
                .catch((error) => stream.destroy(error));
        });
    };

    try {
        for (const task of tasks) {
            addJson(task.path, async () => {
                const json = await snapshot(task.id);
                if (json.task_id !== task.id) throw new TaskTransferError('invalidTask');
                return json;
            });
        }
        for (const artifact of artifacts) {
            if (
                !ARTIFACT_ENTRY_PATTERN.test(artifact.entryName) ||
                artifact.entryName.split('/').slice(1).some(isForbiddenWindowsFileName)
            ) {
                // 枚举自任务自己的 artifacts 目录，不合规名只可能是人工放入的文件：
                // 跳过并告警，不因单个文件让整个导出失败（与下方"文件消失即跳过"同策略；
                // 导入端白名单校验同样拒绝这类条目，不存在放开攻击面的问题）
                logger.warn(`task export: artifact entry name rejected, skipped: ${artifact.entryName}`);
                continue;
            }
            // 磁盘直读流式写入，不经内存；枚举与写入之间文件消失时按缺失跳过（悬空降级）
            if (!fs.existsSync(artifact.diskPath)) {
                logger.warn(`task export: artifact file vanished before write, skipped: ${artifact.diskPath}`);
                continue;
            }
            zip.addFile(artifact.diskPath, artifact.entryName);
        }
        addJson('manifest.json', () => ({
            format: 'opendesk-task-bundle',
            version,
            exportedAt,
            tasks
        }));
        zip.end();
        await writing;
        await fs.promises.rename(temporary, filePath);
    } finally {
        active?.destroy();
        stream.destroy();
        await writing.catch(() => {});
        await fs.promises.unlink(temporary).catch(() => {});
    }
}

/**
 * 改写指向源任务产物目录的相对路径到新任务命名空间（v2 bundle 导入）：
 * 图片外置 marker（externalized.relative_path）、工具结果原文（result_storage.relative_path）、
 * 替换状态记录（tool_result_replacement_state
 * 内的 relative_path）。存储值在 Windows 上是 path.join 产生的反斜杠路径，这里按两种
 * 分隔符识别前缀后用本机分隔符重建，一并解决跨平台导入。
 * 穿越路径与其他任务的 images 引用（恶意包可借宽松回灌读出本机其他任务的图片）不落地，
 * 直接删除字段走下游降级；指向本机数据根内其他任务的工具结果原文等引用不消费 images
 * 目录，无请求期读盘路径，仍保留。
 */
function rewriteImportedArtifactRelativePath(value: string, sourceId: string, targetId: string): string {
    const segments = value.split(/[\\/]/);
    if (segments.length < 3 || segments[0] !== 'artifacts' || segments[1] !== sourceId) return value;
    const rest = segments.slice(2);
    if (rest.some((segment) => !segment || segment === '.' || segment === '..')) return value;
    return path.join('artifacts', targetId, ...rest);
}

/** 结构化的产物引用字段：存储层只保存相对路径，模型可见文本由边界渲染生成 */
const ARTIFACT_REFERENCE_PATH_KEYS = new Set(['relative_path']);

function rewriteImportedArtifactRelativePaths(root: Record<string, unknown>, sourceId: string, targetId: string): void {
    // 只改写结构化引用字段（relative_path）。模型可见文本不落盘，
    // 因此不存在"内嵌路径需要跟着改"的问题；旧格式的 free-text（replacement_text）
    // 原样保留——跨机导入后其中记录的源机路径仍然失效，属于已接受的降级：不报错、
    // 不破坏文本，只是模型按旧路径读文件会失败并走既有降级链路
    const visit = (value: Record<string, unknown>, depth: number): void => {
        if (depth > 100) return;
        for (const [key, child] of Object.entries(value)) {
            // 工具参数是用户载荷，不携带产物引用语义，保持原样
            if (key === 'args_object' || key === 'args_string' || key === 'arguments') continue;
            if (ARTIFACT_REFERENCE_PATH_KEYS.has(key) && typeof child === 'string') {
                const rewritten = rewriteImportedArtifactRelativePath(child, sourceId, targetId);
                if (rewritten !== child) {
                    // 命中本任务前缀：改写到新命名空间（改写结果由构造保证安全）
                    value[key] = rewritten;
                } else if (isSafeArtifactRelativePath(child, 'images') || !isSafeArtifactRelativePath(child)) {
                    // 穿越/绝对路径/畸形值，或形状安全但指向其他任务 images 的引用，一律丢弃
                    // 该字段——marker 失效后图片回退内联缩略图，result_storage 缺失后替代文本
                    // 照常生效，均有降级路径；绝不让恶意包把越界读取或「读取本机其他任务
                    // 图片」的指针写进导入后的任务 JSON（后者会在无 taskId 的宽松回灌路径被
                    // 原样读出发给模型服务）。工具结果原文等非 images 目录的跨任务引用无
                    // 请求期读盘消费方，仍按合法布局保留
                    delete value[key];
                }
            } else if (child && typeof child === 'object') {
                visit(child as Record<string, unknown>, depth + 1);
            }
        }
    };
    visit(root, 0);

    // marker 清理：relative_path 被删除（穿越/跨任务 images 清洗）后残留的 externalized
    // 空壳没有读取语义，整字段移除，保证 marker「要么完整（含可读 relative_path）要么
    // 缺席」，下游 isExternalizedToolResultImage 不再面对残缺对象。args 键同样跳过。
    const pruneMarkers = (value: Record<string, unknown>, depth: number): void => {
        if (depth > 100) return;
        for (const [key, child] of Object.entries(value)) {
            if (key === 'args_object' || key === 'args_string' || key === 'arguments') continue;
            if (
                key === 'externalized' &&
                child !== null &&
                typeof child === 'object' &&
                !Array.isArray(child) &&
                typeof (child as Record<string, unknown>).relative_path !== 'string'
            ) {
                delete value[key];
            } else if (child && typeof child === 'object') {
                pruneMarkers(child as Record<string, unknown>, depth + 1);
            }
        }
    };
    pruneMarkers(root, 0);
}

export function normalizeImportedTask(source: TaskJson, ids: Map<string, string>, workspace: string): TaskJson {
    const copy = JSON.parse(JSON.stringify(source));
    const now = Date.now();
    const scopes = new Set([
        'chat_context',
        'goal_state',
        'goal_final_snapshots',
        'goal_event_log',
        'goal_event_log_tail',
        'benchmark_usage',
        'tool_result_replacement_state',
        'auto_compact_state',
        'microcompact_state',
        'session_memory_state'
    ]);
    // These are original user/tool payloads, not OpenDesk record metadata.
    const opaque = new Set(['args_object', 'args_string', 'arguments', 'result', 'result_object', 'rendered']);
    const timestamps: { object: TaskJson; key: string; time: number; numeric: boolean }[] = [];
    let previousMessageTime = 0;
    for (const message of copy.chat_context?.messages ?? []) {
        if (message.role === 'compact_separator') continue;
        const time = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(message.timestamp);
        message.timestamp = Number.isFinite(time) ? time : previousMessageTime + 1;
        previousMessageTime = message.timestamp;
    }
    const remap = (value: any, depth = 0): void => {
        if (depth > 100) throw new TaskTransferError('invalidTask');
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
            if (opaque.has(key)) continue;
            if ((key === 'taskId' || key === 'task_id') && typeof child === 'string' && ids.has(child))
                value[key] = ids.get(child);
            else if (
                /(?:_at|At)$|^(?:timestamp|message_timestamp)$/.test(key) &&
                (typeof child === 'string' || typeof child === 'number')
            ) {
                const time = typeof child === 'number' ? child : Date.parse(child);
                timestamps.push({
                    object: value,
                    key,
                    time: Number.isFinite(time) ? time : 0,
                    numeric: typeof child === 'number'
                });
            } else if (child && typeof child === 'object' && (value !== copy || scopes.has(key)))
                remap(child, depth + 1);
        }
    };
    remap(copy);
    // 深拷贝已隔离源数据：产物相对路径按新任务 id 改写（文件本体由 restoreArtifacts 落盘）
    const targetTaskId = ids.get(source.task_id);
    if (typeof targetTaskId === 'string') {
        rewriteImportedArtifactRelativePaths(copy as Record<string, unknown>, source.task_id, targetTaskId);
    }
    // Rebuild a compact import-time timeline: equal instants stay equal, chronological
    // order is retained, and even future-dated source records never sort into the future.
    const ordered = [...new Set(timestamps.map((entry) => entry.time))].sort((a, b) => a - b);
    const freshTimes = new Map(ordered.map((time, index) => [time, now - ordered.length + index]));
    for (const entry of timestamps) {
        const time = freshTimes.get(entry.time)!;
        entry.object[entry.key] = entry.numeric ? time : new Date(time).toISOString();
    }
    copy.created_at = new Date(now - ordered.length).toISOString();
    copy.updated_at = new Date(now).toISOString();
    copy.task_id = ids.get(source.task_id);
    copy.parent_id = ids.get(source.parent_id) ?? null;
    copy.task_status = 'stopped';
    if (!copy.parent_id) delete copy.internal;
    copy.workspace = workspace;
    for (const key of ['workspaceID', 'executionNodeId', 'executionNodeLabel', 'origin', 'harnessContext'])
        delete copy[key];
    if (isObject(copy.goal_state)) {
        delete copy.goal_state.schedulerLease;
        if (copy.goal_state.status === 'active') {
            copy.goal_state.status = 'paused';
            copy.goal_state.pausedAt = new Date(now).toISOString();
            copy.goal_state.updatedAt = copy.goal_state.pausedAt;
        }
    }
    return copy;
}
