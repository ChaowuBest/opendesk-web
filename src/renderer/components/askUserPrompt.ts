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
 * Electron renderer 侧的用户提问面板组件。
 *
 * 面板通过 IPC 从主进程接收问题请求，展示在 task-view 的底部（agent-input 上方），
 * 仅在本组件所属的 task-view（通过 data-task-id 匹配）中显示。
 * 用户做出选择后通过 IPC 回传结果。
 *
 * 支持多问题顺序导航：每次显示一个问题，用户回答后自动进入下一题。
 */

export interface AskUserOption {
    label: string;
    description: string;
}

interface AskUserQuestion {
    question: string;
    header: string;
    options: AskUserOption[];
    multiple?: boolean;
}

interface AskUserRequestData {
    questions: AskUserQuestion[];
    taskId: string;
    taskName: string | null;
}

declare global {
    interface Window {
        askUserAPI?: {
            onAskUserRequest: (callback: (requestId: string, data: AskUserRequestData) => void) => void;
            offAskUserRequest: (callback: (requestId: string, data: AskUserRequestData) => void) => void;
            onAskUserDismiss: (callback: (requestId: string) => void) => void;
            offAskUserDismiss: (callback: (requestId: string) => void) => void;
            respondAskUser: (requestId: string, response: Record<string, unknown>) => void;
        };
    }
}

import { escapeHtml } from '../../common/utils/escape.js';

class AskUserPrompt extends HTMLElement {
    private _visible = false;
    private _requestId: string | null = null;
    private _data: AskUserRequestData | null = null;
    private _currentQuestionIndex = 0;
    private _answers: Record<number, string[]> = {};
    private _selectedValues: Set<number> = new Set();
    private _customInputOpen = false;
    private _onRequest = (requestId: string, data: AskUserRequestData) => {
        if (data.taskId && data.taskId !== this._ownTaskId) return;
        this.showPrompt(requestId, data);
    };
    private _onDismiss = (requestId: string) => {
        if (this._requestId === requestId) {
            this.hidePrompt();
        }
    };

    private get _ownTaskId(): string {
        return this.getAttribute('data-task-id') || '';
    }

    connectedCallback(): void {
        this.renderContent();
        window.askUserAPI?.onAskUserRequest(this._onRequest);
        window.askUserAPI?.onAskUserDismiss(this._onDismiss);
    }

    disconnectedCallback(): void {
        // 组件被销毁（任务视图切换/重建）时兜底清除「等待用户输入」标记，
        // 避免 renderer 侧标记残留导致浮窗一直显示「需要操作」。
        if (this._visible) {
            this._notifyWaitingState(false);
        }
        window.askUserAPI?.offAskUserRequest(this._onRequest);
        window.askUserAPI?.offAskUserDismiss(this._onDismiss);
    }

    private showPrompt(requestId: string, data: AskUserRequestData): void {
        // Normalize: ensure questions is an array with well-formed entries
        if (data?.questions && !Array.isArray(data.questions)) {
            data.questions = [data.questions as any];
        }
        if (data?.questions) {
            for (const q of data.questions) {
                if (!q) continue;
                if (typeof q.question !== 'string') q.question = String(q.question ?? '');
                if (typeof q.header !== 'string') q.header = String(q.header ?? q.question ?? '').slice(0, 30);
                if (!Array.isArray(q.options)) q.options = [];
                for (const opt of q.options) {
                    if (!opt) continue;
                    if (typeof opt.label !== 'string') opt.label = String(opt.label ?? '');
                    if (typeof opt.description !== 'string') opt.description = String(opt.description ?? '');
                }
            }
        }

        this._requestId = requestId;
        this._data = data;
        this._visible = true;
        this._currentQuestionIndex = 0;
        this._answers = {};
        this._selectedValues = new Set();
        this._customInputOpen = false;
        this.renderContent();

        this._notifyWaitingState(true);

        requestAnimationFrame(() => {
            const panel = this.querySelector<HTMLElement>('#ask-user-panel');
            if (panel) {
                panel.classList.remove('translate-y-4', 'opacity-0');
                panel.classList.add('translate-y-0', 'opacity-100');
            }
        });
    }

    private hidePrompt(): void {
        const panel = this.querySelector<HTMLElement>('#ask-user-panel');
        if (panel) {
            panel.classList.add('translate-y-4', 'opacity-0');
            panel.classList.remove('translate-y-0', 'opacity-100');
        }

        this._notifyWaitingState(false);

        setTimeout(() => {
            this._visible = false;
            this._requestId = null;
            this._data = null;
            this.renderContent();
        }, 200);
    }

