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
import { t } from './locale/index.js';
import { BaseTool, BaseToolset } from '../../aikernel/tool';
import { Skill } from '../../aikernel/skill.js';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { safeSendToWebContents } from '../../utils/electron-ipc.js';
import { Setting } from '../../utils/setting.js';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
    BrowserNavigateTool,
    BrowserSnapshotTool,
    BrowserExploreTool,
    BrowserClickTool,
    BrowserTypeTool,
    BrowserUploadFileTool,
    BrowserHoverTool,
    BrowserPressKeyTool,
    BrowserSelectOptionTool,
    BrowserScrollToTool,
    BrowserGoBackTool,
    BrowserGoForwardTool,
    BrowserReloadTool,
    BrowserEvaluateTool,
    BrowserTriggerTool,
    BrowserTabsTool,
    BrowserScreenshotTool,
    BrowserWaitForTool,
    BrowserDropHistoryTool
} from './tools';
import { BROWSER_SKILL, MANAGE_BROWSER_SKILL } from './skills';
import { collectBrowserHintSummaries } from './hints.js';
import type { BrowserHintSummary } from './hints.js';
import {
    BrowserManager,
    CDPSessionManager,
    captureSnapshot,
    collectSnapshotPrefix,
    makeCallBrowserScript,
    makeExecuteScriptOnBrowser,
    renderSnapshotText
} from '../../../common/embedBrowserUse/main';
import type { CDPSession, BrowserPageEvaluator } from '../../../common/embedBrowserUse/main';
import type { PageSnapshot } from '../../../common/embedBrowserUse/protocol';
import { Channels as EmbedBrowserChannels } from '../../../common/embedBrowserUse/protocol';
import { makeEnsureSidebarScript, openDeskScriptGenerators } from './utils.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/** 惰性加载 electron 模块，避免在非 Electron 平台（如 HarmonyOS）启动时报错 */
let _electronApp: Electron.App | undefined;
let _electronDialog: Electron.Dialog | undefined;
let _electronShell: Electron.Shell | undefined;
let _electronWebContents: any;

function getElectronApp(): Electron.App {
    if (!_electronApp) {
        try {
            _electronApp = require('electron').app;
        } catch {
            _electronApp = undefined as any;
        }
    }
    if (!_electronApp) throw new Error('electron.app is not available on this platform');
    return _electronApp;
}

function getElectronDialog(): Electron.Dialog {
    if (!_electronDialog) {
        try {
            _electronDialog = require('electron').dialog;
        } catch {
            _electronDialog = undefined as any;
        }
    }
    if (!_electronDialog) throw new Error('electron.dialog is not available on this platform');
    return _electronDialog;
}

function getElectronShell(): Electron.Shell {
    if (!_electronShell) {
        try {
            _electronShell = require('electron').shell;
        } catch {
            _electronShell = undefined as any;
        }
    }
    if (!_electronShell) throw new Error('electron.shell is not available on this platform');
    return _electronShell;
}

function getElectronWebContents(): any {
    if (!_electronWebContents) {
        try {
            _electronWebContents = require('electron').webContents;
        } catch {
            _electronWebContents = undefined as any;
        }
    }
    if (!_electronWebContents) throw new Error('electron.webContents is not available on this platform');
    return _electronWebContents;
}
import chalk from 'chalk';

// Re-export script generators so existing consumers (main.ts) can still import from here
export { makeEnsureSidebarScript, makeCallBrowserScript, makeExecuteScriptOnBrowser };

// ---- 下载管理 ----

interface DownloadState {
    id: string;
    url: string;
    filename: string;
    savePath: string;
    receivedBytes: number;
    totalBytes: number;
    state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
    startTime: number;
    endTime?: number;
}

function normalizeSaveDialogSyncPath(result: string | undefined): string | null {
    return typeof result === 'string' && result.length > 0 ? result : null;
}

function sanitizeDownloadFilename(filename: string): string {
    const sanitized = path
        .basename(filename)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .trim();
    return sanitized || 'download';
}

