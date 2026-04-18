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
 * 样式与权限确认面板保持一致。用户做出选择后通过 IPC 回传结果。
 *
 * 支持多问题顺序导航：每次显示一个问题，用户回答后自动进入下一题。
 */

interface AskUserOption {
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
            onAskUserDismiss: (callback: (requestId: string) => void) => void;
            respondAskUser: (requestId: string, response: Record<string, unknown>) => void;
        };
    }
}

function escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

class AskUserPrompt extends HTMLElement {
    private _visible = false;
    private _requestId: string | null = null;
    private _data: AskUserRequestData | null = null;
    private _currentQuestionIndex = 0;
    private _answers: Record<number, string[]> = {};
    private _selectedValues: Set<number> = new Set();

    connectedCallback(): void {
        this.renderContent();
        window.askUserAPI?.onAskUserRequest((requestId, data) => {
            this.showPrompt(requestId, data);
        });
        window.askUserAPI?.onAskUserDismiss((requestId) => {
            if (this._requestId === requestId) {
                this.hidePrompt();
            }
        });
    }

    private showPrompt(requestId: string, data: AskUserRequestData): void {
        this._requestId = requestId;
        this._data = data;
        this._visible = true;
        this._currentQuestionIndex = 0;
        this._answers = {};
        this._selectedValues = new Set();
        this.renderContent();

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
        setTimeout(() => {
            this._visible = false;
            this._requestId = null;
            this._data = null;
            this.renderContent();
        }, 200);
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

    private renderContent(): void {
        if (!this._visible || !this._data) {
            this.innerHTML = '';
            return;
        }

        const { questions, taskName } = this._data;
        const q = questions[this._currentQuestionIndex];
        if (!q) {
            this.innerHTML = '';
            return;
        }

        const totalQuestions = questions.length;
        const progressText =
            totalQuestions > 1 ? `问题 ${this._currentQuestionIndex + 1} / ${totalQuestions}` : '请选择';

        const taskBadgeHtml = taskName
            ? `<span class="text-[11px] text-blue-500 bg-blue-50 rounded-md px-2 py-0.5 font-mono truncate max-w-[200px]">${escapeHtml(taskName)}</span>`
            : '';

        const optionsHtml = q.options
            .map((opt, i) => {
                const isSelected = this._selectedValues.has(i);
                const selectedClass = isSelected
                    ? 'bg-blue-50 border-blue-300 ring-1 ring-blue-200'
                    : 'bg-white/60 border-slate-200/80 hover:bg-slate-50/80';
                const checkHtml = q.multiple
                    ? `<div class="flex-shrink-0 w-4 h-4 rounded border ${isSelected ? 'bg-blue-500 border-blue-500' : 'border-slate-300'} flex items-center justify-center">
                        ${isSelected ? '<svg class="w-2.5 h-2.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                       </div>`
                    : `<div class="flex-shrink-0 w-4 h-4 rounded-full border ${isSelected ? 'bg-blue-500 border-blue-500' : 'border-slate-300'}"></div>`;

                return `
                <button
                    data-option-index="${i}"
                    class="ask-option-btn w-full text-left px-3 py-2 rounded-xl border ${selectedClass} transition-all duration-150 active:scale-[0.99] flex items-start gap-2.5"
                >
                    ${checkHtml}
                    <div class="flex-1 min-w-0">
                        <div class="text-[13px] font-medium text-slate-800 leading-tight">${escapeHtml(opt.label)}</div>
                        ${opt.description ? `<div class="text-[11px] text-slate-500 mt-0.5 leading-snug">${escapeHtml(opt.description)}</div>` : ''}
                    </div>
                </button>`;
            })
            .join('');

        const confirmBtnHtml = q.multiple
            ? `<button id="ask-confirm-btn" class="w-full px-3 py-2 rounded-lg text-[13px] font-medium text-white bg-blue-500 hover:bg-blue-600 shadow-sm transition-all duration-150 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed" ${this._selectedValues.size === 0 ? 'disabled' : ''}>
                    确认选择 (${this._selectedValues.size} 项)
                   </button>`
            : '';

        this.innerHTML = `
        <div id="ask-user-panel"
             class="transform translate-y-4 opacity-0 transition-all duration-200 ease-out">
            <div class="rounded-2xl bg-white/85 backdrop-blur-xl shadow-[0_8px_40px_-8px_rgba(0,0,0,0.12)] ring-1 ring-black/[0.06] overflow-hidden">
                <!-- 标题栏 -->
                <div class="flex items-center gap-3 px-4 pt-3.5 pb-2">
                    <div class="flex-shrink-0 w-8 h-8 rounded-xl bg-blue-50 border border-blue-200/60 flex items-center justify-center text-blue-600">
                        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"/>
                            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                            <line x1="12" y1="17" x2="12.01" y2="17"/>
                        </svg>
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="text-[13px] font-semibold text-slate-800">${escapeHtml(progressText)}</div>
                        ${taskBadgeHtml ? `<div class="mt-0.5">${taskBadgeHtml}</div>` : ''}
                    </div>
                    <button id="ask-cancel-btn" class="flex-shrink-0 w-6 h-6 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 flex items-center justify-center transition-colors">
                        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>

                <!-- 分割线 -->
                <div class="mx-4 border-t border-slate-200/60"></div>

                <!-- 问题文本 -->
                <div class="px-4 pt-3 pb-2">
                    <p class="text-[13px] text-slate-700 font-medium leading-snug">${escapeHtml(q.question)}</p>
                    ${q.multiple ? '<p class="text-[11px] text-slate-400 mt-1">可多选</p>' : ''}
                </div>

                <!-- 选项列表 -->
                <div class="px-4 pb-3 flex flex-col gap-1.5">
                    ${optionsHtml}
                    ${confirmBtnHtml}
                </div>
            </div>
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
    }
}

customElements.define('ask-user-prompt', AskUserPrompt);
