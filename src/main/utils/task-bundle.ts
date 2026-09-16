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

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRaw, crc32 } from 'node:zlib';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { buildAtomicWriteTmpPath } from './temp.js';

// These codes are protocol values; GUI/TUI translate them at the presentation boundary.
export type TaskTransferErrorCode =
    | 'invalidBundle'
    | 'invalidTask'
    | 'unsupportedVersion'
    | 'tooLarge'
    | 'writeFailed'
    | 'expired'
    | 'invalidWorkspace';
export class TaskTransferError extends Error {
    constructor(readonly code: TaskTransferErrorCode) {
        super(code);
    }
}
export type TaskJson = Record<string, any>;
export interface TaskImportEntry {
    id: string;
    name: string;
    parentId: string | null;
    messageCount: number;
    fingerprint?: string;
    json?: TaskJson;
    error?: TaskTransferErrorCode;
}

export const TASK_BUNDLE_LIMITS = {
    tasks: 1000,
    taskBytes: 16 * 1024 * 1024,
    totalBytes: 128 * 1024 * 1024,
    fileBytes: 64 * 1024 * 1024
};
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const isObject = (value: unknown): value is TaskJson => !!value && typeof value === 'object' && !Array.isArray(value);
const inflate = promisify(inflateRaw);

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

export function taskFingerprint(json: TaskJson): string {
    const canonical = (value: any, depth = 0): any => {
        if (depth > 100) throw new TaskTransferError('invalidTask');
        if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
        if (!isObject(value)) return value;
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonical(value[key], depth + 1)])
        );
    };
    const data = JSON.parse(JSON.stringify(json));
    delete data.import_metadata;
    return createHash('sha256')
        .update(JSON.stringify(canonical(data)))
        .digest('hex');
}

function parseEntry(raw: string, id?: string): TaskImportEntry {
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
        return {
            id: json.task_id,
            name: typeof json.task_name === 'string' ? json.task_name : '',
            parentId: typeof json.parent_id === 'string' ? json.parent_id : null,
            messageCount: json.chat_context.messages.length,
            fingerprint: taskFingerprint(json),
            json
        };
    } catch {
        return { id: id ?? '', name: id ?? '', parentId: null, messageCount: 0, error: 'invalidTask' };
    }
}

async function readLimited(filePath: string): Promise<Buffer> {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > TASK_BUNDLE_LIMITS.fileBytes) throw new TaskTransferError('tooLarge');
        // A fixed buffer also bounds a file that grows between stat and read.
        const bytes = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
        }
        if (offset !== stat.size) throw new TaskTransferError('invalidBundle');
        return bytes.subarray(0, offset);
    } finally {
        await handle.close();
    }
}

