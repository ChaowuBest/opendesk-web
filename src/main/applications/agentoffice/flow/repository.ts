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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { FlowHistorySnapshot } from './context.js';
import { FlowReadingRepository } from './reading.js';
import { parseFlowMentions } from './routing/mentions.js';
import { t } from '../locale/index.js';
import type { AgentOfficeRepository } from '../repository.js';
import {
    AgentFlowIdSchema,
    AgentFlowListFilterSchema,
    AgentFlowMemberIdsSchema,
    AgentFlowMessageHistoryQuerySchema,
    AgentFlowMessageSchema,
    AgentFlowRevisionSchema,
    AgentFlowSchema,
    AgentFlowTaskIdSchema,
    CreateAgentFlowInputSchema,
    PrepareAgentFlowUserMessageInputSchema,
    UpdateAgentFlowPatchSchema,
    type AgentFlow,
    type AgentFlowDetail,
    type AgentFlowListFilter,
    type AgentFlowMember,
    type AgentFlowMessage,
    type AgentFlowMessageHistoryQuery,
    type AgentFlowMessageHistoryResult,
    type AgentFlowResourceContent,
    type AgentFlowSummary,
    type CreateAgentFlowInput,
    type PreparedAgentFlowUserMessage,
    type PrepareAgentFlowUserMessageInput,
    type UpdateAgentFlowPatch,
    parseAgentFlowInput
} from './common.js';

interface FlowCursorPayload {
    flowId: string;
    offset: number;
    issuedAt: number;
    mac: string;
}

const FLOW_CURSOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const MessageSequenceIndexSchema = z
    .object({
        schemaVersion: z.literal(1),
        highWater: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        sequences: z.record(AgentFlowIdSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
    })
    .strict();

function mimeTypeFor(filePath: string): string {
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
        '.txt': 'text/plain; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8'
    };
    return known[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function mediaTypeFor(mimeType: string): AgentFlowResourceContent['mediaType'] {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'file';
}

function atomicWriteJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
}

function atomicWriteText(filePath: string, value: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, value, 'utf8');
    fs.renameSync(temporaryPath, filePath);
}

export class AgentFlowRepository {
    readonly flowsDirectory: string;
    readonly reading: FlowReadingRepository;
    private readonly cursorSecret = crypto.randomBytes(32);

    constructor(
        readonly appDataDirectory: string,
        private readonly staffRepository: Pick<AgentOfficeRepository, 'listStaffs'>
    ) {
        this.flowsDirectory = path.join(appDataDirectory, 'flows');
        this.reading = new FlowReadingRepository(this);
    }

    flowDirectory(flowId: string): string {
        const parsedFlowId = AgentFlowIdSchema.safeParse(flowId);
        if (!parsedFlowId.success) throw new Error(t('agentoffice.flow.error.invalidFlowId'));
        const directory = path.join(this.flowsDirectory, parsedFlowId.data);
        if (path.dirname(directory) !== this.flowsDirectory) {
            throw new Error(t('agentoffice.flow.error.invalidFlowId'));
        }
        return directory;
    }

    createFlow(input: CreateAgentFlowInput): AgentFlow {
        const parsed = parseAgentFlowInput(CreateAgentFlowInputSchema, input);
        this.assertExistingStaff(parsed.memberIds);
        const now = new Date().toISOString();
        const flow = parseAgentFlowInput(AgentFlowSchema, {
            schemaVersion: 1,
            id: crypto.randomUUID(),
            revision: 1,
            name: parsed.name,
            goal: parsed.goal,
            status: 'active',
            memberIds: parsed.memberIds,
            createdAt: now,
            updatedAt: now
        });
        atomicWriteJson(this.flowPath(flow.id), flow);
        this.reading.getState(flow.id);
        return flow;
    }

    updateFlow(flowId: string, expectedRevision: number, patch: UpdateAgentFlowPatch): AgentFlow {
        const current = this.readFlow(flowId);
        this.assertMutable(current, expectedRevision);
        const parsedPatch = parseAgentFlowInput(UpdateAgentFlowPatchSchema, patch);
        return this.writeRevision(current, parsedPatch);
    }

