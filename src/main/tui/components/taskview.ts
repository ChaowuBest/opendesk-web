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

import {
    Component,
    Markdown,
    Box,
    type TUI,
    visibleWidth,
    truncateToWidth,
    wrapTextWithAnsi
} from '@earendil-works/pi-tui';
import type {
    TaskState,
    TaskUpdateChunk,
    TaskUpdateUserChunk,
    TaskUpdateAssistantChunk,
    TaskUpdateAssistantReplaceChunk,
    TaskUpdateRetryChunk,
    TaskUpdateGoalEvalChunk
} from '../../aikernel/states/tasks';
import {
    AssistantMessage,
    ReasoningMessagePart,
    TextMessagePart,
    ToolCallMessagePart,
    ErrorMessagePart,
    UserMessage,
    isCompactBoundaryMessage,
    ToolCall,
    type UserMessagePart,
    type AssistantMessagePart
} from '../../aikernel/messages';
import { prepareContextForModel } from '../../aikernel/compaction/pipeline.js';
import type { GoalFinalSnapshot } from '../../aikernel/goal/state.js';
import { logger, getDebugMode } from '../../utils/logger.js';
import { Setting } from '../../utils/setting.js';
import { defaultMarkdownTheme } from '../theme';
import { DefaultToolCallView } from './toolcall';
import { Card } from './card';
import { GoalPanel, type GoalPanelData } from './goalpanel.js';
import {
    getGoalSupplementDisplayText,
    shouldRenderGoalUserMessage as shouldRenderTuiUserMessage
} from '../../../common/goal/user-message-display.js';
import { TaskViewGoalController } from './taskview-goal/controller.js';
import {
    getGoalTerminalTimestamp,
    getTerminalGoalPanelData,
    shouldInsertFinalSnapshotAfterMessage,
    shouldInsertGoalSnapshotBeforeMessage
} from './taskview-goal/history-placement.js';
import chalk from 'chalk';
import type { TaskStatusBarData } from './input';
import { t } from '../../../locale/index.js';

const MAX_TUI_PART_INDEX = 10_000;
const USER_MESSAGE_PART_TYPES = new Set(['text', 'image_url', 'file']);
const ASSISTANT_MESSAGE_PART_TYPES = new Set(['text', 'reasoning', 'tool_call', 'error']);

type TaskViewMessage = UserMessageView | AssistantMessageView | CompactBoundaryView | RetryStatusView | GoalPanel;
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isValidPartIndex(index: unknown): index is number {
    return typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 && index < MAX_TUI_PART_INDEX;
}

function getPartType(part: unknown): string | undefined {
    if (!isRecord(part)) return undefined;
    return typeof part.type === 'string' ? part.type : undefined;
}

function isUserMessagePartLike(part: unknown): part is UserMessagePart {
    const partType = getPartType(part);
    return partType !== undefined && USER_MESSAGE_PART_TYPES.has(partType);
}

function isAssistantMessagePartLike(part: unknown): part is AssistantMessagePart {
    const partType = getPartType(part);
    return partType !== undefined && ASSISTANT_MESSAGE_PART_TYPES.has(partType);
}

function normalizeAssistantParts(parts: unknown, context: string): AssistantMessagePart[] | undefined {
    if (!Array.isArray(parts)) {
        logger.warn(`skip invalid assistant parts for ${context}: parts is not an array`);
        return undefined;
    }
    const normalized: AssistantMessagePart[] = [];
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (isAssistantMessagePartLike(part)) {
            normalized.push(part);
        } else {
            logger.warn(
                `skip invalid assistant part for ${context}: index=${i}, type=${getPartType(part) ?? 'unknown'}`
            );
        }
    }
    return normalized;
}

