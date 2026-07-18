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
    Menu,
    dialog,
    screen,
    session,
    powerMonitor,
    powerSaveBlocker
} from 'electron';
import {
    Setting,
    ModelInstance,
    getOpendeskDirectory,
    getTaskDirectory,
    getTaskArtifactDirectory
} from './utils/setting.js';
import { QuickPassHelper } from './utils/quickpass.js';
import { getWindowsDrives } from './utils/drives.js';
import { cleanPathInput } from '../utils/path.js';
import { PROVIDER_TEMPLATES } from './tui/components/config/providers.js';
import { GlobalState } from './aikernel/states/global.js';
import { BaseToolset } from './aikernel/tool';
import { is } from '@electron-toolkit/utils';
import { z } from 'zod';
import { NotificationManager } from './utils/notificationmgr.js';
import { LogStream, logger, useConsoleTransport, dropDeprecatedLogs } from './utils/logger.js';
import { safeSendToWebContents, safeSendToWebFrame } from './utils/electron-ipc.js';
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
import { readUserPortrait } from './aikernel/memory/user_portrait.js';
import { registerMemoryReviewHook } from './aikernel/memory/review.js';
import { FactorialMemoryStore } from './aikernel/memory/store.js';
import { getUsageDashboardSummary, getUsageRankings, type RankPeriod } from './telemetry/index.js';
import { initTelemetry, shutdownTelemetry, reloadTelemetry, withSpan } from './telemetry/index.js';
import { StartupTrace } from './telemetry/startup-tracer.js';
import { registerGoalHooks } from './aikernel/goal/hooks.js';
import { initializeHarnesses } from './aikernel/harnesses/index.js';
import { GoalController } from './aikernel/goal/controller.js';
import { GoalService } from './aikernel/goal/service.js';
import type { GoalCommandResult } from './aikernel/goal/state.js';
import { parseGoalEditIfMatch } from '../common/goal/command.js';
import { marked } from './aikernel/messages.js';
import { lookupKnownContextSize, lookupKnownVisionSupport, fetchContextSizeFromAPI } from './utils/model-context.js';
import { fetchModelUrl } from './utils/model-network.js';
import { LLM } from './aikernel/llm.js';
import { BrowserManager, setCDPLogger } from '../common/embedBrowserUse/main';
import { openDeskScriptGenerators } from './applications/browser/utils.js';
import { Channels as EmbedBrowserChannels } from '../common/embedBrowserUse/protocol';
import { registerNativeBridge, resolveNativeBridge } from '../platforms/bridges/main.js';
import { listGatewayListenHostOptions } from './applications/devicemgr/common.js';
import { getExecutionNode, listExecutionNodes } from './applications/devicemgr/execution.js';
import type { TaskState } from './aikernel/states/tasks.js';
import { getLocale, t } from '../locale/index.js';
import { getAttachmentFileSupport, UnsupportedAttachmentFileTypeError } from './aikernel/attachment-support.js';

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

async function initializeMemoryReviewTask(task: TaskState): Promise<void> {
    const workspace = Setting.getInstance().getEffectiveWorkspace();
    const agent = getGlobalAgentDecl();
    const modes = agent.supportedModes();
    const mode = modes.find((m) => m.id === (_currentElectronModeId || agent.defaultModeId())) ?? modes[0];
    await GlobalState.getInstance().taskManagerState.initHarness(task, workspace, mode);
}

function publishTaskTodosCleared(taskIds: Iterable<string>): void {
    const seen = new Set(taskIds);
    for (const taskId of seen) {
        ApplicationRegistry.dispatchEvent('todomgr', 'taskTodosUpdated', { taskId, todos: [] });
    }
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

    // Electron net.fetch() 遇到越界 HTTP 状态码（如 LinkedIn 返回 999）。
    // 降级为 warning，不弹出 FATAL 对话框，不退出进程。
    if (err instanceof RangeError && err.stack?.includes('initializeResponse')) {
        logger.warn(`[RECOVERABLE] Out-of-range HTTP status code: ${err.message}`);
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

function getPreferredSystemLanguagesForLocale(): string[] {
    try {
        const languages = app.getPreferredSystemLanguages();
        return Array.isArray(languages) ? languages : [];
    } catch {
        return [];
    }
}

async function notifyWorkerCurrentSettingUpdate(): Promise<void> {
    await notifyWorkerSettingUpdate(Setting.getInstance().getData(), {
        preferredSystemLanguages: getPreferredSystemLanguagesForLocale()
    });
}

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
                try {
                    browserApp?.handleDownload(item, webContents);
                } catch (err: any) {
                    logger.error(`browser will-download handler failed: ${err?.stack || err?.message || err}`);
                    try {
                        item?.cancel?.();
                    } catch {
                        /* ignore */
                    }
                }
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
        // getPreloadScripts / registerPreloadScript 是 Electron 39+ 才引入的 API，
        // 部分平台（如鸿蒙）的 Electron 版本可能不支持，需做能力检测
        if (typeof (session.defaultSession as any).getPreloadScripts !== 'function') {
            logger.info('Frame preload API not available on this platform, skipping');
            return;
        }
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
                safeSendToWebContents(hostWindow.webContents, EmbedBrowserChannels.popupBlocked, url, webContents.id);
            }
            return { action: 'deny' };
        });

        // 当 webview guest 页面调用 window.close()（如 OAuth 完成后），
        // 通知 renderer 关闭对应 tab。
        webContents.on('close', () => {
            if (hostWindow.isDestroyed()) return;
            safeSendToWebContents(hostWindow.webContents, EmbedBrowserChannels.webviewCloseRequested, webContents.id);
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

            safeSendToWebContents(hostWindow.webContents, 'webview:keyboard-event', {
                type: input.type, // 'keyDown' | 'keyUp'
                key: input.key,
                code: input.code,
                modifiers: input.modifiers // e.g. ['meta'], ['control','shift']
            });
        });
    });
}

const DEFAULT_WINDOW_WIDTH = 1600;
const DEFAULT_WINDOW_HEIGHT = 1080;

