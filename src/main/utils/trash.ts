/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

// 统一文件回收站：各平台沙箱（Windows Detours / Linux LD_PRELOAD / OpenHarmony
// LD_PRELOAD / macOS DYLD interpose）在拦截到删除时，把文件移动到任务级回收站
// 目录 `<opendeskDir>/trash/<taskId>/<uuid>.back`，并追加记录到同目录的
// `summary.json`（顶层为条目数组）。本模块负责宿主侧的读取、搜索、恢复与过期
// 清理；summary.json 的写入由各沙箱原生层在删除发生时完成。
//
// 另保留跨平台"系统回收站"能力（resolveOpenDeskTrashDirectory / openSystemTrash），
// 与统一回收站无关：它打开的是操作系统自身的回收站/废纸篓。
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { getPlatform } from '../../platforms/base.js';
import { getHarmonyHomeDirectory, getHarmonyRuntimeEnvironment } from '../../platforms/bridges/harmonyos/runtime.js';
import { getTaskTrashDirectory, getTrashRootDirectory } from './setting.js';
import { getTempDir } from './temp.js';
import { logger } from './logger.js';

/** summary.json 中的单条删除记录（字段名与各沙箱原生层写入的 JSON 保持一致）。 */
export interface TrashEntry {
    /** v4 UUID，对应回收站内的 `<uuid>.back` 文件名 */
    uuid: string;
    /** 删除时的原始绝对路径（恢复目标） */
    original_path: string;
    /** 文件字节数（目录为 0） */
    size: number;
    /** 删除时间（ISO 8601 UTC） */
    deleted_at: string;
}

export const TRASH_SUMMARY_FILENAME = 'summary.json';
export const TRASH_BACK_SUFFIX = '.back';
/** 统一回收站的保留窗口：最后一次用户交互超过 7 天的任务，其回收站在启动时清理 */
export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** 回收站目录名即任务 ID（形如 task_xxx）；其他名字按孤儿目录处理 */
const TRASH_TASK_DIR_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

// ── 系统回收站（平台能力，独立于统一回收站） ────────────────────────────────

/** 各平台系统回收站目录（Windows 返回 null，使用系统回收站窗口）。 */
export function resolveOpenDeskTrashDirectory(): string | null {
    if (process.platform === 'openharmony') {
        const runtime = getHarmonyRuntimeEnvironment();
        if (runtime) return path.join(getHarmonyHomeDirectory(runtime), 'Trash');
        return process.env.USER_DATA_PATH ? path.join(process.env.USER_DATA_PATH, 'Trash') : null;
    }
    if (process.platform === 'linux') return path.join(os.homedir(), '.local', 'share', 'Trash');
    if (process.platform === 'darwin') return path.join(os.homedir(), '.Trash');
    return null; // Windows：使用系统回收站窗口
}

/** 用系统能力打开当前平台的回收站。 */
export async function openSystemTrash(): Promise<void> {
    if (process.platform === 'win32') {
        // 打开 Windows 回收站窗口（系统能力）
        const child = spawn('explorer.exe', ['shell:RecycleBinFolder'], {
            stdio: 'ignore',
            detached: true
        });
        child.unref();
        return;
    }
    const directory = resolveOpenDeskTrashDirectory();
    if (!directory) throw new Error('当前平台没有可打开的回收站目录');
    await getPlatform().openPath(directory);
}

// ── 统一回收站：目录 ────────────────────────────────────────────────────────

/**
 * 确保统一回收站根目录存在并返回路径（`<opendeskDir>/trash/`）。
 * 应用启动时调用一次；沙箱启动参数也会按任务惰性创建子目录。
 */
export function ensureTrashRootDirectory(): string {
    return getTrashRootDirectory();
}

/** 便捷包装：任务级回收站目录（默认创建）。 */
export function taskTrashDirectory(taskId: string, ensureExists: boolean = true): string {
    return getTaskTrashDirectory(taskId, ensureExists);
}