    setFlowMembers(flowId: string, expectedRevision: number, memberIds: string[]): AgentFlow {
        const current = this.readFlow(flowId);
        this.assertMutable(current, expectedRevision);
        const parsedMemberIds = parseAgentFlowInput(AgentFlowMemberIdsSchema, memberIds);
        this.assertExistingStaff(parsedMemberIds);
        const updated = this.writeRevision(current, { memberIds: parsedMemberIds });
        this.reading.getState(flowId);
        return updated;
    }

    archiveFlow(flowId: string, expectedRevision: number): AgentFlow {
        const current = this.readFlow(flowId);
        this.assertMutable(current, expectedRevision);
        const now = new Date().toISOString();
        return this.writeRevision(current, { status: 'archived', archivedAt: now });
    }

    assertDeletable(flowId: string, expectedRevision: number): void {
        const flow = this.readFlow(flowId);
        if (flow.revision !== expectedRevision) throw new Error(t('agentoffice.flow.error.revisionConflict'));
        if (flow.status !== 'archived') throw new Error(t('agentoffice.flow.error.deleteActive'));
    }

    rememberTasks(flowId: string, taskIds: string[]): string[] {
        this.readFlow(flowId);
        const filePath = path.join(this.flowDirectory(flowId), 'tasks.json');
        const existing = fs.existsSync(filePath)
            ? parseAgentFlowInput(AgentFlowTaskIdSchema.array(), JSON.parse(fs.readFileSync(filePath, 'utf8')))
            : [];
        const ids = [...new Set([...existing, ...parseAgentFlowInput(AgentFlowTaskIdSchema.array(), taskIds)])];
        // Keep ownership even after a message or a staff member has been deleted.
        atomicWriteJson(filePath, ids);
        return ids;
    }

    deleteFlow(flowId: string, expectedRevision: number): void {
        this.assertDeletable(flowId, expectedRevision);
        const directory = path.resolve(this.flowDirectory(flowId));
        if (path.dirname(directory) !== path.resolve(this.flowsDirectory)) {
            throw new Error(t('agentoffice.flow.error.invalidFlowId'));
        }
        fs.rmSync(directory, { recursive: true, force: true });
    }

