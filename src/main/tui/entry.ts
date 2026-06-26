import {
    TUI,
    Text,
    Key,
    matchesKey,
    isKeyRelease,
    type Component,
    EditorKeybindingsManager,
    setEditorKeybindings
} from '@mariozechner/pi-tui';
import { OpenDeskBanner } from './banner';
import { VerticalLayout } from './components/layout';
import { OpenDeskTerminal } from './terminal';
import { TaskView } from './components/taskview';
import { TaskManagerState, TaskState, TaskUpdateChunk } from '../aikernel/states/tasks';
import { GlobalState } from '../aikernel/states/global';
import { AgentInputArea } from './components/input';
import { ApplicationRegistry } from '../applications/registry';
import { KeyboardShortcutManager } from './shortcuts';
import { SlashCommandRegistry, registerAllCommands } from './commands/index.js';
import { Setting, getShortcuts, getTaskArtifactDirectory } from '../utils/setting.js';
import { getReasoningEffortLabels } from '../../common/reasoning-effort.js';
import { logger } from '../utils/logger.js';
import { lookupKnownContextSize, fetchContextSizeFromAPI } from '../utils/model-context';
import { LLM } from '../aikernel/llm.js';
import { AgentDecl, type ModeDecl } from '../aikernel/agents/common.js';
import { MainAgentDecl } from '../aikernel/agents/main/agent.js';
import { HelpOverlay } from './components/help';
import { ConfirmOverlay, InfoOverlay, InfoPage } from './components/notice';
import { LogPanel, LogPanelMode } from './components/logpanel';
import { TodoList } from './components/todolist';
import { TaskSwitcher } from './components/taskswitcher';
import { ConfigMainPage } from './components/config/configMain';
import { getTaskTodosForDisplay } from '../aikernel/todos/task-todos';
import { exportTaskToHtml } from '../utils/export';
import { QuickPassHelper } from '../utils/quickpass';
import { UserMessage, AssistantMessage, type ChatMessage } from '../aikernel/messages';
import { NotificationStore, NotificationCenterOverlay, ToastManager } from './components/notification';
import { NotificationManager } from '../utils/notificationmgr.js';
import { SkillMgrApplication } from '../applications/skillmgr/app.js';
import { DashboardBar } from './components/dashboard';
import { HarnessContext } from '../aikernel/security/harness.js';
import { TUIPermissionPromptProvider } from './components/permission.js';
import { TUIAskUserProvider } from './components/askUser.js';
import { TUIExitPlanModeProvider } from './components/exitPlanMode.js';
import { TaskProfiler } from '../aikernel/profiler.js';
import { t } from '../../locale/index.js';
import { getPlatform } from '../../platforms/base.js';
import { CliPlatform } from '../../platforms/cli.js';
import { onWorkspaceChanged } from '../aikernel/agents_md.js';
import { getExecutionNode } from '../applications/devicemgr/execution.js';

import path from 'path';
import fs from 'fs';
import chalk from 'chalk';

export interface CommandLineArgs {
    workspace: string;
    command?: string;
    model?: string;
    exportHtml?: string;
    exportJson?: string;
    dumpLog?: string;
    headless?: boolean;
    profile?: string;
    allowEverything?: boolean;
    mode?: string;
    language?: string;
    renderInterval?: number;
    /** 各应用的 CLI 参数（已按 bundleName 分组，参数名不含前缀） */
    appCliOptions?: Record<string, Record<string, string | boolean | undefined>>;
}

export class OpenDeskTUI {
    public taskManagerState: TaskManagerState;

    public tui: TUI;
    private container: VerticalLayout = new VerticalLayout({
        spacing: 0,
        padding: { left: 1, right: 1 }
    });
    public taskView: TaskView;
    public logPanel: LogPanel;
    private todoList: TodoList;
    public inputArea: AgentInputArea;
    public dashboardBar: DashboardBar;

    private shortcutManager: KeyboardShortcutManager;
    public commandRegistry: SlashCommandRegistry;
    private retryCommandRegistered = false;

    public activeTaskId?: string;

    /** 所有任务共享的权限确认 provider（内含请求队列，确保同时只弹一个弹窗） */
    private sharedPermissionPrompt: TUIPermissionPromptProvider;

    /** 主任务专用的 askUser provider */
    private sharedAskUserProvider: TUIAskUserProvider;
    /** 主任务专用的 exitPlanMode provider */
    private sharedExitPlanModeProvider: TUIExitPlanModeProvider;

    /** 跟踪是否有 overlay 打开（使用 setter 以在关闭时自动处理积压弹窗） */
    private _hasOpenOverlay = false;

    get hasOpenOverlay(): boolean {
        return this._hasOpenOverlay;
    }

    set hasOpenOverlay(value: boolean) {
        this._hasOpenOverlay = value;
        // overlay 关闭后，处理可能积压的权限/askUser 弹窗
        if (value === false) {
            setTimeout(() => this.processPendingPrompts(), 0);
        }
    }

    /** 当前激活的配置页面组件（非 null 时表示处于配置模式） */
    private configComponent?: Component;

    public workspace: string;
    private agentDecl: AgentDecl;
    public model?: string;
    private lastGlobalDefaultModel: string = '';
    private pendingGlobalDefaultModelPrompt?: { previousDefault: string; newDefault: string; taskId: string };

    /** 当前活跃的运行模式 */
    private _activeMode: ModeDecl;

    /**
     * 如果在命令行中给了-c参数，就用singleShot模式执行，第一轮补全后就自动退出.
     * todo: 这个地方未来可以考虑用LLM来判断任务是不是已经完成了还是需要后续的互动 ;)
     */
    private singleShot?: boolean;
    private profilePath?: string;

    /** -c 模式下任务结束、退出前执行的钩子（如导出），按注册顺序执行 */
    private beforeExitHooks: Array<(taskId: string) => void | Promise<void>> = [];

    /** Toast 弹窗管理器 */
    private toastManager: ToastManager;

    /**
     * Per-task undo/redo stack，仅存在于内存中，不落盘。
     * key = taskId，value = 每次 undo 操作移除的消息数组（栈结构，后进先出）。
     * switch 任务不会清空其他任务的栈，退出 CLI 后全部丢失。
     */
    public undoStacks: Map<string, ChatMessage[][]> = new Map();

