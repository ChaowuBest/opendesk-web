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
 * Electron renderer 侧的权限确认浮窗组件。
 *
 * 浮窗通过 IPC 从主进程接收权限请求，仅在本组件所属的 task-view（通过 data-task-id 匹配）中显示。
 * 用户做出选择后通过 IPC 回传结果。
 */

interface PermissionRequestData {
    requests: { resourceType: string; action: string; resourcePath: string }[];
    toolName: string;
    prefixOptions: { label: string; pattern: string }[];
    timeoutSec?: number;
    taskId?: string;
    taskName?: string | null;
    sourceTaskId?: string;
    sourceTaskName?: string | null;
    parentTaskId?: string | null;
    /** 弹窗附加上下文（如沙箱命令的 command），用于展示请求来源 */
    input?: Record<string, unknown> | null;
}

declare global {
    interface Window {
        permissionAPI?: {
            onPermissionRequest: (callback: (requestId: string, data: PermissionRequestData) => void) => void;
            offPermissionRequest: (callback: (requestId: string, data: PermissionRequestData) => void) => void;
            onPermissionDismiss: (callback: (requestId: string) => void) => void;
            offPermissionDismiss: (callback: (requestId: string) => void) => void;
            respondPermission: (requestId: string, response: Record<string, unknown>) => void;
        };
    }
}

const ACTION_LABELS: Record<string, string> = {
    read: '读取',
    write: '编辑',
    execute: '执行',
    access: '访问'
};

const RESOURCE_TYPE_LABELS: Record<string, string> = {
    file: '文件',
    network: '网络',
    skill: '技能'
};

function getShortName(resourcePath: string, resourceType: string): string {
    if (!resourcePath) return resourcePath;
    const p = resourcePath.replace(/\\/g, '/');
    if (p.endsWith('/')) {
        const parts = p.slice(0, -1).split('/').filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] + '/' : p;
    }
    // 文件路径不能按 URL 解析：Windows 盘符会被识别为协议，导致中文编码或 # 后的文件名丢失。
    if (resourceType !== 'file') {
        try {
            const url = new URL(p);
            const pathParts = url.pathname.split('/').filter(Boolean);
            return pathParts.length > 0 ? pathParts[pathParts.length - 1] : url.hostname;
        } catch {
            // not a URL
        }
    }
    const parts = p.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : p;
}

import { escapeHtml } from '../../common/utils/escape.js';

class PermissionPrompt extends HTMLElement {
    private _visible = false;
    private _requestId: string | null = null;
    private _data: PermissionRequestData | null = null;
    private _countdownTimer: ReturnType<typeof setInterval> | null = null;
    private _hideTimer: ReturnType<typeof setTimeout> | null = null;
    private _remaining = 0;
    private _onRequest = (requestId: string, data: PermissionRequestData) => {
        if (data.taskId && data.taskId !== this._ownTaskId) return;
        if (this._visible && this._requestId === requestId) {
            this._data = data;
            this._remaining = data.timeoutSec ?? this._remaining;
            this.updateCountdownLabel();
            return;
        }
        if (this._visible && this._requestId) {
            window.permissionAPI?.respondPermission(this._requestId, { decision: 'deny', rememberScope: 'none' });
        }
        this.showPrompt(requestId, data);
    };
    private _onDismiss = (requestId: string) => {
        if (this._requestId === requestId) {
            this.stopCountdown();
            this.hidePrompt();
        }
    };

    private get _ownTaskId(): string {
        return this.getAttribute('data-task-id') || '';
    }

    connectedCallback(): void {
        this.renderContent();
        window.permissionAPI?.onPermissionDismiss(this._onDismiss);
        window.permissionAPI?.onPermissionRequest(this._onRequest);
    }

    disconnectedCallback(): void {
        // 组件被销毁（任务视图切换/重建）时兜底清除「等待用户输入」标记，
        // 避免 renderer 侧标记残留导致浮窗一直显示「需要操作」。
        if (this._visible) {
            this._notifyWaitingState(false);
        }
        window.permissionAPI?.offPermissionRequest(this._onRequest);
        window.permissionAPI?.offPermissionDismiss(this._onDismiss);
        this.stopCountdown();
        this.clearHideTimer();
    }

    private showPrompt(requestId: string, data: PermissionRequestData): void {
        this.stopCountdown();
        this.clearHideTimer();
        this._requestId = requestId;
        this._data = data;
        this._visible = true;
        this._remaining = data.timeoutSec ?? 300;
        this.renderContent();
        this.startCountdown();

        this._notifyWaitingState(true);

        requestAnimationFrame(() => {
            const panel = this.querySelector<HTMLElement>('#permission-prompt-panel');
            if (panel) {
                panel.classList.remove('translate-y-4', 'opacity-0');
                panel.classList.add('translate-y-0', 'opacity-100');
            }
        });
    }

