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
 * TUI 反馈弹窗组件（输入区 prompt 方式）。
 *
 * 设计要点（与 tui_prompt_queue.md 规范一致）：
 *   - show() 先 deferInputPromptIfBlockedByMode，然后 showPromptWidget + setFocus(this)
 *   - 关闭走 closeInputPrompt + focusAfterInputPromptClose，保证焦点正确归还
 *   - addInputListener 负责：Tab/Shift+Tab 在各控件间切换、提交中吞键、文本控件转发
 *   - addInputListener 在 destroy 时移除，避免残留
 *   - 文本字段使用 pi-tui Input/Editor，自动支持中文、粘贴、光标、退格
 */

import {
    type Component,
    type TUI,
    Input,
    Editor,
    getKeybindings,
    matchesKey,
    visibleWidth,
    truncateToWidth,
    wrapTextWithAnsi,
    Key
} from '@earendil-works/pi-tui';
import type { OpenDeskTUI } from '../entry.js';
import chalk from 'chalk';
import { t } from '../../../locale/index.js';
import type { FeedbackType } from '../../utils/feedback.js';

// ─── 类型 ─────────────────────────────────────────────────────────────────────

export interface FeedbackTaskOption {
    taskId: string;
    name: string;
}

export interface FeedbackSubmitResult {
    status: 'ok' | 'error';
    message?: string;
    id?: number | null;
}

export type FeedbackSubmitter = (submission: {
    type: FeedbackType;
    content: string;
    includeSystemLog: boolean;
    includeTaskJson: boolean;
    taskId: string | null;
}) => Promise<FeedbackSubmitResult>;

export interface FeedbackWidgetOptions {
    submitter: FeedbackSubmitter;
    tasks: FeedbackTaskOption[];
    currentTaskId: string | null;
}

type View = 'home' | 'form' | 'submitting' | 'success';

type FormFocus = 'name' | 'content' | 'checkbox' | 'taskCycler' | 'actions';

// ─── 配色 ─────────────────────────────────────────────────────────────────────

const fbColors = {
    bg: (s: string) => chalk.bgHex('#1e2230')(s),
    title: (s: string) => chalk.bgHex('#3a4a63').hex('#ffffff').bold(s),
    subtitle: (s: string) => chalk.hex('#9fb0c8')(s),
    optionTitle: (s: string) => chalk.hex('#e0e8f0').bold(s),
    optionDesc: (s: string) => chalk.hex('#8899aa')(s),
    action: (s: string) => chalk.hex('#7ec8e3')(s),
    wish: chalk.hex('#3DBF82'),
    bug: chalk.hex('#E2A23B'),
    selected: (s: string) => chalk.hex('#5cbb5c').bold(s),

    // 表单字段聚焦态：参考 config/form.ts —— active 用青色高亮，inactive 灰化
    fieldLabel: (s: string) => chalk.hex('#aab8cc')(s),
    fieldLabelActive: (s: string) => chalk.hex('#7ec8e3').bold(s),
    fieldCaret: (s: string) => chalk.hex('#7ec8e3').bold(s),
    fieldValue: (s: string) => chalk.hex('#e6edf5')(s),
    fieldValueActive: (s: string) => chalk.hex('#ffffff').bold(s),
    fieldInactive: (s: string) => chalk.hex('#5a6b80')(s),
    fieldPlaceholder: (s: string) => chalk.hex('#55607a')(s),
    fieldPlaceholderActive: (s: string) => chalk.hex('#7ec8e3')(s),

    checked: (s: string) => chalk.hex('#5cbb5c').bold(s),
    unchecked: (s: string) => chalk.hex('#8899aa')(s),
    error: (s: string) => chalk.hex('#ff6b6b')(s),
    hint: (s: string) => chalk.hex('#556677')(s),
    separator: (s: string) => chalk.hex('#33415a')(s)
};

const CONTENT_PREVIEW_LINES = 4;

// ─── FeedbackWidget ──────────────────────────────────────────────────────────

export class FeedbackWidget implements Component {
    private openDeskTUI: OpenDeskTUI;
    private options: FeedbackWidgetOptions;
    private tui: TUI;

    // 状态
    private view: View = 'home';
    private homeIndex = 0;
    private formType: FeedbackType = 'feature';

    // 文本控件
    private nameInput: Input;
    private contentEditor: Editor;

