/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You may use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { BaseApplication } from '../base';
import { BaseToolset } from '../../aikernel/tool';
import { Skill } from '../../aikernel/skill.js';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import {
    BrowserNavigateTool,
    BrowserGetStateTool,
    BrowserExecuteScriptTool,
    BrowserGoBackTool,
    BrowserGoForwardTool,
    BrowserRefreshTool,
    BrowserClickTool,
    BrowserInputTool,
    BrowserScrollTool,
    BrowserExtractContentTool,
    BrowserGetHtmlTool,
    BrowserListTabsTool,
    BrowserSwitchTabTool,
    BrowserCloseTabTool
} from './tools';
import { BROWSER_SKILL } from './skills';
import chalk from 'chalk';

class BrowserApplication extends BaseApplication {
    constructor() {
        super('browser', '浏览器', false);
    }

    async getTUIStatusBlock() {
        try {
            return `🌐 ${chalk.cyan('浏览器就绪')}`;
        } catch {
            return null;
        }
    }

    static getConfigSchema() {
        return z.object({
            defaultHomepage: z.string().default('about:blank').describe('浏览器默认主页')
        });
    }

    getCliSlashCommands(tui: any) {
        return [
            {
                name: 'browser',
                description: '显示浏览器信息',
                execute: async () => {
                    try {
                        tui.log('');
                        tui.log(chalk.cyan.bold('🌐 嵌入式浏览器'));
                        tui.log(chalk.dim('──────────────────────────────'));
                        tui.log('• 浏览器标签位于右侧栏 "浏览器" 选项');
                        tui.log('• 使用 browser 系列工具进行自动化控制');
                        tui.log('');
                    } catch (err) {
                        logger.error(`浏览器命令执行失败: ${err}`);
                    }
                }
            }
        ];
    }

    async getSupportedEvents() {
        return [
            { eventName: 'navigate', eventDescription: '浏览器导航到指定URL' },
            { eventName: 'goBack', eventDescription: '浏览器后退' },
            { eventName: 'goForward', eventDescription: '浏览器前进' },
            { eventName: 'refresh', eventDescription: '浏览器刷新' },
            { eventName: 'executeScript', eventDescription: '在浏览器中执行JavaScript' }
        ];
    }

    async getSkills() {
        const skill = Skill.parseMd(BROWSER_SKILL);
        const toolset = new BaseToolset('browser');
        toolset.addTool(new BrowserNavigateTool(this));
        toolset.addTool(new BrowserGetStateTool(this));
        toolset.addTool(new BrowserClickTool(this));
        toolset.addTool(new BrowserInputTool(this));
        toolset.addTool(new BrowserScrollTool(this));
        toolset.addTool(new BrowserGoBackTool(this));
        toolset.addTool(new BrowserGoForwardTool(this));
        toolset.addTool(new BrowserRefreshTool(this));
        toolset.addTool(new BrowserExtractContentTool(this));
        toolset.addTool(new BrowserGetHtmlTool(this));
        toolset.addTool(new BrowserExecuteScriptTool(this));
        toolset.addTool(new BrowserListTabsTool(this));
        toolset.addTool(new BrowserSwitchTabTool(this));
        toolset.addTool(new BrowserCloseTabTool(this));
        skill.toolsets = [toolset];
        return [skill];
    }

    // ---- Renderer bridge methods ----
    // All methods use globalMainWindow.webContents.executeJavaScript to call
    // <task-artifacts> methods in the renderer. This is the same pattern used
    // by the IPC handlers in main.js.

    private async _getMainWindow(): Promise<any> {
        try {
            const { BrowserWindow } = await import('electron');
            const wins = BrowserWindow.getAllWindows();
            return wins.find((w: any) => !w.isDestroyed()) ?? null;
        } catch {
            return null;
        }
    }

    /**
     * JS snippet injected into the renderer to expand the sidebar and activate the browser tab.
     * Finds the parent task-view by walking up from the task-artifacts element.
     */
    private _makeEnsureSidebarScript(taskId: string): string {
        const safeId = taskId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `
            var el = document.getElementById('task-${safeId}-artifacts');
            if (el) {
                var tv = el.closest('task-view');
                if (tv && typeof tv._ensureRightSidebarOpen === 'function') tv._ensureRightSidebarOpen();
                if (typeof el.ensureBrowserReady === 'function') el.ensureBrowserReady();
            }
        `;
    }

    /**
     * Ensure browser sidebar is open and browser tab is active for the given task,
     * then execute a script in the active webview and return the result.
     *
     * @param timeoutMs 超时时间（毫秒），默认 12 秒。防止 webview.executeJavaScript 在页面加载期间无限挂起。
     */
    async runOnActiveWebview(taskId: string, script: string, timeoutMs: number = 12000): Promise<any> {
        const mainWin = await this._getMainWindow();
        if (!mainWin) throw new Error('No main window available');

        const safeId = taskId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const escapedScript = JSON.stringify(script);

        const jsPromise = mainWin.webContents.executeJavaScript(`
            (async () => {
                try {
                    ${this._makeEnsureSidebarScript(taskId)}
                    var el = document.getElementById('task-${safeId}-artifacts');
                    if (!el) return { __e: 'Task artifacts element not found' };
                    if (typeof el.browserExecuteScript !== 'function') return { __e: 'Browser not initialized' };
                    var r = await el.browserExecuteScript(${escapedScript});
                    return { __d: r };
                } catch (e) {
                    return { __e: (e && e.message) || String(e) };
                }
            })()
        `);

        const result = await Promise.race([
            jsPromise,
            new Promise<{ __e: string }>((_, reject) =>
                setTimeout(() => reject(new Error(`webview script timed out after ${timeoutMs}ms`)), timeoutMs)
            )
        ]);

        if (result?.__e) throw new Error(result.__e);
        return result?.__d;
    }

    /**
     * Call a synchronous method on the task's <task-artifacts> element.
     * Also ensures browser sidebar is open.
     */
    async callRendererBrowser(taskId: string, method: string, ...args: any[]): Promise<any> {
        const mainWin = await this._getMainWindow();
        if (!mainWin) throw new Error('No main window available');

        const safeId = taskId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const safeMethod = method.replace(/[^a-zA-Z0-9_]/g, '');
        const argsStr = args.map((a) => JSON.stringify(a)).join(',');

        const result = await mainWin.webContents.executeJavaScript(`
            (() => {
                try {
                    ${this._makeEnsureSidebarScript(taskId)}
                    var el = document.getElementById('task-${safeId}-artifacts');
                    if (!el) return { __e: 'Task artifacts element not found' };
                    if (typeof el.${safeMethod} !== 'function') return { __e: 'Method ${safeMethod} not available' };
                    var r = el.${safeMethod}(${argsStr});
                    return { __d: r };
                } catch (e) {
                    return { __e: (e && e.message) || String(e) };
                }
            })()
        `);

        if (result?.__e) throw new Error(result.__e);
        return result?.__d;
    }

    /**
     * Ensure sidebar is expanded and browser tab is active, then emit an event.
     * Used for fire-and-forget operations (navigate, goBack, etc.)
     */
    async emitBrowserEvent(eventName: string, taskId: string, ...args: any[]): Promise<void> {
        const mainWin = await this._getMainWindow();
        if (mainWin) {
            await mainWin.webContents.executeJavaScript(`
                (() => { ${this._makeEnsureSidebarScript(taskId)} })()
            `);
        }
        this.emitEvent(eventName, taskId, ...args);
    }
}

export { BrowserApplication };
