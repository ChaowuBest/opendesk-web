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
 * Electron 环境下的权限确认 PromptProvider。
 *
 * 通过 IPC 将权限请求发送到 renderer 的 permission-prompt 组件展示，
 * 等待用户在内嵌浮窗中做出选择后回传结果。
 * 同时向操作系统发送通知，提示用户需要进行权限授权。
 */

import type {
    PermissionRequest,
    PermissionUserResponse,
    PermissionPromptProvider,
    PermissionTaskInfo,
    PermissionPromptContext,
    PermissionEnforcer
} from './permission.js';
import {
    clearInterval as nodeClearInterval,
    clearTimeout as nodeClearTimeout,
    setInterval as nodeSetInterval,
    setTimeout as nodeSetTimeout
} from 'node:timers';
import { logger } from '../../utils/logger.js';
import { safeSendToWebContents } from '../../utils/electron-ipc.js';
import { showTaskNotification, clearPendingOpenTasks } from '../../utils/system-notification.js';
import { electron } from '../../../utils/electron.js';
import { t } from '../../../locale/index.js';

function getActionLabel(action: string): string {
    const key = `permission.action.${action}`;
    const result = t(key);
    return result === key ? action : result;
}

function getResourceTypeLabel(resourceType: string): string {
    const key = `permission.resource.${resourceType}`;
    const result = t(key);
    return result === key ? resourceType : result;
}

interface QueuedElectronPermissionPrompt {
    requestId: string;
    requests: PermissionRequest[];
    toolName: string;
    prefixOptions: { label: string; pattern: string }[];
    taskInfo?: PermissionTaskInfo;
    /** 弹窗附加上下文（工具调用参数，如沙箱命令的 command），随 payload 下发展示 */
    context?: PermissionPromptContext;
    deadlineMs: number;
    resolve: (response: PermissionUserResponse) => void;
    settled: boolean;
    responseHandler?: (_event: any, requestId: string, response: any) => void;
    timeoutTimer?: ReturnType<typeof setTimeout>;
    resendTimer?: ReturnType<typeof setInterval>;
}

interface GrantedElectronPermission {
    resourceType: string;
    action: string;
    scope: 'prefix' | 'type';
    prefixPath?: string;
}

const PROMPT_TIMEOUT_SEC = 300;
const PROMPT_TIMEOUT_MS = PROMPT_TIMEOUT_SEC * 1000;

function allowProcessExit(timer: unknown): void {
    (timer as { unref?: () => void } | null)?.unref?.();
}

function safeSetTimeout(handler: () => void, timeoutMs: number): ReturnType<typeof setTimeout> {
    const setTimer =
        typeof globalThis.setTimeout === 'function' ? globalThis.setTimeout.bind(globalThis) : nodeSetTimeout;
    const timer = setTimer(handler, timeoutMs) as ReturnType<typeof setTimeout>;
    allowProcessExit(timer);
    return timer;
}

function safeSetInterval(handler: () => void, timeoutMs: number): ReturnType<typeof setInterval> {
    const setTimer =
        typeof globalThis.setInterval === 'function' ? globalThis.setInterval.bind(globalThis) : nodeSetInterval;
    const timer = setTimer(handler, timeoutMs) as ReturnType<typeof setInterval>;
    allowProcessExit(timer);
    return timer;
}

function safeClearTimeout(timer: ReturnType<typeof setTimeout>): void {
    const clearTimer =
        typeof globalThis.clearTimeout === 'function' ? globalThis.clearTimeout.bind(globalThis) : nodeClearTimeout;
    clearTimer(timer);
}

function safeClearInterval(timer: ReturnType<typeof setInterval>): void {
    const clearTimer =
        typeof globalThis.clearInterval === 'function' ? globalThis.clearInterval.bind(globalThis) : nodeClearInterval;
    clearTimer(timer);
}

export class ElectronPermissionPromptProvider implements PermissionPromptProvider {
    private queue: QueuedElectronPermissionPrompt[] = [];
    private current: QueuedElectronPermissionPrompt | null = null;
    private grantedPermissions: GrantedElectronPermission[] = [];

