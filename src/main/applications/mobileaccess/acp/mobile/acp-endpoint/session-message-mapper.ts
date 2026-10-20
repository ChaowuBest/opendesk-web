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

import * as acp from '@agentclientprotocol/sdk';
import type { LoadSessionRequest } from '@agentclientprotocol/sdk';
import path from 'node:path';
import { z } from 'zod';
import { labelForStoredReasoningEffort } from '../../../../../../common/reasoning-effort.js';
import { t } from '../../../../../../locale/index.js';
import { REASONING_EFFORT_VALUES, type ReasoningEffort } from '../../../../../aikernel/types/reasoning.js';
import {
    PUBLIC_SESSION_PROFILE_VERSION,
    PUBLIC_TEXT_MAX_BYTES,
    utf8Bytes,
    type PublicSessionFailureCode
} from '../remote-session-service/public-session.js';
import { isRunToken } from '../remote-session-service/public-session-identifiers.js';
import { RemotePromptDomainError, type RemoteSessionDirectoryEntry } from '../remote-session-service/service.js';
import type {
    HostModelEffortSelection,
    HostSessionModelConfiguration
} from '../remote-session-service/host-binding.js';

export const OPENDESK_MODEL_EFFORT_CONFIG_ID = 'opendesk.model_effort';
export const SESSION_INVALIDATED_METHOD = '_opendesk/session/invalidated' as const;
export const SESSION_INVALIDATION_CAPABILITY = { schemaVersion: 1 } as const;

export interface SessionInvalidationNotification extends Record<string, unknown> {
    schemaVersion: 1;
    sessionId: string;
}

const sessionInvalidationCapabilitySchema = z.object({ schemaVersion: z.literal(1) }).strict();

export function parseAdvertisedSessionInvalidationCapability(
    meta: unknown
): { schemaVersion: 1 } | undefined {
    if (!profileRecord(meta)) return undefined;
    const opendesk = meta.opendesk;
    if (!profileRecord(opendesk)) return undefined;
    const parsed = sessionInvalidationCapabilitySchema.safeParse(opendesk.sessionInvalidation);
    return parsed.success ? parsed.data : undefined;
}

export function encodeSessionInvalidation(sessionId: string): {
    method: typeof SESSION_INVALIDATED_METHOD;
    params: SessionInvalidationNotification;
} {
    return {
        method: SESSION_INVALIDATED_METHOD,
        params: { schemaVersion: 1, sessionId }
    };
}

export function encodeModelEffortValue(selection: HostModelEffortSelection): string {
    return JSON.stringify([selection.modelAlias, selection.reasoningEffort]);
}

export function decodeModelEffortValue(value: string): HostModelEffortSelection {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error('invalid model configuration value');
    }
    if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        typeof parsed[0] !== 'string' ||
        parsed[0].length === 0 ||
        typeof parsed[1] !== 'string' ||
        !REASONING_EFFORT_VALUES.includes(parsed[1] as ReasoningEffort)
    ) {
        throw new Error('invalid model configuration value');
    }
    const selection = { modelAlias: parsed[0], reasoningEffort: parsed[1] as ReasoningEffort };
    if (encodeModelEffortValue(selection) !== value) throw new Error('noncanonical model configuration value');
    return selection;
}

export function mapSessionModelConfigurationOptions(
    configuration: HostSessionModelConfiguration
): acp.SessionConfigOption[] {
    return [
        {
            id: OPENDESK_MODEL_EFFORT_CONFIG_ID,
            type: 'select',
            category: 'model',
            name: `${t('model.provider_model')} / ${t('config.model.field.reasoning_effort')}`,
            currentValue: encodeModelEffortValue(configuration.current),
            options: configuration.candidates.map((candidate) => ({
                group: candidate.modelAlias,
                name: candidate.modelAlias,
                options: candidate.reasoningEfforts.map((effort) => ({
                    value: encodeModelEffortValue({ modelAlias: candidate.modelAlias, reasoningEffort: effort }),
                    name: labelForStoredReasoningEffort(effort, t)
                }))
            }))
        }
    ];
}

export interface OpenDeskCancelIntent {
    sessionId: string;
    runToken: string;
}

function profileRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseOpenDeskCancelProfile(value: unknown): OpenDeskCancelIntent {
    if (!profileRecord(value) || typeof value.sessionId !== 'string' || value.sessionId.trim().length === 0) {
        throw new Error('invalid OpenDesk cancel profile');
    }
    const outer = value._meta;
    const profile = profileRecord(outer) ? outer.opendesk : undefined;
    if (
        !profileRecord(profile) ||
        Object.keys(profile).length !== 2 ||
        profile.schemaVersion !== PUBLIC_SESSION_PROFILE_VERSION ||
        !isRunToken(profile.runToken)
    ) {
        throw new Error('invalid OpenDesk cancel profile');
    }
    return { sessionId: value.sessionId, runToken: profile.runToken };
}

export function parseMobilePromptText(blocks: readonly acp.ContentBlock[]): string {
    const parts = blocks.map((block) => {
        if (block.type === 'text') return block.text;
        if (block.type === 'resource_link') {
            const label = block.title?.trim() || block.name?.trim() || block.uri;
            return `Referenced resource: ${label}\n${block.uri}`;
        }
        throw acp.RequestError.invalidParams(undefined, 'prompt contains an unsupported content block');
    });
    const text = parts.join('\n\n').trim();
    if (!text) throw acp.RequestError.invalidParams(undefined, 'prompt must contain non-empty text');
    if (utf8Bytes(text) > PUBLIC_TEXT_MAX_BYTES) {
        throw acp.RequestError.invalidParams(undefined, 'prompt text exceeds the 1 MiB limit');
    }
    return text;
}

export function assertLoadParams(params: LoadSessionRequest): void {
    if (!path.isAbsolute(params.cwd)) {
        throw acp.RequestError.invalidParams(undefined, 'cwd must be an absolute path');
    }
    if (!Array.isArray(params.mcpServers) || params.mcpServers.length !== 0) {
        throw acp.RequestError.invalidParams(undefined, 'mcpServers are not supported');
    }
    if (Array.isArray(params.additionalDirectories) && params.additionalDirectories.length > 0) {
        throw acp.RequestError.invalidParams(undefined, 'additionalDirectories are not supported');
    }
}

export function assertNewSessionParams(params: acp.NewSessionRequest): void {
    if (typeof params.cwd !== 'string') {
        throw acp.RequestError.invalidParams(undefined, 'cwd must be a string');
    }
    if (!Array.isArray(params.mcpServers) || params.mcpServers.length !== 0) {
        throw acp.RequestError.invalidParams(undefined, 'mcpServers are not supported');
    }
    if (Array.isArray(params.additionalDirectories) && params.additionalDirectories.length > 0) {
        throw acp.RequestError.invalidParams(undefined, 'additionalDirectories are not supported');
    }
}

export function mobileLoadError(code: PublicSessionFailureCode): acp.RequestError {
    return acp.RequestError.internalError({ opendesk: { schemaVersion: 1, code } }, 'Unable to load session');
}

export type MobilePromptCode =
    | 'session_not_live'
    | 'prompt_in_flight'
    | 'task_busy'
    | 'goal_not_supported'
    | 'session_unavailable'
    | 'prompt_rejected'
    | 'prompt_recorded_not_started'
    | 'prompt_failed';

export function mobilePromptError(code: MobilePromptCode): acp.RequestError {
    return acp.RequestError.internalError({ opendesk: { schemaVersion: 1, code } }, 'Unable to continue session');
}

export function mapRemotePromptDomainError(error: RemotePromptDomainError): acp.RequestError {
    switch (error.code) {
        case 'session_unavailable':
            return mobilePromptError('session_unavailable');
        case 'task_busy':
            return mobilePromptError('task_busy');
        case 'goal_not_supported':
            return mobilePromptError('goal_not_supported');
        case 'prompt_rejected':
            return mobilePromptError('prompt_rejected');
        case 'prompt_failed':
            return mobilePromptError('prompt_failed');
        default: {
            const unsupported: never = error.code;
            throw new Error(`unsupported remote prompt domain code: ${String(unsupported)}`);
        }
    }
}

export function mapSessionDirectoryEntries(entries: readonly RemoteSessionDirectoryEntry[]): acp.SessionInfo[] {
    return entries.map((entry) => ({
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        title: entry.title,
        updatedAt: entry.updatedAt,
        _meta: {
            opendesk: {
                schemaVersion: PUBLIC_SESSION_PROFILE_VERSION,
                taskStatus: entry.taskStatus,
                completionStatus: entry.completionStatus
            }
        }
    }));
}

export function sessionNotificationWireBytes(notification: acp.SessionNotification): number {
    return utf8Bytes(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: notification }));
}
