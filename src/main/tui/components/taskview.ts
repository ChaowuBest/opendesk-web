import {
    Component,
    Markdown,
    Box,
    type TUI,
    visibleWidth,
    truncateToWidth,
    wrapTextWithAnsi
} from '@mariozechner/pi-tui';
import type {
    TaskState,
    TaskUpdateChunk,
    TaskUpdateUserChunk,
    TaskUpdateAssistantChunk,
    TaskUpdateAssistantReplaceChunk,
    TaskUpdateRetryChunk
} from '../../aikernel/states/tasks';
import {
    AssistantMessage,
    ReasoningMessagePart,
    TextMessagePart,
    ToolCallMessagePart,
    ErrorMessagePart,
    UserMessage,
    isCompactBoundaryMessage,
    ToolCall
} from '../../aikernel/messages';
import { prepareContextForModel } from '../../aikernel/compaction/pipeline.js';
import { logger, getDebugMode } from '../../utils/logger.js';
import { Setting } from '../../utils/setting.js';
import { defaultMarkdownTheme } from '../theme';
import { DefaultToolCallView } from './toolcall';
import { Card } from './card';
import chalk from 'chalk';
import type { TaskStatusBarData } from './input';
import { t } from '../../../locale/index.js';

export class TextMessagePartView implements Component {
    text: Markdown = new Markdown('', 0, 0, defaultMarkdownTheme);
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];

    constructor(text?: string) {
        if (text) {
            this.text.setText(text);
        }
    }

    setMarkdown(markdown: string) {
        try {
            this.text.setText(markdown);
            this.invalidated = true;
        } catch {
            // ignore error
        }
    }

    invalidate() {
        this.invalidated = true;
    }

    render(width: number): string[] {
        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }

        this.lastWidth = width;
        this.cachedOutput = this.text.render(width);
        this.invalidated = false;
        return this.cachedOutput;
    }
}

/** 思考进行中时使用的旋转图标帧（约每 120ms 一帧） */
const REASONING_SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
const REASONING_SPINNER_MS = 120;

/** partial 模式下保留的 reasoning 行数（从尾部算起，按卡片内容区换行后的可视行计；流式与结束后一致） */
export const REASONING_TAIL_LINES = 10;

/** 将原始按换行符分行的思考文本展开为内容区宽度下的可视行（与 Card 内 truncateToWidth 使用同一宽度基准） */
function wrapReasoningLinesForPartial(rawLines: string[], contentWidth: number): string[] {
    const out: string[] = [];
    for (const line of rawLines) {
        if (line.length === 0) {
            out.push('');
            continue;
        }
        const wrapped = wrapTextWithAnsi(line, contentWidth);
        if (wrapped.length === 0) {
            out.push('');
        } else {
            out.push(...wrapped);
        }
    }
    return out;
}

/** 尾部截断时提示用户可切换为完整思考显示（动态取本地化文本） */
function getReasoningPartialOmitHint(): string {
    return chalk.dim.italic(t('reasoning.partial.hint'));
}

/** 思考/推理内容用卡片展示：
 * - reason_display = 'partial'：只显示最后 REASONING_TAIL_LINES 行；超出时首行省略号 + 切换 full 提示
 * - reason_display = 'full'：完整 Markdown 渲染
 * - 正文均为斜体
 */