    constructor(args: CommandLineArgs) {
        this.taskManagerState = GlobalState.getInstance().taskManagerState;
        this.agentDecl = new MainAgentDecl();

        // 初始化默认 Mode（--allow-everything 等价于 --mode unlimited）
        {
            const modes = this.agentDecl.supportedModes();
            // allowEverything 优先级最高，等同于 unlimited mode
            const cliModeId = args.allowEverything ? 'unlimited' : args.mode?.toLowerCase();
            const defaultId = this.agentDecl.defaultModeId();
            if (cliModeId) {
                this._activeMode =
                    modes.find((m) => m.id === cliModeId) ?? modes.find((m) => m.id === defaultId) ?? modes[0];
            } else {
                this._activeMode = modes.find((m) => m.id === defaultId) ?? modes[0];
            }
        }

        const terminal = new OpenDeskTerminal();
        terminal.onResize((cols, rows) => {
            this.container.setMinLines(rows);
            this.tui.requestRender(true);
        });

        this.tui = new TUI(terminal);
        this.tui.setClearOnShrink(false);
        this.taskView = new TaskView(this.tui, args.renderInterval);
        this.logPanel = new LogPanel(this.tui);
        this.todoList = new TodoList();
        this.inputArea = new AgentInputArea(this);
        this.dashboardBar = new DashboardBar(() => this.tui.requestRender());
        this.sharedPermissionPrompt = new TUIPermissionPromptProvider(this);
        this.sharedAskUserProvider = new TUIAskUserProvider(this);
        this.sharedExitPlanModeProvider = new TUIExitPlanModeProvider(this);
        this.workspace = args.workspace;
        this.model = this.resolveValidChatModelAlias(args.model);
        this.lastGlobalDefaultModel = Setting.getInstance().getData().default_model ?? '';
        this.singleShot = !!args.command;
        this.profilePath = args.profile;
        if (args.command) {
            if (args.exportHtml) {
                const htmlPath = path.resolve(args.workspace, args.exportHtml);
                this.onBeforeExit(async (taskId) => {
                    const task = this.taskManagerState.getTask(taskId);
                    if (!task) return;
                    try {
                        await exportTaskToHtml(task, htmlPath);
                        logger.info(`Session exported to HTML: ${htmlPath}`);
                    } catch (err) {
                        logger.error(`Failed to export HTML: ${err}`);
                    }
                });
            }
            if (args.exportJson) {
                const jsonPath = path.resolve(args.workspace, args.exportJson);
                this.onBeforeExit(async (taskId) => {
                    const task = this.taskManagerState.getTask(taskId);
                    if (!task) return;
                    try {
                        const dir = path.dirname(jsonPath);
                        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                        fs.writeFileSync(jsonPath, JSON.stringify(task.toJSON(), null, 4), {
                            encoding: 'utf8'
                        });
                        logger.info(`Task exported to JSON: ${jsonPath}`);
                    } catch (err) {
                        logger.error(`Failed to export JSON: ${err}`);
                    }
                });
            }

            if (args.profile) {
                const profilePath = path.resolve(args.workspace, args.profile);
                this.onBeforeExit(async (taskId) => {
                    const task = this.taskManagerState.getTask(taskId);
                    if (!task?.profiler) return;
                    try {
                        const report = task.profiler.finish();
                        TaskProfiler.writeReport(report, profilePath);
                        logger.info(`Profile written to: ${profilePath}`);
                    } catch (err) {
                        logger.error(`Failed to write profile: ${err}`);
                    }
                });
            }
        }

        this.tui.addChild(this.container);
        this.container.addChild(new OpenDeskBanner(this.workspace));
        this.container.addChild(this.taskView);
        this.container.addChild(this.todoList);
        this.container.addChild(this.inputArea);
        this.container.addChild(this.dashboardBar);
        this.container.setMinLines(this.tui.terminal.rows);
        this.container.setVerticalAlign('center');

        // 设置日志面板模式变更回调，用于动态调整布局
        this.logPanel.onModeChange((mode) => {
            this.updateLayoutForLogMode(mode);
        });

        this.inputArea.onSubmit(this.onRequestSubmit.bind(this));

        this.inputArea.setQuickPassHandler((text: string) => {
            if (!QuickPassHelper.isQuickPass(text)) {
                return false;
            }
            try {
                const { name, hasApplications } = QuickPassHelper.importConfig(text);
                const scope = hasApplications ? t('quickpass.import.range.all') : t('quickpass.import.range.basic');
                const info = new InfoOverlay(this, {
                    title: t('quickpass.import.success'),
                    message: `${t('quickpass.import.success.detail')}${name}」\n${t('quickpass.import.scope')}${scope}`,
                    closeLabel: t('quickpass.close')
                });
                info.show(() => {
                    this.resolveModelInfo();
                });
            } catch (err: any) {
                const info = new InfoOverlay(this, {
                    title: t('quickpass.import.fail'),
                    message: `${err?.message ?? err}`,
                    closeLabel: t('quickpass.close')
                });
                info.show();
            }
            return true;
        });

        // 当队列变化时，更新当前任务的队列
        this.inputArea.setOnQueueChange((queue) => {
            if (this.activeTaskId) {
                const currentTask = this.taskManagerState.getTask(this.activeTaskId);
                if (currentTask) {
                    currentTask.message_queue = [...queue];
                }
            }
        });

        // 计时器停止时，把累计执行时间同步到当前任务元数据
        this.inputArea.statusBar.onTimerStop = () => {
            if (this.activeTaskId) {
                const task = this.taskManagerState.getTask(this.activeTaskId);
                if (task) {
                    task.total_elapsed_ms = this.inputArea.statusBar.getAccumulatedMs();
                }
            }
        };

        // TaskStatusBar: 只接受当前活跃任务的 token 数据
        this.taskView.onStatusBarUpdate = (data) => {
            if (this.taskView.taskState && this.activeTaskId === this.taskView.taskState.task_id) {
                this.inputArea.statusBar.update(data);
            }
        };

        // 获取 TodoWrite 工具使用的 taskTodosMap 并绑定更新回调
        this.bindTodoUpdates();

        // 指令注册（含快捷键绑定）
        this.commandRegistry = new SlashCommandRegistry();
        this.setupCommands();
        this.inputArea.setCommandRegistry(this.commandRegistry);
        this.taskView.onRetryStateChange = () => {
            this.syncRetryCommandAvailability();
        };

        // 从已注册指令中提取快捷键（跳过由 cli_config.shortcuts 管理的命令）
        const CLI_MANAGED_COMMANDS = new Set(['switch']);
        this.shortcutManager = new KeyboardShortcutManager();
        for (const cmd of this.commandRegistry.getAll()) {
            if (cmd.shortcut && !CLI_MANAGED_COMMANDS.has(cmd.name)) {
                this.shortcutManager.register({
                    key: cmd.shortcut,
                    handler: () => {
                        cmd.execute('');
                    }
                });
            }
        }

        // 将 TUI 的权限/交互提供者注入到 Platform，供 dispatchPromptToAgent 使用
        {
            const platform = getPlatform();
            if (platform instanceof CliPlatform) {
                platform.setPermissionPromptProvider(this.sharedPermissionPrompt);
                platform.setAskUserProvider(this.sharedAskUserProvider);
                platform.setExitPlanModeProvider(this.sharedExitPlanModeProvider);
            }
        }

        // ── 全局通知系统初始化 ──
        this.toastManager = new ToastManager(this);
        this.toastManager.start();
        this.bridgeNotificationManager();

        // 检查设置加载错误，显示 InfoOverlay 提示用户配置文件损坏
        // 用户确认后进入引导页面
        const loadError = Setting.getLoadError();
        if (loadError) {
            const errorOverlay = new InfoOverlay(this, {
                title: t('setting.load.error.title'),
                message: loadError,
                closeLabel: t('setting.load.error.ok'),
                type: 'error'
            });
            errorOverlay.show(() => {
                Setting.clearLoadError();
                // 用户确认后，进入模型未配置引导页面
                this.showModelNotConfiguredNotice();
            });
            // 有 loadError 时，不设置焦点到 inputArea，让 overlay 保持焦点
            // overlay 关闭后，showModelNotConfiguredNotice 会正确设置焦点
        } else {
            // 立即解析模型信息，让状态栏一进去就能显示当前模型
            this.resolveModelInfo();
        }

        // 初始化模式显示
        this.syncModeDisplay();
    }

    /**
     * 将 NotificationManager（来自 worker/应用的通知）桥接到 TUI 通知系统
     */
    private bridgeNotificationManager(): void {
        const store = NotificationStore.getInstance();
        const mgr = NotificationManager.getInstance();

        mgr.addCliCallback((type: string, source: string, title: string, message: string) => {
            const notifType: 'info' | 'warning' | 'error' =
                type === 'error' || type === 'warning' || type === 'info' ? type : 'info';
            // 根据通知类型设置优先级
            const priority =
                type === 'error' ? ('high' as const) : type === 'warning' ? ('normal' as const) : ('low' as const);
            store.push(notifType, source, title, message, {
                priority,
                group: source // 按来源分组
            });
        });

        // 通知数据变更时刷新 DashboardBar（通知角标已移至 DashboardBar）
        store.onChange(() => {
            this.dashboardBar.invalidate();
            this.tui.requestRender();
        });
    }

