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

import { z } from 'zod';
import { BaseTool } from '../../../aikernel/tool.js';
import type { ToolCall } from '../../../aikernel/messages.js';
import {
    getToolCallPresentationArgs,
    type ToolCallPresentation,
    type ToolPresentationText
} from '../../../aikernel/tool-presentation.js';

function toolKind(toolName: string): string {
    return toolName
        .split(/[-./:]/)
        .pop()!
        .replace(/Tool$/i, '')
        .toLowerCase();
}

function normalizeUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    try {
        const url = new URL(value.trim());
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
    } catch {
        return undefined;
    }
}

function presentationText(args: Record<string, unknown>, url?: string): ToolPresentationText | undefined {
    for (const key of ['description', 'purpose', 'task']) {
        const value = args[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    if (url) return { key: 'renderer.taskview.output.purpose.openUrl', params: { url } };
    for (const key of ['query', 'pattern', 'url']) {
        if (args[key] !== undefined) return String(args[key]);
    }
    return undefined;
}

function searchPresentation(toolCall: ToolCall): ToolCallPresentation {
    const kind = toolKind(toolCall.tool_name);
    const args = getToolCallPresentationArgs(toolCall);
    const url = normalizeUrl(args.url);
    const displayName: ToolPresentationText =
        kind === 'webfetch'
            ? { key: 'search.webfetch.name' }
            : kind === 'websearch'
              ? { key: 'renderer.taskview.output.toolName.webSearch' }
              : toolCall.tool_name;
    return {
        displayName,
        summary: presentationText(args, url),
        resource: url ? { type: 'url', value: url } : undefined,
        resultFormat: kind === 'webfetch' || kind.endsWith('search') ? 'markdown' : undefined
    };
}

export abstract class SearchPresentationTool<T extends z.ZodType> extends BaseTool<T> {
    getToolCallPresentation(toolCall: ToolCall): ToolCallPresentation {
        return searchPresentation(toolCall);
    }
}
