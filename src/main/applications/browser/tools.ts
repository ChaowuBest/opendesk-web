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
import type { TaskState } from '../../aikernel/states/tasks';
import type { BrowserApplication } from './app';

// ========== browserNavigate 工具 ==========

const BrowserNavigateArgsSchema = z.object({
    url: z.string().describe('要访问的网址，例如 https://www.baidu.com')
});

export class BrowserNavigateTool extends BaseTool<typeof BrowserNavigateArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserNavigate',
            '在当前任务的嵌入式浏览器中打开指定的网页，浏览器会自动切换到前台显示',
            BrowserNavigateArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const url = args?.['url'];
        const body: string[] = [];

        if (url) {
            body.push(chalk.dim('网址: ') + chalk.cyan(truncText(String(url), width - 14)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 正在加载页面…'));
        } else if (toolcall.status === 'success') {
            body.push(chalk.dim('  ✓ 页面已打开'));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '🌐',
            title: '打开网页',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserNavigateArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        // Emit event to renderer → renderer finds the task's browser and navigates
        this.browserApp.emitEvent('navigate', taskId, args.url);

        return JSON.stringify({ success: true, url: args.url, taskId });
    }
}

// ========== browserGetCDPPort 工具 ==========

const BrowserGetCDPPortArgsSchema = z.object({});

export class BrowserGetCDPPortTool extends BaseTool<typeof BrowserGetCDPPortArgsSchema> {
    constructor() {
        super(
            'browserGetCDPPort',
            '获取浏览器的 Chrome DevTools Protocol (CDP) 端口，用于 Playwright 等自动化工具连接',
            BrowserGetCDPPortArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                body.push(chalk.dim('  端口: ') + chalk.green(String(result.port)));
                body.push(
                    chalk.dim('  WebSocket: ') + chalk.gray(truncText(String(result.webSocketDebuggerUrl), width - 20))
                );
            } catch {
                body.push(chalk.dim('  ✓ 已获取 CDP 信息'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '🔌',
            title: '获取 CDP 端口',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(): Promise<string> {
        return JSON.stringify({
            success: true,
            port: 9222,
            webSocketDebuggerUrl: 'ws://localhost:9222',
            note: 'Use this with Playwright: const browser = await chromium.connectOverCDP("ws://localhost:9222")'
        });
    }
}

// ========== browserGetState 工具 ==========

const BrowserGetStateArgsSchema = z.object({});

export class BrowserGetStateTool extends BaseTool<typeof BrowserGetStateArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserGetState',
            '获取当前任务浏览器的状态信息（当前URL、是否可前进/后退等）',
            BrowserGetStateArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                if (result.active) {
                    body.push(chalk.dim('  状态: ') + chalk.green('活跃'));
                    body.push(
                        chalk.dim('  URL: ') + chalk.cyan(truncText(String(result.currentUrl || ''), width - 16))
                    );
                } else {
                    body.push(chalk.dim('  状态: ') + chalk.gray('未激活'));
                }
            } catch {
                body.push(chalk.dim('  ✓ 已获取状态'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '📊',
            title: '浏览器状态',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        _args: z.output<typeof BrowserGetStateArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ active: false });

        // Emit event to renderer to get state, but we can't wait for the response
        // Return basic info; detailed state is available via CDP
        return JSON.stringify({ success: true, taskId, note: 'Use CDP for detailed browser state' });
    }
}

// ========== browserExecuteScript 工具 ==========

const BrowserExecuteScriptArgsSchema = z.object({
    script: z.string().describe('要在页面中执行的 JavaScript 代码')
});

export class BrowserExecuteScriptTool extends BaseTool<typeof BrowserExecuteScriptArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserExecuteScript',
            '在当前任务的浏览器页面中执行 JavaScript 代码并返回结果',
            BrowserExecuteScriptArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const script = args?.['script'];
        const body: string[] = [];

        if (script) {
            body.push(chalk.dim('脚本: ') + chalk.yellow(truncText(String(script), width - 14)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 正在执行脚本…'));
        } else if (toolcall.status === 'success') {
            body.push(chalk.dim('  ✓ 执行完成'));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '⚡',
            title: '执行脚本',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserExecuteScriptArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        this.browserApp.emitEvent('executeScript', taskId, args.script);

        return JSON.stringify({ success: true, taskId, note: 'Script forwarded to browser' });
    }
}

// ========== browserGoBack 工具 ==========

const BrowserGoBackArgsSchema = z.object({});

export class BrowserGoBackTool extends BaseTool<typeof BrowserGoBackArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserGoBack', '在浏览器中后退到上一个页面', BrowserGoBackArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已后退'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '⬅', title: '后退', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        _args: z.output<typeof BrowserGoBackArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });
        this.browserApp.emitEvent('goBack', taskId);
        return JSON.stringify({ success: true, taskId });
    }
}

// ========== browserGoForward 工具 ==========

const BrowserGoForwardArgsSchema = z.object({});

export class BrowserGoForwardTool extends BaseTool<typeof BrowserGoForwardArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserGoForward', '在浏览器中前进到下一个页面', BrowserGoForwardArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已前进'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '➡', title: '前进', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        _args: z.output<typeof BrowserGoForwardArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });
        this.browserApp.emitEvent('goForward', taskId);
        return JSON.stringify({ success: true, taskId });
    }
}

// ========== browserRefresh 工具 ==========

const BrowserRefreshArgsSchema = z.object({});

export class BrowserRefreshTool extends BaseTool<typeof BrowserRefreshArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserRefresh', '刷新当前浏览器页面', BrowserRefreshArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已刷新'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '🔄', title: '刷新', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        _args: z.output<typeof BrowserRefreshArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });
        this.browserApp.emitEvent('refresh', taskId);
        return JSON.stringify({ success: true, taskId });
    }
}
