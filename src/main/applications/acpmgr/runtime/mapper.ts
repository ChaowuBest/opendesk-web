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

import type { SessionUpdate, ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { AcpProjectedToolLocation, AcpProjectedToolStatus, AcpProjectedUpdate } from './types.js';

type ToolSnapshot = {
    toolCallId: string;
    title: string;
    status: AcpProjectedToolStatus;
    locations?: AcpProjectedToolLocation[];
    rawInput?: unknown;
    rawOutput?: unknown;
};

function mapToolStatus(status: string | null | undefined, fallback: AcpProjectedToolStatus): AcpProjectedToolStatus {
    return status === 'pending' ||
        status === 'in_progress' ||
        status === 'completed' ||
        status === 'failed' ||
        status === 'cancelled'
        ? status
        : fallback;
}

function mapLocations(
    locations: ToolCall['locations'] | ToolCallUpdate['locations']
): AcpProjectedToolLocation[] | undefined {
    if (!locations) return undefined;
    return locations.map((location) => ({
        path: location.path,
        ...(typeof location.line === 'number' ? { line: location.line } : {})
    }));
}

function metadataUpdate(update: SessionUpdate): AcpProjectedUpdate {
    const data: Record<string, unknown> = { ...update };
    delete data._meta;
    return { type: 'metadata', data };
}

function messageMetadata(update: SessionUpdate): { messageId?: string; replace: boolean } {
    const meta = update._meta;
    return {
        ...(typeof meta?.['opendesk/messageId'] === 'string' ? { messageId: meta['opendesk/messageId'] } : {}),
        replace: meta?.['opendesk/replace'] === true
    };
}

export class AcpSessionUpdateMapper {
    private readonly tools = new Map<string, ToolSnapshot>();

    map(update: SessionUpdate): AcpProjectedUpdate[] {
        switch (update.sessionUpdate) {
            case 'agent_message_chunk': {
                if (update.content.type !== 'text') return [metadataUpdate(update)];
                const message = messageMetadata(update);
                return message.replace && message.messageId
                    ? [{ type: 'message_replace', text: update.content.text, messageId: message.messageId }]
                    : [
                          {
                              type: 'message_delta',
                              text: update.content.text,
                              ...(message.messageId ? { messageId: message.messageId } : {})
                          }
                      ];
            }
            case 'agent_thought_chunk': {
                if (update.content.type !== 'text') return [metadataUpdate(update)];
                const thought = messageMetadata(update);
                return thought.replace && thought.messageId
                    ? [{ type: 'thought_replace', text: update.content.text, messageId: thought.messageId }]
                    : [
                          {
                              type: 'thought_delta',
                              text: update.content.text,
                              ...(thought.messageId ? { messageId: thought.messageId } : {})
                          }
                      ];
            }
            case 'user_message_chunk':
                return [];
            case 'tool_call':
                return [this.mapToolCall(update)];
            case 'tool_call_update':
                return [this.mapToolCallUpdate(update)];
            case 'plan':
                return [
                    {
                        type: 'plan',
                        entries: update.entries.map((entry) => ({
                            content: entry.content,
                            status: entry.status,
                            priority: entry.priority
                        }))
                    }
                ];
            default:
                return [metadataUpdate(update)];
        }
    }

    private mapToolCall(update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }>): AcpProjectedUpdate {
        const snapshot: ToolSnapshot = {
            toolCallId: update.toolCallId,
            title: update.title,
            status: mapToolStatus(update.status, 'pending'),
            ...(update.locations ? { locations: mapLocations(update.locations) } : {}),
            ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
            ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {})
        };
        this.tools.set(update.toolCallId, snapshot);
        return { type: 'tool_call', ...snapshot };
    }

    private mapToolCallUpdate(
        update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>
    ): AcpProjectedUpdate {
        const previous = this.tools.get(update.toolCallId);
        const snapshot: ToolSnapshot = {
            toolCallId: update.toolCallId,
            title: update.title ?? previous?.title ?? update.name ?? update.toolCallId,
            status: mapToolStatus(update.status, previous?.status ?? 'pending'),
            ...(update.locations
                ? { locations: mapLocations(update.locations) }
                : previous?.locations
                  ? { locations: previous.locations }
                  : {}),
            ...(update.rawInput !== undefined
                ? { rawInput: update.rawInput }
                : previous?.rawInput !== undefined
                  ? { rawInput: previous.rawInput }
                  : {}),
            ...(update.rawOutput !== undefined
                ? { rawOutput: update.rawOutput }
                : previous?.rawOutput !== undefined
                  ? { rawOutput: previous.rawOutput }
                  : {})
        };
        this.tools.set(update.toolCallId, snapshot);
        return { type: 'tool_call', ...snapshot };
    }
}