export class ReasoningMessagePartView implements Component {
    /** 原始思考文本内容 */
    private _content = '';
    /** 是否正在流式输出思考内容 */
    private _streaming = false;
    /** Markdown 渲染实例（完整显示模式使用） */
    private _markdown: Markdown = new Markdown('', 0, 0, defaultMarkdownTheme);
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];

    setContent(content: string) {
        this._content = content ?? '';
        // 同时更新 Markdown 内容（完整显示模式需要）
        this._markdown.setText(content ?? '');
        this.invalidated = true;
    }

    setStreaming(streaming: boolean) {
        this._streaming = streaming;
        this.invalidated = true;
    }

    invalidate() {
        this.invalidated = true;
    }

    private getStreamingIcon(): string {
        const idx = Math.floor(Date.now() / REASONING_SPINNER_MS) % REASONING_SPINNER_FRAMES.length;
        return chalk.blueBright(REASONING_SPINNER_FRAMES[idx]);
    }

    /** 判断是否应该完整显示思考内容 */
    private shouldDisplayFull(): boolean {
        const setting = Setting.getInstance();
        return setting.data.reason_display === 'full';
    }

    render(width: number): string[] {
        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }

        const displayFull = this.shouldDisplayFull();

        this.lastWidth = width;
        this.cachedOutput = [];

        if (displayFull) {
            const contentWidth = Math.max(1, width - 4);

            const bodyLines = this._markdown.render(contentWidth).map((line) => chalk.italic(line));

            const card = new Card({
                icon: this._streaming ? this.getStreamingIcon() : chalk.dim('◆'),
                title: t('reasoning.card.title'),
                body: bodyLines
            });
            this.cachedOutput = card.render(width);
        } else {
            // partial：流式与结束后同一套尾部视图；先按内容区宽度换行，再按换行后的可视行取尾部
            const contentWidth = Math.max(1, width - 4);
            const wrappedLines = wrapReasoningLinesForPartial(this._content.split('\n'), contentWidth);
            const hasMoreAbove = wrappedLines.length > REASONING_TAIL_LINES;
            const tailLines = wrappedLines.slice(-REASONING_TAIL_LINES).map((line) => chalk.italic(line));
            const hintLines = hasMoreAbove ? wrapTextWithAnsi(getReasoningPartialOmitHint(), contentWidth) : [];
            const bodyLines = hasMoreAbove ? [...hintLines, ...tailLines] : tailLines;
            const maxBodyLines = hasMoreAbove ? hintLines.length + REASONING_TAIL_LINES : REASONING_TAIL_LINES;
            const card = new Card({
                icon: this._streaming ? this.getStreamingIcon() : chalk.dim('◆'),
                title: t('reasoning.card.title'),
                body: bodyLines,
                maxLines: maxBodyLines,
                truncateStrategy: 'tail'
            });
            this.cachedOutput = card.render(width);
        }

        this.invalidated = false;
        return this.cachedOutput;
    }
}

export class ToolCallView implements Component {
    private toolCall: ToolCall;
    private defaultView: DefaultToolCallView;
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];
    private lastRenderedStatus?: string;

    constructor(toolCall: ToolCall) {
        this.toolCall = toolCall;
        this.defaultView = new DefaultToolCallView(toolCall);
    }

    invalidate() {
        this.invalidated = true;
    }

    render(width: number): string[] {
        const statusChanged = this.toolCall.status !== this.lastRenderedStatus;
        if (!statusChanged && !this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }
        this.lastRenderedStatus = this.toolCall.status;
        this.lastWidth = width;

        try {
            if (this.toolCall.tool && typeof this.toolCall.tool.renderToolCallCli === 'function') {
                const custom = this.toolCall.tool.renderToolCallCli(this.toolCall, width);
                if (custom) {
                    this.cachedOutput = custom;
                    this.invalidated = false;
                    return custom;
                }
            }
        } catch (error) {
            logger.error(`Error rendering tool call ${this.toolCall.tool_name}: ${error}`);
        }

        this.cachedOutput = this.defaultView.render(width);
        this.invalidated = false;
        return this.cachedOutput;
    }
}

export class ToolCallMessagePartView implements Component {
    private box: Box = new Box(0, 0);
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];
    private viewMap: Map<ToolCall, ToolCallView> = new Map();
    private lastRenderedStatuses: Map<ToolCall, string> = new Map();

    setToolcalls(toolcalls: ToolCall[]) {
        const newSet = new Set(toolcalls);
        for (const [toolcall, view] of this.viewMap) {
            if (!newSet.has(toolcall)) {
                this.box.removeChild(view);
                this.viewMap.delete(toolcall);
                this.lastRenderedStatuses.delete(toolcall);
            }
        }
        for (const toolcall of toolcalls) {
            const existing = this.viewMap.get(toolcall);
            if (existing) {
                existing.invalidate();
            } else {
                const view = new ToolCallView(toolcall);
                this.viewMap.set(toolcall, view);
                this.box.addChild(view);
            }
        }
        this.invalidated = true;
    }

    needsFreshRender(): boolean {
        for (const tc of this.viewMap.keys()) {
            if (tc.status === 'running') return true;
            if (this.lastRenderedStatuses.get(tc) !== tc.status) return true;
        }
        return false;
    }

    invalidate() {
        this.box.invalidate();
        this.invalidated = true;
    }

    render(width: number): string[] {
        const fresh = this.needsFreshRender();
        if (!fresh && !this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }
        if (fresh) this.box.invalidate();
        this.lastWidth = width;
        this.cachedOutput = this.box.render(width);
        this.invalidated = false;
        for (const tc of this.viewMap.keys()) {
            this.lastRenderedStatuses.set(tc, tc.status);
        }
        return this.cachedOutput;
    }
}