// ── 统一回收站：summary 读取 ────────────────────────────────────────────────

/**
 * 读取任务回收站目录的 summary.json 条目列表。
 * 文件缺失/损坏/顶层不是数组时返回空列表（读操作绝不创建文件）。
 */
export function readTrashSummary(taskTrashDirectory: string): TrashEntry[] {
    const summaryPath = path.join(taskTrashDirectory, TRASH_SUMMARY_FILENAME);
    let raw: string;
    try {
        raw = fs.readFileSync(summaryPath, 'utf8');
    } catch {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const entries: TrashEntry[] = [];
        for (const item of parsed) {
            if (!item || typeof item !== 'object') continue;
            const uuid = typeof item.uuid === 'string' ? item.uuid : '';
            const originalPath = typeof item.original_path === 'string' ? item.original_path : '';
            if (!uuid || !originalPath) continue;
            entries.push({
                uuid,
                original_path: originalPath,
                size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0,
                deleted_at: typeof item.deleted_at === 'string' ? item.deleted_at : ''
            });
        }
        return entries;
    } catch (error) {
        logger.warn(`[trash] 解析 summary.json 失败（忽略）: ${taskTrashDirectory} ${error}`);
        return [];
    }
}

/** 便捷包装：按任务 ID 读取 summary 条目。 */
export function readTaskTrashSummary(taskId: string): TrashEntry[] {
    return readTrashSummary(getTaskTrashDirectory(taskId, false));
}

// ── 统一回收站：搜索 ────────────────────────────────────────────────────────

export interface TrashSearchOptions {
    /** 回收站根目录；缺省时使用 `<opendeskDir>/trash/` */
    trashRoot?: string;
    /** task：只搜指定任务；global：跨任务搜索 */
    scope: 'task' | 'global';
    /** scope=task 时的任务 ID */
    taskId?: string;
    /** 大小写不敏感的子串，匹配原始路径；空串/缺省表示不按关键字过滤 */
    keyword?: string;
    /**
     * scope=global 且无关键字时生效：只列出这些任务的回收站
     * （"最近一个星期的任务"场景由调用方按任务交互时间传入）。
     */
    recentTaskIds?: string[];
    offset?: number;
    limit?: number;
}

export interface TrashSearchResult {
    total: number;
    entries: Array<TrashEntry & { task_id: string }>;
}

/** 枚举回收站根目录下的任务目录（仅目录名匹配任务 ID 约定）。 */
function listTaskTrashDirectories(trashRoot: string): string[] {
    let names: string[];
    try {
        names = fs.readdirSync(trashRoot);
    } catch {
        return [];
    }
    return names.filter((name) => TRASH_TASK_DIR_PATTERN.test(name)).sort();
}

function deletedAtTime(entry: TrashEntry): number {
    const time = Date.parse(entry.deleted_at);
    return Number.isFinite(time) ? time : 0;
}

/**
 * 搜索回收站条目。结果按删除时间从近到远排序（原生侧追加了同名条目的场景
 * 同样按时间稳定排序），分页由 offset/limit 控制，total 为过滤后的总数。
 */
export function searchTrashEntries(options: TrashSearchOptions): TrashSearchResult {
    const trashRoot = options.trashRoot ?? getTrashRootDirectory();
    const keyword = (options.keyword ?? '').trim().toLowerCase();

    let taskDirs: string[];
    if (options.scope === 'task') {
        taskDirs = options.taskId && TRASH_TASK_DIR_PATTERN.test(options.taskId) ? [options.taskId] : [];
    } else if (keyword) {
        // 有关键字：全局搜索所有任务
        taskDirs = listTaskTrashDirectories(trashRoot);
    } else if (options.recentTaskIds) {
        taskDirs = options.recentTaskIds.filter((taskId) => TRASH_TASK_DIR_PATTERN.test(taskId));
    } else {
        taskDirs = listTaskTrashDirectories(trashRoot);
    }

    const matched: Array<TrashEntry & { task_id: string }> = [];
    for (const taskId of taskDirs) {
        const taskDir = path.join(trashRoot, taskId);
        for (const entry of readTrashSummary(taskDir)) {
            if (keyword && !entry.original_path.toLowerCase().includes(keyword)) continue;
            matched.push({ ...entry, task_id: taskId });
        }
    }
    matched.sort((a, b) => deletedAtTime(b) - deletedAtTime(a));

    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = Math.max(0, Math.floor(options.limit ?? matched.length));
    return {
        total: matched.length,
        entries: matched.slice(offset, offset + limit)
    };
}