    async prompt(
        requests: PermissionRequest[],
        toolName: string,
        prefixOptions: { label: string; pattern: string }[],
        taskInfo?: PermissionTaskInfo,
        context?: PermissionPromptContext
    ): Promise<PermissionUserResponse> {
        try {
            const { BrowserWindow } = electron();
            const focusedWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;

            if (!focusedWindow) {
                logger.warn('No Electron window available for permission prompt, denying');
                return { decision: 'deny', rememberScope: 'none', denyReason: 'no_prompt_provider' };
            }

            const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            return new Promise<PermissionUserResponse>((resolve) => {
                this.queue.push({
                    requestId,
                    requests,
                    toolName,
                    prefixOptions,
                    taskInfo,
                    context,
                    deadlineMs: Date.now() + PROMPT_TIMEOUT_MS,
                    resolve,
                    settled: false
                });
                this.processQueue();
            });
        } catch (err) {
            logger.warn(`Electron permission prompt failed, denying: ${err}`);
            return { decision: 'deny', rememberScope: 'none', denyReason: 'no_prompt_provider' };
        }
    }

    async notifyPermissionRulesChanged(enforcer: PermissionEnforcer, taskIds?: string[]): Promise<void> {
        const ids = taskIds ? new Set(taskIds) : null;
        const current = this.current;
        if (current && !current.settled && (!ids || this.matchesTask(current, ids))) {
            try {
                const askOrDeny = await enforcer.checkAllDetailed(current.requests);
                if (this.current === current && !current.settled && askOrDeny.length === 0) {
                    this.cleanupCurrent();
                    this.dismiss(current);
                    this.settleItem(current, { decision: 'allow', rememberScope: 'none' });
                    this.current = null;
                }
            } catch (err) {
                logger.warn(`Permission current prompt re-check failed: ${err}`);
            }
        }

        const queuedItems = [...this.queue];
        for (const item of queuedItems) {
            if (item.settled) continue;
            if (ids && !this.matchesTask(item, ids)) {
                continue;
            }
            try {
                const askOrDeny = await enforcer.checkAllDetailed(item.requests);
                if (askOrDeny.length === 0) {
                    const index = this.queue.indexOf(item);
                    if (index >= 0) {
                        this.queue.splice(index, 1);
                        this.settleItem(item, { decision: 'allow', rememberScope: 'none' });
                    }
                } else {
                    this.invalidateGrants(item.requests);
                }
            } catch (err) {
                logger.warn(`Permission queue re-check failed: ${err}`);
            }
        }
        this.processQueue();
    }

    cancelTaskPrompts(taskIds: string[]): void {
        if (taskIds.length === 0) return;
        const ids = new Set(taskIds);

        this.queue = this.queue.filter((item) => {
            if (!this.matchesTask(item, ids)) return true;
            this.settleItem(item, { decision: 'deny', rememberScope: 'none', denyReason: 'task_stopped' });
            return false;
        });
        if (this.current && this.matchesTask(this.current, ids)) {
            const current = this.current;
            this.cleanupCurrent();
            this.dismiss(current);
            this.settleItem(current, { decision: 'deny', rememberScope: 'none', denyReason: 'task_stopped' });
            this.current = null;
            this.processQueue();
        }
    }

    dispose(): void {
        if (this.current) {
            this.cleanupCurrent();
            this.settleItem(this.current, { decision: 'deny', rememberScope: 'none', denyReason: 'task_stopped' });
            this.current = null;
        }

        const queued = this.queue;
        this.queue = [];
        for (const item of queued) {
            this.settleItem(item, { decision: 'deny', rememberScope: 'none', denyReason: 'task_stopped' });
        }
        this.grantedPermissions = [];
    }

