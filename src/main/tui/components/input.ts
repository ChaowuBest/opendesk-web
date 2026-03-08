
import { Box, Component, Text, Editor, TUI, CombinedAutocompleteProvider } from "@mariozechner/pi-tui";
import { defaultEditorTheme } from "../theme";
import { SlashCommandRegistry } from "../commands";
import type { OpenDeskTUI } from "../entry";
import chalk from "chalk";
import { visibleWidth } from "@mariozechner/pi-tui";

type AgentInputStatus = 'idle' | 'running';

export interface ChannelStatusEntry {
    label: string;
    online: boolean;
}

export interface StatusBarData {
    elapsedMs: number;
    totalTokens: number;
    contextSize: number;
    modelName: string;
    channelStates?: ChannelStatusEntry[];
}

/**
 * 底部状态栏：灰色背景，显示任务执行时间、token 用量及上下文占比。
 * 计时器跟踪的是任务内所有 agent 执行时间的累计总和。
 */
export class StatusBar implements Component {
    private static readonly SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

    private data: StatusBarData = { elapsedMs: 0, totalTokens: 0, contextSize: 0, modelName: '' };
    private timerStarted = false;
    private timerStart: number = 0;
    private accumulatedMs: number = 0;
    private spinnerFrame: number = 0;
    private timerInterval?: ReturnType<typeof setInterval>;
    private tui?: TUI;
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];

    onTimerStop?: () => void;

    setTUI(tui: TUI) {
        this.tui = tui;
    }

    startTimer() {
        this.stopTimer();
        this.timerStarted = true;
        this.timerStart = Date.now();
        this.spinnerFrame = 0;
        this.timerInterval = setInterval(() => {
            this.data.elapsedMs = this.accumulatedMs + (Date.now() - this.timerStart);
            this.spinnerFrame = (this.spinnerFrame + 1) % StatusBar.SPINNER.length;
            this.invalidated = true;
            this.tui?.requestRender();
        }, 200);
    }

    stopTimer() {
        if (this.timerStarted) {
            this.accumulatedMs += Date.now() - this.timerStart;
            this.data.elapsedMs = this.accumulatedMs;
        }
        this.timerStarted = false;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = undefined;
        }
        this.invalidated = true;
        this.onTimerStop?.();
    }

    resetAccumulated() {
        this.accumulatedMs = 0;
        this.data.elapsedMs = 0;
        this.invalidated = true;
    }

    setAccumulatedMs(ms: number) {
        this.accumulatedMs = ms;
        if (!this.timerStarted) {
            this.data.elapsedMs = ms;
        }
        this.invalidated = true;
    }

    getAccumulatedMs(): number {
        if (this.timerStarted) {
            return this.accumulatedMs + (Date.now() - this.timerStart);
        }
        return this.accumulatedMs;
    }

    update(partial: Partial<StatusBarData>) {
        Object.assign(this.data, partial);
        this.invalidated = true;
        if (this.timerStarted) {
            this.data.elapsedMs = this.accumulatedMs + (Date.now() - this.timerStart);
        }
        this.tui?.requestRender();
    }

    private formatElapsed(ms: number): string {
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }

    invalidate() {
        this.invalidated = true;
    }

    render(width: number): string[] {
        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }
        this.lastWidth = width;
        const { elapsedMs, totalTokens, contextSize, modelName, channelStates } = this.data;

        const parts: string[] = [];
        if (this.timerStarted) {
            const icon = StatusBar.SPINNER[this.spinnerFrame];
            parts.push(chalk.greenBright(`${icon} ${this.formatElapsed(elapsedMs)}`));
        } else if (elapsedMs > 0) {
            parts.push(chalk.hex('#d4d4d4')(`⏱ ${this.formatElapsed(elapsedMs)}`));
        }
        if (totalTokens > 0) {
            const pct = contextSize > 0 ? ((totalTokens / contextSize) * 100).toFixed(1) : '—';
            parts.push(`Tokens: ${totalTokens}/${contextSize} (${pct}%)`);
        }
        if (modelName) {
            parts.push(`模型: ${modelName}`);
        }

        const leftContent = parts.length > 0 ? ` ${parts.join('  │  ')}` : '';

        // Build right-side content: channel states + /help
        const rightParts: string[] = [];
        if (channelStates && channelStates.length > 0) {
            const channelLabels = channelStates.map(ch =>
                ch.online
                    ? chalk.greenBright(`● ${ch.label}`)
                    : chalk.hex('#666666')(`○ ${ch.label}`)
            );
            rightParts.push(channelLabels.join('  '));
        }
        rightParts.push(chalk.hex('#d4d4d4')('/help 帮助'));
        const rightHint = rightParts.join(chalk.hex('#d4d4d4')('  │  ')) + ' ';

        const leftW = visibleWidth(leftContent);
        const rightW = visibleWidth(rightHint);
        const gap = Math.max(1, width - leftW - rightW);
        const line = chalk.bgHex('#3a3a3a')(
            chalk.hex('#d4d4d4')(leftContent) + ' '.repeat(gap) + rightHint
        );
        this.cachedOutput = [line];
        this.invalidated = false;
        return this.cachedOutput;
    }
}

/**
 * AgentInputArea: 输入区域 + 斜杠指令 + 消息队列 + 状态栏
 *
 * 任务运行期间用户仍可输入，新消息入队，当前回复完成后自动发送。
 */
export class AgentInputArea implements Component {

    input: Editor;
    statusBar: StatusBar = new StatusBar();

    private openDeskTUI: OpenDeskTUI;
    private layout: Box;
    private status: AgentInputStatus = 'idle';
    private hintText: Text = new Text('');

