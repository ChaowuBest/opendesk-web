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

// ========== browserNavigate ==========

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

        await this.browserApp.emitBrowserEvent('navigate', taskId, args.url);

        return JSON.stringify({ success: true, url: args.url, taskId });
    }
}

// ========== browserGetState ==========

const BrowserGetStateArgsSchema = z.object({});

export class BrowserGetStateTool extends BaseTool<typeof BrowserGetStateArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserGetState',
            '获取当前页面状态，包括 URL、标题、滚动位置，以及页面上所有可交互元素的索引列表（用于 browserClick / browserInput）',
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
                if (result.url) {
                    body.push(chalk.dim('  URL: ') + chalk.cyan(truncText(String(result.url), width - 16)));
                }
                if (result.title) {
                    body.push(chalk.dim('  标题: ') + chalk.white(truncText(String(result.title), width - 16)));
                }
                const elCount = result.elements?.length ?? 0;
                body.push(chalk.dim('  可交互元素: ') + chalk.green(String(elCount) + ' 个'));
            } catch {
                body.push(chalk.dim('  ✓ 已获取状态'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '📊',
            title: '页面状态',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        _args: z.output<typeof BrowserGetStateArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        try {
            const data = await this.browserApp.runOnActiveWebview(taskId, GET_STATE_SCRIPT);
            return typeof data === 'string' ? data : JSON.stringify(data);
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

const GET_STATE_SCRIPT = `(() => {
    var SEL = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick], [tabindex]:not([tabindex="-1"])';
    var els = [];
    var idx = 0;
    var allEls = document.querySelectorAll(SEL);
    for (var k = 0; k < allEls.length; k++) {
        var el = allEls[k];
        var rect = el.getBoundingClientRect();
        var style = getComputedStyle(el);
        if (rect.width === 0 && rect.height === 0) continue;
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        el.setAttribute('data-oi', String(idx));
        els.push({
            i: idx,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || '',
            text: (el.innerText || el.textContent || '').trim().slice(0, 200),
            placeholder: el.getAttribute('placeholder') || '',
            value: ('value' in el) ? String(el.value).slice(0, 200) : '',
            href: el.getAttribute('href') || '',
            aria: el.getAttribute('aria-label') || '',
        });
        idx++;
    }
    return JSON.stringify({
        url: location.href,
        title: document.title,
        scroll: { x: scrollX, y: scrollY, height: document.documentElement.scrollHeight, vh: innerHeight },
        elements: els
    });
})()`;

// ========== browserExecuteScript ==========

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

        try {
            const data = await this.browserApp.runOnActiveWebview(taskId, args.script);
            return JSON.stringify({ success: true, result: data });
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserGoBack ==========

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
        await this.browserApp.emitBrowserEvent('goBack', taskId);
        return JSON.stringify({ success: true, taskId });
    }
}

// ========== browserGoForward ==========

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
        await this.browserApp.emitBrowserEvent('goForward', taskId);
        return JSON.stringify({ success: true, taskId });
    }
}

// ========== browserRefresh ==========

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
        await this.browserApp.emitBrowserEvent('refresh', taskId);
        return JSON.stringify({ success: true, taskId });
    }
}

// ========== browserClick ==========

const BrowserClickArgsSchema = z.object({
    index: z.number().int().min(0).describe('要点击的元素索引，通过 browserGetState 获取')
});

