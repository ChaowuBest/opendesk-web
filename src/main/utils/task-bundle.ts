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
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { crc32 } from 'node:zlib';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import yazl from 'yazl';
import { buildAtomicWriteTmpPath, getTempDir } from './temp.js';
import { jsonChunksAsBuffers } from './json-stream-write.js';

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

export interface TaskImportPreview {
    entries: TaskImportEntry[];
    dispose(): Promise<void>;
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
            if (
                entries.has(name) ||
                !/^(manifest\.json|tasks\/|tasks\/[a-zA-Z0-9_-]{1,128}\.json)$/.test(name) ||
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

async function previewArchive(zip: ZipFile): Promise<TaskImportEntry[]> {
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
    if (manifest.version !== 1) throw new TaskTransferError('unsupportedVersion');
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
    return result;
}

export async function readTaskImportFile(filePath: string): Promise<TaskImportPreview> {
    if (!(await fs.promises.stat(filePath)).isFile()) throw new TaskTransferError('invalidBundle');
    const directory = await fs.promises.mkdtemp(path.join(getTempDir(), 'opendesk-task-preview-'));
    const snapshot = path.join(directory, 'snapshot');
    let zip: ZipFile | undefined;
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
            return { entries: [entry], dispose };
        }
        zip = await yauzl.openPromise(snapshot, { autoClose: false, decodeStrings: false }).catch((error) => {
            throw archiveError(error);
        });
        return { entries: await previewArchive(zip), dispose };
    } catch (error) {
        await dispose().catch(() => {});
        throw error;
    }
}

export async function writeTaskBundle(
    filePath: string,
    ids: Iterable<string>,
    snapshot: (id: string) => TaskJson | Promise<TaskJson>
): Promise<void> {
    const uniqueIds = new Set<string>();
    const tasks: { id: string; path: string }[] = [];
    for (const id of ids) {
        if (!safeId(id) || uniqueIds.has(id)) throw new TaskTransferError('invalidTask');
        uniqueIds.add(id);
        tasks.push({ id, path: `tasks/${id}.json` });
    }
    if (!tasks.length) throw new TaskTransferError('invalidTask');

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
        addJson('manifest.json', () => ({
            format: 'opendesk-task-bundle',
            version: 1,
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
