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

import { FileWatchService, type FileWatchSubscription } from './services/file-watch/service.js';
import { TaskSearchService } from './services/task-search/service.js';
import { TASK_SEARCH_MAX_QUERY, TASK_SEARCH_MAX_RESULTS } from '../common/task-search.js';
import { createRequire } from 'module';

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
    powerSaveBlocker,
    clipboard
} from 'electron';
import type { WebContents } from 'electron';
import { installBrowserCredentials } from './services/browser-credentials/manager.js';
import { initializeBrowserCredentials } from './services/browser-credentials/runtime.js';
import {
    Setting,
    ModelInstance,
    getOpendeskDirectory,
    getTaskDirectory,
    getTaskArtifactDirectory,
    getLogDirectory,
    isDeveloperModeEnabled,
    isDebugLogEnabled,
    isOpendeskDebugMode
} from './utils/setting.js';
import { runSettingSideEffects, type SettingSideEffect } from './utils/setting-side-effects.js';
import { QuickPassHelper } from './utils/quickpass.js';
import { getWindowsDrives } from './utils/drives.js';
import { cleanPathInput } from '../utils/path.js';
import { sandboxPathToHostPath } from '../common/utils/path.js';
import { toErrorMessage } from '../common/utils/error.js';
import { PROVIDER_TEMPLATES } from './tui/components/config/providers.js';
import { GlobalState } from './aikernel/states/global.js';
import { BaseToolset } from './aikernel/tool';
import { is } from '@electron-toolkit/utils';
import { z } from 'zod';
import { NotificationManager } from './utils/notificationmgr.js';
import {
    LogStream,
    logger,
    setDebugMode,
    useConsoleTransport,
    dropDeprecatedLogs,
    getLogFilename
} from './utils/logger.js';
import { broadcastToAllWindows, safeSendToWebContents, safeSendToWebFrame } from './utils/electron-ipc.js';
import {
    isRecoverableMainProcessError,
    logRecoverableMainProcessError,
    shouldDowngradeRecoverableError
} from './utils/recoverable-errors.js';
import { createMainWindowCloseHandler } from './utils/window-close.js';
import { registerNotificationMainWindowResolver } from './utils/system-notification.js';
import { installMainWindowNavigationGuard } from './utils/main-window-navigation.js';
import { createReloadBudget, createWindowRecoveryController, freezeRecoveryProfile } from './utils/window-recovery.js';
import { skillRegistry } from './applications/skillmgr/utils/skill-registry.js';
import { SkillMgrApplication } from './applications/skillmgr/app.js';
import { scanSupportedShells } from './applications/terminal/scan.js';
import { registerInteractiveTerminalHandlers } from './applications/terminal/interactive/handlers.js';
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
import { exportTaskJsonToFile, exportTaskToHtml, generateTaskHtml } from './utils/export.js';
import { registerTaskTransferHandlers } from './utils/task-transfer-ipc.js';
import { refreshRuntimePreferredSystemLanguages } from './utils/system-language-refresh.js';
import * as taskTransfer from './aikernel/task/transfer.js';
import { saveTaskExportHtml } from './utils/export-html-writer.js';
import { getMainThemeService, registerThemeHandlers } from '../renderer/theme/main-theme-service.js';
import { AgentRegistry } from './aikernel/agents/registry.js';
import { HarnessContext } from './aikernel/security/harness.js';
import { ElectronPermissionPromptProvider } from './aikernel/security/electronPrompt.js';
import { ElectronExitPlanModeProvider } from './aikernel/interaction/electronExitPlanMode.js';
import {
    activateOpenDeskOfficeContents,
    attachOpenDeskOfficeWindow,
    configureOpenDeskOfficeWebPreferences,
    getEmbeddedOpenDeskOfficeContentsKind,
    getEmbeddedOpenDeskOfficeEditorKind,
    isEmbeddedOpenDeskOfficeContents,
    registerEmbeddedOpenDeskOffice,
    requestCloseOpenDeskOfficeContents
} from './office/openDeskOfficeHost.js';
import { isOpenDeskOfficePartition } from '../common/officeWebview.js';
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
import { startReporter } from './utils/reporter.js';
import { submitFeedback } from './utils/feedback.js';
import { getUsageDashboardSummary, getUsageRankings, type RankPeriod } from './telemetry/local-telemetry.js';
import { TelemetryOperation, TelemetryOperationRegistry } from './telemetry/operation.js';
import { registerGoalHooks } from './aikernel/goal/hooks.js';
import { registerDesktopAPIHandlers, registerTrashAPIHandlers } from './windows/handlers.js';
import { DisplayZoomSync } from './windows/display-zoom-sync.js';
import { initializeHarnesses } from './aikernel/harnesses/index.js';
import { initAgentGateHook } from './applications/agentgate/hook.js';
import {
    PluginToolsetProvider,
    combineToolsetProviders,
    disposePluginHost,
    initializePluginHost,
    syncPluginSkillServers
} from './applications/pluginmgr/index.js';
import { GoalController } from './aikernel/goal/controller.js';
import { GoalService } from './aikernel/goal/service.js';
import type { GoalCommandResult } from './aikernel/goal/state.js';
import { parseGoalEditIfMatch } from '../common/goal/command.js';
import { parseMarkdownSafe } from './aikernel/messages.js';
import { buildTaskContextDiagnostics } from './aikernel/context/task-diagnostics.js';
import {
    lookupKnownContextSize,
    lookupKnownMaxOutputTokens,
    resolveModelVisionSupport,
    resolveModelReasoningEfforts,
    fetchContextSizeFromAPI
} from './utils/model-context.js';
import { fetchModelUrl } from './utils/model-network.js';
import { fetchProviderModelNames } from './utils/provider-models.js';
import { LLM } from './aikernel/llm.js';
import {
    BrowserManager,
    setCDPLogger,
    setSnapshotDialogTextsProvider,
    setSnapshotPrefixProvider
} from '../common/embedBrowserUse/main';
import { openDeskScriptGenerators } from './applications/browser/utils.js';
import { browserHintsSnapshotPrefixProvider } from './applications/browser/hints.js';
import { Channels as EmbedBrowserChannels } from '../common/embedBrowserUse/protocol';
import { registerNativeBridge, resolveNativeBridge } from '../platforms/bridges/main.js';
import { QUICK_CAPTURE_BRING_MAIN_TO_FRONT_EVENT } from '../platforms/bridges/common.js';
import { getHuaweiAuthService } from '../platforms/bridges/harmonyos/auth/huawei-auth.js';
import { listGatewayListenHostOptions } from './applications/devicemgr/common.js';
import { getExecutionNode, listExecutionNodes } from './applications/devicemgr/execution.js';
import { registerElectronAccountIntegration } from './applications/account/electron.js';
import { type TaskState, isTaskVisibleForDeveloperMode } from './aikernel/states/tasks.js';
import { getLocale, getRuntimePreferredSystemLanguages, t } from '../locale/index.js';
import { getLocalePackStore } from '../locale/packs.js';
import { getAttachmentFileSupport, UnsupportedAttachmentFileTypeError } from './aikernel/attachment-support.js';
import { replaceTaskHarnessForWorkspace, switchTaskMode } from './aikernel/task/mode.js';
import {
    expandVisualBounds,
    LINUX_WINDOW_SHADOW_MARGIN,
    normalizeShadowResizeDirection,
    shrinkWindowBounds
} from './windows/linux-window-shadow.js';
import {
    endShadowResizeSession,
    startShadowResizeSession,
    updateShadowResizeSession,
    type ShadowResizeDriver
} from './windows/shadow-resize.js';
import {
    endWindowDragSession,
    startWindowDragSession,
    updateWindowDragSession,
    type WindowDragDriver
} from './windows/window-drag.js';
import { attachNormalBoundsTracker } from './utils/normal-bounds-tracker.js';
import { suppressWmSystemMenuOnLinux } from './windows/linux-context-menu.js';
import { installTouchLongPress } from './windows/touch-long-press.js';
import {
    initTaskStatusWidget,
    installTransparentBackgroundReassert,
    setMainWindowHidden,
    setMainWindowFocused
} from './windows/task-status-widget-window.js';
import { registerElectronUpdateService } from './updater/electron-service.js';

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
import { openSystemTrash, initializeTrash, startTrashPreviewCleanupScheduler } from './utils/trash.js';
import os from 'os';
import fsPromises from 'fs/promises';

import { getAppIconPath, getWindowIcon } from './utils/app-icon.js';
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
// macOS 关闭终端后 TTY 写入可能报 EIO；仅忽略终端错误，保留重定向文件的 I/O 故障。
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || (process.stdout.isTTY && err.code === 'EIO')) return;
    throw err;
});
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || (process.stderr.isTTY && err.code === 'EIO')) return;
    throw err;
});

// 全局异常兜底：记录日志并向用户展示错误对话框
process.on('uncaughtException', (err, origin) => {
    const errDetails = err instanceof Error ? err.stack || err.message : String(err);
    const debugMode = isOpendeskDebugMode();

    // 可恢复错误（窗口/renderer 已销毁的竞态、管道断开等）：进程健康，降级为告警，
    // 不弹 FATAL 对话框也不退出进程
    const recoverableReason = isRecoverableMainProcessError(err);
    if (recoverableReason !== null && shouldDowngradeRecoverableError(recoverableReason, debugMode)) {
        logRecoverableMainProcessError(logger.warn.bind(logger), recoverableReason, `(${origin}) ${errDetails}`);
        return;
    }

    // 命中可恢复判定但被 debug 模式拦下时，日志要说明原因，否则看着和未知崩溃一样
    const downgradeHint =
        recoverableReason !== null ? ` (可恢复类别: ${recoverableReason}，debug 模式下按致命处理)` : '';
    logger.error(`[FATAL] uncaughtException (${origin}): ${errDetails}${downgradeHint}`);
    if (!debugMode) {
        try {
            dialog.showErrorBox(
                'OpenDesk 发生不可恢复的错误',
                `${origin}\n\n${errDetails}\n\n程序即将退出，请查看日志获取详细信息。`
            );
        } catch {
            /* dialog 可能在 app ready 前不可用 */
        }
    }
    app.exit(1);
});