    listFlows(filter: AgentFlowListFilter = {}): AgentFlowSummary[] {
        const parsedFilter = parseAgentFlowInput(AgentFlowListFilterSchema, filter);
        const staffIds = new Set(this.staffRepository.listStaffs().map((staff) => staff.id));
        const result: AgentFlowSummary[] = [];
        if (!fs.existsSync(this.flowsDirectory)) return result;
        for (const entry of fs.readdirSync(this.flowsDirectory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            try {
                const flow = this.readFlow(entry.name);
                if (parsedFilter.status !== 'all' && flow.status !== parsedFilter.status) continue;
                const query = parsedFilter.query?.toLocaleLowerCase();
                if (query && !`${flow.name}\n${flow.goal}`.toLocaleLowerCase().includes(query)) continue;
                result.push({
                    ...flow,
                    memberCount: flow.memberIds.length,
                    missingMemberCount: flow.memberIds.filter((staffId) => !staffIds.has(staffId)).length
                });
            } catch {
                // Ignore malformed Flow directories while keeping healthy Flows available.
            }
        }
        return result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    getFlow(flowId: string): AgentFlowDetail {
        const flow = this.readFlow(flowId);
        const staffs = new Map(this.staffRepository.listStaffs().map((staff) => [staff.id, staff]));
        const members: AgentFlowMember[] = flow.memberIds.map((staffId) => {
            const staff = staffs.get(staffId);
            return staff
                ? {
                      staffId,
                      missing: false,
                      name: staff.name,
                      title: staff.title,
                      enabled: staff.enabled
                  }
                : { staffId, missing: true };
        });
        return { ...flow, members };
    }

    prepareUserMessage(flowId: string, input: PrepareAgentFlowUserMessageInput): PreparedAgentFlowUserMessage {
        const flow = this.readFlow(flowId);
        if (flow.status === 'archived') throw new Error(t('agentoffice.flow.error.archived'));
        this.reading.getState(flowId);
        const parsed = parseAgentFlowInput(PrepareAgentFlowUserMessageInputSchema, input);
        const requestHash = this.userMessageRequestHash(parsed);
        const existingMessages = this.readMessages(flow.id);
        const existing = existingMessages.find(
            (message) => message.sender.type === 'user' && message.clientRequestId === parsed.clientRequestId
        );
        if (existing) {
            if (existing.requestHash !== requestHash) throw new Error(t('agentoffice.flow.error.requestIdConflict'));
            const referencedMessage = existing.replyToMessageId
                ? existingMessages.find((message) => message.id === existing.replyToMessageId)
                : undefined;
            return {
                message: existing,
                ...(referencedMessage ? { referencedMessage } : {}),
                imageDataUris: this.messageImageDataUris(flow.id, existing),
                created: false
            };
        }
        const referencedMessage = parsed.replyToMessageId
            ? existingMessages.find((message) => message.id === parsed.replyToMessageId)
            : undefined;
        if (parsed.replyToMessageId && !referencedMessage) {
            throw new Error(t('agentoffice.flow.error.referencedMessageNotFound'));
        }

        const content: AgentFlowMessage['content'] = [];
        if (parsed.text) content.push({ type: 'text', text: parsed.text });
        const imageDataUris: string[] = [];
        for (const attachment of parsed.attachments ?? []) {
            const resource = this.copyResource(flow.id, attachment.path, attachment.name);
            content.push(resource);
            if (resource.mediaType === 'image') imageDataUris.push(this.resourceDataUri(flow.id, resource));
        }
        for (const dataUri of parsed.imageDataUris ?? []) {
            const resource = this.copyDataUri(flow.id, dataUri);
            content.push(resource);
            imageDataUris.push(dataUri);
        }
        const message = parseAgentFlowInput(AgentFlowMessageSchema, {
            schemaVersion: 1,
            id: crypto.randomUUID(),
            flowId: flow.id,
            clientRequestId: parsed.clientRequestId,
            requestHash,
            taskId: parsed.taskId,
            replyToMessageId: parsed.replyToMessageId,
            sender: { type: 'user' },
            mentions: parsed.mentions,
            kind: 'message',
            content,
            createdAt: new Date().toISOString()
        });
        this.appendMessage(flow.id, message);
        return { message, ...(referencedMessage ? { referencedMessage } : {}), imageDataUris, created: true };
    }

    appendSystemMessage(
        flowId: string,
        text: string,
        taskId?: string,
        kind: 'message' | 'error' = 'message',
        retryable = false
    ): AgentFlowMessage {
        return this.appendAuthoredMessage(flowId, { type: 'system' }, taskId, text, [], kind, retryable);
    }

    appendStaffMessage(
        flowId: string,
        staffId: string,
        taskId: string,
        text?: string,
        files: string[] = [],
        kind: 'message' | 'error' = 'message',
        replyToMessageId?: string,
        readingReply?: { readingBatchId: string; replyKey: string }
    ): AgentFlowMessage {
        if (replyToMessageId && !this.getMessage(flowId, replyToMessageId)) {
            throw new Error(t('agentoffice.flow.error.referencedMessageNotFound'));
        }
        return this.appendAuthoredMessage(
            flowId,
            { type: 'staff', id: staffId },
            taskId,
            text,
            files,
            kind,
            false,
            replyToMessageId,
            readingReply
        );
    }

    getMessageHistory(flowId: string, query: AgentFlowMessageHistoryQuery): AgentFlowMessageHistoryResult {
        this.readFlow(flowId);
        const parsed = parseAgentFlowInput(AgentFlowMessageHistoryQuerySchema, query);
        const offset = this.decodeCursor(flowId, parsed.cursor);
        const allMessages = this.readMessages(flowId);
        const descending = [...allMessages].reverse();
        const page = descending.slice(offset, offset + parsed.limit).reverse();
        const referencedIds = new Set(page.flatMap((message) => message.replyToMessageId ?? []));
        const referencedMessages = allMessages.filter((message) => referencedIds.has(message.id));
        const nextOffset = offset + page.length;
        const hasMore = nextOffset < descending.length;
        return {
            messages: page,
            ...(referencedMessages.length > 0 ? { referencedMessages } : {}),
            hasMore,
            nextCursor: hasMore ? this.encodeCursor(flowId, nextOffset) : undefined
        };
    }

    getHistorySnapshot(flowId: string): FlowHistorySnapshot {
        const flow = this.getFlow(flowId);
        const messages = this.readMessages(flowId);
        const filePath = path.join(this.flowDirectory(flowId), 'message-sequences.json');
        const index = fs.existsSync(filePath)
            ? parseAgentFlowInput(MessageSequenceIndexSchema, JSON.parse(fs.readFileSync(filePath, 'utf8')))
            : { sequences: {} };
        return {
            flow,
            messages,
            messageRefs: Object.fromEntries(
                Object.entries(index.sequences).map(([id, sequence]) => [id, `m${sequence}`])
            )
        };
    }

    getMessage(flowId: string, messageId: string): AgentFlowMessage | undefined {
        this.readFlow(flowId);
        const parsedMessageId = parseAgentFlowInput(AgentFlowIdSchema, messageId);
        return this.readMessages(flowId).find((message) => message.id === parsedMessageId);
    }

    deleteMessage(flowId: string, messageId: string): AgentFlowMessage {
        this.readFlow(flowId);
        const parsedMessageId = parseAgentFlowInput(AgentFlowIdSchema, messageId);
        const messages = this.readMessages(flowId);
        const deleted = messages.find((message) => message.id === parsedMessageId);
        if (!deleted) throw new Error(t('agentoffice.flow.error.messageNotFound'));
        const retained = messages.filter((message) => message.id !== parsedMessageId);
        const filePath = path.join(this.flowDirectory(flowId), 'messages.jsonl');
        atomicWriteText(
            filePath,
            retained.map((message) => JSON.stringify(message)).join('\n') + (retained.length ? '\n' : '')
        );
        for (const content of deleted.content) {
            if (content.type !== 'resource') continue;
            const resourcePath = path.join(this.flowDirectory(flowId), content.path);
            if (fs.existsSync(resourcePath)) fs.unlinkSync(resourcePath);
        }
        return deleted;
    }

    readMessages(flowId: string): AgentFlowMessage[] {
        const filePath = path.join(this.flowDirectory(flowId), 'messages.jsonl');
        if (!fs.existsSync(filePath)) return [];
        const result: AgentFlowMessage[] = [];
        for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const parsed = AgentFlowMessageSchema.parse(JSON.parse(line));
                if (parsed.flowId === flowId) result.push(parsed);
            } catch {
                // A partial trailing line must not make the Flow conversation unreadable.
            }
        }
        this.assignMessageSequences(flowId, result);
        return result.sort((left, right) => left.sequence! - right.sequence!);
    }