    // Checkbox / Task cycler（纯 TUI，不获取焦点，由 addInputListener 转发）
    private checkboxFocus: number = 0; // 0=systemLog, 1=taskJson（仅 bug 表单有）
    private includeSystemLog = true;
    private includeTaskJson = false;
    private taskIndex = 0;

    // 焦点：text 聚焦真实的 Input/Editor；checkbox/taskCycler 由 listener 转发
    private formFocus: FormFocus = 'name';

    // 提交相关
    private submitting = false;
    private closed = false;
    private formError = '';

    // addInputListener 清理函数
    private removeInputListener?: () => void;

    constructor(openDeskTUI: OpenDeskTUI, options: FeedbackWidgetOptions) {
        this.openDeskTUI = openDeskTUI;
        this.options = options;
        this.tui = openDeskTUI.tui;

        // nameInput：仅渲染，不获取 TUI 焦点
        this.nameInput = new Input();
        this.nameInput.onSubmit = () => this.moveToFocus('content');

        // contentEditor：disableSubmit=true，Enter 插入换行；无边框，避免与 widget 背景色冲突
        this.contentEditor = new Editor(this.tui, {
            borderColor: () => '',
            selectList: {}
        });
        this.contentEditor.disableSubmit = true;

        // 默认任务选中
        const currentIdx = options.tasks.findIndex((task) => task.taskId === options.currentTaskId);
        this.taskIndex = currentIdx >= 0 ? currentIdx : 0;
    }

    // ─── Task helpers ──────────────────────────────────────────────────────────

    private get taskOptions(): FeedbackTaskOption[] {
        return this.options.tasks;
    }

    private get selectedTaskId(): string | null {
        if (this.taskOptions.length === 0) return null;
        return this.taskOptions[this.taskIndex]?.taskId ?? null;
    }

    // ─── show / destroy ────────────────────────────────────────────────────────

    show(): void {
        if (this.openDeskTUI.deferInputPromptIfBlockedByMode(() => this.show())) {
            return;
        }
        this.openDeskTUI.inputArea.showPromptWidget(this);
        this.openDeskTUI.hasOpenOverlay = true;
        this.tui.setFocus(this);
        this.installInputListener();
        this.moveToFocus('name');
        this.tui.requestRender();
    }

    private destroy(): void {
        this.removeInputListener?.();
        this.removeInputListener = undefined;
        const restored = this.openDeskTUI.closeInputPrompt(this);
        this.openDeskTUI.focusAfterInputPromptClose(restored);
    }

    private moveHome(): void {
        this.view = 'home';
        this.formError = '';
        this.moveToFocus('name');
        this.tui.requestRender();
    }

    private moveToFocus(target: FormFocus): void {
        // 取消旧焦点
        this.nameInput.focused = false;
        this.contentEditor.focused = false;
        this.formFocus = target;
        if (target === 'name') this.nameInput.focused = true;
        if (target === 'content') this.contentEditor.focused = true;
        this.tui.requestRender();
    }

    // ─── addInputListener：统一键盘路由 ────────────────────────────────────────

    private installInputListener(): void {
        this.removeInputListener = this.tui.addInputListener((data) => this.routeKey(data));
    }