process.on('unhandledRejection', (reason, _promise) => {
    const reasonDetails = reason instanceof Error ? reason.stack || reason.message : String(reason);
    const debugMode = isOpendeskDebugMode();

    // 与 uncaughtException 同一套可恢复判定：销毁竞态经 Promise 链冒泡时同样只降级告警
    const recoverableReason = isRecoverableMainProcessError(reason);
    if (recoverableReason !== null && shouldDowngradeRecoverableError(recoverableReason, debugMode)) {
        logRecoverableMainProcessError(
            logger.warn.bind(logger),
            recoverableReason,
            `unhandledRejection: ${reasonDetails}`
        );
        return;
    }

    const downgradeHint =
        recoverableReason !== null ? ` (可恢复类别: ${recoverableReason}，debug 模式下按致命处理)` : '';
    logger.error(`[FATAL] unhandledRejection: ${reasonDetails}${downgradeHint}`);
    if (!debugMode) {
        try {
            dialog.showErrorBox(
                'OpenDesk 发生不可恢复的错误',
                `unhandledRejection\n\n${reasonDetails}\n\n程序即将退出，请查看日志获取详细信息。`
            );
        } catch {
            /* dialog 可能在 app ready 前不可用 */
        }
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
// Linux 上启用透明 visual：透明窗口（主窗口/悬浮窗自绘圆角）依赖 ARGB 输出，
// 缺省合成路径下 alpha 会被写入为不透明，导致圆角外区域呈现底色
if (process.platform === 'linux') {
    app.commandLine.appendSwitch('enable-transparent-visuals');
}
// OpenHarmony 规避渲染进程沙箱崩溃（启动白屏）：
// OHOS Electron 渲染沙箱的 seccomp 策略未放行 timerfd_create，系统图形栈 FFRT
// 初始化（由字体枚举路径首次触发）收到 EPERM 后抛出未捕获异常，导致渲染进程
// SIGABRT 循环崩溃、窗口白屏。待框架侧在 seccomp 策略放行 timerfd_create 后
// 可移除此开关。
if ((process.platform as string) === 'openharmony') {
    app.commandLine.appendSwitch('no-sandbox');
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
let resolveMainWindowShown: (() => void) | undefined;
const mainWindowShown = new Promise<void>((resolve) => {
    resolveMainWindowShown = resolve;
});

function signalMainWindowShown(): void {
    const resolve = resolveMainWindowShown;
    if (!resolve) return;
    resolveMainWindowShown = undefined;
    resolve();
}

function restoreHuaweiLoginForWorkbenchWindow(reason: string): void {
    if ((process.platform as string) !== 'openharmony' || !isHuaweiStartupAuthPending || isHuaweiLoginRestorePending) {
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

// ohos bridge 延迟 require：与 locale/index.ts、system-language-refresh.ts 的取值路径一致，
// 避免非 ohos 平台启动时加载 bridge 模块链
const require = createRequire(import.meta.url);

function getPreferredSystemLanguagesForLocale(): string[] {
    // 缓存优先：主进程与 Worker 共用同一份注入值（app ready 后注入、主窗口 focus 时刷新），
    // 避免每次调用都跨 NAPI 查询系统语言
    const injected = getRuntimePreferredSystemLanguages();
    if (injected) {
        return [...injected];
    }
    // 缓存未就绪时的回退链与 locale/index.ts getSystemPreferredLanguages 保持一致
    // （bridge 缓存 > Electron），保证注入给 Worker 的值与 getLocale() 的解析来源一致
    try {
        // Only available on OpenHarmony with bridge initialized;
        // uses the same cache as system-theme.ts (warmed up by MainThemeService).
        const { getCachedOhosSystemLanguage } = require('../platforms/bridges/harmonyos/system-theme.js') as {
            getCachedOhosSystemLanguage?: () => string;
        };
        const lang = getCachedOhosSystemLanguage?.();
        if (lang) {
            return [lang];
        }
    } catch {
        // bridge 模块不可用：退化 Electron API
    }
    try {
        // 与 locale/index.ts 的防御一致：app 未 ready 时不查询系统语言（避免 pre-ready
        // 行为差异被一次性固化进缓存）
        if (app.isReady && !app.isReady()) {
            return [];
        }
        const languages = app.getPreferredSystemLanguages();
        return Array.isArray(languages) ? languages : [];
    } catch {
        return [];
    }
}

// app ready 后经 refreshRuntimePreferredSystemLanguages（bridge 优先，退化 Electron）注入
// 系统首选语言缓存：与主窗口 focus 时的刷新共用同一取值路径，避免注入值与刷新值来源不一致
// 导致首次 focus 产生纠正性广播。此后主进程 getLocale()/t() 的 auto 解析只读这份缓存，
// 与 Worker 的注入机制保持一致；首次注入只预热缓存，不会触发变更广播。
void app.whenReady().then(() => {
    refreshRuntimePreferredSystemLanguages().catch((error: any) => {
        logger.warn(`[locale] failed to inject system languages at startup: ${error?.message ?? error}`);
    });
});

let systemLanguageRefreshInFlight: Promise<void> | null = null;

/**
 * 主窗口获得焦点时刷新系统语言：用户切出去修改系统语言再切回来时实时感知。
 * 经 bridge（不可用时退化 Electron API）取一次最新语言更新注入缓存；
 * 生效语言变化（语言设置为 auto，或为语言包卸载后按系统语言解析的残留值）时，
 * 同步 Worker 并广播 setting:changed，各界面按新的 resolved_locale 一起切换语言。
 */
async function refreshSystemLanguageOnMainWindowFocus(): Promise<void> {
    if (systemLanguageRefreshInFlight) {
        return systemLanguageRefreshInFlight;
    }
    systemLanguageRefreshInFlight = refreshRuntimePreferredSystemLanguages()
        .then(async (outcome) => {
            if (!outcome.shouldBroadcast) {
                return;
            }
            logger.info('[locale] system language changed, broadcasting locale switch to all windows');
            try {
                await notifyWorkerCurrentSettingUpdate();
            } catch (error: any) {
                logger.warn(`[locale] failed to sync system language to worker: ${error?.message ?? error}`);
            }
            broadcastSettingChangedToAllWindows();
        })
        .catch((error: any) => {
            logger.warn(`[locale] failed to refresh system language on window focus: ${error?.message ?? error}`);
        })
        .finally(() => {
            systemLanguageRefreshInFlight = null;
        });
    return systemLanguageRefreshInFlight;
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

        initializeBrowserCredentials();
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

const OPENDESK_BROWSER_PARTITION = 'persist:opendesk-browser';

function isEmbeddedBrowserContents(contents: WebContents): boolean {
    return contents.session === session.fromPartition(OPENDESK_BROWSER_PARTITION);
}

function installWebviewKeyboardForwarding(
    hostWindow: BrowserWindow,
    contents: WebContents,
    preservePlainBrowserTab: boolean
): void {
    contents.on('before-input-event', (event, input) => {
        if (hostWindow.isDestroyed()) return;
        if (input.key === 'Escape' && input.type === 'keyDown' && hostWindow.isFullScreen()) {
            hostWindow.setFullScreen(false);
            event.preventDefault();
            return;
        }
        const modifiers = input.modifiers ?? [];
        const isPlainTab =
            input.key === 'Tab' &&
            !modifiers.some((modifier) => modifier === 'control' || modifier === 'meta' || modifier === 'alt');
        if (preservePlainBrowserTab && isPlainTab) return;

        safeSendToWebContents(hostWindow.webContents, 'webview:keyboard-event', {
            type: input.type,
            key: input.key,
            code: input.code,
            modifiers: input.modifiers
        });
    });
}

function installEmbeddedBrowserLifecycleHandlers(hostWindow: BrowserWindow, contents: WebContents): void {
    contents.setWindowOpenHandler(({ url }) => {
        if (url && url !== 'about:blank' && !hostWindow.isDestroyed()) {
            safeSendToWebContents(hostWindow.webContents, EmbedBrowserChannels.popupBlocked, url, contents.id);
        }
        return { action: 'deny' };
    });

    (contents as NodeJS.EventEmitter).on('close', () => {
        if (hostWindow.isDestroyed()) return;
        safeSendToWebContents(hostWindow.webContents, EmbedBrowserChannels.webviewCloseRequested, contents.id);
    });
}

function installNonBrowserWindowOpenPolicy(contents: WebContents): void {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function installWebviewHostHandlers(hostWindow: BrowserWindow): void {
    hostWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
        // 非活跃 webview 默认开启后台节流；Browser 和 Office 会在各自分支显式关闭。
        webPreferences.backgroundThrottling = true;
        const src = params.src ?? '';
        if (isOpenDeskOfficePartition(webPreferences.partition)) {
            const officeEditorKind = getEmbeddedOpenDeskOfficeEditorKind(src, webPreferences.partition);
            if (!officeEditorKind) {
                logger.warn(`Blocked untrusted OpenDesk Office webview URL: ${src || '<empty>'}`);
                event.preventDefault();
                return;
            }
            configureOpenDeskOfficeWebPreferences(officeEditorKind, webPreferences);
            return;
        }

        // 仅 browser application 的 webview 注入 window.open proxy preload
        // 页面代理通过同步 contextBridge 注入；凭据逻辑保留在隔离上下文。
        const isBrowserWebview = webPreferences.partition === OPENDESK_BROWSER_PARTITION;
        if (isBrowserWebview) {
            webPreferences.preload = path.join(__dirname, '..', 'preload', 'webviewPreload.js');
            webPreferences.contextIsolation = true;
            webPreferences.nodeIntegration = false;
            webPreferences.sandbox = true;
            // 浏览器面板 webview 关闭后台节流：后台任务 offscreen 渲染时，
            // 麒麟系统定制 Chromium 仍会节流定时器/动画，导致页面 JS 误判触发弹窗告警。
            webPreferences.backgroundThrottling = false;
            if (BrowserManager.browserSession) webPreferences.session = BrowserManager.browserSession;
            return;
        }

        const isApplicationGuest = src.includes('application.html');
        if (isApplicationGuest) {
            webPreferences.preload = getRendererPreloadPath();
            webPreferences.contextIsolation = true;
            webPreferences.nodeIntegration = false;
        }
    });

    hostWindow.webContents.on('did-attach-webview', (_event, webContents) => {
        if (isEmbeddedOpenDeskOfficeContents(webContents)) {
            // Office webview 永远不接入 Browser 标签页协议，即使首个 URL 尚未提交。
            installNonBrowserWindowOpenPolicy(webContents);
            installWebviewKeyboardForwarding(hostWindow, webContents, false);
            const officeEditorKind = getEmbeddedOpenDeskOfficeContentsKind(webContents);
            if (!officeEditorKind) {
                logger.warn(`Ignored untrusted OpenDesk Office webview URL: ${webContents.getURL() || '<empty>'}`);
                return;
            }
            activateOpenDeskOfficeContents(officeEditorKind, webContents);
            return;
        }

        if (!isEmbeddedBrowserContents(webContents)) {
            // 其他 legacy webview 保留既有的弹窗/关闭转发行为；只有 Office 与 Browser 协议隔离。
            installEmbeddedBrowserLifecycleHandlers(hostWindow, webContents);
            installWebviewKeyboardForwarding(hostWindow, webContents, false);
            return;
        }

        installBrowserCredentials(hostWindow, webContents);

        // 导航拦截 workaround（NAV_INTERCEPT_SCRIPT）由 renderer 侧按 tab 注入：
        // 脚本只安装在顶层文档（iframe 导航走原生通道，避免 sandbox 绕过），
        // 且 console 信令需要 renderer 生成的 tab 级一次性 token —— 主进程注入
        // 无法共享该 token，且会因幂等标记抢先占用而让 token 注入失效。
        installEmbeddedBrowserLifecycleHandlers(hostWindow, webContents);
        installWebviewKeyboardForwarding(hostWindow, webContents, true);
    });
}

const DEFAULT_WINDOW_WIDTH = 1600;
const DEFAULT_WINDOW_HEIGHT = 1080;
const MAIN_WINDOW_SHOW_FALLBACK_DELAY_MS = 1000;

/*
 * 冻结判定的运行档位：dev 下 vite 重编译、构建、全仓扫描都会把整机 CPU 打满，
 * renderer 心跳饿死十几秒是常态，按生产阈值判死会在几分钟内反复重载；
 * 生产环境相反，越早判死用户越早脱离冻结界面。
 */
const freezeProfile = freezeRecoveryProfile(is.dev);

/*
 * 主窗口异常重载入口。入口页加载失败、renderer 崩溃、GPU 进程退出共享同一份重载配额，
 * 避免它们互相触发形成重载风暴。
 */
const mainWindowReloadBudget = createReloadBudget(freezeProfile.reloadBudget);

/**
 * 判定 renderer 冻结时补充进程侧证据。
 *
 * 心跳与探活都无回应只能证明 renderer 主线程没在跑 JS，区分不了「真冻结」和「整机
 * CPU/IO 打满、renderer 抢不到时间片」。把渲染进程的 CPU/内存与实际加载状态一并记进
 * 判死日志，事后才能判断该不该调整阈值——没有这层信息时，两类现场在日志里完全一样。
 */
function describeFrozenMainWindow(): string | null {
    if (!globalMainWindow || globalMainWindow.isDestroyed()) return 'mainWindow=destroyed';
    const contents = globalMainWindow.webContents;
    if (contents.isDestroyed()) return 'webContents=destroyed';

    const parts: string[] = [];
    try {
        parts.push(`loading=${contents.isLoading()}`, `crashed=${contents.isCrashed()}`);
    } catch {
        // 窗口销毁竞态下这些 getter 可能抛错，诊断缺失不影响恢复流程
    }

    try {
        const osPid = contents.getOSProcessId();
        if (osPid > 0) {
            parts.push(`rendererPid=${osPid}`);
            const metric = app.getAppMetrics().find((item) => item.pid === osPid);
            if (metric) {
                parts.push(`cpu=${metric.cpu.percentCPUUsage.toFixed(1)}%`);
                // ProcessMetric.memory 单位为 KB
                parts.push(`workingSet=${Math.round(metric.memory.workingSetSize / 1024)}MB`);
                parts.push(`peakWorkingSet=${Math.round(metric.memory.peakWorkingSetSize / 1024)}MB`);
            }
        }
    } catch {
        // 同上：诊断失败不改变恢复决策
    }

    return parts.length > 0 ? parts.join(' ') : null;
}

/** 重新加载主窗口入口页；返回 false 表示窗口不可用或重载配额已耗尽 */
function reloadMainWindowEntry(reason: string): boolean {
    if (!globalMainWindow || globalMainWindow.isDestroyed()) return false;
    if (!mainWindowReloadBudget.tryConsume(reason)) return false;
    logger.warn(`reloading main window entry (reason: ${reason})`);
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        void globalMainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
        void globalMainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    }
    return true;
}

/**
 * 请求主窗口 renderer 立即补报一次心跳。
 *
 * renderer 侧心跳由定时器驱动，窗口被其他窗口遮挡或最小化时会被 Chromium 节流到分钟级，
 * 而 IPC 消息不受节流影响、仍会即时投递到 renderer 主线程，因此可用它来二次确认
 * 「心跳静默是后台节流还是 renderer 真冻结」（详见 utils/window-recovery.ts）。
 */
function probeMainWindowHeartbeat(): void {
    if (!globalMainWindow || globalMainWindow.isDestroyed()) return;
    const contents = globalMainWindow.webContents;
    if (contents.isDestroyed()) return;
    contents.send('renderer:heartbeat-probe');
}

const windowRecovery = createWindowRecoveryController({
    reload: reloadMainWindowEntry,
    // 窗口隐藏/最小化时 renderer 定时器会被节流，心跳缺失不代表冻结
    isWindowVisible: () =>
        !!globalMainWindow &&
        !globalMainWindow.isDestroyed() &&
        globalMainWindow.isVisible() &&
        !globalMainWindow.isMinimized(),
    requestHeartbeatProbe: probeMainWindowHeartbeat,
    heartbeatTimeoutMs: freezeProfile.heartbeatTimeoutMs,
    probeTimeoutMs: freezeProfile.probeTimeoutMs,
    describeFrozenRenderer: describeFrozenMainWindow,
    log: logger
});

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
    // Linux 主窗口自绘阴影：窗口矩形四周扩展阴影边距，renderer 侧内容容器
    // #app-root 内缩同样距离并绘制 box-shadow（titlebar.css 的 --od-window-margin）。
    // 非 Linux 平台 margin 为 0，bounds 换算恒等，既有行为不变。
    const shadowMargin = process.platform === 'linux' ? LINUX_WINDOW_SHADOW_MARGIN : 0;
    // renderer 侧的 CSS 长度是 CSS 像素，需按有效 zoom 反算才能与上面的 DIP 边距
    // 对齐；zoom 在窗口创建时已确定，用 additionalArguments 同步带给 preload，
    // 避免 renderer 首帧前还要等一次 IPC 才能算对边距
    const windowZoom = computeEffectiveZoom();
    // 尝试恢复上次保存的窗口尺寸与位置，无效或未保存时回退默认尺寸居中
    let savedBounds: { x: number; y: number; width: number; height: number; is_maximized?: boolean } | null = null;
    let windowX: number | undefined;
    let windowY: number | undefined;
    let windowWidth = DEFAULT_WINDOW_WIDTH;
    let windowHeight = DEFAULT_WINDOW_HEIGHT;
    try {
        const guiConfig = Setting.getInstance().getData().gui_config as Record<string, unknown>;
        const bounds = guiConfig.window_bounds as {
            x: number;
            y: number;
            width: number;
            height: number;
            is_maximized?: boolean;
        } | null;
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

    // 上面的 windowX/Y/W/H 均为视觉语义（window_bounds 保存的即用户看到的内容矩形），
    // 构造 BrowserWindow 前扩展为含阴影边距的窗口矩形
    const mainWindowBounds = expandVisualBounds(
        { x: windowX ?? 0, y: windowY ?? 0, width: windowWidth, height: windowHeight },
        shadowMargin
    );

    const mainWindow = new BrowserWindow({
        x: mainWindowBounds.x,
        y: mainWindowBounds.y,
        width: mainWindowBounds.width,
        height: mainWindowBounds.height,
        minHeight: 400 + shadowMargin * 2,
        minWidth: 850 + shadowMargin * 2,
        frame: false,
        // Linux(X11) 窗口管理器不为无边框窗口绘制圆角与阴影，改用透明窗口由页面
        // 自绘圆角+外阴影（参数与 task-status-widget 悬浮窗保持一致）
        transparent: process.platform === 'linux',
        roundedCorners: true,
        // 透明窗口必须显式透明底色，否则 Electron 默认白色画布会垫在圆角缺口下
        backgroundColor: process.platform === 'linux' ? '#00000000' : undefined,
        icon: getWindowIcon(),
        show: false, // 等 ready-to-show 后再显示，避免白屏闪烁
        paintWhenInitiallyHidden: true, // 允许在隐藏状态下预先渲染首帧
        webPreferences: {
            nodeIntegration: false,
            nodeIntegrationInSubFrames: true,
            contextIsolation: true,
            webviewTag: true,
            allowRunningInsecureContent: true,
            backgroundThrottling: true, // 窗口失焦时降低渲染频率（省电）
            preload: path.join(__dirname, '..', 'preload', 'index.js'),
            additionalArguments: [`--opendesk-zoom=${windowZoom}`]
        }
    });

    let hasShownMainWindow = false;
    let mainWindowShowFallbackTimer: NodeJS.Timeout | undefined;
    const clearMainWindowShowFallback = () => {
        if (!mainWindowShowFallbackTimer) return;
        clearTimeout(mainWindowShowFallbackTimer);
        mainWindowShowFallbackTimer = undefined;
    };
    const showMainWindow = (reason: 'ready-to-show' | 'did-finish-load fallback') => {
        if (mainWindow.isDestroyed() || hasShownMainWindow || mainWindow.isVisible()) return;
        // per-monitor DPI 下 BrowserWindow 构造时的 bounds 可能被错误缩放，
        // 在窗口已确定最终显示器（DPI 已就绪）后用 setBounds 精确修正
        // （savedBounds 为视觉语义，扩展阴影边距后再应用到窗口矩形）
        if (savedBounds) {
            mainWindow.setBounds(expandVisualBounds(savedBounds, shadowMargin));
            // 上次退出时处于最大化：先按 normal bounds 布局再调用 maximize()，
            // 让 WM 真实最大化（isMaximized() 同步为 true，还原几何也是本次
            // setBounds 的值）。不能直接把最大化尺寸的 bounds 当普通窗口尺寸
            // 模拟"假最大化"——双击标题栏的切换判断依赖 isMaximized()。
            if (savedBounds.is_maximized) {
                mainWindow.maximize();
            }
        }
        if (isHuaweiStartupAuthPending) {
            restoreHuaweiLoginForWorkbenchWindow(`workbench ${reason}`);
            return;
        }
        hasShownMainWindow = true;
        mainWindow.show();
        signalMainWindowShown();
        logger.info(`[startup] 主窗口已显示 (${reason})`);
    };

    // 就绪后显示窗口，避免白屏；did-finish-load 兜底处理 Electron 偶发丢失 ready-to-show 的情况。
    mainWindow.once('ready-to-show', () => {
        clearMainWindowShowFallback();
        showMainWindow('ready-to-show');
    });

    mainWindow.setMenu(null);
    mainWindow.webContents.once('did-finish-load', () => {
        mainWindowShowFallbackTimer = setTimeout(() => {
            mainWindowShowFallbackTimer = undefined;
            if (hasShownMainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
            logger.warn('[startup] ready-to-show 未触发，使用 did-finish-load 兜底显示主窗口');
            showMainWindow('did-finish-load fallback');
        }, MAIN_WINDOW_SHOW_FALLBACK_DELAY_MS);
    });
    mainWindow.once('closed', clearMainWindowShowFallback);
    // 主窗口与独立应用窗口共用同一个界面缩放偏好
    displayZoomSync.add(mainWindow);
    mainWindow.once('closed', () => displayZoomSync.remove(mainWindow));
    installWebviewHostHandlers(mainWindow);
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
        mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    }

    // 悬浮窗（pill/card 模式）依赖主窗口是否处于前台的焦点状态。
    mainWindow.on('blur', () => setMainWindowFocused(false));
    mainWindow.on('focus', () => {
        setMainWindowFocused(true);
        // 切出去修改系统语言再切回来时实时感知：每次获得焦点都刷新一次系统语言；
        // 生效语言变化（auto 或语言包卸载后的残留设置）时广播 locale 切换，各界面一起切换语言
        void refreshSystemLanguageOnMainWindowFocus();
    });

    // Linux/Windows 透明窗口在显示、尺寸变化等时机合成层偶发丢失 alpha（同
    // electron/electron#40515 缺陷），导致自绘圆角外露出不透明底色；
    // 统一挂载恢复钩子，在受影响时机重新声明透明背景并强制重绘。
    // 主窗口仅 Linux 为透明窗口（Windows 保持不透明底色随主题切换）。
    installTransparentBackgroundReassert(mainWindow, process.platform === 'linux');

    // 全屏状态变化时更新 tray 菜单文案
    mainWindow.on('enter-full-screen', () => {
        globalTray?.setContextMenu(buildTrayMenu());
    });
    mainWindow.on('leave-full-screen', () => {
        globalTray?.setContextMenu(buildTrayMenu());
    });

    // 跟踪 normal bounds：Linux 透明无边框窗口最大化后 getNormalBounds() 可能
    // 返回最大化尺寸（restored bounds 缓存被污染），退出保存时改用跟踪缓存。
    const normalBoundsTracker = attachNormalBoundsTracker(mainWindow);

    // 最大化状态变化主动推送 renderer：X11 下 WM 异步应用最大化，IPC 返回后
    // 立即回查 isMaximized() 拿到的还是旧值，图标/自绘圆角等 UI 状态会失同步。
    mainWindow.on('maximize', () => {
        safeSendToWebContents(mainWindow.webContents, 'setting:maximizeStateChanged', true);
    });
    mainWindow.on('unmaximize', () => {
        safeSendToWebContents(mainWindow.webContents, 'setting:maximizeStateChanged', false);
    });

    mainWindow.on(
        'close',
        createMainWindowCloseHandler({
            isAppQuitting: () => isAppQuitting,
            window: mainWindow,
            // 保存前收缩阴影边距，window_bounds 始终保持视觉矩形语义
            normalizeSaveBounds: (bounds) => shrinkWindowBounds(bounds, shadowMargin),
            getTrustedNormalBounds: () => normalBoundsTracker.getNormalBounds(),
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
    const isInternalUrl = (url: string) =>
        url.startsWith('file://') ||
        url.startsWith('http://localhost') ||
        url.startsWith('http://127.0.0.1') ||
        inAppSchemePrefixes.some((p) => url.startsWith(p));
    const openExternalLink = (url: string) => {
        logger.info(`openLink: ${url}`);
        void getPlatform()
            .openExternal(url)
            .catch((error) => {
                logger.warn(`openExternal failed for ${url}: ${error}`);
            });
    };

    // 可编辑区域的右键菜单（剪切/复制/粘贴/全选）由渲染层自绘菜单接管：
    // 主世界注入脚本统一处理真实右键与触摸长按的合成事件，菜单位置、主题与
    // 语言都可控（原生菜单只能弹在系统光标处，触摸长按时位置不可控）。
    // 此处不再弹原生编辑菜单；非编辑区域仍由全局 web-contents-created 钩子
    // 统一 preventDefault（Linux 下阻止 WM 系统菜单）。

    // 全屏状态下按 ESC 退出全屏（主窗口直接获焦时）
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'Escape' && input.type === 'keyDown' && mainWindow.isFullScreen()) {
            mainWindow.setFullScreen(false);
            event.preventDefault();
        }
    });

    installMainWindowNavigationGuard(mainWindow.webContents, {
        isInternalUrl,
        openExternal: openExternalLink
    });

    // 防御性兜底：如果主框架导航到外部 URL 后加载失败（will-navigate 拦截未生效或被绕过），
    // 自动重载应用入口页，避免用户面对灰色空白屏幕无法操作。
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
        if (!reloadMainWindowEntry(`did-fail-load ${validatedURL}`)) {
            logger.error(`did-fail-load: skipped reloading app entry for ${validatedURL}`);
        }
    });

    // renderer 进程崩溃时自动重载
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        logger.error(`render-process-gone: ${details.reason}`);
        reloadMainWindowEntry(`render-process-gone ${details.reason}`);
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
        signalMainWindowShown();
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
    // 系统通知（权限确认 / AskUser / 计划审批）点击后要唤起主窗口并打开对应任务，
    // 主窗口句柄在此统一注入，避免各 provider 用 getAllWindows() 顺序猜主窗口
    registerNotificationMainWindowResolver(() => globalMainWindow);
    attachOpenDeskOfficeWindow(mainWindow);
    BrowserManager.setMainWindow(mainWindow);
};

// renderer 侧诊断日志转发到主进程日志文件（如侧边栏任务列表刷新被跳过等）。
// 与 taskManager 无关的通用通道，故独立注册；来自 renderer 的内容不可信，
// 折叠换行避免伪造多行日志条目。
const registerRendererLogHandler = () => {
    ipcMain.on('renderer:log', (_event, level, message) => {
        const msg = String(message ?? '')
            .replace(/[\r\n]+/g, ' ')
            .trim();
        if (!msg) return;
        const tagged = `[renderer] ${msg}`;
        switch (level) {
            // debug 级别仅在调试模式开启时落盘（winston 级别随 setDebugMode 切换）
            case 'debug':
                logger.debug(tagged);
                break;
            case 'warn':
                logger.warn(tagged);
                break;
            case 'error':
                logger.error(tagged);
                break;
            default:
                logger.info(tagged);
        }
    });
};

// renderer 心跳上报，主进程据此判断 renderer 是否冻结（详见 window-recovery.ts）。
// 心跳不携带内容，仅证明 renderer 主线程仍在执行 JS。
const registerRendererHeartbeatHandler = () => {
    ipcMain.on('renderer:heartbeat', (event) => {
        // 所有窗口共用同一份 preload，只有主窗口的心跳参与冻结判定：
        // 悬浮窗或应用窗口存活时不应掩盖主窗口自身的冻结。
        if (!globalMainWindow || globalMainWindow.isDestroyed()) return;
        if (event.sender.id !== globalMainWindow.webContents.id) return;
        windowRecovery.onHeartbeat();
    });
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
    // 让「导出 Snapshot」（任务浏览器标签与浏览器应用）与 agent 的 snapshot 工具输出一致：
    // 都带上插件注册的 Browser Hints。
    setSnapshotPrefixProvider(browserHintsSnapshotPrefixProvider);
    // 任务浏览器标签的导出保存对话框由 embedBrowserUse 弹出：文案用 provider 注入，
    // 保证切换语言后（t() 每次按当前设置解析）取到的是新语言。
    setSnapshotDialogTextsProvider(() => ({
        title: t('main.browser.snapshot.saveDialog.title'),
        textFiles: t('main.browser.snapshot.saveDialog.textFiles'),
        allFiles: t('main.browser.snapshot.saveDialog.allFiles')
    }));

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
    registerTaskTransferHandlers(globalState.taskManagerState, () => globalMainWindow, taskTransfer);
    const taskSearch = new TaskSearchService(
        getTaskDirectory(),
        path.join(getOpendeskDirectory(), 'task-search-v1.sqlite'),
        {
            onChange: (unavailable) => broadcastToAllWindows('taskManager:searchChanged', unavailable === true),
            onError: (error) => logger.warn(`Task search worker failed: ${error.stack || error.message}`)
        }
    );
    try {
        taskSearch.start();
    } catch (error) {
        logger.warn(`Task search initialization failed: ${error}`);
    }
    app.once('will-quit', () => void taskSearch.dispose());
    // 退出前释放所有 BrowserController（CDP 会话与 debugger listener），确保干净卸载
    app.once('will-quit', () => BrowserManager.removeAllControllers());
    ipcMain.on('taskManager:refreshSearchIndex', () => {
        try {
            taskSearch.refresh();
        } catch (error) {
            logger.warn(`Task search refresh failed: ${error}`);
        }
    });
    ipcMain.handle('taskManager:searchTasks', async (_event, query: unknown, limit: unknown) => {
        if (
            typeof query !== 'string' ||
            query.length > TASK_SEARCH_MAX_QUERY ||
            typeof limit !== 'number' ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > TASK_SEARCH_MAX_RESULTS
        ) {
            return { status: 'error' };
        }
        try {
            const data = await taskSearch.search(query, limit, _event.sender.id);
            // Recheck live metadata without loading any task history. Deleted/internal
            // tasks must not leak through an index that is still being refreshed.
            const visible = new Map(
                globalState.taskManagerState.tasks
                    .filter((task) => task.internal !== true && Boolean(task.task_name?.trim() || task.name_pending))
                    .map((task) => [task.task_id, task])
            );
            data.items = data.items
                .filter((item) => visible.has(item.taskId))
                .map((item) => {
                    const task = visible.get(item.taskId)!;
                    return { ...item, title: task.task_name || '', workspace: task.workspace || '' };
                });
            return { status: 'ok', data };
        } catch (error) {
            logger.warn(`Task search failed: ${error}`);
            return { status: 'error' };
        }
    });

    // session memory 渲染缓存：内容未变化时直接复用上次 rendered，
    // 省去周期性轮询的重复 parse 开销。任务删除时一并清理，避免条目长期驻留。
    const sessionMemoryRenderCache = new Map<string, { content: string; rendered: string }>();

    ipcMain.handle('taskManager:listFrontendTailCardSections', (_event, taskId: unknown) => {
        if (typeof taskId !== 'string') {
            return { status: 'error', message: 'taskId must be a string' };
        }
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        return { status: 'ok', data: task.listFrontendTailCardSections() };
    });

    ipcMain.handle(
        'taskManager:setFrontendTailCardSection',
        (_event, taskId: unknown, id: unknown, content: unknown) => {
            if (typeof taskId !== 'string') {
                return { status: 'error', message: 'taskId must be a string' };
            }
            if (typeof id !== 'string') {
                return { status: 'error', message: 'id must be a string' };
            }
            if (typeof content !== 'string') {
                return { status: 'error', message: 'content must be a string' };
            }
            if (id === '') {
                return { status: 'error', message: 'id must not be empty' };
            }
            if (content === '') {
                return { status: 'error', message: 'content must not be empty' };
            }
            const task = globalState.taskManagerState.getTask(taskId);
            if (task === undefined) {
                return { status: 'error', message: `task ${taskId} not found` };
            }
            task.setFrontendTailCardSection(id, content);
            return { status: 'ok' };
        }
    );

    ipcMain.handle('taskManager:removeFrontendTailCardSection', (_event, taskId: unknown, id: unknown) => {
        if (typeof taskId !== 'string') {
            return { status: 'error', message: 'taskId must be a string' };
        }
        if (typeof id !== 'string') {
            return { status: 'error', message: 'id must be a string' };
        }
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        task.removeFrontendTailCardSection(id);
        return { status: 'ok' };
    });

    type CreateTaskOptions = {
        modeId?: string;
        selectedExecutionNodeId?: string | null;
        internal?: boolean;
        taskName?: string;
    };

    function normalizeCreateTaskOptions(raw: unknown): CreateTaskOptions {
        if (raw && typeof raw === 'object') {
            const obj = raw as Record<string, unknown>;
            const selectedExecutionNodeId = obj.selectedExecutionNodeId;
            return {
                modeId: typeof obj.modeId === 'string' ? obj.modeId : undefined,
                selectedExecutionNodeId:
                    typeof selectedExecutionNodeId === 'string'
                        ? selectedExecutionNodeId
                        : selectedExecutionNodeId === null
                          ? null
                          : undefined,
                internal: obj.internal === true,
                taskName: typeof obj.taskName === 'string' ? obj.taskName : undefined
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
        // system prompt 中的可派发 agent 列表是创建时刻的快照（此后不会重建）。
        // 应用的 agent 延迟加载在主窗口显示后才后台触发，若在此处不等待加载屏障，
        // 加载窗口内创建的任务将终身缺失自定义 agent，任务无法分发到这些 agent
        // （与 CLI/TUI 建任务前 await ensureFullyLoaded 的行为保持一致）。
        // 屏障通常启动后即已就绪，此处等待无感；agent 加载失败时屏障内部已兜底不会 reject。
        await ApplicationRegistry.ensureFullyLoaded();
        const task = globalState.taskManagerState.createTask(undefined, {
            internal: options.internal,
            taskName: options.taskName
        });
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

        for (const removedId of removedTaskIds) {
            sessionMemoryRenderCache.delete(removedId);
        }
        publishTaskTodosCleared(removedTaskIds);
        return { status: 'ok', data: taskId };
    });
    /**
     * 前台关闭/驱逐任务视图时，回收该任务在 main 进程中的重量级内存
     * （chat_context、扩展快照等），使其回到懒加载壳状态，下次打开时重新加载。
     * 仅被动响应前台请求，main 侧不做定时驱逐。
     */
    ipcMain.handle('taskManager:releaseTaskMemory', (_event, taskId) => {
        if (typeof taskId !== 'string') {
            return { status: 'error', message: 'taskId must be a string' };
        }
        // 用 tasks.find 而非 getTask()：getTask() 会触发 ensureLoaded()，
        // 反而把待释放的任务数据加载回来。
        const task = globalState.taskManagerState.tasks.find((candidate) => candidate.task_id === taskId);
        if (!task) {
            // 幂等：删除流程会先关闭视图（触发本 IPC）再删除任务，此时任务可能已不存在。
            return { status: 'ok', data: { released: false } };
        }
        sessionMemoryRenderCache.delete(taskId);
        const released = task.unload();
        return { status: 'ok', data: { released } };
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
            const mainAgent = AgentRegistry.getMainAgent();
            const mainModeId = task.activeModeId || _currentElectronModeId;
            const mainModes = mainAgent.supportedModes();
            const mainMode = mainModes.find((candidate) => candidate.id === mainModeId) ?? mainAgent.getDefaultMode();
            // lazy harness 初始化前 provider 可能为空，与切换前行为一致地兜底
            task.harnessContext.permissionPrompt =
                task.harnessContext.permissionPrompt || new ElectronPermissionPromptProvider();
            await replaceTaskHarnessForWorkspace(task, newWorkspace, (taskAgent) =>
                taskAgent.agentId === mainAgent.agentId ? mainMode : task.getAgentMode()
            );
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
        sessionMemoryRenderCache.clear();
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
                parent_id: task.parent_id,
                // 导出 header 需要的元数据：任务起止时间与累计 token 消耗
                started_at: task.started_at,
                created_at: task.created_at,
                finished_at: task.finished_at,
                total_elapsed_ms: task.total_elapsed_ms,
                usage_summary: task.usage_summary
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
    ipcMain.handle('taskManager:getContextDiagnostics', async (_event, taskId) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        try {
            // 复用 TUI /context 命令同款诊断管线，只读不写回任务状态
            const data = await buildTaskContextDiagnostics(task);
            return { status: 'ok', data };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`Context diagnostics failed for task ${taskId}: ${msg}`);
            return { status: 'error', message: msg };
        }
    });
    ipcMain.handle('taskManager:getTaskTodos', async (event, taskId) => {
        try {
            const todos = getTaskTodosForDisplay(taskId);
            return { status: 'ok', data: todos };
        } catch (err) {
            return { status: 'error', message: toErrorMessage(err) };
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
        const goalState = task.goal_state;
        const hasUnfinishedGoal =
            goalState !== undefined && goalState.status !== 'complete' && goalState.status !== 'cleared';
        if (hasUnfinishedGoal) {
            return {
                status: 'ok',
                data: {
                    ok: false,
                    status: goalState.status,
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
            data: await GoalService.addSupplement(task, {
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
        return result;
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
            task.reasoningEffort = details.reasoningEffort;
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
    ipcMain.handle('taskManager:setTaskModel', async (_event, taskId, modelAlias, reasoningEffort) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        if (modelAlias && !Setting.getInstance().getModelInstance(modelAlias, 'chat')) {
            return { status: 'error', message: t('error.model.chat_alias_not_found', { alias: modelAlias }) };
        }
        const previous = task.model;
        task.model = modelAlias || undefined;
        if (reasoningEffort !== undefined) {
            // 空字符串是显式选择模型默认档位，不能丢弃或保留旧的任务覆盖值。
            task.reasoningEffort = reasoningEffort;
        }
        task.persistLater();
        // 模型切换后立即重新过滤工具集：非视觉模型不应继续看到 readImage/askImage 等视觉工具，
        // 否则运行中的 turn 会在后续请求中继续调用已不匹配的工具并报"模型不支持视觉"错误。
        if (previous !== task.model) {
            try {
                await task.refreshToolsets();
            } catch (err) {
                logger.warn(
                    `failed to refresh toolsets after model switch: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        }
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
    // session memory 渲染缓存
    ipcMain.handle('taskManager:getSessionMemory', async (event, taskId) => {
        try {
            const content = await readTaskSessionMemory(taskId);
            if (!content || isSessionMemoryTemplateOnly(content)) {
                return { status: 'ok', data: null };
            }
            const cached = sessionMemoryRenderCache.get(taskId);
            if (cached && cached.content === content) {
                return { status: 'ok', data: { raw: content, rendered: cached.rendered } };
            }
            const rendered = await parseMarkdownSafe(content);
            sessionMemoryRenderCache.set(taskId, { content, rendered });
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
    // 打开各平台的回收站（Windows 系统回收站窗口；macOS/Linux/OpenHarmony 打开回收站目录）
    ipcMain.handle('fs:openTrash', async () => {
        try {
            await openSystemTrash();
            return { status: 'ok' };
        } catch (error: any) {
            logger.error('opening trash failed', error);
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
    // 保存 renderer 侧生成的任务导出 HTML（内联字体后写盘）
    ipcMain.handle('taskManager:saveExportHtml', async (event, filePath, html, fontUrls) => {
        try {
            await saveTaskExportHtml(filePath, html, fontUrls);
            return { status: 'ok', data: filePath };
        } catch (error: any) {
            logger.error('saving export html failed', error);
            return { status: 'error', message: error.message };
        }
    });
    // 将任务的 .task.json 导出到用户选择的路径
    ipcMain.handle('taskManager:exportTaskJson', async (event, taskId, filePath) => {
        const task = globalState.taskManagerState.getTask(taskId);
        if (task === undefined) {
            return { status: 'error', message: `task ${taskId} not found` };
        }
        try {
            await exportTaskJsonToFile(task, filePath);
            return { status: 'ok', data: filePath };
        } catch (error: any) {
            logger.error('exporting task json failed', error);
            return { status: 'error', message: error.message };
        }
    });
};

/** Shared regular-file validation and metadata for content reads and size-only queries. */
async function readFileMetadata(filePath: string): Promise<{ systemPath: string; size: number }> {
    if (typeof filePath !== 'string' || !filePath) throw new Error('filePath is required');
    const systemPath = filePath.replace(/\//g, path.sep);
    const stats = await fs.promises.stat(systemPath);
    if (!stats.isFile()) throw new Error('not a file');
    return { systemPath, size: stats.size };
}

const registerFSAPIHandlers = () => {
    const fileWatchService = new FileWatchService();
    type WatchedFile = { subscription?: FileWatchSubscription };
    // 每个窗口保存自己的订阅，最后一个订阅关闭时一并移除窗口清理回调。
    const fileWatchOwners = new Map<WebContents, { files: Map<string, WatchedFile>; dispose: () => void }>();

    const stopFileWatch = (sender: WebContents, id: string): void => {
        const owner = fileWatchOwners.get(sender);
        if (!owner) return;
        owner.files.get(id)?.subscription?.dispose();
        owner.files.delete(id);
        if (owner.files.size === 0) owner.dispose();
    };

    ipcMain.handle('fs:watchFile', async (event, id: string, filePath: string) => {
        const sender = event.sender;
        if (sender.isDestroyed() || event.senderFrame !== sender.mainFrame) {
            throw new Error('File watch requires the main frame');
        }
        if (typeof id !== 'string' || !id || typeof filePath !== 'string' || !filePath) {
            throw new Error('Invalid file watch request');
        }
        stopFileWatch(sender, id);
        let owner = fileWatchOwners.get(sender);
        if (!owner) {
            const files = new Map<string, WatchedFile>();
            const dispose = (): void => {
                for (const file of files.values()) file.subscription?.dispose();
                files.clear();
                fileWatchOwners.delete(sender);
                sender.removeListener('destroyed', dispose);
                sender.removeListener('did-start-navigation', onNavigation);
            };
            const onNavigation = (_event: unknown, _url: string, inPlace: boolean, isMainFrame: boolean): void => {
                if (isMainFrame && !inPlace) dispose();
            };
            owner = { files, dispose };
            fileWatchOwners.set(sender, owner);
            sender.once('destroyed', dispose);
            sender.on('did-start-navigation', onNavigation);
        }

        // 先登记再等待注册：关闭文件/窗口后才返回的句柄，也必须立即释放。
        const files = owner.files;
        const file: WatchedFile = {};
        files.set(id, file);
        try {
            file.subscription = await fileWatchService.watch(filePath, (change) => {
                if (files.get(id) === file && !sender.isDestroyed()) sender.send('fs:fileChanged', id, change);
            });
            if (files.get(id) !== file) file.subscription.dispose();
        } catch (error) {
            if (files.get(id) === file) stopFileWatch(sender, id);
            throw error;
        }
    });
    ipcMain.on('fs:unwatchFile', (event, id: string) => {
        if (!event.sender.isDestroyed() && event.senderFrame === event.sender.mainFrame) {
            stopFileWatch(event.sender, id);
        }
    });
    app.once('will-quit', () => {
        for (const owner of fileWatchOwners.values()) owner.dispose();
        fileWatchService.dispose();
    });
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

    ipcMain.handle('fs:getFileSize', async (_event, filePath) => {
        try {
            const { size } = await readFileMetadata(filePath);
            return { status: 'ok', data: size };
        } catch (error) {
            return { status: 'error', message: error instanceof Error ? error.message : String(error) };
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
            const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
            const { systemPath, size } = await readFileMetadata(filePath);
            if (limit > 0 && size > limit) {
                return {
                    status: 'ok',
                    data: { tooLarge: true, size, limit, content: '', binary: false }
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
                    size,
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
            // 沙箱虚拟路径（Z:\C\...）还原为宿主路径，卷卸载后仍可打开
            p = sandboxPathToHostPath(p);
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

/**
 * 给发往 renderer 的设置对象补上解析后的语言。
 * loadSettingObject 与 setting:changed 广播共用，保证两处字段形状一致。
 */
const withResolvedLocale = (data: any) => ({
    ...data,
    resolved_locale: getLocale()
});

/**
 * 广播 setting:changed 到所有 renderer 窗口（含 resolved_locale）。
 * Setting.setData 的 afterSetDataCallbacks 与主窗口 focus 的系统语言刷新共用
 * 这一广播路径，保证所有窗口对语言切换的感知方式一致。
 */
function broadcastSettingChangedToAllWindows(): void {
    const updatedData = withResolvedLocale(Setting.getInstance().getData());
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
            safeSendToWebContents(win.webContents, 'setting:changed', updatedData);
        }
    }
}

const registerSettingAPIHandlers = () => {
    // 启动时按持久化配置同步调试日志级别（GUI 无 CLI 的 /debug 入口，靠设置项驱动）
    setDebugMode(isDebugLogEnabled());

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
    ipcMain.handle('setting:listShells', () => scanSupportedShells());
    ipcMain.handle('setting:loadSettingObject', () => {
        return { status: 'ok', data: withResolvedLocale(Setting.getInstance().getData()) };
    });
    // 语言包快照（与激活语言解耦，按 tag 组织）：preload 启动时拉取，
    // 之后由 packsChanged 推送刷新
    ipcMain.handle('locale:getLocalePacks', () => {
        return { status: 'ok', data: getLocalePackStore().getSnapshot() };
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
        const oldSettings = Setting.getInstance().getData();
        let prepared: ReturnType<typeof prepareFileMgrWorkspaceSettings>;
        try {
            prepared = prepareFileMgrWorkspaceSettings(settingObject, oldSettings);
            Setting.getInstance().setData(prepared.data);
        } catch (error: any) {
            // 持久化失败：配置未提交，内存与磁盘都保持旧值，按「保存失败」上报
            return { status: 'error', message: error.message };
        }

        // 配置已落盘：以下步骤只是让新配置在各处立即生效。它们失败时配置本身是对的，
        // 因此逐项收集失败信息单独提示，不再把它们混报成「保存失败」。
        const currentSettings = Setting.getInstance().getData();
        const debugLogChanged = !!oldSettings?.debug?.debug_log !== !!currentSettings.debug?.debug_log;
        const telemetryChanged = JSON.stringify(oldSettings?.telemetry) !== JSON.stringify(currentSettings.telemetry);
        const logSideEffectFailure = (label: string, message: string) =>
            logger.warn(`[setting] ${label} failed after save: ${message}`);

        // 阻塞组：调用方依赖其完成后的状态，且都是进程内调用，耗时为毫秒级
        const blockingEffects: SettingSideEffect[] = [
            // 模型配置可能已变更，清理 adapter 缓存使旧连接池释放
            { label: 'llm-adapter-cache', run: () => LLM.clearAdapterCache() },
            // 通知 Worker 线程更新设置，使新的模型配置立即生效
            { label: 'worker-settings-sync', run: () => notifyWorkerCurrentSettingUpdate() },
            {
                label: 'filemgr-embedding-config',
                run: () => notifyFileMgrEmbeddingConfigChanged(oldSettings, currentSettings)
            }
        ];
        // 调试日志开关变更后立即生效（winston 级别随 setDebugMode 切换）
        if (debugLogChanged) {
            blockingEffects.push({
                label: 'debug-log-mode',
                run: () => setDebugMode(!!currentSettings.debug?.debug_log)
            });
        }
        blockingEffects.push({ label: 'theme-apply', run: () => getMainThemeService().applyFromSettings() });
        // AgentGate 的 bridge 启停已由 AgentGateApplication.onConfigChanged 内部处理，无需在此同步
        const pendingWorkspace = prepared.shouldNotifyWorkspaceChanged ? prepared.defaultWorkspace : undefined;
        if (pendingWorkspace) {
            blockingEffects.push({
                label: 'filemgr-workspace-marker',
                run: () => ApplicationRegistry.callWorker('filemgr', 'workspaceChanged', pendingWorkspace)
            });
        }
        const sideEffectFailures = await runSettingSideEffects(blockingEffects, logSideEffectFailure);

        // 后台组：会 spawn 系统命令（Windows 查注册表、macOS 走 scutil）或重建 OTel SDK，
        // 耗时不可控。设置面板是防抖自动保存，放进阻塞组会把保存响应拖慢，
        // 因此放到后台执行，失败只记日志（与这些步骤引入前的行为一致）。
        const deferredEffects: SettingSideEffect[] = [
            // 网络配置变更后立即刷新代理 env 缓存，使命令行子进程即时生效
            { label: 'proxy-env-refresh', run: () => onNetworkConfigChanged() }
        ];
        // 遥测配置变更时热重载 OTel SDK
        if (telemetryChanged) {
            deferredEffects.push({
                label: 'telemetry-reload',
                run: async () => {
                    const telemetry = await loadTelemetryModule();
                    await telemetry.reloadTelemetry();
                }
            });
        }
        void runSettingSideEffects(deferredEffects, logSideEffectFailure);

        // setting:changed 广播由 Setting.afterSetDataCallbacks 统一负责（含 resolved_locale），
        // 这里不再重复广播，避免每个 renderer 窗口每次保存收到两遍。
        return { status: 'ok', data: withResolvedLocale(currentSettings), sideEffectFailures };
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
    ipcMain.handle(
        'setting:fetchProviderModels',
        async (_event, { base_url, api_key, provider_type, no_proxy, no_ssl }) => {
            return TelemetryOperationRegistry.aroundOperation(new TelemetryOperation('llm.list_models'), async () => {
                try {
                    const names = await fetchProviderModelNames(
                        { base_url, api_key, provider_type, no_proxy: !!no_proxy, no_ssl: !!no_ssl },
                        fetchModelUrl
                    );
                    return { status: 'ok', data: names };
                } catch (error: unknown) {
                    const message =
                        error instanceof Error && /^MODEL_LIST_(HTTP_\d+|INVALID)$/.test(error.message)
                            ? error.message
                            : 'MODEL_LIST_FAILED';
                    return { status: 'error', message };
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
            // 继续执行；setData 写盘失败时内存配置不会提交，本次切换与磁盘保持一致地不生效
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
        ipcMain.handle('setting:isFullscreen', () => {
            if (globalMainWindow === null) {
                return { status: 'error', message: 'main window not found' };
            }
            return { status: 'ok', data: globalMainWindow.isFullScreen() };
        }),
        ipcMain.handle('setting:setFullscreen', (_event, fullscreen: boolean) => {
            if (globalMainWindow === null) {
                return { status: 'error', message: 'main window not found' };
            }
            globalMainWindow.setFullScreen(!!fullscreen);
            return { status: 'ok', data: globalMainWindow.isFullScreen() };
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
    // 用户反馈上报：在 main 侧读取日志/任务文件并经 Platform fetch 提交，
    // 以继承代理与 no_ssl 配置，同时规避 renderer file:// 跨源的 CORS 限制。
    ipcMain.handle('feedback:submit', async (_event: any, submission: any) => {
        try {
            const result = await submitFeedback(
                {
                    type: submission?.type,
                    content: String(submission?.content ?? ''),
                    includeSystemLog: submission?.includeSystemLog === true,
                    includeTaskJson: submission?.includeTaskJson === true,
                    taskId: typeof submission?.taskId === 'string' ? submission.taskId : null
                },
                {
                    fetchImpl: (input, init) => getPlatform().fetch(input as string | URL, init),
                    resolveLogPath: () => path.join(getLogDirectory(), getLogFilename()),
                    resolveTaskPath: (taskId) => path.join(getTaskDirectory(), `${taskId}.json`),
                    onWarn: (message) => logger.warn(message),
                    onInfo: (message) => logger.info(message)
                }
            );
            return result.ok
                ? { status: 'ok', data: { id: result.id ?? null } }
                : { status: 'error', message: result.message };
        } catch (error: any) {
            logger.error('submitting feedback failed', error);
            return { status: 'error', message: error.message };
        }
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
        ipcMain.handle('setting:isFullScreen', () => {
            if (globalMainWindow === null) {
                return { status: 'error', message: 'main window not found' };
            }
            return { status: 'ok', data: globalMainWindow.isFullScreen() };
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

/**
 * 需要跟随缩放偏好的窗口：主窗口 + 独立应用窗口。
 * 独立应用窗口里的 Ctrl+{+,-,0} 与主窗口共用同一份全局偏好，两边缩放比例始终一致。
 */
const displayZoomSync = new DisplayZoomSync<BrowserWindow>();

/** 将有效缩放系数应用到所有参与同步的窗口并通知各自渲染进程 */
const applyEffectiveZoomToWindow = () => {
    const effective = computeEffectiveZoom();
    for (const win of displayZoomSync.apply(effective)) {
        safeSendToWebContents(win.webContents, 'display:scaleFactorChanged', effective);
    }
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

/**
 * Linux 阴影窗口的内容边缘 resize：renderer 感应条（贴内容边缘）发起/结束拖动
 * 会话，鼠标由主进程轮询光标位置实时 setBounds，触摸屏/手写笔由 renderer 上报
 * 窗口内坐标驱动（详见 windows/shadow-resize.ts）。
 */
const registerShadowResizeHandlers = () => {
    if (process.platform !== 'linux') {
        return;
    }
    // 触摸排障用：end 时输出本次会话收到的坐标更新条数，0 条说明 renderer 的
    // pointer 事件根本没到达（被原生 resize 边框拦截或手势被浏览器接管）
    let resizeMoveCount = 0;
    let resizeSessionDriver: ShadowResizeDriver | null = null;
    ipcMain.on('window:shadowResizeStart', (event, direction: unknown, options: unknown) => {
        const normalized = normalizeShadowResizeDirection(direction);
        if (normalized === null) {
            return;
        }
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || win.isDestroyed()) {
            return;
        }
        const [minWidth, minHeight] = win.getMinimumSize();
        const o = options as { driver?: unknown; clientX?: unknown; clientY?: unknown } | null | undefined;
        const driver: ShadowResizeDriver = o?.driver === 'pointer' ? 'pointer' : 'cursor';
        // NaN/Infinity 会污染 bounds 换算，坐标必须是有限数值
        const startClient =
            typeof o?.clientX === 'number' &&
            Number.isFinite(o.clientX) &&
            typeof o.clientY === 'number' &&
            Number.isFinite(o.clientY)
                ? { x: o.clientX, y: o.clientY }
                : undefined;
        resizeMoveCount = 0;
        resizeSessionDriver = driver;
        if (driver === 'pointer') {
            // info 级：不启用 debug 模式也能确认触摸事件是否到达 renderer
            logger.info(
                `[shadow-resize] pointer start direction=${normalized} startClient=${JSON.stringify(startClient ?? null)}`
            );
        }
        startShadowResizeSession(win, normalized, minWidth, minHeight, driver, startClient);
    });
    ipcMain.on('window:shadowResizeMove', (_event, point: unknown) => {
        const p = point as { x?: unknown; y?: unknown } | null | undefined;
        const x = p?.x;
        const y = p?.y;
        if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
            return;
        }
        resizeMoveCount += 1;
        updateShadowResizeSession({ x, y });
    });
    ipcMain.on('window:shadowResizeEnd', () => {
        if (resizeSessionDriver === 'pointer') {
            logger.info(`[shadow-resize] pointer end moves=${resizeMoveCount}`);
        }
        resizeMoveCount = 0;
        resizeSessionDriver = null;
        endShadowResizeSession();
    });
    app.on('before-quit', () => {
        endShadowResizeSession();
    });
};

/**
 * 主窗口顶部拖拽层的手动拖动（Linux only）：renderer 通知开始/结束，鼠标由本进程
 * 轮询光标驱动整窗移动，触摸屏/手写笔由 renderer 上报窗口内坐标驱动。背景与
 * bounds 换算见 windows/window-drag.ts。
 */
const registerWindowDragHandlers = () => {
    if (process.platform !== 'linux') {
        return;
    }
    ipcMain.on('window:dragStart', (event, grab: unknown) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || win.isDestroyed()) {
            return;
        }
        const p = grab as { x?: unknown; y?: unknown; driver?: unknown } | null | undefined;
        const x = p?.x;
        const y = p?.y;
        const grabPoint =
            typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
                ? { x, y }
                : undefined;
        const driver: WindowDragDriver = p?.driver === 'pointer' ? 'pointer' : 'cursor';
        startWindowDragSession(win, grabPoint, driver);
    });
    ipcMain.on('window:dragMove', (_event, point: unknown) => {
        const p = point as { x?: unknown; y?: unknown } | null | undefined;
        const x = p?.x;
        const y = p?.y;
        if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
            return;
        }
        updateWindowDragSession({ x, y });
    });
    ipcMain.on('window:dragEnd', () => {
        endWindowDragSession();
    });
    app.on('before-quit', () => {
        endWindowDragSession();
    });
};

/**
 * 鸿蒙平台启动时校验华为账号登录。
 * 若未登录则拉起登录窗口阻塞启动，登录成功或用户关闭窗口后继续。
 * 非鸿蒙平台直接跳过。
 */
async function ensureHuaweiAuthOnStartup(): Promise<void> {
    if ((process.platform as string) !== 'openharmony') {
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
        // Windows：Alt+Space 是快速截图入口，是否响应由设置里的开关决定
        // （Kit 内部 gate，关闭时等价于原来的 no-op）。
        if (process.platform !== 'win32') {
            return;
        }
        void resolveNativeBridge()
            .getQuickCaptureKit()
            .then((kit) => kit.triggerFromHotkey?.())
            .catch((error: unknown) => {
                logger.error(`[quick-capture] hotkey dispatch failed: ${String(error)}`);
            });
    });
    if (!ret) {
        logger.warn(`hotkey ${hotkey} register failed, possibly because the hot key is already in use`);
    }
};

/**
 * 快速截图遮罩把截图交接给主窗口后，把主窗口带到前台。
 * 渲染层在主窗口 focus / visibilityChanged 时消费待处理截图（见 quickcaptureInbox）。
 */
const registerQuickCaptureHandlers = () => {
    // Electron 的 app 事件签名不接受自定义事件名，这里按 EventEmitter 使用。
    (app as unknown as NodeJS.EventEmitter).on(QUICK_CAPTURE_BRING_MAIN_TO_FRONT_EVENT, () => {
        if (!globalMainWindow || globalMainWindow.isDestroyed()) return;
        if (globalMainWindow.isMinimized()) {
            globalMainWindow.restore();
        }
        globalMainWindow.show();
        globalMainWindow.focus();
        // 主窗口本来就可见时 show() 不产生窗口事件、focus 也未必变化，三条激活信号里
        // 可能一条都不出现；显式补一条可见性信号，保证渲染层一定会去取待处理截图。
        safeSendToWebContents(globalMainWindow.webContents, 'window:visibilityChanged', true);
    });
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
        icon: getWindowIcon(),
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
    if ((process.platform as string) !== 'openharmony') {
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
    let icon = nativeImage.createFromPath(getAppIconPath());
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

    // debug 模式设置独立的 AppUserModelID：dev 下主/调试版共用同一 electron.exe，
    // 不设置时 Windows 11 任务栏会按 exe 路径合并分组；独立 AUMID 让调试版自成一组。
    if (isOpendeskDebugMode()) {
        app.setAppUserModelId('OpenDesk.Debug');
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

    // Linux(X11) 无边框窗口在未设置应用菜单时，右键非编辑区域会走 _NET_WM_MENU
    // 协议请求 WM 弹系统窗口菜单（Muffin/Cinnamon 的最小化/移动/关闭菜单）：
    // 弹于窗口左上角而非鼠标位置，弹出后 WM grab 输入导致菜单点不动、关不掉，
    // 期间标题栏按钮也失效。对所有 BrowserWindow 统一阻止该默认行为（编辑区域
    // 的剪切/复制/粘贴菜单由各级 handler 按需弹出，不受影响）。
    app.on('web-contents-created', (_event, contents) => {
        suppressWmSystemMenuOnLinux(contents);
        // 触摸屏长按 → 右键：对所有窗口与 webview guest 注入长按检测脚本
        installTouchLongPress(contents);
    });

    // GPU 进程负责所有窗口的合成输出，它退出后既有窗口的 surface 会与合成器失联，
    // 表现为画面冻结而主进程仍然存活。Chromium 重启 GPU 进程不会把窗口重新挂上去，
    // 因此需要主进程主动重载主窗口（详见 window-recovery.ts）。
    app.on('child-process-gone', (_event, details) => {
        windowRecovery.onChildProcessGone(details);
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
            await Promise.all([
                ensureTelemetryReady(),
                initializePluginHost(),
                ApplicationRegistry.ensureFullyLoaded(),
                ensureBrowserReady()
            ]);
        };
        // 打开单个应用时的窄屏障：只等目标应用自身的延迟资源 + 插件宿主。遥测、其它应用的
        // 延迟加载都在后台进行，不再拖住应用首屏；只有浏览器应用要等它自己的 browser session。
        const ensureElectronApplicationLoaded = async (bundleName: string): Promise<void> => {
            await registryWorkerReady;
            // 插件宿主必须先落地：应用 UI 会读插件贡献的外观 / 命令 / 技能 hook，应用的延迟
            // 加载本身也会消费这些 hook（如 skillmgr 的技能列表），并行会拿到空 hook 且不再重跑
            await initializePluginHost();
            const tasks = [ApplicationRegistry.ensureApplicationLoaded(bundleName)];
            // 浏览器应用直接依赖主进程侧的 browser session（下载、证书校验、preload）
            if (bundleName === 'browser') tasks.push(ensureBrowserReady());
            await Promise.all(tasks);
        };

        // 先注册 renderer 首屏会调用的无状态 IPC，再立即启动 renderer 加载。
        // taskManager handler 会在本回调首次让出事件循环前完成注册。
        registerSettingAPIHandlers();
        registerInteractiveTerminalHandlers();
        registerElectronAccountIntegration();
        registerApplicationRegistryHandlers(ipcMain, ensureElectronFullyLoaded, ensureElectronApplicationLoaded);
        registerNotificationAPIHandlers();
        registerRendererLogHandler();
        registerRendererHeartbeatHandler();
        registerThemeHandlers();
        registerEmbeddedOpenDeskOffice();
        AgentRegistry.initBuiltinAgents();
        registerModeAPIHandlers();
        registerNativeBridge();

        createWindow();

        // 主窗口就绪后启动 renderer 冻结看门狗；GPU 崩溃恢复由上面的 child-process-gone 驱动
        windowRecovery.start();

        // 启动阶段不采集遥测；主窗口显示后再初始化运行期遥测。
        void mainWindowShown.then(() => void ensureTelemetryReady());

        // 浏览器持久化 session 不参与主窗口首屏，窗口显示后再在后台初始化。
        void mainWindowShown.then(() => void ensureBrowserReady());

        // BrowserWindow 已开始加载；同步恢复任务状态时 renderer 进程可以并行解析页面。
        GlobalState.initialize();
        registerTaskManagerAPIHandlers();
        registerElectronUpdateService({
            getMainWindow: () => globalMainWindow,
            prepareWindowsForQuit: requestCloseOpenDeskOfficeContents,
            quitForRestart: () => {
                officeQuitApproved = true;
                isAppQuitting = true;
                app.quit();
            },
            logInfo: (message) => logger.info(message),
            logError: (message) => logger.error(message)
        });
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
        startMemoryCleanupScheduler(() =>
            FactorialMemoryStore.getInstance(Setting.getInstance().getEffectiveWorkspace()).cleanupStaleMemories()
        );
        startProxyEnvRefreshScheduler();
        // 启动时上报设备心跳，之后每 5 小时上报一次（fire-and-forget，不阻塞主流程）
        startReporter('desktop');

        await initializePluginHost();
        GlobalState.getInstance().taskManagerState.toolsetProvider = combineToolsetProviders(
            {
                listAvailableToolsets: (taskState) => ApplicationRegistry.listAvailableToolsets(taskState)
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
        // Native Bridge IPC 已在 createWindow 前注册，此处只执行需要 ArkTS active context 的能力探测。
        await probeArkdataAvailability();

        // 启动 global worker（同步 spawn，不阻塞）。
        // Worker 初始化与应用 Agent 加载将在 createWindow 之后并行执行，避免阻塞窗口显示。
        initializeRegistryWorker({ preferredSystemLanguages: getPreferredSystemLanguagesForLocale() });
        resolveRegistryWorkerReady();

        // 插件 bootstrap 早于全局 worker 启动，技能内部 MCP server 的首次同步在此补齐
        void syncPluginSkillServers();

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
                const agApp = ApplicationRegistry.getApplication('agentgate') as
                    InstanceType<typeof AgentGateApplication> | undefined;
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
                    // 恶意技能检测开关未开启时，拒绝新增黑名单（已有条目仍由 filter 生效）
                    const agCfgAdd = Setting.getInstance().getApplicationConfig('agentgate') as any;
                    if (agCfgAdd?.maliciousSkillDetection !== true) return;
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
        void mainWindowShown.then(() => void ApplicationRegistry.ensureFullyLoaded());

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
        registerDesktopAPIHandlers();
        registerTrashAPIHandlers();
        // registerTaskManagerAPIHandlers() 已在同步恢复 GlobalState 后注册；首次让出主进程
        // 事件循环前 handler 已就绪，可响应 renderer sidebar 的 taskManager:getTaskList。
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

        // 剪贴板：渲染器默认沙箱化，preload 无法使用 electron clipboard 模块，
        // 由主进程代执行（自绘编辑菜单的复制/粘贴、工作空间路径复制等）
        ipcMain.handle('clipboard:writeText', (_event, text: unknown) => {
            if (typeof text !== 'string') return;
            clipboard.writeText(text);
        });
        ipcMain.handle('clipboard:readText', () => {
            try {
                return clipboard.readText();
            } catch {
                return '';
            }
        });

        // 在新窗口中打开应用
        ipcMain.handle('application:openInNewWindow', async (_event, bundleName: string) => {
            try {
                // 浏览器应用依赖 webview（iframe 内不可用），只能内联挂载在主窗口；
                // 这里直接拒绝，避免开出一个只会白屏/报错的独立窗口
                if (bundleName === 'browser') {
                    return { status: 'error', message: 'browser application does not support separate window' };
                }
                const appConfig = ApplicationRegistry.getApplicationGUIConfig(bundleName) as
                    Record<string, unknown> | undefined;
                const appName = (appConfig?.name as string) || bundleName;

                const appWindow = new BrowserWindow({
                    width: 1100,
                    height: 680,
                    minWidth: 480,
                    minHeight: 320,
                    frame: false,
                    icon: getWindowIcon(),
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
                        preload: getRendererPreloadPath(),
                        // zoom 按 webContents 独立存储，新窗口不会自动继承主窗口的缩放，
                        // 必须显式给出初始值（后续变更由 displayZoomSync 广播）
                        zoomFactor: computeEffectiveZoom()
                    }
                });

                // 独立应用窗口也跟随缩放偏好：窗口内的 Ctrl+{+,-,0} 与主窗口一致
                displayZoomSync.add(appWindow);
                appWindow.once('closed', () => displayZoomSync.remove(appWindow));

                installWebviewHostHandlers(appWindow);
                appWindow.setMenu(null);
                appWindow.once('ready-to-show', () => {
                    appWindow.show();
                    // 应用的延迟加载（如 AgentOffice 自定义 agent 磁盘扫描 + MCP 同步）
                    // 不阻塞窗口显示，窗口展示后在后台补齐 AgentRegistry 注册；
                    // 子应用 UI 依赖的 worker 数据本身不依赖该注册。
                    void ApplicationRegistry.ensureApplicationLoaded(bundleName);
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
        registerShadowResizeHandlers();
        registerWindowDragHandlers();
        registerAuthAPIHandlers();
        registerDisplayZoomHandlers();
        // registerThemeHandlers() 已在 createWindow 之前提前注册，
        // getMainThemeService().init() 在 IPC handler 内部懒调用，避免 createWindow
        // 之前触发 callArkTS 导致 ArkTS 侧 NAPI 类型断言 crash。
        // 此处 createWindow() 已完成、ArkTS 侧已 active，显式 init() 安全，
        // 确保窗口背景色等主题效果在显示前就绪。
        getMainThemeService().init();
        registerHotKeys();
        registerQuickCaptureHandlers();
        registerTray();

        migrateFileMgrWorkspaceSettingsOnStartup();

        initializeProtocolHandlers();

        ApplicationRegistry.onReady(async () => {
            const channelMgrApp = ApplicationRegistry.getApplication('channelmgr') as ChannelMgrApplication | undefined;
            if (channelMgrApp) {
                const router = new ChannelMessageRouter(GlobalState.getInstance().taskManagerState, startupWorkspace);

                const CHANNEL_NAMES: Record<string, string> = {
                    feishu: '飞书',
                    weixin: '微信',
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
            const agApp = ApplicationRegistry.getApplication('agentgate') as
                InstanceType<typeof AgentGateApplication> | undefined;
            if (agApp) {
                agApp.startRuntime((events, counts) => {
                    if (globalMainWindow && !globalMainWindow.isDestroyed()) {
                        safeSendToWebContents(globalMainWindow.webContents, 'agentgate:eventsUpdate', {
                            events,
                            counts
                        });
                    }
                });

                // 存储超限低频监控：跨阈值边沿推送 agentgate:storageOversize → 主窗口弹确认框。
                // 独立于浮窗 eventsUpdate 链，浮窗关闭时仍能提醒。
                agApp.startStorageMonitor((payload) => {
                    if (globalMainWindow && !globalMainWindow.isDestroyed()) {
                        safeSendToWebContents(globalMainWindow.webContents, 'agentgate:storageOversize', payload);
                    }
                });
            }

            // IPC handler：主窗口确认存储清理 → app.cleanupStorage（删除 tool_calls + 清空拦截记录）
            ipcMain.handle('agentgate:cleanupStorage', async () => {
                const agApp2 = ApplicationRegistry.getApplication('agentgate') as
                    InstanceType<typeof AgentGateApplication> | undefined;
                if (!agApp2) return { status: 'error', message: 'agentgate application not found' };
                try {
                    const data = await (agApp2 as any).cleanupStorage();
                    return { status: 'ok', data };
                } catch (error) {
                    return { status: 'error', message: String(error) };
                }
            });
        } catch (err) {
            logger.warn(`AgentGate bridge start failed: ${err}`);
        }

        // 注册全局设置变更广播：每次 Setting.setData 完成后，
        // 广播 setting:changed 到所有 renderer 窗口。
        // 这确保通过 callMainWorld 修改配置（如浮窗开关）时，主窗口能实时响应。
        // 这是 setting:changed 的唯一广播点，调用方（如设置保存）不要再自己广播一遍。
        Setting.afterSetDataCallbacks.push(() => {
            broadcastSettingChangedToAllWindows();
        });

        // 语言包变更广播：插件宿主激活/停用语言包（LocaleStore 变更）后，
        // 推送最新快照到所有窗口，各翻译器重建后立即生效
        getLocalePackStore().subscribe((snapshot) => {
            for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) {
                    safeSendToWebContents(win.webContents, 'locale:packsChanged', snapshot);
                }
            }
        });

        // 启动完成后异步清理过期日志，不阻塞主流程
        dropDeprecatedLogs().catch(() => {});

        // 统一回收站：确保 trash/ 根目录存在，并清理最后一次用户交互超过 7 天
        // 的任务的回收站（不阻塞主流程，失败仅记日志）
        try {
            initializeTrash(() => {
                const state = GlobalState.getInstance().taskManagerState;
                return new Map(state.getTaskList().map((task) => [task.task_id, task.updated_at] as const));
            });
        } catch (error) {
            logger.warn(`初始化统一回收站失败（忽略）: ${error}`);
        }
        // 运行期周期清扫"打开"生成的预览副本（保留期 24 小时）
        startTrashPreviewCleanupScheduler();
    });

    app.on('will-quit', async () => {
        windowRecovery.stop();
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