function makeUniqueDownloadPath(
    directory: string,
    filename: string,
    exists: (filePath: string) => boolean = fsSync.existsSync
): string {
    const safeFilename = sanitizeDownloadFilename(filename);
    const parsed = path.parse(safeFilename);
    let candidate = path.join(directory, safeFilename);
    let suffix = 1;

    while (exists(candidate)) {
        candidate = path.join(directory, `${parsed.name} (${suffix})${parsed.ext}`);
        suffix += 1;
    }

    return candidate;
}

function resolveAutomatedDownloadDirectory(workspace: string | undefined): string {
    const workspaceDir =
        workspace && workspace.trim().length > 0 ? workspace : Setting.getInstance().getEffectiveWorkspace();
    return path.join(workspaceDir, 'Downloads');
}

interface AutomatedDownloadScope {
    id: symbol;
    taskId: string;
    directory: string;
    downloads: DownloadState[];
    active: boolean;
}

interface AutomatedDownloadWebContents {
    taskId: string | null;
    directory: string;
    scope: AutomatedDownloadScope | null;
    cleanup: () => void;
}

const AUTOMATED_DOWNLOAD_WEB_CONTENTS_TTL_MS = 15 * 60 * 1000;

function appendAutomatedDownloadsToToolResult(result: string, downloads: DownloadState[]): string {
    if (downloads.length === 0) return result;

    try {
        const parsed = JSON.parse(result);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return result;
        }

        const existingDownloads = Array.isArray(parsed.downloads) ? parsed.downloads : [];
        return JSON.stringify({
            ...parsed,
            downloads: [...existingDownloads, ...downloads.map((download) => ({ ...download }))]
        });
    } catch {
        return result;
    }
}

class BrowserApplication extends BaseApplication {
    private _snapshotSessionManager = new CDPSessionManager();
    private _activeDownloads = new Map<string, DownloadState>();
    private _downloadStorePath: string | null = null;
    private _automatedDownloadScopes: AutomatedDownloadScope[] = [];
    private _automatedDownloadWebContents = new Map<number, AutomatedDownloadWebContents>();
    private _pendingAutomatedDownloadsByTask = new Map<string, DownloadState[]>();

    constructor() {
        super('browser');
    }

    getName(): string {
        return t('app.name');
    }

    async getTUIStatusBlock() {
        try {
            return `🌐 ${chalk.cyan('浏览器就绪')}`;
        } catch {
            return null;
        }
    }

    // =====================================================================
    //  下载管理
    // =====================================================================

    private _getDownloadStorePath(): string {
        if (this._downloadStorePath) return this._downloadStorePath;
        this._downloadStorePath = path.join(getElectronApp().getPath('userData'), 'browser_downloads.json');
        return this._downloadStorePath;
    }

    /** 从磁盘加载历史下载记录 */
    loadDownloads(): void {
        try {
            const storePath = this._getDownloadStorePath();
            if (!fsSync.existsSync(storePath)) return;
            const raw = fsSync.readFileSync(storePath, 'utf-8');
            const downloads: DownloadState[] = JSON.parse(raw);
            for (const dl of downloads) {
                if (dl.state === 'progressing') {
                    dl.state = 'interrupted';
                    dl.endTime = dl.startTime;
                }
                this._activeDownloads.set(dl.id, dl);
            }
        } catch {
            /* ignore corrupted file */
        }
    }

    /** 将下载记录持久化到磁盘 */
    private _saveDownloads(): void {
        try {
            const downloads = Array.from(this._activeDownloads.values());
            fsSync.writeFileSync(this._getDownloadStorePath(), JSON.stringify(downloads, null, 2), 'utf-8');
        } catch {
            /* best-effort */
        }
    }

    /** 向渲染进程广播下载状态更新 */
    private _broadcastDownloadUpdate(download: DownloadState): void {
        const mainWindow = BrowserManager.mainWindow;
        if (!mainWindow || mainWindow.isDestroyed()) return;
        safeSendToWebContents(mainWindow.webContents, EmbedBrowserChannels.downloadUpdate, download);
    }

    private _forgetAutomatedDownloadWebContents(webContentsId: number): void {
        const existing = this._automatedDownloadWebContents.get(webContentsId);
        if (!existing) return;
        existing.cleanup();
        this._automatedDownloadWebContents.delete(webContentsId);
    }

