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
import { TaskSearchService, searchVisibleTasks } from './services/task-search/service.js';
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
import { saveSettingObject, importQuickPassConfiguration } from './applications/settings/service.js';
import { QuickPassHelper } from './utils/quickpass.js';
import { getWindowsDrives } from './utils/drives.js';
import { listFileEntries, listWorkspaceEntries, readTextFile, resolveWorkspaceFilePath } from './utils/file-browser.js';
import { sandboxPathToHostPath } from '../common/utils/path.js';
import { toErrorMessage } from '../common/utils/error.js';
import { PROVIDER_TEMPLATES } from './tui/components/config/providers.js';
import { GlobalState } from './aikernel/states/global.js';
import { BaseToolset } from './aikernel/tool';
import { is } from '@electron-toolkit/utils';
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
import { createMainWindowCloseHandler, bringMainWindowToForeground } from './utils/window-close.js';
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
    ApplicationRegistry,
    notifyWorkerSettingUpdate
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
import { releaseTaskMemory } from './aikernel/task/memory.js';
import { readExternalizedImageFile } from './aikernel/task/image-externalization.js';
import { saveTaskExportHtml } from './utils/export-html-writer.js';
import { exportLogEntries } from './utils/export-log.js';
import { createLocalExportDestinationHost } from './utils/export-local-destination.js';
import { getMainThemeService, registerThemeHandlers } from '../renderer/theme/main-theme-service.js';
import { AgentRegistry } from './aikernel/agents/registry.js';
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
import { prepareFileMgrStartupWorkspaceSettings } from './applications/filemgr/workspace.js';
import { getTaskTodosForDisplay } from './aikernel/todos/task-todos.js';
import { readTaskSessionMemoryForDisplay } from './aikernel/compaction/session-memory-compact.js';
import { readUserPortrait, writeUserPortrait } from './aikernel/memory/user_portrait.js';
import { registerMemoryReviewHook, unregisterMemoryReviewHook } from './aikernel/memory/review.js';
import { FactorialMemoryStore } from './aikernel/memory/store.js';
import { startMemoryCleanupScheduler } from './aikernel/memory/cleanup.js';
import { getFeatureManager } from '../common/features/manager.js';
import { OPENDESK_FEATURES, resolveFeatureLocalizedText } from '../common/features/registry.js';
import { startProxyEnvRefreshScheduler, onNetworkConfigChanged } from './utils/proxy-env.js';
import { startHeartbeatReporter, syncHeartbeatReporter } from './telemetry/heartbeat.js';
import { submitFeedback } from './utils/feedback.js';
import type { RankPeriod } from './telemetry/local-telemetry.js';
import { createTaskUsageViewService } from './telemetry/task-usage-view.js';
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
    resolveModelReasoningEfforts
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
import { applyTaskExecutionNode, normalizeExecutionNodeId } from './applications/devicemgr/task-execution.js';
import { registerElectronAccountIntegration } from './applications/account/electron.js';
import { type TaskState, isTaskVisibleForDeveloperMode } from './aikernel/states/tasks.js';
import { getLocale, getRuntimePreferredSystemLanguages, t } from '../locale/index.js';
import { getLocalePackStore } from '../locale/packs.js';
import { getAttachmentFileSupport, UnsupportedAttachmentFileTypeError } from './aikernel/attachment-support.js';
import {
    getSupportedModeSnapshot,
    replaceTaskHarnessForWorkspace,
    selectGlobalMode,
    switchTaskMode,
    updateTaskWorkspace
} from './aikernel/task/mode.js';
import { resolveTaskModelContextSize, setTaskModel } from './aikernel/task/model.js';
import { createGuiTask, submitGuiTaskMessage } from './applications/task-gui/operations.js';
import { createGuiGoalOperations } from './applications/task-gui/goals.js';
import { applyWorkspaceSelection } from './applications/settings/workspace.js';
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

let telemetryReadyPromise: Promise<void> | undefined;

/**
 * 运行期遥测初始化（幂等）：主窗口显示后才初始化，启动阶段不采集遥测。
 * 关闭遥测时会把 promise 复位，之后再次请求（如窗口重开）仍能重新初始化。
 */