// ── 统一回收站：恢复 ────────────────────────────────────────────────────────

export interface TrashRestoreOptions {
    trashRoot?: string;
    taskId: string;
    uuid: string;
    /** 目标路径已存在文件时是否覆盖；false 时返回 exists 提示由 UI 二次确认 */
    overwrite: boolean;
}

export interface TrashRestoreResult {
    restored: boolean;
    /** 目标路径已存在（overwrite=false 或内容一致时出现） */
    exists?: boolean;
    /** 目标已存在且内容与回收站文件一致（仅普通文件条目可判定） */
    identical?: boolean;
    /** 目标现有文件的最近修改时间（毫秒时间戳，供覆盖确认展示） */
    target_mtime?: number;
    /** 恢复目标路径（成功或已存在时返回） */
    target?: string;
    message?: string;
}

/** 流式计算文件 SHA-1（大文件不全量读入内存）；失败返回 null。 */
function fileSha1(filePath: string): string | null {
    try {
        const hash = crypto.createHash('sha1');
        const fd = fs.openSync(filePath, 'r');
        try {
            const buffer = Buffer.alloc(1024 * 1024);
            for (;;) {
                const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
                if (bytes <= 0) break;
                hash.update(buffer.subarray(0, bytes));
            }
        } finally {
            fs.closeSync(fd);
        }
        return hash.digest('hex');
    } catch {
        return null;
    }
}

/**
 * 判断回收站文件与目标现有文件内容是否一致。
 * 仅两侧都是普通文件时可判定（先比大小再比哈希）；目录/读失败返回 null（无法判定）。
 */
function filesHaveSameContent(backPath: string, target: string): boolean | null {
    try {
        const backStat = fs.statSync(backPath);
        const targetStat = fs.statSync(target);
        if (!backStat.isFile() || !targetStat.isFile()) return null;
        if (backStat.size !== targetStat.size) return false;
        const backHash = fileSha1(backPath);
        const targetHash = fileSha1(target);
        if (!backHash || !targetHash) return null;
        return backHash === targetHash;
    } catch {
        return null;
    }
}

/**
 * 确保目标父目录存在。父目录已存在时绝不调用 mkdir——Windows 盘符根（如 `D:\`）
 * 已存在但 fs.mkdirSync(…, {recursive:true}) 会抛 EPERM，导致根目录文件无法找回。
 */
function ensureParentDirectory(parent: string): void {
    if (fs.existsSync(parent)) return;
    try {
        fs.mkdirSync(parent, { recursive: true });
    } catch (error) {
        // 并发创建等竞态下目录可能已就位：再次存在则容忍
        if (fs.existsSync(parent)) return;
        throw error;
    }
}

/**
 * 找回（恢复）回收站条目：把 `<uuid>.back` 复制回原始路径。
 * 恢复是复制而非移动——回收站内容保留，用户可以多次找回或恢复到不同位置。
 *
 * 目标已存在时：普通文件条目会做内容比对——一致返回 `identical: true`
 * （UI 提示无需找回）；不同返回 `exists: true` + 现有文件修改时间
 * （UI 弹覆盖确认），`overwrite: true` 时执行覆盖。
 */
