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
import AdmZip from 'adm-zip';
import { t } from '../../../locale/index.js';
import { getTempDir } from '../../utils/temp.js';
import { parseAndValidateSkillMd } from '../skillmgr/skill-schema.js';
import {
    StaffDefinitionSchema,
    StaffMessageSchema,
    StaffPermissionSchema,
    staffTriggerIntervalMs,
    sumTaskUsage,
    type DueStaffTrigger,
    type HistoryQuery,
    type HistoryResult,
    type MessageAttachmentInput,
    type PreparedMessage,
    type PresetStaffDefinition,
    type StaffDefinition,
    type StaffDefinitionInput,
    type StaffDetail,
    type StaffListItem,
    type StaffMessage,
    type StaffMetadata,
    type StaffPermission,
    type StaffResourceContent,
    type StaffSkillImportCandidate,
    type StaffSkillSummary,
    type StaffTaskRecord,
    type StaffUpdateInput
} from './common.js';

const ZIP_MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const PORTRAIT_DATA_URI_MAX_LENGTH = 8 * 1024 * 1024;
const HISTORY_CURSOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SKILL_SCAN_MAX_ENTRIES = 20_000;
const SKILL_SCAN_MAX_RESULTS = 1_000;
const DEFAULT_AGENTS_MD = '# Digital employee instructions\n\nDescribe this employee’s role and working style here.\n';
const EMPTY_MCP = { servers: [] };
const EMPTY_PERMISSION: StaffPermission = { directories: [], network_access: true };

function atomicWriteJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function addDirectoryToZip(zip: AdmZip, directory: string, zipDirectory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const sourcePath = path.join(directory, entry.name);
        const stat = fs.lstatSync(sourcePath);
        if (stat.isSymbolicLink()) throw new Error(t('agentoffice.error.definitionSymlink'));
        if (stat.isDirectory()) {
            addDirectoryToZip(zip, sourcePath, path.posix.join(zipDirectory, entry.name));
        } else if (stat.isFile()) {
            zip.addLocalFile(sourcePath, zipDirectory);
        }
    }
}

function findSkillDirectory(rootDirectory: string): string | undefined {
    const pending = [rootDirectory];
    let scannedEntries = 0;
    while (pending.length > 0 && scannedEntries < SKILL_SCAN_MAX_ENTRIES) {
        const directory = pending.shift()!;
        if (fs.existsSync(path.join(directory, 'SKILL.md'))) return directory;
        const children = fs
            .readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
            scannedEntries += 1;
            if (scannedEntries >= SKILL_SCAN_MAX_ENTRIES) break;
            if (!child.isDirectory() || child.isSymbolicLink()) continue;
            pending.push(path.join(directory, child.name));
        }
    }
    return undefined;
}

function mimeTypeFor(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();
    const known: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.m4a': 'audio/mp4',
        '.ogg': 'audio/ogg',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.md': 'text/markdown',
        '.json': 'application/json'
    };
    return known[extension] ?? 'application/octet-stream';
}

function mediaTypeFor(mimeType: string): StaffResourceContent['media_type'] {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'file';
}

function normalizeDateBoundary(value: string, end: boolean): number {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const parsed = dateOnly ? new Date(`${value}T00:00:00`) : new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error(t('agentoffice.error.invalidHistoryDate'));
    if (dateOnly && end) parsed.setHours(23, 59, 59, 999);
    return parsed.getTime();
}

interface CursorPayload {
    signature: string;
    offset: number;
    issued_at: number;
    mac: string;
}

