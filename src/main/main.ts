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

declare const __BUILD_TIME__: string;
declare const __IS_DEV__: boolean;

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
    getTaskArtifactDirectory,
    isDeveloperModeEnabled
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
import { createMainWindowCloseHandler } from './utils/window-close.js';
import { skillRegistry } from './applications/skillmgr/utils/skill-registry.js';
import { SkillMgrApplication } from './applications/skillmgr/app.js';
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
import { setPlatform, getPlatform } from '../platforms/base.js';
import {
    ElectronTaskUpdateSubscriber,
    ElectronPlatform,
    ElectronTaskManagerUpdateSubscriber
} from '../platforms/electron.js';
import { exportTaskToHtml, generateTaskHtml } from './utils/export.js';
import { getMainThemeService, registerThemeHandlers } from '../renderer/theme/main-theme-service.js';
import { AgentRegistry } from './aikernel/agents/registry.js';
import { HarnessContext } from './aikernel/security/harness.js';
import { ElectronPermissionPromptProvider } from './aikernel/security/electronPrompt.js';
import { ElectronExitPlanModeProvider } from './aikernel/interaction/electronExitPlanMode.js';
import {
    activateOpenDeskOfficeContents,
    attachOpenDeskOfficeWindow,
    configureOpenDeskOfficeWebPreferences,
    getOpenDeskOfficeEditorKind,
    registerEmbeddedOpenDeskOffice,
    requestCloseOpenDeskOfficeContents
} from './office/openDeskOfficeHost.js';
import { ChannelMgrApplication } from './applications/channelmgr/app.js';
import { ChannelMessageRouter } from './applications/channelmgr/router.js';
import {
    prepareFileMgrStartupWorkspaceSettings,
    prepareFileMgrWorkspaceSettings
} from './applications/filemgr/workspace.js';
import { getTaskTodosForDisplay } from './aikernel/todos/task-todos.js';
import { readTaskSessionMemory, isSessionMemoryTemplateOnly } from './aikernel/compaction/session-memory-compact.js';
import { readUserPortrait, writeUserPortrait } from './aikernel/memory/user_portrait.js';
import { registerMemoryReviewHook } from './aikernel/memory/review.js';
import { FactorialMemoryStore } from './aikernel/memory/store.js';
import { startMemoryCleanupScheduler } from './aikernel/memory/cleanup.js';
import { startProxyEnvRefreshScheduler, onNetworkConfigChanged } from './utils/proxy-env.js';
import { getUsageDashboardSummary, getUsageRankings, type RankPeriod } from './telemetry/local-telemetry.js';
import { TelemetryOperation, TelemetryOperationRegistry } from './telemetry/operation.js';
import { registerGoalHooks } from './aikernel/goal/hooks.js';
import { initializeHarnesses } from './aikernel/harnesses/index.js';
import { initAgentGateHook } from './applications/agentgate/hook.js';
import {
    PluginToolsetProvider,
    combineToolsetProviders,
    disposePluginHost,
    initializePluginHost
} from './applications/pluginmgr/index.js';
import { GoalController } from './aikernel/goal/controller.js';
import { GoalService } from './aikernel/goal/service.js';
import type { GoalCommandResult } from './aikernel/goal/state.js';
import { parseGoalEditIfMatch } from '../common/goal/command.js';
import { marked } from './aikernel/messages.js';
import {
    lookupKnownContextSize,
    lookupKnownMaxOutputTokens,
    resolveModelVisionSupport,
    resolveModelReasoningEfforts,
    fetchContextSizeFromAPI
} from './utils/model-context.js';
import { fetchModelUrl } from './utils/model-network.js';
import { LLM } from './aikernel/llm.js';
import { BrowserManager, setCDPLogger } from '../common/embedBrowserUse/main';
import { openDeskScriptGenerators } from './applications/browser/utils.js';
import { Channels as EmbedBrowserChannels } from '../common/embedBrowserUse/protocol';
import { registerNativeBridge, resolveNativeBridge } from '../platforms/bridges/main.js';
import { getHuaweiAuthService } from '../platforms/bridges/harmonyos/auth/huawei-auth.js';
import { listGatewayListenHostOptions } from './applications/devicemgr/common.js';
import { getExecutionNode, listExecutionNodes } from './applications/devicemgr/execution.js';
import { type TaskState, isTaskVisibleForDeveloperMode } from './aikernel/states/tasks.js';
import { getLocale, t } from '../locale/index.js';
import { getAttachmentFileSupport, UnsupportedAttachmentFileTypeError } from './aikernel/attachment-support.js';
import { switchTaskMode } from './aikernel/task/mode.js';
import {
    initTaskStatusWidget,
    setMainWindowHidden,
    setMainWindowFocused
} from './windows/task-status-widget-window.js';

let telemetryModulePromise: Promise<typeof import('./telemetry/index.js')> | undefined;
function loadTelemetryModule(): Promise<typeof import('./telemetry/index.js')> {
    if (!telemetryModulePromise) {
        telemetryModulePromise = import('./telemetry/index.js');
    }
    return telemetryModulePromise;
}

/** 当前在 Electron GUI 中选择的 modeId */
let _currentElectronModeId: string | null = null;

