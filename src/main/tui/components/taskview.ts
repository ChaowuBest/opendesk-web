
import { Component, Markdown, Box, type TUI, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { TaskState, TaskUpdateChunk, TaskUpdateUserChunk, TaskUpdateAssistantChunk } from "../../aikernel/states/tasks";
import {
    AssistantMessage, ReasoningMessagePart, TextMessagePart,
    ToolCallMessagePart, UserMessage, ToolCall
} from "../../aikernel/messages";
import { shouldCompact, compactContext } from "../../aikernel/compact";
import { logger } from "../../utils/logger.js";
import { defaultMarkdownTheme } from "../theme";
import { DefaultToolCallView } from "./toolcall";
import { Card } from "./card";
import chalk from "chalk";
import type { StatusBarData } from "./input";


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
        } catch (error) {
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

/** 思考/推理内容用卡片展示，内容始终完整显示（不设 maxLines） */
export class ReasoningMessagePartView implements Component {
    private text: Markdown = new Markdown('', 0, 0, defaultMarkdownTheme);
    /** 是否正在流式输出思考内容，用于显示旋转图标 */
    private _streaming = false;
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];

    constructor(text?: string) {
        if (text) {
            this.text.setText(text);
        }
    }

    setMarkdown(markdown: string) {
        this.text.setText(markdown);
        this.invalidated = true;
    }

    setStreaming(streaming: boolean) {
        this._streaming = streaming;
        this.invalidated = true;
    }

    invalidate() {
        this.invalidated = true;
    }

    private getIcon(): string {
        if (!this._streaming) {
            return chalk.dim('◆');
        }
        const idx = Math.floor(Date.now() / REASONING_SPINNER_MS) % REASONING_SPINNER_FRAMES.length;
        return chalk.blueBright(REASONING_SPINNER_FRAMES[idx]);
    }

    render(width: number): string[] {
        if (this._streaming) {
            // When streaming, always re-render to update spinner
            const contentWidth = Math.max(1, width - 4);
            const bodyLines = this.text.render(contentWidth);
            const card = new Card({
                icon: this.getIcon(),
                title: '思考',
                body: bodyLines,
            });
            return card.render(width);
        }

        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }

        this.lastWidth = width;
        const contentWidth = Math.max(1, width - 4);
        const bodyLines = this.text.render(contentWidth);
        const card = new Card({
            icon: this.getIcon(),
            title: '思考',
            body: bodyLines,
        });
        this.cachedOutput = card.render(width);
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

    constructor(toolCall: ToolCall) {
        this.toolCall = toolCall;
        this.defaultView = new DefaultToolCallView(toolCall);
    }

    invalidate() {
        this.invalidated = true;
    }

    render(width: number): string[] {
        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }
        this.lastWidth = width;

        if (this.toolCall.tool && typeof this.toolCall.tool.renderToolCallCli === 'function') {
            const custom = this.toolCall.tool.renderToolCallCli(this.toolCall, width);
            if (custom) {
                this.cachedOutput = custom;
                this.invalidated = false;
                return custom;
            }
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

    setToolcalls(toolcalls: ToolCall[]) {
        this.box.clear();
        for (const toolcall of toolcalls) {
            this.box.addChild(new ToolCallView(toolcall));
        }
        this.invalidated = true;
    }

    invalidate() {
        this.box.invalidate();
        this.invalidated = true;
    }

    render(width: number): string[] {
        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }
        this.lastWidth = width;
        this.cachedOutput = this.box.render(width);
        this.invalidated = false;
        return this.cachedOutput;
    }
}

const COMPACT_SPINNER_FRAMES = ['◐', '◓', '◑', '◒'];
const COMPACT_SPINNER_MS = 120;

/**
 * 上下文压缩分隔线视图。
 * - 静态模式：渲染为一条带 ✂ 的水平分隔线
 * - loading 模式：渲染为带旋转动画的"正在压缩…"提示
 */