    private _rememberAutomatedDownloadWebContents(
        webContentsId: unknown,
        taskId: string | null,
        directory: string,
        scope: AutomatedDownloadScope | null,
        ttlMs: number = AUTOMATED_DOWNLOAD_WEB_CONTENTS_TTL_MS
    ): void {
        if (!Number.isInteger(webContentsId) || (webContentsId as number) <= 0) return;

        const id = webContentsId as number;
        this._forgetAutomatedDownloadWebContents(id);

        const timer = setTimeout(() => {
            this._forgetAutomatedDownloadWebContents(id);
        }, ttlMs);
        timer.unref?.();

        let cleanupDestroyed: (() => void) | null = null;
        try {
            const wc = getElectronWebContents().fromId(id);
            if (wc && !wc.isDestroyed?.()) {
                const onDestroyed = () => this._forgetAutomatedDownloadWebContents(id);
                wc.once('destroyed', onDestroyed);
                cleanupDestroyed = () => wc.off?.('destroyed', onDestroyed);
            }
        } catch {
            /* best-effort only */
        }

        this._automatedDownloadWebContents.set(id, {
            taskId,
            directory,
            scope,
            cleanup: () => {
                clearTimeout(timer);
                cleanupDestroyed?.();
            }
        });
    }

    private async _rememberTaskActiveWebContents(
        taskId: string,
        directory: string,
        scope: AutomatedDownloadScope | null
    ): Promise<void> {
        try {
            const ctrl = BrowserManager.getOrCreateController(taskId);
            const webContentsId = await ctrl.callRendererBrowser('browserGetWebContentsId');
            this._rememberAutomatedDownloadWebContents(webContentsId, taskId, directory, scope);
        } catch {
            /* best-effort only */
        }
    }

    private _queuePendingAutomatedDownload(taskId: string | null, download: DownloadState): void {
        if (!taskId) return;
        const pending = this._pendingAutomatedDownloadsByTask.get(taskId) ?? [];
        pending.push(download);
        this._pendingAutomatedDownloadsByTask.set(taskId, pending);
    }

    private _takePendingAutomatedDownloads(taskId: string): DownloadState[] {
        const pending = this._pendingAutomatedDownloadsByTask.get(taskId);
        if (!pending || pending.length === 0) return [];
        this._pendingAutomatedDownloadsByTask.delete(taskId);
        return pending;
    }

    async runWithAutomatedDownloadScope(
        taskId: string,
        workspace: string | undefined,
        operation: () => Promise<string>
    ): Promise<string> {
        const scope: AutomatedDownloadScope = {
            id: Symbol('automated-download-scope'),
            taskId,
            directory: resolveAutomatedDownloadDirectory(workspace),
            downloads: [],
            active: true
        };
        this._automatedDownloadScopes.push(scope);
        await this._rememberTaskActiveWebContents(taskId, scope.directory, scope);

        try {
            const result = await operation();
            scope.active = false;
            const downloads = [...this._takePendingAutomatedDownloads(taskId), ...scope.downloads];
            return appendAutomatedDownloadsToToolResult(result, downloads);
        } finally {
            scope.active = false;
            await this._rememberTaskActiveWebContents(taskId, scope.directory, null);
            const index = this._automatedDownloadScopes.findIndex((item) => item.id === scope.id);
            if (index >= 0) {
                this._automatedDownloadScopes.splice(index, 1);
            }
        }
    }

    private _getAutomatedDownloadTarget(
        webContents: Electron.WebContents
    ): { taskId: string | null; directory: string; scope: AutomatedDownloadScope | null } | null {
        const target = this._automatedDownloadWebContents.get(webContents.id);
        if (target) {
            const scope = target.scope?.active ? target.scope : null;
            return { taskId: target.taskId, directory: target.directory, scope };
        }

        if (this._automatedDownloadScopes.length === 0) return null;
        if (this._automatedDownloadScopes.length > 1) {
            return { taskId: null, directory: resolveAutomatedDownloadDirectory(undefined), scope: null };
        }
        const scope = this._automatedDownloadScopes[0];
        return { taskId: scope.taskId, directory: scope.directory, scope: scope.active ? scope : null };
    }