async function initializeMemoryReviewTask(task: TaskState): Promise<void> {
    const workspace = Setting.getInstance().getEffectiveWorkspace();
    const agent = AgentRegistry.getMainAgent();
    const modes = agent.supportedModes();
    const mode = modes.find((candidate) => candidate.id === _currentElectronModeId) ?? agent.getDefaultMode();
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
import {
    getHarmonyBrowseRoots,
    getHarmonyRuntimeEnvironment,
    initializeHarmonyRuntimeEnvironment
} from '../platforms/bridges/harmonyos/runtime.js';
import { initializeHarmonyLocalRuntimeState } from '../platforms/bridges/harmonyos/local-runtime.js';

// TODO: FSService 和 recallApplication 当前未接入，保留 ipcMain handler 以兼容旧前端
declare const FSService: any;
declare const recallApplication: any;

setPlatform(new ElectronPlatform(app));
useConsoleTransport();
initializeHarmonyRuntimeEnvironment();
initializeHarmonyLocalRuntimeState();
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

const __dirname = import.meta.dirname;
const converter = new Convert();

let globalMainWindow: BrowserWindow | null = null;
let globalTray: Tray | null = null;
let isAppQuitting = false;
let officeQuitCheckPending = false;
let officeQuitApproved = false;
let isHuaweiStartupAuthPending = false;
let isHuaweiLoginRestorePending = false;

function restoreHuaweiLoginForWorkbenchWindow(reason: string): void {
    if (process.platform !== 'openharmony' || !isHuaweiStartupAuthPending || isHuaweiLoginRestorePending) {
        return;
    }

    isHuaweiLoginRestorePending = true;
    void getHuaweiAuthService()
        .restoreLogin()
        .catch((error: unknown) => {
            logger.warn(`[auth] Failed to restore Huawei login window after ${reason}: ${String(error)}`);
        })
        .finally(() => {
            isHuaweiLoginRestorePending = false;
        });
}

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
    const fromRegistry = skillRegistry.getBundledSkillsDirectory();
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

        const userSkillsDir = skillRegistry.getSkillsDirectory();

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
            // 浏览器面板 webview 关闭后台节流：后台任务 offscreen 渲染时，
            // 麒麟系统定制 Chromium 仍会节流定时器/动画，导致页面 JS 误判触发弹窗告警。
            webPreferences.backgroundThrottling = false;
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
            // 全屏状态下 ESC 退出全屏
            if (input.key === 'Escape' && input.type === 'keyDown' && hostWindow.isFullScreen()) {
                hostWindow.setFullScreen(false);
                _evt.preventDefault();
                return;
            }
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
        minHeight: 400,
        minWidth: 850,
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
        if (isHuaweiStartupAuthPending) {
            restoreHuaweiLoginForWorkbenchWindow('workbench ready-to-show');
            return;
        }
        mainWindow.show();
        logger.info('[startup] 主窗口已显示 (ready-to-show)');
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

    // 悬浮窗（pill/card 模式）依赖主窗口是否处于前台的焦点状态。
    mainWindow.on('blur', () => setMainWindowFocused(false));
    mainWindow.on('focus', () => setMainWindowFocused(true));

    // 全屏状态变化时更新 tray 菜单文案
    mainWindow.on('enter-full-screen', () => {
        globalTray?.setContextMenu(buildTrayMenu());
    });
    mainWindow.on('leave-full-screen', () => {
        globalTray?.setContextMenu(buildTrayMenu());
    });

    mainWindow.on(
        'close',
        createMainWindowCloseHandler({
            isAppQuitting: () => isAppQuitting,
            window: mainWindow,
            getSettingData: () => Setting.getInstance().getData() as Record<string, unknown>,
            saveSettingData: (data) => Setting.getInstance().setData(data),
            ipcMain,
            quit: () => app.quit(),
            sendToRenderer: (channel, ...args) => safeSendToWebContents(mainWindow.webContents, channel, ...args)
        })
    );

    const protocolConfigs = ApplicationRegistry.collectProtocolHandlerEntries();
    const inAppSchemePrefixes = Array.from(
        new Set([...protocolConfigs.map((c) => c.scheme + '://'), 'opendesk-app://'])
    );
    const openLink = (url: string) => {
        if (
            url.startsWith('file://') ||
            url.startsWith('http://localhost') ||
            url.startsWith('http://127.0.0.1') ||
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

    // 可编辑区域恢复 Electron 默认右键菜单（剪切/复制/粘贴/全选），非编辑区域保持禁用。
    // label 使用 t() 以跟随 OpenDesk 语言设置；role 保留以维持系统原生快捷键和启用/禁用逻辑。
    mainWindow.webContents.on('context-menu', (_event, params) => {
        if (!params.isEditable) return;
        Menu.buildFromTemplate([
            { role: 'cut', label: t('contextmenu.cut') },
            { role: 'copy', label: t('contextmenu.copy') },
            { role: 'paste', label: t('contextmenu.paste') },
            { type: 'separator' },
            { role: 'selectAll', label: t('contextmenu.selectAll') }
        ]).popup();
    });

    mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
        // 非活跃 webview 开启后台节流，降低 CPU 和电量消耗
        webPreferences.backgroundThrottling = true;
        const src = params.src ?? '';
        const officeEditorKind = getOpenDeskOfficeEditorKind(src);
        if (officeEditorKind) {
            configureOpenDeskOfficeWebPreferences(officeEditorKind, webPreferences);
            return;
        }
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
            // 浏览器面板 webview 关闭后台节流：后台任务 offscreen 渲染时，
            // 麒麟系统定制 Chromium 仍会节流定时器/动画，导致页面 JS 误判触发弹窗告警。
            webPreferences.backgroundThrottling = false;
        }
        if (BrowserManager.browserSession) {
            webPreferences.session = BrowserManager.browserSession;
        }
    });

    // 拦截嵌入式浏览器 webview 中的弹窗请求（window.open / target="_blank"），
    // 通知 renderer 以新标签页形式打开，避免弹出独立窗口。
    mainWindow.webContents.on('did-attach-webview', (_event, webContents) => {
        const officeEditorKind = getOpenDeskOfficeEditorKind(webContents.getURL());
        if (officeEditorKind) activateOpenDeskOfficeContents(officeEditorKind, webContents);
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

    // 全屏状态下按 ESC 退出全屏（主窗口直接获焦时）
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'Escape' && input.type === 'keyDown' && mainWindow.isFullScreen()) {
            mainWindow.setFullScreen(false);
            event.preventDefault();
        }
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

    // 防御性兜底：如果主框架导航到外部 URL 后加载失败（will-navigate 拦截未生效或被绕过），
    // 自动重载应用入口页，避免用户面对灰色空白屏幕无法操作。
    let appReloadCount = 0;
    let appReloadResetTimer: NodeJS.Timeout | null = null;
    mainWindow.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        // 只处理非内部 URL 的加载失败，避免应用自身入口页加载失败时无限重载
        if (
            validatedURL.startsWith('file://') ||
            validatedURL.startsWith('http://localhost') ||
            validatedURL.startsWith('http://127.0.0.1') ||
            inAppSchemePrefixes.some((p) => validatedURL.startsWith(p))
        ) {
            return;
        }
        // 限制重载频率，防止极端情况下无限重载
        if (appReloadCount >= 3) {
            logger.error(`did-fail-load: reload limit reached for ${validatedURL}`);
            return;
        }
        appReloadCount++;
        if (appReloadResetTimer) clearTimeout(appReloadResetTimer);
        appReloadResetTimer = setTimeout(() => {
            appReloadCount = 0;
        }, 10000);
        logger.warn(`did-fail-load: main frame failed to load ${validatedURL}, reloading app entry`);
        if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
            void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
        } else {
            mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
        }
    });

    // renderer 进程崩溃时自动重载
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        logger.error(`render-process-gone: ${details.reason}`);
        if (appReloadCount >= 3) {
            logger.error('render-process-gone: reload limit reached, not reloading');
            return;
        }
        appReloadCount++;
        if (appReloadResetTimer) clearTimeout(appReloadResetTimer);
        appReloadResetTimer = setTimeout(() => {
            appReloadCount = 0;
        }, 10000);
        if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
            void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
        } else {
            mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
        }
    });

    // 窗口隐藏/最小化时通知 renderer 降低刷新率，节省 CPU 和电量
    mainWindow.on('hide', () => {
        setMainWindowHidden(true);
        safeSendToWebContents(mainWindow.webContents, 'window:visibilityChanged', false);
    });
    mainWindow.on('show', () => {
        if (isHuaweiStartupAuthPending) {
            mainWindow.hide();
            restoreHuaweiLoginForWorkbenchWindow('workbench show');
            return;
        }
        setMainWindowHidden(false);
        safeSendToWebContents(mainWindow.webContents, 'window:visibilityChanged', true);
    });
    mainWindow.on('minimize', () => {
        setMainWindowHidden(true);
        safeSendToWebContents(mainWindow.webContents, 'window:visibilityChanged', false);
    });
    mainWindow.on('restore', () => {
        if (isHuaweiStartupAuthPending) {
            mainWindow.hide();
            restoreHuaweiLoginForWorkbenchWindow('workbench restore');
            return;
        }
        setMainWindowHidden(false);
        safeSendToWebContents(mainWindow.webContents, 'window:visibilityChanged', true);
    });

    globalMainWindow = mainWindow;
    attachOpenDeskOfficeWindow(mainWindow);
    BrowserManager.setMainWindow(mainWindow);
};