    private setupCommands() {
        registerAllCommands(this);

        ApplicationRegistry.onReady(() => {
            this.registerApplicationCommands();
            this.dashboardBar.start(60_000);
        });
    }

    private syncRetryCommandAvailability(): void {
        const task = this.activeTaskId ? this.taskManagerState.getTask(this.activeTaskId) : undefined;
        const shouldRegister = task?.isLLMRetryDelayPending() === true;

        if (shouldRegister && !this.retryCommandRegistered) {
            this.retryCommandRegistered = this.commandRegistry.register({
                name: 'retry',
                description: t('task.retry.command.description'),
                source: 'OpenDesk TUI',
                execute: async () => {
                    const currentTask = this.activeTaskId
                        ? this.taskManagerState.getTask(this.activeTaskId)
                        : undefined;
                    if (currentTask?.skipRetryDelay()) {
                        this.syncRetryCommandAvailability();
                        this.tui.requestRender();
                        return;
                    }
                    this.syncRetryCommandAvailability();
                }
            });
            if (this.retryCommandRegistered) {
                this.inputArea.refreshAutocomplete();
            }
            return;
        }

        if (!shouldRegister && this.retryCommandRegistered) {
            this.commandRegistry.unregister('retry');
            this.retryCommandRegistered = false;
            this.inputArea.refreshAutocomplete();
        }
    }

    public getActiveTask(): TaskState | undefined {
        return this.activeTaskId ? this.taskManagerState.getTask(this.activeTaskId) : undefined;
    }

    private resolveValidChatModelAlias(modelAlias?: string): string | undefined {
        if (!modelAlias) return undefined;
        const setting = Setting.getInstance();
        if (setting.getModelInstance(modelAlias, 'chat')) {
            return modelAlias;
        }
        const defaultModel = (setting.getData() as any).default_model || '';
        if (defaultModel && setting.getModelInstance(defaultModel, 'chat')) {
            logger.warn(`model "${modelAlias}" not found, falling back to global default model "${defaultModel}"`);
            return undefined;
        }
        logger.warn(`model "${modelAlias}" not found, clearing model override`);
        return undefined;
    }

    public isTaskStarted(task?: TaskState): boolean {
        if (!task) return false;
        return task.started_at !== undefined || task.chat_context.messages.length > 0 || task.task_status !== 'waiting';
    }

    public getCurrentModelAlias(): string {
        const data = Setting.getInstance().getData() as any;
        const task = this.getActiveTask();
        if (task && this.isTaskStarted(task)) {
            task.ensureValidModelOrFallback();
            return task.model || data.default_model || this.model || '';
        }
        this.model = this.resolveValidChatModelAlias(this.model);
        return this.model || data.default_model || '';
    }

    public setGlobalDefaultModel(alias: string): void {
        const setting = Setting.getInstance();
        const data = setting.getData() as any;
        const previousDefault = data.default_model || '';
        this.model = undefined;
        if (previousDefault === alias) {
            this.lastGlobalDefaultModel = alias;
            this.clearUnstartedActiveTaskModelOverride();
            return;
        }

        setting.setData({ ...data, default_model: alias });
        this.handleGlobalDefaultModelChanged(previousDefault, alias);
    }

    private handleConfigChange(): void {
        const currentDefault = Setting.getInstance().getData().default_model || '';
        const previousDefault = this.lastGlobalDefaultModel;
        if (currentDefault !== previousDefault) {
            this.handleGlobalDefaultModelChanged(previousDefault, currentDefault);
            return;
        }
        this.resolveModelInfo();
    }

    private handleGlobalDefaultModelChanged(previousDefault: string, newDefault: string): void {
        this.model = undefined;
        this.lastGlobalDefaultModel = newDefault;
        this.clearUnstartedActiveTaskModelOverride();
        this.queueSwitchActiveTaskToGlobalDefaultPrompt(previousDefault, newDefault);
        this.resolveModelInfo();
    }

    private clearUnstartedActiveTaskModelOverride(): void {
        const task = this.getActiveTask();
        if (!task || this.isTaskStarted(task) || task.model === undefined) return;
        task.model = undefined;
        task.persistLater();
    }

    private queueSwitchActiveTaskToGlobalDefaultPrompt(previousDefault: string, newDefault: string): void {
        const task = this.getTaskForGlobalDefaultModelPrompt(previousDefault, newDefault);
        if (!task) {
            this.pendingGlobalDefaultModelPrompt = undefined;
            return;
        }

        const prompt = { previousDefault, newDefault, taskId: task.task_id };
        if (this.isInputBlocked()) {
            this.pendingGlobalDefaultModelPrompt = prompt;
            return;
        }

        this.showSwitchActiveTaskToGlobalDefaultPrompt(prompt);
    }

    private getTaskForGlobalDefaultModelPrompt(previousDefault: string, newDefault: string): TaskState | undefined {
        const task = this.getActiveTask();
        if (!task || !this.isTaskStarted(task)) return undefined;

        if (!task.model && previousDefault) {
            task.model = previousDefault;
            task.persistLater();
        }

        if (!previousDefault || !newDefault || previousDefault === newDefault) return undefined;

        const currentTaskModel = task.model || previousDefault;
        return currentTaskModel !== newDefault ? task : undefined;
    }

    private showSwitchActiveTaskToGlobalDefaultPrompt(prompt: {
        previousDefault: string;
        newDefault: string;
        taskId: string;
    }): void {
        const task = this.taskManagerState.getTask(prompt.taskId);
        if (!task || !this.isTaskStarted(task)) return;

        const currentTaskModel = task.model || prompt.previousDefault;
        if (
            !prompt.previousDefault ||
            !prompt.newDefault ||
            prompt.previousDefault === prompt.newDefault ||
            currentTaskModel === prompt.newDefault
        ) {
            return;
        }

        const overlay = new ConfirmOverlay(this, {
            title: t('model.global.changed.title'),
            message: t('model.global.changed.message', {
                oldModel: prompt.previousDefault,
                newModel: prompt.newDefault
            }),
            confirmLabel: t('model.global.changed.confirm'),
            cancelLabel: t('model.global.changed.cancel')
        });
        overlay.show(
            () => {
                task.model = prompt.newDefault;
                task.persistLater();
                this.resolveModelInfo();
            },
            () => {
                this.resolveModelInfo();
            }
        );
    }

    private processPendingGlobalDefaultModelPrompt(): void {
        if (!this.pendingGlobalDefaultModelPrompt || this.isInputBlocked()) return;

        const prompt = this.pendingGlobalDefaultModelPrompt;
        this.pendingGlobalDefaultModelPrompt = undefined;
        this.showSwitchActiveTaskToGlobalDefaultPrompt(prompt);
    }

    /**
     * 从应用中收集 CLI 斜杠命令并注册
     */
    private registerApplicationCommands() {
        const apps = ApplicationRegistry.getApplicationList();
        for (const appInfo of apps) {
            const appInfoTyped = appInfo as { bundleName: string; name: string; showIcon: boolean };
            const app = ApplicationRegistry.getApplication(appInfoTyped.bundleName);
            if (app) {
                const commands = app.getCliSlashCommands(this);
                for (const cmd of commands) {
                    // 设置命令来源为应用名称
                    cmd.source = app.name;
                    this.commandRegistry.register(cmd);
                }
            }
        }
        // 刷新自动补全，确保新注册的命令能被提示
        this.inputArea.refreshAutocomplete();

        // 订阅 Skill 刷新事件，让 /skillName 自动补全的名称和描述跟着更新
        SkillMgrApplication.onSkillsRefreshed(() => {
            this.inputArea.refreshAutocomplete();
            void this.refreshActiveTaskSystemPrompt();
        });
    }

