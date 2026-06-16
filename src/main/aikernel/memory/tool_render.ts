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

import chalk from 'chalk';
import type { ToolCall } from '../messages.js';
import { Card } from '../../tui/components/card.js';
import { statusDisplay, truncText } from '../../tui/components/toolcall.js';
import { escapeHtml } from '../../../common/utils/escape.js';
import { t } from '../../../locale/index.js';

export function parseToolResult<T>(toolcall: ToolCall): T | undefined {
    if (!toolcall.result) {
        return undefined;
    }
    try {
        return JSON.parse(toolcall.result) as T;
    } catch {
        return undefined;
    }
}

export function memoryScopeLabel(scope?: string): string {
    if (scope === 'global') {
        return t('tools.memory.scope.global');
    }
    if (scope === 'workspace') {
        return t('tools.memory.scope.workspace');
    }
    return scope || '';
}

export function truncMemoryText(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function renderMemoryCardCli(
    toolcall: ToolCall,
    width: number,
    options: {
        icon: string;
        title: string;
        body: string[];
        maxLines?: number;
        truncateStrategy?: 'head' | 'tail';
    }
): string[] {
    return new Card({
        icon: options.icon,
        title: options.title,
        status: statusDisplay(toolcall.status),
        body: options.body,
        maxLines: options.maxLines,
        truncateStrategy: options.truncateStrategy
    }).render(width);
}

export function cliField(label: string, value: string, width: number): string {
    return chalk.dim(`${label}: `) + truncText(value, Math.max(8, width - label.length - 6));
}

export function appendCliError(body: string[], toolcall: ToolCall, width: number): void {
    if (toolcall.status === 'error' && toolcall.result) {
        body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
    }
}

function statusBadgeHtml(status: string): string {
    const key = `toolcall.status.${status}`;
    const text = t(key);
    if (status === 'running') {
        return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 text-[10px] font-medium"><i class="fa-solid fa-circle-notch fa-spin text-[8px]"></i>${escapeHtml(text)}</span>`;
    }
    if (status === 'error') {
        return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-50 text-red-600 text-[10px] font-medium"><i class="fa-solid fa-circle-xmark text-[8px]"></i>${escapeHtml(text)}</span>`;
    }
    if (status === 'success') {
        return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[10px] font-medium"><i class="fa-solid fa-circle-check text-[8px]"></i>${escapeHtml(text)}</span>`;
    }
    return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-[10px] font-medium">${escapeHtml(text)}</span>`;
}

export function metaRowHtml(label: string, value: string, options: { mono?: boolean } = {}): string {
    return `<div class="flex gap-2 min-w-0 text-[12px]">
        <span class="text-gray-400 shrink-0">${escapeHtml(label)}</span>
        <span class="${options.mono ? 'font-mono ' : ''}text-gray-600 min-w-0 truncate">${escapeHtml(value)}</span>
    </div>`;
}

export function textBlockHtml(text: string, maxChars = 1800): string {
    const preview = truncMemoryText(text, maxChars);
    return `<div class="text-[12px] text-gray-600 leading-relaxed whitespace-pre-wrap break-words">${escapeHtml(preview)}</div>`;
}

export function renderMemoryCardHtml(
    toolcall: ToolCall,
    options: {
        iconClass: string;
        title: string;
        subtitle?: string;
        bodyHtml?: string;
        defaultOpen?: boolean;
    }
): string {
    const isError = toolcall.status === 'error';
    const borderColor = isError ? 'border-red-200' : 'border-gray-200';
    const iconTone = isError ? 'bg-red-50 text-red-500' : 'bg-emerald-50 text-emerald-600';
    const subtitle = options.subtitle
        ? `<span class="text-[12px] text-gray-600 truncate flex-1">${escapeHtml(options.subtitle)}</span>`
        : '<span class="flex-1"></span>';
    const errorBody =
        isError && toolcall.result
            ? `<div class="px-3.5 py-2.5 text-[12px] text-red-600">${escapeHtml(String(toolcall.result).slice(0, 300))}</div>`
            : '';
    const bodyHtml = errorBody || options.bodyHtml || '';

    return `<div class="od-inline-toolcall-container">
        <details class="memory-tool-card my-1.5 rounded-lg border ${borderColor} bg-white overflow-hidden w-full" ${options.defaultOpen === false ? '' : 'open'}>
            <summary class="flex items-center gap-2 px-3 py-2 cursor-pointer select-none hover:bg-gray-50/60 transition-colors duration-150 min-w-0">
                <span class="inline-flex items-center justify-center w-5 h-5 rounded ${iconTone} shrink-0">
                    <i class="${escapeHtml(options.iconClass)} text-[10px]"></i>
                </span>
                <span class="text-[12px] text-gray-500 shrink-0">${escapeHtml(options.title)}</span>
                ${subtitle}
                ${statusBadgeHtml(toolcall.status)}
                <svg class="w-3 h-3 text-gray-400 shrink-0 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M6 9l6 6 6-6"/>
                </svg>
            </summary>
            ${bodyHtml ? `<div class="border-t border-gray-100 bg-gray-50/40"><div class="px-3.5 py-2.5 max-h-[260px] overflow-y-auto space-y-2">${bodyHtml}</div></div>` : ''}
        </details>
    </div>`;
}