    private routeKey(data: string): { consume: boolean } | undefined {
        if (this.closed) return undefined;

        // ─── submitting 态：吞掉所有输入 ───
        if (this.view === 'submitting') return { consume: true };

        // ─── success 态：Enter / Esc 关闭 ───
        if (this.view === 'success') {
            const kb = getKeybindings();
            if (kb.matches(data, 'tui.select.confirm') || kb.matches(data, 'tui.select.cancel')) {
                this.closed = true;
                this.destroy();
                return { consume: true };
            }
            return { consume: true }; // 成功态吞其余键
        }

        const kb = getKeybindings();

        // ─── 首屏 ───
        if (this.view === 'home') {
            if (kb.matches(data, 'tui.select.up') || kb.matches(data, 'tui.select.down')) {
                this.homeIndex = this.homeIndex === 0 ? 1 : 0;
                this.tui.requestRender();
                return { consume: true };
            }
            if (kb.matches(data, 'tui.select.confirm')) {
                this.openForm(this.homeIndex === 0 ? 'feature' : 'bug');
                return { consume: true };
            }
            if (kb.matches(data, 'tui.select.cancel')) {
                this.closed = true;
                this.destroy();
                return { consume: true };
            }
            return { consume: true };
        }

        // ─── 表单态：全局键 ───
        // Tab / Shift+Tab：切换焦点
        if (matchesKey(data, 'tab')) {
            this.advanceFocus(1);
            return { consume: true };
        }
        if (matchesKey(data, Key.shift('tab'))) {
            this.advanceFocus(-1);
            return { consume: true };
        }
        // Ctrl+S：提交
        if (matchesKey(data, 'ctrl+s')) {
            if (!this.submitting) void this.doSubmit();
            return { consume: true };
        }
        // Esc：取消反馈，直接关闭（首屏/表单一致）
        if (kb.matches(data, 'tui.select.cancel')) {
            this.closed = true;
            this.destroy();
            return { consume: true };
        }

        // ─── 根据当前焦点路由 ───
        if (this.formFocus === 'name') {
            return this.routeToName(data);
        }
        if (this.formFocus === 'content') {
            return this.routeToContent(data);
        }
        if (this.formFocus === 'checkbox') {
            return this.routeCheckbox(data);
        }
        if (this.formFocus === 'taskCycler') {
            return this.routeTaskCycler(data);
        }
        if (this.formFocus === 'actions') {
            return this.routeActions(data);
        }

        return { consume: true };
    }

    // ─── 焦点切换 ──────────────────────────────────────────────────────────────

    private focusOrder(): FormFocus[] {
        const order: FormFocus[] = [];
        if (this.formType === 'feature') order.push('name');
        order.push('content');
        if (this.formType === 'bug') {
            order.push('checkbox');
            if (this.includeTaskJson && this.taskOptions.length > 0) order.push('taskCycler');
        }
        order.push('actions');
        return order;
    }

    private advanceFocus(delta: number): void {
        const order = this.focusOrder();
        const idx = order.indexOf(this.formFocus);
        const next = (idx + delta + order.length) % order.length;
        this.moveToFocus(order[next]);
    }

    // ─── 路由到各控件 ──────────────────────────────────────────────────────────

    private routeToName(data: string): { consume: boolean } {
        this.nameInput.handleInput(data);
        this.tui.requestRender();
        return { consume: true };
    }

    private routeToContent(data: string): { consume: boolean } {
        this.contentEditor.handleInput(data);
        this.tui.requestRender();
        return { consume: true };
    }

    private routeCheckbox(data: string): { consume: boolean } {
        const kb = getKeybindings();
        const checkboxCount = 2;
        if (kb.matches(data, 'tui.select.up') || kb.matches(data, 'tui.editor.cursorLeft')) {
            this.checkboxFocus = (this.checkboxFocus - 1 + checkboxCount) % checkboxCount;
            this.tui.requestRender();
        } else if (kb.matches(data, 'tui.select.down') || kb.matches(data, 'tui.editor.cursorRight')) {
            this.checkboxFocus = (this.checkboxFocus + 1) % checkboxCount;
            this.tui.requestRender();
        } else if (matchesKey(data, 'space') || kb.matches(data, 'tui.select.confirm')) {
            if (this.checkboxFocus === 0) {
                this.includeSystemLog = !this.includeSystemLog;
            } else {
                this.includeTaskJson = !this.includeTaskJson;
            }
            this.tui.requestRender();
        }
        return { consume: true };
    }

    private routeTaskCycler(data: string): { consume: boolean } {
        const kb = getKeybindings();
        const len = this.taskOptions.length;
        if (kb.matches(data, 'tui.select.up') || kb.matches(data, 'tui.editor.cursorLeft')) {
            this.taskIndex = (this.taskIndex - 1 + len) % len;
            this.tui.requestRender();
        } else if (kb.matches(data, 'tui.select.down') || kb.matches(data, 'tui.editor.cursorRight')) {
            this.taskIndex = (this.taskIndex + 1) % len;
            this.tui.requestRender();
        }
        return { consume: true };
    }

    private routeActions(data: string): { consume: boolean } {
        const kb = getKeybindings();
        if (kb.matches(data, 'tui.select.confirm') || matchesKey(data, 'enter') || matchesKey(data, Key.enter)) {
            void this.doSubmit();
        }
        return { consume: true };
    }

