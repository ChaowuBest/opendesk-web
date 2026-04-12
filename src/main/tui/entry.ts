import {
    TUI,
    Box,
    Text,
    Key,
    matchesKey,
    type Component,
    EditorKeybindingsManager,
    setEditorKeybindings
} from '@mariozechner/pi-tui';
// FULL_CLEAR removed: use tui.requestRender(true) instead to avoid blank-frame flicker
import { OpenDeskBanner } from './banner';
import { VerticalLayout } from './components/layout';
import { OpenDeskTerminal } from './terminal';
import { TaskView, AssistantMessageView } from './components/taskview';
import { TaskManagerState, TaskState, TaskUpdateChunk } from '../aikernel/states/tasks';
import { GlobalState } from '../aikernel/states/global';
import { AgentInputArea } from './components/input';
import { ApplicationRegistry } from '../applications/registry';
import { KeyboardShortcutManager } from './shortcuts';
import { SlashCommandRegistry, registerAllCommands } from './commands/index.js';
import { Setting } from '../utils/setting.js';
import { logger, setDebugMode, getDebugMode } from '../utils/logger.js';
import { lookupKnownContextSize, fetchContextSizeFromAPI } from '../utils/model-context';
import { LLM } from '../aikernel/llm.js';
import { UpgradeOverlay } from './components/upgrade';
import { AgentDecl } from '../aikernel/agent.js';
import { MainAgentDecl } from '../aikernel/agents/mainagent.js';
import { HelpOverlay } from './components/help';
import { ConfirmOverlay, InfoOverlay, InfoPage } from './components/notice';
import { DashboardOverlay } from './components/dashboard';
import { LogPanel, LogPanelMode } from './components/logpanel';
import { TodoList } from './components/todolist';
import { TaskSwitcher } from './components/taskswitcher';
import { BookmarkList } from './components/bookmarklist';
import { ConfigMainPage } from './components/config/configMain';
import { getTaskTodosForDisplay } from '../aikernel/todos/task-todos';
import { exportTaskToHtml } from '../utils/export';
import { QuickPassHelper } from '../utils/quickpass';
import { describeCron } from '../utils/cron';
import { MemoryRegistry } from '../aikernel/memory/registry';
import { MemoryListOverlay } from './components/memorylist';
import { ChatContext, UserMessage, SystemMessage, AssistantMessage, type ChatMessage } from '../aikernel/messages';
import { createMemoryToolset } from '../aikernel/memory/tools';
import { NotificationStore, NotificationCenterOverlay, ToastManager } from './components/notification';
import { NotificationManager } from '../utils/notificationmgr.js';
import { SkillMgrApplication } from '../applications/skillmgr/app.js';
import { DashboardBar } from './components/dashboard';
import { HarnessContext } from '../aikernel/security/harness.js';
import { TUIPermissionPromptProvider } from './components/permission.js';
import { TaskProfiler } from '../aikernel/profiler.js';

import format from 'string-template';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import open from 'open';