export function restoreTrashEntry(options: TrashRestoreOptions): TrashRestoreResult {
    const { taskId, uuid, overwrite } = options;
    if (!UUID_PATTERN.test(uuid)) {
        return { restored: false, message: 'invalid trash uuid' };
    }
    // taskId 来自 renderer 的 IPC 入参：约束字符集防路径穿越（目录名即任务 ID）
    if (!TRASH_TASK_DIR_PATTERN.test(taskId)) {
        return { restored: false, message: 'invalid trash task id' };
    }
    const taskDir = path.join(options.trashRoot ?? getTrashRootDirectory(), taskId);
    const entry = readTrashSummary(taskDir).find((item) => item.uuid === uuid);
    if (!entry) {
        return { restored: false, message: 'trash entry not found' };
    }
    const backPath = path.join(taskDir, `${uuid}${TRASH_BACK_SUFFIX}`);
    if (!fs.existsSync(backPath)) {
        return { restored: false, message: 'trash back file missing' };
    }
    const target = entry.original_path;
    if (fs.existsSync(target)) {
        let targetMtime: number | undefined;
        try {
            targetMtime = fs.statSync(target).mtimeMs;
        } catch {
            // stat 失败时无 mtime 可展示，不阻塞判定
        }
        if (!overwrite) {
            // 内容一致：无需找回（UI 直接提示）；不同：UI 弹覆盖确认（带现有文件修改时间）
            const identical = filesHaveSameContent(backPath, target);
            if (identical === true) {
                return { restored: false, exists: true, identical: true, target_mtime: targetMtime, target };
            }
            return {
                restored: false,
                exists: true,
                identical: identical === false ? false : undefined,
                target_mtime: targetMtime,
                target
            };
        }
        // overwrite=true：用户已确认覆盖，直接复制
    } else {
        // 目标父目录可能已随删除一并消失（或位于盘符根）
        try {
            ensureParentDirectory(path.dirname(target));
        } catch (error) {
            return { restored: false, message: `cannot create parent directory: ${error}` };
        }
    }
    try {
        // 目录条目递归复制；已存在目标（overwrite=true）直接覆盖
        fs.cpSync(backPath, target, { recursive: true, force: overwrite, errorOnExist: !overwrite });
        return { restored: true, target };
    } catch (error) {
        logger.warn(`[trash] 恢复失败: ${backPath} -> ${target} ${error}`);
        return { restored: false, message: `restore failed: ${error}` };
    }
}

// ── 统一回收站：预览打开 ────────────────────────────────────────────────────

export interface TrashPreviewOptions {
    trashRoot?: string;
    taskId: string;
    uuid: string;
    /** 预览副本根目录；缺省时使用应用托管临时目录下的 opendesk-trash-preview */
    previewRoot?: string;
}

/** 预览副本的保留期：超过该时长未被修改的副本在清扫时删除（24 小时） */
export const TRASH_PREVIEW_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 预览副本清扫的运行间隔（2 小时，启动后由调度器周期执行） */
export const TRASH_PREVIEW_CLEANUP_INTERVAL_MS = 2 * 60 * 60 * 1000;

/** 预览副本根目录（应用托管临时目录下；HarmonyOS 为应用沙箱 tempDir） */
export function getTrashPreviewRoot(): string {
    return path.join(getTempDir(), 'opendesk-trash-preview');
}

/**
 * 为"打开"准备回收站条目的预览副本：以删除时的原始文件名复制到临时目录。
 * `<uuid>.back` 的扩展名无应用关联，按原始文件名命名后系统默认应用才能选中
 * 正确的程序。.back 落盘后内容不可变，副本已存在时直接复用（临时目录由系统
 * 或应用退出清理）。返回副本路径；失败返回 message。
 */