export class ErrorMessagePartView implements Component {
    private title: string;
    private message: string;
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];

    constructor(title: string, message: string) {
        this.title = title;
        this.message = message;
    }

    setContent(title: string, message: string) {
        this.title = title;
        this.message = message;
        this.invalidated = true;
    }

    invalidate() {
        this.invalidated = true;
    }

    render(width: number): string[] {
        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }
        this.lastWidth = width;

        const body: string[] = [];
        if (this.message) {
            const markdown = new Markdown(this.message, 0, 0, defaultMarkdownTheme);
            body.push(...markdown.render(width - 4));
        }

        this.cachedOutput = new Card({
            icon: chalk.redBright('⚠'),
            title: chalk.redBright(this.title),
            body
        }).render(width);

        this.invalidated = false;
        return this.cachedOutput;
    }
}

const COMPACT_SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
const COMPACT_SPINNER_MS = 120;

/**
 * 上下文压缩 boundary 视图。
 * - 静态模式：渲染为一条带 ✂ 的水平分隔线
 * - loading 模式：渲染为带旋转动画的"正在压缩…"提示
 */
export class CompactBoundaryView implements Component {
    private _loading = false;
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];

    setLoading(loading: boolean) {
        this._loading = loading;
        this.invalidated = true;
    }

    invalidate() {
        this.invalidated = true;
    }

    private buildLine(label: string, width: number): string {
        const labelW = visibleWidth(label);
        const available = Math.max(0, width - labelW);
        const left = Math.floor(available / 2);
        const right = available - left;
        const raw = chalk.dim('─'.repeat(left)) + chalk.yellow(label) + chalk.dim('─'.repeat(right));
        return truncateToWidth(raw, width, '', true);
    }

    render(width: number): string[] {
        if (this._loading) {
            const idx = Math.floor(Date.now() / COMPACT_SPINNER_MS) % COMPACT_SPINNER_FRAMES.length;
            const icon = chalk.blueBright(COMPACT_SPINNER_FRAMES[idx]);
            return ['', this.buildLine(` ${icon} ${t('compact.boundary.loading')} `, width), ''];
        }

        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }
        this.lastWidth = width;
        this.cachedOutput = ['', this.buildLine(` ✂ ${t('compact.boundary.done')} `, width), ''];
        this.invalidated = false;
        return this.cachedOutput;
    }
}

export class RetryStatusView implements Component {
    private state: TaskUpdateRetryChunk;
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];

    constructor(state: TaskUpdateRetryChunk) {
        this.state = state;
    }

    update(state: TaskUpdateRetryChunk) {
        this.state = state;
        this.invalidated = true;
    }

    invalidate() {
        this.invalidated = true;
    }

    render(width: number): string[] {
        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }

        const remainingSeconds = Math.max(0, Math.ceil((this.state.next_retry_at - Date.now()) / 1000));
        const retryTime = new Date(this.state.next_retry_at).toLocaleTimeString();
        const contentWidth = Math.max(1, width - 4);
        const statusLine =
            this.state.status === 'retrying'
                ? t('task.retry.retrying', { attempt: this.state.attempt })
                : t('task.retry.scheduled', {
                      attempt: this.state.attempt,
                      time: retryTime,
                      seconds: remainingSeconds
                  });
        const errorLine = t('task.retry.last_error', { error: this.state.error_message });
        const body = [
            ...wrapTextWithAnsi(chalk.yellow(statusLine), contentWidth),
            ...wrapTextWithAnsi(chalk.dim(errorLine), contentWidth),
            ...(this.state.status === 'scheduled'
                ? wrapTextWithAnsi(chalk.cyan(t('task.retry.command_hint')), contentWidth)
                : [])
        ];

        this.lastWidth = width;
        this.cachedOutput = new Card({
            icon: chalk.yellow('↻'),
            title: chalk.yellow(t('task.retry.title')),
            body,
            maxLines: 6,
            truncateStrategy: 'head-tail'
        }).render(width);
        this.invalidated = false;
        return this.cachedOutput;
    }
}