/**
 * 检查保存的窗口 bounds 是否在某个屏幕可见范围内（至少 100px 可见）。
 * 如果所有显示器都已断开/配置变更导致窗口完全不可见，返回 false。
 */
function isValidWindowBounds(bounds: { x: number; y: number; width: number; height: number }): boolean {
    const displays = screen.getAllDisplays();
    const winRight = bounds.x + bounds.width;
    const winBottom = bounds.y + bounds.height;
    const MIN_VISIBLE = 100;
    return displays.some((d) => {
        const overlapX = Math.min(winRight, d.bounds.x + d.bounds.width) - Math.max(bounds.x, d.bounds.x);
        const overlapY = Math.min(winBottom, d.bounds.y + d.bounds.height) - Math.max(bounds.y, d.bounds.y);
        return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
    });
}

/**
 * 获取默认窗口 bounds：以给定尺寸在首选显示器上居中。
 * 如果默认尺寸超过屏幕工作区，则限制为屏幕工作区尺寸。
 */
function getDefaultCenteredBounds(
    width: number,
    height: number
): { x: number; y: number; width: number; height: number } {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { x: screenX, y: screenY, width: screenWidth, height: screenHeight } = primaryDisplay.workArea;
    // 如果默认尺寸超过屏幕工作区，则限制为屏幕工作区尺寸
    const actualWidth = Math.min(width, screenWidth);
    const actualHeight = Math.min(height, screenHeight);
    return {
        x: Math.round(screenX + (screenWidth - actualWidth) / 2),
        y: Math.round(screenY + (screenHeight - actualHeight) / 2),
        width: actualWidth,
        height: actualHeight
    };
}

