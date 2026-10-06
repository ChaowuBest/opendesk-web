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
 * Electron renderer 侧的计划审批面板组件。
 *
 * 当主进程的 ExitPlanModeTool 被调用时，通过 IPC 接收请求，
 * 在 task-view 底部显示审批面板，包含操作按钮和"查看完整计划"功能。
 *
 * 支持任务切换后恢复：connectedCallback 时主动查询主进程是否有
 * pending 的审批请求，避免切换任务再切回来时面板丢失。
 */

export interface ExitPlanModeRequestData {
    planContent: string;
    planFilePath: string;
}

declare global {
    interface Window {
        exitPlanModeAPI?: {
            onExitPlanModeRequest: (callback: (requestId: string, data: ExitPlanModeRequestData) => void) => void;
            offExitPlanModeRequest: (callback: (requestId: string, data: ExitPlanModeRequestData) => void) => void;
            onExitPlanModeDismiss: (callback: (requestId: string) => void) => void;
            offExitPlanModeDismiss: (callback: (requestId: string) => void) => void;
            respondExitPlanMode: (requestId: string, response: Record<string, unknown>) => void;
            getPendingRequest: (
                taskId?: string
            ) => Promise<{ requestId: string; planContent: string; planFilePath: string } | null>;
        };
    }
}

import { escapeHtml } from '../../common/utils/escape.js';

class ExitPlanModePrompt extends HTMLElement {
    private _visible = false;
    private _requestId: string | null = null;
    private _data: ExitPlanModeRequestData | null = null;
    private _onRequest = (requestId: string, data: ExitPlanModeRequestData) => {
        this.showPrompt(requestId, data);
    };
    private _onDismiss = (requestId: string) => {
        if (this._requestId === requestId) {
            this.hidePrompt();
        }
    };

    connectedCallback(): void {
        this.renderContent();

        window.exitPlanModeAPI?.onExitPlanModeRequest(this._onRequest);
        window.exitPlanModeAPI?.onExitPlanModeDismiss(this._onDismiss);

        this._checkPendingRequest();
    }

    disconnectedCallback(): void {
        // 组件被销毁（任务视图切换/重建）时兜底清除「等待用户输入」标记，
        // 避免 renderer 侧标记残留导致浮窗一直显示「需要操作」。
        if (this._visible) {
            this._notifyWaitingState(false);
        }
        window.exitPlanModeAPI?.offExitPlanModeRequest(this._onRequest);
        window.exitPlanModeAPI?.offExitPlanModeDismiss(this._onDismiss);
    }

    private async _checkPendingRequest(): Promise<void> {
        try {
            const pending = await window.exitPlanModeAPI?.getPendingRequest?.(this._ownTaskId);
            if (pending && !this._visible) {
                this.showPrompt(pending.requestId, {
                    planContent: pending.planContent,
                    planFilePath: pending.planFilePath
                });
            }
        } catch {
            // 静默忽略
        }
    }

    private get _ownTaskId(): string {
        const id = this.id;
        const match = id.match(/^task-(.+)-exit-plan$/);
        return match ? match[1] : '';
    }

    private showPrompt(requestId: string, data: ExitPlanModeRequestData): void {
        this._requestId = requestId;
        this._data = data;
        this._visible = true;
        this.renderContent();

        this._notifyWaitingState(true);

        requestAnimationFrame(() => {
            const panel = this.querySelector<HTMLElement>('#exit-plan-panel');
            if (panel) {
                panel.classList.remove('translate-y-4', 'opacity-0');
                panel.classList.add('translate-y-0', 'opacity-100');
            }
        });
    }