    private messageQueue: string[] = [];
    private submitCallback?: (text: string) => void;
    private commandRegistry?: SlashCommandRegistry;
    private onQueueChange?: (queue: string[]) => void;
    private externalHint: string | null = null;
    private quickPassHandler?: (text: string) => boolean;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
        this.layout = new Box(0, 0);
        this.input = new Editor(this.openDeskTUI.tui, defaultEditorTheme);
        this.layout.addChild(this.hintText);
        this.layout.addChild(this.input);
        this.layout.addChild(this.statusBar);
        this.statusBar.setTUI(this.openDeskTUI.tui);

        this.input.onSubmit = (text: string) => {
            if (text.trim() === '') return;
            this.input.addToHistory(text);
            this.handleSubmit(text);
        };
    }

    /**
     * 注入斜杠指令注册中心并配置自动补全
     */
    setCommandRegistry(registry: SlashCommandRegistry) {
        this.commandRegistry = registry;
        this.refreshAutocomplete();
    }

    /**
     * 设置口令处理回调，返回 true 表示输入已作为口令处理
     */
    setQuickPassHandler(handler: (text: string) => boolean) {
        this.quickPassHandler = handler;
    }

    /**
     * 刷新 Editor 的自动补全（在注册/注销命令后调用）
     */
    refreshAutocomplete() {
        if (!this.commandRegistry) return;
        const provider = new CombinedAutocompleteProvider(
            this.commandRegistry.toPiTuiSlashCommands()
        );
        this.input.setAutocompleteProvider(provider);
    }

    private async handleSubmit(text: string) {
        // 检查是否处于模型未配置模式
        if (this.openDeskTUI.isModelNotConfiguredMode()) {
            // 模型未配置，只尝试执行斜杠命令和口令导入，不进行任何任务操作
            if (this.commandRegistry) {
                const handled = await this.commandRegistry.execute(text);
                if (handled) {
                    this.input.setText('');
                    return;
                }
            }
            if (this.quickPassHandler && this.quickPassHandler(text)) {
                this.input.setText('');
                return;
            }
            // 不是斜杠命令/口令或未处理，只清空输入框
            this.input.setText('');
            return;
        }

        if (this.commandRegistry) {
            const handled = await this.commandRegistry.execute(text);
            if (handled) {
                this.input.setText('');
                return;
            }
        }

        if (this.quickPassHandler && this.quickPassHandler(text)) {
            this.input.setText('');
            return;
        }

        if (this.status === 'running') {
            this.messageQueue.push(text);
            this.updateQueueHint();
            this.notifyQueueChange();
            this.input.setText('');
            return;
        }

        this.setStatus('running');
        this.submitCallback?.(text);
    }

    /**
     * 设置队列变化回调
     */
    setOnQueueChange(callback: (queue: string[]) => void) {
        this.onQueueChange = callback;
    }

    /**
     * 通知队列变化
     */
    private notifyQueueChange() {
        if (this.onQueueChange) {
            this.onQueueChange(this.getQueueSnapshot());
        }
    }

    setExternalHint(text: string) {
        this.externalHint = text;
        this.hintText.setText(text);
    }

    clearExternalHint() {
        this.externalHint = null;
        this.refreshHint();
    }

    private refreshHint() {
        if (this.externalHint) {
            this.hintText.setText(this.externalHint);
            return;
        }
        if (this.messageQueue.length > 0) {
            this.updateQueueHint();
        } else if (this.status === 'running') {
            this.hintText.setText(chalk.dim('任务进行中，你仍然可以继续输入...'));
        } else {
            this.hintText.setText('');
        }
    }

    setStatus(status: AgentInputStatus) {
        this.status = status;
        this.refreshHint();
        if (this.status === 'idle' && !this.openDeskTUI.hasOpenOverlay) {
            this.openDeskTUI.tui.setFocus(this.input);
        }
    }

    private updateQueueHint() {
        const len = this.messageQueue.length;
        if (len === 0) {
            this.hintText.setText('');
        } else if (len === 1) {
            const preview = this.messageQueue[0].length > 60
                ? this.messageQueue[0].slice(0, 57) + '...'
                : this.messageQueue[0];
            this.hintText.setText(chalk.yellow(`📨 待发送: ${preview} (输入 /cancel 撤销)`));
        } else {
            this.hintText.setText(chalk.yellow(`📨 ${len} 条消息待发送 (输入 /cancel 撤销)`));
        }
    }

    /**
     * 清空消息队列中的所有待发送消息
     */
    clearMessageQueue(): string[] {
        const oldQueue = [...this.messageQueue];
        this.messageQueue = [];
        this.updateQueueHint();
        this.notifyQueueChange();
        return oldQueue;
    }

    /**
     * 检查队列，返回下一条待发送的消息（如有），否则返回 undefined
     */
    dequeueMessage(): string | undefined {
        const msg = this.messageQueue.shift();
        this.updateQueueHint();
        this.notifyQueueChange();
        return msg;
    }

    hasQueuedMessages(): boolean {
        return this.messageQueue.length > 0;
    }

    /**
     * 绑定到特定任务的队列
     */
    bindToTaskQueue(taskId: string, queue: string[]) {
        this.currentTaskId = taskId;
        this.messageQueue = [...queue];
        this.updateQueueHint();
    }

    /**
     * 获取当前队列的副本（用于保存）
     */
    getQueueSnapshot(): string[] {
        return [...this.messageQueue];
    }

    /**
     * 解除当前任务的绑定
     */
    unbindTaskQueue(): void {
        this.currentTaskId = undefined;
        this.messageQueue = [];
        this.updateQueueHint();
    }

    invalidate() {
        this.layout.invalidate();
    }

    render(width: number): string[] {
        return this.layout.render(width);
    }

    onSubmit(callback: (text: string) => void) {
        this.submitCallback = callback;
    }
}