function ensureTelemetryReady(): Promise<void> {
    if (!telemetryReadyPromise) {
        telemetryReadyPromise = loadTelemetryModule().then((telemetry) => telemetry.initTelemetry());
    }
    return telemetryReadyPromise;
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

/**
 * features:getState / features:changed 推给渲染进程的状态载荷。
 * 特性清单的展示文案在这里按当前界面语言解析成纯文本，渲染进程无需再关心
 * FeatureLocalizedText 的多语言结构。
 */
function getFeatureStatePayload() {
    const locale = getLocale();
    return {
        ...getFeatureManager().getSnapshot(),
        features: OPENDESK_FEATURES.map((feature) => ({
            id: feature.id,
            displayName: resolveFeatureLocalizedText(feature.displayName, locale) ?? feature.id,
            description: resolveFeatureLocalizedText(feature.description, locale) ?? ''
        }))
    };
}

/**
 * 记忆特性门控联动（ctx.features.disableFeature('memory')）：
 * 禁用时注销任务回顾钩子并停掉记忆清理调度器，恢复时重新注册。
 */
let stopMemoryCleanupSchedulerFn: (() => void) | null = null;
/** 特性门控联动订阅（记忆 + 遥测）；重复进入 startApplication 时不重复注册 */
let featureStateSubscription: (() => void) | undefined;
function syncMemoryFeatureState(): void {
    if (getFeatureManager().isFeatureDisabled('memory')) {
        unregisterMemoryReviewHook();
        stopMemoryCleanupSchedulerFn?.();
        stopMemoryCleanupSchedulerFn = null;
        return;
    }
    // registerMemoryReviewHook 内部有已注册守卫，重复调用安全
    registerMemoryReviewHook({
        taskManagerState: GlobalState.getInstance().taskManagerState,
        initializeReviewTask: initializeMemoryReviewTask
    });
    stopMemoryCleanupSchedulerFn ??= startMemoryCleanupScheduler(() =>
        FactorialMemoryStore.getInstance(Setting.getInstance().getEffectiveWorkspace()).cleanupStaleMemories()
    );
}

/**
 * 用户级记忆开关（gui_config.memory_enabled）到特性门控的映射。
 *
 * 与插件 `ctx.features.disableFeature('memory')` 是叠加关系：任意一方要求禁用即生效，
 * 所以用固定的 owner id 单独持有一份禁用，插件释放自己那份不会误恢复用户关掉的记忆。
 */
const USER_MEMORY_DISABLE_OWNER = 'user-setting';

function syncMemoryFeatureFromUserSetting(): void {
    const enabled = Setting.getInstance().getData().gui_config?.memory_enabled !== false;
    // setFeatureDisabled 内部幂等：状态没变化不会触发 notify，重复调用安全
    getFeatureManager().setFeatureDisabled('memory', USER_MEMORY_DISABLE_OWNER, !enabled);
}

/**
 * 远程遥测特性联动（ctx.features.disableFeature('telemetry')）：
 * 设备心跳与遥测协议分属两条通道，但都由 telemetry 模块按同一特性状态启停。
 * 心跳的启停逻辑收口在 telemetry/heartbeat.ts，这里只需要按特性变化触发同步；
 * 遥测模块按需延迟加载，运行期初始化前不主动加载重量级依赖。
 */
function syncTelemetryFeatureState(): void {
    // 心跳是轻量的，不依赖遥测协议模块是否已加载：窗口显示前被禁用也要立刻停掉
    syncHeartbeatReporter();
    if (!telemetryReadyPromise) return;
    void telemetryReadyPromise
        .then(() => loadTelemetryModule())
        .then((telemetry) => telemetry.syncTelemetryFeatureGate())
        .catch((error: unknown) => {
            // 加载/初始化失败后复位，让下次特性变化重新尝试，而不是一直复用被拒的 promise
            telemetryReadyPromise = undefined;
            logger.warn(`sync telemetry feature gate failed: ${String(error)}`);
        });
}

/**
 * 特性门控联动订阅：记忆与遥测各自按特性状态启停自身资源。
 * 重复进入 startApplication 时不重复注册。
 */
function subscribeFeatureStateChanges(): () => void {
    const manager = getFeatureManager();
    const unsubscribers = [
        manager.onFeaturesChanged(syncMemoryFeatureState),
        manager.onFeaturesChanged(syncTelemetryFeatureState)
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
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
            if (!officeEditorKind || !configureOpenDeskOfficeWebPreferences(officeEditorKind, webPreferences)) {
                logger.warn(`Blocked untrusted OpenDesk Office webview URL: ${src || '<empty>'}`);
                event.preventDefault();
                return;
            }
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
            return {
                status: 'ok',
                data: getSupportedModeSnapshot(agentDecl, _currentElectronModeId)
            };
        } catch (err) {
            return { status: 'error', message: String(err) };
        }
    });

    ipcMain.handle('mode:setCurrentMode', async (event, modeId) => {
        try {
            const agentDecl = AgentRegistry.getMainAgent();
            const selection = selectGlobalMode(agentDecl, _currentElectronModeId, modeId);
            if (selection.status !== 'ok') return selection;

            // 仅更新系统默认模式（影响新任务启动时的初始模式），不再同步所有现有任务。
            // 先保存成功状态，再广播；非法值和重复选择都不产生 changed 事件。
            _currentElectronModeId = selection.modeId;
            if (selection.changed) broadcastToAllWindows('mode:changed', selection.modeId);

            return { status: 'ok', data: selection.modeId };
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
    type MemoryInvokeHandler = Parameters<typeof ipcMain.handle>[1];
    // 记忆特性被插件禁用（ctx.features.disableFeature('memory')）时记忆相关 IPC 一律不可用：
    // 侧栏入口已经隐藏，这里堵住渲染进程的旁路调用，避免继续读写记忆数据。
    const handleMemoryIPC = (channel: string, handler: MemoryInvokeHandler) => {
        ipcMain.handle(channel, async (event, ...args) => {
            if (getFeatureManager().isFeatureDisabled('memory')) {
                return { status: 'error', message: t('feature.memory.disabled') };
            }
            return handler(event, ...args);
        });
    };

    handleMemoryIPC('memory:getUserPortrait', async () => {
        try {
            return { status: 'ok', data: { raw: await readUserPortrait() } };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    handleMemoryIPC('memory:listMemories', async () => {
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

    handleMemoryIPC('memory:updateUserPortrait', async (_event, content: string) => {
        try {
            await writeUserPortrait(content);
            return { status: 'ok', data: { raw: await readUserPortrait() } };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    handleMemoryIPC('memory:updateMemory', async (_event, uid: string, title: string, content: string) => {
        try {
            const registry = FactorialMemoryStore.getInstance(Setting.getInstance().getEffectiveWorkspace());
            return { status: 'ok', data: await registry.updateMemory(uid, title, content) };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    handleMemoryIPC('memory:removeMemory', async (_event, uid: string) => {
        try {
            const registry = FactorialMemoryStore.getInstance(Setting.getInstance().getEffectiveWorkspace());
            return { status: 'ok', data: await registry.removeMemory(uid) };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    handleMemoryIPC('memory:cleanup', async () => {
        try {
            const registry = FactorialMemoryStore.getInstance(Setting.getInstance().getEffectiveWorkspace());
            return { status: 'ok', data: await registry.cleanupStaleMemories() };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });
};

/** 插件特性禁用状态查询/推送：sidebar 记忆与文件系统图标、agentinput 搜索按钮据此显隐 */
let featuresBroadcastSubscriptions: Array<() => void> | undefined;
const registerFeaturesAPIHandlers = () => {
    // 必须先注册 handler 再允许渲染进程拉取；重复进入时保持幂等（不重复 handle/订阅）
    if (featuresBroadcastSubscriptions) return;
    ipcMain.handle('features:getState', async () => {
        return { status: 'ok', data: getFeatureStatePayload() };
    });
    const broadcast = () => broadcastToAllWindows('features:changed', getFeatureStatePayload());
    // 特性级与应用级禁用都在同一份快照里，两类变化都要推送，否则渲染端的
    // disabledApplications 会停留在启动时的快照（应用入口/iframe/搜索按钮不跟着更新）
    featuresBroadcastSubscriptions = [
        getFeatureManager().onFeaturesChanged(broadcast),
        getFeatureManager().onApplicationsChanged(broadcast)
    ];
};

const registerUsageAPIHandlers = () => {
    const usageViews = createTaskUsageViewService({
        listTasks: () => GlobalState.getInstance().taskManagerState.tasks,
        getTask: (taskId) => GlobalState.getInstance().taskManagerState.getTask(taskId),
        isDeveloperMode: isDeveloperModeEnabled,
        isTaskVisible: isTaskVisibleForDeveloperMode
    });

    ipcMain.handle('usage:getDashboardSummary', async (_event, params?: { rankPeriod?: RankPeriod }) => {
        try {
            return { status: 'ok', data: await usageViews.getDashboardSummary(params) };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });

    ipcMain.handle('usage:getRankings', async (_event, params?: { rankPeriod?: RankPeriod }) => {
        try {
            return { status: 'ok', data: await usageViews.getRankings(params) };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
        }
    });
};

const registerTaskManagerAPIHandlers = () => {
    const globalState = GlobalState.getInstance();
    const guiGoalOperations = createGuiGoalOperations(globalState.taskManagerState);
    registerTaskTransferHandlers(globalState.taskManagerState, () => globalMainWindow, taskTransfer);
    const taskSearch = new TaskSearchService(
        getTaskDirectory(),
        path.join(getOpendeskDirectory(), 'task-search-v3.sqlite'),
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
        try {
            const data = await searchVisibleTasks(
                taskSearch,
                () => globalState.taskManagerState.tasks,
                query,
                limit,
                _event.sender.id
            );
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

    ipcMain.handle('taskManager:createTask', async (_event, rawOptions) => {
        return createGuiTask(globalState.taskManagerState, rawOptions, {
            get currentModeId() {
                return _currentElectronModeId;
            },
            defaultExecutionNodeId: globalState.getDefaultExecutionNodeId(),
            permissionPromptFactory: () => new ElectronPermissionPromptProvider(),
            createInteractionToolset: (task) => getPlatform().createInteractionToolset(task)
        });
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
        return releaseTaskMemory(taskId, globalState.taskManagerState.tasks, (id) => {
            sessionMemoryRenderCache.delete(id);
        });
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
            await updateTaskWorkspace(task, newWorkspace, {
                currentModeId: _currentElectronModeId,
                permissionPromptFactory: () => new ElectronPermissionPromptProvider()
            });
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
        return guiGoalOperations.getGoalStatus(taskId);
    });
    ipcMain.handle('taskManager:createGoal', async (_event, taskId, objective) => {
        return guiGoalOperations.createGoal(taskId, objective);
    });
    ipcMain.handle('taskManager:editGoal', async (_event, taskId, objective, options) => {
        return guiGoalOperations.editGoal(taskId, objective, options);
    });
    ipcMain.handle('taskManager:addGoalSupplement', async (_event, taskId, content) => {
        return guiGoalOperations.addGoalSupplement(taskId, content);
    });
    ipcMain.handle('taskManager:pauseGoal', async (_event, taskId) => {
        return guiGoalOperations.pauseGoal(taskId);
    });
    ipcMain.handle('taskManager:resumeGoal', async (_event, taskId) => {
        return guiGoalOperations.resumeGoal(taskId);
    });
    ipcMain.handle('taskManager:clearGoal', async (_event, taskId) => {
        return guiGoalOperations.clearGoal(taskId);
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
    ipcMain.handle('taskManager:submitMessage', async (_event, taskId, details) => {
        return submitGuiTaskMessage(globalState.taskManagerState, taskId, details);
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
        return setTaskModel(task, modelAlias, reasoningEffort);
    });
    ipcMain.handle('taskManager:stopTask', async (_event, taskId) => {
        return guiGoalOperations.stopTask(taskId);
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
            return { status: 'ok', data: await readTaskSessionMemoryForDisplay(taskId, sessionMemoryRenderCache) };
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
        return { status: 'ok', data: await resolveTaskModelContextSize(modelAlias) };
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
    // 读取外置的工具结果原图（issue #341）：恢复任务时内存里只有缩略图，
    // 点击查看大图等显式消费场景才通过本通道从磁盘按需加载
    ipcMain.handle('taskManager:readExternalizedImage', async (_event, taskId, relativePath) => {
        if (typeof taskId !== 'string' || taskId.length === 0 || typeof relativePath !== 'string') {
            return { status: 'error', message: 'invalid externalized image request' };
        }
        try {
            return { status: 'ok', data: await readExternalizedImageFile(taskId, relativePath) };
        } catch (error: any) {
            return { status: 'error', message: error?.message || String(error) };
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
    type WatchedFile = { subscription?: Pick<FileWatchSubscription, 'dispose'> };
    // 每个窗口保存自己的订阅，最后一个订阅关闭时一并移除窗口清理回调。
    const fileWatchOwners = new Map<WebContents, { files: Map<string, WatchedFile>; dispose: () => void }>();

    const stopFileWatch = (sender: WebContents, id: string): void => {
        const owner = fileWatchOwners.get(sender);
        if (!owner) return;
        owner.files.get(id)?.subscription?.dispose();
        owner.files.delete(id);
        if (owner.files.size === 0) owner.dispose();
    };

    ipcMain.handle('fs:watchFile', async (event, id: string, filePath: string, directory = false) => {
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
            const notify = (change?: unknown): void => {
                if (files.get(id) === file) safeSendToWebContents(sender, 'fs:fileChanged', id, change);
            };
            if (directory === true) {
                const watcher = fs.watch(path.resolve(filePath), () => notify());
                file.subscription = { dispose: () => watcher.close() };
                watcher.on('error', () => {
                    notify();
                    if (files.get(id) === file) stopFileWatch(sender, id);
                });
            } else {
                file.subscription = await fileWatchService.watch(filePath, notify);
            }
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
    ipcMain.handle('fs:listDirectory', async (_event, dirPath: string) => {
        try {
            return { status: 'ok', data: await listFileEntries(dirPath) };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });

    // 读取文本文件内容，用于工作空间预览/编辑面板。
    // maxBytes <= 0 或未提供时不限制体积，直接读取全文。
    ipcMain.handle('fs:readTextFile', async (_event, filePath: string, maxBytes?: number) => {
        try {
            return { status: 'ok', data: await readTextFile(filePath, maxBytes) };
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
            return {
                status: 'ok',
                data: resolveWorkspaceFilePath(
                    filePath,
                    Setting.getInstance().getEffectiveWorkspace(),
                    sandboxPathToHostPath
                )
            };
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
 * 向所有窗口推送语言包瘦身快照（仅生效语言 + 回退语言的增量）。
 * 全量快照按语言数线性膨胀（多包时 >1MB），而每个窗口与子 frame 的 preload
 * 都会持有一份克隆副本；瘦身把恒定内存与推送开销降到单语言体量。
 */
function pushLocalePackSnapshotToAllWindows(): void {
    const snapshot = getLocalePackStore().getSlimSnapshot(getLocale());
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
            safeSendToWebContents(win.webContents, 'locale:packsChanged', snapshot);
        }
    }
}

// packsChanged 推送去抖：批量插件激活（启动时各语言包插件逐个注册）会产生连续
// 多次 store 变更，合并为一次推送，避免多 MB 快照的克隆在启动期连续阻塞主线程
let localePackPushTimer: NodeJS.Timeout | null = null;

function scheduleLocalePackSnapshotPush(): void {
    if (localePackPushTimer) return;
    localePackPushTimer = setTimeout(() => {
        localePackPushTimer = null;
        pushLocalePackSnapshotToAllWindows();
    }, 50);
}

// 上次随 setting:changed 下发的生效语言；null 表示尚未广播过（首播必带快照基线）
let lastBroadcastResolvedLocale: string | null = null;

/**
 * 广播 setting:changed 到所有 renderer 窗口（含 resolved_locale）。
 * Setting.setData 的 afterSetDataCallbacks 与主窗口 focus 的系统语言刷新共用
 * 这一广播路径，保证所有窗口对语言切换的感知方式一致。
 *
 * 生效语言变化时先推新的语言包瘦身快照再广播设置：renderer 翻译器收到
 * setting:changed 后立刻按新语言查增量，快照先行保证新语言词条已就位。
 */
function broadcastSettingChangedToAllWindows(): void {
    const updatedData = withResolvedLocale(Setting.getInstance().getData());
    if (lastBroadcastResolvedLocale !== updatedData.resolved_locale) {
        lastBroadcastResolvedLocale = updatedData.resolved_locale;
        pushLocalePackSnapshotToAllWindows();
    }
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
            return { status: 'ok', data: Setting.getSettingJSONSchema() };
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
    // 之后由 packsChanged 推送刷新。下发瘦身快照（仅生效语言 + 回退语言增量），
    // 每个窗口与子 frame 各持一份副本，全量快照会让内存与克隆耗时按语言数膨胀
    ipcMain.handle('locale:getLocalePacks', () => {
        return { status: 'ok', data: getLocalePackStore().getSlimSnapshot(getLocale()) };
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

    ipcMain.handle('setting:saveSettingObject', async (_event, settingObject) => {
        const result = await saveSettingObject(settingObject, {
            getPreferredSystemLanguages: getPreferredSystemLanguagesForLocale,
            applyTheme: () => getMainThemeService().applyFromSettings()
        });
        // setting:changed 广播由 Setting.afterSetDataCallbacks 统一负责（含 resolved_locale），
        // 这里不再重复广播，避免每个 renderer 窗口每次保存收到两遍。
        return result.status === 'ok' ? { ...result, data: withResolvedLocale(result.data) } : result;
    });
    ipcMain.handle('quickpass:import', async (_event, quickpass) => {
        return importQuickPassConfiguration(quickpass, {
            getPreferredSystemLanguages: getPreferredSystemLanguagesForLocale
        });
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
            await applyWorkspaceSelection(selectedPath, {
                getPreferredSystemLanguages: getPreferredSystemLanguagesForLocale
            });
            return { status: 'ok', data: selectedPath };
        } catch (error: any) {
            return { status: 'error', message: error.message };
        }
    });
    ipcMain.handle('workspace:pickDirectoryDialog', async (_event, currentPath?: string) => {
        try {
            const initialPath =
                typeof currentPath === 'string' && path.isAbsolute(currentPath)
                    ? path.normalize(currentPath)
                    : undefined;
            const stat = initialPath ? await fsPromises.stat(initialPath).catch(() => undefined) : undefined;
            const result = await dialog.showOpenDialog(globalMainWindow!, {
                title: t('main.dialog.selectWorkspaceDirectory'),
                defaultPath: stat?.isDirectory() ? initialPath : undefined,
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
            await applyWorkspaceSelection(selectedPath, {
                getPreferredSystemLanguages: getPreferredSystemLanguagesForLocale
            });
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

                return { status: 'ok', data: await listWorkspaceEntries(dirPath, opts) };
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
            const host = createLocalExportDestinationHost(async (request) => {
                const dialogOptions: Electron.SaveDialogOptions = {
                    title: request.title,
                    defaultPath: path.join(app.getPath('desktop'), request.suggestedName),
                    filters: [{ name: t('main.log.export.textFiles'), extensions: [...request.extensions] }]
                };
                const selected =
                    globalMainWindow === null
                        ? await dialog.showSaveDialog(dialogOptions)
                        : await dialog.showSaveDialog(globalMainWindow, dialogOptions);
                return selected.canceled || !selected.filePath ? null : selected.filePath;
            });
            const result = await exportLogEntries(options, host);
            return {
                status: 'ok',
                data: result.canceled ? { canceled: true } : { canceled: false, filePath: result.receipt.localPath }
            };
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
        bringMainWindowToForeground(globalMainWindow);
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
                if (globalMainWindow) {
                    bringMainWindowToForeground(globalMainWindow);
                }
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
        if (globalMainWindow) {
            bringMainWindowToForeground(globalMainWindow);
        }
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
                // 用户再次启动应用（双击图标、命令行再跑一次等）时要把窗口真正带到前台：
                // 只调 show() 在 Windows 上不会还原最小化窗口，也不会抢到焦点
                bringMainWindowToForeground(globalMainWindow);
            }
        });
    } else {
        app.quit();
        process.exit(1);
    }

    // 在 app.whenReady() 之前初始化 Registry 和协议 schemes
    initializeRegistry();
    initializeRegistryProtocols();

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
            bringMainWindowToForeground(globalMainWindow);
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
        // 特性禁用状态是渲染进程首帧就要读的（sidebar/搜索按钮显隐），必须早于 createWindow
        registerFeaturesAPIHandlers();

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
        // 记忆清理调度器的生命周期统一由 syncMemoryFeatureState 管理（跟随 memory 特性门控启停），
        // 不在此处再启动一个不受门控约束的实例。
        startProxyEnvRefreshScheduler();

        await initializePluginHost();
        GlobalState.getInstance().taskManagerState.toolsetProvider = combineToolsetProviders(
            {
                listAvailableToolsets: (taskState) => ApplicationRegistry.listAvailableToolsets(taskState)
            },
            new PluginToolsetProvider()
        );

        // 用户级记忆开关先落到特性门控上，下面的联动再按最终状态注册/注销资源。
        syncMemoryFeatureFromUserSetting();
        // 插件特性门控联动：插件已在 initializePluginHost 中完成 setup（禁用状态就位）。
        // 记忆回顾钩子与设备心跳按特性状态启停；特性变更时同步注销/恢复。
        // worker 侧（镜像 + 崩溃重启兜底）由 initializeRegistryWorker 的 ensureFeatureWorkerSync 统一处理。
        syncMemoryFeatureState();
        // 设备心跳受 telemetry 特性门控：插件禁用时连一次上报都不发，故放在插件宿主初始化之后
        startHeartbeatReporter('desktop');
        featureStateSubscription ??= subscribeFeatureStateChanges();

        registerGoalHooks();

        initializeHarnesses();
        initAgentGateHook();

        // Worker 会继承 ARKDATA_AVAILABLE，因此原生桥探测必须先于 Worker 和应用 Agent 初始化。
        // Native Bridge IPC 已在 createWindow 前注册，此处只执行需要 ArkTS active context 的能力探测。
        await probeArkdataAvailability();

        // 启动 global worker（同步 spawn，不阻塞）。
        // Worker 初始化与应用 Agent 加载将在 createWindow 之后并行执行，避免阻塞窗口显示。
        const manager = getFeatureManager();
        initializeRegistryWorker({
            getPreferredSystemLanguages: getPreferredSystemLanguagesForLocale,
            disabledFeatures: manager.getDisabledFeatures(),
            disabledApplications: manager.getDisabledApplications()
        });
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
            void refreshSystemLanguageOnMainWindowFocus();
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
        // registerFeaturesAPIHandlers() 已在 createWindow 前注册（渲染进程首帧即需要特性状态）
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

        // 用户级记忆开关即时生效：设置面板 / callMainWorld 等任何写入路径都会走到这里，
        // 关掉时记忆工具集、侧栏入口、回顾钩子与清理调度器随特性门控一起停用。
        Setting.afterSetDataCallbacks.push(() => {
            syncMemoryFeatureFromUserSetting();
        });

        // 语言包变更广播：插件宿主激活/停用语言包（LocaleStore 变更）后，
        // 去抖合并为一次瘦身快照推送，各翻译器重建后立即生效
        getLocalePackStore().subscribe(() => {
            scheduleLocalePackSnapshotPush();
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
            // 协议已关闭：复位延迟初始化状态，避免窗口重开等场景静默跳过遥测初始化
            telemetryReadyPromise = undefined;
        }
    });
}

void startApplication();