export class UserMessageView implements Component {
    message: UserMessage;
    box: Box = new Box(1, 1);
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];

    constructor(message: UserMessage) {
        this.box.setBgFn((text: string) => chalk.white.bgGrey(text));
        this.message = message;
        for (const part of message.content) {
            if (part.type === 'text') {
                this.box.addChild(new TextMessagePartView(part.text));
            }
        }
    }

    static text(text: string): UserMessageView {
        return new UserMessageView(new UserMessage(text));
    }

    /** 从 TaskUpdateUserChunk 创建用户消息视图（用于“继续任务”等追加的用户消息） */
    static fromChunk(chunk: TaskUpdateUserChunk): UserMessageView {
        const msg = new UserMessage();
        msg.message_id = chunk.message_id;
        msg.content = [chunk.last_part];
        msg.internal = chunk.internal;
        return new UserMessageView(msg);
    }

    invalidate() {
        this.box.invalidate();
        this.invalidated = true;
    }

    render(width: number): string[] {
        if (this.message.internal && !getDebugMode()) {
            return [];
        }
        if (this.message.internal) {
            const label = chalk.dim.italic(`  ${t('message.internal')}`);
            const body = this.box.render(width);
            return [label, ...body];
        }
        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }
        this.lastWidth = width;
        this.cachedOutput = this.box.render(width);
        this.invalidated = false;
        return this.cachedOutput;
    }
}

export class AssistantMessageView implements Component {
    box: Box = new Box(0, 1);
    parts: Array<ReasoningMessagePartView | TextMessagePartView | ToolCallMessagePartView | ErrorMessagePartView> = [];
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];
    /** 当前正在更新的 message_id，用于检测新的 AssistantMessage 并重置 parts */
    private currentMessageId?: string;

    async updateTextPart(index: number, textPart: TextMessagePart) {
        while (index >= this.parts.length) {
            const newPartView = new TextMessagePartView();
            this.parts.push(newPartView);
            this.box.addChild(newPartView);
        }

        const existingPartView = this.parts[index];
        if (!(existingPartView instanceof TextMessagePartView)) {
            throw new Error(`part type mismatch`);
        }

        existingPartView.setMarkdown(textPart.text);
        this.invalidated = true;
    }

    async updateReasoningPart(index: number, reasoningPart: ReasoningMessagePart) {
        while (index >= this.parts.length) {
            const newPartView = new ReasoningMessagePartView();
            this.parts.push(newPartView);
            this.box.addChild(newPartView);
        }

        const existingPartView = this.parts[index];
        if (!(existingPartView instanceof ReasoningMessagePartView)) {
            throw new Error(`part type mismatch`);
        }

        existingPartView.setStreaming(true);
        existingPartView.setContent(reasoningPart.content);
        this.invalidated = true;
    }

    /** 流式结束：停止 reasoning 动画 */
    setStreamingComplete() {
        for (const part of this.parts) {
            if (part instanceof ReasoningMessagePartView) {
                part.setStreaming(false);
            }
        }
        this.invalidated = true;
    }

    async updateToolCallPart(index: number, toolCallPart: ToolCallMessagePart) {
        while (index >= this.parts.length) {
            const newPartView = new ToolCallMessagePartView();
            this.parts.push(newPartView);
            this.box.addChild(newPartView);
        }

        const existingPartView = this.parts[index];
        if (!(existingPartView instanceof ToolCallMessagePartView)) {
            throw new Error(`part type mismatch`);
        }

        existingPartView.setToolcalls(toolCallPart.toolcalls);
        this.invalidated = true;
    }

    async updateErrorPart(index: number, errorPart: ErrorMessagePart) {
        while (index >= this.parts.length) {
            const newPartView = new ErrorMessagePartView('', '');
            this.parts.push(newPartView);
            this.box.addChild(newPartView);
        }

        const existingPartView = this.parts[index];
        if (!(existingPartView instanceof ErrorMessagePartView)) {
            throw new Error(`part type mismatch`);
        }

        existingPartView.setContent(errorPart.title, errorPart.message);
        this.invalidated = true;
    }

    /**
     * 设置当前视图对应的 message_id（用于 rebuildFromHistory 时与 messageIdToAssistantView 一致）。
     */
    setMessageId(message_id: string) {
        this.currentMessageId = message_id;
    }

    /**
     * 根据任务发回的 assistant 更新块来更新消息视图。
     * 若 chunk 的 message_id 与当前视图不一致且当前已有关联 message_id，则不再抹除当前内容（由调用方创建新容器）。
     */
    async update(chunkUpdate: TaskUpdateAssistantChunk) {
        if (this.currentMessageId !== undefined && this.currentMessageId !== chunkUpdate.message_id) {
            return;
        }
        this.currentMessageId = chunkUpdate.message_id;

        // last_part 可能不存在（如流式更新异常），跳过处理
        if (!chunkUpdate.last_part) {
            return;
        }

        switch (chunkUpdate.last_part.type) {
            case 'text':
                this.setStreamingComplete();
                return await this.updateTextPart(chunkUpdate.last_part_index, chunkUpdate.last_part);
            case 'reasoning':
                return await this.updateReasoningPart(chunkUpdate.last_part_index, chunkUpdate.last_part);
            case 'tool_call':
                this.setStreamingComplete();
                return await this.updateToolCallPart(chunkUpdate.last_part_index, chunkUpdate.last_part);
            case 'error':
                this.setStreamingComplete();
                return await this.updateErrorPart(chunkUpdate.last_part_index, chunkUpdate.last_part);
        }
    }

    clearParts() {
        this.box.clear();
        this.parts = [];
        this.invalidated = true;
    }

    async replace(chunkUpdate: TaskUpdateAssistantReplaceChunk) {
        this.currentMessageId = chunkUpdate.message_id;
        this.clearParts();
        for (let i = 0; i < chunkUpdate.parts.length; i++) {
            const part = chunkUpdate.parts[i];
            switch (part.type) {
                case 'text':
                    await this.updateTextPart(i, part);
                    break;
                case 'reasoning':
                    await this.updateReasoningPart(i, part);
                    break;
                case 'tool_call':
                    await this.updateToolCallPart(i, part);
                    break;
                case 'error':
                    await this.updateErrorPart(i, part);
                    break;
            }
        }
        this.setStreamingComplete();
    }

    invalidate() {
        this.box.invalidate();
        this.invalidated = true;
    }

    private hasToolCallUpdates(): boolean {
        for (const part of this.parts) {
            if (part instanceof ToolCallMessagePartView && part.needsFreshRender()) {
                return true;
            }
        }
        return false;
    }

    render(width: number): string[] {
        const fresh = this.hasToolCallUpdates();
        if (!fresh && !this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }
        if (fresh) this.box.invalidate();
        this.lastWidth = width;
        this.cachedOutput = this.box.render(width);
        this.invalidated = false;
        return this.cachedOutput;
    }
}

