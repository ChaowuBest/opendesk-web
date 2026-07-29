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

import crypto from 'crypto';
import type {
    PermissionPromptContext,
    PermissionPromptProvider,
    PermissionRequest,
    PermissionTaskInfo,
    PermissionUserResponse
} from '../../aikernel/security/permission.js';
import { EventBus } from './event-bus.js';

export type OpenCodePermissionReply = 'once' | 'always' | 'reject';

export interface OpenCodePermissionRequest {
    id: string;
    sessionID: string;
    permission: string;
    patterns: string[];
    metadata: Record<string, unknown>;
    always: string[];
    tool?: {
        messageID: string;
        callID: string;
    };
}

export interface OpenCodePermissionReplyBody {
    reply: OpenCodePermissionReply;
    message?: string;
}

interface PendingPermission {
    info: OpenCodePermissionRequest;
    prefixOptions: { label: string; pattern: string }[];
    timer: ReturnType<typeof setTimeout>;
    resolve: (response: PermissionUserResponse) => void;
}

let _permissionCounter = 0;

function ascendingPermissionId(): string {
    const ts = Date.now().toString(36).padStart(9, '0');
    const seq = (++_permissionCounter).toString(36).padStart(4, '0');
    const rand = crypto.randomBytes(3).toString('hex');
    return `per_${ts}${seq}${rand}`;
}

function toExternalSessionId(taskId: string | undefined): string {
    if (!taskId) return 'ses_unknown';
    if (taskId.startsWith('task_')) {
        return taskId.replace('task_', 'ses_');
    }
    if (taskId.startsWith('ses_')) {
        return taskId;
    }
    return `ses_${taskId}`;
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = input[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return undefined;
}

function normalizeInput(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
    }
    return { ...(input as Record<string, unknown>) };
}

function inferPermissionName(toolName: string, requests: PermissionRequest[]): string {
    const name = toolName.toLowerCase();
    if (name === 'readfile') return 'read';
    if (name === 'writefile' || name === 'editfile' || name === 'searchreplace' || name === 'applypatch') return 'edit';
    if (name === 'globfiles') return 'glob';
    if (name === 'grepfiles') return 'grep';
    if (name === 'executepowershell' || name === 'executebash' || name === 'executezsh') return 'bash';
    if (name === 'webfetch') return 'webfetch';
    if (name.includes('websearch') || name.endsWith('search')) return 'websearch';
    if (name === 'loadskill' || name === 'callskill') return 'skill';
    if (name === 'createsubtask') return 'task';

    const first = requests[0];
    if (!first) return toolName;
    if (first.resourceType === 'file' && first.action === 'read') return 'read';
    if (first.resourceType === 'file' && first.action === 'write') return 'edit';
    if (first.resourceType === 'network') return 'webfetch';
    if (first.resourceType === 'skill') return 'skill';
    if (first.action === 'execute') return 'bash';
    return `${first.resourceType}.${first.action}`;
}

function buildMetadata(
    permission: string,
    toolName: string,
    requests: PermissionRequest[],
    prefixOptions: { label: string; pattern: string }[],
    context?: PermissionPromptContext
): Record<string, unknown> {
    const input = normalizeInput(context?.input);
    const firstPath = requests[0]?.resourcePath || '';
    const metadata: Record<string, unknown> = {
        toolName,
        input,
        requests: requests.map((request) => ({
            resourceType: request.resourceType,
            action: request.action,
            resourcePath: request.resourcePath
        })),
        prefixOptions
    };

    if (permission === 'edit') {
        const filePath = firstString(input, ['filePath', 'filepath', 'path']) || firstPath;
        metadata.filepath = filePath;
        metadata.filePath = filePath;
        const diff = firstString(input, ['diff']);
        if (diff) metadata.diff = diff;
    } else if (permission === 'read') {
        const filePath = firstString(input, ['filePath', 'file_path', 'path']) || firstPath;
        metadata.filePath = filePath;
        metadata.file_path = filePath;
    } else if (permission === 'bash') {
        metadata.command = firstString(input, ['command']) || '';
        metadata.description = firstString(input, ['description']) || '';
    } else if (permission === 'webfetch') {
        metadata.url = firstString(input, ['url']) || firstPath;
    } else if (permission === 'websearch') {
        metadata.query = firstString(input, ['query']) || '';
    }

    return metadata;
}

function buildAlwaysPatterns(
    requests: PermissionRequest[],
    prefixOptions: { label: string; pattern: string }[]
): string[] {
    if (requests[0]?.resourceType === 'file') {
        const directoryPrefix = prefixOptions.find(({ pattern }) => pattern.endsWith('/**'))?.pattern;
        if (directoryPrefix) return [directoryPrefix];
    }

    const firstPrefix = prefixOptions[0]?.pattern;
    if (firstPrefix) return [firstPrefix];
    const firstPath = requests[0]?.resourcePath;
    return firstPath ? [firstPath] : ['*'];
}

