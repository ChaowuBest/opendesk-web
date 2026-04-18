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

/**
 * TUI 用户提问组件。
 *
 * 当 AI 调用 askUser 工具时，临时替换输入框，显示问题和选项列表，
 * 让用户做出选择后恢复输入框。
 *
 * 支持多问题顺序导航：每次显示一个问题，用户回答后自动进入下一题。
 * 支持单选和多选模式。
 */

import { type Component, getEditorKeybindings, matchesKey } from '@mariozechner/pi-tui';
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from '@mariozechner/pi-tui';
import type { OpenDeskTUI } from '../entry';
import type {
    AskUserRequest,
    AskUserResponse,
    AskUserProvider,
    AskUserQuestion
} from '../../aikernel/interaction/tools';
import chalk from 'chalk';

// ─── 配色 ─────────────────────────────────────────────────────────────────────

const askColors = {
    bg: (s: string) => chalk.bgHex('#1e2a3a')(s),
    title: (s: string) => chalk.bgHex('#1a6b9a').hex('#ffffff').bold(s),
    taskBadge: (s: string) => chalk.bgHex('#2d4a6a').hex('#7ec8e3').bold(s),
    question: (s: string) => chalk.hex('#e0e8f0').bold(s),
    optionLabel: (s: string) => chalk.hex('#7ec8e3')(s),
    optionDesc: (s: string) => chalk.hex('#8899aa')(s),
    selected: (s: string) => chalk.hex('#5cbb5c').bold(s),
    progress: (s: string) => chalk.hex('#7ec8e3')(s),
    hint: (s: string) => chalk.hex('#556677')(s),
    separator: (s: string) => chalk.hex('#334455')(s)
};

// ─── AskUserWidget ────────────────────────────────────────────────────────────

/**
 * 单个问题的 TUI 交互 widget。
 * 每次只显示一个问题，多问题时由 TUIAskUserProvider 顺序调用。
 * 支持单选和多选模式，支持"其他"选项自定义输入。
 */
export class AskUserWidget implements Component {
    private selectedValues: Set<string> = new Set();
    private highlightedIndex = 0;
    private question: AskUserQuestion;
    private questionIndex: number;
    private totalQuestions: number;
    private taskName: string | null;

    /** 是否处于自定义输入模式（选择"其他"后激活） */
    private customInputMode = false;
    private customInputText = '';
    /** "其他"选项是否为多选（若是单选，Enter 选中后直接进入自定义输入） */
    private customFromMultiple = false;

    /** 渲染回调，由 provider 设置，用于触发 TUI 重新渲染 */
    private renderCallback?: () => void;

    onDone?: (selected: string[]) => void;
    onCancel?: () => void;

    constructor(question: AskUserQuestion, questionIndex: number, totalQuestions: number, taskName: string | null) {
        this.question = question;
        this.questionIndex = questionIndex;
        this.totalQuestions = totalQuestions;
        this.taskName = taskName;
    }

    /** 设置渲染回调 */
    setRenderCallback(cb: () => void): void {
        this.renderCallback = cb;
    }

    /** 拦截按键 */
    handleInput(keyData: any): { consume: boolean } | undefined {
        const kb = this.getKeybindings();
        const opts = this.question.options;
        const lastIndex = opts.length; // "其他"选项的虚拟索引

        // 自定义输入模式
        if (this.customInputMode) {
            // Esc：返回选项列表
            if (kb.matches(keyData, 'selectCancel')) {
                this.customInputMode = false;
                this.customInputText = '';
                this.invalidate();
                return { consume: true };
            }
            // Enter：提交自定义输入
            if (kb.matches(keyData, 'selectConfirm')) {
                if (this.customInputText.trim()) {
                    if (this.customFromMultiple) {
                        // 多选模式：添加自定义输入到已选列表
                        this.selectedValues.add(this.customInputText.trim());
                        const selected = Array.from(this.selectedValues).map((v) => {
                            const idx = Number(v);
                            return isNaN(idx) ? v : opts[idx].label;
                        });
                        this.onDone?.(selected);
                    } else {
                        // 单选模式：直接提交自定义输入
                        this.onDone?.([this.customInputText.trim()]);
                    }
                }
                return { consume: true };
            }
            // 退格键：删除最后一个字符
            if (kb.matches(keyData, 'deleteCharBackward')) {
                this.customInputText = this.customInputText.slice(0, -1);
                this.invalidate();
                return { consume: true };
            }
            // 其他可打印字符：追加到输入
            if (typeof keyData === 'string' && keyData.length === 1) {
                this.customInputText += keyData;
                this.invalidate();
                return { consume: true };
            }
            return undefined;
        }

        // 上下键：切换高亮项
        if (kb.matches(keyData, 'selectUp')) {
            this.highlightedIndex = this.highlightedIndex === 0 ? lastIndex : this.highlightedIndex - 1;
            this.invalidate();
            return { consume: true };
        }
        if (kb.matches(keyData, 'selectDown')) {
            this.highlightedIndex = (this.highlightedIndex + 1) % (lastIndex + 1);
            this.invalidate();
            return { consume: true };
        }

        // 空格键：多选模式下切换当前项的选中状态（不能选"其他"）
        if (this.question.multiple && matchesKey(keyData, 'space')) {
            if (this.highlightedIndex < opts.length) {
                const value = String(this.highlightedIndex);
                if (this.selectedValues.has(value)) {
                    this.selectedValues.delete(value);
                } else {
                    this.selectedValues.add(value);
                }
                this.invalidate();
            }
            return { consume: true };
        }

        // Enter：提交
        if (kb.matches(keyData, 'selectConfirm')) {
            if (this.highlightedIndex === lastIndex) {
                // 选择了"其他"
                if (this.question.multiple) {
                    // 多选模式下，选中"其他"后直接添加自定义输入
                    this.customFromMultiple = true;
                    this.customInputMode = true;
                    this.invalidate();
                } else {
                    // 单选模式下，进入自定义输入模式
                    this.customFromMultiple = false;
                    this.customInputMode = true;
                    this.invalidate();
                }
                return { consume: true };
            }

            if (this.question.multiple) {
                // 多选：至少选一项才能提交
                if (this.selectedValues.size > 0) {
                    const selected = Array.from(this.selectedValues).map((v) => opts[Number(v)].label);
                    this.onDone?.(selected);
                }
            } else {
                // 单选：直接提交高亮项
                const selected = [opts[this.highlightedIndex].label];
                this.onDone?.(selected);
            }
            return { consume: true };
        }

        // Esc：取消
        if (kb.matches(keyData, 'selectCancel')) {
            this.onCancel?.();
            return { consume: true };
        }

        return undefined;
    }