export function prepareTrashPreviewCopy(options: TrashPreviewOptions): { path?: string; message?: string } {
    const { taskId, uuid } = options;
    if (!UUID_PATTERN.test(uuid)) {
        return { message: 'invalid trash uuid' };
    }
    if (!TRASH_TASK_DIR_PATTERN.test(taskId)) {
        return { message: 'invalid trash task id' };
    }
    const taskDir = path.join(options.trashRoot ?? getTrashRootDirectory(), taskId);
    const entry = readTrashSummary(taskDir).find((item) => item.uuid === uuid);
    if (!entry) {
        return { message: 'trash entry not found' };
    }
    const backPath = path.join(taskDir, `${uuid}${TRASH_BACK_SUFFIX}`);
    if (!fs.existsSync(backPath)) {
        return { message: 'trash back file missing' };
    }
    const previewRoot = options.previewRoot ?? getTrashPreviewRoot();
    const name =
        entry.original_path
            .replace(/[\\/]+$/, '')
            .split(/[\\/]/)
            .pop() || 'file';
    const previewPath = path.join(previewRoot, taskId, uuid, name);
    if (!fs.existsSync(previewPath)) {
        try {
            fs.mkdirSync(path.dirname(previewPath), { recursive: true });
            // 目录条目递归复制（openPath 打开目录时呈现文件管理器视图）
            fs.cpSync(backPath, previewPath, { recursive: true });
        } catch (error) {
            logger.warn(`[trash] 创建预览副本失败: ${backPath} -> ${previewPath} ${error}`);
            return { message: `cannot create preview copy: ${error}` };
        }
    }
    return { path: previewPath };
}

export interface TrashPreviewCleanupOptions {
    previewRoot?: string;
    /** 保留期：修改时间早于该时长的副本被删除（默认 24 小时） */
    maxAgeMs?: number;
    now?: number;
}

/**
 * 清扫过期的预览副本（"打开"功能生成的临时拷贝）。
 * 系统临时目录不会被及时清理（Windows 完全不清理 %TEMP%），需应用侧自管：
 * 应用启动时与运行期周期调用。正在被查看器占用的副本删除会失败，逐项容忍
 * （Windows 上跳过留待下次，POSIX 上查看器仍持有 fd 可继续查看）。
 * 返回删除的副本数量。
 */
export function cleanupTrashPreviewCopies(options?: TrashPreviewCleanupOptions): number {
    const previewRoot = options?.previewRoot ?? getTrashPreviewRoot();
    const now = options?.now ?? Date.now();
    const maxAgeMs = options?.maxAgeMs ?? TRASH_PREVIEW_RETENTION_MS;
    let removed = 0;

    const isExpired = (p: string): boolean => {
        try {
            return now - fs.statSync(p).mtimeMs >= maxAgeMs;
        } catch {
            return false; // stat 失败（已消失/无权限）时保守保留
        }
    };
    const removeIfExpired = (p: string): void => {
        if (!isExpired(p)) return;
        try {
            fs.rmSync(p, { recursive: true, force: true });
            removed++;
        } catch (error) {
            // 被查看器占用等：跳过留待下次清扫
            logger.warn(`[trash] 清理预览副本失败（跳过）: ${p} ${error}`);
        }
    };

    let taskDirs: string[];
    try {
        taskDirs = fs.readdirSync(previewRoot);
    } catch {
        return 0; // 预览根目录尚不存在
    }
    for (const taskEntry of taskDirs) {
        const taskDir = path.join(previewRoot, taskEntry);
        let uuidDirs: string[];
        try {
            uuidDirs = fs.readdirSync(taskDir);
        } catch {
            // 顶层散落文件（防御）：按年龄清理
            removeIfExpired(taskDir);
            continue;
        }
        for (const uuidEntry of uuidDirs) {
            const uuidDir = path.join(taskDir, uuidEntry);
            let names: string[];
            try {
                names = fs.readdirSync(uuidDir);
            } catch {
                removeIfExpired(uuidDir);
                continue;
            }
            for (const name of names) {
                removeIfExpired(path.join(uuidDir, name));
            }
            // 副本清空后收敛空的 uuid 目录
            try {
                fs.rmdirSync(uuidDir);
            } catch {
                // 非空或清理失败：保留
            }
        }
        try {
            fs.rmdirSync(taskDir);
        } catch {
            // 非空：保留
        }
    }
    return removed;
}

