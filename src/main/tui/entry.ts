import { TUI, SelectList, Box, Text, Key, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
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
import { defaultSelectListTheme } from "./theme";
import { logger } from "../utils/logger.js";
import { lookupKnownContextSize, fetchContextSizeFromAPI } from "../utils/model-context";
import chalk from "chalk";
import { CenteredText } from "./components/texts.js";
import { AgentDecl } from "../agents/agentdecl.js";
import { ShellAgentDecl } from "../agents/agentdecls/shellagent.js";


export interface CommandLineArgs {
    workspace: string;
    command?: string;
    model?: string;
}


export class OpenDeskTUI {

    private taskManagerState: TaskManagerState;

    private tui: TUI;
    private container: VerticalLayout = new VerticalLayout({
        spacing: 1,
        padding: { left: 1, right: 1 }
    });
    private taskView: TaskView;
    private inputArea: AgentInputArea;

    private shortcutManager: KeyboardShortcutManager;
    private commandRegistry: SlashCommandRegistry;
    private modelInfoResolved = false;
    private activeTaskId?: string;

    private workspace: string;
    private agentDecl: AgentDecl;
    private model?: string;

    /**
     * 如果在命令行中给了-c参数，就用singleShot模式执行，第一轮补全后就自动退出.
     * todo: 这个地方未来可以考虑用LLM来判断任务是不是已经完成了还是需要后续的互动 ;)
     */
    private singleShot?: boolean;

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
        this.inputArea = new AgentInputArea(this.tui);
        this.workspace = args.workspace;
        this.model = args.model;
        this.singleShot = !!args.command;

        this.tui.addChild(this.container);
        this.container.addChild(new OpenDeskBanner(this.workspace));
        this.container.addChild(this.taskView);
        this.container.addChild(this.inputArea)
        this.container.setMinLines(this.tui.terminal.rows);
        this.container.setVerticalAlign("center");

        this.inputArea.onSubmit(this.onRequestSubmit.bind(this));

        // StatusBar: 只接受当前活跃任务的 token 数据
        this.taskView.onStatusBarUpdate = (data) => {
            if (this.taskView.taskState &&
                this.activeTaskId === this.taskView.taskState.task_id) {
                this.inputArea.statusBar.update(data);
            }
        };

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

        if (args.command) {
            this.onRequestSubmit(args.command);
        }
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
            execute: async () => { this.showHelp(); },
        });

        this.commandRegistry.register({
            name: "exit",
            description: "退出 OpenDesk",
            execute: async () => { await this.exit(); },
        });
    }

    private async createNewTask() {
        const task = this.taskManagerState.createTask(this.model);
        await task.setSystemPrompt(this.agentDecl.createSystemPrompt());
        this.activeTaskId = task.task_id;
        this.taskView.taskState = task;
        this.taskView.clearMessages();
        this.inputArea.setStatus('idle');
        this.inputArea.statusBar.stopTimer();
        this.inputArea.statusBar.update({ elapsedMs: 0, totalTokens: 0 });
        this.tui.requestRender();
    }

    private showTaskSwitcher() {
        const tasks = this.taskManagerState.tasks;
        if (tasks.length === 0) return;

        const statusIcons: Record<string, string> = {
            running: '● 执行中',
            waiting: '○ 空闲',
            stopped: '■ 已完成',
            failed: '✖ 异常中断',
        };

        const overlayWidth = Math.floor(this.tui.terminal.columns * 0.6);
        const contentWidth = overlayWidth - 6;

        const items = [...tasks].reverse().map(t => {
            const rawName = t.task_name || '未命名任务';
            const status = statusIcons[t.task_status] ?? t.task_status;
            const statusW = visibleWidth(status);
            const maxNameW = contentWidth - statusW - 2;

            let name = rawName;
            if (visibleWidth(rawName) > maxNameW) {
                name = truncateToWidth(rawName, Math.max(4, maxNameW - 2), '') + '..';
            }

            const gap = Math.max(2, contentWidth - visibleWidth(name) - statusW);
            return {
                value: t.task_id,
                label: name + ' '.repeat(gap) + chalk.dim(status),
            };
        });

        const list = new SelectList(items, Math.min(items.length, 10), defaultSelectListTheme);
        const box = new Box(1, 1);
        box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        box.addChild(list);

        const handle = this.tui.showOverlay(box, {
            width: "60%",
            maxHeight: "50%",
            anchor: "center",
        });

        this.tui.setFocus(list);

        list.onSelect = (item) => {
            handle.hide();
            this.tui.setFocus(this.inputArea.input);
            const task = this.taskManagerState.getTask(item.value);
            if (task) {
                this.switchToTask(task);
            }
        };

        list.onCancel = () => {
            handle.hide();
            this.tui.setFocus(this.inputArea.input);
        };
    }

    private showHelp() {
        const commands = this.commandRegistry.getAll();

        const items = commands.map(cmd => {
            const cmdName = ('/' + cmd.name).padEnd(10);
            const shortcut = cmd.shortcut
                ? chalk.cyan(SlashCommandRegistry.formatKeyLabel(cmd.shortcut).padEnd(10))
                : ' '.repeat(10);
            return {
                value: cmd.name,
                label: `${chalk.bold(cmdName)}${shortcut}${cmd.description}`,
            };
        });

        const overlayWidth = Math.min(50, Math.floor(this.tui.terminal.columns * 0.6));

        const header = new Text(chalk.bold(' 指令列表'));
        const list = new SelectList(items, items.length, defaultSelectListTheme);
        const box = new Box(1, 1);
        box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        box.addChild(header);
        box.addChild(list);

        const handle = this.tui.showOverlay(box, {
            width: overlayWidth,
            maxHeight: "50%",
            anchor: "center",
        });

        this.tui.setFocus(list);

        list.onSelect = () => {
            handle.hide();
            this.tui.setFocus(this.inputArea.input);
        };

        list.onCancel = () => {
            handle.hide();
            this.tui.setFocus(this.inputArea.input);
        };
    }

    private switchToTask(task: TaskState) {
        this.activeTaskId = task.task_id;
        this.taskView.taskState = task;
        this.taskView.clearMessages();
        this.inputArea.statusBar.stopTimer();
        this.inputArea.statusBar.update({ elapsedMs: 0, totalTokens: 0 });
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
            await this.taskView.taskState.setSystemPrompt(this.agentDecl.createSystemPrompt());
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
     * 解析模型信息（名称、上下文长度）。首次调用时触发异步 API 查询，
     * 结果缓存，不会重复请求。
     */
    private resolveModelInfo() {
        if (this.modelInfoResolved) return;
        this.modelInfoResolved = true;

        try {
            const setting = Setting.getInstance();
            const data = setting.getData() as any;
            const aliasToUse = this.model || data.default_model;
            const modelCfg = data.models?.find((m: any) => m.alias === aliasToUse);
            const modelName = modelCfg?.model_name ?? aliasToUse;

            this.inputArea.statusBar.update({ modelName });

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
            }).catch(() => {});
        } catch { /* 配置读取失败不影响主流程 */ }
    }

    private async processQueue() {
        const taskId = this.activeTaskId;
        while (this.inputArea.hasQueuedMessages() && this.activeTaskId === taskId) {
            const next = this.inputArea.dequeueMessage();
            if (!next) break;
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

    start() {
        this.tui.start();
        this.shortcutManager.attach(this.tui);
        this.tui.setFocus(this.inputArea.input);
    }
}