export class CompactSeparatorView implements Component {
    private _loading = false;
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];

    setLoading(loading: boolean) {
        this._loading = loading;
        this.invalidated = true;
    }

    invalidate() { this.invalidated = true; }

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
            return ['', this.buildLine(` ${icon} 正在压缩上下文... `, width), ''];
        }

        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }
        this.lastWidth = width;
        this.cachedOutput = ['', this.buildLine(' ✂ 上下文已压缩 ', width), ''];
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
        this.box.setBgFn((text: string) => chalk.white.bgGrey((text)));
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
        return new UserMessageView(msg);
    }

    invalidate() {
        this.box.invalidate();
        this.invalidated = true;
    }

    render(width: number): string[] {
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
    parts: Array<ReasoningMessagePartView | TextMessagePartView | ToolCallMessagePartView> = [];
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
            throw new Error(`part type mismatch`)
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
            throw new Error(`part type mismatch`)
        }

        existingPartView.setStreaming(true);
        existingPartView.setMarkdown(reasoningPart.content);
        this.invalidated = true;
    }

    /** 思考/流式结束，停止所有 reasoning 部分的动画 */
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
            throw new Error(`part type mismatch`)
        }

        existingPartView.setToolcalls(toolCallPart.toolcalls);
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

        switch (chunkUpdate.last_part.type) {
            case 'text':
                this.setStreamingComplete();
                return await this.updateTextPart(chunkUpdate.last_part_index, chunkUpdate.last_part);
            case 'reasoning':
                return await this.updateReasoningPart(chunkUpdate.last_part_index, chunkUpdate.last_part);
            case 'tool_call':
                this.setStreamingComplete();
                return await this.updateToolCallPart(chunkUpdate.last_part_index, chunkUpdate.last_part);
        }
    }

    invalidate() {
        this.box.invalidate();
        this.invalidated = true;
    }

    render(width: number): string[] {
        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }
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
    messages: Array<UserMessageView | AssistantMessageView | CompactSeparatorView> = [];

    /** 用于向外部回传 StatusBar 数据 */
    onStatusBarUpdate?: (data: Partial<StatusBarData>) => void;

    /** 当前任务的ID，用于判断是否仍为活跃任务 */
    private currentTaskId?: string;
    /** 防止 performCompactWithAnimation 重入 */
    private _compacting = false;
    /** message_id -> AssistantMessageView，用于按 message_id 追加而非覆盖 */
    private messageIdToAssistantView: Map<string, AssistantMessageView> = new Map();

    private tui: TUI;
    private messageLayout: Box = new Box(0, 0);
    private mainLayout: Box = new Box(0, 0);
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];

    get isCompacting() { return this._compacting; }

    constructor(tui: TUI) {
        this.tui = tui;
        this.mainLayout.addChild(this.messageLayout);
    }

    /**
     * 执行上下文压缩并在消息列表中展示动画。
     * 内置防重入：如果上一次压缩尚未完成，直接返回。
     */
    async performCompactWithAnimation(): Promise<void> {
        if (!this.taskState || this._compacting) return;
        this._compacting = true;

        const indicatorView = new CompactSeparatorView();
        indicatorView.setLoading(true);
        this.messageLayout.addChild(indicatorView);
        this.invalidated = true;

        const spinnerInterval = setInterval(() => {
            this.tui.requestRender();
        }, COMPACT_SPINNER_MS);

        try {
            await compactContext(this.taskState.chat_context, this.taskState.model);
            this.taskState.markCompacted();
        } catch (err: any) {
            logger.warn(`Context compact failed: ${err?.message ?? err}`);
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

        // 在提交新消息前检查是否需要压缩上下文（TUI 层负责展示动画）
        try {
            if (await shouldCompact(this.taskState.chat_context, this.taskState.model)) {
                logger.info(`Auto-compacting context for task ${this.taskState.task_id}`);
                await this.performCompactWithAnimation();
                // 压缩可能插入了 CompactSeparatorMessage，需要重建视图
                this.clearMessages();
                this.rebuildFromHistory();
            }
        } catch { /* shouldCompact 失败不影响正常流程 */ }

        // 记录当前任务的ID
        const snapshotTaskId = this.taskState.task_id;
        this.currentTaskId = snapshotTaskId;

        this.messageLayout.addChild(UserMessageView.text(text));
        this.invalidated = true;

        await this.taskState.submitUserMessage(text);
        const renderInterval = setInterval(() => {
            if (this.currentTaskId === snapshotTaskId) {
                this.tui.requestRender();
            }
        }, REASONING_SPINNER_MS);
        try {
            await this.taskState.waitUntilFinished(async (chunkUpdate: TaskUpdateChunk) => {
                if (this.currentTaskId !== snapshotTaskId) return;
                await this.handleChunkUpdate(chunkUpdate);
                this.tui.requestRender();
            });
        } finally {
            clearInterval(renderInterval);
            if (this.currentTaskId === snapshotTaskId) {
                const lastView = this.getLastAssistantView();
                if (lastView) lastView.setStreamingComplete();
                this.invalidated = true;
                this.tui.requestRender();
            }
        }
    }

    /** 清空消息视图（用于切换任务时） */
    clearMessages() {
        this.messageLayout.clear();
        this.messages = [];
        this.messageIdToAssistantView.clear();
        this.currentTaskId = undefined;
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
        } else {
            let view = this.messageIdToAssistantView.get(chunkUpdate.message_id);
            if (!view) {
                view = new AssistantMessageView();
                view.setMessageId(chunkUpdate.message_id);
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
            if ((msg as any).role === 'compact_separator') {
                const view = new CompactSeparatorView();
                this.messages.push(view);
                this.messageLayout.addChild(view);
            } else if (msg instanceof UserMessage) {
                const view = new UserMessageView(msg);
                this.messages.push(view);
                this.messageLayout.addChild(view);
            } else if (msg instanceof AssistantMessage) {
                const view = new AssistantMessageView();
                view.setMessageId(msg.message_id);
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
        this.messages.forEach(message => message.invalidate());
        this.invalidated = true;
    }

    render(width: number): string[] {
        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }

        this.lastWidth = width;
        this.cachedOutput = this.mainLayout.render(width);
        this.invalidated = false;
        return this.cachedOutput;
    }
}