const createWindow = () => {
    // 尝试恢复上次保存的窗口尺寸与位置，无效或未保存时回退默认尺寸居中
    let savedBounds: { x: number; y: number; width: number; height: number } | null = null;
    let windowX: number | undefined;
    let windowY: number | undefined;
    let windowWidth = DEFAULT_WINDOW_WIDTH;
    let windowHeight = DEFAULT_WINDOW_HEIGHT;
    try {
        const guiConfig = Setting.getInstance().getData().gui_config as Record<string, unknown>;
        const bounds = guiConfig.window_bounds as { x: number; y: number; width: number; height: number } | null;
        if (bounds && isValidWindowBounds(bounds)) {
            savedBounds = bounds;
            const targetDisplay = screen.getDisplayMatching(bounds);
            windowX = bounds.x;
            windowY = bounds.y;
            windowWidth = Math.min(bounds.width, targetDisplay.workArea.width);
            windowHeight = Math.min(bounds.height, targetDisplay.workArea.height);
        } else {
            const defaultBounds = getDefaultCenteredBounds(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT);
            windowX = defaultBounds.x;
            windowY = defaultBounds.y;
            windowWidth = defaultBounds.width;
            windowHeight = defaultBounds.height;
        }
    } catch {
        const defaultBounds = getDefaultCenteredBounds(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT);
        windowX = defaultBounds.x;
        windowY = defaultBounds.y;
        windowWidth = defaultBounds.width;
        windowHeight = defaultBounds.height;
    }

    const mainWindow = new BrowserWindow({
        x: windowX,
        y: windowY,
        width: windowWidth,
        height: windowHeight,
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
        // per-monitor DPI 下 BrowserWindow 构造时的 bounds 可能被错误缩放，
        // 在窗口已确定最终显示器（DPI 已就绪）后用 setBounds 精确修正
        if (savedBounds) {
            mainWindow.setBounds(savedBounds);
        }
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
        safeSendToWebContents(mainWindow.webContents, 'magicPointer:forceExit');
    };

    mainWindow.on('blur', forceExitMagicPointer);
    mainWindow.on('hide', forceExitMagicPointer);
    mainWindow.on('minimize', forceExitMagicPointer);

    mainWindow.on('close', (event) => {
        if (!isAppQuitting) {
            // 如果不是应用要退出，仅仅是窗口关闭，则拦截并隐藏
            event.preventDefault();
            mainWindow.hide();
        } else {
            // 应用退出时保存窗口 normal bounds，下次启动恢复
            try {
                const bounds = mainWindow.getNormalBounds();
                const setting = Setting.getInstance();
                const data = setting.getData() as Record<string, unknown>;
                const guiConfig = (data.gui_config ?? {}) as Record<string, unknown>;
                guiConfig.window_bounds = {
                    x: bounds.x,
                    y: bounds.y,
                    width: bounds.width,
                    height: bounds.height
                };
                setting.setData(data);
            } catch {
                /* best-effort */
            }
        }
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
        void getPlatform()
            .openExternal(url)
            .catch((error) => {
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
                safeSendToWebContents(mainWindow.webContents, EmbedBrowserChannels.popupBlocked, url, webContents.id);
            }
            return { action: 'deny' };
        });

        // 当 webview guest 页面调用 window.close()（如 OAuth 完成后），
        // 通知 renderer 关闭对应 tab。
        webContents.on('close', () => {
            if (mainWindow.isDestroyed()) return;
            safeSendToWebContents(mainWindow.webContents, EmbedBrowserChannels.webviewCloseRequested, webContents.id);
        });

        // 将 webview 中的键盘事件转发给主 renderer，使快捷键和 magic pointer
        // 在 webview 获得焦点时仍能正常工作。
        webContents.on('before-input-event', (_evt, input) => {
            if (mainWindow.isDestroyed()) return;
            safeSendToWebContents(mainWindow.webContents, 'webview:keyboard-event', {
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
        safeSendToWebContents(mainWindow.webContents, 'window:visibilityChanged', false);
    });
    mainWindow.on('show', () => {
        safeSendToWebContents(mainWindow.webContents, 'window:visibilityChanged', true);
    });
    mainWindow.on('minimize', () => {
        safeSendToWebContents(mainWindow.webContents, 'window:visibilityChanged', false);
    });
    mainWindow.on('restore', () => {
        safeSendToWebContents(mainWindow.webContents, 'window:visibilityChanged', true);
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

    ipcMain.handle('memory:listMemories', async () => {
        try {
            const registry = FactorialMemoryStore.getInstance(Setting.getInstance().getEffectiveWorkspace());
            const memories = await registry.listAllMemories();
            return {
                status: 'ok',
                data: memories.map(({ scope, chunk }) => ({
                    scope,
                    ...chunk
                }))
            };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });
};

const registerUsageAPIHandlers = () => {
    const startOfLocalDay = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const startOfLocalWeek = (date: Date): Date => {
        const start = startOfLocalDay(date);
        const daysSinceMonday = (start.getDay() + 6) % 7;
        start.setDate(start.getDate() - daysSinceMonday);
        return start;
    };
    const countTasksCreatedBetween = (start: Date, end: Date): number => {
        const taskManagerState = GlobalState.getInstance().taskManagerState;
        return taskManagerState.tasks.filter((task) => {
            const createdAt = task.created_at;
            return createdAt >= start && createdAt < end;
        }).length;
    };

    ipcMain.handle('usage:getDashboardSummary', async (_event, params?: { rankPeriod?: RankPeriod }) => {
        try {
            const now = new Date();
            const summary = await getUsageDashboardSummary({ rankLimit: 30, now, rankPeriod: params?.rankPeriod });
            const taskManagerState = GlobalState.getInstance().taskManagerState;
            const todayStart = startOfLocalDay(now);
            const tomorrowStart = new Date(todayStart.getTime());
            tomorrowStart.setDate(tomorrowStart.getDate() + 1);
            const weekStart = startOfLocalWeek(todayStart);
            summary.today.task_count = countTasksCreatedBetween(todayStart, tomorrowStart);
            summary.week.task_count = countTasksCreatedBetween(weekStart, tomorrowStart);

            const existingRankItems: typeof summary.month_top_tasks = [];
            for (const item of summary.month_top_tasks) {
                const task = taskManagerState.getTask(item.task_id);
                if (!task) {
                    continue;
                }
                existingRankItems.push({
                    ...item,
                    task_name: task.task_name || item.task_name
                });
                if (existingRankItems.length >= 10) {
                    break;
                }
            }
            summary.month_top_tasks = existingRankItems;
            return { status: 'ok', data: summary };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    ipcMain.handle('usage:getRankings', async (_event, params?: { rankPeriod?: RankPeriod }) => {
        try {
            const rankings = await getUsageRankings(params?.rankPeriod ?? 'month', 30);
            const taskManagerState = GlobalState.getInstance().taskManagerState;
            const enrichedTasks: typeof rankings.tasks = [];
            for (const item of rankings.tasks) {
                const task = taskManagerState.getTask(item.task_id);
                if (!task) {
                    continue;
                }
                enrichedTasks.push({
                    ...item,
                    task_name: task.task_name || item.task_name
                });
                if (enrichedTasks.length >= 10) {
                    break;
                }
            }
            rankings.tasks = enrichedTasks;
            return { status: 'ok', data: rankings };
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
        // 如果没有指定执行节点，使用全局默认值
        let initialNodeId = normalizeExecutionNodeId(options.selectedExecutionNodeId);
        if (!initialNodeId) {
            initialNodeId = globalState.getDefaultExecutionNodeId();
        }
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
            task.workspace = workspace;
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
                        safeSendToWebContents(w.webContents, 'mode:taskModeChanged', task.task_id, targetModeId);
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
            task.workspace = workspace;
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
            const triggered = await task.hooks.noticeTaskReview(task, 0);
            return { status: 'ok', data: { triggered } };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });
    ipcMain.handle('taskManager:removeTask', (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }

        const removedTaskIds = globalState.taskManagerState.removeTask(taskId);
        publishTaskTodosCleared(removedTaskIds);
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
    ipcMain.handle('taskManager:compactTask', async (_event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        try {
            const compacted = await task.manualCompact();
            task._dirty = true;
            globalState.taskManagerState.save();
            return { status: 'ok', data: { compacted } };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`Compact failed for task ${taskId}: ${msg}`);
            return { status: 'error', message: msg };
        }
    });
    ipcMain.handle('taskManager:renameTask', (event, taskId, newName) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        task.rename(newName);
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:updateTaskWorkspace', async (_event, taskId, newWorkspace) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        try {
            const agentDecl = getGlobalAgentDecl();
            const modes = agentDecl.supportedModes();
            const modeId = task.activeModeId || _currentElectronModeId || agentDecl.defaultModeId();
            const mode = modes.find((m) => m.id === modeId) ?? modes[0];
            const savedEnv = task.harnessContext.environ;
            const savedExecutionHost = task.harnessContext.executionHost;
            const savedPrompt = task.harnessContext.permissionPrompt;
            const ctx = await HarnessContext.createForMode(newWorkspace, mode);
            ctx.environ = savedEnv;
            ctx.executionHost = savedExecutionHost;
            ctx.permissionPrompt = savedPrompt || new ElectronPermissionPromptProvider();
            await ctx.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
            task.harnessContext = ctx;
            task.workspace = newWorkspace;
            task.persistLater();
            return { status: 'ok' };
        } catch (err: any) {
            logger.error(`Failed to update task workspace: ${err?.message ?? err}`);
            return { status: 'error', message: err?.message ?? String(err) };
        }
    });
    ipcMain.handle('taskManager:clearAllTasks', () => {
        const removedTaskIds = globalState.taskManagerState.clearAllTasks();
        publishTaskTodosCleared(removedTaskIds);
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:getTaskInfo', async (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        const taskJsonPath = path.join(getTaskDirectory(), `${taskId}.json`);
        return {
            status: 'ok',
            data: {
                task_id: task.task_id,
                task_name: task.task_name,
                task_status: task.task_status,
                task_json_path: taskJsonPath,
                model: task.model,
                parent_id: task.parent_id
            }
        };
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
    ipcMain.handle('taskManager:getGoalStatus', async (_event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        return { status: 'ok', data: GoalController.getStatus(task) };
    });
    ipcMain.handle('taskManager:createGoal', async (_event, taskId, objective) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        const hasUnfinishedGoal =
            task.goal_state && task.goal_state.status !== 'complete' && task.goal_state.status !== 'cleared';
        if (hasUnfinishedGoal) {
            return {
                status: 'ok',
                data: {
                    ok: false,
                    status: task.goal_state.status,
                    messageKey: 'goal.create.requires_clear',
                    errorCode: 'goal_exists'
                }
            };
        }
        const input = {
            objective: String(objective ?? ''),
            source: 'gui' as const
        };
        const result = await GoalService.create(task, input, { projectDisplayMessage: true });
        const response: GoalCommandResult =
            result.ok === false && result.errorCode === 'task_running' && task.goal_state?.status === 'active'
                ? {
                      ok: true,
                      status: task.goal_state.status,
                      summary: GoalController.getStatus(task).summary,
                      startedScheduler: false
                  }
                : result;
        if (response.clearedTaskTodos) {
            publishTaskTodosCleared([taskId]);
        }
        return {
            status: 'ok',
            data: response
        };
    });
    ipcMain.handle('taskManager:editGoal', async (_event, taskId, objective, options) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        const rawIfMatch =
            options && typeof options === 'object' && !Array.isArray(options)
                ? (options as Record<string, unknown>).ifMatch
                : undefined;
        const ifMatch = parseGoalEditIfMatch(rawIfMatch);
        if (rawIfMatch !== undefined && !ifMatch) {
            return {
                status: 'ok',
                data: {
                    ok: false,
                    messageKey: 'goal.edit.invalid_precondition',
                    errorCode: 'invalid_goal_precondition'
                } satisfies GoalCommandResult
            };
        }
        return {
            status: 'ok',
            data: await GoalService.edit(task, String(objective ?? ''), 'gui', {
                projectDisplayMessage: true,
                ...(ifMatch ? { ifMatch } : {})
            })
        };
    });
    ipcMain.handle('taskManager:addGoalSupplement', async (_event, taskId, content) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        return {
            status: 'ok',
            data: GoalService.addSupplement(task, {
                content: String(content ?? ''),
                source: 'gui'
            })
        };
    });
    ipcMain.handle('taskManager:pauseGoal', async (_event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        return {
            status: 'ok',
            data: await GoalService.pause(task, 'gui')
        };
    });
    ipcMain.handle('taskManager:resumeGoal', async (_event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        return {
            status: 'ok',
            data: await GoalService.resume(task, {
                source: 'gui'
            })
        };
    });
    ipcMain.handle('taskManager:clearGoal', async (_event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        const result = await GoalService.clear(task, 'gui');
        ApplicationRegistry.dispatchEvent('todomgr', 'taskTodosUpdated', {
            taskId,
            todos: getTaskTodosForDisplay(taskId)
        });
        return { status: 'ok', data: result };
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
    ipcMain.handle('taskManager:unsubscribeTaskListUpdate', (_event, subscriptionId) => {
        return { status: 'ok', data: globalState.taskManagerState.removeSubscriber(subscriptionId) };
    });
    ipcMain.on('taskManager:unsubscribeTaskListUpdate', (_event, subscriptionId) => {
        globalState.taskManagerState.removeSubscriber(subscriptionId);
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
                    const sent = safeSendToWebFrame(
                        senderFrame,
                        `taskManager:callTool`,
                        taskId,
                        toolCallId,
                        toolset.name,
                        tool.name,
                        args
                    );
                    if (!sent) {
                        clearTimeout(timeout);
                        ipcMain.removeAllListeners(`taskManager:reportToolCallResult:${toolCallId}`);
                        resolve({ status: 'error', message: `Renderer tool ${tool.name} target frame unavailable` });
                    }
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
    ipcMain.handle('node:setDefaultExecutionNode', async (_event, nodeId: string | null, label?: string) => {
        globalState.setDefaultExecutionNode(nodeId ?? '', label ?? '');
        return { status: 'ok' };
    });
    ipcMain.handle('node:getDefaultExecutionNode', async () => {
        return {
            status: 'ok',
            data: {
                nodeId: globalState.getDefaultExecutionNodeId(),
                label: globalState.getDefaultExecutionNodeLabel()
            }
        };
    });
    ipcMain.handle('taskManager:getAttachmentFileSupport', () => {
        return { status: 'ok', data: getAttachmentFileSupport() };
    });
    ipcMain.handle('taskManager:submitMessage', async (event, taskId, details) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        if (details.attachedFilePaths) {
            try {
                await task.attachFiles(details.attachedFilePaths);
            } catch (err) {
                if (err instanceof UnsupportedAttachmentFileTypeError) {
                    const extensions = [
                        ...new Set(
                            err.unsupportedFiles.map((file) =>
                                file.extension
                                    ? `.${file.extension}`
                                    : t('renderer.agentInput.unsupportedFile.noExtension')
                            )
                        )
                    ].join(', ');
                    const supportedExtensions = err.supportedExtensions.map((extension) => `.${extension}`).join(', ');
                    return {
                        status: 'error',
                        message: t('renderer.agentInput.unsupportedFile.message', {
                            extensions,
                            supportedExtensions
                        })
                    };
                }
                throw err;
            }
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

        await task.submitUserMessage(details.message, imageDataUris);
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:rewindToUserMessage', async (_event, taskId, messageId, options) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        try {
            const result = await task.rewindToUserMessage(messageId, {
                resubmit: options?.resubmit === true
            });
            return { status: 'ok', data: result };
        } catch (err: any) {
            return { status: 'error', message: err?.message || String(err) };
        }
    });
    ipcMain.handle('taskManager:setTaskModel', (_event, taskId, modelAlias) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        if (modelAlias && !Setting.getInstance().getModelInstance(modelAlias, 'chat')) {
            return { status: 'error', message: t('error.model.chat_alias_not_found', { alias: modelAlias }) };
        }
        task.model = modelAlias || undefined;
        task.persistLater();
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:stopTask', async (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        if (task.goal_state?.status === 'active') {
            return { status: 'ok', data: await GoalService.stopActiveGoal(task, 'gui') };
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
            const modelInstance = modelAlias
                ? setting.getModelInstance(modelAlias, 'chat')
                : setting.getDefaultModelInstance();
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
            await getPlatform().trashItem(path.resolve(itemPath));
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
            await getPlatform().openPath(filePath);
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
            // 清理不可见的 Unicode 字符和首尾空白，避免 path.isAbsolute 误判
            p = cleanPathInput(p);
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
    const withResolvedLocale = (data: any) => ({
        ...data,
        resolved_locale: getLocale()
    });

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
        return { status: 'ok', data: withResolvedLocale(Setting.getInstance().getData()) };
    });

    ipcMain.handle('model:checkVisionSupport', (_event, models) => {
        if (!Array.isArray(models)) {
            return {};
        }
        const result: Record<string, boolean> = {};
        for (const m of models) {
            if (m.alias && m.model_name) {
                const vision = lookupKnownVisionSupport(m.model_name);
                if (vision !== undefined) {
                    result[m.alias] = vision;
                }
                // 如果内置表查不到，默认悲观认为不支持视觉
            }
        }
        return result;
    });

    const embeddingConfigFingerprint = (data: any): string => {
        const alias = data?.default_embedding_model || '';
        const model = (data?.models || []).find((item: any) => item.alias === alias);
        const provider = (data?.providers || []).find((item: any) => item.name === model?.provider_name);
        return JSON.stringify({
            alias,
            model_type: model?.model_type || 'chat',
            model_name: model?.model_name || '',
            provider_name: model?.provider_name || '',
            custom_headers: model?.custom_headers || {},
            provider_type: provider?.provider_type || 'openai',
            base_url: provider?.base_url || '',
            api_key: provider?.api_key || '',
            no_proxy: !!provider?.no_proxy,
            no_ssl: !!provider?.no_ssl
        });
    };

    const notifyFileMgrEmbeddingConfigChanged = async (oldSettings: any, newSettings: any): Promise<void> => {
        if (embeddingConfigFingerprint(oldSettings) === embeddingConfigFingerprint(newSettings)) {
            return;
        }
        try {
            await ApplicationRegistry.callWorker('filemgr', 'embeddingConfigChanged');
        } catch (error: any) {
            logger.warn(`[filemgr] failed to sync embedding config change: ${error?.message ?? error}`);
        }
    };

    ipcMain.handle('setting:saveSettingObject', async (event, settingObject) => {
        try {
            const oldSettings = Setting.getInstance().getData();
            const prepared = prepareFileMgrWorkspaceSettings(settingObject, oldSettings);
            Setting.getInstance().setData(prepared.data);
            // 模型配置可能已变更，清理 adapter 缓存使旧连接池释放
            LLM.clearAdapterCache();
            // 通知 Worker 线程更新设置，使新的模型配置立即生效
            await notifyWorkerCurrentSettingUpdate();
            await notifyFileMgrEmbeddingConfigChanged(oldSettings, Setting.getInstance().getData());
            try {
                getMainThemeService().applyFromSettings();
            } catch (themeErr) {
                logger.warn('[theme] applyFromSettings after save failed', themeErr);
            }
            // 遥测配置变更时热重载 OTel SDK
            const oldTelemetryJson = JSON.stringify(oldSettings?.telemetry);
            const newTelemetryJson = JSON.stringify(Setting.getInstance().getData().telemetry);
            if (oldTelemetryJson !== newTelemetryJson) {
                void reloadTelemetry().catch((err) => logger.warn('[telemetry] hot reload failed', err));
            }
            // 广播设置变更给所有 renderer 窗口，以便 AgentInput 等组件刷新模型列表
            const updatedData = withResolvedLocale(Setting.getInstance().getData());
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) {
                    safeSendToWebContents(win.webContents, 'setting:changed', updatedData);
                }
            }

            // 试验性功能开关或安全网关总开关变更时启动/停止 AgentGate Bridge
            const oldExpFeature = !!oldSettings?.debug?.experimental_feature;
            const newExpFeature = !!updatedData?.debug?.experimental_feature;
            const oldAgEnabled = oldSettings?.applications?.agentgate?.enabled !== false;
            const newAgEnabled = updatedData?.applications?.agentgate?.enabled !== false;
            const oldShouldRun = oldExpFeature && oldAgEnabled;
            const newShouldRun = newExpFeature && newAgEnabled;
            if (oldShouldRun !== newShouldRun) {
                try {
                    const { AgentGateBridge } = await import('./services/agent-gate-bridge');
                    const bridge = AgentGateBridge.getInstance();
                    if (newShouldRun && !bridge.isRunning()) {
                        logger.info(
                            '[electron] AgentGate bridge starting (experimental feature & master switch enabled)'
                        );
                        await bridge.start(Setting.getInstance());
                    } else if (!newShouldRun && bridge.isRunning()) {
                        logger.info(
                            '[electron] AgentGate bridge stopping (experimental feature or master switch disabled)'
                        );
                        bridge.stop();
                    }
                } catch (err) {
                    logger.warn(`AgentGate bridge toggle failed: ${err}`);
                }
            }

            // 浮窗开关变更时启动/停止 AgentGate 事件缓存轮询
            const oldFloatingEnabled = oldSettings?.applications?.agentgate?.floatingWindowEnabled === true;
            const newFloatingEnabled = updatedData?.applications?.agentgate?.floatingWindowEnabled === true;
            if (oldFloatingEnabled !== newFloatingEnabled) {
                try {
                    const { AgentGateEventsCache } = await import('./applications/agentgate/events-cache');
                    const cache = AgentGateEventsCache.getInstance();
                    const bridgeRunning = newShouldRun;
                    if (newFloatingEnabled && bridgeRunning) {
                        cache.startPolling();
                        logger.info('[electron] AgentGate events cache polling started (floating window enabled)');
                    } else {
                        cache.stopPolling();
                        logger.info('[electron] AgentGate events cache polling stopped');
                    }
                } catch (err) {
                    logger.warn(`AgentGate events cache toggle failed: ${err}`);
                }
            }
            if (prepared.shouldNotifyWorkspaceChanged && prepared.defaultWorkspace) {
                try {
                    await ApplicationRegistry.callWorker('filemgr', 'workspaceChanged', prepared.defaultWorkspace);
                } catch (error: any) {
                    logger.warn(`[filemgr] failed to refresh workspace marker: ${error?.message ?? error}`);
                }
            }
            return { status: 'ok', data: updatedData };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('quickpass:import', async (event, quickpass) => {
        try {
            const oldSettings = Setting.getInstance().getData();
            const cleaned = quickpass.trim().replace(/[\r\n]+/g, '');
            const result = QuickPassHelper.importConfig(cleaned);
            await notifyWorkerCurrentSettingUpdate();
            await notifyFileMgrEmbeddingConfigChanged(oldSettings, Setting.getInstance().getData());
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
        async (
            event,
            { base_url, api_key, provider_type, model_name, model_type, custom_headers, no_proxy, no_ssl }
        ) => {
            try {
                const instance = new ModelInstance(
                    model_name,
                    base_url,
                    api_key,
                    !!no_proxy,
                    !!no_ssl,
                    '',
                    undefined,
                    false,
                    custom_headers,
                    provider_type,
                    model_type === 'embedding' ? 'embedding' : 'chat'
                );
                if (instance.getModelType() === 'embedding') {
                    await LLM.verifyEmbeddingModel(instance);
                } else {
                    await LLM.verifyModel(instance);
                }
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

    ipcMain.handle(
        'setting:fetchProviderModels',
        async (_event, { base_url, api_key, provider_type, no_proxy, no_ssl }) => {
            return withSpan('llm.list_models', async () => {
                try {
                    const headers: Record<string, string> = {
                        Authorization: `Bearer ${api_key}`,
                        'Content-Type': 'application/json'
                    };
                    if (provider_type === 'anthropic') {
                        headers['x-api-key'] = api_key;
                        headers['anthropic-version'] = '2023-06-01';
                    }
                    const resp = await fetchModelUrl(
                        { base_url, no_proxy: !!no_proxy, no_ssl: !!no_ssl },
                        joinProviderModelsPath(base_url, provider_type),
                        {
                            headers,
                            signal: AbortSignal.timeout(8000)
                        }
                    );
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
        }
    );
    async function _applyWorkspaceSelection(selectedPath: string) {
        try {
            const oldSettings = Setting.getInstance().getData();
            const nextSettings = { ...oldSettings, default_workspace: selectedPath };
            const prepared = prepareFileMgrWorkspaceSettings(nextSettings, oldSettings);
            Setting.getInstance().setData(prepared.data);
            Setting.getInstance().addRecentWorkspace(selectedPath);
            await notifyWorkerCurrentSettingUpdate();
            await notifyFileMgrEmbeddingConfigChanged(oldSettings, Setting.getInstance().getData());
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

        // 切换全局工作空间不影响已有任务的 workspace 绑定。
        // 每个任务在创建时就与其工作空间绑定，后续全局切换不应改变已有任务的上下文。
        // 新创建的任务将使用新的全局工作空间。
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
            await getPlatform().openPath(workspace);
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
                // 支持虚拟根目录路径（用于 OpenHarmony 家目录 + 应用沙箱）
                if (dirPath === '{OH_ROOT}') {
                    if ((process.platform as string) === 'openharmony') {
                        return {
                            status: 'ok',
                            data: [
                                {
                                    name: '家目录',
                                    path: '/storage/Users/currentUser',
                                    isDirectory: true
                                },
                                {
                                    name: '应用沙箱',
                                    path: '/data/storage/el2/base/files',
                                    isDirectory: true
                                }
                            ]
                        };
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
    ipcMain.handle('setting:exportLogEntries', async (_event: any, options: any) => {
        try {
            const scope = options?.scope === 'filtered' ? 'filtered' : 'all';
            const filter = scope === 'filtered' ? String(options?.filter || '').trim() : '';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
            const fileName =
                scope === 'filtered' ? `opendesk-filtered-logs-${timestamp}.txt` : `opendesk-logs-${timestamp}.txt`;
            const dialogOptions: Electron.SaveDialogOptions = {
                title: t('main.log.export.title'),
                defaultPath: path.join(app.getPath('desktop'), fileName),
                filters: [{ name: t('main.log.export.textFiles'), extensions: ['txt'] }]
            };
            const result =
                globalMainWindow === null
                    ? await dialog.showSaveDialog(dialogOptions)
                    : await dialog.showSaveDialog(globalMainWindow, dialogOptions);
            if (result.canceled || !result.filePath) {
                return { status: 'ok', data: { canceled: true } };
            }
            const content = LogStream.getStream().formatEntries({ filter });
            await fsPromises.writeFile(result.filePath, content, 'utf8');
            return { status: 'ok', data: { canceled: false, filePath: result.filePath } };
        } catch (error: any) {
            logger.error('exporting log entries failed', error);
            return { status: 'error', message: error.message };
        }
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
        }),
        ipcMain.handle('setting:estimateContextSize', (_event, modelName: string) => {
            if (!modelName || typeof modelName !== 'string') return { status: 'ok', data: 0 };
            return { status: 'ok', data: lookupKnownContextSize(modelName) };
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
        safeSendToWebContents(globalMainWindow.webContents, 'display:scaleFactorChanged', clamped);
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

const registerAgentGateFloatingWindowHandlers = () => {
    ipcMain.handle('agentgate:getFloatingWindowConfig', async () => {
        try {
            const { AgentGateApplication } = await import('./applications/agentgate/app');
            const app = ApplicationRegistry.getApplication('agentgate') as AgentGateApplication;
            if (!app) return { status: 'ok', data: { enabled: false, opacity: 0.76 } };
            return { status: 'ok', data: app.getFloatingWindowConfig() };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    ipcMain.handle('agentgate:setFloatingWindowEnabled', async (_event, enabled: boolean) => {
        try {
            const { AgentGateApplication } = await import('./applications/agentgate/app');
            const app = ApplicationRegistry.getApplication('agentgate') as AgentGateApplication;
            if (!app) return { status: 'error', message: 'agentgate application not found' };
            app.setFloatingWindowEnabled(enabled);
            return { status: 'ok' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    ipcMain.handle('agentgate:setFloatingWindowOpacity', async (_event, opacity: number) => {
        try {
            const { AgentGateApplication } = await import('./applications/agentgate/app');
            const app = ApplicationRegistry.getApplication('agentgate') as AgentGateApplication;
            if (!app) return { status: 'error', message: 'agentgate application not found' };
            app.setFloatingWindowOpacity(opacity);
            return { status: 'ok' };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    ipcMain.handle('agentgate:openDashboard', async () => {
        try {
            const { AgentGateApplication } = await import('./applications/agentgate/app');
            const app = ApplicationRegistry.getApplication('agentgate') as AgentGateApplication;
            if (!app) return { status: 'error', message: 'agentgate application not found' };
            return { status: 'ok', data: app.getDashboardUrl() };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    ipcMain.handle('agentgate:getRecentEvents', async () => {
        try {
            const { AgentGateEventsCache } = await import('./applications/agentgate/events-cache');
            return { status: 'ok', data: AgentGateEventsCache.getInstance().getRecentEvents() };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
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

function openLogViewFromTray(): void {
    if (!globalMainWindow || globalMainWindow.isDestroyed()) {
        return;
    }
    globalMainWindow.show();
    void globalMainWindow.webContents
        .executeJavaScript(
            `(() => {
                if (window.globalControlAPI && typeof window.globalControlAPI.openLogView === 'function') {
                    window.globalControlAPI.openLogView();
                }
            })()`
        )
        .catch((error) => {
            logger.warn(`failed to open log view from tray: ${error}`);
        });
}

const registerTray = () => {
    let icon = nativeImage.createFromPath(appIcon);
    icon = icon.resize({ width: 22, height: 22 });
    const menuitems = [
        {
            label: t('main.tray.openMainWindow'),
            click: () => {
                globalMainWindow.show();
            }
        },
        {
            label: t('main.tray.openLogs'),
            click: () => {
                openLogViewFromTray();
            }
        },
        {
            label: t('main.tray.openDevTools'),
            click: () => {
                globalMainWindow.webContents.openDevTools();
            }
        }
    ];
    if (process.platform !== 'openharmony') {
        menuitems.push({ type: 'separator' });
        menuitems.push({
            label: t('main.tray.quit'),
            click: () => {
                app.quit();
            }
        });
    }
    const menu = Menu.buildFromTemplate(menuitems);

    globalTray = new Tray(icon);
    globalTray.setToolTip('OpenDesk');
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

const ARKDATA_PROBE_TIMEOUT_MS = 5000;

async function probeArkdataAvailability(): Promise<void> {
    if ((process.platform as string) !== 'openharmony') {
        process.env.ARKDATA_AVAILABLE = '0';
        return;
    }
    try {
        const available = await withTimeout(
            resolveNativeBridge()
                .getDatabaseKit()
                .then((kit) => kit.available()),
            ARKDATA_PROBE_TIMEOUT_MS,
            'ArkData availability probe'
        );
        process.env.ARKDATA_AVAILABLE = available ? '1' : '0';
        logger.info(`ArkData availability: ${process.env.ARKDATA_AVAILABLE}`);
    } catch (error) {
        process.env.ARKDATA_AVAILABLE = '0';
        logger.warn('ArkData availability probe failed', error);
    }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

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
    initTelemetry();
    const startupTrace = new StartupTrace('startup.gui');
    const t = startupTrace.createPhase('startup.pre_ready.registry');
    initializeRegistry();
    initializeRegistryProtocols();
    t.end();

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
        const p1a = startupTrace.createPhase('startup.ready.global_state.init');
        GlobalState.initialize();
        p1a.end();

        const p1b = startupTrace.createPhase('startup.ready.global_state.toolset_provider');
        GlobalState.getInstance().taskManagerState.toolsetProvider = {
            listAvailableToolsets: () => ApplicationRegistry.listAvailableToolsets()
        };
        p1b.end();

        const p1c = startupTrace.createPhase('startup.ready.global_state.memory_review_hook');
        registerMemoryReviewHook({
            taskManagerState: GlobalState.getInstance().taskManagerState,
            initializeReviewTask: initializeMemoryReviewTask
        });
        p1c.end();

        const p1d = startupTrace.createPhase('startup.ready.global_state.goal_hooks');
        registerGoalHooks();
        p1d.end();

        const p1e = startupTrace.createPhase('startup.ready.global_state.harnesses');
        initializeHarnesses();
        p1e.end();

        // 为从磁盘恢复的旧任务注入完整的 harnessContext（不落盘，加载后默认为空）
        const p2 = startupTrace.createPhase('startup.ready.restore_tasks');
        // getInstance() 已内置容错，不会抛异常
        const startupWorkspace = Setting.getInstance().getEffectiveWorkspace();
        const agentDecl = getGlobalAgentDecl();
        const defaultMode =
            agentDecl.supportedModes().find((m) => m.id === (_currentElectronModeId || agentDecl.defaultModeId())) ??
            agentDecl.supportedModes()[0];
        for (const task of GlobalState.getInstance().taskManagerState.tasks) {
            if (!task.harnessContext.workspace) {
                const savedExecutionHost = task.harnessContext.executionHost;
                // 优先用任务自身持久化的 workspace，回退到全局启动 workspace
                const taskWorkspace = task.workspace || startupWorkspace;
                try {
                    task.harnessContext = await HarnessContext.createForMode(taskWorkspace, defaultMode);
                    task.harnessContext.executionHost = savedExecutionHost;
                    task.harnessContext.permissionPrompt = new ElectronPermissionPromptProvider();
                    await task.harnessContext.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
                } catch (err) {
                    logger.warn(`Failed to init restored task harness: ${err}`);
                    task.harnessContext.workspace = taskWorkspace;
                }
            }
        }
        p2.end();

        // 刷新证书缓存（不依赖 session，直接从文件加载）
        const p3 = startupTrace.createPhase('startup.ready.browser_session');
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
        p3.end();

        const p4 = startupTrace.createPhase('startup.ready.create_window');
        createWindow();
        p4.end();

        // 系统电源状态监听：休眠/锁屏时通知 renderer 暂停非必要渲染
        powerMonitor.on('suspend', () => {
            logger.info('[power] 系统即将休眠，通知 renderer 暂停渲染');
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) {
                    safeSendToWebContents(win.webContents, 'window:visibilityChanged', false);
                }
            }
        });
        powerMonitor.on('resume', () => {
            logger.info('[power] 系统从休眠恢复');
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed() && win.isVisible()) {
                    safeSendToWebContents(win.webContents, 'window:visibilityChanged', true);
                }
            }
        });
        // 锁屏时也暂停渲染
        if (process.platform === 'win32') {
            powerMonitor.on('lock-screen', () => {
                for (const win of BrowserWindow.getAllWindows()) {
                    if (!win.isDestroyed()) {
                        safeSendToWebContents(win.webContents, 'window:visibilityChanged', false);
                    }
                }
            });
            powerMonitor.on('unlock-screen', () => {
                for (const win of BrowserWindow.getAllWindows()) {
                    if (!win.isDestroyed() && win.isVisible()) {
                        safeSendToWebContents(win.webContents, 'window:visibilityChanged', true);
                    }
                }
            });
        }

        // 检查设置加载错误，等待 renderer 加载完成后再发送 IPC 显示模态弹窗
        const loadError = Setting.getLoadError();
        if (loadError && globalMainWindow) {
            const sendError = () => {
                safeSendToWebContents(globalMainWindow?.webContents, 'setting:loadError', loadError);
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
        const p5 = startupTrace.createPhase('startup.ready.skills');
        try {
            await installBundledSkillsIfNeeded();
        } catch (err) {
            logger.error('installBundledSkillsIfNeeded error', err);
        }
        p5.end();

        const p6 = startupTrace.createPhase('startup.ready.ipc_handlers');
        initializeScreenAdaption();
        registerBrowserAPIHandlers();
        registerMemoryAPIHandlers();
        registerUsageAPIHandlers();
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
        ipcMain.handle('app:quit', async () => {
            app.quit();
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
                    backgroundColor: '#1e1e1e', // 防止深色模式缩放窗口时露出原生白底
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
        await probeArkdataAvailability();
        registerNotificationAPIHandlers();
        registerScreenAPIHandlers();
        registerMagicPointerHandlers();
        registerDisplayZoomHandlers();
        registerAgentGateFloatingWindowHandlers();
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
        p6.end();

        const p7 = startupTrace.createPhase('startup.ready.finalize');
        initializeRegistryWorker({ preferredSystemLanguages: getPreferredSystemLanguagesForLocale() });
        initializeProtocolHandlers();
        initializeUpdater();
        p7.end();

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
                        safeSendToWebContents(globalMainWindow.webContents, 'command:openTask', task.task_id);
                    }
                };

                await channelMgrApp.initializeChannels(router, startupWorkspace);
                logger.info('[electron] channelmgr 消息路由已初始化');
            }
        });

        // 启动 AgentGate + AgentMoss 后端服务（仅在试验性功能且安全网关总开关均启用时）
        try {
            const settingData = Setting.getInstance().getData() as any;
            const experimentalFeature = !!settingData?.debug?.experimental_feature;
            const agentgateEnabled = settingData?.applications?.agentgate?.enabled !== false;
            // [DEBUG-LOG] 鸿蒙诊断：打印开关状态，部署验证后删除此行
            logger.info(
                `[electron] AgentGate pre-check: experimental=${experimentalFeature}, agentgateEnabled=${agentgateEnabled}, settingData.applications=${JSON.stringify(settingData?.applications?.agentgate)}, settingData.debug=${JSON.stringify(settingData?.debug)}`
            );
            if (experimentalFeature && agentgateEnabled) {
                const { AgentGateBridge } = await import('./services/agent-gate-bridge');
                await AgentGateBridge.getInstance().start(Setting.getInstance());
            } else {
                logger.info('[electron] AgentGate skipped — experimental feature or master switch disabled');
            }
        } catch (err) {
            logger.warn(`AgentGate bridge start failed: ${err}`);
        }

        // 初始化 AgentGate 事件缓存（用于浮窗推送）
        try {
            const { AgentGateEventsCache } = await import('./applications/agentgate/events-cache');
            // 设置推送回调：通过 IPC 将事件推送到主窗口渲染进程
            AgentGateEventsCache.getInstance().setPushCallback((events, counts) => {
                if (globalMainWindow && !globalMainWindow.isDestroyed()) {
                    safeSendToWebContents(globalMainWindow.webContents, 'agentgate:eventsUpdate', { events, counts });
                }
            });
            const settingData = Setting.getInstance().getData() as any;
            const floatingWindowEnabled = settingData?.applications?.agentgate?.floatingWindowEnabled === true;
            const experimentalFeature = !!settingData?.debug?.experimental_feature;
            const agentgateEnabled = settingData?.applications?.agentgate?.enabled !== false;
            if (floatingWindowEnabled && experimentalFeature && agentgateEnabled) {
                AgentGateEventsCache.getInstance().startPolling();
                logger.info('[electron] AgentGate events cache polling started (floating window enabled)');
            }
        } catch (err) {
            logger.warn(`AgentGate events cache init failed: ${err}`);
        }

        // 注册全局设置变更广播：每次 Setting.setData 完成后，
        // 广播 setting:changed 到所有 renderer 窗口。
        // 这确保通过 callMainWorld 修改配置（如浮窗开关）时，主窗口能实时响应。
        Setting.afterSetDataCallbacks.push(() => {
            const updatedData = Setting.getInstance().getData();
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) {
                    safeSendToWebContents(win.webContents, 'setting:changed', updatedData);
                }
            }
        });

        // 所有 onReady 回调注册完毕后，追加最后一个回调来结束 root trace
        ApplicationRegistry.onReady(() => {
            startupTrace.end();
        });

        // 启动完成后异步清理过期日志，不阻塞主流程
        dropDeprecatedLogs().catch(() => {});
    });

    app.on('will-quit', async () => {
        // 关闭 AgentGate + AgentMoss 服务 + 事件缓存轮询
        try {
            const { AgentGateBridge } = await import('./services/agent-gate-bridge');
            AgentGateBridge.getInstance().stop();
        } catch {
            /* best-effort */
        }
        try {
            const { AgentGateEventsCache } = await import('./applications/agentgate/events-cache');
            AgentGateEventsCache.getInstance().stopPolling();
        } catch {
            /* best-effort */
        }

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
        await shutdownTelemetry();
    });
}

startApplication();
