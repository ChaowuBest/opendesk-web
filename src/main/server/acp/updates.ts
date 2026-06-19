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

import type * as acp from '@agentclientprotocol/sdk';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { TaskUpdateAssistantChunk, TaskUpdateChunk } from '../../aikernel/states/tasks.js';
import type { ToolCall } from '../../aikernel/messages.js';
import { t } from '../../../locale/index.js';

type AcpToolStatus = acp.ToolCallStatus;
type AcpToolKind = acp.ToolKind;

function safeParseJson(value: string | undefined): unknown {
    if (!value || value.trim().length === 0) return undefined;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function firstString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
    if (!record) return undefined;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return undefined;
}

export function toJsonCompatible(value: unknown): unknown {
    if (value === undefined) return undefined;
    try {
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : JSON.parse(json);
    } catch {
        return String(value);
    }
}

export function mapToolStatus(status: ToolCall['status'] | undefined): AcpToolStatus {
    if (status === 'pending') return 'pending';
    if (status === 'running') return 'in_progress';
    if (status === 'error') return 'failed';
    return 'completed';
}

export function mapToolKind(toolName: string): AcpToolKind {
    const name = toolName.toLowerCase();
    if (name.includes('read') || name.includes('extract')) return 'read';
    if (name.includes('searchreplace') || name.includes('write') || name.includes('edit') || name.includes('patch')) {
        return 'edit';
    }
    if (name.includes('grep') || name.includes('glob') || name.includes('search')) return 'search';
    if (name.includes('delete') || name.includes('remove')) return 'delete';
    if (name.includes('move') || name.includes('rename')) return 'move';
    if (name.includes('bash') || name.includes('zsh') || name.includes('powershell') || name.includes('shell')) {
        return 'execute';
    }
    if (name.includes('fetch') || name.includes('web')) return 'fetch';
    if (name.includes('think') || name.includes('plan')) return 'think';
    if (name.includes('mode')) return 'switch_mode';
    return 'other';
}

export function getToolRawInput(toolCall: ToolCall): unknown {
    if (toolCall.args_object && Object.keys(toolCall.args_object).length > 0) {
        return toolCall.args_object;
    }
    return safeParseJson(toolCall.args_string);
}

export function getToolLocations(toolCall: ToolCall): acp.ToolCallLocation[] | undefined {
    const input = asRecord(getToolRawInput(toolCall));
    const path =
        firstString(input, ['path', 'filePath', 'filepath', 'file_path', 'cwd']) ||
        (toolCall.tool_name.toLowerCase().includes('web') ? undefined : firstString(input, ['url']));
    if (!path) return undefined;
    return [{ path }];
}

function getToolOutputText(toolCall: ToolCall): string | undefined {
    if (typeof toolCall.result === 'string' && toolCall.result.length > 0) {
        return toolCall.result;
    }
    if (toolCall.result_object !== undefined) {
        try {
            return JSON.stringify(toolCall.result_object);
        } catch {
            return String(toolCall.result_object);
        }
    }
    return undefined;
}

function toolSnapshot(toolCall: ToolCall): string {
    return JSON.stringify({
        status: toolCall.status,
        args: toolCall.args_string?.length ?? 0,
        result: toolCall.result?.length ?? 0,
        resultObject: toolCall.result_object !== undefined
    });
}

export class AcpUpdateTranslator {
    private textOffsets = new Map<string, number>();
    private thoughtOffsets = new Map<string, number>();
    private emittedToolCalls = new Set<string>();
    private toolSnapshots = new Map<string, string>();

    async publish(connection: AgentSideConnection, sessionId: string, chunk: TaskUpdateChunk): Promise<void> {
        if (chunk.type !== 'assistant') {
            return;
        }

        const assistantChunk = chunk as TaskUpdateAssistantChunk;
        const part = assistantChunk.last_part as any;
        if (!part) return;

        if (part.type === 'text') {
            await this.publishTextDelta(connection, sessionId, assistantChunk, part.text ?? '', false);
            return;
        }

        if (part.type === 'reasoning') {
            await this.publishTextDelta(connection, sessionId, assistantChunk, part.content ?? part.text ?? '', true);
            return;
        }

        if (part.type === 'tool_call') {
            for (const toolCall of part.toolcalls ?? []) {
                await this.publishToolCall(connection, sessionId, toolCall);
            }
            return;
        }

        if (part.type === 'error') {
            const title = typeof part.title === 'string' ? part.title : t('headless.error');
            const message = typeof part.message === 'string' ? part.message : '';
            await this.publishTextDelta(connection, sessionId, assistantChunk, `${title}: ${message}`, false);
        }
    }

    private async publishTextDelta(
        connection: AgentSideConnection,
        sessionId: string,
        chunk: TaskUpdateAssistantChunk,
        content: string,
        thought: boolean
    ): Promise<void> {
        if (!content) return;

        const offsets = thought ? this.thoughtOffsets : this.textOffsets;
        const key = `${chunk.message_id}:${chunk.last_part_index}`;
        const previous = offsets.get(key) ?? 0;
        const delta = content.slice(previous);
        offsets.set(key, content.length);
        if (!delta) return;

        await connection.sessionUpdate({
            sessionId,
            update: {
                sessionUpdate: thought ? 'agent_thought_chunk' : 'agent_message_chunk',
                content: {
                    type: 'text',
                    text: delta
                }
            }
        });
    }

    private async publishToolCall(
        connection: AgentSideConnection,
        sessionId: string,
        toolCall: ToolCall
    ): Promise<void> {
        const toolCallId = toolCall.id || `${toolCall.tool_name}-${toolCall.index}`;
        const kind = mapToolKind(toolCall.tool_name);
        const status = mapToolStatus(toolCall.status);
        const rawInput = toJsonCompatible(getToolRawInput(toolCall));
        const locations = getToolLocations(toolCall);

        if (!this.emittedToolCalls.has(toolCallId)) {
            this.emittedToolCalls.add(toolCallId);
            await connection.sessionUpdate({
                sessionId,
                update: {
                    sessionUpdate: 'tool_call',
                    toolCallId,
                    title: toolCall.tool_name,
                    kind,
                    status,
                    ...(locations ? { locations } : {}),
                    ...(rawInput !== undefined ? { rawInput } : {})
                }
            });
        }

        const snapshot = toolSnapshot(toolCall);
        if (this.toolSnapshots.get(toolCallId) === snapshot) {
            return;
        }
        this.toolSnapshots.set(toolCallId, snapshot);

        const outputText = getToolOutputText(toolCall);
        const rawOutput = toJsonCompatible(toolCall.result_object ?? outputText);
        await connection.sessionUpdate({
            sessionId,
            update: {
                sessionUpdate: 'tool_call_update',
                toolCallId,
                kind,
                status,
                title: toolCall.tool_name,
                ...(locations ? { locations } : {}),
                ...(rawInput !== undefined ? { rawInput } : {}),
                ...(outputText
                    ? {
                          content: [
                              {
                                  type: 'content',
                                  content: {
                                      type: 'text',
                                      text: outputText
                                  }
                              }
                          ],
                          rawOutput
                      }
                    : {})
            }
        });
    }
}