    private async refreshActiveTaskSystemPrompt(): Promise<void> {
        if (!this.activeTaskId) return;
        const task = this.taskManagerState.getTask(this.activeTaskId);
        if (!task) return;
        try {
            const systemPrompt = await this.agentDecl.createSystemPrompt(this._activeMode, task);
            task.setSystemPrompt(systemPrompt);
        } catch (err) {
            logger.warn(`Failed to refresh active task system prompt after skill update: ${err}`);
        }
    }

    showNotificationCenter() {
        // 打开通知中心时，先清除所有残留的 toast 弹窗
        this.toastManager.dismissAll();
        const overlay = new NotificationCenterOverlay(this);
        overlay.show();
    }

    async doExport(task: any, absolutePath: string) {
        await exportTaskToHtml(task, absolutePath);
        logger.info(`Session exported to: ${absolutePath}`);

        const info = new InfoOverlay(this, {
            title: t('export.success'),
            message: `${t('export.success.detail')}${absolutePath}`,
            closeLabel: t('common.close')
        });
        info.show();
    }

    /**
     * 注册在 -c 模式任务结束、退出前执行的钩子。仅在有 -c 时注册的导出等逻辑会在此执行。
     */
    onBeforeExit(fn: (taskId: string) => void | Promise<void>): void {
        this.beforeExitHooks.push(fn);
    }

    private async runBeforeExitHooks(taskId: string): Promise<void> {
        for (const fn of this.beforeExitHooks) {
            await fn(taskId);
        }
    }

    /**
     * 根据日志面板模式更新 VerticalLayout 的子组件排列
     */
    private updateLayoutForLogMode(mode: LogPanelMode) {
        this.container.clear();

        this.container.addChild(new OpenDeskBanner(this.workspace));

        if (mode === 'all') {
            this.container.addChild(this.logPanel);
        } else if (mode === 'last') {
            this.container.addChild(this.taskView);
            this.container.addChild(this.todoList);
            this.container.addChild(this.logPanel);
        } else {
            this.container.addChild(this.taskView);
            this.container.addChild(this.todoList);
        }

        this.container.addChild(this.inputArea);
        this.container.addChild(this.dashboardBar);
        this.container.setMinLines(this.tui.terminal.rows);

        this.tui.requestRender();
    }

    enterConfigMode() {
        this.configComponent = new ConfigMainPage(
            this,
            () => this.exitConfigMode(),
            () => {
                this.handleConfigChange();
            }
        );
        this.shortcutManager.detach();

        this.container.clear();
        this.container.addChild(new OpenDeskBanner(this.workspace));
        this.container.addChild(this.configComponent);
        this.container.setMinLines(this.tui.terminal.rows);
        this.tui.requestRender();
    }

    /**
     * 以内联页面方式展示标题和内容（非浮层），用户按 Enter/Esc 后恢复正常布局。
     * 供应用层 slash command 调用，替代 InfoOverlay 浮层。
     */
    public showTextPage(title: string, message: string): void {
        const page = new InfoPage(this, title, message, () => {
            this.shortcutManager.attach(this.tui);
            if (this.modelNotConfiguredMode) {
                // getInstance() 已内置容错，不会抛异常
                const setting = Setting.getInstance();
                const data = setting.getData() as any;
                if (!data.default_model || data.default_model.trim() === '') {
                    this.container.clear();
                    this.container.addChild(new OpenDeskBanner(this.workspace));
                    if (this.modelNotConfiguredNotice) {
                        this.container.addChild(this.modelNotConfiguredNotice);
                    }
                    this.container.addChild(this.inputArea);
                    this.container.setMinLines(this.tui.terminal.rows);
                    this.tui.requestRender();
                    setTimeout(() => {
                        this.tui.setFocus(this.inputArea.input);
                        this.tui.requestRender();
                    }, 10);
                    return;
                } else {
                    this.modelNotConfiguredNotice = undefined;
                    this.modelNotConfiguredMode = false;
                }
            }

            this.container.clear();
            this.container.addChild(new OpenDeskBanner(this.workspace));
            this.container.addChild(this.taskView);
            this.container.addChild(this.todoList);
            if (this.logPanel.mode !== 'off') {
                this.container.addChild(this.logPanel);
            }
            this.container.addChild(this.inputArea);
            this.container.addChild(this.dashboardBar);
            this.container.setMinLines(this.tui.terminal.rows);
            this.tui.requestRender();
            setTimeout(() => {
                this.tui.setFocus(this.inputArea.input);
                this.tui.requestRender();
            }, 10);
        });
        this.shortcutManager.detach();
        this.container.clear();
        this.container.addChild(new OpenDeskBanner(this.workspace));
        this.container.addChild(page);
        this.container.setMinLines(this.tui.terminal.rows);
        this.tui.requestRender();
    }

    private exitConfigMode() {
        this.configComponent = undefined;

        this.shortcutManager.attach(this.tui);

        // 退出配置模式时，检查模型是否已配置
        // 如果仍未配置，则重新显示提示页面
        if (this.modelNotConfiguredMode) {
            // getInstance() 已内置容错，不会抛异常
            const setting = Setting.getInstance();
            const data = setting.getData() as any;
            if (!data.default_model || data.default_model.trim() === '') {
                this.container.clear();
                this.container.addChild(new OpenDeskBanner(this.workspace));
                this.container.addChild(this.modelNotConfiguredNotice!);
                this.container.addChild(this.inputArea);
                this.container.addChild(this.dashboardBar);
                this.container.setMinLines(this.tui.terminal.rows);
                this.tui.requestRender();
                setTimeout(() => {
                    this.tui.setFocus(this.inputArea.input);
                    this.tui.requestRender();
                    // 配置模式退出后（模型未配置状态），处理可能积压的弹窗
                    this.processPendingPrompts();
                }, 10);
                return;
            } else {
                // 模型已配置，清除提示状态
                this.modelNotConfiguredNotice = undefined;
                this.modelNotConfiguredMode = false;
            }
        }

        this.container.clear();
        this.container.addChild(new OpenDeskBanner(this.workspace));
        this.container.addChild(this.taskView);
        this.container.addChild(this.todoList);

        if (this.logPanel.mode !== 'off') {
            this.container.addChild(this.logPanel);
        }

        this.container.addChild(this.inputArea);
        this.container.addChild(this.dashboardBar);
        this.container.setMinLines(this.tui.terminal.rows);

        this.resolveModelInfo();

        this.tui.requestRender();
        setTimeout(() => {
            this.tui.setFocus(this.inputArea.input);
            this.tui.requestRender();
            // 配置模式退出后，处理可能积压的权限/askUser 弹窗
            this.processPendingPrompts();
        }, 10);
    }

    async createNewTask() {
        // 保存当前任务的队列（如果有）
        if (this.activeTaskId) {
            const currentTask = this.taskManagerState.getTask(this.activeTaskId);
            if (currentTask) {
                currentTask.message_queue = this.inputArea.getQueueSnapshot();
            }
        }

        const task = this.taskManagerState.createTask(this.model);
        await this.initTaskHarness(task);
        const systemPrompt = await this.agentDecl.createSystemPrompt(this._activeMode, task);
        task.setSystemPrompt(systemPrompt);

        this.activeTaskId = task.task_id;
        this.taskView.taskState = task;
        this.taskView.clearMessages();
        this.syncRetryCommandAvailability();
        // 绑定到新任务的队列（应该是空的）
        this.inputArea.bindToTaskQueue(task.task_id, task.message_queue);
        this.inputArea.setStatus('idle');
        this.inputArea.statusBar.stopTimer();
        this.inputArea.statusBar.resetAccumulated();
        this.inputArea.statusBar.update({ totalTokens: 0 });
        this.tui.requestRender(true);
    }