    private assignMessageSequences(flowId: string, messages: AgentFlowMessage[]): void {
        const filePath = path.join(this.flowDirectory(flowId), 'message-sequences.json');
        const exists = fs.existsSync(filePath);
        let index: z.output<typeof MessageSequenceIndexSchema>;
        try {
            index = exists
                ? MessageSequenceIndexSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')))
                : { schemaVersion: 1, highWater: 0, sequences: {} };
        } catch {
            throw new Error(t('agentoffice.flow.error.invalidSequenceIndex'));
        }
        const used = new Set(Object.values(index.sequences));
        if (used.size !== Object.keys(index.sequences).length || [...used].some((value) => value > index.highWater)) {
            throw new Error(t('agentoffice.flow.error.invalidSequenceIndex'));
        }
        let changed = !exists;
        const ids = new Set<string>();
        for (const message of messages) {
            if (ids.has(message.id)) throw new Error(t('agentoffice.flow.error.invalidSequenceIndex'));
            ids.add(message.id);
            const stored = index.sequences[message.id];
            if (message.sequence !== undefined && message.sequence !== stored) {
                // Never reconstruct a missing ledger from remaining messages: deleted high numbers may be lost.
                throw new Error(t('agentoffice.flow.error.invalidSequenceIndex'));
            }
            if (stored === undefined) {
                if (index.highWater >= Number.MAX_SAFE_INTEGER) {
                    throw new Error(t('agentoffice.flow.error.invalidSequenceIndex'));
                }
                index.sequences[message.id] = ++index.highWater;
                changed = true;
            }
            message.sequence = index.sequences[message.id];
        }
        // Reserve IDs before writing messages; a crash may leave gaps, but never reuse a number.
        if (changed) atomicWriteJson(filePath, index);
    }

    private flowPath(flowId: string): string {
        return path.join(this.flowDirectory(flowId), 'flow.json');
    }

