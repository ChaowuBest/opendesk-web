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
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
import { Channels as EmbedBrowserChannels } from '../../../common/embedBrowserUse/protocol';
import { makeEnsureSidebarScript, openDeskScriptGenerators } from './utils.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/** 惰性加载 electron 模块，避免在非 Electron 平台（如 HarmonyOS）启动时报错 */
let _electronApp: Electron.App | undefined;
let _electronDialog: Electron.Dialog | undefined;
let _electronShell: Electron.Shell | undefined;

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

class BrowserApplication extends BaseApplication {
    private _snapshotSessionManager = new CDPSessionManager();
    private _activeDownloads = new Map<string, DownloadState>();
    private _downloadStorePath: string | null = null;

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
        try {
            mainWindow.webContents.send(EmbedBrowserChannels.downloadUpdate, download);
        } catch {
            /* ignore */
        }
    }

    /** 处理 Electron session 的 will-download 事件 */
    handleDownload(item: Electron.DownloadItem, _webContents: Electron.WebContents): void {
        const downloadId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const suggestedFilename = item.getFilename() || 'download';
        const downloadUrl = item.getURL();

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

        if (saveResult.canceled || !saveResult.filePath) {
            item.cancel();
            return;
        }

        const savePath = saveResult.filePath;
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
        this._broadcastDownloadUpdate(download);

        item.on('updated', (_event, state) => {
            if (state === 'progressing') {
                download.receivedBytes = item.getReceivedBytes();
                download.totalBytes = item.getTotalBytes() || download.totalBytes;
                this._broadcastDownloadUpdate(download);
            }
        });

        item.once('done', (_event, state) => {
            download.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
            download.endTime = Date.now();
            download.receivedBytes = item.getReceivedBytes();
            download.totalBytes = item.getTotalBytes() || download.totalBytes;
            this._broadcastDownloadUpdate(download);
            this._saveDownloads();
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

export { BrowserApplication };

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
