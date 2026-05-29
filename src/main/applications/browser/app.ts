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
import fs from 'node:fs/promises';
import {
    BrowserNavigateTool,
    BrowserSnapshotTool,
    BrowserClickTool,
    BrowserTypeTool,
    BrowserHoverTool,
    BrowserPressKeyTool,
    BrowserSelectOptionTool,
    BrowserScrollToTool,
    BrowserGoBackTool,
    BrowserGoForwardTool,
    BrowserReloadTool,
    BrowserEvaluateTool,
    BrowserTabsTool,
    BrowserWaitForTool,
    BrowserDropHistoryTool
} from './tools';
import { BROWSER_SKILL, MANAGE_BROWSER_SKILL } from './skills';
import {
    BrowserManager,
    CDPSessionManager,
    captureSnapshot,
    makeCallBrowserScript,
    makeExecuteScriptOnBrowser
} from '../../../common/embedBrowserUse/main';
import type { CDPSession } from '../../../common/embedBrowserUse/main';
import type { PageSnapshot } from '../../../common/embedBrowserUse/protocol';
import { makeEnsureSidebarScript, openDeskScriptGenerators } from './utils.js';
import chalk from 'chalk';

// Re-export script generators so existing consumers (main.ts) can still import from here
export { makeEnsureSidebarScript, makeCallBrowserScript, makeExecuteScriptOnBrowser };

class BrowserApplication extends BaseApplication {
    private _snapshotSessionManager = new CDPSessionManager();

    constructor() {
        super('browser', '浏览器');
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
        toolset.addTool(new BrowserSnapshotTool(this));
        toolset.addTool(new BrowserClickTool(this));
        toolset.addTool(new BrowserTypeTool(this));
        toolset.addTool(new BrowserHoverTool(this));
        toolset.addTool(new BrowserPressKeyTool(this));
        toolset.addTool(new BrowserSelectOptionTool(this));
        toolset.addTool(new BrowserScrollToTool(this));
        toolset.addTool(new BrowserGoBackTool(this));
        toolset.addTool(new BrowserGoForwardTool(this));
        toolset.addTool(new BrowserReloadTool(this));
        toolset.addTool(new BrowserEvaluateTool(this));
        toolset.addTool(new BrowserTabsTool(this));
        toolset.addTool(new BrowserWaitForTool(this));
        skill.toolsets = [toolset];

        const manageSkill = Skill.parseMd(MANAGE_BROWSER_SKILL);
        const manageToolset = new BaseToolset('browser-manage');
        manageToolset.addTool(new BrowserDropHistoryTool());
        manageSkill.toolsets = [manageToolset];

        return [skill, manageSkill];
    }

    // ---- CDP session access (delegated to BrowserManager) ----

    /**
     * Obtain a CDP session for the current task's active webview.
     * Delegates to BrowserController via BrowserManager.
     */
    async getCDPSession(taskId: string): Promise<CDPSession | null> {
        try {
            const ctrl = BrowserManager.getOrCreateController(taskId);
            return await ctrl.getCDPSession();
        } catch (err: any) {
            logger.warn(`Failed to get CDP session: ${err.message || err}`);
            return null;
        }
    }

    // ---- Renderer bridge methods (delegated to BrowserController) ----

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
     * 如果 task-view 尚不存在（后台定时任务等场景），先创建一个隐藏的 task-view，
     * 并直接初始化浏览器（跳过侧边栏动画和全局状态修改）。
     */
    private _makeEnsureSidebarScript(taskId: string): string {
        return makeEnsureSidebarScript(taskId);
    }

    /**
     * Ensure browser sidebar is open and browser tab is active for the given task,
     * then execute a script in the active webview and return the result.
     *
     * @param timeoutMs 超时时间（毫秒），默认 12 秒。防止 webview.executeJavaScript 在页面加载期间无限挂起。
     */
    async runOnActiveWebview(taskId: string, script: string, timeoutMs: number = 12000): Promise<any> {
        // Ensure UI is ready before executing — external callers may bypass callRendererBrowser
        const mainWin = await this._getMainWindow();
        if (mainWin) {
            await mainWin.webContents.executeJavaScript(`(() => { ${makeEnsureSidebarScript(taskId)} })()`);
        }
        const ctrl = BrowserManager.getOrCreateController(taskId);
        return ctrl.runOnActiveWebview(script, timeoutMs);
    }

    /**
     * Call a synchronous method on the task's <task-artifacts> element.
     * Also ensures browser sidebar is open.
     */
    async callRendererBrowser(taskId: string, method: string, ...args: any[]): Promise<any> {
        const ctrl = BrowserManager.getOrCreateController(taskId);
        return ctrl.callRendererBrowser(method, ...args);
    }

    /**
     * Ensure sidebar is expanded and browser tab is active, then emit an event.
     * Used for fire-and-forget operations (navigate, goBack, etc.)
     */
    async emitBrowserEvent(eventName: string, taskId: string, ...args: any[]): Promise<void> {
        const mainWin = await this._getMainWindow();
        if (mainWin) {
            await mainWin.webContents.executeJavaScript(`(() => { ${this._makeEnsureSidebarScript(taskId)} })()`);
        }
        this.emitEvent(eventName, taskId, ...args);
    }

    /**
     * Capture an ARIA snapshot for the given webContents id.
     * Used by browser renderer UI (tool menu debug action).
     */
    async captureSnapshotByWebContentsId(webContentsId: number): Promise<PageSnapshot> {
        if (!Number.isInteger(webContentsId) || webContentsId <= 0) {
            throw new Error('Invalid webContentsId');
        }
        const session = await this._snapshotSessionManager.getSession(webContentsId);
        return captureSnapshot(session);
    }

    /**
     * Capture snapshot and export it to a text file via native save dialog.
     */
    async exportSnapshotByWebContentsId(
        webContentsId: number
    ): Promise<{ canceled: boolean; filePath: string | null }> {
        const snapshot = await this.captureSnapshotByWebContentsId(webContentsId);
        const lines: string[] = [];
        lines.push(`- Page URL: ${snapshot.url}`);
        if (snapshot.title) lines.push(`- Page Title: ${snapshot.title}`);
        lines.push(`- Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height}`);
        if (snapshot.scroll.x || snapshot.scroll.y) lines.push(`- Scroll: ${snapshot.scroll.x},${snapshot.scroll.y}`);
        lines.push('');
        lines.push('[Accessibility Snapshot]');
        lines.push(snapshot.ariaSnapshot);
        const content = lines.join('\n');

        const { BrowserWindow, dialog } = await import('electron');
        const win =
            BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dialogOptions = {
            title: '保存 Snapshot',
            defaultPath: `snapshot-${timestamp}.txt`,
            filters: [
                { name: 'Text Files', extensions: ['txt'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        };
        const saveResult = win
            ? await dialog.showSaveDialog(win, dialogOptions)
            : await dialog.showSaveDialog(dialogOptions);

        if (saveResult.canceled || !saveResult.filePath) {
            return { canceled: true, filePath: null };
        }

        await fs.writeFile(saveResult.filePath, content, 'utf8');
        return { canceled: false, filePath: saveResult.filePath };
    }
}

export { BrowserApplication };