export async function readTaskImportFile(filePath: string): Promise<TaskImportEntry[]> {
    const bytes = await readLimited(filePath);
    if (path.extname(filePath).toLowerCase() === '.json') {
        if (bytes.length > TASK_BUNDLE_LIMITS.taskBytes) throw new TaskTransferError('tooLarge');
        return [parseEntry(bytes.toString('utf8'))];
    }
    try {
        const zip = new AdmZip(bytes);
        const entries = zip.getEntries();
        if (entries.length > TASK_BUNDLE_LIMITS.tasks + 2) throw new TaskTransferError('tooLarge');
        const names = new Set<string>();
        let total = 0;
        for (const entry of entries) {
            const name = entry.entryName;
            if (
                names.has(name) ||
                !/^(manifest\.json|tasks\/|tasks\/[a-zA-Z0-9_-]{1,128}\.json)$/.test(name) ||
                entry.header.flags & 1 ||
                ((entry.attr >>> 16) & 0xf000) === 0xa000
            ) {
                throw new TaskTransferError('invalidBundle');
            }
            names.add(name);
            total += entry.header.size;
            if (entry.header.size > TASK_BUNDLE_LIMITS.taskBytes || total > TASK_BUNDLE_LIMITS.totalBytes) {
                throw new TaskTransferError('tooLarge');
            }
        }
        let inflatedBytes = 0;
        const readEntry = async (name: string): Promise<string> => {
            const entry = zip.getEntry(name);
            if (!entry || entry.isDirectory) throw new TaskTransferError('invalidBundle');
            const compressed = entry.getCompressedData();
            // Do not trust the ZIP's advertised size: bound the inflater's actual output.
            const data =
                entry.header.method === 0
                    ? compressed
                    : entry.header.method === 8
                      ? await inflate(compressed, { maxOutputLength: TASK_BUNDLE_LIMITS.taskBytes }).catch(() => {
                            throw new TaskTransferError('tooLarge');
                        })
                      : undefined;
            inflatedBytes += data?.length ?? 0;
            if (inflatedBytes > TASK_BUNDLE_LIMITS.totalBytes) throw new TaskTransferError('tooLarge');
            if (!data || data.length !== entry.header.size || crc32(data) !== entry.header.crc) {
                throw new TaskTransferError('invalidBundle');
            }
            return data.toString('utf8');
        };
        const manifest = JSON.parse(await readEntry('manifest.json'));
        if (!isObject(manifest) || manifest.format !== 'opendesk-task-bundle')
            throw new TaskTransferError('invalidBundle');
        if (manifest.version !== 1) throw new TaskTransferError('unsupportedVersion');
        if (
            !Array.isArray(manifest.tasks) ||
            !manifest.tasks.length ||
            manifest.tasks.length > TASK_BUNDLE_LIMITS.tasks
        ) {
            throw new TaskTransferError('invalidBundle');
        }
        const ids = new Set<string>();
        for (const item of manifest.tasks) {
            if (!isObject(item) || !safeId(item.id) || ids.has(item.id) || item.path !== `tasks/${item.id}.json`) {
                throw new TaskTransferError('invalidBundle');
            }
            ids.add(item.id);
        }
        if (
            entries.some(
                (entry) =>
                    !entry.isDirectory &&
                    entry.entryName !== 'manifest.json' &&
                    !manifest.tasks.some((item: any) => item.path === entry.entryName)
            )
        )
            throw new TaskTransferError('invalidBundle');
        const result: TaskImportEntry[] = [];
        for (const item of manifest.tasks) {
            try {
                const entry = parseEntry(await readEntry(item.path), item.id);
                if (entry.error && typeof item.parentId === 'string') entry.parentId = item.parentId;
                if (entry.error && typeof item.name === 'string') entry.name = item.name;
                result.push(entry);
            } catch (error) {
                if (error instanceof TaskTransferError && error.code === 'tooLarge') throw error;
                result.push({
                    id: item.id,
                    name: typeof item.name === 'string' ? item.name : item.id,
                    parentId: typeof item.parentId === 'string' ? item.parentId : null,
                    messageCount: 0,
                    error: 'invalidTask'
                });
            }
        }
        const byId = new Map(result.map((entry) => [entry.id, entry]));
        for (const entry of result) {
            const visited = new Set<string>();
            let current: TaskImportEntry | undefined = entry;
            while (current) {
                if (visited.has(current.id)) {
                    entry.error = 'invalidTask';
                    break;
                }
                visited.add(current.id);
                current = current.parentId ? byId.get(current.parentId) : undefined;
            }
        }
        // A damaged family is one import unit. Healthy unrelated tasks remain selectable.
        for (let changed = true; changed;) {
            changed = false;
            for (const entry of result) {
                const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
                if (parent && Boolean(entry.error) !== Boolean(parent.error)) {
                    entry.error = parent.error = 'invalidTask';
                    changed = true;
                }
            }
        }
        return result;
    } catch (error) {
        if (error instanceof TaskTransferError) throw error;
        throw new TaskTransferError('invalidBundle');
    }
}

export async function writeTaskBundle(filePath: string, tasks: TaskJson[]): Promise<void> {
    if (!tasks.length || tasks.length > TASK_BUNDLE_LIMITS.tasks) throw new TaskTransferError('tooLarge');
    const zip = new AdmZip();
    const manifest = {
        format: 'opendesk-task-bundle',
        version: 1,
        exportedAt: new Date().toISOString(),
        tasks: [] as { id: string; path: string; parentId: string | null; name: string }[]
    };
    let total = 0;
    const ids = new Set<string>();
    for (const task of tasks) {
        if (!safeId(task.task_id) || ids.has(task.task_id)) throw new TaskTransferError('invalidTask');
        ids.add(task.task_id);
        const bytes = Buffer.from(JSON.stringify(task, null, 4));
        total += bytes.length;
        if (bytes.length > TASK_BUNDLE_LIMITS.taskBytes || total > TASK_BUNDLE_LIMITS.totalBytes)
            throw new TaskTransferError('tooLarge');
        const entryPath = `tasks/${task.task_id}.json`;
        zip.addFile(entryPath, bytes);
        manifest.tasks.push({
            id: task.task_id,
            path: entryPath,
            parentId: task.parent_id ?? null,
            name: task.task_name ?? ''
        });
    }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 4)));
    const bytes = await new Promise<Buffer>((resolve, reject) => zip.toBuffer(resolve, reject));
    if (bytes.length > TASK_BUNDLE_LIMITS.fileBytes) throw new TaskTransferError('tooLarge');
    const temporary = buildAtomicWriteTmpPath(filePath);
    try {
        await fs.promises.writeFile(temporary, bytes);
        await fs.promises.rename(temporary, filePath);
    } finally {
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
    const remap = (value: any): void => {
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
            } else if (child && typeof child === 'object' && (value !== copy || scopes.has(key))) remap(child);
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
    copy.import_metadata = {
        source_id: source.task_id,
        fingerprint: taskFingerprint(source),
        imported_at: new Date(now).toISOString(),
        source_workspace: source.workspace,
        source_execution_node: source.executionNodeLabel ?? source.executionNodeId
    };
    return copy;
}