    private processQueue(): void {
        if (this.current) return;

        while (this.queue.length > 0) {
            const item = this.queue.shift()!;
            if (item.settled) continue;

            const cachedResponse = this.tryAutoResolve(item);
            if (cachedResponse) {
                this.settleItem(item, cachedResponse);
                continue;
            }

            const remainingMs = item.deadlineMs - Date.now();
            if (remainingMs <= 0) {
                logger.warn(`Queued permission prompt timed out before display, denying`);
                this.settleItem(item, { decision: 'deny', rememberScope: 'none', denyReason: 'timeout' });
                continue;
            }

            this.current = item;
            this.showCurrent(item, remainingMs);
            return;
        }
    }

    private showCurrent(item: QueuedElectronPermissionPrompt, remainingMs: number): void {
        const { BrowserWindow, ipcMain } = electron();
        // 没有任何窗口时 renderer 无法展示弹窗，直接拒绝；通知的唤起目标由 system-notification 解析主窗口
        if (!BrowserWindow.getAllWindows().some((w) => !w.isDestroyed())) {
            this.current = null;
            this.settleItem(item, { decision: 'deny', rememberScope: 'none', denyReason: 'no_prompt_provider' });
            this.processQueue();
            return;
        }

        const first = item.requests[0];
        const actionLabel = getActionLabel(first.action);
        const typeLabel = getResourceTypeLabel(first.resourceType);

        showTaskNotification({
            title: t('notification.permission.title'),
            body: t('notification.permission.body', {
                toolName: item.toolName,
                action: actionLabel,
                type: typeLabel
            }),
            taskId: item.taskInfo?.taskId
        });

        item.timeoutTimer = safeSetTimeout(() => {
            if (this.current !== item || item.settled) return;
            this.cleanupCurrent();
            this.dismiss(item);
            logger.warn(`Permission prompt timed out after ${PROMPT_TIMEOUT_MS}ms, denying`);
            this.settleItem(item, { decision: 'deny', rememberScope: 'none', denyReason: 'timeout' });
            this.current = null;
            this.processQueue();
        }, remainingMs);

        item.responseHandler = (_event: any, respRequestId: string, response: any) => {
            if (respRequestId !== item.requestId) return;
            if (this.current !== item || item.settled) return;

            this.cleanupCurrent();
            const decision = response.decision || 'deny';
            const userResponse: PermissionUserResponse = {
                decision,
                rememberScope: response.rememberScope || 'none',
                selectedPrefixPattern: response.selectedPrefixPattern,
                denyReason:
                    decision === 'deny' ? (response.denyReason === 'timeout' ? 'timeout' : 'user_denied') : undefined
            };
            this.settleItem(item, userResponse);
            this.current = null;

            const persistent =
                userResponse.decision === 'allow' &&
                (userResponse.rememberScope === 'type' ||
                    (userResponse.rememberScope === 'prefix' && !!userResponse.selectedPrefixPattern));
            this.recordGrant(item, userResponse);
            if (persistent) {
                // 让调用方先把持久化规则写回，再处理队列，避免短暂绕过更具体的 ask/deny 规则。
                safeSetTimeout(() => this.processQueue(), 0);
            } else {
                this.processQueue();
            }
        };
        ipcMain.on('permission:response', item.responseHandler);

        this.broadcastPromptRequest(item);
        item.resendTimer = safeSetInterval(() => {
            if (this.current !== item || item.settled) return;
            this.broadcastPromptRequest(item);
        }, 2000);
    }

    private broadcastPromptRequest(item: QueuedElectronPermissionPrompt): void {
        const { BrowserWindow } = electron();
        const remainingMs = item.deadlineMs - Date.now();
        if (remainingMs <= 0) return;

        const payload = {
            requests: item.requests.map((r) => ({
                resourceType: r.resourceType,
                action: r.action,
                resourcePath: r.resourcePath
            })),
            toolName: item.toolName,
            prefixOptions: item.prefixOptions,
            timeoutSec: Math.max(1, Math.ceil(remainingMs / 1000)),
            taskId: item.taskInfo?.taskId ?? '',
            taskName: item.taskInfo?.taskName ?? null,
            sourceTaskId: item.taskInfo?.sourceTaskId,
            sourceTaskName: item.taskInfo?.sourceTaskName ?? null,
            parentTaskId: item.taskInfo?.parentTaskId ?? null,
            // 弹窗附加上下文（如沙箱命令的 command）：renderer 据此渲染"被执行的命令"
            input: item.context?.input ?? null
        };

        for (const win of BrowserWindow.getAllWindows()) {
            if (win.isDestroyed()) continue;
            safeSendToWebContents(win.webContents, 'permission:request', item.requestId, payload);
        }
    }