    private appendAuthoredMessage(
        flowId: string,
        sender: AgentFlowMessage['sender'],
        taskId: string | undefined,
        text: string | undefined,
        files: string[],
        kind: 'message' | 'error',
        retryable: boolean,
        replyToMessageId?: string,
        readingReply?: { readingBatchId: string; replyKey: string }
    ): AgentFlowMessage {
        this.readFlow(flowId);
        if (sender.type === 'staff') {
            const staff = this.staffRepository.listStaffs().find((entry) => entry.id === sender.id);
            sender = { ...sender, ...(staff ? { name: staff.name, title: staff.title } : {}) };
        }
        const content: AgentFlowMessage['content'] = [];
        if (text?.trim()) content.push({ type: 'text', text: text.trim() });
        for (const filePath of files) content.push(this.copyResource(flowId, filePath));
        const message = parseAgentFlowInput(AgentFlowMessageSchema, {
            schemaVersion: 1,
            id: crypto.randomUUID(),
            flowId,
            taskId,
            replyToMessageId,
            ...readingReply,
            sender,
            mentions: parseFlowMentions(text, this.getFlow(flowId)),
            kind,
            content,
            retryable: retryable || undefined,
            createdAt: new Date().toISOString()
        });
        this.appendMessage(flowId, message);
        return message;
    }

    private appendMessage(flowId: string, message: AgentFlowMessage): void {
        this.reading.assertWritable(flowId);
        const parsed = parseAgentFlowInput(AgentFlowMessageSchema, message);
        if (parsed.flowId !== flowId) throw new Error(t('agentoffice.flow.error.invalidInput'));
        const messages = this.readMessages(flowId);
        this.assignMessageSequences(flowId, [...messages, parsed]);
        atomicWriteText(
            path.join(this.flowDirectory(flowId), 'messages.jsonl'),
            [...messages, parsed].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
        );
        message.sequence = parsed.sequence;
        this.reading.getState(flowId);
    }

    private userMessageRequestHash(input: PrepareAgentFlowUserMessageInput): string {
        const attachmentHashes = (input.attachments ?? []).map((attachment) => {
            if (!fs.existsSync(attachment.path) || !fs.statSync(attachment.path).isFile()) {
                throw new Error(t('agentoffice.error.attachmentMustBeFile'));
            }
            return crypto.createHash('sha256').update(fs.readFileSync(attachment.path)).digest('hex');
        });
        const imageHashes = (input.imageDataUris ?? []).map((dataUri) =>
            crypto.createHash('sha256').update(dataUri).digest('hex')
        );
        return crypto
            .createHash('sha256')
            .update(
                JSON.stringify({
                    text: input.text ?? '',
                    mentions: input.mentions,
                    replyToMessageId: input.replyToMessageId,
                    attachmentHashes,
                    imageHashes
                })
            )
            .digest('hex');
    }

