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

import {
    app,
    BrowserWindow,
    Tray,
    globalShortcut,
    nativeImage,
    ipcMain,
    shell,
    Menu,
    dialog,
    screen,
    session,
    powerMonitor,
    powerSaveBlocker
} from 'electron';
import { Setting, ModelInstance, getOpendeskDirectory, getTaskArtifactDirectory } from './utils/setting.js';
import { QuickPassHelper } from './utils/quickpass.js';
import { getWindowsDrives } from './utils/drives.js';
import { PROVIDER_TEMPLATES } from './tui/components/config/providers.js';
import { GlobalState } from './aikernel/states/global.js';
import { BaseToolset } from './aikernel/tool';
import { is } from '@electron-toolkit/utils';
import { z } from 'zod';
import { NotificationManager } from './utils/notificationmgr.js';
import { LogStream, logger, useConsoleTransport } from './utils/logger.js';
import { SkillRegistry } from './applications/skillmgr/utils.js';
import {
    initializeRegistry,
    initializeRegistryWorker,
    notifyWorkerSettingUpdate,
    ApplicationRegistry
} from './applications/registry';
import {
    initializeRegistryProtocols,
    initializeProtocolHandlers,
    registerApplicationRegistryHandlers
} from './applications/registry_electron.js';
import { UpdateClient } from '../updater/client.js';
import { setPlatform, getPlatform } from '../platforms/base.js';
import {
    ElectronTaskUpdateSubscriber,
    ElectronPlatform,
    ElectronTaskManagerUpdateSubscriber
} from '../platforms/electron.js';
import { exportTaskToHtml, generateTaskHtml } from './utils/export.js';
import { getMainThemeService, registerThemeHandlers } from '../renderer/theme/main-theme-service.js';
import { MainAgentDecl } from './aikernel/agents/main/agent.js';
import { AgentRegistry } from './aikernel/agents/registry.js';
import { HarnessContext } from './aikernel/security/harness.js';
import { ElectronPermissionPromptProvider } from './aikernel/security/electronPrompt.js';
import { ElectronAskUserProvider } from './aikernel/interaction/electronAskUser.js';
import { createInteractionToolset } from './aikernel/interaction/tools.js';
import { ElectronExitPlanModeProvider } from './aikernel/interaction/electronExitPlanMode.js';
import { ChannelMgrApplication } from './applications/channelmgr/app.js';
import { ChannelMessageRouter } from './applications/channelmgr/router.js';
import {
    prepareFileMgrStartupWorkspaceSettings,
    prepareFileMgrWorkspaceSettings
} from './applications/filemgr/workspace.js';
import { getTaskTodosForDisplay } from './aikernel/todos/task-todos.js';
import { readTaskSessionMemory, isSessionMemoryTemplateOnly } from './aikernel/compaction/session-memory-compact.js';
import { readUserPortrait, registerUserPortraitReviewHook } from './aikernel/memory/user_portrait.js';
import { marked } from './aikernel/messages.js';
import { lookupKnownContextSize, fetchContextSizeFromAPI } from './utils/model-context.js';
import { LLM } from './aikernel/llm.js';
import { BrowserManager, setCDPLogger } from '../common/embedBrowserUse/main';
import { openDeskScriptGenerators } from './applications/browser/utils.js';
import { Channels as EmbedBrowserChannels } from '../common/embedBrowserUse/protocol';
import { registerNativeBridge } from '../platforms/bridges/main.js';
import { listGatewayListenHostOptions } from './applications/devicemgr/common.js';
import { getExecutionNode, listExecutionNodes } from './applications/devicemgr/execution.js';
import type { TaskState } from './aikernel/states/tasks.js';

/** 全局 agentDecl 实例（延迟初始化），用于获取 mode 等元信息 */
let _globalAgentDecl: MainAgentDecl | null = null;
function getGlobalAgentDecl(): MainAgentDecl {
    if (!_globalAgentDecl) {
        _globalAgentDecl = new MainAgentDecl();
        AgentRegistry.initBuiltinAgents();
    }
    return _globalAgentDecl;
}
/** 当前在 Electron GUI 中选择的 modeId */
let _currentElectronModeId: string | null = null;

async function initializeUserPortraitReviewTask(task: TaskState): Promise<void> {
    const workspace = Setting.getInstance().getEffectiveWorkspace();
    const agent = getGlobalAgentDecl();
    const modes = agent.supportedModes();
    const mode = modes.find((m) => m.id === (_currentElectronModeId || agent.defaultModeId())) ?? modes[0];
    await GlobalState.getInstance().taskManagerState.initHarness(task, workspace, mode);
}

function migrateFileMgrWorkspaceSettingsOnStartup() {
    const setting = Setting.getInstance();
    const prepared = prepareFileMgrStartupWorkspaceSettings(setting.getData());
    if (prepared.changed) {
        setting.setData(prepared.data);
    }
}

import Convert from 'ansi-to-html';
import fs from 'fs';
import path from 'path';
import os from 'os';
import fsPromises from 'fs/promises';

import appIcon from '../../resources/main/images/icon_round.png?asset';
import { initTempDir, closeTempDir } from './utils/temp.js';

// TODO: FSService 和 recallApplication 当前未接入，保留 ipcMain handler 以兼容旧前端
declare const FSService: any;
declare const recallApplication: any;

setPlatform(new ElectronPlatform(app));
useConsoleTransport();
initTempDir();

// 防止 stdout/stderr EPIPE 错误逃逸为 uncaughtException
// 当终端管道断开或系统休眠后恢复时，写入操作可能触发 EPIPE
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    throw err;
});
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    throw err;
});

// 全局异常兜底：记录日志并向用户展示错误对话框
process.on('uncaughtException', (err, origin) => {
    const errDetails = err instanceof Error ? err.stack || err.message : String(err);

    // EPIPE 是可恢复的网络/管道断开错误，不应导致应用崩溃
    // 常见于系统休眠后网络连接恢复时，或终端管道断开
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPIPE') {
        logger.warn(`[RECOVERABLE] EPIPE error (${origin}): ${errDetails}`);
        return;
    }

    logger.error(`[FATAL] uncaughtException (${origin}): ${errDetails}`);
    try {
        dialog.showErrorBox(
            'OpenDesk 发生不可恢复的错误',
            `${origin}\n\n${errDetails}\n\n程序即将退出，请查看日志获取详细信息。`
        );
    } catch {
        /* dialog 可能在 app ready 前不可用 */
    }
    app.exit(1);
});

process.on('unhandledRejection', (reason, _promise) => {
    const reasonDetails = reason instanceof Error ? reason.stack || reason.message : String(reason);
    logger.error(`[FATAL] unhandledRejection: ${reasonDetails}`);
    try {
        dialog.showErrorBox(
            'OpenDesk 发生不可恢复的错误',
            `unhandledRejection\n\n${reasonDetails}\n\n程序即将退出，请查看日志获取详细信息。`
        );
    } catch {
        /* dialog 可能在 app ready 前不可用 */
    }
    app.exit(1);
});

app.commandLine.appendSwitch(
    'disable-features',
    'CompressionDictionaryTransportBackend,CompressionDictionaryTransport,WebContentsForceDark'
);
// 启用 Windows 原生窗口遮挡检测（减少被遮挡时的绘制开销）
if (process.platform === 'win32') {
    app.commandLine.appendSwitch('enable-features', 'CalculateNativeWinOcclusion');
}

// OpenHarmony 环境下注入 USER_DATA_PATH，确保 setting.ts / skillmgr utils 等模块能找到可写数据目录
if (process.platform === 'openharmony' && !process.env.USER_DATA_PATH) {
    try {
        const electronUserData = app.getPath('userData');
        if (electronUserData) {
            process.env.USER_DATA_PATH = electronUserData;
        }
    } catch {
        // app.getPath 可能在 OpenHarmony 上不可用，后续 resolveWritableUserDataRoot 会做回退
    }
}

const __dirname = import.meta.dirname;
const converter = new Convert();

let globalMainWindow: BrowserWindow | null = null;
let globalTray: Tray | null = null;
let isAppQuitting = false;

/**
 * 解析内置 skills 目录：优先用 SkillRegistry，再尝试 main 进程侧路径（开发/打包均可用）
 */
function resolveBundledSkillsDir() {
    const fromRegistry = SkillRegistry.getBundledSkillsDirectory();
    if (fs.existsSync(fromRegistry)) return fromRegistry;
    const appPath = app.getAppPath();
    const candidates = [
        path.join(__dirname, 'applications', 'skills', 'resources'),
        path.join(appPath, 'applications', 'skills', 'resources'),
        path.join(appPath, 'src', 'main', 'applications', 'skills', 'resources')
    ];
    for (const dir of candidates) {
        if (fs.existsSync(dir)) return dir;
    }
    return null;
}

/**
 * 仅在首次运行时将内置 skills 拷贝到用户的 apps/skills/resources
 * - 若用户技能目录已存在（含用户删除后的空目录），则不再覆盖，以保留用户删除/修改
 * - 支持 npm 调试（dev）和打包运行，多路径回退定位内置目录
 */
async function installBundledSkillsIfNeeded() {
    try {
        const appDir = getOpendeskDirectory();
        const userSkillsDirPath = path.join(appDir, 'apps', 'skills', 'resources');
        if (fs.existsSync(userSkillsDirPath)) {
            return;
        }

        const bundledSkillsDir = resolveBundledSkillsDir();
        if (!bundledSkillsDir) {
            logger.warn('installBundledSkillsIfNeeded: 未找到内置 skills 目录，跳过拷贝');
            return;
        }

        const userSkillsDir = SkillRegistry.getSkillsDirectory();

        const copyRecursive = (src: string, dest: string) => {
            const stat = fs.statSync(src);
            if (stat.isDirectory()) {
                fs.mkdirSync(dest, { recursive: true });
                for (const child of fs.readdirSync(src)) {
                    copyRecursive(path.join(src, child), path.join(dest, child));
                }
            } else {
                fs.copyFileSync(src, dest);
            }
        };

        const entries = fs.readdirSync(bundledSkillsDir, { withFileTypes: true });
        for (const ent of entries) {
            const srcPath = path.join(bundledSkillsDir, ent.name);
            const destPath = path.join(userSkillsDir, ent.name);
            copyRecursive(srcPath, destPath);
        }
    } catch (error: any) {
        logger.error('installBundledSkillsIfNeeded failed', error);
    }
}