    private cleanupCurrent(): void {
        if (!this.current) return;
        const { ipcMain } = electron();
        if (this.current.responseHandler) {
            ipcMain.removeListener('permission:response', this.current.responseHandler);
            this.current.responseHandler = undefined;
        }
        if (this.current.timeoutTimer) {
            safeClearTimeout(this.current.timeoutTimer);
            this.current.timeoutTimer = undefined;
        }
        if (this.current.resendTimer) {
            safeClearInterval(this.current.resendTimer);
            this.current.resendTimer = undefined;
        }
    }

    private dismiss(item: QueuedElectronPermissionPrompt): void {
        const { BrowserWindow } = electron();
        for (const win of BrowserWindow.getAllWindows()) {
            if (win.isDestroyed()) continue;
            safeSendToWebContents(win.webContents, 'permission:dismiss', item.requestId);
        }
    }

    private settleItem(item: QueuedElectronPermissionPrompt, response: PermissionUserResponse): void {
        if (item.settled) return;
        item.settled = true;
        // 请求已结算（应答 / 超时 / 任务停止），通知的待打开记录必须一并作废：
        // 用户多半是在应用内直接应答的，留着会让之后任意一次窗口聚焦把他跳回这个任务。
        clearPendingOpenTasks(item.taskInfo?.taskId);
        item.resolve(response);
    }

    private matchesTask(item: QueuedElectronPermissionPrompt, taskIds: Set<string>): boolean {
        const taskInfo = item.taskInfo;
        if (!taskInfo) return false;
        return (
            taskIds.has(taskInfo.taskId) ||
            (taskInfo.sourceTaskId ? taskIds.has(taskInfo.sourceTaskId) : false) ||
            (taskInfo.parentTaskId ? taskIds.has(taskInfo.parentTaskId) : false)
        );
    }

    private tryAutoResolve(item: QueuedElectronPermissionPrompt): PermissionUserResponse | null {
        const first = item.requests[0];
        if (!first) return null;
        for (const grant of this.grantedPermissions) {
            if (grant.resourceType !== first.resourceType || grant.action !== first.action) continue;
            if (grant.scope === 'type') return { decision: 'allow', rememberScope: 'none' };
            if (!grant.prefixPath) continue;
            const prefix = grant.prefixPath.toLowerCase().replace(/\/$/, '');
            if (
                item.requests.every((request) => {
                    const path = request.resourcePath.toLowerCase();
                    return path === prefix || path.startsWith(`${prefix}/`);
                })
            ) {
                return { decision: 'allow', rememberScope: 'none' };
            }
        }
        return null;
    }

    private recordGrant(item: QueuedElectronPermissionPrompt, response: PermissionUserResponse): void {
        const first = item.requests[0];
        if (!first || response.decision !== 'allow') return;
        if (response.rememberScope === 'type') {
            this.grantedPermissions.push({ resourceType: first.resourceType, action: first.action, scope: 'type' });
        } else if (response.rememberScope === 'prefix' && response.selectedPrefixPattern) {
            this.grantedPermissions.push({
                resourceType: first.resourceType,
                action: first.action,
                scope: 'prefix',
                prefixPath: response.selectedPrefixPattern.replace(/\/\*\*$/, '')
            });
        }
    }

    private invalidateGrants(requests: PermissionRequest[]): void {
        this.grantedPermissions = this.grantedPermissions.filter(
            (grant) =>
                !requests.some(
                    (request) => `${grant.resourceType}:${grant.action}` === `${request.resourceType}:${request.action}`
                )
        );
    }
}
