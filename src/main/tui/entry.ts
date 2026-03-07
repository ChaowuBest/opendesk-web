import { TUI, Box, Text, Key, matchesKey, type Component } from "@mariozechner/pi-tui";
import { FULL_CLEAR } from './components/constants';
import { OpenDeskBanner } from './banner';
import { VerticalLayout } from './components/layout';
import { OpenDeskTerminal } from './terminal';
import { TaskView } from "./components/taskview";
import { TaskManagerState, TaskState, TaskUpdateChunk } from "../states/tasks";
import { GlobalState } from "../states/global";
import { AgentInputArea } from "./components/input";
import { ApplicationRegistry } from "../applications/registry";
import { KeyboardShortcutManager } from "./shortcuts";
import { SlashCommandRegistry } from "./commands";
import { Setting } from "../utils/setting.js";
import { logger, setDebugMode, getDebugMode } from "../utils/logger.js";
import { lookupKnownContextSize, fetchContextSizeFromAPI } from "../utils/model-context";
import { UpgradeOverlay } from "./components/upgrade";
import { AgentDecl } from "../aikernel/agent.js";
import { ShellAgentDecl } from "../aikernel/agents/shellagent.js";
import { HelpOverlay } from "./components/help";
import { ConfirmOverlay, InfoOverlay } from "./components/notice";
import { DashboardOverlay } from "./components/dashboard";
import { LogPanel, LogPanelMode } from "./components/logpanel";
import { TodoList } from "./components/todolist";
import { TaskSwitcher } from "./components/taskswitcher";
import { BookmarkList } from "./components/bookmarklist";
import { ConfigMainPage } from "./components/config/configMain";
import { getTaskTodosForDisplay } from "../applications/todomgr/tools";
import { exportTaskToHtml } from "../utils/export";
import { QuickPassHelper } from "../utils/quickpass";
import { describeCron } from "../utils/cron";
import { MemoryRegistry } from "../aikernel/memory/registry";
import { MemoryListOverlay } from "./components/memorylist";
import { ChatContext, UserMessage, SystemMessage, AssistantMessage } from "../aikernel/messages";
import { createMemoryToolset } from "../aikernel/memory/tools";

import format from "string-template";
import path from "path";
import fs from "fs";
import chalk from "chalk";
import { fileURLToPath } from "url";
import open from "open";


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
}

export class OpenDeskTUI {

    public taskManagerState: TaskManagerState;

    public tui: TUI;
    private container: VerticalLayout = new VerticalLayout({
        spacing: 1,
        padding: { left: 1, right: 1 }
    });
    private taskView: TaskView;
    private logPanel: LogPanel;
    private todoList: TodoList;
    public inputArea: AgentInputArea;

    private shortcutManager: KeyboardShortcutManager;
    public commandRegistry: SlashCommandRegistry;

    private activeTaskId?: string;

    /** 跟踪是否有 overlay 打开 */
    hasOpenOverlay = false;

    /** 当前激活的配置页面组件（非 null 时表示处于配置模式） */
    private configComponent?: Component;

    private workspace: string;
    private agentDecl: AgentDecl;
    private model?: string;

    /**
     * 如果在命令行中给了-c参数，就用singleShot模式执行，第一轮补全后就自动退出.
     * todo: 这个地方未来可以考虑用LLM来判断任务是不是已经完成了还是需要后续的互动 ;)
     */
    private singleShot?: boolean;

    private memoryOpBusy = false;
    private memorySpinnerInterval?: ReturnType<typeof setInterval>;
    private static readonly SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