    private getKeybindings() {
        return getEditorKeybindings();
    }

    invalidate(): void {
        this.renderCallback?.();
    }

    render(width: number): string[] {
        const c = askColors;
        const bgFn = c.bg;
        const emptyLine = bgFn(' '.repeat(width));
        const opts = this.question.options;

        const lines: string[] = [];
        lines.push(c.separator('─'.repeat(width)));
        lines.push(emptyLine);

        // 任务标识
        if (this.taskName) {
            const badge = c.taskBadge(` 💬 ${this.taskName} `);
            lines.push(padBgLine(badge, width, bgFn));
        }

        // 标题行（含进度）
        const progressText = this.totalQuestions > 1 ? ` ${this.questionIndex + 1}/${this.totalQuestions} ` : ' 询问 ';
        const titleLine = c.title(progressText);
        lines.push(padBgLine(titleLine, width, bgFn));
        lines.push(emptyLine);

        // 问题文本（自动换行）
        const questionText = c.question('  ' + this.question.question);
        const wrapped = wrapTextWithAnsi(questionText, Math.max(10, width - 2));
        for (const l of wrapped) {
            lines.push(padBgLine(l, width, bgFn));
        }
        lines.push(emptyLine);

        // 自定义输入模式
        if (this.customInputMode) {
            const inputPrompt = c.hint('  请输入您的回答：');
            lines.push(padBgLine(inputPrompt, width, bgFn));

            const inputLine = c.selected('  > ') + c.optionLabel(this.customInputText) + c.hint('_');
            lines.push(padBgLine(inputLine, width, bgFn));

            lines.push(emptyLine);
            lines.push(padBgLine(c.hint('  Enter 确认，Esc 返回'), width, bgFn));
            lines.push(emptyLine);
            return lines;
        }

        // 选项列表
        const lastIndex = opts.length; // "其他"是最后一个选项
        const maxVisible = Math.min(opts.length + 1, 10); // +1 因为有"其他"选项
        const totalItems = opts.length + 1;
        const startIndex = Math.max(
            0,
            Math.min(this.highlightedIndex - Math.floor(maxVisible / 2), totalItems - maxVisible)
        );
        const endIndex = Math.min(startIndex + maxVisible, totalItems);

        for (let i = startIndex; i < endIndex; i++) {
            const isLastOption = i === lastIndex;
            const isHighlighted = i === this.highlightedIndex;
            const isChecked = this.selectedValues.has(String(i));

            let label: string;
            if (isLastOption) {
                label = '其他（请输入）';
            } else {
                label = opts[i].label;
            }

            const checkbox = this.question.multiple ? (isChecked ? c.selected('[×] ') : c.hint('[ ] ')) : '';
            const prefix = isHighlighted ? '→ ' : '  ';

            let lineText: string;
            if (isHighlighted) {
                lineText = c.selected(prefix + checkbox + label);
            } else {
                lineText = c.optionLabel(prefix + checkbox + label);
            }

            if (!isLastOption) {
                const descSingleLine = opts[i].description ? '  ' + opts[i].description : '';
                if (descSingleLine && width > 50) {
                    const labelWidth = visibleWidth(prefix + checkbox + label);
                    const descWidth = Math.max(0, width - labelWidth - 4);
                    const truncatedDesc = truncateToWidth(descSingleLine, descWidth);
                    lineText = lineText + c.optionDesc(truncatedDesc);
                }
            }

            lines.push(padBgLine(lineText, width, bgFn));
        }

        // 滚动提示
        if (totalItems > maxVisible) {
            const scrollInfo = `  (${this.highlightedIndex + 1}/${totalItems})`;
            lines.push(padBgLine(c.hint(scrollInfo), width, bgFn));
        }

        // 提示
        if (this.question.multiple) {
            const selectedLabels = Array.from(this.selectedValues)
                .map((v) => {
                    const idx = Number(v);
                    return isNaN(idx) ? v : opts[idx]?.label;
                })
                .filter(Boolean);
            const hint = c.hint(
                '  空格切换选择，Enter 确认，已选: ' + (selectedLabels.length > 0 ? selectedLabels.join(', ') : '无')
            );
            lines.push(padBgLine(hint, width, bgFn));
        } else {
            lines.push(padBgLine(c.hint('  Enter 确认，Esc 取消'), width, bgFn));
        }

        lines.push(emptyLine);
        return lines;
    }
}