    private copyResource(flowId: string, sourcePath: string, preferredName?: string): AgentFlowResourceContent {
        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
            throw new Error(t('agentoffice.error.attachmentMustBeFile'));
        }
        const originalName = preferredName || path.basename(sourcePath);
        const candidateExtension = (path.extname(originalName) || path.extname(sourcePath)).toLowerCase();
        const extension = /^\.[a-z0-9]{1,16}$/.test(candidateExtension) ? candidateExtension : '';
        const resourceId = crypto.randomUUID();
        const fileName = `${resourceId}${extension}`;
        const targetPath = path.join(this.flowDirectory(flowId), 'resources', fileName);
        const bytes = fs.readFileSync(sourcePath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, bytes);
        const mimeType = mimeTypeFor(sourcePath);
        return {
            type: 'resource',
            resourceId,
            mediaType: mediaTypeFor(mimeType),
            mimeType,
            name: originalName,
            path: `resources/${fileName}`,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length
        };
    }

    private copyDataUri(flowId: string, dataUri: string): AgentFlowResourceContent {
        const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUri);
        if (!match || !match[1].startsWith('image/')) throw new Error(t('agentoffice.error.imageDataUriOnly'));
        const mimeType = match[1];
        const knownExtensions: Record<string, string> = {
            'image/png': '.png',
            'image/jpeg': '.jpg',
            'image/gif': '.gif',
            'image/webp': '.webp'
        };
        const extension = knownExtensions[mimeType];
        if (!extension) throw new Error(t('agentoffice.error.imageDataUriOnly'));
        const resourceId = crypto.randomUUID();
        const fileName = `${resourceId}${extension}`;
        const bytes = Buffer.from(match[2], 'base64');
        const targetPath = path.join(this.flowDirectory(flowId), 'resources', fileName);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, bytes);
        return {
            type: 'resource',
            resourceId,
            mediaType: 'image',
            mimeType,
            name: `image${extension}`,
            path: `resources/${fileName}`,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length
        };
    }

    private resourceDataUri(flowId: string, resource: AgentFlowResourceContent): string {
        const bytes = fs.readFileSync(path.join(this.flowDirectory(flowId), resource.path));
        return `data:${resource.mimeType};base64,${bytes.toString('base64')}`;
    }

    private messageImageDataUris(flowId: string, message: AgentFlowMessage): string[] {
        return message.content
            .filter((part): part is AgentFlowResourceContent => part.type === 'resource' && part.mediaType === 'image')
            .map((resource) => this.resourceDataUri(flowId, resource));
    }

    private cursorMac(flowId: string, offset: number, issuedAt: number): string {
        return crypto
            .createHmac('sha256', this.cursorSecret)
            .update(`${flowId}:${offset}:${issuedAt}`)
            .digest('base64url');
    }

    private encodeCursor(flowId: string, offset: number): string {
        const issuedAt = Date.now();
        return Buffer.from(
            JSON.stringify({ flowId, offset, issuedAt, mac: this.cursorMac(flowId, offset, issuedAt) }),
            'utf8'
        ).toString('base64url');
    }

    private decodeCursor(flowId: string, cursor: string | undefined): number {
        if (!cursor) return 0;
        try {
            const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as FlowCursorPayload;
            if (payload.flowId !== flowId || !Number.isInteger(payload.offset) || payload.offset < 0) {
                throw new Error('cursor mismatch');
            }
            if (!Number.isFinite(payload.issuedAt) || Date.now() - payload.issuedAt > FLOW_CURSOR_MAX_AGE_MS) {
                throw new Error('cursor expired');
            }
            const expected = Buffer.from(this.cursorMac(flowId, payload.offset, payload.issuedAt), 'base64url');
            const received = Buffer.from(payload.mac ?? '', 'base64url');
            if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
                throw new Error('cursor integrity check failed');
            }
            return payload.offset;
        } catch {
            throw new Error(t('agentoffice.flow.error.invalidMessageCursor'));
        }
    }

    private readFlow(flowId: string): AgentFlow {
        const filePath = this.flowPath(flowId);
        if (!fs.existsSync(filePath)) throw new Error(t('agentoffice.flow.error.notFound'));
        try {
            const result = AgentFlowSchema.safeParse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
            if (!result.success) throw new Error(t('agentoffice.flow.error.invalidData'));
            return result.data;
        } catch (error) {
            if (error instanceof SyntaxError) throw new Error(t('agentoffice.flow.error.invalidData'));
            throw error;
        }
    }

    private assertMutable(flow: AgentFlow, expectedRevision: number): void {
        const revision = parseAgentFlowInput(AgentFlowRevisionSchema, expectedRevision);
        if (flow.revision !== revision) throw new Error(t('agentoffice.flow.error.revisionConflict'));
        if (flow.status === 'archived') throw new Error(t('agentoffice.flow.error.archived'));
    }

    private assertExistingStaff(memberIds: string[]): void {
        const staffIds = new Set(this.staffRepository.listStaffs().map((staff) => staff.id));
        if (memberIds.some((staffId) => !staffIds.has(staffId))) {
            throw new Error(t('agentoffice.flow.error.memberNotFound'));
        }
    }

    private writeRevision(flow: AgentFlow, patch: Partial<AgentFlow>): AgentFlow {
        const next = parseAgentFlowInput(AgentFlowSchema, {
            ...flow,
            ...patch,
            id: flow.id,
            schemaVersion: flow.schemaVersion,
            revision: flow.revision + 1,
            createdAt: flow.createdAt,
            updatedAt: new Date().toISOString()
        });
        atomicWriteJson(this.flowPath(flow.id), next);
        return next;
    }
}
