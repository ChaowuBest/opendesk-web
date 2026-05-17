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

import { BaseTool } from '../../aikernel/tool';
import { ToolCall } from '../../aikernel/messages';
import { Card } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import chalk from 'chalk';
import { z } from 'zod';

/**
 * MCP 工具类，继承自 BaseTool，提供专门的渲染逻辑
 */
export class MCPTool<T extends z.ZodType> extends BaseTool<T> {
    private serverName: string;
    private originalToolName: string;

    constructor(serverName: string, toolName: string, description: string, params: T) {
        // 工具名格式：serverName__toolName（去掉 mcpmgr 前缀）
        const safeName = `${serverName.replace(/[^a-zA-Z0-9_]/g, '_')}__${toolName}`;
        super(safeName, `[MCP: ${serverName}] ${description}`, params);

        this.serverName = serverName;
        this.originalToolName = toolName;
    }

    /**
     * 自定义的 GUI 工具调用渲染
     */
    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const statusIcon =
            toolcall.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : toolcall.status === 'error'
                  ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
                  : '';

        // MCP 工具专用渲染：图标 + serverName · toolName
        const toolIcon = '<i class="fas fa-plug shrink-0 text-blue-400 text-xs"></i>';
        const displayName = `<span class="text-slate-600 font-medium">${this.serverName}</span><span class="text-slate-300 mx-0.5">·</span><span class="text-slate-500">${this.originalToolName}</span>`;

        if (toolcall.status === 'error') {
            return `<div class="od-inline-toolcall-container">
                <div class="flex items-center gap-1.5 min-w-0 group relative">
                    ${toolIcon}
                    <span class="shrink-0 text-xs">${displayName}</span>
                    ${statusIcon}
                    <span class="text-xs text-rose-500">失败</span>
                    <div class="absolute bottom-full mb-2 left-0 opacity-0 group-hover:opacity-100 transition-all pointer-events-none z-10">
                        <div class="bg-white border border-slate-200 shadow-xl rounded-lg p-2 max-w-xs text-[11px] text-slate-600">
                            <p class="font-mono text-[10px] leading-relaxed text-rose-500 bg-rose-50 p-1 rounded break-all">${toolcall.result || ''}</p>
                        </div>
                    </div>
                </div>
            </div>`;
        }

        return `<div class="od-inline-toolcall-container">
            <div class="flex items-center gap-1.5 min-w-0">
                ${toolIcon}
                <span class="shrink-0 text-xs">${displayName}</span>
                ${statusIcon}
            </div>
        </div>`;
    }

    /**
     * 自定义的 TUI 工具调用渲染
     */
    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 执行中…'));
        } else if (toolcall.status === 'success') {
            body.push(chalk.dim('  ✓ 执行成功'));
            if (toolcall.result) {
                const truncated = truncText(toolcall.result, width - 20);
                body.push(chalk.dim('  ') + chalk.gray(truncated));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '🔌',
            title: `${this.serverName} · ${this.originalToolName}`,
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}