    private getActionLabels(): string[] {
        return [t('cli.feedback.submit')];
    }

    // ─── 表单提交 ──────────────────────────────────────────────────────────────

    private openForm(type: FeedbackType): void {
        this.formType = type;
        this.view = 'form';
        this.formError = '';
        this.checkboxFocus = 0;
        this.moveToFocus(type === 'feature' ? 'name' : 'content');
    }

    private async doSubmit(): Promise<void> {
        const content = this.contentEditor.getExpandedText().trim();
        if (!content) {
            this.formError = t('cli.feedback.error.contentRequired');
            this.tui.requestRender();
            return;
        }
        if (this.formType === 'feature') {
            const name = this.nameInput.getValue().trim();
            if (!name) {
                this.formError = t('cli.feedback.error.nameRequired');
                this.tui.requestRender();
                return;
            }
        }

        this.submitting = true;
        this.view = 'submitting';
        this.formError = '';
        this.tui.requestRender();

        const finalContent =
            this.formType === 'feature' ? `${this.nameInput.getValue().trim()}\n\n${content}`.trim() : content;

        const result = await this.options.submitter({
            type: this.formType,
            content: finalContent,
            includeSystemLog: this.formType === 'bug' ? this.includeSystemLog : false,
            includeTaskJson: this.formType === 'bug' ? this.includeTaskJson : false,
            taskId:
                this.formType === 'bug' && this.includeTaskJson
                    ? (this.selectedTaskId ?? this.options.currentTaskId)
                    : null
        });

        if (this.closed) return;
        this.submitting = false;
        if (result.status === 'ok') {
            this.view = 'success';
        } else {
            this.view = 'form';
            this.formError = t('cli.feedback.error.submitFailed', { message: result.message ?? '' });
        }
        this.tui.requestRender();
    }

    // ─── render：所有视图 ──────────────────────────────────────────────────────

    invalidate(): void {
        this.tui.requestRender();
    }

    render(width: number): string[] {
        switch (this.view) {
            case 'home':
                return this.renderHome(width);
            case 'form':
                return this.renderForm(width);
            case 'submitting':
                return this.renderSubmitting(width);
            case 'success':
                return this.renderSuccess(width);
        }
    }

    // ─── 首屏 ──────────────────────────────────────────────────────────────────

    private renderHome(width: number): string[] {
        const c = fbColors;
        const lines: string[] = [];
        lines.push(c.separator('─'.repeat(width)));
        lines.push(padBgLine(c.title(`  ${t('cli.feedback.title')} `), width, c.bg));
        lines.push(padBgLine(c.subtitle(`  ${t('cli.feedback.subtitle')}`), width, c.bg));
        lines.push(padBgLine(' '.repeat(width), width, c.bg));

        const options: Array<{ type: FeedbackType; icon: string; tone: 'wish' | 'bug' }> = [
            { type: 'feature', icon: '💡', tone: 'wish' },
            { type: 'bug', icon: '⚠', tone: 'bug' }
        ];
        options.forEach((opt, idx) => {
            const isHi = idx === this.homeIndex;
            const tone = opt.tone === 'wish' ? c.wish : c.bug;
            const titleKey = opt.type === 'feature' ? 'cli.feedback.wish.title' : 'cli.feedback.bug.title';
            const descKey = opt.type === 'feature' ? 'cli.feedback.wish.desc' : 'cli.feedback.bug.desc';
            const actionKey = opt.type === 'feature' ? 'cli.feedback.wish.action' : 'cli.feedback.bug.action';
            const prefix = isHi ? c.selected('→ ') : '  ';
            const titleText = isHi ? tone.bold(t(titleKey)) : tone(t(titleKey));
            lines.push(padBgLine(prefix + titleText + '  ' + tone(opt.icon), width, c.bg));
            lines.push(padBgLine('   ' + c.optionDesc(t(descKey)), width, c.bg));
            lines.push(padBgLine('   ' + c.action(t(actionKey) + ' →'), width, c.bg));
            if (idx < options.length - 1) lines.push(padBgLine(' '.repeat(width), width, c.bg));
        });

        lines.push(padBgLine(' '.repeat(width), width, c.bg));
        lines.push(padBgLine(c.hint('  ↑↓ 选择，Enter 进入，Esc 退出 '), width, c.bg));
        return lines;
    }