// Browser management — delegated to BrowserManager from embedBrowserUse.
// Legacy cleanup kept here since it depends on app-specific getOpendeskDirectory().
async function initBrowserSession() {
    try {
        // Clean up the old session.fromPath directory if its cache is corrupted
        const legacySessionPath = path.join(getOpendeskDirectory(), 'apps', 'browser', 'session');
        const legacyCachePath = path.join(legacySessionPath, 'Cache');
        if (fs.existsSync(legacyCachePath)) {
            try {
                fs.rmSync(legacyCachePath, { recursive: true, force: true });
                logger.info('Cleaned up legacy browser session cache directory');
            } catch {
                // best-effort cleanup
            }
        }

        // Wire in the project logger for CDP messages
        setCDPLogger(logger);

        const ses = await BrowserManager.initSession('persist:opendesk-browser');
        if (ses) {
            logger.info(
                `Browser session initialized (partition: persist:opendesk-browser), storage: ${ses.storagePath || (ses as any).getStoragePath?.() || 'default'}`
            );

            // 获取 BrowserApplication 实例
            const browserApp = ApplicationRegistry.getApplication('browser') as any;

            // 初始化证书验证器（支持用户导入的根证书 + 系统根证书）
            if (browserApp?.initCertificateVerifier) {
                void browserApp.initCertificateVerifier().catch((err: any) => {
                    logger.error(`initCertificateVerifier 失败: ${err?.message || err}`);
                });
            }

            // 处理下载事件 — 委托给 BrowserApplication
            ses.on('will-download', (_event: any, item: any, webContents: any) => {
                browserApp?.handleDownload(item, webContents);
            });

            // 加载持久化的下载记录
            browserApp?.loadDownloads();
        }
    } catch (err) {
        logger.error(`Failed to initialize browser session: ${err}`);
    }
}

function getRendererPreloadPath(): string {
    const candidates = [
        path.join(__dirname, '..', 'preload', 'index.js'),
        path.join(app.getAppPath(), 'dist', 'preload', 'index.js')
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return candidates[0];
}

/** Electron 39+：OOPIF iframe 的 frame preload；子应用 guest 主要靠 webview + will-attach-webview */
function registerRendererFramePreload(): void {
    const preloadPath = getRendererPreloadPath();
    try {
        const existing = session.defaultSession.getPreloadScripts();
        if (!existing.some((s) => s.id === 'opendesk-renderer-frame')) {
            session.defaultSession.registerPreloadScript({
                id: 'opendesk-renderer-frame',
                type: 'frame',
                filePath: preloadPath
            });
            logger.info(`Registered frame preload: ${preloadPath}`);
        }
    } catch (err) {
        logger.error(`Failed to register frame preload: ${err}`);
    }
}

function installWebviewHostHandlers(hostWindow: BrowserWindow): void {
    hostWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
        const src = params.src ?? '';
        const isApplicationGuest = src.includes('application.html');
        if (isApplicationGuest) {
            webPreferences.preload = getRendererPreloadPath();
            webPreferences.contextIsolation = true;
            webPreferences.nodeIntegration = false;
            return;
        }
        // 仅 browser application 的 webview 注入 window.open proxy preload
        // 并关闭 contextIsolation（使 preload 能同步 patch window.open）
        const isBrowserWebview = webPreferences.partition === 'persist:opendesk-browser';
        if (isBrowserWebview) {
            webPreferences.preload = path.join(__dirname, '..', 'preload', 'webviewPreload.js');
            webPreferences.contextIsolation = false;
        }
        if (BrowserManager.browserSession) {
            webPreferences.session = BrowserManager.browserSession;
        }
    });

    // 拦截嵌入式浏览器 webview 中的弹窗请求（window.open / target="_blank"），
    // 通知 renderer 以新标签页形式打开，避免弹出独立窗口。
    hostWindow.webContents.on('did-attach-webview', (_event, webContents) => {
        webContents.setWindowOpenHandler(({ url }) => {
            if (url && url !== 'about:blank' && !hostWindow.isDestroyed()) {
                hostWindow.webContents.send(EmbedBrowserChannels.popupBlocked, url, webContents.id);
            }
            return { action: 'deny' };
        });

        // 当 webview guest 页面调用 window.close()（如 OAuth 完成后），
        // 通知 renderer 关闭对应 tab。
        webContents.on('close', () => {
            if (hostWindow.isDestroyed()) return;
            hostWindow.webContents.send(EmbedBrowserChannels.webviewCloseRequested, webContents.id);
        });

        // 将 webview 中的键盘事件转发给所属 renderer，使快捷键和 magic pointer
        // 在 webview 获得焦点时仍能正常工作。
        webContents.on('before-input-event', (_evt, input) => {
            if (hostWindow.isDestroyed()) return;
            const modifiers = input.modifiers ?? [];
            const isBrowserWebview = webContents.session === BrowserManager.browserSession;
            const isPlainTab =
                input.key === 'Tab' &&
                !modifiers.some((modifier) => modifier === 'control' || modifier === 'meta' || modifier === 'alt');

            if (isBrowserWebview && isPlainTab) {
                // Keep native Chromium Tab traversal inside the guest page, but
                // do not mirror plain Tab into the OpenDesk host UI.
                return;
            }

            hostWindow.webContents.send('webview:keyboard-event', {
                type: input.type, // 'keyDown' | 'keyUp'
                key: input.key,
                code: input.code,
                modifiers: input.modifiers // e.g. ['meta'], ['control','shift']
            });
        });
    });
}