    private _makeAutomatedDownloadPath(downloadsDir: string, suggestedFilename: string): string {
        fsSync.mkdirSync(downloadsDir, { recursive: true });
        return makeUniqueDownloadPath(downloadsDir, suggestedFilename);
    }

    private _promptDownloadSavePath(suggestedFilename: string): string | null {
        const mainWindow = BrowserManager.mainWindow;
        const saveResult = mainWindow
            ? getElectronDialog().showSaveDialogSync(mainWindow, {
                  title: '保存文件',
                  defaultPath: suggestedFilename,
                  properties: ['createDirectory']
              })
            : getElectronDialog().showSaveDialogSync({
                  title: '保存文件',
                  defaultPath: suggestedFilename,
                  properties: ['createDirectory']
              });

        return normalizeSaveDialogSyncPath(saveResult);
    }

    private _cancelDownloadItem(item: Electron.DownloadItem): void {
        try {
            item.cancel();
        } catch {
            /* ignore */
        }
    }

    /** 处理 Electron session 的 will-download 事件 */
    handleDownload(item: Electron.DownloadItem, webContents: Electron.WebContents): void {
        try {
            this._handleDownload(item, webContents);
        } catch (err) {
            logger.error(`[browser] handleDownload failed: ${(err as Error)?.stack || (err as Error)?.message || err}`);
            this._cancelDownloadItem(item);
        }
    }

    private _handleDownload(item: Electron.DownloadItem, webContents: Electron.WebContents): void {
        const downloadId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const suggestedFilename = item.getFilename() || 'download';
        const downloadUrl = item.getURL();

        const automatedDownloadTarget = this._getAutomatedDownloadTarget(webContents);
        const savePath = automatedDownloadTarget
            ? this._makeAutomatedDownloadPath(automatedDownloadTarget.directory, suggestedFilename)
            : this._promptDownloadSavePath(suggestedFilename);
        if (!savePath) {
            this._cancelDownloadItem(item);
            return;
        }

        item.setSavePath(savePath);

        const download: DownloadState = {
            id: downloadId,
            url: downloadUrl,
            filename: path.basename(savePath),
            savePath,
            receivedBytes: 0,
            totalBytes: item.getTotalBytes() || 0,
            state: 'progressing',
            startTime: Date.now()
        };
        this._activeDownloads.set(downloadId, download);
        if (automatedDownloadTarget?.scope) {
            automatedDownloadTarget.scope.downloads.push(download);
        } else {
            this._queuePendingAutomatedDownload(automatedDownloadTarget?.taskId ?? null, download);
        }
        this._broadcastDownloadUpdate(download);

        item.on('updated', (_event, state) => {
            try {
                if (state === 'progressing') {
                    download.receivedBytes = item.getReceivedBytes();
                    download.totalBytes = item.getTotalBytes() || download.totalBytes;
                    this._broadcastDownloadUpdate(download);
                }
            } catch (err) {
                logger.warn(`[browser] download update failed: ${(err as Error)?.message || err}`);
            }
        });

        item.once('done', (_event, state) => {
            try {
                download.state =
                    state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
                download.endTime = Date.now();
                download.receivedBytes = item.getReceivedBytes();
                download.totalBytes = item.getTotalBytes() || download.totalBytes;
                this._broadcastDownloadUpdate(download);
                this._saveDownloads();
            } catch (err) {
                logger.warn(`[browser] download completion failed: ${(err as Error)?.message || err}`);
            }
        });
    }