    // ─── 表单 ──────────────────────────────────────────────────────────────────

    private renderForm(width: number): string[] {
        const c = fbColors;
        const lines: string[] = [];
        const isWish = this.formType === 'feature';

        lines.push(c.separator('─'.repeat(width)));
        const headerTitle = t(isWish ? 'cli.feedback.wish.title' : 'cli.feedback.bug.title');
        lines.push(padBgLine(c.title(`  ${t('cli.feedback.title')} · ${headerTitle} `), width, c.bg));
        lines.push(padBgLine(' '.repeat(width), width, c.bg));

        if (isWish) {
            this.renderNameField(lines, width);
        }
        this.renderContentField(lines, width);
        if (!isWish) this.renderCheckboxArea(lines, width);

        if (this.formError) {
            lines.push(padBgLine(' '.repeat(width), width, c.bg));
            lines.push(padBgLine(c.error(`  ${this.formError}`), width, c.bg));
        }

        lines.push(padBgLine(' '.repeat(width), width, c.bg));
        lines.push(this.renderActionRow(width));
        lines.push(padBgLine(c.hint('  Tab/Shift+Tab 切换  │  Ctrl+S 提交  │  Esc 退出 '), width, c.bg));
        return lines;
    }

    private renderNameField(lines: string[], width: number): void {
        const c = fbColors;
        const focused = this.formFocus === 'name';
        const label = focused
            ? c.fieldLabelActive(t('cli.feedback.wish.nameLabel'))
            : c.fieldLabel(t('cli.feedback.wish.nameLabel'));
        lines.push(padBgLine(`  ${focused ? c.fieldCaret('❯ ') : '  '}${label}`, width, c.bg));
        const value = this.nameInput.getValue().trim();
        if (value) {
            const text = focused ? c.fieldValueActive(`  ${value}▏`) : c.fieldInactive(`  ${value}`);
            lines.push(padBgLine(text, width, c.bg));
        } else {
            // TUI 中不展示占位文案（label 已说明用途），聚焦时仅保留光标示意可输入
            const empty = focused ? c.fieldPlaceholderActive('  ▏') : '  ';
            lines.push(padBgLine(empty, width, c.bg));
        }
    }

    private renderContentField(lines: string[], width: number): void {
        const c = fbColors;
        const focused = this.formFocus === 'content';
        const contentLabel = t(
            this.formType === 'feature' ? 'cli.feedback.wish.contentLabel' : 'cli.feedback.bug.contentLabel'
        );
        const label = focused ? c.fieldLabelActive(contentLabel) : c.fieldLabel(contentLabel);
        lines.push(padBgLine(`  ${focused ? c.fieldCaret('❯ ') : '  '}${label}`, width, c.bg));

        // 自行渲染编辑器内容（读 getExpandedText），不直接复用 Editor.render 的 ANSI 输出，
        // 避免其内部 \x1b[0m 重置序列破坏 widget 统一深色背景。
        const text = this.contentEditor.getExpandedText() ?? '';
        const rawLines = text.split('\n');
        const shown = rawLines.slice(0, CONTENT_PREVIEW_LINES);

        if (shown.length === 0) {
            const placeholder = t(
                this.formType === 'feature'
                    ? 'cli.feedback.wish.contentPlaceholder'
                    : 'cli.feedback.bug.contentPlaceholder'
            );
            const hint = focused ? c.fieldPlaceholderActive(`  ${placeholder}▏`) : c.fieldInactive(`  ${placeholder}`);
            lines.push(padBgLine(hint, width, c.bg));
        } else {
            const cursor = this.contentEditor.getCursor();
            shown.forEach((rawLine, idx) => {
                const lineText = rawLine.length > 0 ? rawLine : ' ';
                const isCursorLine = focused && idx === cursor.line;
                const textOverlay = isCursorLine
                    ? c.fieldValueActive(`  ${lineText}▏`)
                    : focused
                      ? c.fieldValue(`  ${lineText}`)
                      : c.fieldInactive(`  ${lineText}`);
                lines.push(padBgLine(textOverlay, width, c.bg));
            });
        }

        if (rawLines.length > CONTENT_PREVIEW_LINES) {
            lines.push(padBgLine(c.hint(`  … (${rawLines.length - CONTENT_PREVIEW_LINES} 行)`), width, c.bg));
        }
    }