function hasMessageId(chunk: { message_id?: unknown }, context: string): chunk is { message_id: string } {
    if (typeof chunk.message_id === 'string' && chunk.message_id.length > 0) {
        return true;
    }
    logger.warn(`skip ${context} task update chunk without a valid message_id`);
    return false;
}

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
        return setting.data.cli_config?.reason_display === 'full';
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
        const normalizedToolcalls = Array.isArray(toolcalls)
            ? toolcalls.filter((toolcall): toolcall is ToolCall => isRecord(toolcall))
            : [];
        const newSet = new Set(normalizedToolcalls);
        for (const [toolcall, view] of this.viewMap) {
            if (!newSet.has(toolcall)) {
                this.box.removeChild(view);
                this.viewMap.delete(toolcall);
                this.lastRenderedStatuses.delete(toolcall);
            }
        }
        for (const toolcall of normalizedToolcalls) {
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

        const nextRetryAt = typeof this.state.next_retry_at === 'number' ? this.state.next_retry_at : Date.now();
        const attempt = typeof this.state.attempt === 'number' ? this.state.attempt : 0;
        const errorMessage = typeof this.state.error_message === 'string' ? this.state.error_message : '';
        const remainingSeconds = Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000));
        const retryTime = new Date(nextRetryAt).toLocaleTimeString();
        const contentWidth = Math.max(1, width - 4);
        const statusLine =
            this.state.status === 'retrying'
                ? t('task.retry.retrying', { attempt })
                : t('task.retry.scheduled', {
                      attempt,
                      time: retryTime,
                      seconds: remainingSeconds
                  });
        const errorLine = t('task.retry.last_error', { error: errorMessage });
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
        const supplementText = getGoalSupplementDisplayText(message);
        if (supplementText !== undefined) {
            this.box.addChild(new TextMessagePartView(supplementText));
            return;
        }
        const content = Array.isArray(message.content) ? message.content : [];
        for (const part of content) {
            if (!isUserMessagePartLike(part)) {
                logger.warn(
                    `skip invalid user message part while building TUI view: type=${getPartType(part) ?? 'unknown'}`
                );
                continue;
            }
            if (part.type === 'text') {
                this.box.addChild(new TextMessagePartView(typeof part.text === 'string' ? part.text : ''));
            }
        }
    }

    static text(text: string): UserMessageView {
        return new UserMessageView(new UserMessage(text));
    }

    /** 从 TaskUpdateUserChunk 创建用户消息视图（用于“继续任务”等追加的用户消息） */
    static fromChunk(chunk: TaskUpdateUserChunk): UserMessageView | undefined {
        if (!hasMessageId(chunk, 'user')) {
            return undefined;
        }
        if (!isValidPartIndex(chunk.last_part_index) || !isUserMessagePartLike(chunk.last_part)) {
            logger.warn(
                `skip invalid user task update chunk: task=${chunk.task_id}, message=${chunk.message_id}, part_index=${chunk.last_part_index}, type=${getPartType(chunk.last_part) ?? 'unknown'}`
            );
            return undefined;
        }
        const msg = new UserMessage();
        msg.message_id = chunk.message_id;
        msg.content = [chunk.last_part];
        msg.internal = chunk.internal;
        msg.rawText = chunk.rawText;
        msg.metadata = chunk.metadata;
        if (typeof chunk.timestamp === 'number') {
            msg.timestamp = chunk.timestamp;
        }
        return new UserMessageView(msg);
    }

    invalidate() {
        this.box.invalidate();
        this.invalidated = true;
    }

    render(width: number): string[] {
        const supplementText = getGoalSupplementDisplayText(this.message);
        if (!shouldRenderTuiUserMessage(this.message) && !getDebugMode()) {
            return [];
        }
        if (this.message.internal && supplementText === undefined) {
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

    private canApplyPart(index: number, part: AssistantMessagePart, expectedType: string): boolean {
        if (!isValidPartIndex(index) || getPartType(part) !== expectedType) {
            logger.warn(
                `skip invalid assistant message part update: message=${this.currentMessageId ?? 'unknown'}, index=${index}, expected=${expectedType}, actual=${getPartType(part) ?? 'unknown'}`
            );
            return false;
        }
        return true;
    }

    async updateTextPart(index: number, textPart: TextMessagePart) {
        if (!this.canApplyPart(index, textPart, 'text')) return;
        while (index >= this.parts.length) {
            const newPartView = new TextMessagePartView();
            this.parts.push(newPartView);
            this.box.addChild(newPartView);
        }

        const existingPartView = this.parts[index];
        if (!(existingPartView instanceof TextMessagePartView)) {
            logger.warn(`skip text part update because existing TUI part type mismatches at index=${index}`);
            return;
        }

        existingPartView.setMarkdown(typeof textPart.text === 'string' ? textPart.text : '');
        this.invalidated = true;
    }

    async updateReasoningPart(index: number, reasoningPart: ReasoningMessagePart) {
        if (!this.canApplyPart(index, reasoningPart, 'reasoning')) return;
        while (index >= this.parts.length) {
            const newPartView = new ReasoningMessagePartView();
            this.parts.push(newPartView);
            this.box.addChild(newPartView);
        }

        const existingPartView = this.parts[index];
        if (!(existingPartView instanceof ReasoningMessagePartView)) {
            logger.warn(`skip reasoning part update because existing TUI part type mismatches at index=${index}`);
            return;
        }

        existingPartView.setStreaming(true);
        existingPartView.setContent(typeof reasoningPart.content === 'string' ? reasoningPart.content : '');
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
        if (!this.canApplyPart(index, toolCallPart, 'tool_call')) return;
        while (index >= this.parts.length) {
            const newPartView = new ToolCallMessagePartView();
            this.parts.push(newPartView);
            this.box.addChild(newPartView);
        }

        const existingPartView = this.parts[index];
        if (!(existingPartView instanceof ToolCallMessagePartView)) {
            logger.warn(`skip tool_call part update because existing TUI part type mismatches at index=${index}`);
            return;
        }

        existingPartView.setToolcalls(toolCallPart.toolcalls);
        this.invalidated = true;
    }

    async updateErrorPart(index: number, errorPart: ErrorMessagePart) {
        if (!this.canApplyPart(index, errorPart, 'error')) return;
        while (index >= this.parts.length) {
            const newPartView = new ErrorMessagePartView('', '');
            this.parts.push(newPartView);
            this.box.addChild(newPartView);
        }

        const existingPartView = this.parts[index];
        if (!(existingPartView instanceof ErrorMessagePartView)) {
            logger.warn(`skip error part update because existing TUI part type mismatches at index=${index}`);
            return;
        }

        existingPartView.setContent(
            typeof errorPart.title === 'string' ? errorPart.title : '',
            typeof errorPart.message === 'string' ? errorPart.message : ''
        );
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

        if (!isValidPartIndex(chunkUpdate.last_part_index) || !isAssistantMessagePartLike(chunkUpdate.last_part)) {
            logger.warn(
                `skip invalid assistant task update chunk: message=${chunkUpdate.message_id}, part_index=${chunkUpdate.last_part_index}, type=${getPartType(chunkUpdate.last_part) ?? 'unknown'}`
            );
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
        const parts = normalizeAssistantParts(chunkUpdate.parts, `assistant_replace message=${chunkUpdate.message_id}`);
        if (!parts) return;
        this.currentMessageId = chunkUpdate.message_id;
        this.clearParts();
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
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
 * 增量渲染容器：与 Box(0, 0) 行为一致，但在宽度不变时
 * 只对变化的行重新计算 visibleWidth + padding，
 * 不变的行直接从缓存复制。避免每次有一行变化就全量重算 N 行的 visibleWidth。
 */
class IncrementalBox implements Component {
    children: Component[] = [];
    private cache?: { childLines: string[]; width: number; lines: string[] };

    addChild(component: Component): void {
        this.children.push(component);
        this.cache = undefined;
    }

    removeChild(component: Component): void {
        const index = this.children.indexOf(component);
        if (index !== -1) {
            this.children.splice(index, 1);
            this.cache = undefined;
        }
    }

    clear(): void {
        this.children = [];
        this.cache = undefined;
    }

    invalidate(): void {
        this.cache = undefined;
        for (const child of this.children) {
            child.invalidate?.();
        }
    }

    render(width: number): string[] {
        if (this.children.length === 0) return [];

        // 渲染所有 children（大部分返回缓存，开销极低）
        const childLines: string[] = [];
        for (const child of this.children) {
            const lines = child.render(width);
            for (const line of lines) childLines.push(line);
        }

        if (childLines.length === 0) return [];

        const cache = this.cache;

        // 无缓存或宽度变化 → 全量 padding
        if (!cache || cache.width !== width) {
            const result = childLines.map((line) => this.padLine(line, width));
            this.cache = { childLines, width, lines: result };
            return result;
        }

        // 宽度不变 → 增量更新：只对变化行重新 padding
        let firstChanged = -1;
        let lastChanged = -1;
        const oldLen = cache.childLines.length;
        const newLen = childLines.length;
        const minLen = Math.min(oldLen, newLen);

        for (let i = 0; i < minLen; i++) {
            if (cache.childLines[i] !== childLines[i]) {
                if (firstChanged === -1) firstChanged = i;
                lastChanged = i;
            }
        }
        // 新增的行
        if (newLen > oldLen) {
            if (firstChanged === -1) firstChanged = oldLen;
            lastChanged = newLen - 1;
        }
        // 减少的行
        if (newLen < oldLen) {
            if (firstChanged === -1) firstChanged = newLen;
            lastChanged = newLen - 1;
        }

        // 完全无变化（长度也一致）
        if (firstChanged === -1) {
            return cache.lines;
        }

        // 从旧缓存复制，只重算变化范围
        const result = cache.lines.slice(0, newLen);
        while (result.length < newLen) result.push('');
        for (let i = firstChanged; i <= lastChanged; i++) {
            result[i] = this.padLine(childLines[i], width);
        }

        this.cache = { childLines, width, lines: result };
        return result;
    }

    private padLine(line: string, width: number): string {
        const visLen = visibleWidth(line);
        const padNeeded = Math.max(0, width - visLen);
        return padNeeded > 0 ? line + ' '.repeat(padNeeded) : line;
    }
}

/**
 * 任务视图
 * 用于显示任务的对话历史
 */
export class TaskView implements Component {
    taskState?: TaskState;
    messages: TaskViewMessage[] = [];

    /** 用于向外部回传 TaskStatusBar 数据 */
    onStatusBarUpdate?: (data: Partial<TaskStatusBarData>) => void;
    /** 通知外层 TUI 同步临时 /retry 命令 */
    onRetryStateChange?: (chunk: TaskUpdateRetryChunk) => void;
    /** 通知外层 TUI 更新目标评估状态（GoalPanel） */
    onGoalEvalUpdate?: (chunk: TaskUpdateGoalEvalChunk) => void;

    /** 当前任务的ID，用于判断是否仍为活跃任务 */
    private currentTaskId?: string;
    /** 防止 performCompactWithAnimation 重入 */
    private _compacting = false;
    lastCompactErrorMessage?: string;
    /** message_id -> AssistantMessageView，用于按 message_id 追加而非覆盖 */
    private messageIdToUserView: Map<string, UserMessageView> = new Map();
    private messageIdToAssistantView: Map<string, AssistantMessageView> = new Map();
    private readonly goalController: TaskViewGoalController;
    private retryStatusView?: RetryStatusView;

    private tui: TUI;
    private messageLayout: IncrementalBox = new IncrementalBox();
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
        this.renderIntervalMs = renderIntervalMs ?? 100;
        this.goalController = new TaskViewGoalController({
            getTaskState: () => this.taskState,
            appendPendingUserMessage: (text) => this.appendLocalUserMessage(text),
            appendGoalPanel: (view) => this.appendGoalPanelView(view),
            removeGoalManagedView: (view) => this.removeGoalManagedView(view),
            replaceGoalManagedView: (previous, next) => this.replaceGoalManagedView(previous, next),
            placeGoalManagedView: (view, placement) => this.placeGoalManagedView(view, placement),
            findMessageViewById: (messageId) =>
                this.messageIdToAssistantView.get(messageId) ?? this.messageIdToUserView.get(messageId),
            findFirstExternalUserMessageViewAfter: (timestamp) =>
                this.messages.find(
                    (message): message is UserMessageView =>
                        message instanceof UserMessageView &&
                        message.message.internal !== true &&
                        message.message.timestamp > timestamp
                ),
            moveGoalPanelToLayoutEnd: (view) => this.moveGoalPanelToLayoutEnd(view),
            markInvalidated: () => {
                this.invalidated = true;
            }
        });
    }

    /** 兼容既有测试和诊断代码；Goal 面板状态实际由 goalController 持有。 */
    private get goalPanelViews(): Map<string, GoalPanel> {
        return this.goalController.goalPanelViews;
    }

    private get pendingGoalSupplementViews() {
        return this.goalController.pendingSupplements;
    }

    private appendGoalPanelView(view: GoalPanel): void {
        this.messages.push(view);
        this.messageLayout.addChild(view);
        this.invalidated = true;
    }

    private removeGoalManagedView(view: Component): void {
        this.messageLayout.removeChild(view);
        this.messages = this.messages.filter((message) => message !== view);
        this.invalidated = true;
    }

    private replaceGoalManagedView(previous: Component, next: GoalPanel): void {
        const previousMessage = previous as TaskViewMessage;
        const messageIndex = this.messages.indexOf(previousMessage);
        if (messageIndex === -1) {
            this.messages.push(next);
        } else {
            this.messages.splice(messageIndex, 1, next);
        }

        const layoutIndex = this.messageLayout.children.indexOf(previous);
        if (layoutIndex === -1) {
            this.messageLayout.addChild(next);
        } else {
            this.messageLayout.children.splice(layoutIndex, 1, next);
        }
        this.invalidated = true;
    }

    private placeGoalManagedView(view: Component, placement: { after?: Component; before?: Component }): void {
        const placeInCollection = <T extends Component>(collection: T[]): void => {
            const target = view as T;
            const currentIndex = collection.indexOf(target);
            if (currentIndex !== -1) collection.splice(currentIndex, 1);

            if (placement.after) {
                const anchorIndex = collection.indexOf(placement.after as T);
                if (anchorIndex !== -1) {
                    collection.splice(anchorIndex + 1, 0, target);
                    return;
                }
            }
            if (placement.before) {
                const anchorIndex = collection.indexOf(placement.before as T);
                if (anchorIndex !== -1) {
                    collection.splice(anchorIndex, 0, target);
                    return;
                }
            }
            collection.push(target);
        };

        placeInCollection(this.messages);
        placeInCollection(this.messageLayout.children);
        this.invalidated = true;
    }

    private moveGoalPanelToLayoutEnd(view: GoalPanel): void {
        const children = this.messageLayout.children;
        const index = children.indexOf(view);
        if (index !== -1 && index < children.length - 1) {
            children.splice(index, 1);
            children.push(view);
        }
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
    async performCompactWithAnimation(taskState: TaskState | undefined = this.taskState): Promise<boolean> {
        if (!taskState || this._compacting) return false;
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
            const compacted = await taskState.manualCompact();
            if (!compacted) {
                this.lastCompactErrorMessage = 'No compactable context available';
                return false;
            }
            taskState.markCompacted();
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

        const taskState = this.taskState;
        const snapshotTaskId = taskState.task_id;
        const isCurrentTask = () => this.taskState === taskState && this.currentTaskId === snapshotTaskId;
        const stopIfTaskChanged = () => {
            if (isCurrentTask()) return false;
            if (this.currentTaskId === snapshotTaskId) {
                this.currentTaskId = undefined;
                this.clearStreamThrottle();
            }
            return true;
        };
        this.currentTaskId = snapshotTaskId;
        this.startStreaming();
        const model = taskState.ensureValidModelOrFallback();

        const isGoalSupplementInput = this.goalController.isGoalSupplementInput(taskState);

        // 立即将用户消息加入布局，确保第一次渲染时就能看到，
        // 避免输入框清空后、消息出现前的空白帧闪烁
        this.syncGoalPanelForCurrentTask();
        const userView = UserMessageView.text(text);
        this.messageLayout.addChild(userView);
        // 非终态 goal 将 GoalPanel 沉到消息列表末尾；终态 goal 则不动，新消息在其下方
        this.ensureGoalPanelLast();
        this.invalidated = true;

        // 在提交新消息前检查是否需要压缩上下文（TUI 层负责展示动画）
        try {
            const preparation = await prepareContextForModel(taskState.chat_context, model, {
                beforeCompact: () => {
                    logger.info(`Auto-compacting context for task ${taskState.task_id}`);
                },
                autoCompactState: taskState.auto_compact_state,
                microcompactState: taskState.getMicrocompactState(),
                microcompactRequestKind: 'pre_submit_check',
                microcompactTaskRole: taskState.parent_id === null ? 'main' : 'subtask',
                taskId: taskState.task_id,
                executeCompact: async () => {
                    const compacted = await this.performCompactWithAnimation(taskState);
                    if (!compacted) {
                        throw new Error(this.lastCompactErrorMessage ?? 'Context compact failed');
                    }
                }
            });
            if (stopIfTaskChanged()) return;
            if (preparation.autoCompactState) {
                taskState.setAutoCompactState(preparation.autoCompactState);
            }
            if (preparation.microcompactState) {
                taskState.setMicrocompactState(preparation.microcompactState);
            }
            if (preparation.compacted) {
                // 压缩重建后重新添加用户消息视图（此时尚未入 chat_context）
                this.clearMessages({ preserveCommunication: true });
                this.rebuildFromHistory();
                this.messageLayout.addChild(userView);
                this.invalidated = true;
            }
        } catch {
            /* shouldCompact 失败不影响正常流程 */
        }

        if (stopIfTaskChanged()) return;
        const submitResult = await taskState.submitUserMessage(text);
        if (stopIfTaskChanged()) return;
        if (submitResult.status === 'error') {
            this.messageLayout.removeChild(userView);
            this.messages = this.messages.filter((message) => message !== userView);
            await this.showLocalSubmitError(submitResult.messageKey, submitResult.messageArgs);
            this.currentTaskId = undefined;
            this.clearStreamThrottle();
            return;
        }
        if (isGoalSupplementInput) {
            this.goalController.trackSubmittedGoalSupplement(userView, submitResult.supplementId);
        }

        // submitUserMessage 中 preloadSlashSkills 可能已向 assistant_message 写入
        // reasoning + tool_call parts（如 /skillName 预加载）。
        // 这些 parts 的 sendSubscriptionFeedback 在 waitUntilFinished 订阅建立前发出，
        // TUI callback 收不到。此处用原始对象补建 view，确保预加载内容可见且自定义渲染生效。
        const lastMsg = taskState.chat_context.lastMessage();
        const preloadedParts =
            lastMsg instanceof AssistantMessage && Array.isArray(lastMsg.content) ? lastMsg.content : [];
        if (lastMsg instanceof AssistantMessage && preloadedParts.length > 0) {
            let view = this.messageIdToAssistantView.get(lastMsg.message_id);
            if (!view) {
                view = new AssistantMessageView();
                view.setMessageId(lastMsg.message_id);
                view.throttleMsProvider = () => this.getMdRenderThrottleMs();
                this.messageIdToAssistantView.set(lastMsg.message_id, view);
                this.messages.push(view);
                this.messageLayout.addChild(view);
            }
            for (let i = 0; i < preloadedParts.length; i++) {
                if (stopIfTaskChanged()) return;
                const part = preloadedParts[i];
                if (!isAssistantMessagePartLike(part)) {
                    logger.warn(
                        `skip invalid preloaded assistant part in TUI: message=${lastMsg.message_id}, index=${i}, type=${getPartType(part) ?? 'unknown'}`
                    );
                    continue;
                }
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
            // resolveOnStop: stop() 时通过 _stopResolvers 立即 settle 订阅者，
            // 避免旧订阅者在 stop() 后继续接收新消息的 chunk 导致重复消息显示 (#197)
            await taskState.waitUntilFinished(async (chunkUpdate: TaskUpdateChunk) => {
                if (!isCurrentTask()) return;
                await this.handleChunkUpdate(chunkUpdate);
                this.requestStreamRender();
            }, true);
        } finally {
            clearInterval(renderInterval);
            if (isCurrentTask()) {
                this.clearStreamThrottle();
                const lastView = this.getLastAssistantView();
                if (lastView) lastView.setStreamingComplete();
                this.invalidated = true;
                this.tui.requestRender();
            } else {
                stopIfTaskChanged();
            }
        }
    }

    /** 清空消息视图（用于切换任务时），同时重置动态节流阈值 */
    clearMessages(options: { preserveCommunication?: boolean } = {}) {
        if (!options.preserveCommunication) this.clearStreamThrottle();
        this.messageLayout.clear();
        this.messages = [];
        this.messageIdToUserView.clear();
        this.messageIdToAssistantView.clear();
        this.goalController.reset();
        this.retryStatusView = undefined;
        this.currentTaskId = undefined;
        this._dynamicThrottleMs = undefined;
        this.invalidated = true;
    }

    private appendUserMessageView(message: UserMessage): UserMessageView {
        const existing = this.messageIdToUserView.get(message.message_id);
        if (existing) {
            return existing;
        }
        const view = new UserMessageView(message);
        this.messageIdToUserView.set(message.message_id, view);
        this.messages.push(view);
        this.messageLayout.addChild(view);
        this.invalidated = true;
        return view;
    }

    appendLocalUserMessage(text: string): UserMessageView {
        const view = UserMessageView.text(text);
        this.messages.push(view);
        this.messageLayout.addChild(view);
        this.invalidated = true;
        this.tui.requestRender();
        return view;
    }

    appendPendingGoalSupplementMessage(text: string, supplementId?: string): void {
        this.goalController.appendPendingGoalSupplementMessage(text, supplementId);
    }

    syncUserMessageFromHistory(messageId: string): boolean {
        if (!this.taskState || this.messageIdToUserView.has(messageId)) {
            return false;
        }
        for (const message of this.taskState.chat_context.messages) {
            if (message instanceof UserMessage && message.message_id === messageId) {
                this.appendUserMessageView(message);
                this.tui.requestRender();
                return true;
            }
        }
        return false;
    }

    removeLiveGoalPanel(goalId: string): void {
        this.goalController.removeLiveGoalPanel(goalId);
    }

    syncFinalGoalSnapshot(snapshot: GoalFinalSnapshot): boolean {
        return this.goalController.syncFinalGoalSnapshot(snapshot);
    }

    /**
     * 同步或创建指定 goal 的消息列表面板。
     * 每个 goal.id 对应一个 GoalPanel 实例，插入到消息列表中。
     */
    syncGoalPanel(data: GoalPanelData): boolean {
        return this.goalController.syncGoalPanel(data);
    }

    private async showLocalSubmitError(messageKey: string, messageArgs?: Record<string, unknown>): Promise<void> {
        const view = new AssistantMessageView();
        view.setMessageId(`local-submit-error-${crypto.randomUUID()}`);
        await view.updateErrorPart(
            0,
            new ErrorMessagePart(
                t('goal.error.title'),
                t(messageKey, messageArgs as Record<string, string | number> | undefined)
            )
        );
        view.setStreamingComplete();
        this.messages.push(view);
        this.messageLayout.addChild(view);
        this.invalidated = true;
        this.requestStreamRender();
    }

    /** 将已存在的非终态 GoalPanel 移动到 messageLayout 末尾，确保：
     *  - goal 执行中：新消息是 goal 上下文的一部分，GoalPanel 沉到它们下方
     *  - goal 完成后（complete/cleared）：GoalPanel 停在原地，后续新消息出现在其下方 */
    private ensureGoalPanelLast(): void {
        this.goalController.ensureGoalPanelLast();
    }

    private syncGoalPanelForCurrentTask(): boolean {
        return this.goalController.syncGoalPanelForCurrentTask();
    }

    /**
     * 处理单条 TaskUpdateChunk：按 type 追加用户消息或按 message_id 获取/创建助手消息视图并更新。
     * 当 message_id 与当前已有助手消息不一致时创建新容器追加，不抹除已有内容。
     */
    async handleChunkUpdate(chunkUpdate: TaskUpdateChunk) {
        if (!isRecord(chunkUpdate) || typeof chunkUpdate.type !== 'string') {
            logger.warn('skip invalid task update chunk without a valid type');
            return;
        }
        if (chunkUpdate.type === 'user') {
            const view = UserMessageView.fromChunk(chunkUpdate);
            if (!view) return;
            this.goalController.reconcileUserMessage(view.message);
            if (this.messageIdToUserView.has(view.message.message_id)) return;
            this.syncGoalPanelForCurrentTask();
            this.messageIdToUserView.set(view.message.message_id, view);
            this.messages.push(view);
            this.messageLayout.addChild(view);
            // 非终态 goal 将 GoalPanel 沉底；终态则不动
            this.ensureGoalPanelLast();
        } else if (chunkUpdate.type === 'user_replace') {
            // user_replace 仅用于 GUI 中 slash skill 替换后重新渲染，TUI 忽略
        } else if (chunkUpdate.type === 'assistant_replace') {
            if (!hasMessageId(chunkUpdate, 'assistant_replace')) return;
            const parts = normalizeAssistantParts(
                chunkUpdate.parts,
                `assistant_replace message=${chunkUpdate.message_id}`
            );
            if (!parts) return;
            let view = this.messageIdToAssistantView.get(chunkUpdate.message_id);
            if (parts.length === 0) {
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
                    this.ensureGoalPanelLast();
                }
                await view.replace({ ...chunkUpdate, parts });
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
        } else if (chunkUpdate.type === 'assistant') {
            if (!hasMessageId(chunkUpdate, 'assistant')) return;
            let view = this.messageIdToAssistantView.get(chunkUpdate.message_id);
            if (!view) {
                view = new AssistantMessageView();
                view.setMessageId(chunkUpdate.message_id);
                view.throttleMsProvider = () => this.getMdRenderThrottleMs();
                this.messageIdToAssistantView.set(chunkUpdate.message_id, view);
                this.messages.push(view);
                this.messageLayout.addChild(view);
                this.ensureGoalPanelLast();
            }
            await view.update(chunkUpdate);
        } else if (chunkUpdate.type === 'goal_eval') {
            this.onGoalEvalUpdate?.(chunkUpdate);
        } else {
            logger.warn(`skip unsupported task update chunk type: ${chunkUpdate.type}`);
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
        const finalSnapshots = Array.isArray(this.taskState.goal_final_snapshots)
            ? [...this.taskState.goal_final_snapshots]
            : [];
        const pendingFinalSnapshots = new Set(finalSnapshots);
        const terminalGoalPanelData =
            finalSnapshots.length === 0 ? getTerminalGoalPanelData(this.taskState) : undefined;
        const terminalAt =
            terminalGoalPanelData?.goalState && finalSnapshots.length === 0
                ? getGoalTerminalTimestamp(terminalGoalPanelData.goalState)
                : undefined;
        let terminalGoalPanelInserted = false;

        const messages = this.taskState.chat_context.messages;
        for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
            const msg = messages[messageIndex];
            if (
                !terminalGoalPanelInserted &&
                terminalGoalPanelData &&
                shouldInsertGoalSnapshotBeforeMessage(msg, terminalAt)
            ) {
                this.syncGoalPanel(terminalGoalPanelData);
                terminalGoalPanelInserted = true;
            }

            if (isCompactBoundaryMessage(msg)) {
                const view = new CompactBoundaryView();
                this.messages.push(view);
                this.messageLayout.addChild(view);
            } else if (msg instanceof UserMessage) {
                this.appendUserMessageView(msg);
            } else if (msg instanceof AssistantMessage) {
                const view = new AssistantMessageView();
                view.setMessageId(msg.message_id);
                view.throttleMsProvider = () => this.getMdRenderThrottleMs();
                this.messageIdToAssistantView.set(msg.message_id, view);
                const content = Array.isArray(msg.content) ? msg.content : [];
                for (let i = 0; i < content.length; i++) {
                    const part = content[i];
                    if (!isAssistantMessagePartLike(part)) {
                        logger.warn(
                            `skip invalid assistant message part while rebuilding TUI history: message=${msg.message_id}, index=${i}, type=${getPartType(part) ?? 'unknown'}`
                        );
                        continue;
                    }
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

            const nextMessage = messages[messageIndex + 1];
            for (const snapshot of [...pendingFinalSnapshots]) {
                if (shouldInsertFinalSnapshotAfterMessage(msg, messageIndex, nextMessage, snapshot)) {
                    this.syncFinalGoalSnapshot(snapshot);
                    pendingFinalSnapshots.delete(snapshot);
                }
            }
        }

        for (const snapshot of pendingFinalSnapshots) {
            this.syncFinalGoalSnapshot(snapshot);
        }

        if (terminalGoalPanelData && !terminalGoalPanelInserted) {
            this.syncGoalPanel(terminalGoalPanelData);
        }

        if (this.taskState.chat_context.lastMessage() instanceof AssistantMessage) {
            const lastMsg = this.taskState.chat_context.lastMessage() as AssistantMessage;
            if (lastMsg.usage) {
                this.onStatusBarUpdate?.({ totalTokens: lastMsg.usage.total_tokens });
            }
        }
        // 重建结束后确保 GoalPanel 位于消息列表末尾
        this.ensureGoalPanelLast();
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
        this.cachedOutput = this.messageLayout.render(width);
        this._lastRenderDurationMs = Date.now() - now;
        this.invalidated = false;
        return this.cachedOutput;
    }
}