const TODO_HANDLER_TEMPLATE = `
请执行以下全局待办事项：

- 待办事项ID: {todoId}
- 待办事项标题：{todoTitle}
- 待办事项触发方式：{todoTrigger}

待办事项内容
---

{todoContent}

注意事项
---
1. 这条消息是由待办事项管理器自动创建的，你的回复应当专注于完成用户在待办事项中指定的任务;
2. 待办事项的所有信息已经告诉你了，不需要尝试获取待办事项的更多信息，你也**不需要**将待办事项标记为已完成；
3. 如果周期型待办事项无法成功完成，你应当检查过往的执行历史，如果失败次数过多，应当提醒用户取消待办事项；
`;

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

    public activeTaskId?: string;

    /** 跟踪是否有 overlay 打开 */
    hasOpenOverlay = false;

    /** 当前激活的配置页面组件（非 null 时表示处于配置模式） */
    private configComponent?: Component;

    public workspace: string;
    private agentDecl: AgentDecl;
    public model?: string;

    /**
     * 如果在命令行中给了-c参数，就用singleShot模式执行，第一轮补全后就自动退出.
     * todo: 这个地方未来可以考虑用LLM来判断任务是不是已经完成了还是需要后续的互动 ;)
     */
    private singleShot?: boolean;
    private profilePath?: string;
    private allowEverything?: boolean;

    /** -c 模式下任务结束、退出前执行的钩子（如导出），按注册顺序执行 */
    private beforeExitHooks: Array<(taskId: string) => void | Promise<void>> = [];

    private memoryOpBusy = false;
    private memorySpinnerInterval?: ReturnType<typeof setInterval>;
    private static readonly SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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
        this.agentDecl = new MainAgentDecl({ workspace: args.workspace });

        const terminal = new OpenDeskTerminal();
        terminal.onResize((cols, rows) => {
            this.container.setMinLines(rows);
            this.tui.requestRender(true);
        });

        this.tui = new TUI(terminal);
        this.tui.setClearOnShrink(false);
        this.taskView = new TaskView(this.tui);
        this.logPanel = new LogPanel(this.tui);
        this.todoList = new TodoList();
        this.inputArea = new AgentInputArea(this);
        this.dashboardBar = new DashboardBar(() => this.tui.requestRender());
        this.workspace = args.workspace;
        this.model = args.model;
        this.singleShot = !!args.command;
        this.profilePath = args.profile;
        this.allowEverything = args.allowEverything;
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

        MemoryRegistry.getInstance(args.workspace);

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
                const scope = hasApplications ? '全部设置（含应用配置）' : '基础设置（不含应用配置）';
                const info = new InfoOverlay(this, {
                    title: '口令导入成功',
                    message: `已成功导入口令「${name}」\n导入范围：${scope}`,
                    closeLabel: '确定'
                });
                info.show(() => {
                    this.resolveModelInfo();
                });
            } catch (err: any) {
                const info = new InfoOverlay(this, {
                    title: '口令导入失败',
                    message: `${err?.message ?? err}`,
                    closeLabel: '确定'
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

        // 从已注册指令中提取快捷键
        this.shortcutManager = new KeyboardShortcutManager();
        for (const cmd of this.commandRegistry.getAll()) {
            if (cmd.shortcut) {
                this.shortcutManager.register({
                    key: cmd.shortcut,
                    handler: () => {
                        cmd.execute('');
                    }
                });
            }
        }

        // 设置触发器任务回调
        this.setupTriggerTaskHandler();

        // ── 全局通知系统初始化 ──
        this.toastManager = new ToastManager(this);
        this.toastManager.start();
        this.bridgeNotificationManager();

        // 立即解析模型信息，让状态栏一进去就能显示当前模型
        this.resolveModelInfo();
    }

    /**
     * 设置全局待办触发器的任务创建回调
     */
    private setupTriggerTaskHandler(): void {
        ApplicationRegistry.onTriggerTask = async (
            todoId: string,
            todoTitle: string,
            todoContent: string,
            trigger: any,
            deliver?: any
        ) => {
            try {
                const task = this.taskManagerState.createTask(this.model);
                const systemPrompt = await this.agentDecl.createSystemPrompt();
                task.setSystemPrompt(systemPrompt);
                await this.initTaskHarness(task);

                // 如果待办有 deliver 配置，设置任务的 origin，使其结果投递到对应 channel
                if (deliver) {
                    task.origin = deliver;
                    logger.info(
                        `触发器 deliver 已设置: channel=${deliver.channel}, accountId=${deliver.accountId}, recipientId=${deliver.recipientId}`
                    );
                }

                let triggerInfo = '';
                if (trigger?.type === 'event') {
                    triggerInfo = `[event] 事件驱动任务，由事件 ${trigger.bundleName}:${trigger.eventName} 自动触发 `;
                } else if (trigger?.type === 'scheduled') {
                    triggerInfo = `[scheduled] 定时任务，仅执行一次 `;
                } else if (trigger?.type === 'cron') {
                    triggerInfo = `[cron] 定时任务, 触发时机为 ${describeCron(trigger.cronExpression)} `;
                }

                logger.info(`触发器创建任务: ${todoId} -> task ${task.task_id}`);
                await task.submitUserMessage(
                    format(TODO_HANDLER_TEMPLATE, {
                        todoId: todoId,
                        todoTitle: todoTitle,
                        todoContent: todoContent,
                        todoTrigger: triggerInfo
                    })
                );

                // 如果有 origin，等待任务完成并发送最终回复
                if (task.origin) {
                    const { ApplicationRegistry } = await import('../applications/registry.js');
                    const channelMgr = ApplicationRegistry.getApplication('channelmgr') as any;

                    logger.info(`触发器任务等待完成: origin=${task.origin.channel}:${task.origin.accountId}`);

                    // 等待任务完成
                    await task.waitUntilFinished();
                    logger.info(`触发器任务已完成`);

                    // 提取最终回复：从消息历史中找到最后一条 assistant 文本
                    const texts: string[] = [];
                    for (let msgIdx = task.chat_context.messages.length - 1; msgIdx >= 0; msgIdx--) {
                        const msg = task.chat_context.messages[msgIdx];
                        if (!(msg instanceof AssistantMessage)) continue;

                        for (let partIdx = msg.content.length - 1; partIdx >= 0; partIdx--) {
                            const part = msg.content[partIdx];
                            if (part.type === 'text' && (part as any).text) {
                                texts.unshift((part as any).text);
                                break;
                            }
                        }
                        if (texts.length > 0) break;
                    }

                    const finalText = texts.join('\n').trim();

                    logger.info(`触发器任务最终回复: text_len=${finalText.length}`);
                    if (finalText && channelMgr?.sendTextToParticipant) {
                        await channelMgr.sendTextToParticipant(task.origin, finalText);
                        logger.info(`触发器任务最终回复已发送`);

                        // Register the task in the router's taskMap so user replies are routed to this task
                        const router = channelMgr.getRouter?.();
                        if (router) {
                            router.registerTaskForParticipant(task.task_id, task.origin, task.task_name);
                        } else {
                            logger.warn(`触发器任务: 无法获取 router，用户的回复将创建新任务`);
                        }
                    } else if (!finalText) {
                        logger.warn(`触发器任务: 没有找到可发送的文本回复`);
                    }
                }
            } catch (err) {
                logger.error(`触发器任务创建失败: ${err}`);
            }
        };
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
        });
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
            title: '导出成功',
            message: `会话已成功导出到：\n${absolutePath}`,
            closeLabel: '确定'
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
            this.tui,
            () => this.exitConfigMode(),
            () => {
                this.resolveModelInfo();
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
        const systemPrompt = await this.agentDecl.createSystemPrompt();
        task.setSystemPrompt(systemPrompt);
        await this.initTaskHarness(task);

        this.activeTaskId = task.task_id;
        this.taskView.taskState = task;
        this.taskView.clearMessages();
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
        this.inputArea.clearMessageQueue();
        this.inputArea.setStatus('idle');
        this.inputArea.statusBar.stopTimer();
        this.inputArea.statusBar.resetAccumulated();
        this.inputArea.statusBar.update({ totalTokens: 0 });
        this.tui.requestRender();
    }

    public async switchToTask(task: TaskState) {
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
        // 绑定到新任务的队列
        this.inputArea.bindToTaskQueue(task.task_id, task.message_queue);
        this.inputArea.statusBar.setAccumulatedMs(task.total_elapsed_ms);
        this.inputArea.statusBar.update({ totalTokens: 0 });

        // 为历史 ToolCall 挂载 toolsets 并解析 tool 引用，确保自定义渲染器正常工作
        await task.ensureToolsResolved();

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

    // ─── Memory operation management (used by commands/memory.ts) ──────────────────────

    public memoryAddStart = 0;

    /**
     * 尝试获取全局记忆操作锁。失败时弹出 InfoOverlay 提示。
     */
    public acquireMemoryLock(op: 'add' | 'search' | 'forget'): boolean {
        const registry = MemoryRegistry.getInstance();
        if (!registry.acquireLock(op)) {
            const labels = { add: '添加', search: '搜索', forget: '删除' };
            const currentOp = labels[registry.busyOp!] ?? registry.busyOp;
            this.showMemoryResult('操作被忽略', `当前有记忆${currentOp}操作正在进行中，请等待完成后再试。`);
            return false;
        }
        return true;
    }

    public releaseMemoryLock() {
        MemoryRegistry.getInstance().releaseLock();
    }

    /**
     * 启动普通记忆操作 spinner（search/forget 用，静态文字 + 旋转图标）
     */
    public startMemorySpinner(message: string) {
        this.memoryOpBusy = true;
        let frame = 0;
        const frames = OpenDeskTUI.SPINNER_FRAMES;
        this.inputArea.setExternalHint(chalk.cyan(`${frames[0]} ${message}`));
        this.memorySpinnerInterval = setInterval(() => {
            frame = (frame + 1) % frames.length;
            this.inputArea.setExternalHint(chalk.cyan(`${frames[frame]} ${message}`));
            this.tui.requestRender();
        }, 80);
    }

    /**
     * 启动 /memory add 专用 spinner（动态更新耗时和条数）
     */
    public startMemoryAddSpinner() {
        this.memoryOpBusy = true;
        let frame = 0;
        const frames = OpenDeskTUI.SPINNER_FRAMES;
        this.memorySpinnerInterval = setInterval(() => {
            frame = (frame + 1) % frames.length;
            const elapsed = Math.floor((Date.now() - this.memoryAddStart) / 1000);
            const count = MemoryRegistry.getInstance().opCounter;
            this.inputArea.setExternalHint(
                chalk.cyan(`${frames[frame]} 正在后台提取记忆... ${elapsed}s · 已提取 ${count} 条`)
            );
            this.tui.requestRender();
        }, 200);
    }

    public stopMemorySpinner() {
        if (this.memorySpinnerInterval) {
            clearInterval(this.memorySpinnerInterval);
            this.memorySpinnerInterval = undefined;
        }
        this.memoryOpBusy = false;
        this.inputArea.clearExternalHint();
    }

    public showMemoryResult(title: string, message: string, onClose?: () => void) {
        const info = new InfoOverlay(this, { title, message });
        info.show(onClose);
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
                for (const p of msg.content) {
                    if (p.type === 'text' && p.text) {
                        const text =
                            p.text.length > OpenDeskTUI.MAX_MSG_CHARS
                                ? p.text.slice(0, OpenDeskTUI.MAX_MSG_CHARS) + '...(已截断)'
                                : p.text;
                        parts.push(`[用户]: ${text}`);
                    }
                }
            } else if (msg instanceof AssistantMessage) {
                for (const p of msg.content) {
                    if (p.type === 'text' && (p as any).text) {
                        const text =
                            (p as any).text.length > OpenDeskTUI.MAX_MSG_CHARS
                                ? (p as any).text.slice(0, OpenDeskTUI.MAX_MSG_CHARS) + '...(已截断)'
                                : (p as any).text;
                        parts.push(`[助手]: ${text}`);
                    }
                    // 工具调用只保留名称，丢弃输出
                    if (p.type === 'tool_call') {
                        for (const tc of p.toolcalls) {
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

        const worker = ApplicationRegistry.globalWorker;
        if (worker) {
            await worker.terminate();
        }
        process.exit(0);
    }

    async onRequestSubmit(request: string) {
        if (this.taskView.taskState === undefined) {
            this.taskView.taskState = this.taskManagerState.createTask(this.model);
            const systemPrompt = await this.agentDecl.createSystemPrompt();
            this.taskView.taskState.setSystemPrompt(systemPrompt);
            await this.initTaskHarness(this.taskView.taskState);

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
        try {
            const setting = Setting.getInstance();
            const data = setting.getData() as any;
            const aliasToUse = this.model || data.default_model;

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

            const effortLabels: Record<string, string> = {
                none: '无推理',
                low: '简洁推理',
                medium: '推理适中',
                high: '推理深入'
            };
            const effortTag = modelCfg?.reasoning_effort
                ? ` [${effortLabels[modelCfg.reasoning_effort] || modelCfg.reasoning_effort}]`
                : '';

            this.inputArea.statusBar.update({ modelName: `${aliasToUse}${effortTag}` });

            // 如果没有通过命令行指定模型，则更新当前活跃任务的模型为新的默认模型
            // 这样用户在 /config 中修改模型后，继续对话时会使用新模型
            if (!this.model && this.activeTaskId) {
                const currentTask = this.taskManagerState.getTask(this.activeTaskId);
                if (currentTask) {
                    currentTask.model = data.default_model;
                }
            }

            // 先用内置表即时填充，再异步 API 覆盖
            const knownSize = lookupKnownContextSize(modelName);
            if (knownSize > 0) {
                this.inputArea.statusBar.update({ contextSize: knownSize });
            }

            const modelInstance = setting.getDefaultModelInstance();
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

            LLM.supportsVision(this.model)
                .then((vision) => {
                    const suffix = vision ? ' 📷' : '';
                    this.inputArea.statusBar.update({ modelName: `${aliasToUse}${effortTag}${suffix}` });
                })
                .catch(() => {});
        } catch {
            /* 配置读取失败不影响主流程 */
        }
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
            chalk.bold.yellow('⚠️  模型未配置'),
            '',
            chalk.dim('请先配置模型才能使用 OpenDesk'),
            '',
            chalk.cyan('使用方法：'),
            '',
            chalk.white('  1. 输入 /config 打开配置菜单'),
            chalk.white('  2. 选择"模型服务商配置"并添加一个模型模型服务商'),
            chalk.white('  3. 选择"模型配置"并添加一个模型'),
            chalk.white('  4. 选择 "默认模型配置", 并选择你要使用的模型'),
            chalk.white('  5. (可选) 选择 "文件扫描配置", 添加文件搜索目录'),
            '',
            chalk.dim('然后? 你可以休息了，让我开始工作吧!')
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

    /**
     * 为新创建的任务初始化 harnessContext（权限引擎 + 环境变量 + 权限确认 UI）
     */
    private async initTaskHarness(task: TaskState): Promise<void> {
        try {
            if (this.allowEverything) {
                task.harnessContext = HarnessContext.createAllowEverything(this.workspace);
            } else {
                task.harnessContext = await HarnessContext.createWithDefaults(this.workspace);
            }
            task.harnessContext.permissionPrompt = new TUIPermissionPromptProvider(this);
        } catch (err) {
            logger.warn(`Failed to init task harness, using empty context: ${err}`);
            task.harnessContext = HarnessContext.createEmpty();
        }
    }

    /**
     * 更新工作空间目录，同步刷新 Banner、process.cwd、自动补全 basePath。
     */
    updateWorkspace(newWorkspace: string) {
        try {
            logger.info(`changing workspace to ${newWorkspace}`);
            this.workspace = newWorkspace;
            this.rebuildBanner();
            this.inputArea.refreshAutocomplete();
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

            if (matchesKey(data, Key.ctrl('c'))) {
                // 有 overlay 打开时不处理
                if (this.hasOpenOverlay) {
                    return undefined; // 不消费，让 overlay 处理
                }

                // 配置模式下静默消费，不干扰配置页面
                if (this.configComponent) {
                    return { consume: true };
                }

                // 首先，取消自动补全（如果正在显示）
                (this.inputArea.input as any).cancelAutocomplete();

                // 检查输入框是否有内容
                const currentText = this.inputArea.input.getText();
                if (currentText.trim() === '') {
                    // 输入框为空，显示提示
                    const info = new InfoOverlay(this, {
                        title: '提示',
                        message: '你可以输入 /exit 退出或者输入 /help 查看帮助',
                        closeLabel: '确定'
                    });
                    info.show();
                } else {
                    // 清空输入框
                    this.inputArea.input.setText('');
                }

                // 强制重新渲染
                this.tui.requestRender(true);

                return { consume: true }; // 完全消费掉，不传给 Editor！
            }
            return undefined;
        });

        this.shortcutManager.attach(this.tui);
        this.tui.setFocus(this.inputArea.input);
    }
}