    private renderCheckboxArea(lines: string[], width: number): void {
        const c = fbColors;
        lines.push(padBgLine(' '.repeat(width), width, c.bg));
        lines.push(padBgLine(c.fieldLabel(`  ${t('cli.feedback.attachments.label')}`), width, c.bg));

        const items: Array<{ key: string; label: string; checked: boolean }> = [
            { key: 'systemLog', label: t('cli.feedback.attachments.systemLog'), checked: this.includeSystemLog },
            { key: 'taskJson', label: t('cli.feedback.attachments.taskJson'), checked: this.includeTaskJson }
        ];
        items.forEach((item, idx) => {
            const isFocused = this.formFocus === 'checkbox' && this.checkboxFocus === idx;
            const prefix = isFocused ? c.fieldCaret('❯ ') : '  ';
            const box = item.checked ? c.checked('[×]') : c.unchecked('[ ]');
            const itemLabel = isFocused ? c.fieldValueActive(item.label) : c.fieldInactive(item.label);
            lines.push(padBgLine(prefix + box + ' ' + itemLabel, width, c.bg));
        });

        if (this.includeTaskJson && this.taskOptions.length > 0) {
            const isFocused = this.formFocus === 'taskCycler';
            const prefix = isFocused ? c.fieldCaret('❯ ') : '  ';
            const task = this.taskOptions[this.taskIndex];
            const label =
                task.taskId === this.options.currentTaskId
                    ? t('cli.feedback.attachments.taskCurrent', { name: task.name })
                    : task.name;
            const nameLabel = isFocused
                ? c.fieldLabelActive(`${t('cli.feedback.attachments.taskNameLabel')}: `)
                : c.fieldInactive(`${t('cli.feedback.attachments.taskNameLabel')}: `);
            const taskLabel = isFocused
                ? c.fieldValueActive(truncateToWidth(label, Math.max(10, width - 24)))
                : c.fieldInactive(truncateToWidth(label, Math.max(10, width - 24)));
            lines.push(padBgLine(prefix + nameLabel + taskLabel, width, c.bg));
        }
    }

    private renderActionRow(width: number): string {
        const c = fbColors;
        const actions = this.getActionLabels();
        const isFocused = this.formFocus === 'actions';
        const submitText = isFocused ? c.fieldCaret(`❯ ${actions[0]}`) : '  ' + c.fieldInactive(actions[0]);
        const row = `  ${submitText}`;
        return padBgLine(row + ' '.repeat(Math.max(0, width - visibleWidth(row))), width, c.bg);
    }

    // ─── 成功 / 提交中 ────────────────────────────────────────────────────────

    private renderSubmitting(width: number): string[] {
        const c = fbColors;
        return [
            c.separator('─'.repeat(width)),
            padBgLine(c.title(`  ${t('cli.feedback.title')} `), width, c.bg),
            padBgLine(' '.repeat(width), width, c.bg),
            padBgLine(c.subtitle(`  ${t('cli.feedback.submitting')}`), width, c.bg),
            padBgLine(' '.repeat(width), width, c.bg)
        ];
    }

    private renderSuccess(width: number): string[] {
        const c = fbColors;
        const lines: string[] = [];
        lines.push(c.separator('─'.repeat(width)));
        lines.push(padBgLine(c.title(`  ${t('cli.feedback.title')} `), width, c.bg));
        lines.push(padBgLine(' '.repeat(width), width, c.bg));
        lines.push(padBgLine(c.selected(`  ✓ ${t('cli.feedback.success.title')}`), width, c.bg));
        const wrapped = wrapTextWithAnsi(c.subtitle('  ' + t('cli.feedback.success.desc')), Math.max(10, width - 2));
        for (const l of wrapped) {
            lines.push(padBgLine(l, width, c.bg));
        }
        lines.push(padBgLine(' '.repeat(width), width, c.bg));
        lines.push(padBgLine(c.hint('  Enter / Esc 关闭 '), width, c.bg));
        return lines;
    }
}

function padBgLine(line: string, width: number, bgFn: (s: string) => string): string {
    const truncated = truncateToWidth(line, width);
    const w = visibleWidth(truncated);
    const pad = Math.max(0, width - w);
    return bgFn(truncated + ' '.repeat(pad));
}