    /**
     * 获取当前激活的任务 ID
     */
    getActiveTaskId(): string | undefined {
        return this.activeTaskId;
    }

    /**
     * 清除当前活跃任务的视图状态（用于任务被外部删除时）
     */
    clearActiveTask() {
        this.taskView.taskState = undefined;
        this.taskView.clearMessages();
        this.activeTaskId = undefined;
        this.syncRetryCommandAvailability();
        this.inputArea.clearMessageQueue();
        this.inputArea.setStatus('idle');
        this.inputArea.statusBar.stopTimer();
        this.inputArea.statusBar.resetAccumulated();
        this.inputArea.statusBar.update({ totalTokens: 0 });
        this.tui.requestRender();
    }

    public async switchToTask(task: TaskState) {
        task.ensureValidModelOrFallback();

        // 先停止计时器并保存旧任务的累计时间（在 activeTaskId 切换之前）
        this.inputArea.statusBar.stopTimer();

        // 保存当前任务的队列（如果有）
        if (this.activeTaskId) {
            const currentTask = this.taskManagerState.getTask(this.activeTaskId);
            if (currentTask) {
                currentTask.message_queue = this.inputArea.getQueueSnapshot();
            }
        }

        // 切换到新任务
        this.activeTaskId = task.task_id;
        this.taskView.taskState = task;
        this.taskView.clearMessages();
        this.syncRetryCommandAvailability();
        // 绑定到新任务的队列
        this.inputArea.bindToTaskQueue(task.task_id, task.message_queue);
        this.inputArea.statusBar.setAccumulatedMs(task.total_elapsed_ms);

        // 为历史 ToolCall 挂载 toolsets 并解析 tool 引用，确保自定义渲染器正常工作
        await task.ensureToolsResolved();

        // rebuildFromHistory 会通过 onStatusBarUpdate 恢复最后一条消息的 token 用量，
        // 因此先重置为 0，再重建历史——如果有历史 usage 会立即被覆盖
        this.inputArea.statusBar.update({ totalTokens: 0 });
        this.taskView.rebuildFromHistory();

        if (task.task_status === 'running') {
            this.inputArea.setStatus('running');
            this.inputArea.statusBar.startTimer();
            this.resubscribeToRunningTask(task);
        } else {
            this.inputArea.setStatus('idle');
            // 即使任务当前非 running，也启动监控器：消息插件场景下，
            // 任务可能在切换后立即变为 running（由后台路由器驱动）
            this.startRunningMonitorForTask(task);
        }
        this.tui.requestRender(true);

        // 切换任务后，处理可能与新任务关联的积压弹窗
        this.processPendingPrompts();
    }

    /**
     * 重新订阅一个正在运行的任务的更新流，确保切换回来后
     * 能继续看到新的输出消息。
     * 当任务完成后，会继续监控任务是否重新变为 running 状态，
     * 以支持用户通过 channel 持续交互的场景。
     */
    private resubscribeToRunningTask(task: TaskState) {
        const snapshotTaskId = task.task_id;

        const subscribeToUpdates = () => {
            this.taskView.startStreaming();
            task.waitUntilFinished(async (chunkUpdate: TaskUpdateChunk) => {
                if (this.activeTaskId !== snapshotTaskId) return;
                await this.taskView.handleChunkUpdate(chunkUpdate);
                this.taskView.requestStreamRender();
            }).then(() => {
                if (this.activeTaskId !== snapshotTaskId) return;

                this.taskView.clearStreamThrottle();
                const lastView = this.taskView.getLastAssistantView();
                if (lastView) lastView.setStreamingComplete();
                this.inputArea.statusBar.stopTimer();
                this.inputArea.setStatus('idle');
                this.tui.requestRender();
                this.processQueue();

                startRunningMonitor();
            });
        };

        // 监控任务是否重新变为 running 状态（支持 channel 持续交互）
        const startRunningMonitor = () => {
            const monitorInterval = setInterval(() => {
                // 如果已切换到其他任务，停止监控
                if (this.activeTaskId !== snapshotTaskId) {
                    clearInterval(monitorInterval);
                    return;
                }

                // 如果任务重新变为 running，重新订阅并停止监控
                if (task.task_status === 'running') {
                    clearInterval(monitorInterval);
                    this.inputArea.setStatus('running');
                    this.inputArea.statusBar.startTimer();

                    // 重建历史消息以显示新的用户消息
                    this.taskView.clearMessages();
                    this.taskView.rebuildFromHistory();
                    this.tui.requestRender();

                    subscribeToUpdates();
                }
            }, 500); // 每 500ms 检查一次
        };

        subscribeToUpdates();
    }

    /**
     * 为当前非 running 的任务启动 monitor，检测其是否变为 running。
     * 用于消息插件场景：切换到任务后，后台路由器随即启动任务处理。
     */
    private startRunningMonitorForTask(task: TaskState) {
        const snapshotTaskId = task.task_id;

        const monitorInterval = setInterval(() => {
            if (this.activeTaskId !== snapshotTaskId) {
                clearInterval(monitorInterval);
                return;
            }

            if (task.task_status === 'running') {
                clearInterval(monitorInterval);
                this.inputArea.setStatus('running');
                this.inputArea.statusBar.startTimer();

                this.taskView.clearMessages();
                this.taskView.rebuildFromHistory();
                this.tui.requestRender();

                this.resubscribeToRunningTask(task);
            }
        }, 300);

        // 如果 15 秒内任务没有变为 running，停止监控以避免资源泄漏
        setTimeout(() => clearInterval(monitorInterval), 15000);
    }

    private static readonly MAX_MSG_CHARS = 2000;

    /**
     * 从当前对话构建一个精简的上下文摘要字符串，供后台记忆提取使用。
     * 丢弃工具输出，截断过长的单条消息。
     */
    public buildConversationSnapshot(): string {
        const task = this.taskView.taskState;
        if (!task) return '';

        const parts: string[] = [];
        for (const msg of task.chat_context.messages) {
            if (msg instanceof UserMessage) {
                const content = Array.isArray(msg.content) ? msg.content : [];
                for (const p of content) {
                    if (p?.type === 'text' && p.text) {
                        const text =
                            p.text.length > OpenDeskTUI.MAX_MSG_CHARS
                                ? p.text.slice(0, OpenDeskTUI.MAX_MSG_CHARS) + '...(已截断)'
                                : p.text;
                        parts.push(`[用户]: ${text}`);
                    }
                }
            } else if (msg instanceof AssistantMessage) {
                const content = Array.isArray(msg.content) ? msg.content : [];
                for (const p of content) {
                    if (p?.type === 'text' && (p as any).text) {
                        const text =
                            (p as any).text.length > OpenDeskTUI.MAX_MSG_CHARS
                                ? (p as any).text.slice(0, OpenDeskTUI.MAX_MSG_CHARS) + '...(已截断)'
                                : (p as any).text;
                        parts.push(`[助手]: ${text}`);
                    }
                    // 工具调用只保留名称，丢弃输出
                    if (p?.type === 'tool_call') {
                        const toolcalls = Array.isArray(p.toolcalls) ? p.toolcalls : [];
                        for (const tc of toolcalls) {
                            if (!tc) continue;
                            const argSnippet = tc.args_string
                                ? tc.args_string.length > OpenDeskTUI.MAX_MSG_CHARS
                                    ? tc.args_string.slice(0, OpenDeskTUI.MAX_MSG_CHARS) + '...'
                                    : tc.args_string
                                : '';
                            parts.push(`[工具调用]: ${tc.tool_name}(${argSnippet})`);
                            // 工具输出全部丢弃
                        }
                    }
                }
            }
        }

        return parts.join('\n\n');
    }

