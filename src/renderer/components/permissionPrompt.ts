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
 * 浮窗通过 IPC 从主进程接收权限请求，展示在 task-view 的底部（agent-input 上方），
 * 样式参考 macOS 原生弹窗风格。用户做出选择后通过 IPC 回传结果。
 */

interface PermissionRequestData {
    requests: { resourceType: string; action: string; resourcePath: string }[];
    toolName: string;
    prefixOptions: { label: string; pattern: string }[];
    timeoutSec?: number;
}

declare global {
    interface Window {
        permissionAPI?: {
            onPermissionRequest: (callback: (requestId: string, data: PermissionRequestData) => void) => void;
            onPermissionDismiss: (callback: (requestId: string) => void) => void;
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
        // 非 URL，按路径处理
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

    connectedCallback(): void {
        this.renderContent();
        window.permissionAPI?.onPermissionRequest((requestId, data) => {
            this.showPrompt(requestId, data);
        });
        window.permissionAPI?.onPermissionDismiss((requestId) => {
            if (this._requestId === requestId) {
                this.stopCountdown();
                this.hidePrompt();
            }
        });
    }

    private showPrompt(requestId: string, data: PermissionRequestData): void {
        this.stopCountdown();
        this._requestId = requestId;
        this._data = data;
        this._visible = true;
        this._remaining = data.timeoutSec ?? 300;
        this.renderContent();
        this.startCountdown();

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
        setTimeout(() => {
            this._visible = false;
            this._requestId = null;
            this._data = null;
            this.renderContent();
        }, 200);
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
                class="permission-btn w-full text-left px-3 py-2 rounded-lg text-[13px] text-blue-700 bg-blue-50/60 hover:bg-blue-100/80 transition-all duration-150 active:scale-[0.98]"
            >
                <span class="font-medium">始终允许${actionLabel}</span>
                <span class="text-blue-500 font-mono text-[11px] ml-1">${escapeHtml(opt.label)}</span>
            </button>`
            )
            .join('');

        this.innerHTML = `
        <div id="permission-prompt-panel"
             class="transform translate-y-4 opacity-0 transition-all duration-200 ease-out">
            <div class="rounded-2xl bg-white/80 backdrop-blur-xl shadow-[0_8px_40px_-8px_rgba(0,0,0,0.12)] ring-1 ring-black/[0.06] overflow-hidden">
                <!-- 标题栏 -->
                <div class="flex items-center gap-3 px-4 pt-3.5 pb-2">
                    <div class="flex-shrink-0 w-8 h-8 rounded-xl bg-amber-50 border border-amber-200/60 flex items-center justify-center text-amber-600">
                        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                        </svg>
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="text-[13px] text-gray-600">
                            <span class="font-semibold text-gray-900">${escapeHtml(toolName)}</span>
                            <span class="mx-1">请求${actionLabel}${typeLabel}</span>
                        </div>
                    </div>
                    <div class="flex-shrink-0">
                        <span class="text-[11px] font-mono text-gray-500 bg-gray-100/80 rounded-md px-2 py-0.5 max-w-[280px] truncate inline-block" title="${escapeHtml(fullPath)}">${escapeHtml(fullPath)}</span>
                    </div>
                </div>

                <!-- 分割线 -->
                <div class="mx-4 border-t border-gray-200/60"></div>

                <!-- 操作按钮 -->
                <div class="px-4 py-3 flex flex-col gap-1.5">
                    <!-- 主按钮行：允许(左) / 始终允许(中) / 拒绝(右) -->
                    <div class="flex gap-2">
                        <button
                            data-action="allow"
                            class="permission-btn flex-1 px-3 py-2 rounded-lg text-[13px] font-medium text-white bg-blue-500 hover:bg-blue-600 shadow-sm transition-all duration-150 active:scale-[0.98] truncate"
                        >
                            允许${actionLabel} ${escapeHtml(shortName)}
                        </button>
                        ${
                            firstPrefix
                                ? `
                        <button
                            data-action="prefix"
                            data-pattern="${escapeHtml(firstPrefix.pattern)}"
                            class="permission-btn flex-1 px-3 py-2 rounded-lg text-[13px] font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200/50 transition-all duration-150 active:scale-[0.98] truncate"
                        >
                            始终允许${actionLabel} ${escapeHtml(shortName)}
                        </button>`
                                : ''
                        }
                        <button
                            data-action="deny"
                            class="permission-btn flex-shrink-0 px-3 py-2 rounded-lg text-[13px] font-medium text-red-600 bg-red-50 hover:bg-red-100 border border-red-200/60 transition-all duration-150 active:scale-[0.98] flex items-center gap-1.5"
                        >
                            <svg class="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="15" y1="9" x2="9" y2="15"/>
                                <line x1="9" y1="9" x2="15" y2="15"/>
                            </svg>
                            <span>拒绝</span>
                        </button>
                    </div>
                    ${restPrefixButtonsHtml}
                    <button
                        data-action="allow_type"
                        class="permission-btn w-full px-3 py-2 rounded-lg text-[13px] font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200/60 transition-all duration-150 active:scale-[0.98]"
                    >
                        始终允许所有${actionLabel}${typeLabel}操作
                    </button>
                    <!-- 倒计时提示 -->
                    <div class="text-center">
                        <span id="permission-countdown" class="text-[11px] text-gray-400">${this._remaining}s 后自动拒绝</span>
                    </div>
                </div>
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