    /** 注册下载相关的 IPC 处理器 */
    registerDownloadIPC(ipcMain: Electron.IpcMain): void {
        ipcMain.handle('browser:getDownloads', () => {
            return { status: 'ok', data: Array.from(this._activeDownloads.values()) };
        });

        ipcMain.handle('browser:cancelDownload', (_event, downloadId: string) => {
            const dl = this._activeDownloads.get(downloadId);
            if (dl) {
                dl.state = 'cancelled';
                dl.endTime = Date.now();
                this._broadcastDownloadUpdate(dl);
                this._saveDownloads();
                return { status: 'ok' };
            }
            return { status: 'error', message: 'Download not found' };
        });

        ipcMain.handle('browser:openDownloadFile', async (_event, downloadId: string) => {
            const dl = this._activeDownloads.get(downloadId);
            if (!dl) return { status: 'error', message: 'Download not found' };
            try {
                getElectronShell().showItemInFolder(dl.savePath);
                return { status: 'ok' };
            } catch (err: any) {
                return { status: 'error', message: err?.message || 'Failed to open file' };
            }
        });

        ipcMain.handle('browser:openDownloadFolder', async (_event, downloadId: string) => {
            const dl = this._activeDownloads.get(downloadId);
            if (!dl) return { status: 'error', message: 'Download not found' };
            try {
                getElectronShell().showItemInFolder(dl.savePath);
                return { status: 'ok' };
            } catch (err: any) {
                return { status: 'error', message: err?.message || 'Failed to open folder' };
            }
        });

        ipcMain.handle('browser:clearDownload', (_event, downloadId: string) => {
            this._activeDownloads.delete(downloadId);
            this._saveDownloads();
            return { status: 'ok' };
        });
    }

    /** 退出前持久化下载记录 */
    async beforeExit(): Promise<void> {
        this._saveDownloads();
    }

    static getConfigSchema() {
        return z.object({
            defaultHomepage: z.string().default('about:blank').describe('浏览器默认主页'),
            userAgent: z.string().default('').describe('自定义 User Agent，留空则使用系统默认')
        });
    }