const registerModeAPIHandlers = () => {
    ipcMain.handle('mode:getSupportedModes', () => {
        try {
            const agentDecl = AgentRegistry.getMainAgent();
            const modes = agentDecl.supportedModes();
            const defaultId = agentDecl.getDefaultMode().id;
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
            const agentDecl = AgentRegistry.getMainAgent();
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
            const globalState = GlobalState.getInstance();
            const task = globalState.taskManagerState.getTask(taskId);
            if (!task) {
                return { status: 'error', message: `task ${taskId} not found` };
            }

            const switched = await switchTaskMode(task, modeId, () => new ElectronPermissionPromptProvider());
            if (!switched) {
                return { status: 'error', message: `unknown mode: ${modeId}` };
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

    ipcMain.handle('memory:updateUserPortrait', async (_event, content: string) => {
        try {
            await writeUserPortrait(content);
            return { status: 'ok', data: { raw: await readUserPortrait() } };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    ipcMain.handle('memory:updateMemory', async (_event, uid: string, title: string, content: string) => {
        try {
            const registry = FactorialMemoryStore.getInstance(Setting.getInstance().getEffectiveWorkspace());
            return { status: 'ok', data: await registry.updateMemory(uid, title, content) };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    ipcMain.handle('memory:removeMemory', async (_event, uid: string) => {
        try {
            const registry = FactorialMemoryStore.getInstance(Setting.getInstance().getEffectiveWorkspace());
            return { status: 'ok', data: await registry.removeMemory(uid) };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    ipcMain.handle('memory:cleanup', async () => {
        try {
            const registry = FactorialMemoryStore.getInstance(Setting.getInstance().getEffectiveWorkspace());
            return { status: 'ok', data: await registry.cleanupStaleMemories() };
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
            const developerMode = isDeveloperModeEnabled();
            for (const item of summary.month_top_tasks) {
                const task = taskManagerState.getTask(item.task_id);
                if (!task || !isTaskVisibleForDeveloperMode(task, developerMode)) {
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
            const developerMode = isDeveloperModeEnabled();
            for (const item of rankings.tasks) {
                const task = taskManagerState.getTask(item.task_id);
                if (!task || !isTaskVisibleForDeveloperMode(task, developerMode)) {
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
        const agentDecl = AgentRegistry.getMainAgent();
        const modes = agentDecl.supportedModes();
        const resolvedModeId = options.modeId || _currentElectronModeId;
        const activeMode = modes.find((candidate) => candidate.id === resolvedModeId) ?? agentDecl.getDefaultMode();

        try {
            task.harnessContext = await HarnessContext.createForMode(workspace, activeMode);
            task.harnessContext.permissionPrompt = new ElectronPermissionPromptProvider();
            task.workspace = workspace;
            task.activeModeId = activeMode.id;
            task.allowedTools = activeMode.allowedTools;
            task.disabledTools = activeMode.disabledTools;
            await task.harnessContext.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
            // 交互工具集由 platform 按需构建（含审批后切模式的 modeSwitcher）；挂载由每次 turn 的 interactive 标记决定
            task.interactionToolset = getPlatform().createInteractionToolset(task);

            if (initialNodeId) {
                const result = await applyTaskExecutionNode(task, initialNodeId);
                if (result.status !== 'ok') return result;
            }

            await task.rebuildSystemPrompt();
        } catch (err) {
            logger.warn(`Failed to init task harness in Electron, using empty context: ${err}`);
            task.harnessContext = HarnessContext.createEmpty();
            task.harnessContext.workspace = workspace;
            task.workspace = workspace;
        }
        // harness 初始化设置了 task.workspace 等属性，需要通知前端更新，
        // 否则前端在 createTask() 发出的 taskListUpdate 中看到的是空 workspace
        globalState.taskManagerState.publishTaskListUpdate();
        return { status: 'ok', data: task.task_id };
    });

    ipcMain.handle('taskManager:triggerTaskReview', async (_event, taskId: string) => {
        try {
            const task = globalState.taskManagerState.getTask(taskId);
            if (!task) {
                return { status: 'error', message: `task ${taskId} not found` };
            }
            task.cancelPendingTaskReview();
            await task.hooks.noticeOnTaskReview({ task, startMessageIndex: 0 });
            return { status: 'ok' };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });
    ipcMain.handle('taskManager:removeTask', (event, taskId) => {
        const removedTaskIds = globalState.taskManagerState.removeTask(taskId);
        if (removedTaskIds.length === 0) {
            return { status: 'error', message: `task ${taskId} not found` };
        }

        publishTaskTodosCleared(removedTaskIds);
        return { status: 'ok', data: taskId };
    });
    ipcMain.handle('taskManager:forkTask', (event, taskId, upToMessageId?: string) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        const forkedTask = task.fork(upToMessageId);
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
            const taskAgent = task.getAgent();
            const mainAgent = AgentRegistry.getMainAgent();
            const mainModeId = task.activeModeId || _currentElectronModeId;
            const mainModes = mainAgent.supportedModes();
            const mode =
                taskAgent.agentId === mainAgent.agentId
                    ? (mainModes.find((candidate) => candidate.id === mainModeId) ?? mainAgent.getDefaultMode())
                    : task.getAgentMode();
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
            task.activeModeId = mode.id;
            task.allowedTools = mode.allowedTools;
            task.disabledTools = mode.disabledTools;
            await task.rebuildSystemPrompt();
            task.persistLater();
            await task.refreshToolsets();
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
        const result = globalState.taskManagerState.getTaskLoadResult(taskId);
        const task = result.task;
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        if (result.corrupted) {
            globalState.taskManagerState.removeCorruptedTaskEntry(taskId);
            return { status: 'error', code: 'TASK_CORRUPTED', message: t('task.corrupted.detail', { taskId }) };
        }

        await globalState.taskManagerState.refreshLazyTaskSystemPrompt(task);
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
        task.agentId = undefined;
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
        await task.rebuildSystemPrompt();
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
        await globalState.taskManagerState.refreshLazyTaskSystemPrompt(task);
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

        await task.submitUserMessage(details.message, { imageDataUris, interactive: true });
        return { status: 'ok' };
    });
    ipcMain.handle('taskManager:rewindToUserMessage', async (_event, taskId, messageId, options) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        try {
            const result = await task.rewindToUserMessage(messageId, {
                resubmit: options?.resubmit === true,
                source: options?.source,
                overrideMessageText: options?.overrideMessageText
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
    ipcMain.handle('taskManager:interruptForNewMessage', async (event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        task.interruptForNewMessage();
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
    ipcMain.handle('fs:showItemInFolder', async (_event, filePath) => {
        try {
            await getPlatform().showItemInFolder(filePath);
            return { status: 'ok' };
        } catch (error: any) {
            logger.error('showing item in folder failed', error);
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
            title: t('main.dialog.openFile'),
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
            title: t('main.dialog.openDirectory'),
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
            // 二进制图片文件附带 data URI，供前端预览
            let dataUri: string | undefined;
            if (binary) {
                const ext = path.extname(systemPath).toLowerCase().slice(1);
                const mimeMap: Record<string, string> = {
                    png: 'image/png',
                    jpg: 'image/jpeg',
                    jpeg: 'image/jpeg',
                    gif: 'image/gif',
                    webp: 'image/webp',
                    bmp: 'image/bmp',
                    ico: 'image/x-icon',
                    avif: 'image/avif',
                    apng: 'image/apng'
                };
                const mime = mimeMap[ext];
                if (mime) {
                    dataUri = `data:${mime};base64,${buf.toString('base64')}`;
                }
            }
            return {
                status: 'ok',
                data: {
                    tooLarge: false,
                    size: st.size,
                    limit,
                    content: binary ? '' : buf.toString('utf8'),
                    binary,
                    ...(dataUri ? { dataUri } : {})
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
                const vision = resolveModelVisionSupport(m);
                if (vision !== undefined) {
                    result[m.alias] = vision;
                }
                // 如果既无手动配置、内置表也查不到，默认悲观认为不支持视觉
            }
        }
        return result;
    });

    // 查询每个模型的可用推理档位（alias → 存储值列表，含 '' 默认项）
    ipcMain.handle('model:checkReasoningEfforts', (_event, models) => {
        if (!Array.isArray(models)) {
            return {};
        }
        const result: Record<string, string[]> = {};
        for (const m of models) {
            if (m.alias && m.model_name) {
                result[m.alias] = resolveModelReasoningEfforts(m);
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
            // 网络配置变更后立即刷新代理 env 缓存，使命令行子进程即时生效
            void onNetworkConfigChanged();
            try {
                getMainThemeService().applyFromSettings();
            } catch (themeErr) {
                logger.warn('[theme] applyFromSettings after save failed', themeErr);
            }
            // 遥测配置变更时热重载 OTel SDK
            const oldTelemetryJson = JSON.stringify(oldSettings?.telemetry);
            const newTelemetryJson = JSON.stringify(Setting.getInstance().getData().telemetry);
            if (oldTelemetryJson !== newTelemetryJson) {
                void loadTelemetryModule()
                    .then((telemetry) => telemetry.reloadTelemetry())
                    .catch((err) => logger.warn('[telemetry] hot reload failed', err));
            }
            // 广播设置变更给所有 renderer 窗口，以便 AgentInput 等组件刷新模型列表
            const updatedData = withResolvedLocale(Setting.getInstance().getData());
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) {
                    safeSendToWebContents(win.webContents, 'setting:changed', updatedData);
                }
            }

            // AgentGate 的 bridge 启停已由 AgentGateApplication.onConfigChanged 内部处理，无需在此同步
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
                    undefined,
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
            return TelemetryOperationRegistry.aroundOperation(new TelemetryOperation('llm.list_models'), async () => {
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
                title: t('main.dialog.selectWorkspaceDirectory'),
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
    ipcMain.handle('workspace:pickDirectoryDialog', async () => {
        try {
            const result = await dialog.showOpenDialog(globalMainWindow!, {
                title: t('main.dialog.selectWorkspaceDirectory'),
                properties: ['openDirectory', 'createDirectory']
            });
            if (result.canceled || result.filePaths.length === 0) {
                return { status: 'ok', data: null };
            }
            const selectedPath = result.filePaths[0].replace(/\\/g, '/');
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
                        const runtime = getHarmonyRuntimeEnvironment();
                        return {
                            status: 'ok',
                            data: runtime
                                ? getHarmonyBrowseRoots(runtime).map((root) => ({
                                      name: root.kind === 'userHome' ? '家目录' : '应用沙箱',
                                      path: root.path,
                                      isDirectory: true
                                  }))
                                : []
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
        ipcMain.handle('setting:openConfigDirectory', async () => {
            try {
                const configDir = getOpendeskDirectory();
                await getPlatform().openPath(configDir);
                return { status: 'ok' };
            } catch (error: any) {
                return { status: 'error', message: error.message };
            }
        }),
        ipcMain.handle('setting:openLogWindow', () => {
            openLogViewFromTray();
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
        ipcMain.handle('setting:getBuildTime', () => {
            return { status: 'ok', data: { time: __BUILD_TIME__, dev: __IS_DEV__ } };
        }),
        ipcMain.handle('setting:estimateContextSize', (_event, modelName: string) => {
            if (!modelName || typeof modelName !== 'string') return { status: 'ok', data: 0 };
            return { status: 'ok', data: lookupKnownContextSize(modelName) };
        }),
        ipcMain.handle('setting:estimateMaxOutputTokens', (_event, modelName: string) => {
            if (!modelName || typeof modelName !== 'string') return { status: 'ok', data: 0 };
            return { status: 'ok', data: lookupKnownMaxOutputTokens(modelName) };
        }));
};

// === 屏幕缩放适配 ===

/**
 * 平台级额外补偿系数，用于按 process.platform 做缩放微调。
 */
const PLATFORM_ZOOM_COMPENSATION: Record<string, number> = {
    openharmony: 1.2
};

/** 读取用户配置的 scale_factor */
const readUserScaleFactor = (): number => {
    try {
        const val = Setting.getInstance().getData().gui_config?.scale_factor;
        return typeof val === 'number' && Number.isFinite(val) ? val : 1;
    } catch {
        return 1;
    }
};

/** 计算实际应该应用的 zoom factor（用户偏好 × 平台补偿） */
const computeEffectiveZoom = (): number => {
    const userScale = readUserScaleFactor();
    const platformCompensation = PLATFORM_ZOOM_COMPENSATION[process.platform as string] ?? 1;
    return Math.max(0.5, Math.min(3.0, userScale * platformCompensation));
};

/** 将有效缩放系数应用到窗口并通知渲染进程 */
const applyEffectiveZoomToWindow = () => {
    if (!globalMainWindow) return;
    const effective = computeEffectiveZoom();
    globalMainWindow.webContents.setZoomFactor(effective);
    safeSendToWebContents(globalMainWindow.webContents, 'display:scaleFactorChanged', effective);
};

const registerDisplayZoomHandlers = () => {
    ipcMain.handle('display:getScaleFactor', () => {
        try {
            return { status: 'ok', data: readUserScaleFactor() };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    ipcMain.handle('display:setScaleFactor', (event, factor) => {
        try {
            if (!Number.isFinite(factor)) factor = 1;
            const clamped = Math.max(0.5, Math.min(2.0, factor));
            const rounded = Math.round(clamped * 10) / 10;
            const currentData = Setting.getInstance().getData();
            Setting.getInstance().setData({
                ...currentData,
                gui_config: { ...(currentData.gui_config || {}), scale_factor: rounded }
            });
            applyEffectiveZoomToWindow();
            return { status: 'ok', data: rounded };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    ipcMain.handle('display:adjustScaleFactor', (event, delta) => {
        try {
            const current = readUserScaleFactor();
            const next = Math.round((current + delta) * 10) / 10;
            const clamped = Math.max(0.5, Math.min(2.0, next));
            const currentData = Setting.getInstance().getData();
            Setting.getInstance().setData({
                ...currentData,
                gui_config: { ...(currentData.gui_config || {}), scale_factor: clamped }
            });
            applyEffectiveZoomToWindow();
            return { status: 'ok', data: clamped };
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

/**
 * 鸿蒙平台启动时校验华为账号登录。
 * 若未登录则拉起登录窗口阻塞启动，登录成功或用户关闭窗口后继续。
 * 非鸿蒙平台直接跳过。
 */
async function ensureHuaweiAuthOnStartup(): Promise<void> {
    if (process.platform !== 'openharmony') {
        return;
    }

    const authService = getHuaweiAuthService();
    const available = await authService.isAvailable();
    if (!available) {
        logger.warn('[auth] Huawei account login is not available, skipping startup auth');
        return;
    }

    // 已有有效会话则跳过
    const existing = authService.getSession();
    if (existing) {
        logger.info('[auth] Valid Huawei auth session found, skipping login');
        return;
    }

    logger.info('[auth] No valid Huawei auth session, launching login window...');
    isHuaweiStartupAuthPending = true;

    // 隐藏主窗口，避免用户在登录校验期间操作应用
    if (globalMainWindow && !globalMainWindow.isDestroyed()) {
        globalMainWindow.hide();
        // 等待主窗口内容加载完成，确保鸿蒙侧 UIAbility 已进入 active 状态，
        // ArkTS 创建登录窗口时才能拿到合法的 window context。
        try {
            await new Promise<void>((resolve) => {
                if (globalMainWindow!.webContents.isLoadingMainFrame()) {
                    globalMainWindow!.webContents.once('did-finish-load', () => resolve());
                } else {
                    resolve();
                }
            });
        } catch {
            /* ignore - 即使加载未完成也继续尝试登录 */
        }
    }

    try {
        await authService.login();
        logger.info('[auth] Huawei account login succeeded on startup');
    } catch (err: any) {
        isHuaweiStartupAuthPending = false;
        logger.error(`[auth] Huawei account login failed on startup: ${err?.message || err}`);
        // 登录失败/取消，立即退出应用；同时使用 app.quit() + process.exit(1) 强制终止，
        // 避免在鸿蒙 Electron 下 app.exit 未能真正结束进程导致悬挂空白窗口。
        // 主动尝试关闭鸿蒙侧登录窗口，避免悬挂
        try {
            await authService.logout();
        } catch {
            /* ignore */
        }
        app.quit();
        process.exit(1);
        return;
    }

    // 登录成功，显示主窗口
    isHuaweiStartupAuthPending = false;
    if (globalMainWindow && !globalMainWindow.isDestroyed()) {
        globalMainWindow.show();
        globalMainWindow.focus();
    }
}

const registerAuthAPIHandlers = () => {
    ipcMain.handle('auth:isAvailable', async () => {
        try {
            const available = await getHuaweiAuthService().isAvailable();
            return { status: 'ok', data: { available } };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    ipcMain.handle('auth:login', async () => {
        try {
            const session = await getHuaweiAuthService().login();
            return { status: 'ok', data: session };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    ipcMain.handle('auth:getSession', () => {
        try {
            const session = getHuaweiAuthService().getSession();
            return { status: 'ok', data: session };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    ipcMain.handle('auth:refreshToken', async () => {
        try {
            const session = await getHuaweiAuthService().refreshToken();
            return { status: 'ok', data: session };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    ipcMain.handle('auth:logout', async () => {
        try {
            await getHuaweiAuthService().logout();
            return { status: 'ok' };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
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

let globalLogWindow: BrowserWindow | null = null;

function openLogViewFromTray(): void {
    if (globalLogWindow && !globalLogWindow.isDestroyed()) {
        globalLogWindow.show();
        globalLogWindow.focus();
        return;
    }

    globalLogWindow = new BrowserWindow({
        width: 900,
        height: 560,
        minWidth: 480,
        minHeight: 300,
        frame: false,
        icon: appIcon,
        title: 'OpenDesk',
        show: false,
        paintWhenInitiallyHidden: true,
        backgroundColor: '#1e1e1e',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            allowRunningInsecureContent: true,
            backgroundThrottling: true,
            preload: getRendererPreloadPath()
        }
    });

    globalLogWindow.setMenu(null);

    globalLogWindow.once('ready-to-show', () => {
        globalLogWindow?.show();
    });

    globalLogWindow.on('closed', () => {
        globalLogWindow = null;
    });

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        const baseUrl = process.env['ELECTRON_RENDERER_URL'];
        const logUrl = new URL('logview_window.html', baseUrl);
        void globalLogWindow.loadURL(logUrl.toString());
    } else {
        const baseDir = path.join(__dirname, '..', 'renderer');
        void globalLogWindow.loadFile(path.join(baseDir, 'logview_window.html'));
    }
}

const buildTrayMenu = () => {
    const isFullscreen = globalMainWindow?.isFullScreen() ?? false;
    const menuitems: Electron.MenuItemConstructorOptions[] = [
        {
            label: t('main.tray.openMainWindow'),
            click: () => {
                globalMainWindow?.show();
            }
        },
        {
            label: isFullscreen ? t('main.tray.exitFullscreen') : t('main.tray.enterFullscreen'),
            click: () => {
                if (globalMainWindow) {
                    globalMainWindow.setFullScreen(!globalMainWindow.isFullScreen());
                }
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
                globalMainWindow?.webContents.openDevTools();
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
    return Menu.buildFromTemplate(menuitems);
};

const registerTray = () => {
    let icon = nativeImage.createFromPath(appIcon);
    icon = icon.resize({ width: 22, height: 22 });

    globalTray = new Tray(icon);
    globalTray.setToolTip('OpenDesk');
    globalTray.setContextMenu(buildTrayMenu());
    globalTray.on('click', () => {
        globalMainWindow?.show();
    });
};

const initializeScreenAdaption = () => {
    const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
    logger.info(`屏幕显示参数: ${scaleFactor}`);

    // 启动时应用有效缩放（含平台补偿）
    applyEffectiveZoomToWindow();

    // 页面加载完成后再次应用，避免加载期间 setZoomFactor 未生效
    if (globalMainWindow) {
        const wc = globalMainWindow.webContents;
        if (wc.isLoadingMainFrame()) {
            wc.once('did-finish-load', () => applyEffectiveZoomToWindow());
        }
    }
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

async function startApplication(): Promise<void> {
    // 同步 --config-directory 到 Electron userData，使单例锁按 config 目录区分
    const configDir = getOpendeskDirectory();
    const defaultUserData = app.getPath('userData');
    if (configDir !== defaultUserData) {
        app.setPath('userData', configDir);
    }

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

    let telemetryReadyPromise: Promise<void> | undefined;
    const ensureTelemetryReady = (): Promise<void> => {
        if (!telemetryReadyPromise) {
            telemetryReadyPromise = loadTelemetryModule().then((telemetry) => telemetry.initTelemetry());
        }
        return telemetryReadyPromise;
    };

    app.on('before-quit', (event) => {
        if (officeQuitApproved) {
            isAppQuitting = true;
            void disposePluginHost();
            return;
        }

        event.preventDefault();
        if (officeQuitCheckPending) return;
        officeQuitCheckPending = true;
        void requestCloseOpenDeskOfficeContents()
            .then((canQuit) => {
                if (!canQuit) return;
                officeQuitApproved = true;
                isAppQuitting = true;
                app.quit();
            })
            .catch((error: unknown) => {
                logger.error(`Failed to confirm OpenDesk Office shutdown: ${String(error)}`);
            })
            .finally(() => {
                officeQuitCheckPending = false;
            });
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
        let resolveRegistryWorkerReady!: () => void;
        const registryWorkerReady = new Promise<void>((resolve) => {
            resolveRegistryWorkerReady = resolve;
        });
        let browserReadyPromise: Promise<void> | undefined;
        const ensureBrowserReady = (): Promise<void> => {
            if (!browserReadyPromise) {
                browserReadyPromise = (async () => {
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
                })();
            }
            return browserReadyPromise;
        };
        const ensureElectronFullyLoaded = async (): Promise<void> => {
            await registryWorkerReady;
            await Promise.all([ensureTelemetryReady(), ApplicationRegistry.ensureFullyLoaded(), ensureBrowserReady()]);
        };

        // 先注册 renderer 首屏会调用的无状态 IPC，再立即启动 renderer 加载。
        // taskManager handler 会在本回调首次让出事件循环前完成注册。
        registerSettingAPIHandlers();
        registerApplicationRegistryHandlers(ipcMain, ensureElectronFullyLoaded);
        registerNotificationAPIHandlers();
        registerThemeHandlers();
        registerEmbeddedOpenDeskOffice();

        createWindow();

        // 启动阶段不采集遥测；主窗口显示后再初始化运行期遥测。
        const triggerTelemetryInitialization = () => void ensureTelemetryReady();
        if (globalMainWindow && !globalMainWindow.isVisible()) {
            globalMainWindow.once('ready-to-show', triggerTelemetryInitialization);
        } else {
            triggerTelemetryInitialization();
        }

        // 浏览器持久化 session 不参与主窗口首屏，窗口显示后再在后台初始化。
        const triggerBrowserInitialization = () => void ensureBrowserReady();
        if (globalMainWindow && !globalMainWindow.isVisible()) {
            globalMainWindow.once('ready-to-show', triggerBrowserInitialization);
        } else {
            triggerBrowserInitialization();
        }

        // BrowserWindow 已开始加载；同步恢复任务状态时 renderer 进程可以并行解析页面。
        GlobalState.initialize();
        registerTaskManagerAPIHandlers();
        initTaskStatusWidget({
            getPreloadPath: getRendererPreloadPath,
            getMainWindow: () => globalMainWindow,
            getTaskList: () => GlobalState.getInstance().taskManagerState.getTaskList(),
            addTaskListSubscriber: (subscriber) => GlobalState.getInstance().taskManagerState.addSubscriber(subscriber),
            loadWidgetPage: (win) => {
                if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
                    const baseUrl = process.env['ELECTRON_RENDERER_URL'];
                    void win.loadURL(new URL('task_status_widget.html', baseUrl).toString());
                } else {
                    void win.loadFile(path.join(__dirname, '..', 'renderer', 'task_status_widget.html'));
                }
            },
            getFloatingWindowMode: () => {
                const raw = (Setting.getInstance().getData().gui_config as Record<string, unknown>)
                    ?.floating_window_mode;
                return raw === 'pill' || raw === 'card' ? raw : undefined;
            },
            getTaskUsageSnapshot: (taskId) =>
                GlobalState.getInstance().taskManagerState.getTask(taskId)?.getUsageSnapshot(),
            subscribeTaskUpdate: (taskId, subscriber) => {
                const task = GlobalState.getInstance().taskManagerState.getTask(taskId);
                if (!task) {
                    return undefined;
                }
                task.addSubscriber(subscriber);
                return () => task.removeSubscriber(subscriber.subscription_id);
            }
        });
        AgentRegistry.initBuiltinAgents();
        startMemoryCleanupScheduler(() =>
            FactorialMemoryStore.getInstance(Setting.getInstance().getEffectiveWorkspace()).cleanupStaleMemories()
        );
        startProxyEnvRefreshScheduler();

        await initializePluginHost();
        GlobalState.getInstance().taskManagerState.toolsetProvider = combineToolsetProviders(
            {
                listAvailableToolsets: () => ApplicationRegistry.listAvailableToolsets()
            },
            new PluginToolsetProvider()
        );

        registerMemoryReviewHook({
            taskManagerState: GlobalState.getInstance().taskManagerState,
            initializeReviewTask: initializeMemoryReviewTask
        });

        registerGoalHooks();

        initializeHarnesses();
        initAgentGateHook();

        // Worker 会继承 ARKDATA_AVAILABLE，因此原生桥探测必须先于 Worker 和应用 Agent 初始化。
        // 在本回调首次让出事件循环前注册，确保 renderer 的 native bridge IPC 被派发时 handler 已就绪。
        registerNativeBridge();
        await probeArkdataAvailability();

        // 启动 global worker（同步 spawn，不阻塞）。
        // Worker 初始化与应用 Agent 加载将在 createWindow 之后并行执行，避免阻塞窗口显示。
        initializeRegistryWorker({ preferredSystemLanguages: getPreferredSystemLanguagesForLocale() });
        resolveRegistryWorkerReady();

        // createWindow 之后并行执行重初始化，不阻塞窗口显示。
        // renderer 加载页面需要时间（dev 模式需 Vite 编译），这些初始化会在
        // renderer 就绪前完成。
        const startupWorkspace = Setting.getInstance().getEffectiveWorkspace();
        const agentDecl = AgentRegistry.getMainAgent();
        const defaultMode =
            agentDecl.supportedModes().find((candidate) => candidate.id === _currentElectronModeId) ??
            agentDecl.getDefaultMode();

        // Promise A: AgentGate 钩子注册 -> lazy harness 初始化
        const agentsReady = (async () => {
            // 注册 GUI 侧 afterFinishTurn 钩子（会话结束时恶意 skill 归因 + 弹窗推送）。
            // 钩子注册逻辑在 AgentGateApplication.registerGuiHooks 内部，此处只注入 IPC 推送回调。
            {
                const { AgentGateApplication } = await import('./applications/agentgate/app');
                const agApp = ApplicationRegistry.getApplication('agentgate') as AgentGateApplication | undefined;
                agApp?.registerGuiHooks((channel: string, payload: object) => {
                    if (globalMainWindow && !globalMainWindow.isDestroyed()) {
                        safeSendToWebContents(globalMainWindow.webContents, channel, payload);
                    }
                });
            }

            // IPC handler：用户确认后将 skill 加入黑名单（转发到 SkillMgrApplication）
            ipcMain.on(
                'skill:blacklist:add',
                (_event, items: Array<{ bundleName: string; skillName: string; reason: string; evidence: string }>) => {
                    // 恶意技能检测开关关闭时，拒绝新增黑名单（已有条目仍由 filter 生效）
                    const agCfgAdd = Setting.getInstance().getApplicationConfig('agentgate') as any;
                    if (agCfgAdd?.maliciousSkillDetection === false) return;
                    const skillmgr = ApplicationRegistry.getApplication('skillmgr') as SkillMgrApplication | undefined;
                    skillmgr?.addSkillsToBlacklist(items);
                }
            );

            // IPC handler：清除指定任务的拦截记录（用户忽略时，转发到 SkillMgrApplication）
            ipcMain.on('skill:blacklist:dismiss', (_event, taskId: string) => {
                const skillmgr = ApplicationRegistry.getApplication('skillmgr') as SkillMgrApplication | undefined;
                skillmgr?.dismissInterceptions(taskId);
            });

            // 为恢复的任务设置共享 harness 延迟初始化。
            // 旧方案在启动时遍历所有 task 创建 HarnessContext（含 GlobPermissionEnforcer），
            // 每个 enforcer 编译 ~17 条 picomatch 规则（~70KB），814 个 task ≈ 56 MB。
            // 新方案：按 workspace 创建共享 enforcer，task 被实际访问时才注入 harness。
            await GlobalState.getInstance().taskManagerState.setupLazyHarnessInit(
                defaultMode,
                startupWorkspace,
                () => new ElectronPermissionPromptProvider()
            );
        })();

        await agentsReady;

        // 延迟加载在主窗口显示后触发，避免与 renderer 首次加载竞争资源
        const triggerLazyLoading = () => ApplicationRegistry.ensureFullyLoaded();
        if (globalMainWindow && !globalMainWindow.isVisible()) {
            globalMainWindow.once('ready-to-show', triggerLazyLoading);
        } else {
            triggerLazyLoading();
        }

        // 注册 exitPlanMode IPC handler，防止 renderer 在任务创建前查询时报错
        new ElectronExitPlanModeProvider();

        // 鸿蒙平台：启动时校验华为账号登录，未登录则阻塞直到登录成功或退出
        await ensureHuaweiAuthOnStartup();

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
        try {
            await installBundledSkillsIfNeeded();
        } catch (err) {
            logger.error('installBundledSkillsIfNeeded error', err);
        }

        initializeScreenAdaption();
        registerBrowserAPIHandlers();
        registerMemoryAPIHandlers();
        registerUsageAPIHandlers();
        // registerTaskManagerAPIHandlers() 已在同步恢复 GlobalState 后注册；首次让出主进程
        // 事件循环前 handler 已就绪，可响应 renderer sidebar 的 taskManager:getTaskList。
        registerModeAPIHandlers();
        registerFSAPIHandlers();
        // registerSettingAPIHandlers() 已在 createWindow 之前提前注册，
        // 鸿蒙登录校验期间 renderer 需要调用 setting:loadSettingObject 判断是否显示引导页
        // registerApplicationRegistryHandlers(ipcMain) 已在 createWindow 之前提前注册，
        // 鸿蒙登录校验期间 renderer 的 sidebar 需调用 applicationRegistry:getApplicationList

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
                // 确保应用已完成延迟加载
                await ApplicationRegistry.getApplication(bundleName)?.ensureLoaded();
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

        // registerNotificationAPIHandlers() 已在 createWindow 之前提前注册，
        // 确保主窗口加载期间 renderer 的 notification-panel 能正常订阅通知。
        registerScreenAPIHandlers();
        registerMagicPointerHandlers();
        registerAuthAPIHandlers();
        registerDisplayZoomHandlers();
        // registerThemeHandlers() 已在 createWindow 之前提前注册，
        // getMainThemeService().init() 在 IPC handler 内部懒调用，避免 createWindow
        // 之前触发 callArkTS 导致 ArkTS 侧 NAPI 类型断言 crash。
        // 此处 createWindow() 已完成、ArkTS 侧已 active，显式 init() 安全，
        // 确保窗口背景色等主题效果在显示前就绪。
        getMainThemeService().init();
        registerHotKeys();
        registerTray();

        migrateFileMgrWorkspaceSettingsOnStartup();

        initializeProtocolHandlers();

        ApplicationRegistry.onReady(async () => {
            const channelMgrApp = ApplicationRegistry.getApplication('channelmgr') as ChannelMgrApplication | undefined;
            if (channelMgrApp) {
                const router = new ChannelMessageRouter(GlobalState.getInstance().taskManagerState, startupWorkspace);

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

                channelMgrApp.configureRouter(router, startupWorkspace);
                // 延迟启动渠道插件，避免与启动关键路径竞争资源
                setTimeout(() => {
                    channelMgrApp
                        .ensureLoaded()
                        .then(() => logger.info('[electron] channelmgr 消息路由已初始化'))
                        .catch((err) => logger.error(`[electron] channelmgr 初始化失败: ${err}`));
                }, 3000);
            }
        });

        // 启动 AgentGate 运行时（注入事件推送回调；是否真正启停由 application 读取配置决定）
        try {
            const { AgentGateApplication } = await import('./applications/agentgate/app');
            const agApp = ApplicationRegistry.getApplication('agentgate') as AgentGateApplication | undefined;
            if (agApp) {
                agApp.startRuntime((events, counts) => {
                    if (globalMainWindow && !globalMainWindow.isDestroyed()) {
                        safeSendToWebContents(globalMainWindow.webContents, 'agentgate:eventsUpdate', {
                            events,
                            counts
                        });
                    }
                });
            }
        } catch (err) {
            logger.warn(`AgentGate bridge start failed: ${err}`);
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

        // 启动完成后异步清理过期日志，不阻塞主流程
        dropDeprecatedLogs().catch(() => {});
    });

    app.on('will-quit', async () => {
        globalShortcut.unregisterAll();
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
        if (telemetryReadyPromise) {
            await telemetryReadyPromise;
        }
        if (telemetryModulePromise) {
            const telemetry = await telemetryModulePromise;
            await telemetry.shutdownTelemetry();
        }
    });
}

void startApplication();
