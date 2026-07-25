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
 * TUI ExitPlanMode 组件。
 *
 * 当 AI 调用 exitPlanMode 工具时，临时替换输入框，显示完整计划内容和操作选项。
 * 用户可以滚动浏览计划，然后选择执行模式或继续编辑。
 */

import { type Component, getKeybindings, Markdown, visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';
import type { OpenDeskTUI } from '../entry.js';
import type {
    ExitPlanModeProvider,
    ExitPlanModeResponse,
    ExitPlanModeAction
} from '../../aikernel/interaction/exitPlanMode.js';
import { defaultMarkdownTheme } from '../theme.js';
import chalk from 'chalk';

// ─── 配色 ─────────────────────────────────────────────────────────────────────

const planColors = {
    bg: (s: string) => chalk.bgHex('#1a2a1a')(s),
    title: (s: string) => chalk.bgHex('#3d7a38').hex('#ffffff').bold(s),
    filePath: (s: string) => chalk.hex('#7ec8e3')(s),
    optionLabel: (s: string) => chalk.hex('#a8d5a0')(s),
    optionDesc: (s: string) => chalk.hex('#8899aa')(s),
    selected: (s: string) => chalk.hex('#5cbb5c').bold(s),
    scrollInfo: (s: string) => chalk.hex('#7ec8e3')(s),
    hint: (s: string) => chalk.hex('#556677')(s),
    separator: (s: string) => chalk.hex('#2d5a2d')(s)
};

// ─── 选项定义 ─────────────────────────────────────────────────────────────────

interface PlanOption {
    label: string;
    description: string;
    action: ExitPlanModeAction;
}

const PLAN_OPTIONS: PlanOption[] = [
    {
        label: 'Standard 模式执行',
        description: '切换到 Standard 模式，关键操作需要确认',
        action: 'execute-standard'
    },
    {
        label: 'Solo 模式执行',
        description: '切换到 Solo 模式，全自动无人值守执行',
        action: 'execute-solo'
    },
    {
        label: '继续编辑计划',
        description: '返回 Plan Mode 继续修改和完善计划',
        action: 'continue-editing'
    }
];

// ─── ExitPlanModeWidget ──────────────────────────────────────────────────────

export class ExitPlanModeWidget implements Component {
    private highlightedIndex = 0;
    private planContent: string;
    private planFilePath: string;
    private planLines: string[] = [];
    private scrollOffset = 0;
    /** true = 浏览计划, false = 选择选项 */
    private planViewMode = true;
    /** 终端高度，用于动态计算可视行数 */
    terminalHeight = 40;
    /** 来自后台任务时显示的标记 */
    taskBadge: string | null = null;

    private renderCallback?: () => void;

    onDone?: (action: ExitPlanModeAction) => void;
    onCancel?: () => void;

    constructor(planContent: string, planFilePath: string) {
        this.planContent = planContent;
        this.planFilePath = planFilePath;
    }

    setRenderCallback(cb: () => void): void {
        this.renderCallback = cb;
    }

    handleInput(keyData: any): { consume: boolean } | undefined {
        const kb = getKeybindings();

        // Tab 切换计划浏览 / 选项选择
        if (typeof keyData === 'string' && keyData === '\t') {
            this.planViewMode = !this.planViewMode;
            this.invalidate();
            return { consume: true };
        }

        if (this.planViewMode) {
            // 计划浏览模式：上下键滚动
            if (kb.matches(keyData, 'tui.select.up')) {
                this.scrollOffset = Math.max(0, this.scrollOffset - 1);
                this.invalidate();
                return { consume: true };
            }
            if (kb.matches(keyData, 'tui.select.down')) {
                this.scrollOffset = Math.min(Math.max(0, this.planLines.length - 5), this.scrollOffset + 1);
                this.invalidate();
                return { consume: true };
            }
            // Page Up / Page Down
            if (typeof keyData === 'object' && keyData.name === 'pageup') {
                this.scrollOffset = Math.max(0, this.scrollOffset - 10);
                this.invalidate();
                return { consume: true };
            }
            if (typeof keyData === 'object' && keyData.name === 'pagedown') {
                this.scrollOffset = Math.min(Math.max(0, this.planLines.length - 5), this.scrollOffset + 10);
                this.invalidate();
                return { consume: true };
            }
            // Enter 或 Tab 切换到选项模式
            if (kb.matches(keyData, 'tui.select.confirm')) {
                this.planViewMode = false;
                this.invalidate();
                return { consume: true };
            }
            // Esc 取消 = 继续编辑
            if (kb.matches(keyData, 'tui.select.cancel')) {
                this.onCancel?.();
                return { consume: true };
            }
            return undefined;
        }

        // 选项选择模式
        if (kb.matches(keyData, 'tui.select.up')) {
            this.highlightedIndex = this.highlightedIndex === 0 ? PLAN_OPTIONS.length - 1 : this.highlightedIndex - 1;
            this.invalidate();
            return { consume: true };
        }
        if (kb.matches(keyData, 'tui.select.down')) {
            this.highlightedIndex = (this.highlightedIndex + 1) % PLAN_OPTIONS.length;
            this.invalidate();
            return { consume: true };
        }
        if (kb.matches(keyData, 'tui.select.confirm')) {
            this.onDone?.(PLAN_OPTIONS[this.highlightedIndex].action);
            return { consume: true };
        }
        if (kb.matches(keyData, 'tui.select.cancel')) {
            this.onCancel?.();
            return { consume: true };
        }

        return undefined;
    }

    invalidate(): void {
        this.renderCallback?.();
    }

    render(width: number): string[] {
        const c = planColors;
        const bgFn = c.bg;
        const emptyLine = bgFn(' '.repeat(width));

        // 预渲染计划内容（缓存）
        if (this.planLines.length === 0 && this.planContent) {
            const md = new Markdown(this.planContent, 0, 0, defaultMarkdownTheme);
            this.planLines = md.render(Math.max(20, width - 6));
        }

        const lines: string[] = [];
        lines.push(c.separator('─'.repeat(width)));
        lines.push(emptyLine);

        // 标题
        const titleText = ' 📋 计划审批 ';
        lines.push(padBgLine(c.title(titleText), width, bgFn));

        // 后台任务标记
        if (this.taskBadge) {
            const badge = `  [后台任务: ${this.taskBadge}]`;
            lines.push(padBgLine(chalk.hex('#ebcb8b').bold(truncateToWidth(badge, width - 2)), width, bgFn));
        }

        // 文件路径
        const fileInfo = '  文件: ' + this.planFilePath;
        lines.push(padBgLine(c.filePath(truncateToWidth(fileInfo, width - 2)), width, bgFn));
        lines.push(emptyLine);

        // 计划内容区域（可滚动）— 标题/选项等约占 ~15 行，剩余留给计划内容
        const fixedLines = 15;
        const maxPlanLines = Math.max(5, this.terminalHeight - 10 - fixedLines);
        const totalPlanLines = this.planLines.length;
        const visibleStart = this.scrollOffset;
        const visibleEnd = Math.min(visibleStart + maxPlanLines, totalPlanLines);

        if (this.planViewMode) {
            lines.push(padBgLine(c.selected('  ▼ 计划内容 (上下键滚动, Tab 切换到选项, Esc 取消)'), width, bgFn));
        } else {
            lines.push(padBgLine(c.hint('  ▼ 计划内容 (Tab 切换回浏览)'), width, bgFn));
        }
        lines.push(padBgLine(c.separator('  ' + '─'.repeat(Math.min(width - 6, 60))), width, bgFn));

        // 滚动指示器（顶部）
        if (visibleStart > 0) {
            lines.push(padBgLine(c.scrollInfo(`  ↑ 还有 ${visibleStart} 行`), width, bgFn));
        }

        for (let i = visibleStart; i < visibleEnd; i++) {
            const planLine = '  ' + (this.planLines[i] || '');
            lines.push(padBgLine(truncateToWidth(planLine, width - 1), width, bgFn));
        }

        // 滚动指示器（底部）
        const remaining = totalPlanLines - visibleEnd;
        if (remaining > 0) {
            lines.push(padBgLine(c.scrollInfo(`  ↓ 还有 ${remaining} 行`), width, bgFn));
        }

        lines.push(padBgLine(c.separator('  ' + '─'.repeat(Math.min(width - 6, 60))), width, bgFn));
        lines.push(emptyLine);

        // 选项区域
        if (this.planViewMode) {
            lines.push(padBgLine(c.hint('  选择执行方式 (按 Tab 或 Enter 切换到选项):'), width, bgFn));
            for (const opt of PLAN_OPTIONS) {
                const line = c.hint(`    • ${opt.label}`);
                lines.push(padBgLine(line, width, bgFn));
            }
        } else {
            lines.push(padBgLine(c.selected('  选择执行方式:'), width, bgFn));
            for (let i = 0; i < PLAN_OPTIONS.length; i++) {
                const opt = PLAN_OPTIONS[i];
                const isHighlighted = i === this.highlightedIndex;
                const prefix = isHighlighted ? '→ ' : '  ';

                let lineText: string;
                if (isHighlighted) {
                    lineText = c.selected(`  ${prefix}${opt.label}`);
                } else {
                    lineText = c.optionLabel(`  ${prefix}${opt.label}`);
                }

                const descWidth = Math.max(0, width - visibleWidth(`  ${prefix}${opt.label}`) - 6);
                if (descWidth > 10) {
                    lineText += c.optionDesc('  ' + truncateToWidth(opt.description, descWidth));
                }

                lines.push(padBgLine(lineText, width, bgFn));
            }
            lines.push(emptyLine);
            lines.push(padBgLine(c.hint('  Enter 确认，Tab 返回浏览计划，Esc 继续编辑'), width, bgFn));
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

// ─── TUIExitPlanModeProvider ──────────────────────────────────────────────────

/**
 * TUI 环境下的 ExitPlanModeProvider 实现。
 *
 * 使用 ExitPlanModeWidget 在输入框位置显示计划审批界面。
 * 当用户选择执行模式时，自动切换 TUI 的当前模式。
 */
interface QueuedExitPlanModeRequest {
    planContent: string;
    planFilePath: string;
    taskId: string;
    taskName?: string;
    resolve: (response: ExitPlanModeResponse) => void;
}

export class TUIExitPlanModeProvider implements ExitPlanModeProvider {
    private openDeskTUI: OpenDeskTUI;
    private _isPrompting = false;
    private _queue: QueuedExitPlanModeRequest[] = [];

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
    }

    isPrompting(): boolean {
        return this._isPrompting || this._queue.length > 0;
    }

    /**
     * 外部在退出配置/overlay 模式后调用，尝试显示积压的审批弹窗。
     */
    processQueueIfReady(): void {
        if (this._isPrompting || this._queue.length === 0) return;
        if (this.openDeskTUI.isInputBlocked()) return;

        const item = this._queue.shift()!;
        this._showWidget(item);
    }

    async promptAndSwitch(
        planContent: string,
        planFilePath: string,
        taskId?: string,
        taskName?: string
    ): Promise<ExitPlanModeResponse> {
        const effectiveTaskId = taskId || 'unknown';

        return new Promise<ExitPlanModeResponse>((resolve) => {
            this._queue.push({ planContent, planFilePath, taskId: effectiveTaskId, taskName, resolve });

            if (this.openDeskTUI.isInputBlocked()) return;

            this.processQueueIfReady();
        });
    }

    private _showWidget(item: QueuedExitPlanModeRequest): void {
        this._isPrompting = true;

        const widget = new ExitPlanModeWidget(item.planContent, item.planFilePath);
        widget.terminalHeight = this.openDeskTUI.tui.terminal.rows;

        // 如果不是当前活跃任务，标记为后台任务
        const activeTaskId = this.openDeskTUI.getActiveTaskId();
        if (item.taskId !== activeTaskId) {
            widget.taskBadge = item.taskName || item.taskId;
        }

        widget.setRenderCallback(() => {
            this.openDeskTUI.tui.requestRender();
        });

        widget.onDone = async (action) => {
            this.openDeskTUI.inputArea.hidePromptWidget(widget);
            this._isPrompting = false;
            this.openDeskTUI.focusInputAreaIfAvailable();

            if (action === 'execute-standard') {
                await this.openDeskTUI.setMode('standard');
            } else if (action === 'execute-solo') {
                await this.openDeskTUI.setMode('solo');
            }

            this.openDeskTUI.tui.requestRender();
            item.resolve({ action });

            // 处理下一个排队的请求
            this.processQueueIfReady();
        };

        widget.onCancel = () => {
            this.openDeskTUI.inputArea.hidePromptWidget(widget);
            this._isPrompting = false;
            this.openDeskTUI.focusInputAreaIfAvailable();
            this.openDeskTUI.tui.requestRender();
            item.resolve({ action: 'continue-editing' });

            this.processQueueIfReady();
        };

        this.openDeskTUI.inputArea.showPromptWidget(widget);
        this.openDeskTUI.tui.setFocus(widget);
        this.openDeskTUI.tui.requestRender();
    }
}