export class BrowserClickTool extends BaseTool<typeof BrowserClickArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserClick',
            '点击页面上指定索引的可交互元素（索引通过 browserGetState 获取）',
            BrowserClickArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.index !== undefined) {
            body.push(chalk.dim('  元素索引: ') + chalk.yellow(String(args.index)));
        }
        if (toolcall.status === 'running') body.push(chalk.dim('  ⏳ 正在点击…'));
        else if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已点击'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '👆', title: '点击元素', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(args: z.output<typeof BrowserClickArgsSchema>, taskState?: TaskState): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        const script = `(() => {
            var el = document.querySelector('[data-oi="${args.index}"]');
            if (!el) return JSON.stringify({ success: false, error: 'Element with index ${args.index} not found. Call browserGetState first to refresh element indices.' });
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            el.click();
            return JSON.stringify({ success: true, tag: el.tagName.toLowerCase(), text: (el.innerText||'').trim().slice(0, 100) });
        })()`;

        try {
            const raw = await this.browserApp.runOnActiveWebview(taskId, script);
            return typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserInput ==========

const BrowserInputArgsSchema = z.object({
    index: z.number().int().min(0).describe('要输入文本的元素索引，通过 browserGetState 获取'),
    text: z.string().describe('要输入的文本内容'),
    clearFirst: z.boolean().default(true).describe('是否先清空已有内容，默认 true')
});

export class BrowserInputTool extends BaseTool<typeof BrowserInputArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserInput',
            '在页面上指定索引的输入框中填写文本（索引通过 browserGetState 获取）',
            BrowserInputArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.index !== undefined) body.push(chalk.dim('  元素索引: ') + chalk.yellow(String(args.index)));
        if (args?.text) body.push(chalk.dim('  文本: ') + chalk.cyan(truncText(String(args.text), width - 14)));
        if (toolcall.status === 'running') body.push(chalk.dim('  ⏳ 正在输入…'));
        else if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已输入'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '⌨️', title: '输入文本', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(args: z.output<typeof BrowserInputArgsSchema>, taskState?: TaskState): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        const textEscaped = JSON.stringify(args.text);
        const script = `(() => {
            var el = document.querySelector('[data-oi="${args.index}"]');
            if (!el) return JSON.stringify({ success: false, error: 'Element with index ${args.index} not found. Call browserGetState first.' });
            el.focus();
            ${args.clearFirst ? "el.value = '';" : ''}
            el.value = ${textEscaped};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return JSON.stringify({ success: true });
        })()`;

        try {
            const raw = await this.browserApp.runOnActiveWebview(taskId, script);
            return typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserScroll ==========

const BrowserScrollArgsSchema = z.object({
    direction: z.enum(['up', 'down']).describe('滚动方向：up 向上 / down 向下'),
    amount: z.number().int().default(500).describe('滚动距离（像素），默认 500')
});

export class BrowserScrollTool extends BaseTool<typeof BrowserScrollArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserScroll', '滚动当前浏览器页面', BrowserScrollArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.direction)
            body.push(chalk.dim('  方向: ') + chalk.yellow(args.direction === 'up' ? '↑ 向上' : '↓ 向下'));
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已滚动'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '📜', title: '滚动页面', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserScrollArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        const dy = args.direction === 'up' ? -args.amount : args.amount;
        const script = `(() => {
            window.scrollBy(0, ${dy});
            return JSON.stringify({
                success: true,
                scrollY: window.scrollY,
                scrollHeight: document.documentElement.scrollHeight,
                viewportHeight: window.innerHeight
            });
        })()`;

        try {
            const raw = await this.browserApp.runOnActiveWebview(taskId, script);
            return typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserExtractContent ==========

const BrowserExtractContentArgsSchema = z.object({
    maxLength: z.number().int().default(30000).describe('提取文本的最大字符数，默认 30000')
});

export class BrowserExtractContentTool extends BaseTool<typeof BrowserExtractContentArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserExtractContent',
            '提取当前页面的文本内容（标题、正文、链接等结构化信息）',
            BrowserExtractContentArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'running') body.push(chalk.dim('  ⏳ 正在提取内容…'));
        else if (toolcall.status === 'success') {
            try {
                const r = JSON.parse(toolcall.result || '{}');
                body.push(chalk.dim('  标题: ') + chalk.cyan(truncText(String(r.title || ''), width - 14)));
                const textLen = r.text?.length ?? 0;
                body.push(chalk.dim('  文本长度: ') + chalk.green(String(textLen) + ' 字符'));
            } catch {
                body.push(chalk.dim('  ✓ 已提取'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }
        return new Card({ icon: '📄', title: '提取内容', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserExtractContentArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        const script = `(() => {
            var maxLen = ${args.maxLength};
            var links = [];
            var allLinks = document.querySelectorAll('a[href]');
            for (var i = 0; i < Math.min(allLinks.length, 50); i++) {
                var a = allLinks[i];
                var t = (a.innerText || '').trim();
                if (t) links.push({ text: t.slice(0, 100), href: a.href });
            }
            return JSON.stringify({
                title: document.title,
                url: location.href,
                text: (document.body.innerText || '').slice(0, maxLen),
                links: links
            });
        })()`;

        try {
            const raw = await this.browserApp.runOnActiveWebview(taskId, script);
            return typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserListTabs ==========

const BrowserListTabsArgsSchema = z.object({});

export class BrowserListTabsTool extends BaseTool<typeof BrowserListTabsArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserListTabs', '列出当前任务浏览器中所有打开的标签页', BrowserListTabsArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const r = JSON.parse(toolcall.result);
                const tabs = r.tabs || [];
                body.push(chalk.dim('  标签页数: ') + chalk.green(String(tabs.length)));
                for (const t of tabs.slice(0, 5)) {
                    const mark = t.active ? chalk.green('▸ ') : '  ';
                    body.push(mark + chalk.dim(`[${t.id}] `) + chalk.cyan(truncText(t.title || t.url, width - 20)));
                }
            } catch {
                body.push(chalk.dim('  ✓ 已获取'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }
        return new Card({ icon: '📑', title: '标签页列表', status: statusDisplay(toolcall.status), body }).render(
            width
        );
    }

    private async handleExecute(
        _args: z.output<typeof BrowserListTabsArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        try {
            const tabs = await this.browserApp.callRendererBrowser(taskId, 'browserListTabs');
            return JSON.stringify({ success: true, tabs });
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserSwitchTab ==========

const BrowserSwitchTabArgsSchema = z.object({
    tabId: z.number().int().describe('要切换到的标签页 ID，通过 browserListTabs 获取')
});

export class BrowserSwitchTabTool extends BaseTool<typeof BrowserSwitchTabArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserSwitchTab', '切换到指定的浏览器标签页', BrowserSwitchTabArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.tabId !== undefined) body.push(chalk.dim('  标签页 ID: ') + chalk.yellow(String(args.tabId)));
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已切换'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '🔀', title: '切换标签页', status: statusDisplay(toolcall.status), body }).render(
            width
        );
    }

    private async handleExecute(
        args: z.output<typeof BrowserSwitchTabArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        try {
            await this.browserApp.callRendererBrowser(taskId, 'browserSwitchTab', args.tabId);
            return JSON.stringify({ success: true, tabId: args.tabId });
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserCloseTab ==========

const BrowserCloseTabArgsSchema = z.object({
    tabId: z.number().int().describe('要关闭的标签页 ID，通过 browserListTabs 获取')
});

export class BrowserCloseTabTool extends BaseTool<typeof BrowserCloseTabArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserCloseTab', '关闭指定的浏览器标签页', BrowserCloseTabArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.tabId !== undefined) body.push(chalk.dim('  标签页 ID: ') + chalk.yellow(String(args.tabId)));
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已关闭'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '❌', title: '关闭标签页', status: statusDisplay(toolcall.status), body }).render(
            width
        );
    }

    private async handleExecute(
        args: z.output<typeof BrowserCloseTabArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        try {
            await this.browserApp.callRendererBrowser(taskId, 'browserCloseTab', args.tabId);
            return JSON.stringify({ success: true, tabId: args.tabId });
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}