    async exit() {
        try {
            this.dashboardBar.stop();
            this.toastManager.stop();
            this.inputArea.statusBar.stopTimer();
            this.shortcutManager.detach();
            this.tui.stop();
        } catch {
            /* 忽略 TUI 清理错误 */
        }

        try {
            await this.taskManagerState.flushAllPendingSaves();
        } catch {
            /* best-effort flush */
        }

        try {
            const { closeTempDir } = await import('../utils/temp.js');
            closeTempDir();
        } catch {
            /* best-effort */
        }

        const worker = ApplicationRegistry.globalWorker;
        if (worker) {
            await worker.terminate();
        }
        process.exit(0);
    }

    async onRequestSubmit(request: string) {
        if (this.taskView.taskState === undefined) {
            this.taskView.taskState = this.taskManagerState.createTask(this.model);
            await this.initTaskHarness(this.taskView.taskState);
            const systemPrompt = await this.agentDecl.createSystemPrompt(this._activeMode, this.taskView.taskState);
            this.taskView.taskState.setSystemPrompt(systemPrompt);

            if (this.profilePath) {
                this.taskView.taskState.profiler = new TaskProfiler(this.taskView.taskState.task_id);
            }

            // 绑定到新任务的队列
            this.inputArea.bindToTaskQueue(this.taskView.taskState.task_id, this.taskView.taskState.message_queue);
        }

        const taskId = this.taskView.taskState.task_id;
        this.activeTaskId = taskId;

        this.resolveModelInfo();
        this.inputArea.statusBar.startTimer();

        await this.taskView.communicate(request).finally(async () => {
            if (this.activeTaskId === taskId) {
                this.inputArea.statusBar.stopTimer();
                this.inputArea.setStatus('idle');
                this.processQueue();

                // 如果使用了 -c 参数，执行 beforeExit 钩子后退出
                if (this.singleShot) {
                    await this.runBeforeExitHooks(taskId);
                    await this.exit();
                }
            }
        });
    }

    /**
     * 执行命令行传入的命令（供外部调用，在 registry 就绪后执行）
     * @param command - 要执行的命令
     */
    executeCommand(command: string): void {
        this.onRequestSubmit(command);
    }

    /**
     * 解析模型信息（名称、上下文长度）。首次调用时触发异步 API 查询，
     * 结果缓存，不会重复请求。
     * 如果检测到没有配置模型（default_model 为空），则隐藏 taskview 并提醒用户配置。
     */
    public resolveModelInfo() {
        // getInstance() 已内置容错，不会抛异常
        const setting = Setting.getInstance();
        const data = setting.getData() as any;
        const currentDefault = data.default_model || '';
        if (currentDefault !== this.lastGlobalDefaultModel) {
            this.handleGlobalDefaultModelChanged(this.lastGlobalDefaultModel, currentDefault);
            return;
        }
        const aliasToUse = this.getCurrentModelAlias();

        // 检查是否没有配置模型
        if (!aliasToUse || aliasToUse.trim() === '') {
            // 没有配置模型，隐藏 taskview 并显示提示信息
            this.showModelNotConfiguredNotice();
            return;
        }

        // 模型已配置，恢复正常的 taskview 显示
        this.hideModelNotConfiguredNotice();

        const modelCfg = data.models?.find((m: any) => m.alias === aliasToUse);
        const modelName = modelCfg?.model_name ?? aliasToUse;

        const effortLabels = getReasoningEffortLabels(t);
        const effortTag = modelCfg?.reasoning_effort
            ? ` [${effortLabels[modelCfg.reasoning_effort] ?? modelCfg.reasoning_effort}]`
            : '';

        this.inputArea.statusBar.update({ modelName: `${aliasToUse}${effortTag}` });

        // 优先使用用户配置的上下文长度
        if (modelCfg?.context_length && modelCfg.context_length > 0) {
            this.inputArea.statusBar.update({ contextSize: modelCfg.context_length });
        } else {
            // 先用内置表即时填充，再异步 API 覆盖
            const knownSize = lookupKnownContextSize(modelName);
            if (knownSize > 0) {
                this.inputArea.statusBar.update({ contextSize: knownSize });
            }

            const modelInstance = aliasToUse
                ? setting.getModelInstance(aliasToUse, 'chat')
                : setting.getDefaultModelInstance();
            if (modelInstance) {
                fetchContextSizeFromAPI(modelInstance)
                    .then((apiSize) => {
                        if (apiSize > 0) {
                            this.inputArea.statusBar.update({ contextSize: apiSize });
                            logger.info(`model context size from API: ${apiSize}`);
                        } else if (knownSize > 0) {
                            logger.info(`model context size from builtin table: ${knownSize}`);
                        }
                    })
                    .catch(() => {});
            }
        }

        LLM.supportsVision(aliasToUse)
            .then((vision) => {
                const suffix = vision ? ' 📷' : '';
                this.inputArea.statusBar.update({ modelName: `${aliasToUse}${effortTag}${suffix}` });
            })
            .catch(() => {});
        this.tui.requestRender();
    }

    /**
     * 显示模型未配置的提示信息，隐藏 taskview 和 todoList
     */
    private showModelNotConfiguredNotice() {
        if (this.modelNotConfiguredNotice) {
            return; // 已经显示
        }

        // 创建提示组件，使用 Text 组件显示多行文本
        const noticeText = [
            chalk.bold.yellow('⚠️  ' + t('model.not.configured')),
            '',
            chalk.dim(t('model.not.configured.hint')),
            '',
            chalk.cyan(t('model.configure.usage')),
            '',
            chalk.white('  ' + t('model.configure.step1')),
            chalk.white('  ' + t('model.configure.step2')),
            chalk.white('  ' + t('model.configure.step3')),
            chalk.white('  ' + t('model.configure.step4')),
            chalk.white('  ' + t('model.configure.step5')),
            '',
            chalk.dim(t('model.configure.after'))
        ].join('\n');

        this.modelNotConfiguredNotice = new Text(noticeText);

        // 标记需要处理回车键
        this.modelNotConfiguredMode = true;

        // 如果当前处于配置模式，不破坏配置页面布局；
        // exitConfigMode() 退出时会根据 modelNotConfiguredMode 标记处理布局。
        if (this.configComponent) {
            return;
        }

        this.container.clear();
        this.container.addChild(new OpenDeskBanner(this.workspace));
        this.container.addChild(this.modelNotConfiguredNotice);
        this.container.addChild(this.inputArea);
        this.container.addChild(this.dashboardBar);
        this.container.setMinLines(this.tui.terminal.rows);

        this.tui.requestRender();
        setTimeout(() => {
            this.tui.setFocus(this.inputArea.input);
            this.tui.requestRender();
        }, 10);
    }

    /**
     * 隐藏模型未配置的提示信息，恢复正常的 taskview 显示
     */
    private hideModelNotConfiguredNotice() {
        if (!this.modelNotConfiguredNotice) {
            return;
        }

        this.modelNotConfiguredNotice = undefined;
        this.modelNotConfiguredMode = false;

        // 如果当前处于配置模式，不破坏配置页面布局；
        // exitConfigMode() 退出时会根据最新状态恢复主界面。
        if (this.configComponent) {
            return;
        }

        // 恢复原始布局
        this.container.clear();
        this.container.addChild(new OpenDeskBanner(this.workspace));
        this.container.addChild(this.taskView);
        this.container.addChild(this.todoList);
        if (this.logPanel.mode !== 'off') {
            this.container.addChild(this.logPanel);
        }
        this.container.addChild(this.inputArea);
        this.container.addChild(this.dashboardBar);
        this.container.setMinLines(this.tui.terminal.rows);

        this.tui.requestRender();
        setTimeout(() => {
            this.tui.setFocus(this.inputArea.input);
            this.tui.requestRender();
        }, 10);
    }