/** 预览副本周期清扫（运行期每 2 小时一次；启动时的首次清扫由 initializeTrash 完成）。 */
export function startTrashPreviewCleanupScheduler(): () => void {
    const timer = setInterval(() => {
        try {
            cleanupTrashPreviewCopies();
        } catch (error) {
            logger.warn(`[trash] 预览副本周期清扫失败（忽略）: ${error}`);
        }
    }, TRASH_PREVIEW_CLEANUP_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}

// ── 统一回收站：过期清理 ────────────────────────────────────────────────────

export interface TrashCleanupOptions {
    trashRoot?: string;
    /**
     * 仍需保留的任务及其最后一次用户交互时间（TaskState.updated_at，Date、
     * 时间戳毫秒或 ISO 字符串）。未出现在 Map 中的任务目录视为孤儿，按目录
     * 修改时间兜底判断；交互时间超过保留窗口（默认 7 天）的目录一并清理。
     */
    retained: Map<string, Date | number | string | undefined>;
    now?: number;
    maxAgeMs?: number;
}

/** 清理过期回收站目录，返回被清理的任务 ID 列表。失败逐目录容忍，不抛出。 */
export function cleanupExpiredTrash(options: TrashCleanupOptions): string[] {
    const trashRoot = options.trashRoot ?? getTrashRootDirectory();
    const now = options.now ?? Date.now();
    const maxAgeMs = options.maxAgeMs ?? TRASH_RETENTION_MS;
    const removed: string[] = [];

    for (const taskId of listTaskTrashDirectories(trashRoot)) {
        const taskDir = path.join(trashRoot, taskId);
        let dirMtime = 0;
        try {
            dirMtime = fs.statSync(taskDir).mtimeMs;
        } catch {
            continue;
        }
        const lastInteraction = options.retained.get(taskId);
        const lastActiveMs =
            lastInteraction === undefined || lastInteraction === null ? dirMtime : new Date(lastInteraction).getTime();
        // 交互时间无效时退回目录 mtime，避免误删
        const effectiveActiveMs = Number.isFinite(lastActiveMs) && lastActiveMs > 0 ? lastActiveMs : dirMtime;
        if (now - effectiveActiveMs < maxAgeMs) continue;
        try {
            fs.rmSync(taskDir, { recursive: true, force: true });
            removed.push(taskId);
        } catch (error) {
            logger.warn(`[trash] 清理回收站目录失败（跳过）: ${taskDir} ${error}`);
        }
    }
    if (removed.length > 0) {
        logger.info(`[trash] 已清理 ${removed.length} 个过期任务回收站: ${removed.join(', ')}`);
    }
    return removed;
}

/**
 * 应用启动时的统一回收站初始化：确保 `<opendeskDir>/trash/` 存在，并清理
 * "最后一次用户交互超过 7 天"的任务的回收站（未知任务的孤儿目录按目录修改
 * 时间兜底）。taskProvider 由调用方传入任务管理器的交互时间快照；异常只记日志
 * 不阻塞启动。
 */
export function initializeTrash(taskProvider?: () => Map<string, Date | number | string | undefined>): string[] {
    ensureTrashRootDirectory();
    // 预览副本清扫（上次会话残留；运行期由 startTrashPreviewCleanupScheduler 周期执行）
    try {
        cleanupTrashPreviewCopies();
    } catch (error) {
        logger.warn(`[trash] 清扫预览副本失败（忽略）: ${error}`);
    }
    let retained: Map<string, Date | number | string | undefined> = new Map();
    if (taskProvider) {
        try {
            retained = taskProvider();
        } catch (error) {
            logger.warn(`[trash] 获取任务交互时间失败（仅按目录时间清理）: ${error}`);
        }
    }
    return cleanupExpiredTrash({ retained });
}