function querySignature(staffId: string, query: HistoryQuery): string {
    const value =
        query.mode === 'recent'
            ? { staffId, mode: query.mode, limit: query.limit }
            : {
                  staffId,
                  mode: query.mode,
                  start_time: query.start_time,
                  end_time: query.end_time,
                  limit: query.limit ?? 200
              };
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function cursorMac(secret: Buffer, signature: string, offset: number, issuedAt: number): string {
    return crypto.createHmac('sha256', secret).update(`${signature}:${offset}:${issuedAt}`).digest('base64url');
}

function decodeCursor(cursor: string | undefined, signature: string, secret: Buffer): number {
    if (!cursor) return 0;
    if (typeof cursor !== 'string' || cursor.length > 4096) {
        throw new Error(t('agentoffice.error.invalidHistoryCursor'));
    }
    try {
        const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
        if (payload.signature !== signature || !Number.isInteger(payload.offset) || payload.offset < 0) {
            throw new Error('cursor mismatch');
        }
        if (!Number.isFinite(payload.issued_at) || Date.now() - payload.issued_at > HISTORY_CURSOR_MAX_AGE_MS) {
            throw new Error('cursor expired');
        }
        const expectedMac = cursorMac(secret, payload.signature, payload.offset, payload.issued_at);
        const receivedMac = Buffer.from(payload.mac ?? '', 'base64url');
        const expectedBytes = Buffer.from(expectedMac, 'base64url');
        if (receivedMac.length !== expectedBytes.length || !crypto.timingSafeEqual(receivedMac, expectedBytes)) {
            throw new Error('cursor integrity check failed');
        }
        return payload.offset;
    } catch {
        throw new Error(t('agentoffice.error.invalidHistoryCursor'));
    }
}

function encodeCursor(signature: string, offset: number, secret: Buffer): string {
    const issuedAt = Date.now();
    return Buffer.from(
        JSON.stringify({
            signature,
            offset,
            issued_at: issuedAt,
            mac: cursorMac(secret, signature, offset, issuedAt)
        }),
        'utf8'
    ).toString('base64url');
}

export class AgentOfficeRepository {
    readonly staffsDirectory: string;
    private readonly cursorSecret = crypto.randomBytes(32);

    constructor(readonly appDataDirectory: string) {
        this.staffsDirectory = path.join(appDataDirectory, 'staffs');
        fs.mkdirSync(this.staffsDirectory, { recursive: true });
    }

    staffDirectory(staffId: string): string {
        if (!/^[0-9a-f-]{36}$/i.test(staffId)) throw new Error(t('agentoffice.error.invalidStaffId'));
        const directory = path.join(this.staffsDirectory, staffId);
        if (path.dirname(directory) !== this.staffsDirectory) throw new Error(t('agentoffice.error.invalidStaffId'));
        return directory;
    }

    workspaceDirectory(staffId: string): string {
        return path.join(this.staffDirectory(staffId), 'workspace');
    }

    resourcesDirectory(staffId: string): string {
        return path.join(this.staffDirectory(staffId), 'resources');
    }

    protectedDirectory(staffId: string): string {
        return path.join(this.staffDirectory(staffId), 'protected');
    }

    ensureWorkspace(staffId: string): string {
        const directory = this.workspaceDirectory(staffId);
        fs.mkdirSync(directory, { recursive: true });
        const memoryPath = path.join(directory, 'MEMORY.md');
        if (!fs.existsSync(memoryPath)) {
            fs.writeFileSync(memoryPath, t('agentoffice.memory.initialContent'), 'utf8');
        }
        return directory;
    }

    ensurePresetStaffs(presets: PresetStaffDefinition[]): StaffDetail[] {
        const statePath = path.join(this.appDataDirectory, 'preset-staffs.json');
        const state = readJson<{ version: number; installed: string[] }>(statePath, {
            version: 1,
            installed: []
        });
        const installed = new Set(Array.isArray(state.installed) ? state.installed : []);
        const available = this.listStaffs();
        const result: StaffDetail[] = [];
        for (const preset of presets) {
            if (installed.has(preset.key)) continue;
            const existing = available.find(
                (staff) =>
                    staff.name === preset.definition.name &&
                    staff.vendor_name === preset.definition.vendor_name &&
                    staff.title === preset.definition.title
            );
            const staff = existing
                ? this.getStaffDetail(existing.id)
                : this.createStaff(preset.definition, preset.agents_md);
            result.push(staff);
            installed.add(preset.key);
            atomicWriteJson(statePath, { version: 1, installed: [...installed] });
        }
        if (!fs.existsSync(statePath)) {
            atomicWriteJson(statePath, { version: 1, installed: [...installed] });
        }
        return result;
    }

    createStaff(definitionInput: StaffDefinitionInput, defaultAgentsMd = DEFAULT_AGENTS_MD): StaffDetail {
        const definition = StaffDefinitionSchema.parse(definitionInput);
        const staffId = crypto.randomUUID();
        const now = new Date().toISOString();
        const directory = this.staffDirectory(staffId);
        const protectedDirectory = this.protectedDirectory(staffId);
        fs.mkdirSync(path.join(directory, 'agent', 'skills'), { recursive: true });
        fs.mkdirSync(path.join(directory, 'resources'), { recursive: true });
        fs.mkdirSync(protectedDirectory, { recursive: true });
        atomicWriteJson(path.join(directory, 'staff.json'), definition);
        fs.writeFileSync(path.join(directory, 'agent', 'agents.md'), defaultAgentsMd, 'utf8');
        atomicWriteJson(path.join(directory, 'agent', 'mcp.json'), EMPTY_MCP);
        atomicWriteJson(path.join(protectedDirectory, 'metadata.json'), {
            id: staffId,
            hired_at: now,
            enabled: true,
            last_triggered_at: now
        } satisfies StaffMetadata);
        atomicWriteJson(path.join(protectedDirectory, 'tasks.json'), []);
        atomicWriteJson(path.join(protectedDirectory, 'permission.json'), EMPTY_PERMISSION);
        fs.writeFileSync(path.join(protectedDirectory, 'messages.jsonl'), '', 'utf8');
        return this.getStaffDetail(staffId);
    }

    listStaffs(): StaffListItem[] {
        if (!fs.existsSync(this.staffsDirectory)) return [];
        const result: StaffListItem[] = [];
        for (const entry of fs.readdirSync(this.staffsDirectory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            try {
                const detail = this.getStaffDetail(entry.name);
                result.push({
                    id: detail.id,
                    name: detail.name,
                    vendor_name: detail.vendor_name,
                    title: detail.title,
                    specialties: detail.specialties,
                    trigger_interval: detail.trigger_interval,
                    hired_at: detail.hired_at,
                    enabled: detail.enabled,
                    portrait_url: detail.portrait_url,
                    message_count: detail.message_count,
                    task_count: detail.task_count,
                    usage_summary: detail.usage_summary,
                    active_task_id: detail.active_task_id
                });
            } catch {
                // Ignore malformed staff directories while keeping healthy staff available.
            }
        }
        return result.sort((left, right) => right.hired_at.localeCompare(left.hired_at));
    }

    getStaffDetail(staffId: string): StaffDetail {
        const directory = this.staffDirectory(staffId);
        const definition = StaffDefinitionSchema.parse(readJson(path.join(directory, 'staff.json'), {}));
        const metadata = readJson<StaffMetadata>(path.join(directory, 'protected', 'metadata.json'), {
            id: staffId,
            hired_at: new Date(0).toISOString(),
            enabled: false
        });
        const tasks = this.readTasks(staffId);
        const messages = this.readMessages(staffId);
        const agentsPath = path.join(directory, 'agent', 'agents.md');
        return {
            ...definition,
            id: metadata.id,
            hired_at: metadata.hired_at,
            enabled: metadata.enabled,
            model: metadata.model,
            portrait_url: fs.existsSync(path.join(directory, 'agent', 'portrait.png'))
                ? `agentoffice://resource/${staffId}/portrait`
                : undefined,
            message_count: messages.length,
            task_count: tasks.length,
            usage_summary: metadata.usage_summary ?? sumTaskUsage(tasks),
            active_task_id: tasks.findLast((task) => task.status === 'running')?.task_id,
            agents_md: fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '',
            mcp: readJson(path.join(directory, 'agent', 'mcp.json'), EMPTY_MCP),
            permission: StaffPermissionSchema.parse(
                readJson(path.join(directory, 'protected', 'permission.json'), EMPTY_PERMISSION)
            ),
            tasks
        };
    }

    updateStaff(staffId: string, input: StaffUpdateInput): StaffDetail {
        const directory = this.staffDirectory(staffId);
        if (input.definition) {
            const definitionPath = path.join(directory, 'staff.json');
            const previous = StaffDefinitionSchema.parse(readJson(definitionPath, {}));
            const next = StaffDefinitionSchema.parse({
                ...input.definition,
                trigger_interval: input.definition.trigger_interval ?? previous.trigger_interval
            });
            atomicWriteJson(definitionPath, next);
            if (previous.trigger_interval !== next.trigger_interval) {
                const metadataPath = path.join(directory, 'protected', 'metadata.json');
                const metadata = readJson<StaffMetadata>(metadataPath, {
                    id: staffId,
                    hired_at: new Date().toISOString(),
                    enabled: true
                });
                metadata.last_triggered_at = new Date().toISOString();
                atomicWriteJson(metadataPath, metadata);
            }
        }
        if (input.agents_md !== undefined) {
            fs.writeFileSync(path.join(directory, 'agent', 'agents.md'), input.agents_md, 'utf8');
        }
        if (input.mcp) atomicWriteJson(path.join(directory, 'agent', 'mcp.json'), input.mcp);
        if (input.permission) {
            atomicWriteJson(
                path.join(directory, 'protected', 'permission.json'),
                StaffPermissionSchema.parse(input.permission)
            );
        }
        if (input.enabled !== undefined || input.model !== undefined) {
            const metadataPath = path.join(directory, 'protected', 'metadata.json');
            const metadata = readJson<StaffMetadata>(metadataPath, {
                id: staffId,
                hired_at: new Date().toISOString(),
                enabled: true
            });
            if (input.enabled !== undefined) {
                if (!metadata.enabled && input.enabled) metadata.last_triggered_at = new Date().toISOString();
                metadata.enabled = input.enabled;
            }
            if (input.model !== undefined) {
                const model = input.model?.trim();
                if (model) metadata.model = model;
                else delete metadata.model;
            }
            atomicWriteJson(metadataPath, metadata);
        }
        if (input.portrait_path !== undefined) {
            const portraitPath = path.join(directory, 'agent', 'portrait.png');
            if (input.portrait_path === null) {
                if (fs.existsSync(portraitPath)) fs.rmSync(portraitPath);
            } else {
                fs.copyFileSync(input.portrait_path, portraitPath);
            }
        }
        if (input.portrait_data_uri !== undefined) {
            const portraitPath = path.join(directory, 'agent', 'portrait.png');
            if (input.portrait_data_uri === null) {
                if (fs.existsSync(portraitPath)) fs.rmSync(portraitPath);
            } else {
                if (input.portrait_data_uri.length > PORTRAIT_DATA_URI_MAX_LENGTH) {
                    throw new Error(t('agentoffice.portraitFileTooLarge'));
                }
                const match = /^data:image\/png;base64,([a-z0-9+/]+={0,2})$/i.exec(input.portrait_data_uri);
                if (!match) throw new Error(t('agentoffice.error.portraitPngOnly'));
                const portrait = Buffer.from(match[1], 'base64');
                if (!portrait.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
                    throw new Error(t('agentoffice.error.portraitPngOnly'));
                }
                fs.writeFileSync(portraitPath, portrait);
            }
        }
        return this.getStaffDetail(staffId);
    }

    prepareUserMessage(
        staffId: string,
        taskId: string,
        text: string | undefined,
        attachments: MessageAttachmentInput[] = [],
        imageDataUris: string[] = []
    ): PreparedMessage {
        const content: StaffMessage['content'] = [];
        if (text?.trim()) content.push({ type: 'text', text: text.trim() });
        const nativeImages: string[] = [];
        for (const attachment of attachments) {
            const resource = this.copyResource(staffId, attachment.path, attachment.name);
            content.push(resource);
            if (resource.media_type === 'image') {
                const data = fs.readFileSync(path.join(this.staffDirectory(staffId), resource.path)).toString('base64');
                nativeImages.push(`data:${resource.mime_type};base64,${data}`);
            }
        }
        for (const dataUri of imageDataUris) {
            const resource = this.copyDataUri(staffId, dataUri);
            content.push(resource);
            nativeImages.push(dataUri);
        }
        if (content.length === 0) throw new Error(t('agentoffice.error.messageRequired'));
        return {
            message: StaffMessageSchema.parse({
                id: crypto.randomUUID(),
                role: 'user',
                task_id: taskId,
                created_at: new Date().toISOString(),
                status: 'sent',
                kind: 'message',
                content
            }),
            image_data_uris: nativeImages
        };
    }

    appendAssistantMessage(
        staffId: string,
        taskId: string,
        text?: string,
        files: string[] = [],
        kind: 'message' | 'error' = 'message'
    ): StaffMessage {
        const content: StaffMessage['content'] = [];
        if (text?.trim()) content.push({ type: 'text', text: text.trim() });
        for (const filePath of files) content.push(this.copyResource(staffId, filePath));
        if (content.length === 0) throw new Error(t('agentoffice.error.replyRequired'));
        const message = StaffMessageSchema.parse({
            id: crypto.randomUUID(),
            role: 'assistant',
            task_id: taskId,
            created_at: new Date().toISOString(),
            status: kind === 'error' ? 'failed' : 'sent',
            kind,
            content
        });
        this.appendMessage(staffId, message);
        return message;
    }

    appendMessage(staffId: string, message: StaffMessage): void {
        const parsed = StaffMessageSchema.parse(message);
        fs.appendFileSync(
            path.join(this.protectedDirectory(staffId), 'messages.jsonl'),
            `${JSON.stringify(parsed)}\n`,
            'utf8'
        );
    }

    readMessages(staffId: string): StaffMessage[] {
        const filePath = path.join(this.protectedDirectory(staffId), 'messages.jsonl');
        if (!fs.existsSync(filePath)) return [];
        const result: StaffMessage[] = [];
        for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                result.push(StaffMessageSchema.parse(JSON.parse(line)));
            } catch {
                // A partial trailing line must not make the whole conversation unreadable.
            }
        }
        return result;
    }

    getHistory(staffId: string, query: HistoryQuery): HistoryResult {
        if (!query || (query.mode !== 'recent' && query.mode !== 'time_range')) {
            throw new Error(t('agentoffice.error.invalidHistoryQuery'));
        }
        const limit = query.mode === 'recent' ? query.limit : (query.limit ?? 200);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
            throw new Error(t('agentoffice.error.invalidHistoryLimit'));
        }
        const signature = querySignature(staffId, { ...query, limit } as HistoryQuery);
        const offset = decodeCursor(query.cursor, signature, this.cursorSecret);
        let matches = this.readMessages(staffId);
        if (query.mode === 'time_range') {
            const start = normalizeDateBoundary(query.start_time, false);
            const end = normalizeDateBoundary(query.end_time, true);
            if (start > end) throw new Error(t('agentoffice.error.invalidHistoryRange'));
            matches = matches.filter((message) => {
                const timestamp = new Date(message.created_at).getTime();
                return timestamp >= start && timestamp <= end;
            });
        }
        const descending = [...matches].reverse();
        const pageDescending = descending.slice(offset, offset + limit);
        const nextOffset = offset + pageDescending.length;
        const hasMore = nextOffset < descending.length;
        return {
            messages: pageDescending.reverse(),
            has_more: hasMore,
            next_cursor: hasMore ? encodeCursor(signature, nextOffset, this.cursorSecret) : undefined
        };
    }

    readTasks(staffId: string): StaffTaskRecord[] {
        const tasks = readJson<StaffTaskRecord[]>(path.join(this.protectedDirectory(staffId), 'tasks.json'), []);
        return Array.isArray(tasks)
            ? tasks.map((task) => ({
                  ...task,
                  source: task.source ?? 'user'
              }))
            : [];
    }

    claimDueTriggers(nowIso: string): DueStaffTrigger[] {
        const now = new Date(nowIso);
        if (Number.isNaN(now.getTime())) return [];
        const due: DueStaffTrigger[] = [];
        for (const entry of fs.readdirSync(this.staffsDirectory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            try {
                const directory = this.staffDirectory(entry.name);
                const definition = StaffDefinitionSchema.parse(readJson(path.join(directory, 'staff.json'), {}));
                const metadataPath = path.join(directory, 'protected', 'metadata.json');
                const metadata = readJson<StaffMetadata>(metadataPath, {
                    id: entry.name,
                    hired_at: new Date(0).toISOString(),
                    enabled: false
                });
                if (!metadata.enabled) continue;
                const intervalMs = staffTriggerIntervalMs(definition.trigger_interval);
                if (intervalMs === undefined) continue;
                const baseline = new Date(metadata.last_triggered_at ?? metadata.hired_at).getTime();
                if (Number.isFinite(baseline) && now.getTime() - baseline < intervalMs) continue;
                const previousTriggeredAt = metadata.last_triggered_at;
                metadata.last_triggered_at = nowIso;
                atomicWriteJson(metadataPath, metadata);
                due.push({
                    staff_id: entry.name,
                    triggered_at: nowIso,
                    previous_triggered_at: previousTriggeredAt
                });
            } catch {
                // Ignore malformed staff directories while keeping healthy schedules active.
            }
        }
        return due;
    }

    releaseTriggerClaim(trigger: DueStaffTrigger): void {
        const metadataPath = path.join(this.protectedDirectory(trigger.staff_id), 'metadata.json');
        const metadata = readJson<StaffMetadata>(metadataPath, {
            id: trigger.staff_id,
            hired_at: new Date().toISOString(),
            enabled: false
        });
        if (metadata.last_triggered_at !== trigger.triggered_at) return;
        if (trigger.previous_triggered_at) metadata.last_triggered_at = trigger.previous_triggered_at;
        else delete metadata.last_triggered_at;
        atomicWriteJson(metadataPath, metadata);
    }

    upsertTask(staffId: string, taskRecord: StaffTaskRecord): void {
        const tasks = this.readTasks(staffId);
        const index = tasks.findIndex((task) => task.task_id === taskRecord.task_id);
        if (index >= 0) tasks[index] = taskRecord;
        else tasks.push(taskRecord);
        atomicWriteJson(path.join(this.protectedDirectory(staffId), 'tasks.json'), tasks);
        const metadataPath = path.join(this.protectedDirectory(staffId), 'metadata.json');
        const metadata = readJson<StaffMetadata>(metadataPath, {
            id: staffId,
            hired_at: new Date().toISOString(),
            enabled: true
        });
        metadata.usage_summary = sumTaskUsage(tasks);
        atomicWriteJson(metadataPath, metadata);
    }

    importStaff(zipPath: string): StaffDetail {
        let zip: AdmZip;
        try {
            zip = new AdmZip(zipPath);
        } catch {
            throw new Error(t('agentoffice.error.invalidStaffZip'));
        }
        let total = 0;
        const entries = zip.getEntries();
        for (const entry of entries) {
            const normalized = entry.entryName.replace(/\\/g, '/');
            if (
                path.posix.isAbsolute(normalized) ||
                path.win32.isAbsolute(normalized) ||
                normalized.split('/').includes('..')
            ) {
                throw new Error(t('agentoffice.error.invalidStaffPackage'));
            }
            if (!entry.isDirectory) {
                total += entry.header.size;
                if (total > ZIP_MAX_UNCOMPRESSED_BYTES) throw new Error(t('agentoffice.error.staffPackageTooLarge'));
            }
        }
        const staffEntry = zip.getEntry('staff.json');
        const agentsEntry = zip.getEntry('agent/agents.md');
        if (!staffEntry || !agentsEntry) throw new Error(t('agentoffice.error.staffPackageRequiredFiles'));
        let definition: StaffDefinition;
        try {
            definition = StaffDefinitionSchema.parse(JSON.parse(staffEntry.getData().toString('utf8')));
        } catch {
            throw new Error(t('agentoffice.error.invalidStaffDefinition'));
        }
        const created = this.createStaff(definition);
        const targetDirectory = this.staffDirectory(created.id);
        try {
            for (const entry of entries) {
                const normalized = entry.entryName.replace(/\\/g, '/');
                if (entry.isDirectory || !normalized.startsWith('agent/')) continue;
                const target = path.join(targetDirectory, ...normalized.split('/'));
                const agentRoot = path.join(targetDirectory, 'agent');
                if (target !== agentRoot && !target.startsWith(`${agentRoot}${path.sep}`)) {
                    throw new Error(t('agentoffice.error.invalidStaffPackage'));
                }
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, entry.getData());
            }
            return this.getStaffDetail(created.id);
        } catch (error) {
            fs.rmSync(targetDirectory, { recursive: true, force: true });
            throw error;
        }
    }

    exportStaff(staffId: string, zipPath: string): string {
        const directory = this.staffDirectory(staffId);
        const zip = new AdmZip();
        const definition = StaffDefinitionSchema.parse(readJson(path.join(directory, 'staff.json'), {}));
        zip.addFile('staff.json', Buffer.from(`${JSON.stringify(definition, null, 4)}\n`, 'utf8'));
        addDirectoryToZip(zip, path.join(directory, 'agent'), 'agent');
        zip.writeZip(zipPath);
        return zipPath;
    }

    listSkills(staffId: string): StaffSkillSummary[] {
        const skillsDirectory = path.join(this.staffDirectory(staffId), 'agent', 'skills');
        if (!fs.existsSync(skillsDirectory)) return [];
        return fs
            .readdirSync(skillsDirectory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .filter((entry) => fs.existsSync(path.join(skillsDirectory, entry.name, 'SKILL.md')))
            .map((entry) => {
                const manifest = fs.readFileSync(path.join(skillsDirectory, entry.name, 'SKILL.md'), 'utf8');
                const parsed = parseAndValidateSkillMd(manifest, entry.name);
                return {
                    name: parsed.valid ? parsed.name : entry.name,
                    directory_name: entry.name,
                    path: `agent/skills/${entry.name}`,
                    description: parsed.valid ? parsed.description : '',
                    body: parsed.valid ? parsed.body : manifest,
                    license: parsed.valid ? parsed.frontmatter.license : undefined,
                    compatibility: parsed.valid ? parsed.frontmatter.compatibility : undefined,
                    allowed_tools: parsed.valid ? parsed.frontmatter['allowed-tools'] : undefined
                };
            });
    }

    scanSkillSources(rootDirectory: string): StaffSkillImportCandidate[] {
        const root = path.resolve(rootDirectory);
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
            throw new Error(t('agentoffice.error.skillScanDirectoryInvalid'));
        }
        const candidates: StaffSkillImportCandidate[] = [];
        let scannedEntries = 0;
        const visit = (directory: string): void => {
            if (candidates.length >= SKILL_SCAN_MAX_RESULTS || scannedEntries >= SKILL_SCAN_MAX_ENTRIES) return;
            const entries = fs.readdirSync(directory, { withFileTypes: true });
            for (const entry of entries) {
                if (candidates.length >= SKILL_SCAN_MAX_RESULTS || scannedEntries >= SKILL_SCAN_MAX_ENTRIES) break;
                scannedEntries += 1;
                const sourcePath = path.join(directory, entry.name);
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    if (fs.existsSync(path.join(sourcePath, 'SKILL.md'))) {
                        candidates.push({ path: sourcePath, name: entry.name, type: 'directory' });
                    } else {
                        visit(sourcePath);
                    }
                    continue;
                }
                if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.zip') continue;
                try {
                    const zip = new AdmZip(sourcePath);
                    if (
                        zip
                            .getEntries()
                            .some(
                                (zipEntry) =>
                                    !zipEntry.isDirectory && path.posix.basename(zipEntry.entryName) === 'SKILL.md'
                            )
                    ) {
                        candidates.push({ path: sourcePath, name: entry.name, type: 'zip' });
                    }
                } catch {
                    // Invalid zip files are ignored during discovery and remain untouched.
                }
            }
        };
        if (fs.existsSync(path.join(root, 'SKILL.md'))) {
            candidates.push({ path: root, name: path.basename(root), type: 'directory' });
        } else {
            visit(root);
        }
        return candidates;
    }

    addSkill(staffId: string, sourcePath: string): { name: string; path: string } {
        const skillsDirectory = path.join(this.staffDirectory(staffId), 'agent', 'skills');
        fs.mkdirSync(skillsDirectory, { recursive: true });
        let sourceDirectory = sourcePath;
        let temporaryDirectory: string | undefined;
        try {
            if (path.extname(sourcePath).toLowerCase() === '.zip') {
                temporaryDirectory = fs.mkdtempSync(path.join(getTempDir(), 'agentoffice-skill-'));
                let zip: AdmZip;
                try {
                    zip = new AdmZip(sourcePath);
                } catch {
                    throw new Error(t('agentoffice.error.invalidSkillPackage'));
                }
                let total = 0;
                for (const entry of zip.getEntries()) {
                    const normalized = entry.entryName.replace(/\\/g, '/');
                    if (
                        path.posix.isAbsolute(normalized) ||
                        path.win32.isAbsolute(normalized) ||
                        normalized.split('/').includes('..')
                    ) {
                        throw new Error(t('agentoffice.error.invalidSkillPackage'));
                    }
                    if (!entry.isDirectory) {
                        total += entry.header.size;
                        if (total > ZIP_MAX_UNCOMPRESSED_BYTES)
                            throw new Error(t('agentoffice.error.skillPackageTooLarge'));
                    }
                }
                zip.extractAllTo(temporaryDirectory, true);
                const directSkill = findSkillDirectory(temporaryDirectory);
                if (!directSkill) {
                    throw new Error(t('agentoffice.error.skillMissingManifest'));
                }
                sourceDirectory = directSkill;
            }
            if (
                !fs.existsSync(sourceDirectory) ||
                !fs.statSync(sourceDirectory).isDirectory() ||
                !fs.existsSync(path.join(sourceDirectory, 'SKILL.md'))
            ) {
                throw new Error(t('agentoffice.error.skillMissingManifest'));
            }
            const name = path.basename(sourceDirectory);
            if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error(t('agentoffice.error.invalidSkillName'));
            const target = path.join(skillsDirectory, name);
            if (fs.existsSync(target)) throw new Error(t('agentoffice.error.skillExists', { name }));
            fs.cpSync(sourceDirectory, target, { recursive: true, dereference: false });
            return { name, path: `agent/skills/${name}` };
        } finally {
            if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
        }
    }

    deleteSkill(staffId: string, name: string): void {
        if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error(t('agentoffice.error.invalidSkillName'));
        const target = path.join(this.staffDirectory(staffId), 'agent', 'skills', name);
        fs.rmSync(target, { recursive: true, force: true });
    }

    deleteStaff(staffId: string): string {
        const directory = this.staffDirectory(staffId);
        fs.rmSync(directory, { recursive: true, force: true });
        return directory;
    }

    private copyResource(staffId: string, sourcePath: string, preferredName?: string): StaffResourceContent {
        const stat = fs.statSync(sourcePath);
        if (!stat.isFile()) throw new Error(t('agentoffice.error.attachmentMustBeFile'));
        const originalName = preferredName || path.basename(sourcePath);
        const extension = path.extname(originalName) || path.extname(sourcePath);
        const resourceId = crypto.randomUUID();
        const fileName = `${resourceId}${extension.toLowerCase()}`;
        const targetPath = path.join(this.resourcesDirectory(staffId), fileName);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
        const mimeType = mimeTypeFor(sourcePath);
        return {
            type: 'resource',
            resource_id: resourceId,
            media_type: mediaTypeFor(mimeType),
            mime_type: mimeType,
            name: originalName,
            path: `resources/${fileName}`
        };
    }

    private copyDataUri(staffId: string, dataUri: string): StaffResourceContent {
        const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUri);
        if (!match || !match[1].startsWith('image/')) throw new Error(t('agentoffice.error.imageDataUriOnly'));
        const mimeType = match[1];
        const extension = mimeType === 'image/jpeg' ? '.jpg' : `.${mimeType.slice('image/'.length)}`;
        const resourceId = crypto.randomUUID();
        const fileName = `${resourceId}${extension}`;
        fs.mkdirSync(this.resourcesDirectory(staffId), { recursive: true });
        fs.writeFileSync(path.join(this.resourcesDirectory(staffId), fileName), Buffer.from(match[2], 'base64'));
        return {
            type: 'resource',
            resource_id: resourceId,
            media_type: 'image',
            mime_type: mimeType,
            name: `image${extension}`,
            path: `resources/${fileName}`
        };
    }
}