    private hidePrompt(): void {
        const panel = this.querySelector<HTMLElement>('#exit-plan-panel');
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

    private respond(action: string): void {
        if (!this._requestId) return;
        window.exitPlanModeAPI?.respondExitPlanMode(this._requestId, { action });
        this.hidePrompt();
    }

    private openPlanPreview(): void {
        if (!this._data?.planFilePath) return;

        const taskView = this.closest('task-view') as any;
        if (!taskView) return;

        taskView._ensureRightSidebarOpen();
        const sidebar = taskView._getRightSidebarEl?.();
        if (sidebar && typeof sidebar.openFilePreview === 'function') {
            sidebar.openFilePreview(this._data.planFilePath);
        }
    }

    private renderContent(): void {
        if (!this._visible || !this._data) {
            this.innerHTML = '';
            return;
        }

        const filePath = escapeHtml(this._data.planFilePath);

        this.innerHTML = `
            <div id="exit-plan-panel"
                 class="mb-2 rounded-xl border shadow-sm
                        bg-[var(--chat-amber-soft)] border-[color-mix(in_srgb,var(--chat-amber)_35%,transparent)]
                        transition-all duration-200 translate-y-4 opacity-0">
                <!-- 标题栏 -->
                <div class="flex items-center gap-2 px-4 py-2.5 border-b border-[color-mix(in_srgb,var(--chat-amber)_16%,transparent)]">
                    <span class="inline-flex items-center justify-center w-6 h-6 rounded-lg bg-[color-mix(in_srgb,var(--chat-amber)_16%,transparent)] text-[var(--chat-amber)]">
                        <i class="fa-solid fa-clipboard-check text-[12px]"></i>
                    </span>
                    <span class="text-[13px] font-medium text-[var(--chat-ink2)]">计划审批</span>
                </div>

                <!-- 计划文件路径 -->
                <div class="px-4 py-2 text-[11px] text-[var(--chat-ink4)] font-mono flex items-center gap-1.5 border-b border-[var(--chat-line-soft)]">
                    <i class="fa-solid fa-file-lines text-[10px] text-[var(--chat-ink4)] opacity-70"></i>
                    <span class="truncate">${filePath}</span>
                </div>

                <!-- 操作按钮 -->
                <div class="px-4 py-3 flex flex-wrap gap-2">
                    <button id="exit-plan-btn-preview"
                            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                                   bg-[var(--od-bg-elevated)] border border-[var(--od-border-strong)] text-[var(--od-text-muted)]
                                   hover:bg-[var(--od-bg-muted)] hover:border-[var(--od-text-disabled)] transition-colors duration-150 cursor-pointer">
                        <i class="fa-solid fa-eye text-[10px]"></i>
                        查看完整计划
                    </button>
                    <button id="exit-plan-btn-standard"
                            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                                   bg-[var(--chat-green-soft)] border border-[color-mix(in_srgb,var(--chat-green)_30%,transparent)] text-[var(--chat-green)]
                                   hover:bg-[color-mix(in_srgb,var(--chat-green)_22%,transparent)] hover:border-[color-mix(in_srgb,var(--chat-green)_45%,transparent)] transition-colors duration-150 cursor-pointer">
                        <i class="fa-solid fa-shield-halved text-[10px]"></i>
                        同意计划并在标准模式执行
                    </button>
                    <button id="exit-plan-btn-solo"
                            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                                   bg-[var(--chat-blue-soft)] border border-[color-mix(in_srgb,var(--chat-blue)_30%,transparent)] text-[var(--chat-blue)]
                                   hover:bg-[color-mix(in_srgb,var(--chat-blue)_22%,transparent)] hover:border-[color-mix(in_srgb,var(--chat-blue)_45%,transparent)] transition-colors duration-150 cursor-pointer">
                        <i class="fa-solid fa-bolt text-[10px]"></i>
                        同意计划并在效率模式执行
                    </button>
                    <button id="exit-plan-btn-edit"
                            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                                   bg-[var(--od-bg-elevated)] border border-[var(--od-border-strong)] text-[var(--od-text-muted)]
                                   hover:bg-[var(--od-bg-muted)] hover:border-[var(--od-text-disabled)] transition-colors duration-150 cursor-pointer">
                        <i class="fa-solid fa-pen text-[10px]"></i>
                        继续编辑计划
                    </button>
                </div>

                <!-- 提示信息 -->
                <div class="px-4 pb-3 text-[11px] text-[var(--chat-ink4)] flex items-center gap-1.5">
                    <i class="fa-solid fa-circle-info text-[9px]"></i>
                    <span>如果希望修改或进一步完善计划，可以直接在对话中提出意见</span>
                </div>
            </div>
        `;

        const btnPreview = this.querySelector('#exit-plan-btn-preview');
        const btnStandard = this.querySelector('#exit-plan-btn-standard');
        const btnSolo = this.querySelector('#exit-plan-btn-solo');
        const btnEdit = this.querySelector('#exit-plan-btn-edit');

        btnPreview?.addEventListener('click', () => this.openPlanPreview());
        btnStandard?.addEventListener('click', () => this.respond('execute-standard'));
        btnSolo?.addEventListener('click', () => this.respond('execute-solo'));
        btnEdit?.addEventListener('click', () => this.respond('continue-editing'));
    }
}

customElements.define('exit-plan-mode-prompt', ExitPlanModePrompt);