    private _notifyWaitingState(waiting: boolean): void {
        const taskId = this._ownTaskId;
        if (taskId) {
            document.dispatchEvent(new CustomEvent('task-waiting-state', { detail: { taskId, waiting } }));
        }
    }

    private selectOption(optionIndex: number): void {
        if (!this._data) return;
        const q = this._data.questions[this._currentQuestionIndex];
        if (!q) return;

        if (q.multiple) {
            if (this._selectedValues.has(optionIndex)) {
                this._selectedValues.delete(optionIndex);
            } else {
                this._selectedValues.add(optionIndex);
            }
            // Re-render to show updated selection state
            this.renderContent();
            requestAnimationFrame(() => {
                const panel = this.querySelector<HTMLElement>('#ask-user-panel');
                if (panel) {
                    panel.classList.remove('translate-y-4', 'opacity-0');
                    panel.classList.add('translate-y-0', 'opacity-100');
                }
            });
        } else {
            // Single select: immediately advance
            this._answers[this._currentQuestionIndex] = [q.options[optionIndex].label];
            this.advanceOrSubmit();
        }
    }

    private confirmMultiSelect(): void {
        if (!this._data) return;
        const q = this._data.questions[this._currentQuestionIndex];
        if (!q || this._selectedValues.size === 0) return;

        this._answers[this._currentQuestionIndex] = Array.from(this._selectedValues).map((i) => q.options[i].label);
        this._selectedValues = new Set();
        this.advanceOrSubmit();
    }

    private advanceOrSubmit(): void {
        if (!this._data) return;
        const nextIndex = this._currentQuestionIndex + 1;
        if (nextIndex < this._data.questions.length) {
            this._currentQuestionIndex = nextIndex;
            this.renderContent();
            requestAnimationFrame(() => {
                const panel = this.querySelector<HTMLElement>('#ask-user-panel');
                if (panel) {
                    panel.classList.remove('translate-y-4', 'opacity-0');
                    panel.classList.add('translate-y-0', 'opacity-100');
                }
            });
        } else {
            this.submit();
        }
    }

    private submit(): void {
        if (!this._requestId) return;
        window.askUserAPI?.respondAskUser(this._requestId, {
            answers: this._answers,
            cancelled: false
        });
        this.hidePrompt();
    }

    private cancel(): void {
        if (!this._requestId) return;
        window.askUserAPI?.respondAskUser(this._requestId, {
            answers: {},
            cancelled: true
        });
        this.hidePrompt();
    }

    private goToPrevious(): void {
        if (!this._data || this._currentQuestionIndex <= 0) return;
        this._currentQuestionIndex--;
        this._restoreSelection();
        this.renderContent();
        this._animatePanelIn();
    }

    private goToNext(): void {
        if (!this._data) return;
        const nextIndex = this._currentQuestionIndex + 1;
        if (nextIndex >= this._data.questions.length) return;
        // 仅当前题已回答时才允许前进
        if (!this._answers[this._currentQuestionIndex]) return;
        this._currentQuestionIndex = nextIndex;
        this._restoreSelection();
        this.renderContent();
        this._animatePanelIn();
    }

    private _restoreSelection(): void {
        this._selectedValues = new Set();
        const q = this._data?.questions[this._currentQuestionIndex];
        const ans = this._answers[this._currentQuestionIndex];
        if (q && ans) {
            for (const label of ans) {
                const idx = q.options.findIndex((o) => o.label === label);
                if (idx >= 0) this._selectedValues.add(idx);
            }
        }
    }

    private _animatePanelIn(): void {
        requestAnimationFrame(() => {
            const panel = this.querySelector<HTMLElement>('#ask-user-panel');
            if (panel) {
                panel.classList.remove('translate-y-4', 'opacity-0');
                panel.classList.add('translate-y-0', 'opacity-100');
            }
        });
    }

    private submitCustomInput(text: string): void {
        if (!this._data || !text.trim()) return;
        this._answers[this._currentQuestionIndex] = [text.trim()];
        this._customInputOpen = false;
        this.advanceOrSubmit();
    }