    private _withAutomatedDownloads<T extends BaseTool<any>>(tool: T): T {
        const originalExecutor = tool.executor;
        if (!originalExecutor) return tool;

        tool.setExecutor(async (args, taskState) => {
            const taskId = taskState?.task_id;
            if (!taskId) return originalExecutor(args, taskState);
            return this.runWithAutomatedDownloadScope(taskId, taskState?.getWorkspace?.(), () =>
                originalExecutor(args, taskState)
            );
        });
        return tool;
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
        for (const tool of [
            new BrowserNavigateTool(this),
            new BrowserSnapshotTool(this),
            new BrowserExploreTool(this),
            new BrowserClickTool(this),
            new BrowserTypeTool(this),
            new BrowserUploadFileTool(this),
            new BrowserHoverTool(this),
            new BrowserPressKeyTool(this),
            new BrowserSelectOptionTool(this),
            new BrowserScrollToTool(this),
            new BrowserGoBackTool(this),
            new BrowserGoForwardTool(this),
            new BrowserReloadTool(this),
            new BrowserEvaluateTool(this),
            new BrowserTriggerTool(this),
            new BrowserTabsTool(this),
            new BrowserScreenshotTool(this),
            new BrowserWaitForTool(this)
        ]) {
            toolset.addTool(this._withAutomatedDownloads(tool));
        }
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
     * JS snippet injected into the renderer to prepare the embedded browser.
     * The host presentation policy may reveal the browser on the task's first use only.
     * Finds the parent task-view by walking up from the task-artifacts element.
     * 如果 task-view 尚不存在（后台定时任务等场景），先创建一个隐藏的 task-view，
     * 并直接初始化浏览器（跳过侧边栏动画和全局状态修改）。
     */
    private _makeEnsureSidebarScript(taskId: string): string {
        return makeEnsureSidebarScript(taskId);
    }

    /**
     * Prepare the browser for the given task, then execute a script in the active
     * webview and return the result.
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
     * Call a synchronous method on the task's <task-artifacts> element after the
     * embedded browser runtime is prepared.
     */
    async callRendererBrowser(taskId: string, method: string, ...args: any[]): Promise<any> {
        const ctrl = BrowserManager.getOrCreateController(taskId);
        return ctrl.callRendererBrowser(method, ...args);
    }

    /**
     * Prepare the embedded browser, then emit an event.
     * Used for fire-and-forget operations (navigate, goBack, etc.).
     */
    async emitBrowserEvent(eventName: string, taskId: string, ...args: any[]): Promise<void> {
        const mainWin = await this._getMainWindow();
        if (mainWin) {
            await mainWin.webContents.executeJavaScript(`(() => { ${this._makeEnsureSidebarScript(taskId)} })()`);
        }
        this.emitEvent(eventName, taskId, ...args);
    }

    /**
     * Resolve a CDP session for the given webContents id.
     * 导出快照需要同一个 session 既抓快照又求值前缀段落，因此单独抽出。
     */
    private async _requireSnapshotSession(webContentsId: number): Promise<CDPSession> {
        if (!Number.isInteger(webContentsId) || webContentsId <= 0) {
            throw new Error('Invalid webContentsId');
        }
        return this._snapshotSessionManager.getSession(webContentsId);
    }

    /**
     * Capture an ARIA snapshot for the given webContents id.
     * Used by browser renderer UI (tool menu debug action).
     */
    async captureSnapshotByWebContentsId(webContentsId: number): Promise<PageSnapshot> {
        return captureSnapshot(await this._requireSnapshotSession(webContentsId));
    }

    /**
     * Capture snapshot and export it to a text file via native save dialog.
     *
     * 输出格式与 agent 的 snapshot 工具一致，包含插件注册的 Browser Hints。
     */
    async exportSnapshotByWebContentsId(
        webContentsId: number
    ): Promise<{ canceled: boolean; filePath: string | null }> {
        const session = await this._requireSnapshotSession(webContentsId);
        const snapshot = await captureSnapshot(session);
        const content = renderSnapshotText(snapshot, {
            prefixLines: await collectSnapshotPrefix(snapshot, session)
        });

        const { BrowserWindow } = await import('electron');
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
            ? await getElectronDialog().showSaveDialog(win, dialogOptions)
            : await getElectronDialog().showSaveDialog(dialogOptions);

        if (saveResult.canceled || !saveResult.filePath) {
            return { canceled: true, filePath: null };
        }

        await fs.writeFile(saveResult.filePath, content, 'utf8');
        return { canceled: false, filePath: saveResult.filePath };
    }

    /**
     * 地址栏「页面提示」入口：列出当前页面命中的插件 Browser Hints 摘要。
     *
     * 任务浏览器标签与浏览器应用共用；提供 webContentsId 时 hint 生成器
     * 可通过 ctx.dom() 读取真实页面 DOM。失败一律降级为空列表，不影响浏览。
     */
    async listBrowserHintsForPage(payload: {
        url: string;
        title?: string;
        webContentsId?: number;
    }): Promise<BrowserHintSummary[]> {
        if (!payload?.url) return [];
        const evaluate: BrowserPageEvaluator = (expression) =>
            this._evaluateOnWebContents(payload.webContentsId, expression);
        try {
            return await collectBrowserHintSummaries(evaluate, { url: payload.url, title: payload.title });
        } catch (error) {
            logger.warn(`listBrowserHintsForPage failed: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    /** 在指定 webContents 上求值；id 无效或页面已销毁时返回空字符串 */
    private async _evaluateOnWebContents(webContentsId: number | undefined, expression: string): Promise<unknown> {
        if (!Number.isInteger(webContentsId) || (webContentsId as number) <= 0) return '';
        try {
            const wc = getElectronWebContents().fromId(webContentsId as number);
            if (!wc || wc.isDestroyed?.()) return '';
            return await wc.executeJavaScript(expression, false);
        } catch {
            return '';
        }
    }

    // =====================================================================
    //  浏览数据清除
    // =====================================================================

    async clearBrowserCookies(): Promise<{ success: boolean; message: string }> {
        try {
            const ses = BrowserManager.browserSession;
            if (!ses) return { success: false, message: '浏览器会话未初始化' };
            await ses.cookies.flushStore();
            const cookies = await ses.cookies.get({});
            for (const cookie of cookies) {
                const url = `http${cookie.secure ? 's' : ''}://${(cookie.domain || '').replace(/^\./, '')}${cookie.path || '/'}`;
                await ses.cookies.remove(url, cookie.name);
            }
            await ses.cookies.flushStore();
            return { success: true, message: `已清除 ${cookies.length} 个 Cookie` };
        } catch (err: any) {
            logger.error(`清除 Cookies 失败: ${err.message}`);
            return { success: false, message: err.message };
        }
    }

    async clearBrowserStorage(): Promise<{ success: boolean; message: string }> {
        try {
            const ses = BrowserManager.browserSession;
            if (!ses) return { success: false, message: '浏览器会话未初始化' };
            await ses.clearStorageData({
                storages: ['localstorage', 'indexdb', 'websql', 'cachestorage', 'serviceworkers']
            });
            return { success: true, message: '已清除 localStorage / IndexedDB / 缓存存储 / Service Workers' };
        } catch (err: any) {
            logger.error(`清除存储失败: ${err.message}`);
            return { success: false, message: err.message };
        }
    }

    async clearBrowserCache(): Promise<{ success: boolean; message: string }> {
        try {
            const ses = BrowserManager.browserSession;
            if (!ses) return { success: false, message: '浏览器会话未初始化' };
            await ses.clearCache();
            return { success: true, message: '已清除 HTTP 缓存' };
        } catch (err: any) {
            logger.error(`清除缓存失败: ${err.message}`);
            return { success: false, message: err.message };
        }
    }

    async clearAllBrowserData(): Promise<{ success: boolean; message: string }> {
        try {
            const ses = BrowserManager.browserSession;
            if (!ses) return { success: false, message: '浏览器会话未初始化' };
            await ses.clearStorageData({
                storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'cachestorage', 'serviceworkers', 'autofill']
            });
            await ses.clearCache();
            await ses.clearAuthCache();
            return { success: true, message: '已清除所有浏览数据' };
        } catch (err: any) {
            logger.error(`清除所有数据失败: ${err.message}`);
            return { success: false, message: err.message };
        }
    }

