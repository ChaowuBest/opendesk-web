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

import { escapeHtml } from '../../../../common/utils/escape.js';
import { getSafeWebUrl } from '../../../../common/web-link.js';
import type { ToolCall } from '../../../aikernel/messages';

/**
 * 搜索工具统一的 inline GUI 渲染函数
 */
export function renderSearchToolCall(opts: {
    icon: string;
    title: string;
    toolcall: ToolCall;
    query?: string;
    resultCountExtractor?: (result: string) => string | null;
}): string {
    const statusIcon =
        opts.toolcall.status === 'running'
            ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
            : '';

    const detailParts: string[] = [];
    if (opts.query) {
        const safeUrl = getSafeWebUrl(opts.query);
        const escapedQuery = escapeHtml(opts.query.trim());
        detailParts.push(
            safeUrl
                ? `<a class="od-search-tool-link text-blue-600 hover:text-blue-700 hover:underline" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(safeUrl)}">"${escapedQuery}"</a>`
                : `"${escapedQuery}"`
        );
    }
    if (opts.toolcall.status === 'success' && opts.toolcall.result && opts.resultCountExtractor) {
        const count = opts.resultCountExtractor(opts.toolcall.result);
        if (count) {
            detailParts.push(escapeHtml(count));
        }
    }
    const detail = detailParts.join(' · ');
    const detailHtml = detail ? `<span class="truncate text-xs text-slate-600">${detail}</span>` : '';

    return `<div class="od-inline-toolcall-container">
        <div class="flex items-center gap-1.5 min-w-0">
            <i class="${opts.icon} shrink-0 text-slate-400 text-xs"></i>
            <span class="shrink-0 text-slate-500 text-xs">${escapeHtml(opts.title)}</span>
            ${statusIcon}
            ${detailHtml}
        </div>
    </div>`;
}

/** 从 **结果数量**: N 格式的文本中提取结果数 */
export function extractResultCount(result: string): string | null {
    const match = result.match(/\*\*结果数量\*\*:\s*(\d+)/);
    return match ? `${match[1]} 条结果` : null;
}

/** 从 "总计找到 N 条结果" 格式提取 */
export function extractExaResultCount(result: string): string | null {
    const match = result.match(/总计找到\s*(\d+)\s*条结果/);
    return match ? `${match[1]} 条结果` : null;
}