    private renderContent(): void {
        if (!this._visible || !this._data) {
            this.innerHTML = '';
            return;
        }

        const { questions } = this._data;
        const q = questions[this._currentQuestionIndex];
        if (!q) {
            this.innerHTML = '';
            return;
        }

        const totalQuestions = questions.length;
        const hasMultiple = totalQuestions > 1;
        const progressText = hasMultiple ? `问题 ${this._currentQuestionIndex + 1} / ${totalQuestions}` : '';
        const isFirst = this._currentQuestionIndex === 0;
        const isLast = this._currentQuestionIndex >= totalQuestions - 1;
        const hasCurrentAnswer = !!this._answers[this._currentQuestionIndex];

        // 导航按钮（仅多问题时显示）
        const navBtnBase =
            'inline-flex items-center justify-center w-6 h-6 rounded text-[10px] transition-colors duration-150 cursor-pointer';
        const navPrevHtml = hasMultiple
            ? `<button id="ask-prev-btn"
                    class="${navBtnBase} ${isFirst ? 'text-[var(--chat-ink4)] cursor-not-allowed' : 'text-[var(--chat-ink3)] hover:bg-[var(--chat-hover)] hover:text-[var(--chat-ink2)]'}"
                    ${isFirst ? 'disabled' : ''}>
                    <i class="fa-solid fa-chevron-left text-[9px]"></i>
                </button>`
            : '';
        const navNextHtml = hasMultiple
            ? `<button id="ask-next-btn"
                    class="${navBtnBase} ${isLast || !hasCurrentAnswer ? 'text-[var(--chat-ink4)] cursor-not-allowed' : 'text-[var(--chat-ink3)] hover:bg-[var(--chat-hover)] hover:text-[var(--chat-ink2)]'}"
                    ${isLast || !hasCurrentAnswer ? 'disabled' : ''}>
                    <i class="fa-solid fa-chevron-right text-[9px]"></i>
                </button>`
            : '';
        const navButtonsHtml = hasMultiple
            ? `<div class="flex items-center gap-0.5 ml-0.5">${navPrevHtml}${navNextHtml}</div>`
            : '';

        const optionsHtml = q.options
            .map((opt, i) => {
                const isSelected = this._selectedValues.has(i);
                const selectedClass = isSelected
                    ? 'bg-[var(--chat-blue-soft)] border-[color-mix(in_srgb,var(--chat-blue)_55%,transparent)] ring-1 ring-[color-mix(in_srgb,var(--chat-blue)_35%,transparent)]'
                    : 'bg-[var(--od-bg-elevated)] border-[var(--od-border-strong)] hover:bg-[var(--od-bg-muted)] hover:border-[var(--od-text-disabled)]';
                const checkHtml = q.multiple
                    ? `<div class="flex-shrink-0 w-4 h-4 rounded border ${isSelected ? 'bg-[var(--chat-blue)] border-[var(--chat-blue)]' : 'border-[var(--od-text-disabled)]'} flex items-center justify-center">
                        ${isSelected ? '<svg class="w-2.5 h-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                       </div>`
                    : '';

                return `
                <button
                    data-option-index="${i}"
                    class="ask-option-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                           border ${selectedClass} transition-colors duration-150 cursor-pointer">
                    ${checkHtml}
                    <span>${escapeHtml(opt.label)}</span>
                </button>`;
            })
            .join('');

        const confirmBtnHtml = q.multiple
            ? `<button id="ask-confirm-btn"
                    class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                           bg-[var(--chat-blue)] text-white hover:bg-[color-mix(in_srgb,var(--chat-blue)_85%,var(--chat-ink))] border border-[var(--chat-blue)]
                           transition-colors duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    ${this._selectedValues.size === 0 ? 'disabled' : ''}>
                    <i class="fa-solid fa-check text-[10px]"></i>
                    确认选择 (${this._selectedValues.size} 项)
               </button>`
            : '';

        const customInputHtml = this._customInputOpen
            ? `<div class="px-4 pb-3 flex items-center gap-2">
                    <input id="ask-custom-input" type="text" placeholder="输入自定义回答后按 Enter 确认"
                           class="flex-1 px-3 py-1.5 rounded-lg text-[12px] border border-[color-mix(in_srgb,var(--chat-blue)_55%,transparent)] bg-[var(--od-bg-elevated)]
                                  focus:outline-none focus:ring-1 focus:ring-[color-mix(in_srgb,var(--chat-blue)_40%,transparent)] text-[var(--chat-ink2)] placeholder:text-[var(--od-placeholder)]" />
                    <button id="ask-custom-submit"
                            class="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-medium
                                   bg-[var(--chat-blue)] text-white hover:bg-[color-mix(in_srgb,var(--chat-blue)_85%,var(--chat-ink))] border border-[var(--chat-blue)]
                                   transition-colors duration-150 cursor-pointer">
                        <i class="fa-solid fa-paper-plane text-[10px]"></i>
                        发送
                    </button>
               </div>`
            : '';

        this.innerHTML = `
        <div id="ask-user-panel"
             class="mb-2 rounded-xl border shadow-sm
                    bg-[var(--chat-blue-soft)] border-[color-mix(in_srgb,var(--chat-blue)_35%,transparent)]
                    transition-all duration-200 translate-y-4 opacity-0">
            <!-- 标题栏 -->
            <div class="flex items-center gap-2 px-4 py-2.5 border-b border-[color-mix(in_srgb,var(--chat-blue)_16%,transparent)]">
                <span class="inline-flex items-center justify-center w-6 h-6 rounded-lg bg-[color-mix(in_srgb,var(--chat-blue)_16%,transparent)] text-[var(--chat-blue)]">
                    <i class="fa-solid fa-circle-question text-[12px]"></i>
                </span>
                <span class="text-[13px] font-medium text-[var(--chat-ink2)]">需要确认</span>
                ${progressText ? `<span class="text-[11px] text-[color-mix(in_srgb,var(--chat-blue)_75%,transparent)] ml-1">${escapeHtml(progressText)}</span>` : ''}
                ${navButtonsHtml}
                <div class="flex-1"></div>
                <button id="ask-cancel-btn"
                        class="inline-flex items-center justify-center w-5 h-5 rounded text-[var(--chat-ink4)] hover:text-[var(--chat-ink3)] hover:bg-[var(--chat-hover)] transition-colors cursor-pointer">
                    <i class="fa-solid fa-xmark text-[10px]"></i>
                </button>
            </div>

            <!-- 问题文本 -->
            <div class="px-4 py-2 border-b border-[var(--chat-line-soft)]">
                <p class="text-[12px] text-[var(--chat-ink2)] leading-snug">${escapeHtml(q.question)}</p>
                ${q.multiple ? '<p class="text-[11px] text-[var(--chat-ink4)] mt-1">可多选</p>' : ''}
            </div>

            <!-- 选项列表 -->
            <div class="px-4 py-3 flex flex-wrap gap-2">
                ${optionsHtml}
                ${confirmBtnHtml}
                <button id="ask-custom-toggle"
                        class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                               bg-[var(--od-bg-elevated)] border border-dashed border-[var(--od-text-disabled)] text-[var(--chat-ink3)]
                               hover:bg-[var(--od-bg-muted)] hover:border-[var(--chat-ink3)] hover:text-[var(--chat-ink2)]
                               transition-colors duration-150 cursor-pointer">
                    <i class="fa-solid fa-pen-to-square text-[10px]"></i>
                    自定义
                </button>
            </div>

            <!-- 自定义输入区域 -->
            ${customInputHtml}
        </div>
        `;

        // 绑定选项点击
        this.querySelectorAll<HTMLButtonElement>('.ask-option-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.optionIndex ?? '0', 10);
                this.selectOption(idx);
            });
        });

        // 多选确认按钮
        const confirmBtn = this.querySelector<HTMLButtonElement>('#ask-confirm-btn');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                this.confirmMultiSelect();
            });
        }

        // 取消按钮
        const cancelBtn = this.querySelector<HTMLButtonElement>('#ask-cancel-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                this.cancel();
            });
        }

        // 导航按钮（上一个/下一个问题）
        const prevBtn = this.querySelector<HTMLButtonElement>('#ask-prev-btn');
        if (prevBtn) {
            prevBtn.addEventListener('click', () => {
                this.goToPrevious();
            });
        }
        const nextBtn = this.querySelector<HTMLButtonElement>('#ask-next-btn');
        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                this.goToNext();
            });
        }

        const customToggle = this.querySelector<HTMLButtonElement>('#ask-custom-toggle');
        if (customToggle) {
            customToggle.addEventListener('click', () => {
                this._customInputOpen = !this._customInputOpen;
                this.renderContent();
                requestAnimationFrame(() => {
                    const panel = this.querySelector<HTMLElement>('#ask-user-panel');
                    if (panel) {
                        panel.classList.remove('translate-y-4', 'opacity-0');
                        panel.classList.add('translate-y-0', 'opacity-100');
                    }
                    const input = this.querySelector<HTMLInputElement>('#ask-custom-input');
                    input?.focus();
                });
            });
        }

        const customInput = this.querySelector<HTMLInputElement>('#ask-custom-input');
        if (customInput) {
            customInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.isComposing) {
                    e.preventDefault();
                    this.submitCustomInput(customInput.value);
                }
            });
        }

        const customSubmit = this.querySelector<HTMLButtonElement>('#ask-custom-submit');
        if (customSubmit) {
            customSubmit.addEventListener('click', () => {
                const input = this.querySelector<HTMLInputElement>('#ask-custom-input');
                if (input) this.submitCustomInput(input.value);
            });
        }
    }
}

customElements.define('ask-user-prompt', AskUserPrompt);
