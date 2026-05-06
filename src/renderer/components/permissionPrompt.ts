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

function getShortName(resourcePath: string): string {
    if (!resourcePath) return resourcePath;
    const p = resourcePath.replace(/\\/g, '/');
    if (p.endsWith('/')) {
        const parts = p.slice(0, -1).split('/').filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] + '/' : p;
    }
    try {
        const url = new URL(p);
        const pathParts = url.pathname.split('/').filter(Boolean);
        return pathParts.length > 0 ? pathParts[pathParts.length - 1] : url.hostname;
    } catch {
        // not a URL
    }
    const parts = p.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : p;
}

function escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

class PermissionPrompt extends HTMLElement {
    private _visible = false;
    private _requestId: string | null = null;
    private _data: PermissionRequestData | null = null;
    private _countdownTimer: ReturnType<typeof setInterval> | null = null;
    private _remaining = 0;
    private _onRequest = (requestId: string, data: PermissionRequestData) => {
        if (data.taskId && data.taskId !== this._ownTaskId) return;
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
        window.permissionAPI?.onPermissionRequest(this._onRequest);
        window.permissionAPI?.onPermissionDismiss(this._onDismiss);
    }

    disconnectedCallback(): void {
        window.permissionAPI?.offPermissionRequest(this._onRequest);
        window.permissionAPI?.offPermissionDismiss(this._onDismiss);
    }

    private showPrompt(requestId: string, data: PermissionRequestData): void {
        this.stopCountdown();
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

    private hidePrompt(): void {
        this.stopCountdown();
        const panel = this.querySelector<HTMLElement>('#permission-prompt-panel');
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

    private startCountdown(): void {
        this._countdownTimer = setInterval(() => {
            this._remaining--;
            const el = this.querySelector<HTMLElement>('#permission-countdown');
            if (el) {
                el.textContent = `${this._remaining}s 后自动拒绝`;
            }
            if (this._remaining <= 0) {
                this.stopCountdown();
            }
        }, 1000);
    }

    private stopCountdown(): void {
        if (this._countdownTimer !== null) {
            clearInterval(this._countdownTimer);
            this._countdownTimer = null;
        }
    }

    private respond(decision: string, rememberScope: string, selectedPrefixPattern?: string): void {
        if (!this._requestId) return;
        const response: Record<string, unknown> = { decision, rememberScope };
        if (selectedPrefixPattern) {
            response.selectedPrefixPattern = selectedPrefixPattern;
        }
        window.permissionAPI?.respondPermission(this._requestId, response);
        this.hidePrompt();
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

        const shortName = getShortName(first.resourcePath);
        const fullPath = requests.map((r) => r.resourcePath).join(', ');

        const firstPrefix = prefixOptions.length > 0 ? prefixOptions[0] : null;

        const restPrefixButtonsHtml = prefixOptions
            .slice(1)
            .map(
                (opt) => `
            <button
                data-action="prefix"
                data-pattern="${escapeHtml(opt.pattern)}"
                class="permission-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                       bg-blue-50 border border-blue-200 text-blue-700
                       hover:bg-blue-100 hover:border-blue-300 transition-colors duration-150 cursor-pointer">
                <span>始终允许${actionLabel}</span>
                <span class="text-blue-500 font-mono text-[11px]">${escapeHtml(opt.label)}</span>
            </button>`
            )
            .join('');

        this.innerHTML = `
        <div id="permission-prompt-panel"
             class="mb-2 rounded-xl border border-amber-200 bg-gradient-to-b from-amber-50/80 to-white shadow-sm
                    transition-all duration-200 translate-y-4 opacity-0">
            <!-- 标题栏 -->
            <div class="flex items-center gap-2 px-4 py-2.5 border-b border-amber-100">
                <span class="inline-flex items-center justify-center w-6 h-6 rounded-lg bg-amber-100 text-amber-600">
                    <i class="fa-solid fa-shield-halved text-[12px]"></i>
                </span>
                <span class="text-[13px] font-medium text-gray-700">
                    <span class="font-semibold">${escapeHtml(toolName)}</span>
                    <span class="text-gray-500 ml-1">请求${actionLabel}${typeLabel}</span>
                </span>
            </div>

            <!-- 资源路径 -->
            <div class="px-4 py-2 text-[11px] text-gray-400 font-mono flex items-center gap-1.5 border-b border-gray-100">
                <i class="fa-solid fa-file-lines text-[10px] text-gray-300"></i>
                <span class="truncate" title="${escapeHtml(fullPath)}">${escapeHtml(fullPath)}</span>
            </div>

            <!-- 操作按钮 -->
            <div class="px-4 py-3 flex flex-wrap gap-2">
                <button
                    data-action="allow"
                    class="permission-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                           bg-emerald-50 border border-emerald-200 text-emerald-700
                           hover:bg-emerald-100 hover:border-emerald-300 transition-colors duration-150 cursor-pointer">
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
                           bg-blue-50 border border-blue-200 text-blue-700
                           hover:bg-blue-100 hover:border-blue-300 transition-colors duration-150 cursor-pointer">
                    <i class="fa-solid fa-folder-open text-[10px]"></i>
                    始终允许${actionLabel} ${escapeHtml(shortName)}
                </button>`
                        : ''
                }
                <button
                    data-action="deny"
                    class="permission-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                           bg-red-50 border border-red-200 text-red-600
                           hover:bg-red-100 hover:border-red-300 transition-colors duration-150 cursor-pointer">
                    <i class="fa-solid fa-xmark text-[10px]"></i>
                    拒绝
                </button>
                ${restPrefixButtonsHtml}
                <button
                    data-action="allow_type"
                    class="permission-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium
                           bg-white border border-gray-200 text-gray-600
                           hover:bg-gray-50 hover:border-gray-300 transition-colors duration-150 cursor-pointer">
                    <i class="fa-solid fa-unlock text-[10px]"></i>
                    始终允许所有${actionLabel}${typeLabel}操作
                </button>
            </div>

            <!-- 倒计时提示 -->
            <div class="px-4 pb-3">
                <span id="permission-countdown" class="text-[11px] text-gray-400">${this._remaining}s 后自动拒绝</span>
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