export class ServerPermissionBroker implements PermissionPromptProvider {
    private static instance: ServerPermissionBroker | null = null;
    private pending = new Map<string, PendingPermission>();
    private activeAssistantMessages = new Map<string, string>();
    private timeoutMs: number;

    constructor(timeoutMs = 300_000) {
        this.timeoutMs = timeoutMs;
    }

    static getInstance(): ServerPermissionBroker {
        if (!ServerPermissionBroker.instance) {
            ServerPermissionBroker.instance = new ServerPermissionBroker();
        }
        return ServerPermissionBroker.instance;
    }

    list(): OpenCodePermissionRequest[] {
        return Array.from(this.pending.values(), (item) => item.info);
    }

    setActiveAssistantMessage(taskId: string, messageID: string): void {
        this.activeAssistantMessages.set(taskId, messageID);
    }

    prompt(
        requests: PermissionRequest[],
        toolName: string,
        prefixOptions: { label: string; pattern: string }[],
        taskInfo?: PermissionTaskInfo,
        context?: PermissionPromptContext
    ): Promise<PermissionUserResponse> {
        if (requests.length === 0) {
            return Promise.resolve({ decision: 'allow', rememberScope: 'none' });
        }

        const id = ascendingPermissionId();
        const permission = inferPermissionName(toolName, requests);
        const input = normalizeInput(context?.input);
        const info: OpenCodePermissionRequest = {
            id,
            sessionID: toExternalSessionId(taskInfo?.taskId),
            permission,
            patterns: requests.map((request) => request.resourcePath),
            metadata: buildMetadata(permission, toolName, requests, prefixOptions, { ...context, input }),
            always: buildAlwaysPatterns(requests, prefixOptions)
        };
        if (taskInfo?.workspace) {
            info.metadata.workspace = taskInfo.workspace;
        }

        const messageID = taskInfo?.taskId ? this.activeAssistantMessages.get(taskInfo.taskId) : undefined;
        if ((messageID || context?.messageId) && context?.toolCallId) {
            info.tool = {
                messageID: messageID || context.messageId!,
                callID: context.toolCallId
            };
        }

        return new Promise<PermissionUserResponse>((resolve) => {
            const timer = setTimeout(() => {
                if (!this.pending.has(id)) return;
                this.pending.delete(id);
                EventBus.publish({
                    type: 'permission.replied',
                    directory: taskInfo?.workspace,
                    properties: {
                        sessionID: info.sessionID,
                        requestID: id,
                        reply: 'reject'
                    }
                });
                resolve({ decision: 'deny', rememberScope: 'none', denyReason: 'timeout' });
            }, this.timeoutMs);

            this.pending.set(id, {
                info,
                prefixOptions,
                timer,
                resolve
            });

            EventBus.publish({
                type: 'permission.asked',
                directory: taskInfo?.workspace,
                properties: info as unknown as Record<string, unknown>
            });
        });
    }

    reply(requestID: string, body: OpenCodePermissionReplyBody): boolean {
        const pending = this.pending.get(requestID);
        if (!pending) return false;

        this.resolvePending(pending, body.reply);

        if (body.reply === 'reject') {
            for (const item of Array.from(this.pending.values())) {
                if (item.info.sessionID !== pending.info.sessionID) continue;
                this.resolvePending(item, 'reject');
            }
        }

        return true;
    }

    dispose(): void {
        for (const item of Array.from(this.pending.values())) {
            this.resolvePending(item, 'reject', 'timeout');
        }
        this.pending.clear();
    }

    private resolvePending(
        pending: PendingPermission,
        reply: OpenCodePermissionReply,
        denyReason: PermissionUserResponse['denyReason'] = 'user_denied'
    ): void {
        this.pending.delete(pending.info.id);
        clearTimeout(pending.timer);

        EventBus.publish({
            type: 'permission.replied',
            directory: pending.info.metadata.workspace as string | undefined,
            properties: {
                sessionID: pending.info.sessionID,
                requestID: pending.info.id,
                reply
            }
        });

        if (reply === 'reject') {
            pending.resolve({ decision: 'deny', rememberScope: 'none', denyReason });
            return;
        }

        if (reply === 'always') {
            const selectedPrefixPattern = pending.info.always[0] || pending.prefixOptions[0]?.pattern;
            if (selectedPrefixPattern) {
                pending.resolve({
                    decision: 'allow',
                    rememberScope: 'prefix',
                    selectedPrefixPattern
                });
                return;
            }
        }

        pending.resolve({ decision: 'allow', rememberScope: 'none' });
    }
}
