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
import { electron } from '../../../utils/electron.js';

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

interface QueuedElectronPermissionPrompt {
    requestId: string;
    requests: PermissionRequest[];
    toolName: string;
    prefixOptions: { label: string; pattern: string }[];
    taskInfo?: PermissionTaskInfo;
    deadlineMs: number;
    resolve: (response: PermissionUserResponse) => void;
    settled: boolean;
    responseHandler?: (_event: any, requestId: string, response: any) => void;
    timeoutTimer?: ReturnType<typeof setTimeout>;
    resendTimer?: ReturnType<typeof setInterval>;
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
    private waitingForRuleChange = false;
    private ruleChangeWaitGeneration = 0;
    private ruleChangeDeadlineTimer?: ReturnType<typeof setTimeout>;

    async prompt(
        requests: PermissionRequest[],
        toolName: string,
        prefixOptions: { label: string; pattern: string }[],
        taskInfo?: PermissionTaskInfo
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
                    deadlineMs: Date.now() + PROMPT_TIMEOUT_MS,
                    resolve,
                    settled: false
                });
                if (this.waitingForRuleChange) {
                    this.scheduleRuleChangeDeadline();
                }
                this.processQueue();
            });
        } catch (err) {
            logger.warn(`Electron permission prompt failed, denying: ${err}`);
            return { decision: 'deny', rememberScope: 'none', denyReason: 'no_prompt_provider' };
        }
    }

    async notifyPermissionRulesChanged(enforcer: PermissionEnforcer, taskIds?: string[]): Promise<void> {
        const waitGeneration = this.ruleChangeWaitGeneration;
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
                }
            } catch (err) {
                logger.warn(`Permission queue re-check failed: ${err}`);
            }
        }
        if (this.ruleChangeWaitGeneration === waitGeneration) {
            this.clearRuleChangeWait();
            this.processQueue();
        }
    }

    cancelTaskPrompts(taskIds: string[]): void {
        if (taskIds.length === 0) return;
        const ids = new Set(taskIds);

        this.queue = this.queue.filter((item) => {
            if (!this.matchesTask(item, ids)) return true;
            this.settleItem(item, { decision: 'deny', rememberScope: 'none', denyReason: 'task_stopped' });
            return false;
        });
        if (this.waitingForRuleChange) {
            if (this.queue.length === 0) {
                this.clearRuleChangeWait();
            } else {
                this.scheduleRuleChangeDeadline();
            }
        }

        if (this.current && this.matchesTask(this.current, ids)) {
            const current = this.current;
            this.cleanupCurrent();
            this.dismiss(current);
            this.settleItem(current, { decision: 'deny', rememberScope: 'none', denyReason: 'task_stopped' });
            this.current = null;
            this.clearRuleChangeWait();
            this.processQueue();
        }
    }

    dispose(): void {
        this.clearRuleChangeWait();

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
    }

    private processQueue(): void {
        if (this.current || this.waitingForRuleChange) return;

        while (this.queue.length > 0) {
            const item = this.queue.shift()!;
            if (item.settled) continue;

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
        const { BrowserWindow, ipcMain, Notification } = electron();
        const focusedWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) || null;
        if (!focusedWindow) {
            this.current = null;
            this.settleItem(item, { decision: 'deny', rememberScope: 'none', denyReason: 'no_prompt_provider' });
            this.processQueue();
            return;
        }

        const first = item.requests[0];
        const actionLabel = ACTION_LABELS[first.action] || first.action;
        const typeLabel = RESOURCE_TYPE_LABELS[first.resourceType] || first.resourceType;

        if (Notification.isSupported()) {
            const notification = new Notification({
                title: 'OpenDesk - 权限确认',
                body: `${item.toolName} 请求${actionLabel}${typeLabel}，请在应用内确认`,
                silent: false
            });
            notification.show();
            notification.on('click', () => {
                if (focusedWindow && !focusedWindow.isDestroyed()) {
                    focusedWindow.show();
                    focusedWindow.focus();
                }
            });
        }

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

            const shouldWaitForRuleChange =
                userResponse.decision === 'allow' &&
                (userResponse.rememberScope === 'type' ||
                    (userResponse.rememberScope === 'prefix' && !!userResponse.selectedPrefixPattern));

            if (shouldWaitForRuleChange) {
                this.startRuleChangeWait();
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
            parentTaskId: item.taskInfo?.parentTaskId ?? null
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
        item.resolve(response);
    }

    private startRuleChangeWait(): void {
        this.ruleChangeWaitGeneration++;
        this.waitingForRuleChange = true;
        this.scheduleRuleChangeDeadline();
    }

    private clearRuleChangeWait(): void {
        this.waitingForRuleChange = false;
        if (this.ruleChangeDeadlineTimer) {
            safeClearTimeout(this.ruleChangeDeadlineTimer);
            this.ruleChangeDeadlineTimer = undefined;
        }
    }

    private scheduleRuleChangeDeadline(): void {
        if (this.ruleChangeDeadlineTimer) {
            safeClearTimeout(this.ruleChangeDeadlineTimer);
            this.ruleChangeDeadlineTimer = undefined;
        }
        if (!this.waitingForRuleChange || this.queue.length === 0) {
            return;
        }

        const nextDeadlineMs = Math.min(...this.queue.filter((item) => !item.settled).map((item) => item.deadlineMs));
        if (!Number.isFinite(nextDeadlineMs)) {
            return;
        }

        this.ruleChangeDeadlineTimer = safeSetTimeout(
            () => {
                if (!this.waitingForRuleChange) return;
                logger.warn('Permission queue rule-change wait reached queued item deadline, resuming queue');
                this.clearRuleChangeWait();
                this.processQueue();
            },
            Math.max(0, nextDeadlineMs - Date.now())
        );
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
}
