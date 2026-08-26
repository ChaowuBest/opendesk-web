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

export type GuiOutputMode = 'minimal' | 'detailed';

export interface GuiToolCall {
    id?: string;
    index?: number;
    tool_name?: string;
    status?: string;
    args_string?: string;
    result?: string;
    rendered?: string;
    elapsedSeconds?: number;
}

export interface GuiAssistantPart {
    type?: string;
    rendered?: string;
    text?: string;
    elapsedSeconds?: number;
    toolcalls?: GuiToolCall[];
}

export interface GuiProcessEntry {
    type: 'reasoning' | 'tool';
    key: string;
    partIndex: number;
    toolIndex?: number;
    ordinal?: number;
    part?: GuiAssistantPart;
    tool?: GuiToolCall;
}

export interface GuiProcessItem {
    type: 'process';
    key: string;
    processIndex: number;
    entries: GuiProcessEntry[];
    toolCount: number;
    toolStart: number | null;
    toolEnd: number | null;
    hasReasoning: boolean;
    hasError: boolean;
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
    kind: 'reasoning' | 'tool' | 'finalizing' | 'working';
    part?: GuiAssistantPart;
    tool?: GuiToolCall;
    toolCount: number;
}

export type GuiAssistantOutputItem = GuiProcessItem | GuiBodyItem;
export type GuiVisibleAssistantOutputItem = GuiAssistantOutputItem | GuiStatusItem;

export function normalizeGuiOutputMode(value: unknown): GuiOutputMode {
    return value === 'detailed' ? 'detailed' : 'minimal';
}

export function getDefaultProcessExpanded(mode: GuiOutputMode): boolean {
    return mode === 'detailed';
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
    let toolOrdinal = 0;
    let reasoningOrdinal = 0;
    let processIndex = 0;
    let processToolStart: number | null = null;
    let processToolEnd: number | null = null;
    let processHasError = false;
    let processHasReasoning = false;

    const flushProcess = () => {
        if (entries.length === 0) return;
        items.push({
            type: 'process',
            key: `process-${processIndex}`,
            processIndex,
            entries,
            toolCount: processToolStart !== null && processToolEnd !== null ? processToolEnd - processToolStart + 1 : 0,
            toolStart: processToolStart,
            toolEnd: processToolEnd,
            hasReasoning: processHasReasoning,
            hasError: processHasError
        });
        processIndex += 1;
        entries = [];
        processToolStart = null;
        processToolEnd = null;
        processHasError = false;
        processHasReasoning = false;
    };

    parts.forEach((part, partIndex) => {
        if (!part) return;
        if (part.type === 'reasoning') {
            processHasReasoning = true;
            reasoningOrdinal += 1;
            entries.push({
                type: 'reasoning',
                key: `reasoning-${partIndex}`,
                partIndex,
                ordinal: reasoningOrdinal,
                part
            });
            return;
        }

        if (part.type === 'tool_call') {
            const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
            toolcalls.forEach((tool, toolIndex) => {
                toolOrdinal += 1;
                processToolStart ??= toolOrdinal;
                processToolEnd = toolOrdinal;
                processHasError ||= tool?.status === 'error';
                entries.push({
                    type: 'tool',
                    key: `tool-${partIndex}-${tool?.id || toolIndex}`,
                    partIndex,
                    toolIndex,
                    ordinal: toolOrdinal,
                    tool
                });
            });
            if (toolcalls.length === 0 && hasVisibleContent(part)) {
                toolOrdinal += 1;
                processToolStart ??= toolOrdinal;
                processToolEnd = toolOrdinal;
                entries.push({
                    type: 'tool',
                    key: `tool-${partIndex}-fallback`,
                    partIndex,
                    toolIndex: 0,
                    ordinal: toolOrdinal,
                    tool: { rendered: part.rendered }
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

function buildRunningStatus(parts: GuiAssistantPart[]): GuiStatusItem {
    let toolCount = 0;
    for (const part of parts) {
        if (part?.type === 'tool_call') {
            toolCount += Array.isArray(part.toolcalls) && part.toolcalls.length > 0 ? part.toolcalls.length : 1;
        }
    }

    for (let index = parts.length - 1; index >= 0; index -= 1) {
        const part = parts[index];
        if (!part) continue;
        if (part.type === 'text' && hasVisibleContent(part)) {
            return { type: 'status', key: 'running-status', kind: 'finalizing', part, toolCount };
        }
        if (part.type === 'tool_call') {
            const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
            return {
                type: 'status',
                key: 'running-status',
                kind: 'tool',
                part,
                tool: toolcalls[toolcalls.length - 1],
                toolCount
            };
        }
        if (part.type === 'reasoning') {
            return { type: 'status', key: 'running-status', kind: 'reasoning', part, toolCount };
        }
    }
    return { type: 'status', key: 'running-status', kind: 'working', toolCount };
}

export function getVisibleAssistantOutputItems(
    items: GuiAssistantOutputItem[],
    options: { mode: GuiOutputMode; isRunning: boolean; showRunningDetails?: boolean; parts?: GuiAssistantPart[] }
): GuiVisibleAssistantOutputItem[] {
    if (!options.isRunning) return items;

    const parts =
        options.parts ??
        items.flatMap((item) => {
            if (item.type === 'process') {
                return item.entries.flatMap((entry) => (entry.part ? [entry.part] : []));
            }
            return [item.part];
        });
    const status = buildRunningStatus(parts);
    if (!options.parts) {
        status.toolCount = items.reduce((count, item) => count + (item.type === 'process' ? item.toolCount : 0), 0);
    }
    if (options.mode === 'minimal' && !options.showRunningDetails) {
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
