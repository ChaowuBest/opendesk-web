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
import { t } from './locale/index.js';

/**
 * MCP 工具类，继承自 BaseTool，提供专门的渲染逻辑
 */
export class MCPTool<T extends z.ZodType> extends BaseTool<T> {
    private serverName: string;
    private originalToolName: string;

    constructor(
        serverName: string,
        toolName: string,
        description: string,
        params: T,
        agentIds?: readonly string[],
        toolNamespace = serverName
    ) {
        // 工具名格式：serverName__toolName（去掉 mcpmgr 前缀）
        const safeName = `${toolNamespace.replace(/[^a-zA-Z0-9_]/g, '_')}__${toolName}`;
        super(safeName, `[MCP: ${serverName}] ${description}`, params);

        this.serverName = serverName;
        this.originalToolName = toolName;
        this.agentIds = agentIds;
    }

    /**
     * 自定义的 GUI 工具调用渲染
     */
    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const statusIcon =
            toolcall.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : '';

        // MCP 工具专用渲染：图标 + serverName · toolName
        const toolIcon = '<i class="fas fa-plug shrink-0 text-blue-400 text-xs"></i>';
        const displayName = `<span class="text-slate-600 font-medium">${this.serverName}</span><span class="text-slate-300 mx-0.5">·</span><span class="text-slate-500">${this.originalToolName}</span>`;

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
            body.push(chalk.dim(`  ⏳ ${t('cli.tool.running')}`));
        } else if (toolcall.status === 'success') {
            body.push(chalk.dim(`  ✓ ${t('cli.tool.success')}`));
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