function padBgLine(line: string, width: number, bgFn: (s: string) => string): string {
    const truncated = truncateToWidth(line, width);
    const w = visibleWidth(truncated);
    const pad = Math.max(0, width - w);
    return bgFn(truncated + ' '.repeat(pad));
}

// ─── TUIAskUserProvider ───────────────────────────────────────────────────────

interface QueuedAskRequest {
    request: AskUserRequest;
    resolve: (response: AskUserResponse) => void;
}

/**
 * TUI 环境下的 AskUserProvider 实现。
 *
 * 通过 AgentInputArea 的 showPermissionPrompt/hidePermissionPrompt 方法
 * 在输入框位置显示问题 widget（与权限弹窗共用同一套替换机制）。
 *
 * 内置请求队列：多个并发请求依次弹出，避免焦点冲突。
 */
export class TUIAskUserProvider implements AskUserProvider {
    private openDeskTUI: OpenDeskTUI;
    private queue: QueuedAskRequest[] = [];
    /** 弹窗是否正在显示（widget 已显示且用户未完成交互） */
    private isShowing = false;
    /** 阻塞状态下请求已入队但未处理 */
    private isPending = false;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
    }

    isPrompting(): boolean {
        // 有请求在队列中（无论是正在显示还是等待显示）都应该抑制 taskview 渲染
        return this.isShowing || this.isPending || this.queue.length > 0;
    }

    async prompt(request: AskUserRequest): Promise<AskUserResponse> {
        return new Promise<AskUserResponse>((resolve) => {
            this.queue.push({ request, resolve });
            // 标记有请求待处理，避免 taskview 在此期间渲染 tool card
            this.isPending = true;
            // 配置/overlay 模式下不入队显示，等退出后再处理
            if (this.openDeskTUI.isInputBlocked()) {
                return;
            }
            this.processQueue();
        });
    }

    /**
     * 尝试处理队列（仅在非阻塞状态下才真正显示弹窗）。
     * 供外部在退出配置/overlay 模式后调用。
     */
    processQueueIfReady(): void {
        this.processQueue();
    }

    private processQueue(): void {
        if (this.isShowing || this.queue.length === 0) return;

        // 阻塞状态下不弹窗，等待退出后再处理
        if (this.openDeskTUI.isInputBlocked()) {
            return;
        }

        this.isShowing = true;
        this.isPending = false;
        const item = this.queue.shift()!;
        this.promptSequential(item.request, item.resolve);
    }

    /**
     * 顺序展示所有问题，收集答案后 resolve。
     */
    private async promptSequential(
        request: AskUserRequest,
        resolve: (response: AskUserResponse) => void
    ): Promise<void> {
        const answers: Record<number, string[]> = {};
        const { questions } = request;

        const askQuestion = (index: number): void => {
            if (index >= questions.length) {
                // 所有问题已回答
                this.finishPrompt(resolve, { answers });
                return;
            }

            const q = questions[index];
            const widget = new AskUserWidget(q, index, questions.length, request.taskName);

            widget.setRenderCallback(() => {
                this.openDeskTUI.tui.requestRender();
            });

            widget.onDone = (selected) => {
                answers[index] = selected;
                this.openDeskTUI.inputArea.hidePermissionPrompt();
                // 短暂延迟后显示下一题，避免闪烁
                setTimeout(() => {
                    askQuestion(index + 1);
                }, 50);
            };

            widget.onCancel = () => {
                this.finishPrompt(resolve, { answers, cancelled: true });
            };

            // 复用权限弹窗的 show/hide 机制
            this.openDeskTUI.inputArea.showPermissionPrompt(widget as any);
            this.openDeskTUI.tui.setFocus(widget);
            this.openDeskTUI.tui.requestRender();
        };

        askQuestion(0);
    }

    private finishPrompt(resolve: (response: AskUserResponse) => void, response: AskUserResponse): void {
        this.openDeskTUI.inputArea.hidePermissionPrompt();
        this.isShowing = false;
        resolve(response);

        if (this.queue.length > 0) {
            this.processQueue();
        } else {
            this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
        }
        this.openDeskTUI.tui.requestRender();
    }
}