    private modelNotConfiguredNotice?: Text;
    private modelNotConfiguredMode = false;

    private async processQueue() {
        const taskId = this.activeTaskId;
        while (this.inputArea.hasQueuedMessages() && this.activeTaskId === taskId) {
            // 每次出队后更新任务的队列
            const currentTask = this.taskManagerState.getTask(taskId!);
            if (currentTask) {
                currentTask.message_queue = this.inputArea.getQueueSnapshot();
            }

            const next = this.inputArea.dequeueMessage();
            if (!next) break;

            // 再次更新队列
            if (currentTask) {
                currentTask.message_queue = this.inputArea.getQueueSnapshot();
            }

            this.inputArea.setStatus('running');
            this.inputArea.statusBar.startTimer();
            await this.taskView.communicate(next).finally(() => {
                if (this.activeTaskId === taskId) {
                    this.inputArea.statusBar.stopTimer();
                    this.inputArea.setStatus('idle');
                }
            });
        }
    }

    /**
     * Bind todo updates from the TodoWrite tool's internal map to the TodoList component.
     * This allows the TodoList to be updated whenever TodoWrite is called.
     */
    private bindTodoUpdates() {
        const checkTodoChanges = () => {
            if (!this.activeTaskId) {
                setTimeout(checkTodoChanges, 500);
                return;
            }

            const todos = getTaskTodosForDisplay(this.activeTaskId);
            const changed = this.todoList.setTodos(todos);
            if (changed) {
                this.tui.requestRender();
            }
            setTimeout(checkTodoChanges, 300);
        };
        checkTodoChanges();
    }

    /**
     * Get the TodoList component
     */
    getTodoList(): TodoList {
        return this.todoList;
    }

    /**
     * 检查是否处于模型未配置模式
     */
    isModelNotConfiguredMode(): boolean {
        return this.modelNotConfiguredMode;
    }

    isConfigMode(): boolean {
        return this.configComponent !== undefined;
    }

    /**
     * 检查当前是否处于输入阻塞状态（配置模式或 overlay 打开）。
     * 处于此状态时，权限弹窗和 askUser 弹窗应该入队等待，而不是立即显示。
     */
    isInputBlocked(): boolean {
        return this.configComponent !== undefined || this.hasOpenOverlay || this.inputArea.hasPromptWidget();
    }

    /**
     * 配置页等模式默认不渲染输入区；当输入区 prompt 正在显示时，
     * 临时把 inputArea 挂到底部，关闭最后一个 prompt 后再移除。
     */
    public syncInputAreaPromptHost(): void {
        if (this.configComponent === undefined) return;

        const hasInputArea = this.container.children.includes(this.inputArea);
        const shouldShowInputArea = this.inputArea.hasPromptWidget();

        if (shouldShowInputArea && !hasInputArea) {
            this.container.addChild(this.inputArea);
            this.container.setMinLines(this.tui.terminal.rows);
            this.tui.requestRender();
            return;
        }

        if (!shouldShowInputArea && hasInputArea) {
            this.container.removeChild(this.inputArea);
            this.container.setMinLines(this.tui.terminal.rows);
            this.tui.requestRender();
        }
    }

    /**
     * 处理积压的权限弹窗请求（退出配置/overlay 模式后调用）。
     */
    processPendingPrompts(): void {
        if (this.isInputBlocked()) return;

        this.sharedPermissionPrompt.processQueueIfReady();
        if (this.isInputBlocked()) return;
        this.sharedAskUserProvider.processQueueIfReady();
        if (this.isInputBlocked()) return;
        this.sharedExitPlanModeProvider.processQueueIfReady();
        if (this.isInputBlocked()) return;
        this.processPendingGlobalDefaultModelPrompt();
    }

    /**
     * 为新创建的任务初始化 harnessContext（权限引擎 + 环境变量 + 权限确认 UI）。
     * 根据当前 activeMode 构建，并应用全局默认执行节点。
     */
    private async initTaskHarness(task: TaskState): Promise<void> {
        await this.taskManagerState.initHarness(task, this.workspace, this._activeMode);
        // 应用全局默认执行节点（如果设置了）
        const globalState = GlobalState.getInstance();
        const defaultNodeId = globalState.getDefaultExecutionNodeId();
        if (defaultNodeId) {
            // 验证节点是否在线
            const node = getExecutionNode(defaultNodeId);
            if (node) {
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
            }
        }
    }

    // ─── Mode 管理 ────────────────────────────────────────────────

    /**
     * 获取当前活跃的运行模式
     */
    get activeMode(): ModeDecl {
        return this._activeMode;
    }

    /**
     * 获取 Agent 支持的所有模式
     */
    getSupportedModes(): ModeDecl[] {
        return this.agentDecl.supportedModes();
    }

    /**
     * 同步当前 Mode 的显示信息到 TaskStatusBar
     */
    private syncModeDisplay(): void {
        this.inputArea.statusBar.update({
            modeDisplay: `${this._activeMode.icon} ${this._activeMode.name}`,
            modeColor: this._activeMode.color
        });
    }

    /**
     * 切换到下一个模式（循环切换）。
     * 切换后立即更新当前活跃任务的权限引擎，确保模式变更即时生效。
     */
    async cycleMode(): Promise<void> {
        const modes = this.agentDecl.supportedModes();
        const currentIndex = modes.findIndex((m) => m.id === this._activeMode.id);
        const nextIndex = (currentIndex + 1) % modes.length;
        const oldMode = this._activeMode;
        const newMode = modes[nextIndex];

        // 调用退出旧模式的钩子
        await oldMode.onExitMode?.(this.workspace);

        this._activeMode = newMode;

        // 调用进入新模式的钩子
        await newMode.onEnterMode?.(this.workspace);

        this.syncModeDisplay();
        await this.syncAllTaskHarnesses();
        this.tui.requestRender();
        logger.info(`Mode switched to: ${this._activeMode.name} (${this._activeMode.id})`);
    }

    /**
     * 在所有已配置模型之间循环切换。
     * 已开始任务中只切换当前任务；未开始时切换全局默认模型。
     */
    cycleModel(): void {
        const setting = Setting.getInstance();
        const data = setting.getData() as any;
        const models: any[] = (data.models ?? []).filter((model: any) => model?.model_type !== 'embedding');
        if (models.length === 0) {
            logger.info('No models configured, cannot cycle');
            return;
        }
        const activeTask = this.getActiveTask();
        const taskStarted = this.isTaskStarted(activeTask);
        if (models.length === 1) {
            const onlyAlias = models[0].alias;
            if (taskStarted && activeTask) {
                activeTask.model = onlyAlias;
                activeTask.persistLater();
            } else {
                this.setGlobalDefaultModel(onlyAlias);
            }
            this.resolveModelInfo();
            return;
        }

        const currentAlias = this.getCurrentModelAlias();
        const currentIndex = models.findIndex((m: any) => m.alias === currentAlias);
        const nextIndex = (currentIndex + 1) % models.length;
        const nextAlias = models[nextIndex].alias;

        if (taskStarted && activeTask) {
            activeTask.model = nextAlias;
            activeTask.persistLater();
        } else {
            this.setGlobalDefaultModel(nextAlias);
        }
        this.resolveModelInfo();
        logger.info(`Model switched to: ${nextAlias}`);
    }