    // =====================================================================
    //  证书管理（导入/删除后需重启 OpenDesk 生效）
    // =====================================================================

    private async _getCertStorePath(): Promise<string> {
        if (this._cachedCertStorePath) return this._cachedCertStorePath;
        const { app } = await import('electron');
        this._cachedCertStorePath = path.join(getElectronApp().getPath('userData'), 'browser_certificates.json');
        return this._cachedCertStorePath;
    }
    private _cachedCertStorePath: string | null = null;

    private async _getCertsDir(): Promise<string> {
        const { app } = await import('electron');
        return path.join(getElectronApp().getPath('userData'), 'certificates');
    }

    async getBrowserCertificates(): Promise<CertInfo[]> {
        try {
            const storePath = await this._getCertStorePath();
            const data = await fs.readFile(storePath, 'utf-8').catch(() => '[]');
            return JSON.parse(data) as CertInfo[];
        } catch {
            return [];
        }
    }

    async importBrowserCertificate(certPem: string): Promise<{ success: boolean; message: string; cert?: CertInfo }> {
        try {
            const certInfo = BrowserApplication.parseCertPem(certPem);
            const certs = await this.getBrowserCertificates();

            if (certs.some((c) => c.fingerprint === certInfo.fingerprint)) {
                return { success: false, message: '该证书已导入' };
            }

            const certsDir = await this._getCertsDir();
            await fs.mkdir(certsDir, { recursive: true });
            const certFileName = `imported-${certInfo.fingerprint.substring(0, 16)}.pem`;
            const certFilePath = path.join(certsDir, certFileName);
            await fs.writeFile(certFilePath, certPem, 'utf-8');

            certInfo.filePath = certFilePath;
            certInfo.importedAt = new Date().toISOString();

            certs.push(certInfo);
            const storePath = await this._getCertStorePath();
            await fs.writeFile(storePath, JSON.stringify(certs, null, 2), 'utf-8');

            return {
                success: true,
                message: `证书 "${certInfo.commonName}" 已导入。请重启 OpenDesk 以使证书生效。`,
                cert: certInfo
            };
        } catch (err: any) {
            logger.error(`导入证书失败: ${err.message}`);
            return { success: false, message: err.message };
        }
    }

    async removeBrowserCertificate(fingerprint: string): Promise<{ success: boolean; message: string }> {
        try {
            let certs = await this.getBrowserCertificates();
            const removed = certs.find((c) => c.fingerprint === fingerprint);
            if (!removed) return { success: false, message: '证书未找到' };

            certs = certs.filter((c) => c.fingerprint !== fingerprint);
            const storePath = await this._getCertStorePath();
            await fs.writeFile(storePath, JSON.stringify(certs, null, 2), 'utf-8');

            if (removed.filePath) {
                await fs.unlink(removed.filePath).catch(() => {});
            }

            return { success: true, message: `证书 "${removed.commonName}" 已删除。请重启 OpenDesk 以使更改生效。` };
        } catch (err: any) {
            logger.error(`删除证书失败: ${err.message}`);
            return { success: false, message: err.message };
        }
    }