    private hidePrompt(requestId = this._requestId): void {
        this.stopCountdown();
        const panel = this.querySelector<HTMLElement>('#permission-prompt-panel');
        if (panel) {
            panel.classList.add('translate-y-4', 'opacity-0');
            panel.classList.remove('translate-y-0', 'opacity-100');
        }

        this._notifyWaitingState(false);

        this.clearHideTimer();
        this._hideTimer = setTimeout(() => {
            this._hideTimer = null;
            if (this._requestId !== null && this._requestId !== requestId) {
                return;
            }
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

    private startCountdown(): void {
        this._countdownTimer = setInterval(() => {
            this._remaining--;
            this.updateCountdownLabel();
            if (this._remaining <= 0) {
                this.stopCountdown();
                this.respond('deny', 'none', undefined, 'timeout');
            }
        }, 1000);
    }

    private updateCountdownLabel(): void {
        const el = this.querySelector<HTMLElement>('#permission-countdown');
        if (el) {
            el.textContent = `${this._remaining}s 后自动拒绝`;
        }
    }

    private stopCountdown(): void {
        if (this._countdownTimer !== null) {
            clearInterval(this._countdownTimer);
            this._countdownTimer = null;
        }
    }

    private clearHideTimer(): void {
        if (this._hideTimer !== null) {
            clearTimeout(this._hideTimer);
            this._hideTimer = null;
        }
    }

    private respond(
        decision: string,
        rememberScope: string,
        selectedPrefixPattern?: string,
        denyReason?: string
    ): void {
        const requestId = this._requestId;
        if (!requestId) return;
        this._requestId = null;
        const response: Record<string, unknown> = { decision, rememberScope };
        if (selectedPrefixPattern) {
            response.selectedPrefixPattern = selectedPrefixPattern;
        }
        if (denyReason) {
            response.denyReason = denyReason;
        }
        window.permissionAPI?.respondPermission(requestId, response);
        this.hidePrompt(requestId);
    }

    private renderContent(): void {
        if (!this._visible || !this._data) {
            this.innerHTML = '';
            return;
        }

        const { requests, toolName, prefixOptions } = this._data;
        const first = requests[0];
        const actionLabel = ACTION_LABELS[first.action] || first.action;
        const typeLabel = RESOURCE_TYPE_LABELS[first.resourceType] || first.resourceType;
        const sourceLabel =
            this._data.sourceTaskId && this._data.sourceTaskId !== this._data.taskId
                ? this._data.sourceTaskName || this._data.sourceTaskId
                : '';

        const shortName = getShortName(first.resourcePath, first.resourceType);
        const fullPath = requests.map((r) => r.resourcePath).join(', ');

        // 被执行的命令（沙箱弹窗经 context.input.command 传入）：折叠换行为单行、
        // 超 240 字符截断；title 悬浮查看完整命令
        const commandRaw = typeof this._data.input?.command === 'string' ? (this._data.input.command as string) : '';
        const commandOneLine = commandRaw.replace(/\s*\r?\n\s*/g, ' ').trim();
        const commandShown = commandOneLine.length > 240 ? `${commandOneLine.slice(0, 239)}…` : commandOneLine;

        const firstPrefix = prefixOptions.length > 0 ? prefixOptions[0] : null;

        const restPrefixButtonsHtml = prefixOptions
            .slice(1)
            .map(
                (opt) => `
            <button
                data-action="prefix"
                data-pattern="${escapeHtml(opt.pattern)}"
                class="permission-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                       bg-[var(--chat-blue-soft)] border border-[color-mix(in_srgb,var(--chat-blue)_30%,transparent)] text-[var(--chat-blue)]
                       hover:bg-[color-mix(in_srgb,var(--chat-blue)_22%,transparent)] hover:border-[color-mix(in_srgb,var(--chat-blue)_45%,transparent)]
                       transition-colors duration-150 cursor-pointer">
                <span>始终允许${actionLabel}</span>
                <span class="text-[color-mix(in_srgb,var(--chat-blue)_78%,transparent)] font-mono text-[11px]">${escapeHtml(opt.label)}</span>
            </button>`
            )
            .join('');

        this.innerHTML = `
        <div id="permission-prompt-panel"
             class="mb-2 rounded-xl border shadow-sm
                    bg-[var(--panel-amber-bg)] border-[var(--panel-amber-border)]
                    transition-all duration-200 translate-y-4 opacity-0">
            <!-- 标题栏 -->
            <div class="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--panel-amber-divider)]">
                <span class="inline-flex items-center justify-center w-6 h-6 rounded-lg bg-[color-mix(in_srgb,var(--chat-amber)_16%,transparent)] text-[var(--chat-amber)]">
                    <i class="fa-solid fa-shield-halved text-[12px]"></i>
                </span>
                <span class="text-[13px] font-medium text-[var(--chat-ink2)]">
                    <span class="font-semibold">${escapeHtml(toolName)}</span>
                    <span class="text-[var(--chat-ink3)] ml-1">请求${actionLabel}${typeLabel}</span>
                </span>
                ${
                    sourceLabel
                        ? `<span class="ml-auto min-w-0 max-w-[180px] truncate rounded bg-[color-mix(in_srgb,#a855f7_12%,transparent)] px-1.5 py-0.5 text-[11px] font-medium text-[color-mix(in_srgb,#a855f7_72%,var(--chat-ink))]" title="${escapeHtml(sourceLabel)}">来自 ${escapeHtml(sourceLabel)}</span>`
                        : ''
                }
            </div>

            <!-- 资源路径 -->
            <div class="px-4 py-2 text-[11px] text-[var(--chat-ink4)] font-mono flex items-center gap-1.5 border-b border-[var(--chat-line-soft)]">
                <i class="fa-solid fa-file-lines text-[10px] text-[var(--chat-ink4)] opacity-70"></i>
                <span class="truncate" title="${escapeHtml(fullPath)}">${escapeHtml(fullPath)}</span>
            </div>
            ${
                commandShown
                    ? `
            <!-- 被执行的命令（请求来源） -->
            <div class="px-4 py-2 text-[11px] text-[var(--chat-ink3)] font-mono flex items-center gap-1.5 border-b border-[var(--chat-line-soft)]">
                <i class="fa-solid fa-terminal text-[10px] text-[var(--chat-ink4)] opacity-70"></i>
                <span class="truncate" title="${escapeHtml(commandOneLine)}">${escapeHtml(commandShown)}</span>
            </div>`
                    : ''
            }

            <!-- 操作按钮 -->
            <div class="px-4 py-3 flex flex-wrap gap-2">
                <button
                    data-action="allow"
                    class="permission-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                           bg-[var(--chat-green-soft)] border border-[color-mix(in_srgb,var(--chat-green)_30%,transparent)] text-[var(--chat-green)]
                           hover:bg-[color-mix(in_srgb,var(--chat-green)_22%,transparent)] hover:border-[color-mix(in_srgb,var(--chat-green)_45%,transparent)]
                           transition-colors duration-150 cursor-pointer">
                    <i class="fa-solid fa-check text-[10px]"></i>
                    允许${actionLabel} ${escapeHtml(shortName)}
                </button>
                ${
                    firstPrefix
                        ? `
                <button
                    data-action="prefix"
                    data-pattern="${escapeHtml(firstPrefix.pattern)}"
                    class="permission-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                           bg-[var(--chat-blue-soft)] border border-[color-mix(in_srgb,var(--chat-blue)_30%,transparent)] text-[var(--chat-blue)]
                           hover:bg-[color-mix(in_srgb,var(--chat-blue)_22%,transparent)] hover:border-[color-mix(in_srgb,var(--chat-blue)_45%,transparent)]
                           transition-colors duration-150 cursor-pointer">
                    <i class="fa-solid fa-folder-open text-[10px]"></i>
                    始终允许${actionLabel} ${escapeHtml(shortName)}
                </button>`
                        : ''
                }
                <button
                    data-action="deny"
                    class="permission-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                           bg-[var(--chat-accent-soft)] border border-[color-mix(in_srgb,var(--chat-accent)_30%,transparent)] text-[var(--chat-accent)]
                           hover:bg-[color-mix(in_srgb,var(--chat-accent)_22%,transparent)] hover:border-[color-mix(in_srgb,var(--chat-accent)_45%,transparent)]
                           transition-colors duration-150 cursor-pointer">
                    <i class="fa-solid fa-xmark text-[10px]"></i>
                    拒绝
                </button>
                ${restPrefixButtonsHtml}
                <button
                    data-action="allow_type"
                    class="permission-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                           bg-[var(--od-bg-elevated)] border border-[var(--od-border-strong)] text-[var(--od-text-muted)]
                           hover:bg-[var(--od-bg-muted)] hover:border-[var(--od-text-disabled)] transition-colors duration-150 cursor-pointer">
                    <i class="fa-solid fa-unlock text-[10px]"></i>
                    始终允许所有${actionLabel}${typeLabel}操作
                </button>
            </div>

            <!-- 倒计时提示 -->
            <div class="px-4 pb-3">
                <span id="permission-countdown" class="text-[11px] text-[var(--chat-ink4)]">${this._remaining}s 后自动拒绝</span>
            </div>
        </div>
        `;

        this.querySelectorAll<HTMLButtonElement>('.permission-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                if (action === 'allow') {
                    this.respond('allow', 'none');
                } else if (action === 'deny') {
                    this.respond('deny', 'none');
                } else if (action === 'allow_type') {
                    this.respond('allow', 'type');
                } else if (action === 'prefix') {
                    this.respond('allow', 'prefix', btn.dataset.pattern);
                }
            });
        });
    }
}

customElements.define('permission-prompt', PermissionPrompt);