    constructor(args: CommandLineArgs) {
        this.taskManagerState = GlobalState.getInstance().taskManagerState;
        this.agentDecl = new ShellAgentDecl({ workspace: args.workspace });

        const terminal = new OpenDeskTerminal();
        terminal.onResize((cols, rows) => {
            this.container.setMinLines(rows);
            this.tui.requestRender(true);
        });

        this.tui = new TUI(terminal);
        this.taskView = new TaskView(this.tui);
        this.logPanel = new LogPanel(this.tui);
        this.todoList = new TodoList();
        this.inputArea = new AgentInputArea(this);
        this.workspace = args.workspace;
        this.model = args.model;
        this.singleShot = !!args.command;

        MemoryRegistry.getInstance(args.workspace);

        this.tui.addChild(this.container);
        this.container.addChild(new OpenDeskBanner(this.workspace));
        this.container.addChild(this.taskView);
        this.container.addChild(this.todoList);
        this.container.addChild(this.inputArea)
        this.container.setMinLines(this.tui.terminal.rows);
        this.container.setVerticalAlign("center");

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
                    title: "口令导入成功",
                    message: `已成功导入口令「${name}」\n导入范围：${scope}`,
                    closeLabel: "确定",
                });
                info.show(() => {
                    this.resolveModelInfo();
                });
            } catch (err: any) {
                const info = new InfoOverlay(this, {
                    title: "口令导入失败",
                    message: `${err?.message ?? err}`,
                    closeLabel: "确定",
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

        // StatusBar: 只接受当前活跃任务的 token 数据
        this.taskView.onStatusBarUpdate = (data) => {
            if (this.taskView.taskState &&
                this.activeTaskId === this.taskView.taskState.task_id) {
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
                    handler: () => { cmd.execute(''); },
                });
            }
        }

        // 设置触发器任务回调
        this.setupTriggerTaskHandler();

        // 立即解析模型信息，让状态栏一进去就能显示当前模型
        this.resolveModelInfo();
    }

    /**
     * 设置全局待办触发器的任务创建回调
     */
    private setupTriggerTaskHandler(): void {
        ApplicationRegistry.onTriggerTask = async (todoId: string, todoTitle: string, todoContent: string, trigger: any) => {
            try {
                const task = this.taskManagerState.createTask(this.model);
                const systemPrompt = await this.agentDecl.createSystemPrompt();
                await task.setSystemPrompt(systemPrompt);

                let triggerInfo = '';
                if (trigger?.type === 'event') {
                    triggerInfo = `[event] 事件驱动任务，由事件 ${trigger.bundleName}:${trigger.eventName} 自动触发 `;
                } else if (trigger?.type === 'scheduled') {
                    triggerInfo = `[scheduled] 定时任务，仅执行一次 `;
                } else if (trigger?.type === 'cron') {
                    triggerInfo = `[cron] 定时任务, 触发时机为 ${describeCron(trigger.cronExpression)} `;
                }

                logger.info(`触发器创建任务: ${todoId} -> task ${task.task_id}`);
                await task.submitUserMessage(format(TODO_HANDLER_TEMPLATE, {
                    todoId: todoId,
                    todoTitle: todoTitle,
                    todoContent: todoContent,
                    todoTrigger: triggerInfo
                }));
            } catch (err) {
                logger.error(`触发器任务创建失败: ${err}`);
            }
        };
    }

    private setupCommands() {
        this.commandRegistry.register({
            name: "new",
            description: "启动新任务并发送消息",
            shortcut: Key.ctrl("n"),
            execute: async (args: string) => {
                await this.createNewTask();
                if (args.trim()) {
                    await this.onRequestSubmit(args.trim());
                }
            },
        });

        this.commandRegistry.register({
            name: "switch",
            description: "切换到其他任务",
            shortcut: Key.ctrl("l"),
            execute: async () => { this.showTaskSwitcher(); },
        });

        this.commandRegistry.register({
            name: "help",
            description: "显示快捷键与指令帮助",
            execute: async () => {
                new HelpOverlay(this).show();
            },
        });

        this.commandRegistry.register({
            name: "exit",
            description: "退出 OpenDesk",
            execute: async () => {
                const confirm = new ConfirmOverlay(this, {
                    title: "确认退出",
                    message: "确定要退出 OpenDesk 吗？",
                    confirmLabel: "退出",
                    cancelLabel: "取消"
                });
                confirm.show(async () => {
                    await this.exit();
                });
            },
        });

        this.commandRegistry.register({
            name: "quit",
            description: "退出 OpenDesk",
            execute: async () => {
                const confirm = new ConfirmOverlay(this, {
                    title: "确认退出",
                    message: "确定要退出 OpenDesk 吗？",
                    confirmLabel: "退出",
                    cancelLabel: "取消"
                });
                confirm.show(async () => {
                    await this.exit();
                });
            },
        });

        this.commandRegistry.register({
            name: "manual",
            description: "打开使用手册",
            execute: async () => {
                // 获取 manual.html 的路径
                // 开发环境: 项目根目录/docs/manual.html
                // 生产环境: 与 opendesk 可执行文件同目录的 manual.html
                const __filename = fileURLToPath(import.meta.url);
                const __dirname = path.dirname(__filename);

                // 尝试多个可能的路径
                const possiblePaths = [
                    // 生产环境: 与可执行文件同目录
                    path.join(__dirname, 'manual.html'),
                    // 开发环境: 从 dist/cli/opendesk-debug 向上找到项目根目录
                    path.join(__dirname, '..', '..', '..', 'docs', 'manual.html'),
                    // 开发环境: 从 dist/main/main.js 向上找到项目根目录
                    path.join(__dirname, '..', '..', 'docs', 'manual.html'),
                ];

                let manualPath: string | null = null;
                for (const p of possiblePaths) {
                    if (fs.existsSync(p)) {
                        manualPath = p;
                        break;
                    }
                }

                if (manualPath) {
                    try {
                        await open(manualPath);
                    } catch (err: any) {
                        const info = new InfoOverlay(this, {
                            title: "打开失败",
                            message: `无法打开手册: ${err?.message ?? err}`,
                            closeLabel: "确定"
                        });
                        info.show();
                    }
                } else {
                    const info = new InfoOverlay(this, {
                        title: "文件未找到",
                        message: "未找到 manual.html 文件",
                        closeLabel: "确定"
                    });
                    info.show();
                }
            },
        });

        this.commandRegistry.register({
            name: "cancel",
            description: "撤销消息队列中的所有待发送消息",
            execute: async () => {
                this.inputArea.clearMessageQueue();
                // 同时更新当前任务的队列
                if (this.activeTaskId) {
                    const currentTask = this.taskManagerState.getTask(this.activeTaskId);
                    if (currentTask) {
                        currentTask.message_queue = this.inputArea.getQueueSnapshot();
                    }
                }
            },
        });

        this.commandRegistry.register({
            name: "clear",
            description: "删除所有任务历史",
            execute: async () => {
                const confirm = new ConfirmOverlay(this, {
                    title: "确认删除",
                    message: "确定要删除所有任务历史吗？此操作不可恢复。",
                    confirmLabel: "删除所有",
                    cancelLabel: "取消"
                });
                confirm.show(() => {
                    // On confirm
                    this.taskManagerState.clearAllTasks();
                    // Reset the current task view
                    this.taskView.taskState = undefined;
                    this.taskView.clearMessages();
                    this.activeTaskId = undefined;
                    this.inputArea.clearMessageQueue();
                    this.inputArea.setStatus('idle');
                    this.inputArea.statusBar.stopTimer();
                    this.inputArea.statusBar.resetAccumulated();
                    this.inputArea.statusBar.update({ totalTokens: 0 });
                    this.tui.requestRender();
                });
            },
        });

        this.commandRegistry.register({
            name: "export",
            description: "导出当前会话为 HTML 文件，用法：/export filename.html",
            execute: async (args: string) => {
                if (!this.activeTaskId) {
                    logger.warn('No active task to export');
                    return;
                }

                const task = this.taskManagerState.getTask(this.activeTaskId);
                if (!task) {
                    logger.warn('Task not found');
                    return;
                }

                let filePath = args.trim();
                if (!filePath) {
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    filePath = `opendesk-session-${timestamp}.html`;
                    logger.info(`未指定文件名，将使用自动生成的文件名：${filePath}`);
                }

                if (!filePath.endsWith('.html')) {
                    filePath += '.html';
                }

                const absolutePath = path.resolve(this.workspace, filePath);

                // 检查文件是否存在
                if (fs.existsSync(absolutePath)) {
                    const confirm = new ConfirmOverlay(this, {
                        title: "文件已存在",
                        message: `文件 ${absolutePath} 已存在。是否覆盖？`,
                        confirmLabel: "覆盖",
                        cancelLabel: "取消"
                    });
                    confirm.show(async () => {
                        // 用户确认覆盖
                        await this.doExport(task, absolutePath);
                    });
                } else {
                    // 文件不存在，直接导出
                    await this.doExport(task, absolutePath);
                }
            },
        });

        this.commandRegistry.register({
            name: "dashboard",
            description: "查看系统仪表盘（任务、待办、状态）",
            execute: async () => {
                await this.showDashboard();
            },
        });

        this.commandRegistry.register({
            name: "config",
            description: "打开系统设置",
            execute: async () => {
                this.enterConfigMode();
            },
        });

        this.commandRegistry.register({
            name: "log",
            description: "显示日志面板，用法: /log [off|last|all]",
            getArgumentCompletions: (argPrefix: string) => {
                const options = ['off', 'last', 'all'];
                return options
                    .filter(opt => opt.startsWith(argPrefix.toLowerCase()))
                    .map(opt => ({ value: opt, label: opt, description: opt === 'off' ? '不显示' : (opt === 'last' ? '最后10条' : '全部') }));
            },
            execute: async (args: string) => {
                const modeArg = args.trim().toLowerCase();
                if (modeArg === 'off' || modeArg === 'last' || modeArg === 'all') {
                    this.logPanel.setMode(modeArg);
                } else {
                    // 默认不显示
                    this.logPanel.setMode('off');
                }
            },
        });

        this.commandRegistry.register({
            name: "debug",
            description: "调试模式开关，用法: /debug [on|off]",
            getArgumentCompletions: (argPrefix: string) => {
                const options = ['on', 'off'];
                return options
                    .filter(opt => opt.startsWith(argPrefix.toLowerCase()))
                    .map(opt => ({ value: opt, label: opt, description: opt === 'on' ? '开启调试模式' : '关闭调试模式' }));
            },
            execute: async (args: string) => {
                const modeArg = args.trim().toLowerCase();
                if (modeArg === 'on') {
                    setDebugMode(true);
                    logger.info('调试模式已开启');
                } else if (modeArg === 'off') {
                    setDebugMode(false);
                    logger.info('调试模式已关闭');
                } else {
                    // 显示当前状态
                    const currentMode = getDebugMode();
                    logger.info(`当前调试模式: ${currentMode ? 'on' : 'off'}`);
                }
            },
        });

        this.commandRegistry.register({
            name: "stop",
            description: "停止当前正在执行的任务",
            execute: async () => {
                if (!this.activeTaskId) {
                    logger.warn('没有活跃的任务');
                    return;
                }

                const currentTask = this.taskManagerState.getTask(this.activeTaskId);
                if (!currentTask) {
                    logger.warn('未找到当前任务');
                    return;
                }

                if (currentTask.task_status !== 'running') {
                    logger.warn('当前任务不在运行中');
                    return;
                }

                currentTask.stop();
                this.inputArea.statusBar.stopTimer();
                this.inputArea.setStatus('idle');
                this.inputArea.clearMessageQueue();
                logger.info('任务已停止');
                this.tui.requestRender();
            },
        });

        this.commandRegistry.register({
            name: "upgrade",
            description: "升级 OpenDesk CLI 到最新版本",
            execute: async () => {
                // 显示升级 overlay 界面，让用户选择 stable 或 nightly
                const upgradeOverlay = new UpgradeOverlay(this);
                upgradeOverlay.show();
            },
        });

        this.commandRegistry.register({
            name: "rename",
            description: "重命名当前任务，用法：/rename <新名称>",
            execute: async (args: string) => {
                if (!this.activeTaskId) {
                    logger.warn('没有活跃的任务');
                    return;
                }

                const currentTask = this.taskManagerState.getTask(this.activeTaskId);
                if (!currentTask) {
                    logger.warn('未找到当前任务');
                    return;
                }

                const newName = args.trim();
                if (!newName) {
                    logger.warn('请提供新的任务名称，用法：/rename <新名称>');
                    return;
                }

                currentTask.rename(newName);
                logger.info(`任务已重命名为: ${newName}`);
                this.tui.requestRender();
            },
        });

        this.commandRegistry.register({
            name: "fork",
            description: "复制当前会话并切换到新会话",
            execute: async () => {
                if (!this.activeTaskId) {
                    const info = new InfoOverlay(this, {
                        title: "Fork 失败",
                        message: "没有活跃的任务",
                        closeLabel: "确定"
                    });
                    info.show();
                    return;
                }

                const currentTask = this.taskManagerState.getTask(this.activeTaskId);
                if (!currentTask) {
                    const info = new InfoOverlay(this, {
                        title: "Fork 失败",
                        message: "未找到当前任务",
                        closeLabel: "确定"
                    });
                    info.show();
                    return;
                }

                // Fork the current task
                const forkedTask = currentTask.fork();

                // Switch to the forked task
                this.switchToTask(forkedTask);

                // Show info notification
                const info = new InfoOverlay(this, {
                    title: "Fork 成功",
                    message: `已切换到新的会话副本`,
                    closeLabel: "确定"
                });
                info.show();
            },
        });

        this.commandRegistry.register({
            name: "compact",
            description: "手动压缩当前任务的上下文",
            execute: async () => {
                if (this.taskView.isCompacting) {
                    return;
                }

                if (!this.activeTaskId) {
                    logger.warn('没有活跃的任务');
                    return;
                }

                const currentTask = this.taskManagerState.getTask(this.activeTaskId);
                if (!currentTask) {
                    logger.warn('未找到当前任务');
                    return;
                }

                try {
                    await this.taskView.performCompactWithAnimation();
                    this.taskManagerState.save();

                    // 重建视图，让分隔线正确显示
                    this.taskView.clearMessages();
                    this.taskView.rebuildFromHistory();
                    this.tui.requestRender();

                    const info = new InfoOverlay(this, {
                        title: "上下文压缩",
                        message: "上下文已成功压缩。压缩效果将在下次对话时体现。",
                        closeLabel: "确定"
                    });
                    info.show();
                } catch (err: any) {
                    logger.error(`上下文压缩失败: ${err?.message ?? err}`);
                    const info = new InfoOverlay(this, {
                        title: "压缩失败",
                        message: `上下文压缩过程中发生错误：${err?.message ?? err}`,
                        closeLabel: "确定"
                    });
                    info.show();
                }
            },
        });

        this.commandRegistry.register({
            name: "memory",
            description: "记忆管理：/memory add [提示]、/memory search <查询>、/memory forget <描述>、/memory list",
            getArgumentCompletions: (argPrefix: string) => {
                const options = ['add', 'search', 'forget', 'list'];
                const parts = argPrefix.split(/\s+/);
                if (parts.length <= 1) {
                    return options
                        .filter(opt => opt.startsWith((parts[0] || '').toLowerCase()))
                        .map(opt => ({
                            value: opt,
                            label: opt,
                            description: opt === 'add' ? '添加记忆' :
                                        opt === 'search' ? '搜索记忆' :
                                        opt === 'forget' ? '删除记忆' :
                                        '列出所有记忆',
                        }));
                }
                return null;
            },
            execute: async (args: string) => {
                const parts = args.trim().split(/\s+/);
                const subCommand = (parts[0] || '').toLowerCase();
                const restArgs = parts.slice(1).join(' ').trim();

                if (subCommand === 'add') {
                    await this.handleMemoryAdd(restArgs);
                } else if (subCommand === 'search') {
                    if (!restArgs) {
                        logger.warn('用法：/memory search <查询关键词>');
                        return;
                    }
                    await this.handleMemorySearch(restArgs);
                } else if (subCommand === 'forget') {
                    if (!restArgs) {
                        logger.warn('用法：/memory forget <描述要删除的记忆>');
                        return;
                    }
                    await this.handleMemoryForget(restArgs);
                } else if (subCommand === 'list') {
                    this.handleMemoryList();
                } else {
                    logger.warn('用法：/memory add [提示] | /memory search <查询> | /memory forget <描述> | /memory list');
                }
            },
        });

        this.commandRegistry.register({
            name: "bookmark",
            description: "管理任务书签，用法：/bookmark add|list|remove",
            getArgumentCompletions: (argPrefix: string) => {
                const options = ['add', 'list', 'remove'];
                return options
                    .filter(opt => opt.startsWith(argPrefix.toLowerCase()))
                    .map(opt => ({
                        value: opt,
                        label: opt,
                        description: opt === 'add' ? '将当前任务添加到书签' :
                                    opt === 'list' ? '列出所有书签任务' :
                                    '移除当前任务的书签'
                    }));
            },
            execute: async (args: string) => {
                const subCommand = args.trim().toLowerCase();

                if (subCommand === 'list') {
                    // 显示书签列表
                    const bookmarkList = new BookmarkList(this);
                    bookmarkList.show();
                    return;
                }

                if (subCommand === 'add') {
                    // 添加当前任务到书签
                    if (!this.activeTaskId) {
                        const info = new InfoOverlay(this, {
                            title: "添加书签失败",
                            message: "没有活跃的任务",
                            closeLabel: "确定"
                        });
                        info.show();
                        return;
                    }

                    const currentTask = this.taskManagerState.getTask(this.activeTaskId);
                    if (!currentTask) {
                        const info = new InfoOverlay(this, {
                            title: "添加书签失败",
                            message: "未找到当前任务",
                            closeLabel: "确定"
                        });
                        info.show();
                        return;
                    }

                    if (currentTask.bookmark_path) {
                        const info = new InfoOverlay(this, {
                            title: "添加书签失败",
                            message: "当前任务已在书签中",
                            closeLabel: "确定"
                        });
                        info.show();
                        return;
                    }

                    currentTask.setBookmark('/');
                    const info = new InfoOverlay(this, {
                        title: "添加书签成功",
                        message: `任务"${currentTask.task_name || '未命名任务'}"已添加到书签`,
                        closeLabel: "确定"
                    });
                    info.show();
                    return;
                }

                if (subCommand === 'remove') {
                    // 移除当前任务的书签
                    if (!this.activeTaskId) {
                        const info = new InfoOverlay(this, {
                            title: "移除书签失败",
                            message: "没有活跃的任务",
                            closeLabel: "确定"
                        });
                        info.show();
                        return;
                    }

                    const currentTask = this.taskManagerState.getTask(this.activeTaskId);
                    if (!currentTask) {
                        const info = new InfoOverlay(this, {
                            title: "移除书签失败",
                            message: "未找到当前任务",
                            closeLabel: "确定"
                        });
                        info.show();
                        return;
                    }

                    if (!currentTask.bookmark_path) {
                        const info = new InfoOverlay(this, {
                            title: "移除书签失败",
                            message: "当前任务不在书签中",
                            closeLabel: "确定"
                        });
                        info.show();
                        return;
                    }

                    const taskName = currentTask.task_name || '未命名任务';
                    currentTask.removeBookmark();
                    const info = new InfoOverlay(this, {
                        title: "移除书签成功",
                        message: `任务"${taskName}"已从书签中移除`,
                        closeLabel: "确定"
                    });
                    info.show();
                    return;
                }

                // 未提供子命令或子命令无效
                logger.warn('用法：/bookmark add|list|remove');
            },
        });

        this.commandRegistry.register({
            name: "quickpass",
            description: "导出快捷口令，用法：/quickpass config base|all",
            getArgumentCompletions: (argPrefix: string) => {
                const options = [
                    { value: 'config base', label: 'config base', description: '导出基础设置口令（不含应用配置）' },
                    { value: 'config all', label: 'config all', description: '导出全部设置口令' },
                ];
                const prefix = argPrefix.trimEnd().toLowerCase();
                return options.filter(opt => opt.value.startsWith(prefix));
            },
            execute: async (args: string) => {
                const parts = args.trim().split(/\s+/);
                const subCommand = (parts[0] || '').toLowerCase();
                const subArg = (parts[1] || '').toLowerCase();

                if (subCommand === 'config') {
                    if (subArg === 'base') {
                        try {
                            const quickpass = QuickPassHelper.exportBaseConfig();
                            const info = new InfoOverlay(this, {
                                title: "基础设置口令",
                                message: `请复制以下口令并发送给对方：\n\n${quickpass}`,
                                closeLabel: "确定",
                                fullWidth: true,
                            });
                            info.show();
                        } catch (err: any) {
                            const info = new InfoOverlay(this, {
                                title: "导出失败",
                                message: `导出基础设置口令失败：${err?.message ?? err}`,
                            });
                            info.show();
                        }
                    } else if (subArg === 'all') {
                        try {
                            const quickpass = QuickPassHelper.exportAllConfig();
                            const info = new InfoOverlay(this, {
                                title: "全部设置口令",
                                message: `请复制以下口令并发送给对方：\n\n${quickpass}`,
                                closeLabel: "确定",
                                fullWidth: true,
                            });
                            info.show();
                        } catch (err: any) {
                            const info = new InfoOverlay(this, {
                                title: "导出失败",
                                message: `导出全部设置口令失败：${err?.message ?? err}`,
                            });
                            info.show();
                        }
                    } else {
                        logger.warn('用法：/quickpass config base|all');
                    }
                } else {
                    logger.warn('用法：/quickpass config base|all');
                }
            },
        });

        // 使用 onReady 回调确保应用注册表初始化完成后再注册命令
        ApplicationRegistry.onReady(() => {
            this.registerApplicationCommands();
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
    }

    private async showDashboard() {
        try {
            // 从 worker 获取全局待办数据
            const todosResult = await ApplicationRegistry.callWorker('todomgr', 'listGlobalTodos', 'all');
            const todos = todosResult?.data || [];
            const tasks = this.taskManagerState.tasks;

            // 直接获取当前已有的消息插件状态，不阻塞等待初始化完成
            let channelStates: any[] = [];
            const channelsApp = ApplicationRegistry.getApplication('channelmgr');
            if (channelsApp && 'getChannelStates' in channelsApp) {
                channelStates = (channelsApp as any).getChannelStates();
            }

            new DashboardOverlay(this, { globalTodos: todos, tasks, channelStates }).show();
        } catch (err) {
            logger.error(`打开仪表盘失败: ${err}`);
        }
    }

    private async doExport(task: any, absolutePath: string) {
        await exportTaskToHtml(task, absolutePath);
        logger.info(`Session exported to: ${absolutePath}`);

        const info = new InfoOverlay(this, {
            title: "导出成功",
            message: `会话已成功导出到：\n${absolutePath}`,
            closeLabel: "确定"
        });
        info.show();
    }

    /**
     * 根据日志面板模式更新 VerticalLayout 的子组件排列
     */
    private updateLayoutForLogMode(mode: LogPanelMode) {
        // 先清空容器，然后按照所需顺序重新添加
        this.container.clear();

        this.container.addChild(new OpenDeskBanner(this.workspace));

        if (mode === 'all') {
            // 全部模式：只显示日志面板，隐藏 TaskView 和 TodoList
            this.container.addChild(this.logPanel);
        } else if (mode === 'last') {
            // 最后 10 条模式：在 TaskView 和 Input 中间显示日志面板
            this.container.addChild(this.taskView);
            this.container.addChild(this.todoList);
            this.container.addChild(this.logPanel);
        } else {
            // off 模式：不显示日志面板，恢复默认布局
            this.container.addChild(this.taskView);
            this.container.addChild(this.todoList);
        }

        this.container.addChild(this.inputArea);
        this.container.setMinLines(this.tui.terminal.rows);

        this.tui.requestRender();
    }

    private enterConfigMode() {
        this.configComponent = new ConfigMainPage(this.tui, () => this.exitConfigMode(), () => {
            this.resolveModelInfo();
        });
        this.shortcutManager.detach();

        this.container.clear();
        this.container.addChild(new OpenDeskBanner(this.workspace));
        this.container.addChild(this.configComponent);
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
                // 模型仍未配置，重新显示提示
                this.container.clear();
                this.container.addChild(new OpenDeskBanner(this.workspace));
                this.container.addChild(this.modelNotConfiguredNotice!);
                this.container.addChild(this.inputArea);
                this.container.setMinLines(this.tui.terminal.rows);
                this.tui.requestRender();
                // 延迟设置焦点
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
        this.container.setMinLines(this.tui.terminal.rows);
        this.tui.requestRender();
        // 延迟设置焦点
        setTimeout(() => {
            this.tui.setFocus(this.inputArea.input);
            this.tui.requestRender();
        }, 10);
    }

    private async createNewTask() {
        // 先清屏，防止旧内容残留
        process.stdout.write(FULL_CLEAR);

        // 保存当前任务的队列（如果有）
        if (this.activeTaskId) {
            const currentTask = this.taskManagerState.getTask(this.activeTaskId);
            if (currentTask) {
                currentTask.message_queue = this.inputArea.getQueueSnapshot();
            }
        }

        const task = this.taskManagerState.createTask(this.model);
        const systemPrompt = await this.agentDecl.createSystemPrompt();
        await task.setSystemPrompt(systemPrompt);
        this.activeTaskId = task.task_id;
        this.taskView.taskState = task;
        this.taskView.clearMessages();
        // 绑定到新任务的队列（应该是空的）
        this.inputArea.bindToTaskQueue(task.task_id, task.message_queue);
        this.inputArea.setStatus('idle');
        this.inputArea.statusBar.stopTimer();
        this.inputArea.statusBar.resetAccumulated();
        this.inputArea.statusBar.update({ totalTokens: 0 });
        this.tui.requestRender();
    }

    private showTaskSwitcher() {
        const switcher = new TaskSwitcher(this);
        switcher.show();
    }


    public switchToTask(task: TaskState) {
        // 先清屏，防止旧内容残留
        process.stdout.write(FULL_CLEAR);

        // 保存当前任务的队列（如果有）
        if (this.activeTaskId) {
            const currentTask = this.taskManagerState.getTask(this.activeTaskId);
            if (currentTask) {
                currentTask.message_queue = this.inputArea.getQueueSnapshot();
            }
        }

        this.activeTaskId = task.task_id;
        this.taskView.taskState = task;
        this.taskView.clearMessages();
        // 绑定到新任务的队列
        this.inputArea.bindToTaskQueue(task.task_id, task.message_queue);
        this.inputArea.statusBar.stopTimer();
        this.inputArea.statusBar.setAccumulatedMs(task.total_elapsed_ms);
        this.inputArea.statusBar.update({ totalTokens: 0 });
        this.taskView.rebuildFromHistory();

        if (task.task_status === 'running') {
            this.inputArea.setStatus('running');
            this.inputArea.statusBar.startTimer();
            this.resubscribeToRunningTask(task);
        } else {
            this.inputArea.setStatus('idle');
        }
        this.tui.requestRender();
    }

    /**
     * 重新订阅一个正在运行的任务的更新流，确保切换回来后
     * 能继续看到新的输出消息。
     */
    private resubscribeToRunningTask(task: TaskState) {
        const lastView = this.taskView.getLastAssistantView();
        if (!lastView) return;

        const snapshotTaskId = task.task_id;
        task.waitUntilFinished(async (chunkUpdate: TaskUpdateChunk) => {
            // 只有当前任务仍然是活跃任务时才更新视图
            if (this.activeTaskId !== snapshotTaskId) return;
            lastView.update(chunkUpdate);
            if (chunkUpdate.usage) {
                this.taskView.onStatusBarUpdate?.({ totalTokens: chunkUpdate.usage.total_tokens });
            }
            this.tui.requestRender();
        }).then(() => {
            if (this.activeTaskId === snapshotTaskId) {
                this.inputArea.statusBar.stopTimer();
                this.inputArea.setStatus('idle');
                this.processQueue();
            }
        });
    }

    // ─── Memory operation management ──────────────────────

    private memoryAddStart = 0;

    /**
     * 尝试获取全局记忆操作锁。失败时弹出 InfoOverlay 提示。
     */
    private acquireMemoryLock(op: 'add' | 'search' | 'forget'): boolean {
        const registry = MemoryRegistry.getInstance();
        if (!registry.acquireLock(op)) {
            const labels = { add: '添加', search: '搜索', forget: '删除' };
            const currentOp = labels[registry.busyOp!] ?? registry.busyOp;
            this.showMemoryResult(
                '操作被忽略',
                `当前有记忆${currentOp}操作正在进行中，请等待完成后再试。`,
            );
            return false;
        }
        return true;
    }

    private releaseMemoryLock() {
        MemoryRegistry.getInstance().releaseLock();
    }

    /**
     * 启动普通记忆操作 spinner（search/forget 用，静态文字 + 旋转图标）
     */
    private startMemorySpinner(message: string) {
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
    private startMemoryAddSpinner() {
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

    private stopMemorySpinner() {
        if (this.memorySpinnerInterval) {
            clearInterval(this.memorySpinnerInterval);
            this.memorySpinnerInterval = undefined;
        }
        this.memoryOpBusy = false;
        this.inputArea.clearExternalHint();
    }

    private showMemoryResult(title: string, message: string, onClose?: () => void) {
        const info = new InfoOverlay(this, { title, message });
        info.show(onClose);
    }

    // ─── Memory command handlers ────────────────────────

    private static readonly MAX_MSG_CHARS = 2000;

    /**
     * 从当前对话构建一个精简的上下文摘要字符串，供后台记忆提取使用。
     * 丢弃工具输出，截断过长的单条消息。
     */
    private buildConversationSnapshot(): string {
        const task = this.taskView.taskState;
        if (!task) return '';

        const parts: string[] = [];
        for (const msg of task.chat_context.messages) {
            if (msg instanceof UserMessage) {
                for (const p of msg.content) {
                    if (p.type === 'text' && p.text) {
                        const text = p.text.length > OpenDeskTUI.MAX_MSG_CHARS
                            ? p.text.slice(0, OpenDeskTUI.MAX_MSG_CHARS) + '...(已截断)'
                            : p.text;
                        parts.push(`[用户]: ${text}`);
                    }
                }
            } else if (msg instanceof AssistantMessage) {
                for (const p of msg.content) {
                    if (p.type === 'text' && (p as any).text) {
                        const text = (p as any).text.length > OpenDeskTUI.MAX_MSG_CHARS
                            ? (p as any).text.slice(0, OpenDeskTUI.MAX_MSG_CHARS) + '...(已截断)'
                            : (p as any).text;
                        parts.push(`[助手]: ${text}`);
                    }
                    // 工具调用只保留名称，丢弃输出
                    if (p.type === 'tool_call') {
                        for (const tc of p.toolcalls) {
                            const argSnippet = tc.args_string
                                ? (tc.args_string.length > OpenDeskTUI.MAX_MSG_CHARS
                                    ? tc.args_string.slice(0, OpenDeskTUI.MAX_MSG_CHARS) + '...'
                                    : tc.args_string)
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

    private async handleMemoryAdd(prompt: string) {
        if (!this.acquireMemoryLock('add')) return;

        const registry = MemoryRegistry.getInstance();
        registry.resetOpCounter();
        this.memoryAddStart = Date.now();
        this.startMemoryAddSpinner();

        const conversationSnapshot = this.buildConversationSnapshot();

        const addPrompt = prompt
            ? `请根据以下指示，从对话中提取并保存相关记忆：\n\n${prompt}\n\n请使用 addMemory 工具保存。注意判断每条记忆应保存到全局(global)还是工作区(workspace)。`
            : '请回顾以下对话，提取所有值得长期保存的信息（用户偏好、重要事实、关键决策、有用上下文等），并使用 addMemory 工具逐条保存。注意判断每条记忆应保存到全局(global)还是工作区(workspace)。';

        const fullPrompt = `${addPrompt}\n\n---\n\n以下是对话记录：\n\n${conversationSnapshot}`;

        try {
            const bgContext = new ChatContext();
            bgContext.system_prompt = new SystemMessage(
                '你是一个记忆提取助手。你的唯一任务是从给定的对话历史中提取有价值的信息，并使用 addMemory 工具保存为长期记忆。' +
                '你只需要调用 addMemory 工具，不要输出其他内容。'
            );

            const memoryToolset = createMemoryToolset();
            bgContext.attachToolsets(memoryToolset);
            bgContext.appendMessage(new UserMessage(fullPrompt));
            bgContext.appendMessage(new AssistantMessage());

            const bgTask = new TaskState(this.taskManagerState);
            bgTask.chat_context = bgContext;
            bgTask.model = this.model;

            await bgTask.processTask();

            this.stopMemorySpinner();
            this.releaseMemoryLock();

            const elapsed = Math.floor((Date.now() - this.memoryAddStart) / 1000);
            const count = registry.opCounter;
            if (count > 0) {
                this.showMemoryResult(
                    '记忆提取完成',
                    `耗时 ${elapsed} 秒，共提取 ${count} 条记忆。`,
                );
            } else {
                this.showMemoryResult(
                    '记忆提取完成',
                    `耗时 ${elapsed} 秒，未发现需要保存的新记忆。`,
                );
            }
        } catch (err: any) {
            this.stopMemorySpinner();
            this.releaseMemoryLock();
            this.showMemoryResult('记忆提取失败', `操作出错：${err?.message ?? err}`);
        }
    }

    private async handleMemorySearch(query: string) {
        if (!this.acquireMemoryLock('search')) return;
        this.startMemorySpinner('正在搜索相关记忆...');

        const registry = MemoryRegistry.getInstance();
        try {
            const results = await registry.smartSearch(query);
            this.stopMemorySpinner();
            this.releaseMemoryLock();

            if (results.length === 0) {
                this.showMemoryResult('记忆搜索', `未找到与「${query}」相关的记忆`);
                return;
            }

            const topResults = results.slice(0, 5);
            const memoriesForContext = topResults.map(r => ({ scope: r.scope, meta: r.meta }));
            const formattedContent = registry.formatMemoriesForContext(memoriesForContext);

            const resultLines = topResults.map(r =>
                `  • ${r.meta.name}（相关度: ${r.relevance}/10）`
            ).join('\n');

            this.showMemoryResult(
                '记忆搜索完成',
                `找到 ${results.length} 条相关记忆，将前 ${topResults.length} 条注入对话上下文：\n\n${resultLines}`,
                async () => {
                    const searchPrompt = `以下是根据查询"${query}"检索到的相关记忆，请参考这些信息：\n\n${formattedContent}`;
                    await this.onRequestSubmit(searchPrompt);
                },
            );
        } catch (err: any) {
            this.stopMemorySpinner();
            this.releaseMemoryLock();
            this.showMemoryResult('记忆搜索失败', `操作出错：${err?.message ?? err}`);
        }
    }

    private async handleMemoryForget(description: string) {
        if (!this.acquireMemoryLock('forget')) return;
        this.startMemorySpinner('正在搜索并删除匹配的记忆...');

        const registry = MemoryRegistry.getInstance();
        try {
            const result = await registry.smartForget(description);
            this.stopMemorySpinner();
            this.releaseMemoryLock();

            if (result.deleted.length > 0) {
                const lines = result.deleted.map(d => `  • ${d.name}`).join('\n');
                this.showMemoryResult(
                    '记忆删除完成',
                    `已删除 ${result.deleted.length} 条记忆：\n\n${lines}`,
                );
            } else {
                this.showMemoryResult(
                    '记忆删除',
                    `未找到与「${description}」匹配的记忆`,
                );
            }
        } catch (err: any) {
            this.stopMemorySpinner();
            this.releaseMemoryLock();
            this.showMemoryResult('记忆删除失败', `操作出错：${err?.message ?? err}`);
        }
    }

    private handleMemoryList() {
        const overlay = new MemoryListOverlay(this);
        overlay.show();
    }

    // ─── Exit & Submit ────────────────────────────────────

    private async exit() {
        try {
            this.inputArea.statusBar.stopTimer();
            this.shortcutManager.detach();
            this.tui.stop();
        } catch { /* 忽略 TUI 清理错误 */ }

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
            await this.taskView.taskState.setSystemPrompt(systemPrompt);
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

                // 如果使用了 -c 参数，在任务完成后退出
                if (this.singleShot) {
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

            this.inputArea.statusBar.update({ modelName });

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
            fetchContextSizeFromAPI(modelInstance).then((apiSize) => {
                if (apiSize > 0) {
                    this.inputArea.statusBar.update({ contextSize: apiSize });
                    logger.info(`model context size from API: ${apiSize}`);
                } else if (knownSize > 0) {
                    logger.info(`model context size from builtin table: ${knownSize}`);
                }
            }).catch(() => { });
        } catch { /* 配置读取失败不影响主流程 */ }
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
            '',
            chalk.dim('然后? 你可以休息了，让我开始工作吧!'),
        ].join('\n');

        this.modelNotConfiguredNotice = new Text(noticeText);

        // 标记需要处理回车键
        this.modelNotConfiguredMode = true;

        // 如果当前处于配置模式，不破坏配置页面布局；
        // exitConfigMode() 退出时会根据 modelNotConfiguredMode 标记处理布局。
        if (this.configComponent) {
            return;
        }

        // 隐藏 taskview 和 todoList，显示提示
        this.container.clear();
        this.container.addChild(new OpenDeskBanner(this.workspace));
        this.container.addChild(this.modelNotConfiguredNotice);
        this.container.addChild(this.inputArea);
        this.container.setMinLines(this.tui.terminal.rows);

        this.tui.requestRender();
        // 重建布局后，重新将焦点设置回输入框
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
            return; // 本来就没有显示提示
        }

        // 移除提示组件
        this.modelNotConfiguredNotice = undefined;
        this.modelNotConfiguredMode = false;

        // 恢复原始布局
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
        // 重建布局后，重新将焦点设置回输入框
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
        // Poll for todo changes and update the TodoList component
        const checkTodoChanges = () => {
            if (!this.activeTaskId) {
                setTimeout(checkTodoChanges, 500);
                return;
            }

            const todos = getTaskTodosForDisplay(this.activeTaskId);
            this.todoList.setTodos(todos);
            this.tui.requestRender();
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

    start() {
        this.tui.start();

        // Attach a direct input listener to TUI FIRST, to hijack Ctrl+C before Editor gets it!
        this.tui.addInputListener((data) => {
            if (matchesKey(data, Key.ctrl("c"))) {
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
                        title: "提示",
                        message: "你可以输入 /exit 退出或者输入 /help 查看帮助",
                        closeLabel: "确定"
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