/**
 * 任务视图
 * 用于显示任务的对话历史
 */
export class TaskView implements Component {
    taskState?: TaskState;
    messages: Array<UserMessageView | AssistantMessageView | CompactBoundaryView | RetryStatusView> = [];

    /** 用于向外部回传 TaskStatusBar 数据 */
    onStatusBarUpdate?: (data: Partial<TaskStatusBarData>) => void;
    /** 通知外层 TUI 同步临时 /retry 命令 */
    onRetryStateChange?: (chunk: TaskUpdateRetryChunk) => void;

    /** 当前任务的ID，用于判断是否仍为活跃任务 */
    private currentTaskId?: string;
    /** 防止 performCompactWithAnimation 重入 */
    private _compacting = false;
    lastCompactErrorMessage?: string;
    /** message_id -> AssistantMessageView，用于按 message_id 追加而非覆盖 */
    private messageIdToAssistantView: Map<string, AssistantMessageView> = new Map();
    private retryStatusView?: RetryStatusView;

    private tui: TUI;
    private messageLayout: Box = new Box(0, 0);
    private mainLayout: Box = new Box(0, 0);
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];

    /** 流式渲染节流：在 render() 层限制消息区域的刷新频率 */
    private _streaming = false;
    private _lastRenderMs = 0;
    /** 上一次渲染耗时（毫秒），用于自适应节流 */
    private _lastRenderDurationMs = 0;
    /** 渲染基础间隔（毫秒），可通过 CLI --render-interval 配置 */
    readonly renderIntervalMs: number;

    constructor(tui: TUI, renderIntervalMs?: number) {
        this.tui = tui;
        this.renderIntervalMs = renderIntervalMs ?? 50;
        this.mainLayout.addChild(this.messageLayout);
    }

    get isCompacting() {
        return this._compacting;
    }

    /**
     * 请求流式渲染：直接调用 requestRender()，实际节流在 render() 层完成。
     * 这样无论渲染请求从哪条路径发起（spinner interval、chunk callback 等），
     * 都能统一在 render() 中被节流，不影响其他组件（DashboardBar、spinner）的动画。
     */
    requestStreamRender() {
        this.tui.requestRender();
    }

    /** 标记流式输出开始 */
    startStreaming() {
        this._streaming = true;
    }

    /** 流式输出结束：清除节流状态，确保最终帧完整渲染 */
    clearStreamThrottle() {
        this._streaming = false;
        this._lastRenderMs = 0;
        this._lastRenderDurationMs = 0;
        this.invalidated = true;
    }

    /**
     * 执行上下文压缩并在消息列表中展示动画。
     * 内置防重入：如果上一次压缩尚未完成，直接返回。
     */
    async performCompactWithAnimation(): Promise<boolean> {
        if (!this.taskState || this._compacting) return false;
        this._compacting = true;
        this.lastCompactErrorMessage = undefined;

        const indicatorView = new CompactBoundaryView();
        indicatorView.setLoading(true);
        this.messageLayout.addChild(indicatorView);
        this.invalidated = true;

        const spinnerInterval = setInterval(() => {
            this.tui.requestRender();
        }, COMPACT_SPINNER_MS);

        try {
            const compacted = await this.taskState.manualCompact();
            if (!compacted) {
                this.lastCompactErrorMessage = 'No compactable context available';
                return false;
            }
            this.taskState.markCompacted();
            return true;
        } catch (err: any) {
            logger.warn(`Context compact failed: ${err?.message ?? err}`);
            this.lastCompactErrorMessage = err?.message ?? String(err);
            return false;
        } finally {
            clearInterval(spinnerInterval);
            this.messageLayout.removeChild(indicatorView);
            this._compacting = false;
            this.invalidated = true;
            this.tui.requestRender();
        }
    }

    /**
     * 在当前任务中向Agent发送一条消息，并等待Agent的响应。Agent完成响应
     * 之后这个函数才会结束
     * @param text 用户输入的消息
     */
    async communicate(text: string) {
        if (!this.taskState) {
            return;
        }

        const snapshotTaskId = this.taskState.task_id;
        this.currentTaskId = snapshotTaskId;
        this.startStreaming();
        const model = this.taskState.ensureValidModelOrFallback();

        // 立即将用户消息加入布局，确保第一次渲染时就能看到，
        // 避免输入框清空后、消息出现前的空白帧闪烁
        const userView = UserMessageView.text(text);
        this.messageLayout.addChild(userView);
        this.invalidated = true;

        // 在提交新消息前检查是否需要压缩上下文（TUI 层负责展示动画）
        try {
            const preparation = await prepareContextForModel(this.taskState.chat_context, model, {
                beforeCompact: () => {
                    logger.info(`Auto-compacting context for task ${this.taskState!.task_id}`);
                },
                autoCompactState: this.taskState.auto_compact_state,
                microcompactState: this.taskState.getMicrocompactState(),
                microcompactRequestKind: 'pre_submit_check',
                microcompactTaskRole: this.taskState.parent_id === null ? 'main' : 'subtask',
                taskId: this.taskState.task_id,
                executeCompact: async () => {
                    const compacted = await this.performCompactWithAnimation();
                    if (!compacted) {
                        throw new Error(this.lastCompactErrorMessage ?? 'Context compact failed');
                    }
                }
            });
            if (preparation.autoCompactState) {
                this.taskState.setAutoCompactState(preparation.autoCompactState);
            }
            if (preparation.microcompactState) {
                this.taskState.setMicrocompactState(preparation.microcompactState);
            }
            if (preparation.compacted) {
                // 压缩重建后重新添加用户消息视图（此时尚未入 chat_context）
                this.clearMessages();
                this.rebuildFromHistory();
                this.messageLayout.addChild(userView);
                this.invalidated = true;
            }
        } catch {
            /* shouldCompact 失败不影响正常流程 */
        }

        await this.taskState.submitUserMessage(text);

        // submitUserMessage 中 preloadSlashSkills 可能已向 assistant_message 写入
        // reasoning + tool_call parts（如 /skillName 预加载）。
        // 这些 parts 的 sendSubscriptionFeedback 在 waitUntilFinished 订阅建立前发出，
        // TUI callback 收不到。此处用原始对象补建 view，确保预加载内容可见且自定义渲染生效。
        const lastMsg = this.taskState.chat_context.lastMessage();
        if (lastMsg instanceof AssistantMessage && lastMsg.content.length > 0) {
            let view = this.messageIdToAssistantView.get(lastMsg.message_id);
            if (!view) {
                view = new AssistantMessageView();
                view.setMessageId(lastMsg.message_id);
                view.throttleMsProvider = () => this.getMdRenderThrottleMs();
                this.messageIdToAssistantView.set(lastMsg.message_id, view);
                this.messages.push(view);
                this.messageLayout.addChild(view);
            }
            for (let i = 0; i < lastMsg.content.length; i++) {
                const part = lastMsg.content[i];
                switch (part.type) {
                    case 'text':
                        await view.updateTextPart(i, part);
                        break;
                    case 'reasoning':
                        await view.updateReasoningPart(i, part);
                        break;
                    case 'tool_call':
                        await view.updateToolCallPart(i, part);
                        break;
                    case 'error':
                        await view.updateErrorPart(i, part);
                        break;
                }
            }
            // preload 的 parts 已是最终状态，关闭 reasoning spinner
            view.setStreamingComplete();
            this.invalidated = true;
            this.requestStreamRender();
        }

        const renderInterval = setInterval(() => {
            if (this.currentTaskId === snapshotTaskId) {
                this.requestStreamRender();
            }
        }, REASONING_SPINNER_MS);
        try {
            await this.taskState.waitUntilFinished(async (chunkUpdate: TaskUpdateChunk) => {
                if (this.currentTaskId !== snapshotTaskId) return;
                await this.handleChunkUpdate(chunkUpdate);
                this.requestStreamRender();
            });
        } finally {
            clearInterval(renderInterval);
            this.clearStreamThrottle();
            if (this.currentTaskId === snapshotTaskId) {
                const lastView = this.getLastAssistantView();
                if (lastView) lastView.setStreamingComplete();
                this.invalidated = true;
                this.tui.requestRender();
            }
        }
    }

    /** 清空消息视图（用于切换任务时），同时重置动态节流阈值 */
    clearMessages() {
        this.messageLayout.clear();
        this.messages = [];
        this.messageIdToAssistantView.clear();
        this.retryStatusView = undefined;
        this.currentTaskId = undefined;
        this._dynamicThrottleMs = undefined;
        this.invalidated = true;
    }

    /**
     * 处理单条 TaskUpdateChunk：按 type 追加用户消息或按 message_id 获取/创建助手消息视图并更新。
     * 当 message_id 与当前已有助手消息不一致时创建新容器追加，不抹除已有内容。
     */
    async handleChunkUpdate(chunkUpdate: TaskUpdateChunk) {
        if (chunkUpdate.type === 'user') {
            const view = UserMessageView.fromChunk(chunkUpdate);
            this.messages.push(view);
            this.messageLayout.addChild(view);
        } else if (chunkUpdate.type === 'user_replace') {
            // user_replace 仅用于 GUI 中 slash skill 替换后重新渲染，TUI 忽略
        } else if (chunkUpdate.type === 'assistant_replace') {
            let view = this.messageIdToAssistantView.get(chunkUpdate.message_id);
            if (chunkUpdate.parts.length === 0) {
                if (view) {
                    this.messageLayout.removeChild(view);
                    this.messages = this.messages.filter((message) => message !== view);
                    this.messageIdToAssistantView.delete(chunkUpdate.message_id);
                }
            } else {
                if (!view) {
                    view = new AssistantMessageView();
                    view.setMessageId(chunkUpdate.message_id);
                    view.throttleMsProvider = () => this.getMdRenderThrottleMs();
                    this.messageIdToAssistantView.set(chunkUpdate.message_id, view);
                    this.messages.push(view);
                    this.messageLayout.addChild(view);
                }
                await view.replace(chunkUpdate);
            }
        } else if (chunkUpdate.type === 'retry') {
            if (chunkUpdate.status === 'cleared') {
                if (this.retryStatusView) {
                    this.messageLayout.removeChild(this.retryStatusView);
                    this.messages = this.messages.filter((message) => message !== this.retryStatusView);
                    this.retryStatusView = undefined;
                }
            } else if (this.retryStatusView) {
                this.retryStatusView.update(chunkUpdate);
            } else {
                this.retryStatusView = new RetryStatusView(chunkUpdate);
                this.messages.push(this.retryStatusView);
                this.messageLayout.addChild(this.retryStatusView);
            }
            this.onRetryStateChange?.(chunkUpdate);
        } else {
            let view = this.messageIdToAssistantView.get(chunkUpdate.message_id);
            if (!view) {
                view = new AssistantMessageView();
                view.setMessageId(chunkUpdate.message_id);
                view.throttleMsProvider = () => this.getMdRenderThrottleMs();
                this.messageIdToAssistantView.set(chunkUpdate.message_id, view);
                this.messages.push(view);
                this.messageLayout.addChild(view);
            }
            await view.update(chunkUpdate);
        }
        this.invalidated = true;
        if (chunkUpdate.type === 'assistant' && chunkUpdate.usage) {
            this.onStatusBarUpdate?.({ totalTokens: chunkUpdate.usage.total_tokens });
        }
    }

    /**
     * 从当前 taskState 的 chat_context 重建历史消息视图。
     * 切换任务时调用：先 clearMessages()，再 rebuildFromHistory()。
     */
    rebuildFromHistory() {
        if (!this.taskState) return;

        this.currentTaskId = this.taskState.task_id;
        this.messageIdToAssistantView.clear();

        for (const msg of this.taskState.chat_context.messages) {
            if (isCompactBoundaryMessage(msg)) {
                const view = new CompactBoundaryView();
                this.messages.push(view);
                this.messageLayout.addChild(view);
            } else if (msg instanceof UserMessage) {
                const view = new UserMessageView(msg);
                this.messages.push(view);
                this.messageLayout.addChild(view);
            } else if (msg instanceof AssistantMessage) {
                const view = new AssistantMessageView();
                view.setMessageId(msg.message_id);
                view.throttleMsProvider = () => this.getMdRenderThrottleMs();
                this.messageIdToAssistantView.set(msg.message_id, view);
                for (let i = 0; i < msg.content.length; i++) {
                    const part = msg.content[i];
                    switch (part.type) {
                        case 'text':
                            view.updateTextPart(i, part);
                            break;
                        case 'reasoning':
                            view.updateReasoningPart(i, part);
                            break;
                        case 'tool_call':
                            view.updateToolCallPart(i, part);
                            break;
                        case 'error':
                            view.updateErrorPart(i, part);
                            break;
                    }
                }
                this.messages.push(view);
                this.messageLayout.addChild(view);
            }
        }

        if (this.taskState.chat_context.lastMessage() instanceof AssistantMessage) {
            const lastMsg = this.taskState.chat_context.lastMessage() as AssistantMessage;
            if (lastMsg.usage) {
                this.onStatusBarUpdate?.({ totalTokens: lastMsg.usage.total_tokens });
            }
        }
        this.invalidated = true;
    }

    /**
     * 获取最后一条 AssistantMessageView（如有），用于 re-subscribe 时继续更新
     */
    getLastAssistantView(): AssistantMessageView | undefined {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i] instanceof AssistantMessageView) {
                return this.messages[i] as AssistantMessageView;
            }
        }
        return undefined;
    }

    invalidate() {
        this.messages.forEach((message) => message.invalidate());
        this.invalidated = true;
    }

    render(width: number): string[] {
        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }

        // 流式输出期间自适应节流：距上次实际渲染不足阈值时返回缓存，
        // 避免高频 chunk / spinner interval 导致消息区域渲染风暴。
        // 其他组件（DashboardBar、spinner 等）不受影响，照常渲染。
        // 自适应阈值 = 上次渲染耗时 + renderIntervalMs
        if (this._streaming && this.cachedOutput && this.lastWidth === width) {
            const now = Date.now();
            const throttleMs = this._lastRenderDurationMs + this.renderIntervalMs;
            if (now - this._lastRenderMs < throttleMs) {
                return this.cachedOutput;
            }
            this._lastRenderMs = now;
        }

        this.lastWidth = width;
        const now = Date.now();
        this.cachedOutput = this.mainLayout.render(width);
        this._lastRenderDurationMs = Date.now() - now;
        this.invalidated = false;
        return this.cachedOutput;
    }
}