    /**
     * 根据 id 切换到指定模式
     */
    async setMode(modeId: string): Promise<boolean> {
        const modes = this.agentDecl.supportedModes();
        const target = modes.find((m) => m.id === modeId);
        if (!target) return false;

        const oldMode = this._activeMode;

        // 调用退出旧模式的钩子
        if (oldMode.id !== target.id) {
            await oldMode.onExitMode?.(this.workspace);
        }

        this._activeMode = target;

        // 调用进入新模式的钩子
        if (oldMode.id !== target.id) {
            await target.onEnterMode?.(this.workspace);
        }

        this.syncModeDisplay();
        await this.syncAllTaskHarnesses();
        this.tui.requestRender();
        logger.info(`Mode set to: ${this._activeMode.name} (${this._activeMode.id})`);
        return true;
    }

    /**
     * 将所有主任务的权限引擎同步到最新的 Mode。
     * 保留已有的环境变量和 permissionPrompt，仅替换权限引擎和 activeModeId。
     * 子任务由父任务管理，不在此处更新。
     */
    private async syncAllTaskHarnesses(): Promise<void> {
        const mode = this._activeMode;
        for (const task of this.taskManagerState.tasks) {
            if (task.parent_id !== null) continue;
            const savedEnv = task.harnessContext.environ;
            const savedPrompt = task.harnessContext.permissionPrompt;

            try {
                const ctx = await HarnessContext.createForMode(this.workspace, mode);
                ctx.environ = savedEnv;
                ctx.permissionPrompt = savedPrompt;
                await ctx.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
                task.harnessContext = ctx;
                task.activeModeId = mode.id;
                task.allowedTools = mode.allowedTools;
                task.disabledTools = mode.disabledTools;
            } catch (err) {
                logger.warn(`Failed to sync task harness for mode ${mode.id}: ${err}`);
            }
        }
    }

    /**
     * 更新工作空间目录，同步刷新 Banner、自动补全 basePath，
     * 并为所有主任务重建 harnessContext（包含新 workspace 的权限引擎）。
     * 子任务由父任务在创建时管理，不在此处更新。
     */
    async updateWorkspace(newWorkspace: string) {
        try {
            logger.info(`changing workspace to ${newWorkspace}`);
            this.workspace = newWorkspace;

            const platform = getPlatform();
            if (platform instanceof CliPlatform) {
                platform.setWorkspace(newWorkspace);
            }

            // 重新加载新工作空间的 AGENTS.md
            onWorkspaceChanged(newWorkspace);

            this.rebuildBanner();
            this.inputArea.refreshAutocomplete();

            const mode = this._activeMode;
            for (const task of this.taskManagerState.tasks) {
                if (task.parent_id !== null) continue;
                const savedEnv = task.harnessContext.environ;
                const savedPrompt = task.harnessContext.permissionPrompt;
                try {
                    const ctx = await HarnessContext.createForMode(newWorkspace, mode);
                    ctx.environ = savedEnv;
                    ctx.permissionPrompt = savedPrompt;
                    await ctx.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id, false));
                    task.harnessContext = ctx;
                } catch (err) {
                    logger.warn(`Failed to sync task harness for new workspace: ${err}`);
                    task.harnessContext.workspace = newWorkspace;
                }
            }

            // 刷新当前活跃任务的 system prompt 以包含新 AGENTS.md 内容
            await this.refreshActiveTaskSystemPrompt();
        } catch {
            logger.error(`failed to change workspace to ${newWorkspace}`);
        }
    }

    /**
     * 重建 Banner（工作空间路径变化后刷新顶部显示）
     */
    private rebuildBanner() {
        const children = this.container.children;
        if (children.length > 0 && children[0] instanceof OpenDeskBanner) {
            children[0] = new OpenDeskBanner(this.workspace);
        }
        this.tui.requestRender(true);
    }

    start() {
        // Ctrl+Backspace 默认未绑定到任何删除操作，导致按下后无反应。
        // 某些终端（尤其 Windows）的普通 Backspace 也发送 0x08（与 Ctrl+Backspace 相同字节），
        // 同样会导致删除失效。将 ctrl+backspace 加入 deleteCharBackward 使其与普通 Backspace 行为一致。
        setEditorKeybindings(
            new EditorKeybindingsManager({
                deleteCharBackward: ['backspace', 'ctrl+backspace']
            })
        );

        this.tui.start();

        // Attach a direct input listener to TUI FIRST, to hijack Ctrl+C before Editor gets it!
        this.tui.addInputListener((data) => {
            if (
                !isKeyRelease(data) &&
                !this.hasOpenOverlay &&
                !this.configComponent &&
                !this.inputArea.hasPromptWidget()
            ) {
                const shortcuts = getShortcuts();

                // 模式切换
                if (matchesKey(data, shortcuts.switch_mode)) {
                    this.cycleMode();
                    return { consume: true };
                }

                // 模型切换
                if (matchesKey(data, shortcuts.switch_model)) {
                    this.cycleModel();
                    return { consume: true };
                }

                // 回车换行：向编辑器注入换行符
                if (matchesKey(data, shortcuts.endline)) {
                    return { data: '\n' };
                }

                // 打开帮助
                if (matchesKey(data, shortcuts.show_help)) {
                    new HelpOverlay(this).show();
                    return { consume: true };
                }

                // 显示任务列表
                if (matchesKey(data, shortcuts.list_tasks)) {
                    const switcher = new TaskSwitcher(this);
                    switcher.show();
                    return { consume: true };
                }

                // 删除输入内容
                if (matchesKey(data, shortcuts.clear_input)) {
                    (this.inputArea.input as any).cancelAutocomplete();
                    const currentText = this.inputArea.input.getText();
                    if (currentText.trim() === '') {
                        const info = new InfoOverlay(this, {
                            title: t('exit.hint.title'),
                            message: t('exit.hint.message'),
                            closeLabel: t('common.close')
                        });
                        info.show();
                    } else {
                        this.inputArea.input.setText('');
                    }
                    this.tui.requestRender(true);
                    return { consume: true };
                }
            }

            // Ctrl+C 在配置模式或 overlay 下的特殊处理
            if (matchesKey(data, Key.ctrl('c'))) {
                if (this.hasOpenOverlay) {
                    return undefined;
                }
                if (this.configComponent) {
                    return { consume: true };
                }
            }

            // 内联结果面板交互：Esc 关闭，Ctrl+Up/Down 滚动
            const activePanel = this.inputArea.shellResultPanel.isVisible()
                ? this.inputArea.shellResultPanel
                : this.inputArea.btwResultPanel.isVisible()
                  ? this.inputArea.btwResultPanel
                  : null;
            if (activePanel) {
                if (matchesKey(data, Key.escape)) {
                    this.inputArea.dismissAllInlinePanels();
                    return { consume: true };
                }
                if (matchesKey(data, Key.ctrl('up'))) {
                    activePanel.scrollUp();
                    this.tui.requestRender();
                    return { consume: true };
                }
                if (matchesKey(data, Key.ctrl('down'))) {
                    activePanel.scrollDown();
                    this.tui.requestRender();
                    return { consume: true };
                }
            }

            return undefined;
        });

        this.shortcutManager.attach(this.tui);
        // 只有在没有设置加载错误时才设置焦点到输入框
        // 如果有错误，InfoOverlay 会保持焦点，关闭后 showModelNotConfiguredNotice 会设置焦点
        if (!Setting.getLoadError()) {
            this.tui.setFocus(this.inputArea.input);
        }
    }
}