const createWindow = () => {
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 700,
        frame: false,
        icon: appIcon,
        show: false, // 等 ready-to-show 后再显示，避免白屏闪烁
        paintWhenInitiallyHidden: true, // 允许在隐藏状态下预先渲染首帧
        webPreferences: {
            nodeIntegration: false,
            nodeIntegrationInSubFrames: true,
            contextIsolation: true,
            webviewTag: true,
            allowRunningInsecureContent: true,
            backgroundThrottling: true, // 窗口失焦时降低渲染频率（省电）
            preload: path.join(__dirname, '..', 'preload', 'index.js')
        }
    });

    // 就绪后显示窗口，避免白屏
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.setMenu(null);
    installWebviewHostHandlers(mainWindow);
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
        mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    }

    const forceExitMagicPointer = () => {
        if (mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('magicPointer:forceExit');
    };

    mainWindow.on('blur', forceExitMagicPointer);
    mainWindow.on('hide', forceExitMagicPointer);
    mainWindow.on('minimize', forceExitMagicPointer);

    mainWindow.on('close', (event) => {
        if (!isAppQuitting) {
            // 如果不是应用要退出，仅仅是窗口关闭，则拦截并隐藏
            event.preventDefault();
            mainWindow.hide();
        }
        // 如果 isAppQuitting 为 true，则不执行 preventDefault，窗口正常销毁
    });

    const protocolConfigs = ApplicationRegistry.collectProtocolHandlerEntries();
    const inAppSchemePrefixes = Array.from(
        new Set([...protocolConfigs.map((c) => c.scheme + '://'), 'opendesk-app://'])
    );
    const openLink = (url: string) => {
        if (
            url.startsWith('file://') ||
            url.startsWith('http://localhost') ||
            inAppSchemePrefixes.some((p) => url.startsWith(p))
        ) {
            return false;
        }
        logger.info(`openLink: ${url}`);
        void shell.openExternal(url).catch((error) => {
            logger.warn(`openExternal failed for ${url}: ${error}`);
        });
        return true;
    };

    // renderer 可以通过 IPC 抑制下一次默认右键菜单（用于自定义右键菜单场景）
    let suppressNextContextMenu = false;
    ipcMain.on('context-menu:suppress', () => {
        suppressNextContextMenu = true;
    });

    // 缓存上一次的右键菜单，避免 macOS 原生 NSMenuItem 引用泄漏
    let _lastContextMenu: Electron.Menu | null = null;

    mainWindow.webContents.on('context-menu', (_event, params) => {
        if (suppressNextContextMenu) {
            suppressNextContextMenu = false;
            return;
        }
        const menuItems: Electron.MenuItemConstructorOptions[] = [];
        if (params.mediaType === 'image' && params.srcURL) {
            menuItems.push({
                label: '复制图片',
                click: () => {
                    mainWindow.webContents.copyImageAt(params.x, params.y);
                }
            });
            menuItems.push({
                label: '另存为图片…',
                click: async () => {
                    const url = params.srcURL;
                    const ext = url.startsWith('data:image/png') ? '.png' : '.jpg';
                    const { canceled, filePath: savePath } = await dialog.showSaveDialog(mainWindow, {
                        defaultPath: path.join(app.getPath('desktop'), `image${ext}`),
                        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
                    });
                    if (canceled || !savePath) return;
                    try {
                        if (url.startsWith('data:')) {
                            const base64 = url.replace(/^data:image\/\w+;base64,/, '');
                            await fsPromises.writeFile(savePath, Buffer.from(base64, 'base64'));
                        }
                    } catch {
                        /* ignore */
                    }
                }
            });
        }
        if (params.editFlags.canCut) {
            menuItems.push({ label: '剪切', role: 'cut' });
        }
        if (params.editFlags.canCopy || params.selectionText) {
            menuItems.push({ label: '复制', role: 'copy' });
        }
        if (params.editFlags.canPaste) {
            menuItems.push({ label: '粘贴', role: 'paste' });
        }
        if (params.editFlags.canSelectAll) {
            menuItems.push({ label: '全选', role: 'selectAll' });
        }
        if (menuItems.length > 0) {
            // 先关闭前一个菜单，释放原生 NSMenuItem 引用
            if (_lastContextMenu) {
                _lastContextMenu.closePopup();
                _lastContextMenu = null;
            }
            _lastContextMenu = Menu.buildFromTemplate(menuItems);
            _lastContextMenu.on('menu-will-close', () => {
                _lastContextMenu = null;
            });
            _lastContextMenu.popup({ window: mainWindow });
        }
    });

    mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
        // 非活跃 webview 开启后台节流，降低 CPU 和电量消耗
        webPreferences.backgroundThrottling = true;
        const src = params.src ?? '';
        const isApplicationGuest = src.includes('application.html');
        if (isApplicationGuest) {
            webPreferences.preload = getRendererPreloadPath();
            webPreferences.contextIsolation = true;
            webPreferences.nodeIntegration = false;
            return;
        }
        // 仅 browser application 的 webview 注入 window.open proxy preload
        // 并关闭 contextIsolation（使 preload 能同步 patch window.open）
        const isBrowserWebview = webPreferences.partition === 'persist:opendesk-browser';
        if (isBrowserWebview) {
            webPreferences.preload = path.join(__dirname, '..', 'preload', 'webviewPreload.js');
            webPreferences.contextIsolation = false;
        }
        if (BrowserManager.browserSession) {
            webPreferences.session = BrowserManager.browserSession;
        }
    });

    // 拦截嵌入式浏览器 webview 中的弹窗请求（window.open / target="_blank"），
    // 通知 renderer 以新标签页形式打开，避免弹出独立窗口。
    mainWindow.webContents.on('did-attach-webview', (_event, webContents) => {
        webContents.setWindowOpenHandler(({ url }) => {
            if (url && url !== 'about:blank') {
                mainWindow.webContents.send(EmbedBrowserChannels.popupBlocked, url, webContents.id);
            }
            return { action: 'deny' };
        });

        // 当 webview guest 页面调用 window.close()（如 OAuth 完成后），
        // 通知 renderer 关闭对应 tab。
        webContents.on('close', () => {
            if (mainWindow.isDestroyed()) return;
            mainWindow.webContents.send(EmbedBrowserChannels.webviewCloseRequested, webContents.id);
        });

        // 将 webview 中的键盘事件转发给主 renderer，使快捷键和 magic pointer
        // 在 webview 获得焦点时仍能正常工作。
        webContents.on('before-input-event', (_evt, input) => {
            if (mainWindow.isDestroyed()) return;
            mainWindow.webContents.send('webview:keyboard-event', {
                type: input.type, // 'keyDown' | 'keyUp'
                key: input.key,
                code: input.code,
                modifiers: input.modifiers // e.g. ['meta'], ['control','shift']
            });
        });
    });

    mainWindow.webContents.on('will-navigate', (event) => {
        if (openLink(event.url)) {
            event.preventDefault();
            return;
        }
    });

    mainWindow.webContents.on('will-frame-navigate', (event) => {
        if (openLink(event.url)) {
            event.preventDefault();
            return;
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (openLink(url)) {
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    // 窗口隐藏/最小化时通知 renderer 降低刷新率，节省 CPU 和电量
    mainWindow.on('hide', () => {
        mainWindow.webContents.send('window:visibilityChanged', false);
    });
    mainWindow.on('show', () => {
        mainWindow.webContents.send('window:visibilityChanged', true);
    });
    mainWindow.on('minimize', () => {
        mainWindow.webContents.send('window:visibilityChanged', false);
    });
    mainWindow.on('restore', () => {
        mainWindow.webContents.send('window:visibilityChanged', true);
    });

    globalMainWindow = mainWindow;
    BrowserManager.setMainWindow(mainWindow);
};

const registerModeAPIHandlers = () => {
    ipcMain.handle('mode:getSupportedModes', () => {
        try {
            const agentDecl = getGlobalAgentDecl();
            const modes = agentDecl.supportedModes();
            const defaultId = agentDecl.defaultModeId();
            const currentId = _currentElectronModeId || defaultId;
            return {
                status: 'ok',
                data: {
                    modes: modes.map((m) => ({
                        id: m.id,
                        name: m.name,
                        description: m.description,
                        icon: m.icon,
                        color: m.color
                    })),
                    defaultModeId: defaultId,
                    currentModeId: currentId
                }
            };
        } catch (err) {
            return { status: 'error', message: String(err) };
        }
    });

    ipcMain.handle('mode:setCurrentMode', async (event, modeId) => {
        try {
            const agentDecl = getGlobalAgentDecl();
            const modes = agentDecl.supportedModes();
            const target = modes.find((m) => m.id === modeId);
            if (!target) {
                return { status: 'error', message: `unknown mode: ${modeId}` };
            }

            // 仅更新系统默认模式（影响新任务启动时的初始模式），不再同步所有现有任务
            _currentElectronModeId = modeId;

            return { status: 'ok', data: modeId };
        } catch (err) {
            return { status: 'error', message: String(err) };
        }
    });

    ipcMain.handle('mode:setTaskMode', async (event, taskId: string, modeId: string) => {
        try {
            const agentDecl = getGlobalAgentDecl();
            const modes = agentDecl.supportedModes();
            const target = modes.find((m) => m.id === modeId);
            if (!target) {
                return { status: 'error', message: `unknown mode: ${modeId}` };
            }

            const globalState = GlobalState.getInstance();
            const task = globalState.taskManagerState.getTask(taskId);
            if (!task) {
                return { status: 'error', message: `task ${taskId} not found` };
            }

            const workspace = Setting.getInstance().getEffectiveWorkspace();
            const oldModeId = task.activeModeId || agentDecl.defaultModeId();
            if (oldModeId !== modeId) {
                const oldMode = modes.find((m) => m.id === oldModeId);
                if (oldMode?.onExitMode) {
                    await oldMode.onExitMode(workspace);
                }
                if (target.onEnterMode) {
                    await target.onEnterMode(workspace);
                }
            }

            const savedEnv = task.harnessContext.environ;
            const savedExecutionHost = task.harnessContext.executionHost;
            try {
                const ctx = await HarnessContext.createForMode(workspace, target);
                ctx.environ = savedEnv;
                ctx.executionHost = savedExecutionHost;
                ctx.permissionPrompt = task.harnessContext.permissionPrompt || new ElectronPermissionPromptProvider();
                await ctx.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
                task.harnessContext = ctx;
                task.activeModeId = target.id;
                task.allowedTools = target.allowedTools;
                task.disabledTools = target.disabledTools;
            } catch (err) {
                logger.warn(`Failed to sync task harness for mode ${modeId}: ${err}`);
                task.harnessContext.workspace = workspace;
            }

            return { status: 'ok', data: modeId };
        } catch (err) {
            return { status: 'error', message: String(err) };
        }
    });
};

const registerBrowserAPIHandlers = () => {
    BrowserManager.setMainWindow(globalMainWindow);
    BrowserManager.bind(ipcMain, openDeskScriptGenerators);

    // 下载管理 IPC — 委托给 BrowserApplication
    const browserApp = ApplicationRegistry.getApplication('browser') as any;
    if (browserApp?.registerDownloadIPC) {
        browserApp.registerDownloadIPC(ipcMain);
    }
};

const registerMemoryAPIHandlers = () => {
    ipcMain.handle('memory:getUserPortrait', async () => {
        try {
            return { status: 'ok', data: { raw: await readUserPortrait() } };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });
};

const registerTaskManagerAPIHandlers = () => {
    const globalState = GlobalState.getInstance();

    type CreateTaskOptions = {
        modeId?: string;
        selectedExecutionNodeId?: string | null;
    };

    function normalizeCreateTaskOptions(raw: unknown): CreateTaskOptions {
        if (raw && typeof raw === 'object') {
            const obj = raw as Record<string, unknown>;
            return {
                modeId: typeof obj.modeId === 'string' ? obj.modeId : undefined,
                selectedExecutionNodeId:
                    typeof obj.selectedExecutionNodeId === 'string' || obj.selectedExecutionNodeId === null
                        ? obj.selectedExecutionNodeId
                        : undefined
            };
        }
        return {
            modeId: typeof raw === 'string' ? raw : undefined
        };
    }

    function normalizeExecutionNodeId(nodeId?: string | null): string {
        return typeof nodeId === 'string' ? nodeId.trim() : '';
    }

    async function applyTaskExecutionNode(task: TaskState, nodeId?: string | null) {
        const normalizedNodeId = normalizeExecutionNodeId(nodeId);
        if (!normalizedNodeId) {
            await task.setExecutionHost({ type: 'local' });
            return { status: 'ok', data: { type: 'local' } };
        }
        const node = getExecutionNode(normalizedNodeId);
        if (!node) {
            return { status: 'error', message: `node ${normalizedNodeId} not connected` };
        }
        const label = node.displayName || node.nodeId;
        await task.setExecutionHost({
            type: 'node',
            nodeId: node.nodeId,
            nodeLabel: label,
            capabilities: {
                nodeId: node.nodeId,
                displayName: node.displayName,
                platform: node.platform,
                workspace: node.workspace,
                commands: node.commands,
                shells: node.shells,
                defaultShell: node.defaultShell
            }
        });
        return {
            status: 'ok',
            data: { type: 'node', nodeId: node.nodeId, nodeLabel: label, workspace: node.workspace }
        };
    }

    ipcMain.handle('taskManager:createTask', async (event, rawOptions) => {
        const options = normalizeCreateTaskOptions(rawOptions);
        const initialNodeId = normalizeExecutionNodeId(options.selectedExecutionNodeId);
        if (initialNodeId && !getExecutionNode(initialNodeId)) {
            return { status: 'error', message: `node ${initialNodeId} not connected` };
        }
        const task = globalState.taskManagerState.createTask();
        const workspace = Setting.getInstance().getEffectiveWorkspace();
        const agentDecl = getGlobalAgentDecl();
        const modes = agentDecl.supportedModes();
        const resolvedModeId = options.modeId || _currentElectronModeId || agentDecl.defaultModeId();
        const activeMode = modes.find((m) => m.id === resolvedModeId) ?? modes[0];

        try {
            task.harnessContext = await HarnessContext.createForMode(workspace, activeMode);
            task.harnessContext.permissionPrompt = new ElectronPermissionPromptProvider();
            task.activeModeId = activeMode.id;
            task.allowedTools = activeMode.allowedTools;
            task.disabledTools = activeMode.disabledTools;
            await task.harnessContext.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
            // 注入 interaction 工具集（仅主任务，buildToolsets 会自动包含）
            const askUserProvider = new ElectronAskUserProvider();
            const exitPlanModeProvider = new ElectronExitPlanModeProvider();
            exitPlanModeProvider.setModeSwitcher(async (targetModeId: string) => {
                const modes2 = getGlobalAgentDecl().supportedModes();
                const targetMode = modes2.find((m) => m.id === targetModeId);
                if (!targetMode) return;
                const ws = Setting.getInstance().getEffectiveWorkspace();
                const oldId = task.activeModeId || getGlobalAgentDecl().defaultModeId();
                if (oldId !== targetModeId) {
                    const oldMode = modes2.find((m) => m.id === oldId);
                    await oldMode?.onExitMode?.(ws);
                    await targetMode.onEnterMode?.(ws);
                }
                // 仅切换当前任务的模式，不影响其他任务
                const savedEnv = task.harnessContext.environ;
                const savedExecutionHost = task.harnessContext.executionHost;
                try {
                    const ctx = await HarnessContext.createForMode(ws, targetMode);
                    ctx.environ = savedEnv;
                    ctx.executionHost = savedExecutionHost;
                    ctx.permissionPrompt =
                        task.harnessContext.permissionPrompt || new ElectronPermissionPromptProvider();
                    await ctx.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
                    task.harnessContext = ctx;
                    task.activeModeId = targetMode.id;
                    task.allowedTools = targetMode.allowedTools;
                    task.disabledTools = targetMode.disabledTools;
                } catch {
                    /* ignore */
                }
                // 通知 renderer 侧更新该任务的模式显示
                for (const w of BrowserWindow.getAllWindows()) {
                    if (!w.isDestroyed()) {
                        w.webContents.send('mode:taskModeChanged', task.task_id, targetModeId);
                    }
                }
            });
            task.interactionToolset = createInteractionToolset(askUserProvider, exitPlanModeProvider);

            if (initialNodeId) {
                const result = await applyTaskExecutionNode(task, initialNodeId);
                if (result.status !== 'ok') return result;
            }

            const systemPrompt = await agentDecl.createSystemPrompt(activeMode, task);
            task.setSystemPrompt(systemPrompt);
        } catch (err) {
            logger.warn(`Failed to init task harness in Electron, using empty context: ${err}`);
            task.harnessContext = HarnessContext.createEmpty();
            task.harnessContext.workspace = workspace;
        }
        return { status: 'ok', data: task.task_id };
    });

    ipcMain.handle('taskManager:triggerTaskReview', async (_event, taskId: string) => {
        try {
            const task = globalState.taskManagerState.getTask(taskId);
            if (!task) {
                return { status: 'error', message: `task ${taskId} not found` };
            }
            task.cancelPendingTaskReview();
            await task.hooks.noticeTaskReview(task, 0);
            return { status: 'ok', data: { triggered: true } };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });
    ipcMain.handle('taskManager:removeTask', (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }

        globalState.taskManagerState.removeTask(taskId);
        return { status: 'ok', data: task.task_id };
    });
    ipcMain.handle('taskManager:forkTask', (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        const forkedTask = task.fork();
        return { status: 'ok', data: forkedTask.task_id };
    });
    ipcMain.handle('taskManager:renameTask', (event, taskId, newName) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        task.rename(newName);
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:clearAllTasks', () => {
        globalState.taskManagerState.clearAllTasks();
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:getFullTask', async (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }

        task.ensureValidModelOrFallback();
        await task.ensureToolsResolved();
        await task.render();
        return { status: 'ok', data: task.toRenderJSON() };
    });
    ipcMain.handle('taskManager:getTaskTodos', async (event, taskId) => {
        try {
            const todos = getTaskTodosForDisplay(taskId);
            return { status: 'ok', data: todos };
        } catch (err) {
            return { status: 'error', message: err?.message || String(err) };
        }
    });
    ipcMain.handle('taskManager:subscribeTaskUpdate', (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }

        if (!event.senderFrame) {
            return { status: 'error', message: 'sender frame not found' };
        }

        const subscriber = new ElectronTaskUpdateSubscriber(event.senderFrame);
        return { status: 'ok', data: task.addSubscriber(subscriber) };
    });
    ipcMain.handle('taskManager:unsubscribeTaskUpdate', (event, taskId, subscriptionId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }

        return { status: 'ok', data: task.removeSubscriber(subscriptionId) };
    });

    ipcMain.handle('taskManager:getTaskList', (_event) => {
        return { status: 'ok', data: globalState.taskManagerState.getTaskList() };
    });
    ipcMain.handle('taskManager:subscribeTaskListUpdate', (event) => {
        if (!event.senderFrame) {
            return { status: 'error', message: 'sender frame not found' };
        }
        const subscriber = new ElectronTaskManagerUpdateSubscriber(event.senderFrame);
        return { status: 'ok', data: globalState.taskManagerState.addSubscriber(subscriber) };
    });
    ipcMain.handle('taskManager:attachToolset', async (event, taskId, toolsetObject) => {
        if (!event.senderFrame) {
            return { status: 'error', message: 'sender frame not found' };
        }
        const senderFrame = event.senderFrame;

        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }

        const toolset = BaseToolset.fromJSON(toolsetObject);
        for (const tool of toolset.tools.values()) {
            tool.setExecutor(async (args) => {
                const toolCallId = crypto.randomUUID();
                type RendererToolCallResult = { status: 'ok'; data: string } | { status: 'error'; message?: string };

                const result = await new Promise<RendererToolCallResult>((resolve, _reject) => {
                    const timeout = setTimeout(() => {
                        ipcMain.removeAllListeners(`taskManager:reportToolCallResult:${toolCallId}`);
                        resolve({ status: 'error', message: `Renderer tool ${tool.name} timed out (60s)` });
                    }, 60_000);

                    ipcMain.once(
                        `taskManager:reportToolCallResult:${toolCallId}`,
                        (_event, result: RendererToolCallResult) => {
                            clearTimeout(timeout);
                            resolve(result);
                        }
                    );
                    senderFrame.send(`taskManager:callTool`, taskId, toolCallId, toolset.name, tool.name, args);
                });

                if (result.status === 'error') {
                    throw new Error(result.message || 'Renderer tool execution failed');
                }
                return result.data;
            });
        }

        await task.attachToolset(toolset);
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:setSystemPrompt', (event, taskId, prompt) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        task.setSystemPrompt(prompt);
    });
    async function setTaskExecutionNode(taskId: string, nodeId?: string | null) {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        const result = await applyTaskExecutionNode(task, nodeId);
        if (result.status !== 'ok') return result;
        await refreshTaskSystemPrompt(task);
        return result;
    }
    async function refreshTaskSystemPrompt(task: TaskState): Promise<void> {
        const agentDecl = getGlobalAgentDecl();
        const modes = agentDecl.supportedModes();
        const modeId = task.activeModeId || _currentElectronModeId || agentDecl.defaultModeId();
        const activeMode = modes.find((m) => m.id === modeId) ?? modes[0];
        const systemPrompt = await agentDecl.createSystemPrompt(activeMode, task);
        task.setSystemPrompt(systemPrompt);
    }
    ipcMain.handle('node:listExecutionNodes', async () => {
        return { status: 'ok', data: listExecutionNodes() };
    });
    ipcMain.handle('node:setTaskExecutionNode', async (_event, taskId, nodeId) => {
        return await setTaskExecutionNode(taskId, nodeId);
    });
    ipcMain.handle('taskManager:submitMessage', async (event, taskId, details) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        if (details.attachedFilePaths) {
            await task.attachFiles(details.attachedFilePaths);
        }
        if (details.selectedModel) {
            task.model = details.selectedModel;
            task.ensureValidModelOrFallback();
        }
        if (details.reasoningEffort !== undefined) {
            task.reasoningEffort = details.reasoningEffort || undefined;
        }
        if (Object.prototype.hasOwnProperty.call(details, 'selectedExecutionNodeId')) {
            const result = await setTaskExecutionNode(taskId, details.selectedExecutionNodeId ?? null);
            if (result.status !== 'ok') return result;
        }

        const imageDataUris: string[] | undefined =
            Array.isArray(details.attachedImages) && details.attachedImages.length > 0
                ? details.attachedImages
                : undefined;

        task.submitUserMessage(details.message, imageDataUris).catch((err) =>
            logger.error(`submitUserMessage failed for task ${taskId}:`, err)
        );
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:setTaskModel', (_event, taskId, modelAlias) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        if (modelAlias && !Setting.getInstance().getModelInstance(modelAlias)) {
            return { status: 'error', message: `model ${modelAlias} not found` };
        }
        task.model = modelAlias || undefined;
        task.persistLater();
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:stopTask', (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        task.stop();
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:skipRetryDelay', (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        task.skipRetryDelay();
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:getSessionMemory', async (event, taskId) => {
        try {
            const content = await readTaskSessionMemory(taskId);
            if (!content || isSessionMemoryTemplateOnly(content)) {
                return { status: 'ok', data: null };
            }
            const rendered = await marked.parse(content);
            return { status: 'ok', data: { raw: content, rendered } };
        } catch {
            return { status: 'ok', data: null };
        }
    });
    ipcMain.handle('taskManager:getTaskChanges', async (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        try {
            const changes = task.getTaskChanges();
            return { status: 'ok', data: changes };
        } catch (err: any) {
            return { status: 'error', message: err?.message || String(err) };
        }
    });
    ipcMain.handle('taskManager:getModelContextSize', async (event, modelAlias) => {
        try {
            const setting = Setting.getInstance();
            const modelInstance = modelAlias ? setting.getModelInstance(modelAlias) : setting.getDefaultModelInstance();
            if (!modelInstance) {
                return { status: 'ok', data: 0 };
            }
            if (modelInstance.context_length && modelInstance.context_length > 0) {
                return { status: 'ok', data: modelInstance.context_length };
            }
            const knownSize = lookupKnownContextSize(modelInstance.model_name);
            if (knownSize > 0) {
                return { status: 'ok', data: knownSize };
            }
            const apiSize = await fetchContextSizeFromAPI(modelInstance);
            return { status: 'ok', data: apiSize };
        } catch {
            return { status: 'ok', data: 0 };
        }
    });
    // 检查文件是否存在
    ipcMain.handle('fs:fileExists', async (event, filePath) => {
        try {
            const exists = fs.existsSync(filePath);
            return { status: 'ok', data: exists };
        } catch (error: any) {
            logger.error('checking file exists failed', error);
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('fs:trashItem', async (event, itemPath) => {
        try {
            await shell.trashItem(path.resolve(itemPath));
            return { status: 'ok', data: true };
        } catch (error: any) {
            logger.error('trashing item failed', error);
            return { status: 'error', message: error.message };
        }
    });
    // 显示保存文件对话框
    ipcMain.handle('dialog:saveFile', async (event, options) => {
        try {
            const result = await dialog.showSaveDialog(globalMainWindow!, options);
            return { status: 'ok', data: result };
        } catch (error: any) {
            logger.error('showing save dialog failed', error);
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('taskManager:exportTask', async (event, taskId, filePath) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        try {
            await task.render();
            await exportTaskToHtml(task, filePath);
            return { status: 'ok', data: filePath };
        } catch (error: any) {
            logger.error('exporting task failed', error);
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('taskManager:exportTaskToHtml', async (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        try {
            await task.render();
            // 创建一个临时函数来获取 HTML 内容而不写入文件
            const htmlContent = await generateTaskHtml(task);
            return { status: 'ok', data: htmlContent };
        } catch (error: any) {
            logger.error('exporting task failed', error);
            return { status: 'error', message: error.message };
        }
    });
};

const registerFSAPIHandlers = () => {
    (ipcMain.handle('fs:searchFilesByKeyword', async (event, keyword) => {
        try {
            const result = await FSService.searchFilesByKeyword(keyword);
            return { status: 'ok', data: result };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }),
        ipcMain.handle('fs:openFile', async (event, filePath) => {
            if (!filePath) {
                return { status: 'error', message: `file path is required, ${filePath} given` };
            }
            shell.openPath(filePath);
            return { status: 'ok' };
        }));
    ipcMain.handle('fs:dialog-open', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            title: '选择附件',
            properties: ['openFile', 'multiSelections'] // 允许选文件、允许多选
        });

        if (canceled) {
            return []; // 用户取消，返回空数组
        } else {
            // 将 Windows 路径的反斜杠统一替换为正斜杠，保持前后端一致
            return filePaths.map((p) => p.replace(/\\/g, '/'));
        }
    });
    ipcMain.handle('fs:dialog-open-directory', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            title: '选择目录',
            properties: ['openDirectory']
        });

        if (canceled) {
            return null;
        } else {
            return (filePaths[0] || '').replace(/\\/g, '/');
        }
    });
    ipcMain.handle('fs:getPathType', async (event, filePath) => {
        try {
            // 将正斜杠路径转换回系统路径格式（Windows需要反斜杠）
            const systemPath = filePath.replace(/\//g, path.sep);
            const stats = await fs.promises.stat(systemPath);
            if (stats.isFile()) {
                return { status: 'ok', data: 'file' };
            } else if (stats.isDirectory()) {
                return { status: 'ok', data: 'directory' };
            } else {
                return { status: 'ok', data: null };
            }
        } catch (error: any) {
            // 如果路径不存在或无法访问，返回null
            if (error.code === 'ENOENT') {
                return { status: 'ok', data: null };
            }
            return { status: 'error', message: error.message };
        }
    });

    // 列出目录内容（仅一层），用于工作空间文件浏览器的按需展开。
    // 返回条目按：目录在前 + 名称不区分大小写排序。
    ipcMain.handle('fs:listDirectory', async (event, dirPath) => {
        try {
            if (typeof dirPath !== 'string' || dirPath.length === 0) {
                return { status: 'error', message: 'dirPath is required' };
            }
            const systemPath = dirPath.replace(/\//g, path.sep);
            const dirents = await fs.promises.readdir(systemPath, { withFileTypes: true });
            const entries = [];
            for (const d of dirents) {
                // 跳过一些典型噪声项，避免浏览器崩溃或渲染过慢；
                // 这里只对无意义的系统快捷方式做过滤，用户自己的点开头目录仍然保留
                const name = d.name;
                const abs = path.join(systemPath, name);
                let isDirectory = d.isDirectory();
                const isSymbolicLink = d.isSymbolicLink();
                let size = 0;
                let modifiedAt = null;
                try {
                    const st = await fs.promises.stat(abs);
                    // 通过 stat 解析 symlink 指向的真实类型，便于前端显示文件夹 / 文件图标
                    if (isSymbolicLink) {
                        isDirectory = st.isDirectory();
                    }
                    size = st.size;
                    modifiedAt = st.mtimeMs;
                } catch {
                    // 忽略权限/损坏项，仍然列出但不提供尺寸
                }
                entries.push({
                    name,
                    path: abs.replace(/\\/g, '/'),
                    isDirectory,
                    isSymbolicLink,
                    size,
                    modifiedAt
                });
            }
            entries.sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
            });
            return { status: 'ok', data: entries };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    // 读取文本文件内容，用于工作空间预览/编辑面板。
    // maxBytes <= 0 或未提供时不限制体积，直接读取全文。
    ipcMain.handle('fs:readTextFile', async (event, filePath, maxBytes) => {
        try {
            if (typeof filePath !== 'string' || filePath.length === 0) {
                return { status: 'error', message: 'filePath is required' };
            }
            const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
            const systemPath = filePath.replace(/\//g, path.sep);
            const st = await fs.promises.stat(systemPath);
            if (!st.isFile()) {
                return { status: 'error', message: 'not a file' };
            }
            if (limit > 0 && st.size > limit) {
                return {
                    status: 'ok',
                    data: { tooLarge: true, size: st.size, limit, content: '', binary: false }
                };
            }
            const buf = await fs.promises.readFile(systemPath);
            // 粗略判断是否为二进制：包含 NUL 字节即判定为二进制，避免把乱码渲染到预览器
            let binary = false;
            const probe = buf.subarray(0, Math.min(buf.length, 8192));
            for (let i = 0; i < probe.length; i++) {
                if (probe[i] === 0) {
                    binary = true;
                    break;
                }
            }
            return {
                status: 'ok',
                data: {
                    tooLarge: false,
                    size: st.size,
                    limit,
                    content: binary ? '' : buf.toString('utf8'),
                    binary
                }
            };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    // 写入文本文件，供工作空间编辑器保存文件使用。
    ipcMain.handle('fs:writeTextFile', async (_event, filePath: string, content: string) => {
        try {
            if (typeof filePath !== 'string' || filePath.length === 0) {
                return { status: 'error', message: 'filePath is required' };
            }
            if (typeof content !== 'string') {
                return { status: 'error', message: 'content must be a string' };
            }
            const systemPath = filePath.replace(/\//g, path.sep);
            await fs.promises.writeFile(systemPath, content, 'utf8');
            return { status: 'ok', data: true };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    // 将文件路径解析为规范化的绝对路径（使用正斜杠）。
    // 支持：相对路径（基于工作空间根目录）、Windows 反斜杠、~ 展开。
    ipcMain.handle('fs:resolveFilePath', (_event, filePath: string) => {
        try {
            if (typeof filePath !== 'string' || filePath.length === 0) {
                return { status: 'error', message: 'filePath is required' };
            }
            let p = filePath;
            // 展开 ~
            if (p.startsWith('~')) {
                p = path.join(os.homedir(), p.slice(1));
            }
            // 相对路径：基于工作空间根目录解析
            if (!path.isAbsolute(p)) {
                const workspace = Setting.getInstance().getEffectiveWorkspace();
                p = path.resolve(workspace, p);
            } else {
                p = path.resolve(p);
            }
            // 统一使用正斜杠
            return { status: 'ok', data: p.replace(/\\/g, '/') };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
};

const registerSettingAPIHandlers = () => {
    ipcMain.handle('setting:loadSettingSchema', () => {
        try {
            const schema = Setting.getSettingSchema();
            return { status: 'ok', data: z.toJSONSchema(schema) };
        } catch (error: any) {
            logger.error(`error loading setting schema`, error);
            logger.error(error.stack);
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('setting:loadSettingObject', () => {
        return { status: 'ok', data: Setting.getInstance().getData() };
    });
    ipcMain.handle('setting:saveSettingObject', async (event, settingObject) => {
        try {
            const oldSettings = Setting.getInstance().getData();
            const prepared = prepareFileMgrWorkspaceSettings(settingObject, oldSettings);
            Setting.getInstance().setData(prepared.data);
            // 通知 Worker 线程更新设置，使新的模型配置立即生效
            notifyWorkerSettingUpdate(Setting.getInstance().getData());
            try {
                getMainThemeService().applyFromSettings();
            } catch (themeErr) {
                logger.warn('[theme] applyFromSettings after save failed', themeErr);
            }
            // 广播设置变更给所有 renderer 窗口，以便 AgentInput 等组件刷新模型列表
            const updatedData = Setting.getInstance().getData();
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) {
                    win.webContents.send('setting:changed', updatedData);
                }
            }
            if (prepared.shouldNotifyWorkspaceChanged && prepared.defaultWorkspace) {
                try {
                    await ApplicationRegistry.callWorker('filemgr', 'workspaceChanged', prepared.defaultWorkspace);
                } catch (error: any) {
                    logger.warn(`[filemgr] failed to refresh workspace marker: ${error?.message ?? error}`);
                }
            }
            return { status: 'ok' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('quickpass:import', (event, quickpass) => {
        try {
            const cleaned = quickpass.trim().replace(/[\r\n]+/g, '');
            const result = QuickPassHelper.importConfig(cleaned);
            notifyWorkerSettingUpdate(Setting.getInstance().getData());
            return { status: 'ok', data: result };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('quickpass:isQuickPass', (event, text) => {
        try {
            return { status: 'ok', data: QuickPassHelper.isQuickPass(text) };
        } catch {
            return { status: 'ok', data: false };
        }
    });
    ipcMain.handle('quickpass:exportBase', () => {
        try {
            const quickpass = QuickPassHelper.exportBaseConfig();
            return { status: 'ok', data: quickpass };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('quickpass:exportAll', () => {
        try {
            const quickpass = QuickPassHelper.exportAllConfig();
            return { status: 'ok', data: quickpass };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('setting:getProviderTemplates', () => {
        return { status: 'ok', data: PROVIDER_TEMPLATES };
    });
    ipcMain.handle('setting:getGatewayHostOptions', () => {
        return { status: 'ok', data: listGatewayListenHostOptions() };
    });
    ipcMain.handle(
        'setting:verifyModel',
        async (event, { base_url, api_key, provider_type, model_name, custom_headers }) => {
            try {
                const instance = new ModelInstance(
                    model_name,
                    base_url,
                    api_key,
                    false,
                    '',
                    undefined,
                    custom_headers,
                    provider_type
                );
                await LLM.verifyModel(instance);
                return { status: 'ok', data: true };
            } catch (error: any) {
                return { status: 'error', message: error.message || String(error) };
            }
        }
    );
    const joinProviderModelsPath = (baseUrl: string, providerType: string | undefined): string => {
        const trimmed = baseUrl.replace(/\/+$/, '');
        if (providerType === 'anthropic' && !trimmed.endsWith('/v1')) {
            return `${trimmed}/v1/models`;
        }
        return `${trimmed}/models`;
    };

    ipcMain.handle('setting:fetchProviderModels', async (_event, { base_url, api_key, provider_type }) => {
        try {
            const headers: Record<string, string> = {
                Authorization: `Bearer ${api_key}`,
                'Content-Type': 'application/json'
            };
            if (provider_type === 'anthropic') {
                headers['x-api-key'] = api_key;
                headers['anthropic-version'] = '2023-06-01';
            }
            const resp = await getPlatform().fetch(joinProviderModelsPath(base_url, provider_type), {
                headers,
                signal: AbortSignal.timeout(8000)
            });
            if (!resp.ok) {
                return { status: 'ok', data: [] };
            }
            const body = await resp.json();
            const models: any[] = body.data ?? body;
            if (!Array.isArray(models) || models.length > 20) {
                return { status: 'ok', data: [] };
            }
            const names = models
                .map((m: any) => m.id || m.name || '')
                .filter((n: string) => n.length > 0)
                .sort();
            return { status: 'ok', data: names };
        } catch {
            return { status: 'ok', data: [] };
        }
    });
    async function _applyWorkspaceSelection(selectedPath: string) {
        try {
            const oldSettings = Setting.getInstance().getData();
            const nextSettings = { ...oldSettings, default_workspace: selectedPath };
            const prepared = prepareFileMgrWorkspaceSettings(nextSettings, oldSettings);
            Setting.getInstance().setData(prepared.data);
            Setting.getInstance().addRecentWorkspace(selectedPath);
            notifyWorkerSettingUpdate(Setting.getInstance().getData());
            if (prepared.shouldNotifyWorkspaceChanged && prepared.defaultWorkspace) {
                try {
                    await ApplicationRegistry.callWorker('filemgr', 'workspaceChanged', prepared.defaultWorkspace);
                } catch (error: any) {
                    logger.warn(`[filemgr] failed to refresh workspace marker: ${error?.message ?? error}`);
                }
            }
        } catch (err: any) {
            logger.error(`Failed to save workspace selection: ${err.message}`);
            // 继续执行，工作区设置仅在当前会话生效
        }

        // 同步所有已有任务的 harnessContext 到新工作空间
        // 仅更新主任务（parent_id === null）；子任务的 harnessContext 由父任务在创建时决定
        const globalState = GlobalState.getInstance();
        const agentDecl = getGlobalAgentDecl();
        const modes = agentDecl.supportedModes();
        for (const task of globalState.taskManagerState.tasks) {
            if (task.parent_id !== null) continue;
            const modeId = task.activeModeId || _currentElectronModeId || agentDecl.defaultModeId();
            const mode = modes.find((m) => m.id === modeId) ?? modes[0];
            const savedEnv = task.harnessContext.environ;
            const savedExecutionHost = task.harnessContext.executionHost;
            try {
                const ctx = await HarnessContext.createForMode(selectedPath, mode);
                ctx.environ = savedEnv;
                ctx.executionHost = savedExecutionHost;
                ctx.permissionPrompt = task.harnessContext.permissionPrompt || new ElectronPermissionPromptProvider();
                await ctx.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
                task.harnessContext = ctx;
            } catch (err) {
                logger.warn(`Failed to sync task harness for new workspace: ${err}`);
                task.harnessContext.workspace = selectedPath;
            }
        }
    }

    ipcMain.handle('workspace:getEffectiveWorkspace', () => {
        try {
            const workspace = Setting.getInstance().getEffectiveWorkspace();
            return { status: 'ok', data: workspace };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('workspace:openWorkspaceDirectory', async () => {
        try {
            const workspace = Setting.getInstance().getEffectiveWorkspace();
            await shell.openPath(workspace);
            return { status: 'ok' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('workspace:selectWorkspaceDirectory', async () => {
        try {
            const result = await dialog.showOpenDialog(globalMainWindow!, {
                title: '选择工作空间目录',
                properties: ['openDirectory']
            });
            if (result.canceled || result.filePaths.length === 0) {
                return { status: 'ok', data: null };
            }
            const selectedPath = result.filePaths[0].replace(/\\/g, '/');
            await _applyWorkspaceSelection(selectedPath);
            return { status: 'ok', data: selectedPath };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('workspace:setWorkspaceDirectory', async (_event, selectedPath: string) => {
        try {
            await _applyWorkspaceSelection(selectedPath);
            return { status: 'ok', data: selectedPath };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('workspace:getRecentWorkspaces', () => {
        try {
            return { status: 'ok', data: Setting.getInstance().getRecentWorkspaces() };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('workspace:removeRecentWorkspace', (_event, workspacePath: string) => {
        try {
            Setting.getInstance().removeRecentWorkspace(workspacePath);
            return { status: 'ok' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    // 获取 Windows 盘符列表
    ipcMain.handle('workspace:listDrives', async () => {
        try {
            const drives = await getWindowsDrives();
            return { status: 'ok', data: drives };
        } catch (error: any) {
            console.error('Failed to list drives:', error);
            return { status: 'ok', data: [] };
        }
    });
    ipcMain.handle(
        'workspace:listDirectory',
        async (
            _event,
            dirPath: string,
            opts?: { includeFiles?: boolean; extensions?: string[]; showHidden?: boolean }
        ) => {
            try {
                // 支持虚拟根目录路径（用于 Windows 盘符浏览）
                if (dirPath === '{DRIVE_ROOT}') {
                    if (process.platform === 'win32') {
                        const drives = await getWindowsDrives();
                        return { status: 'ok', data: drives };
                    } else {
                        dirPath = '/';
                    }
                }

                const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
                const result: { name: string; path: string; isDirectory: boolean }[] = [];
                for (const entry of entries) {
                    if (!opts?.showHidden && entry.name.startsWith('.')) continue;
                    const fullPath = path.join(dirPath, entry.name).replace(/\\/g, '/');
                    if (entry.isDirectory()) {
                        result.push({ name: entry.name, path: fullPath, isDirectory: true });
                    } else if (opts?.includeFiles) {
                        if (opts.extensions && opts.extensions.length > 0) {
                            const ext = path.extname(entry.name).toLowerCase();
                            if (!opts.extensions.includes(ext)) continue;
                        }
                        result.push({ name: entry.name, path: fullPath, isDirectory: false });
                    }
                }
                result.sort((a, b) => {
                    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
                return { status: 'ok', data: result };
            } catch (error: any) {
                return { status: 'ok', data: [] };
            }
        }
    );
    ipcMain.handle('workspace:renameEntry', async (_event, oldPath: string, newName: string) => {
        try {
            const dir = path.dirname(oldPath);
            const newPath = path.join(dir, newName).replace(/\\/g, '/');
            await fsPromises.rename(oldPath, newPath);
            return { status: 'ok', data: newPath };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('workspace:createDirectory', async (_event, parentPath: string, dirName: string) => {
        try {
            const newPath = path.join(parentPath, dirName).replace(/\\/g, '/');
            await fsPromises.mkdir(newPath, { recursive: false });
            return { status: 'ok', data: newPath };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('workspace:deleteEntry', async (_event, entryPath: string) => {
        try {
            const stat = await fsPromises.stat(entryPath);
            if (stat.isDirectory()) {
                await fsPromises.rm(entryPath, { recursive: true, force: true });
            } else {
                await fsPromises.unlink(entryPath);
            }
            return { status: 'ok' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    (ipcMain.handle('setting:openDevTools', () => {
        if (globalMainWindow === null) {
            return { status: 'error', message: 'main window not found' };
        }
        globalMainWindow.webContents.openDevTools();
        return { status: 'ok' };
    }),
        ipcMain.handle('setting:getLogContent', () => {
            return { status: 'ok', data: converter.toHtml(LogStream.getStream().getContent()) };
        }));
    ipcMain.handle('setting:getLogEntries', (_event: any, options: any) => {
        return { status: 'ok', data: LogStream.getStream().getEntries(options || {}) };
    });
    (ipcMain.handle('setting:closeMainWindow', () => {
        if (globalMainWindow === null) {
            return { status: 'error', message: 'main window not found' };
        }
        globalMainWindow.close();
        return { status: 'ok' };
    }),
        ipcMain.handle('setting:minimizeMainWindow', () => {
            if (globalMainWindow === null) {
                return { status: 'error', message: 'main window not found' };
            }
            globalMainWindow.minimize();
            return { status: 'ok' };
        }),
        ipcMain.handle('setting:maximizeMainWindow', () => {
            if (globalMainWindow === null) {
                return { status: 'error', message: 'main window not found' };
            }
            if (globalMainWindow.isMaximized()) {
                globalMainWindow.unmaximize();
            } else {
                globalMainWindow.maximize();
            }
            return { status: 'ok' };
        }),
        ipcMain.handle('setting:isMaximized', () => {
            if (globalMainWindow === null) {
                return { status: 'error', message: 'main window not found' };
            }
            return { status: 'ok', data: globalMainWindow.isMaximized() };
        }),
        ipcMain.handle('setting:getAppVersion', () => {
            return { status: 'ok', data: app.getVersion() };
        }));
};

const registerDisplayZoomHandlers = () => {
    const readCurrentScale = () => {
        try {
            const val = Setting.getInstance().getData().gui_config?.scale_factor;
            return typeof val === 'number' && Number.isFinite(val) ? val : 1;
        } catch {
            return 1;
        }
    };

    const applyZoom = (factor: number) => {
        if (!globalMainWindow) return;
        if (!Number.isFinite(factor)) factor = 1;
        const clamped = Math.max(0.5, Math.min(2.0, factor));
        globalMainWindow.webContents.setZoomFactor(clamped);
        try {
            const currentData = Setting.getInstance().getData();
            const rounded = Math.round(clamped * 10) / 10;
            Setting.getInstance().setData({
                ...currentData,
                gui_config: { ...(currentData.gui_config || {}), scale_factor: rounded }
            });
        } catch (err: any) {
            logger.warn(`Failed to save zoom setting: ${err.message}`);
            // 继续执行，不阻塞缩放功能
        }
        globalMainWindow.webContents.send('display:scaleFactorChanged', clamped);
    };

    ipcMain.handle('display:getScaleFactor', () => {
        try {
            return { status: 'ok', data: readCurrentScale() };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    ipcMain.handle('display:setScaleFactor', (event, factor) => {
        try {
            applyZoom(factor);
            return { status: 'ok', data: Math.max(0.5, Math.min(2.0, factor)) };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    ipcMain.handle('display:adjustScaleFactor', (event, delta) => {
        try {
            const current = readCurrentScale();
            const next = Math.round((current + delta) * 10) / 10;
            applyZoom(next);
            return { status: 'ok', data: Math.max(0.5, Math.min(2.0, next)) };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
};

const registerNotificationAPIHandlers = () => {
    (ipcMain.handle('notification:sendNotification', (event, ...args) => {
        try {
            NotificationManager.getInstance().sendNotification(...args);
            return { status: 'ok' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    }),
        ipcMain.handle('notification:subscribeNotification', (event) => {
            NotificationManager.getInstance().addSubscriber(event.sender);
            return { status: 'ok' };
        }));
};

const registerScreenAPIHandlers = () => {
    ipcMain.handle('screen:getDisplayScaleFactors', () => {
        try {
            const displays = screen.getAllDisplays();
            const scaleFactors = displays.map((display) => ({
                id: display.id,
                scaleFactor: display.scaleFactor,
                bounds: display.bounds,
                workArea: display.workArea,
                rotation: display.rotation,
                internal: display.internal,
                touchSupport: display.touchSupport
            }));
            return { status: 'ok', data: scaleFactors };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
};

const registerMagicPointerHandlers = () => {
    ipcMain.handle('magicPointer:getCursorPosition', (event) => {
        try {
            const win = BrowserWindow.fromWebContents(event.sender) ?? globalMainWindow;
            if (!win || win.isDestroyed()) {
                return { status: 'error', message: 'no main window' };
            }

            const cursorPoint = screen.getCursorScreenPoint();
            const contentBounds = win.getContentBounds();
            return {
                status: 'ok',
                data: {
                    x: cursorPoint.x - contentBounds.x,
                    y: cursorPoint.y - contentBounds.y,
                    width: contentBounds.width,
                    height: contentBounds.height
                }
            };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    ipcMain.handle('magicPointer:captureWindow', async () => {
        try {
            if (!globalMainWindow) {
                return { status: 'error', message: 'no main window' };
            }
            const image = await globalMainWindow.webContents.capturePage();
            const dataUrl = 'data:image/png;base64,' + image.toPNG().toString('base64');
            return { status: 'ok', data: dataUrl };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    ipcMain.handle('magicPointer:saveScreenshot', async (_event, pngDataUrl: string, _description?: string) => {
        try {
            const desktopPath = app.getPath('desktop');
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
            const fileName = `OpenDesk_MagicPointer_${timestamp}.png`;
            const filePath = path.join(desktopPath, fileName);
            const base64Data = pngDataUrl.replace(/^data:image\/png;base64,/, '');
            await fsPromises.writeFile(filePath, Buffer.from(base64Data, 'base64'));
            return { status: 'ok', data: filePath };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
};

const registerHotKeys = () => {
    let hotkey = 'Alt+Space';
    if (process.platform === 'darwin') {
        hotkey = 'Option+Space';
    }
    const ret = globalShortcut.register(hotkey, () => {
        // todo: 意图理解还没成熟，先显示主窗口
        // openFloatWindow();
        // globalMainWindow.show();
        // globalMainWindow.webContents.send('command:openHomePage');
    });
    if (!ret) {
        logger.warn(`hotkey ${hotkey} register failed, possibly because the hot key is already in use`);
    }
};

const registerTray = () => {
    let icon = nativeImage.createFromPath(appIcon);
    icon = icon.resize({ width: 22, height: 22 });
    const menuitems = [
        {
            label: '打开主窗口',
            click: () => {
                globalMainWindow.show();
            }
        },
        {
            label: '打开开发者工具',
            click: () => {
                globalMainWindow.webContents.openDevTools();
            }
        }
    ];
    if (process.platform !== 'openharmony') {
        menuitems.push({ type: 'separator' });
        menuitems.push({
            label: '退出',
            click: () => {
                app.quit();
            }
        });
    }
    const menu = Menu.buildFromTemplate(menuitems);

    globalTray = new Tray(icon);
    globalTray.setToolTip('OpenDesk | 一站式智慧办公空间');
    globalTray.setContextMenu(menu);
    globalTray.on('click', () => {
        globalMainWindow.show();
    });
};

// 初始化自动更新客户端
let updateClient: UpdateClient | null = null;

const initializeUpdater = () => {
    // 配置多个备选更新服务器地址，按顺序尝试
    // 如果第一个服务器不可用，会自动尝试下一个
    const updateServerUrls = [
        // 如果要进行更新测试，可以把下边这一行注释打开
        // 'http://localhost:3000',
        'https://fillipdesk.uv0xab.com/update'
    ];

    // 只在生产环境启用自动更新，或者设置了 DEBUG_UPDATER 环境变量
    if (!is.dev || process.env.DEBUG_UPDATER) {
        logger.info(`启用自动更新, 当前版本: ${app.getVersion()}`);
        updateClient = new UpdateClient({
            serverUrls: updateServerUrls,
            currentVersion: app.getVersion(),
            checkInterval: 3600000 // 每小时检查一次
        });

        // 延迟检查更新，避免影响应用启动速度
        setTimeout(() => {
            updateClient.checkAndPromptUpdate().catch((error) => {
                logger.error('检查更新失败', error);
            });
        }, 3000); // 3秒后检查
    }
};

const initializeScreenAdaption = () => {
    const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
    logger.info(`屏幕显示参数: ${scaleFactor}`);
    screen.on('display-metrics-changed', (event, display, _changedMetrics) => {
        logger.info(`屏幕显示参数已更改: ${display.scaleFactor}`);
        // 在此处重新计算并调整窗口布局
    });
};

function startApplication() {
    if (app.requestSingleInstanceLock()) {
        app.on('second-instance', (_event, _commandLine) => {
            if (globalMainWindow) {
                globalMainWindow.show();
            }
        });
    } else {
        app.quit();
        process.exit(1);
    }

    // 在 app.whenReady() 之前初始化 Registry 和协议 schemes
    initializeRegistry();
    initializeRegistryProtocols();

    app.on('before-quit', () => {
        isAppQuitting = true;
    });

    // macOS: 点击 Dock 图标时恢复并显示主窗口（解决最小化后点击图标不显示的问题）
    app.on('activate', () => {
        if (globalMainWindow) {
            if (globalMainWindow.isMinimized()) {
                globalMainWindow.restore();
            }
            globalMainWindow.show();
            globalMainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        GlobalState.initialize();
        GlobalState.getInstance().taskManagerState.toolsetProvider = {
            listAvailableToolsets: () => ApplicationRegistry.listAvailableToolsets()
        };
        registerUserPortraitReviewHook({
            taskManagerState: GlobalState.getInstance().taskManagerState,
            initializeReviewTask: initializeUserPortraitReviewTask
        });

        // 为从磁盘恢复的旧任务注入完整的 harnessContext（不落盘，加载后默认为空）
        // getInstance() 已内置容错，不会抛异常
        const startupWorkspace = Setting.getInstance().getEffectiveWorkspace();
        const agentDecl = getGlobalAgentDecl();
        const defaultMode =
            agentDecl.supportedModes().find((m) => m.id === (_currentElectronModeId || agentDecl.defaultModeId())) ??
            agentDecl.supportedModes()[0];
        for (const task of GlobalState.getInstance().taskManagerState.tasks) {
            if (!task.harnessContext.workspace) {
                const savedExecutionHost = task.harnessContext.executionHost;
                try {
                    task.harnessContext = await HarnessContext.createForMode(startupWorkspace, defaultMode);
                    task.harnessContext.executionHost = savedExecutionHost;
                    task.harnessContext.permissionPrompt = new ElectronPermissionPromptProvider();
                    await task.harnessContext.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
                } catch (err) {
                    logger.warn(`Failed to init restored task harness: ${err}`);
                    task.harnessContext.workspace = startupWorkspace;
                }
            }
        }

        // 刷新证书缓存（不依赖 session，直接从文件加载）
        try {
            const browserApp = ApplicationRegistry.getApplication('browser') as any;
            if (browserApp?.constructor?._refreshCertCache) {
                await browserApp.constructor._refreshCertCache();
            }
        } catch (err: any) {
            logger.error(`证书缓存初始化失败: ${err?.message || err}`);
        }

        await initBrowserSession();
        registerRendererFramePreload();

        // 全局证书错误处理：使用内存缓存同步匹配
        app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
            const browserApp = ApplicationRegistry.getApplication('browser') as any;
            const matched = browserApp?.constructor?.matchCachedFingerprint?.(certificate.fingerprint);
            callback(!!matched);
        });

        // 提前注册 exitPlanMode IPC handler，防止 renderer 在任务创建前查询时报错
        new ElectronExitPlanModeProvider();

        createWindow();

        // 系统电源状态监听：休眠/锁屏时通知 renderer 暂停非必要渲染
        powerMonitor.on('suspend', () => {
            logger.info('[power] 系统即将休眠，通知 renderer 暂停渲染');
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) {
                    win.webContents.send('window:visibilityChanged', false);
                }
            }
        });
        powerMonitor.on('resume', () => {
            logger.info('[power] 系统从休眠恢复');
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed() && win.isVisible()) {
                    win.webContents.send('window:visibilityChanged', true);
                }
            }
        });
        // 锁屏时也暂停渲染
        if (process.platform === 'win32') {
            powerMonitor.on('lock-screen', () => {
                for (const win of BrowserWindow.getAllWindows()) {
                    if (!win.isDestroyed()) {
                        win.webContents.send('window:visibilityChanged', false);
                    }
                }
            });
            powerMonitor.on('unlock-screen', () => {
                for (const win of BrowserWindow.getAllWindows()) {
                    if (!win.isDestroyed() && win.isVisible()) {
                        win.webContents.send('window:visibilityChanged', true);
                    }
                }
            });
        }

        // 检查设置加载错误，等待 renderer 加载完成后再发送 IPC 显示模态弹窗
        const loadError = Setting.getLoadError();
        if (loadError && globalMainWindow) {
            const sendError = () => {
                globalMainWindow?.webContents.send('setting:loadError', loadError);
            };
            // 如果页面已加载完成，立即发送；否则等待 did-finish-load 事件
            if (globalMainWindow.webContents.isLoadingMainFrame()) {
                globalMainWindow.webContents.once('did-finish-load', sendError);
            } else {
                // 页面已加载完成，延迟一小段时间确保 renderer 端监听器已注册
                setTimeout(sendError, 100);
            }
            Setting.clearLoadError();
        }

        // 将内置 skills（applications/skills/resources）自动同步到用户 skills 目录（先完成再注册，确保首次对话能发现技能）
        try {
            await installBundledSkillsIfNeeded();
        } catch (err) {
            logger.error('installBundledSkillsIfNeeded error', err);
        }

        initializeScreenAdaption();
        registerBrowserAPIHandlers();
        registerMemoryAPIHandlers();
        registerTaskManagerAPIHandlers();
        registerModeAPIHandlers();
        registerFSAPIHandlers();
        registerSettingAPIHandlers();

        registerApplicationRegistryHandlers(ipcMain);

        // 通用窗口控制 IPC（通过 event.sender 定位当前窗口）
        ipcMain.handle('window:close', async (event) => {
            BrowserWindow.fromWebContents(event.sender)?.close();
        });
        ipcMain.handle('window:minimize', async (event) => {
            BrowserWindow.fromWebContents(event.sender)?.minimize();
        });
        ipcMain.handle('window:maximize', async (event) => {
            const win = BrowserWindow.fromWebContents(event.sender);
            if (win) {
                if (win.isMaximized()) {
                    win.unmaximize();
                } else {
                    win.maximize();
                }
            }
        });
        ipcMain.handle('window:isMaximized', async (event) => {
            const win = BrowserWindow.fromWebContents(event.sender);
            return { status: 'ok', data: win?.isMaximized() ?? false };
        });

        // 在新窗口中打开应用
        ipcMain.handle('application:openInNewWindow', async (_event, bundleName: string) => {
            try {
                const appConfig = ApplicationRegistry.getApplicationGUIConfig(bundleName) as
                    | Record<string, unknown>
                    | undefined;
                const appName = (appConfig?.name as string) || bundleName;

                const appWindow = new BrowserWindow({
                    width: 1100,
                    height: 680,
                    minWidth: 480,
                    minHeight: 320,
                    frame: false,
                    icon: appIcon,
                    title: appName,
                    show: false,
                    paintWhenInitiallyHidden: true,
                    webPreferences: {
                        nodeIntegration: false,
                        nodeIntegrationInSubFrames: true,
                        contextIsolation: true,
                        webviewTag: true,
                        allowRunningInsecureContent: true,
                        backgroundThrottling: true,
                        preload: getRendererPreloadPath()
                    }
                });

                installWebviewHostHandlers(appWindow);
                appWindow.setMenu(null);
                appWindow.once('ready-to-show', () => {
                    appWindow.show();
                });

                // 统一加载壳页面，由壳页面根据 app 类型决定 iframe 内容
                if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
                    const baseUrl = process.env['ELECTRON_RENDERER_URL'];
                    const appUrl = new URL('application_window.html', baseUrl);
                    appUrl.searchParams.set('applicationBundleName', bundleName);
                    await appWindow.loadURL(appUrl.toString());
                } else {
                    const baseDir = path.join(__dirname, '..', 'renderer');
                    await appWindow.loadFile(path.join(baseDir, 'application_window.html'), {
                        query: { applicationBundleName: bundleName }
                    });
                }

                return { status: 'ok' };
            } catch (error) {
                logger.error(`Failed to open app in new window: ${error}`);
                return { status: 'error', message: String(error) };
            }
        });

        registerNativeBridge();
        registerNotificationAPIHandlers();
        registerScreenAPIHandlers();
        registerMagicPointerHandlers();
        registerDisplayZoomHandlers();
        registerThemeHandlers();
        getMainThemeService().init();
        registerHotKeys();
        registerTray();

        migrateFileMgrWorkspaceSettingsOnStartup();

        // Restore saved zoom level
        try {
            const savedScale = Setting.getInstance().getData().gui_config?.scale_factor;
            if (typeof savedScale === 'number' && Number.isFinite(savedScale) && savedScale !== 1 && globalMainWindow) {
                globalMainWindow.webContents.setZoomFactor(Math.max(0.5, Math.min(3.0, savedScale)));
            }
        } catch {
            /* ignore */
        }
        initializeRegistryWorker();
        initializeProtocolHandlers();
        initializeUpdater();

        ApplicationRegistry.onReady(async () => {
            const channelMgrApp = ApplicationRegistry.getApplication('channelmgr') as ChannelMgrApplication | undefined;
            if (channelMgrApp) {
                const agentDecl = getGlobalAgentDecl();
                const router = new ChannelMessageRouter(
                    GlobalState.getInstance().taskManagerState,
                    agentDecl,
                    startupWorkspace
                );

                const CHANNEL_NAMES: Record<string, string> = {
                    feishu: '飞书',
                    'openclaw-weixin': '微信',
                    whatsapp: 'WhatsApp',
                    zalouser: 'Zalo',
                    telegram: 'Telegram',
                    discord: 'Discord',
                    slack: 'Slack',
                    signal: 'Signal'
                };

                router.onTaskResolved = (task, message) => {
                    const channelName = CHANNEL_NAMES[message.channelId] || message.channelId;
                    const senderLabel = message.senderName || '新联系人';
                    const preview =
                        (message.text || '').length > 60
                            ? (message.text || '').slice(0, 57) + '...'
                            : message.text || '';

                    NotificationManager.getInstance().info(
                        channelName,
                        `${senderLabel} 的${channelName}消息`,
                        preview || '(无文本内容)'
                    );

                    // 自动切换到渠道消息对应的任务会话
                    if (globalMainWindow) {
                        globalMainWindow.show();
                        globalMainWindow.webContents.send('command:openTask', task.task_id);
                    }
                };

                await channelMgrApp.initializeChannels(router, startupWorkspace);
                logger.info('[electron] channelmgr 消息路由已初始化');
            }
        });
    });

    app.on('will-quit', async () => {
        globalShortcut.unregisterAll();
        if (updateClient) {
            updateClient.stopAutoCheck();
        }
        try {
            await GlobalState.getInstance().taskManagerState.flushAllPendingSaves();
        } catch {
            /* best-effort flush */
        }

        // 通知所有应用准备退出
        for (const app of ApplicationRegistry.applications.values()) {
            try {
                await app.beforeExit();
            } catch {
                /* best-effort */
            }
        }

        if (BrowserManager.browserSession) {
            try {
                await BrowserManager.persistSessionCookies();
            } catch {
                /* best-effort persist */
            }
            try {
                await BrowserManager.browserSession.cookies.flushStore();
            } catch {
                /* best-effort flush */
            }
            try {
                BrowserManager.browserSession.flushStorageData();
            } catch {
                /* best-effort flush */
            }
        }
        closeTempDir();
    });
}

startApplication();