    async clearAutofillData(): Promise<{ success: boolean; message: string }> {
        try {
            const ses = BrowserManager.browserSession;
            if (!ses) return { success: false, message: '浏览器会话未初始化' };
            await ses.clearStorageData({ storages: ['autofill'] });
            return { success: true, message: '已清除密码与自动填充数据' };
        } catch (err: any) {
            logger.error(`清除自动填充数据失败: ${err.message}`);
            return { success: false, message: err.message };
        }
    }

    // ---- 证书验证器（启动时从文件加载到内存） ----

    private static _cachedFingerprints: Set<string> = new Set();

    static async _refreshCertCache(): Promise<void> {
        const certs = await BrowserApplication._loadUserCerts();
        BrowserApplication._cachedFingerprints.clear();
        for (const c of certs) {
            BrowserApplication._cachedFingerprints.add(c.fingerprint);
            if (c.fingerprint256) BrowserApplication._cachedFingerprints.add(c.fingerprint256);
        }
    }

    static matchCachedFingerprint(serverFingerprint: string): boolean {
        const clean = serverFingerprint.replace(/^sha256\//, '');
        return BrowserApplication._cachedFingerprints.has(clean);
    }

    private static async _loadUserCerts(): Promise<CertInfo[]> {
        try {
            const { app } = await import('electron');
            const storePath = path.join(getElectronApp().getPath('userData'), 'browser_certificates.json');
            const data = await fs.readFile(storePath, 'utf-8').catch(() => '[]');
            return JSON.parse(data) as CertInfo[];
        } catch {
            return [];
        }
    }

    async initCertificateVerifier(): Promise<void> {
        const ses = BrowserManager.browserSession;
        if (!ses) return;

        await BrowserApplication._refreshCertCache();

        ses.setCertificateVerifyProc((request, callback) => {
            if (request.errorCode === 0) {
                callback(0);
                return;
            }
            try {
                const sc = new crypto.X509Certificate(request.certificate.data);
                const fp1 = sc.fingerprint.replace(/:/g, '').toLowerCase();
                const fp256 = crypto.createHash('sha256').update(sc.raw).digest('base64');
                if (
                    BrowserApplication._cachedFingerprints.has(fp1) ||
                    BrowserApplication._cachedFingerprints.has(fp256)
                ) {
                    callback(0);
                    return;
                }
            } catch {
                /* ignore */
            }
            callback(-2);
        });
    }

    private static parseCertPem(pem: string): CertInfo {
        const cert = new crypto.X509Certificate(pem);
        const fingerprint = cert.fingerprint.replace(/:/g, '').toLowerCase();
        const fingerprint256 = crypto.createHash('sha256').update(cert.raw).digest('base64');
        const subject = cert.subject;
        const issuer = cert.issuer;

        const cnMatch = subject.match(/CN\s*=\s*([^,\n]+)/);
        const commonName = cnMatch ? cnMatch[1].trim() : '未知';

        const issuerCnMatch = issuer.match(/CN\s*=\s*([^,\n]+)/);
        const issuerCN = issuerCnMatch ? issuerCnMatch[1].trim() : '未知';

        return {
            fingerprint,
            fingerprint256,
            commonName,
            issuer: issuerCN,
            subject,
            validFrom: cert.validFrom,
            validTo: cert.validTo,
            serialNumber: cert.serialNumber,
            filePath: ''
        };
    }
}

export {
    BrowserApplication,
    normalizeSaveDialogSyncPath,
    sanitizeDownloadFilename,
    makeUniqueDownloadPath,
    resolveAutomatedDownloadDirectory,
    appendAutomatedDownloadsToToolResult
};

// ---- 类型定义 ----

export interface CertInfo {
    fingerprint: string;
    fingerprint256: string;
    commonName: string;
    issuer: string;
    subject: string;
    validFrom: string;
    validTo: string;
    serialNumber: string;
    filePath: string;
    importedAt?: string;
}
