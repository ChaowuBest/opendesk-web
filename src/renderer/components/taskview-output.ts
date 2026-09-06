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

import type { OutputDisplayLevel } from '../../common/output-display.js';

export type GuiReasonDisplayMode = 'inline' | 'bubble';

export interface GuiToolCall {
    tool_name?: string;
    requires_user_attention?: boolean;
}

export interface GuiAssistantPart {
    type?: string;
    rendered?: string;
    text?: string;
    streaming?: boolean;
    toolcalls?: GuiToolCall[];
}

export interface GuiProcessEntry {
    type: 'reasoning' | 'tool';
    key: string;
    partIndex: number;
    part: GuiAssistantPart;
    tools?: GuiToolCall[];
}

export interface GuiProcessItem {
    type: 'process';
    key: string;
    entries: GuiProcessEntry[];
    hasReasoning: boolean;
    requiresUserAttention: boolean;
}

export interface GuiBodyItem {
    type: 'body' | 'final' | 'error';
    key: string;
    partIndex: number;
    part: GuiAssistantPart;
}

export interface GuiStatusItem {
    type: 'status';
    key: 'running-status';
    kind: 'reasoning' | 'tool' | 'working';
    tool?: GuiToolCall;
}

export type GuiAssistantOutputItem = GuiProcessItem | GuiBodyItem;
export type GuiVisibleAssistantOutputItem = GuiAssistantOutputItem | GuiStatusItem;

export function normalizeGuiOutputMode(value: unknown): OutputDisplayLevel {
    return value === 'verbose' ? 'verbose' : 'minimal';
}

export function normalizeGuiReasonDisplayMode(value: unknown): GuiReasonDisplayMode {
    return value === 'bubble' ? 'bubble' : 'inline';
}

export function getDefaultExpanded(mode: OutputDisplayLevel): boolean {
    return mode === 'verbose';
}

function hasVisibleContent(part: GuiAssistantPart): boolean {
    return Boolean(String(part.rendered ?? part.text ?? '').trim());
}

export function buildAssistantOutputItems(
    parts: GuiAssistantPart[],
    options: { isRunning: boolean }
): GuiAssistantOutputItem[] {
    const items: GuiAssistantOutputItem[] = [];
    let entries: GuiProcessEntry[] = [];
    let processIndex = 0;
    let processHasReasoning = false;

    const flushProcess = () => {
        if (entries.length === 0) return;
        items.push({
            type: 'process',
            key: `process-${processIndex}`,
            entries,
            hasReasoning: processHasReasoning,
            requiresUserAttention: entries.some(
                (entry) => entry.type === 'tool' && entry.tools?.some((tool) => tool.requires_user_attention === true)
            )
        });
        processIndex += 1;
        entries = [];
        processHasReasoning = false;
    };

    parts.forEach((part, partIndex) => {
        if (!part) return;
        if (part.type === 'reasoning') {
            processHasReasoning = true;
            entries.push({
                type: 'reasoning',
                key: `reasoning-${partIndex}`,
                partIndex,
                part
            });
            return;
        }

        if (part.type === 'tool_call') {
            const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
            if (toolcalls.length > 0 || hasVisibleContent(part)) {
                entries.push({
                    type: 'tool',
                    key: `tool-${partIndex}`,
                    partIndex,
                    part,
                    tools: toolcalls
                });
            }
            return;
        }

        if (!hasVisibleContent(part)) return;
        flushProcess();
        items.push({
            type: part.type === 'error' ? 'error' : 'body',
            key: `${part.type || 'body'}-${partIndex}`,
            partIndex,
            part
        });
    });

    flushProcess();

    if (!options.isRunning) {
        for (let index = items.length - 1; index >= 0; index -= 1) {
            if (items[index].type === 'body') {
                (items[index] as GuiBodyItem).type = 'final';
                break;
            }
        }
    }

    return items;
}

function buildRunningStatus(parts: GuiAssistantPart[]): GuiStatusItem | undefined {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index];
        if (!part) continue;
        if (part.type === 'text' && hasVisibleContent(part)) {
            return undefined;
        }
        if (part.type === 'tool_call') {
            const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
            return {
                type: 'status',
                key: 'running-status',
                kind: 'tool',
                tool: toolcalls[toolcalls.length - 1]
            };
        }
        if (part.type === 'reasoning') {
            return { type: 'status', key: 'running-status', kind: 'reasoning' };
        }
    }
    return { type: 'status', key: 'running-status', kind: 'working' };
}

export function getVisibleAssistantOutputItems(
    items: GuiAssistantOutputItem[],
    options: {
        mode: OutputDisplayLevel;
        isRunning: boolean;
        showRunningDetails?: boolean;
        parts?: GuiAssistantPart[];
    }
): GuiVisibleAssistantOutputItem[] {
    if (!options.isRunning) return items;

    const parts =
        options.parts ??
        items.flatMap((item) => {
            if (item.type === 'process') {
                return item.entries.map((entry) => entry.part);
            }
            return [item.part];
        });
    const status = buildRunningStatus(parts);
    if (!status) return items;
    if (options.mode === 'verbose' && status.kind === 'reasoning') return items;
    if (options.mode === 'minimal' && !options.showRunningDetails) {
        const activeProcess = items.at(-1);
        if (activeProcess?.type === 'process' && activeProcess.requiresUserAttention) {
            const attentionEntries = activeProcess.entries.filter(
                (entry) => entry.type === 'tool' && entry.tools?.some((tool) => tool.requires_user_attention === true)
            );
            return [
                ...items.slice(0, -1),
                {
                    ...activeProcess,
                    entries: attentionEntries,
                    hasReasoning: false
                }
            ];
        }
        const hasBody = items.some((item) => item.type === 'body' || item.type === 'error');
        if (!hasBody) return [status];

        const committedItems = items.at(-1)?.type === 'process' ? items.slice(0, -1) : items;
        return [...committedItems, status];
    }
    if (options.mode === 'minimal') {
        if (items.at(-1)?.type === 'process') {
            return [...items.slice(0, -1), status, items[items.length - 1]];
        }
        return [...items, status];
    }
    return [...items, status];
}
