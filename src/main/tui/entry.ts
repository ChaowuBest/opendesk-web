import { TUI, SelectList, Box, Key, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
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
import { lookupKnownContextSize } from "../utils/model-context";
import chalk from "chalk";


/**
 * 从模型对象中提取上下文窗口大小，兼容多种 API 格式：
 * - 火山引擎 Ark: token_limits.context_window
 * - OpenRouter: context_length
 * - vLLM: max_model_len
 * - 通用: context_window, max_context_length
 */
function extractContextSize(model: any): number {
    if (!model) return 0;
    const candidates = [
        model.token_limits?.context_window,
        model.token_limits?.max_input_token_length,
        model.context_length,
        model.context_window,
        model.max_context_length,
        model.max_model_len,
        model.model_info?.context_length,
        model.model_info?.context_window,
    ];
    for (const val of candidates) {
        if (typeof val === 'number' && val > 0) return val;
    }
    return 0;
}

/**
 * 在模型列表中查找目标模型，支持多种匹配策略：
 * 1. id 精确匹配
 * 2. name 精确匹配
 * 3. id 或 name 前缀匹配（取最新的）
 */
function findModelInList(models: any[], modelName: string): any | undefined {
    const norm = modelName.toLowerCase().replace(/[._]/g, '-');
    const normId = (m: any) => (m.id ?? '').toLowerCase().replace(/[._]/g, '-');
    const normName = (m: any) => (m.name ?? '').toLowerCase().replace(/[._]/g, '-');

    return models.find((m: any) => m.id === modelName)
        ?? models.find((m: any) => m.name === modelName)
        ?? models.find((m: any) => normId(m) === norm)
        ?? models.find((m: any) => normName(m) === norm)
        ?? models
            .filter((m: any) => {
                const id = normId(m), name = normName(m);
                return id.startsWith(norm) || name.startsWith(norm)
                    || norm.startsWith(id) || norm.startsWith(name);
            })
            .sort((a: any, b: any) => (b.created ?? 0) - (a.created ?? 0))[0];
}

/**
 * 尝试通过 OpenAI 兼容 API 的 /models 端点获取模型的上下文窗口大小。
 * 失败时返回 0 表示未知。
 */
async function fetchContextSizeFromAPI(modelInstance: any): Promise<number> {
    const baseUrl: string = modelInstance.base_url;
    const apiKey: string = modelInstance.api_key;
    const modelName: string = modelInstance.model_name;
    const headers: Record<string, string> = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    };

    try {
        const resp = await fetch(`${baseUrl}/models/${encodeURIComponent(modelName)}`, { headers, signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
            const size = extractContextSize(await resp.json());
            if (size > 0) return size;
        }
    } catch { /* 忽略单模型端点错误 */ }

    try {
        const resp = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(8000) });
        if (resp.ok) {
            const body = await resp.json();
            const models: any[] = body.data ?? body;
            const match = findModelInList(models, modelName);
            if (match) {
                const size = extractContextSize(match);
                if (size > 0) return size;
            }
        }
    } catch { /* 忽略列表端点错误 */ }

    return 0;
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

    constructor() {
        this.taskManagerState = GlobalState.getInstance().taskManagerState;

        const terminal = new OpenDeskTerminal();
        terminal.onResize((cols, rows) => {
            this.container.setMinLines(rows);
            this.tui.requestRender(true);
        });

        this.tui = new TUI(terminal);
        this.taskView = new TaskView(this.tui);
        this.inputArea = new AgentInputArea(this.tui);

        this.tui.addChild(this.container);
        this.container.addChild(new OpenDeskBanner());
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

        // 快捷键
        this.shortcutManager = new KeyboardShortcutManager();
        this.setupShortcuts();

        // 斜杠指令
        this.commandRegistry = new SlashCommandRegistry();
        this.setupCommands();
        this.inputArea.setCommandRegistry(this.commandRegistry);
    }

    private setupShortcuts() {
        this.shortcutManager.register({
            key: Key.ctrl("n"),
            description: "新建任务",
            handler: () => { this.createNewTask(); },
        });
        this.shortcutManager.register({
            key: Key.ctrl("t"),
            description: "切换任务",
            handler: () => { this.showTaskSwitcher(); },
        });
    }

    private setupCommands() {
        this.commandRegistry.register({
            name: "exit",
            description: "退出 OpenDesk",
            execute: async () => { await this.exit(); },
        });

        this.commandRegistry.register({
            name: "new",
            description: "启动新任务并发送消息",
            execute: async (args: string) => {
                this.createNewTask();
                if (args.trim()) {
                    await this.onRequestSubmit(args.trim());
                }
            },
        });

        this.commandRegistry.register({
            name: "switch",
            description: "切换到其他任务",
            execute: async () => { this.showTaskSwitcher(); },
        });
    }

    private createNewTask() {
        const task = this.taskManagerState.createTask();
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
            this.taskView.taskState = this.taskManagerState.createTask();
        }

        const taskId = this.taskView.taskState.task_id;
        this.activeTaskId = taskId;

        this.resolveModelInfo();
        this.inputArea.statusBar.startTimer();

        await this.taskView.communicate(request).finally(() => {
            if (this.activeTaskId === taskId) {
                this.inputArea.statusBar.stopTimer();
                this.inputArea.setStatus('idle');
                this.processQueue();
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
            const defaultAlias = data.default_model;
            const modelCfg = data.models?.find((m: any) => m.alias === defaultAlias);
            const modelName = modelCfg?.model_name ?? defaultAlias;

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
