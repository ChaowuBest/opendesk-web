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
 * Electron 环境下的 AskUserProvider 实现。
 *
 * 通过 IPC 将问题请求发送到 renderer 的 ask-user-prompt 组件展示，
 * 等待用户在内嵌面板中做出选择后回传结果。
 */

import type { AskUserProvider, AskUserRequest, AskUserResponse } from './contracts.js';
import type { InteractionDeliveryChannel, InteractionDeliveryHandle, InteractionRemoteSettlement } from './delivery.js';
import { logger } from '../../utils/logger.js';
import { broadcastToAllWindows } from '../../utils/electron-ipc.js';
import { showTaskNotification, clearPendingOpenTasks } from '../../utils/system-notification.js';
import { electron } from '../../../utils/electron.js';
import { t } from '../../../locale/index.js';
import { RemoteFinishBarrier } from './remote-finish-barrier.js';

interface PendingPrompt {
    requestId: string;
    request: AskUserRequest;
    sourceTaskId: string;
    /** Original expiry, so a re-offer never extends the request. */
    deadlineMs: number;
    resolve: (response: AskUserResponse) => void;
    timer: ReturnType<typeof setTimeout> | null;
    handler: ((event: unknown, respRequestId: string, response: unknown) => void) | null;
    settled: boolean;
    delivery?: InteractionDeliveryHandle;
    /** Endpoint generation this request was published to, so a re-offer never repeats. */
    deliveredGeneration?: number;
    /** True once a local window was actually asked, so the phone is not the only answer path. */
    localPrompted?: boolean;
}

const ASK_USER_TIMEOUT_MS = 600_000;

export class ElectronAskUserProvider implements AskUserProvider {
    /**
     * 同时等待用户响应的所有请求。
     * 模型在单个 turn 内可能并行发起多个 askUser 调用，单 pending 会被后一个覆盖，
     * 导致旧请求的 ipcMain 监听器与定时器泄漏、promise 永不 resolve。
     */
    private pendingPrompts: PendingPrompt[] = [];
    private readonly remoteFinish = new RemoteFinishBarrier();
    private readyUnsubscribe?: () => void;

    constructor(private readonly deliveryChannel?: InteractionDeliveryChannel) {}

    /**
     * Listens only while a question is outstanding. This Provider is created per Task and never
     * disposed, so a constructor-long subscription would retain one closure per Task.
     */
    private watchEndpointReady(): void {
        this.readyUnsubscribe ??= this.deliveryChannel?.subscribeEndpointReady(() =>
            this.offerPendingToCurrentEndpoint()
        );
    }

    private unwatchEndpointReady(): void {
        this.readyUnsubscribe?.();
        this.readyUnsubscribe = undefined;
    }

    /**
     * Keeps concurrent questions in the Provider while the phone accepts one delivery at a time.
     * Reconnection and release of the previous delivery both re-offer the oldest eligible request,
     * preserving each request's settle gate and original deadline.
     */
    private offerPendingToCurrentEndpoint(): void {
        if (this.remoteFinish.blocked) return;
        const generation = this.deliveryChannel?.endpointGeneration;
        if (!this.deliveryChannel) return;
        for (const pending of this.pendingPrompts) {
            if (pending.settled || pending.deadlineMs <= Date.now()) continue;
            if (pending.sourceTaskId.trim().length === 0 || pending.sourceTaskId === 'unknown') continue;
            // A delivery in this generation still owns the phone's single interaction slot.
            if (pending.delivery && pending.deliveredGeneration === generation) return;
            if (this.publishToMobile(pending)) return;
        }
    }

    /**
     * Gives up only when nothing can answer any more. A follow-up question issued while the previous
     * delivery was still closing has no delivery yet purely because the exit was busy: settling it
     * here would cancel a question the phone is about to receive.
     */
    private settleIfUnanswerable(pending: PendingPrompt): void {
        if (pending.settled || pending.delivery || pending.localPrompted) return;
        if (this.remoteFinish.blocked) return;
        // A concurrent question is still answerable after the currently delivered question releases
        // the phone. A retained delivery also preserves the queue while waiting for reconnection.
        if (this.pendingPrompts.some((other) => other !== pending && !other.settled && other.delivery)) return;
        logger.warn('ElectronAskUserProvider: no window or mobile endpoint available, returning cancelled');
        this.settle(pending, { answers: {}, cancelled: true }, 'fallback');
    }

    private publishToMobile(pending: PendingPrompt): boolean {
        const delivery = this.deliveryChannel?.publishAskUser(
            {
                type: 'askUser',
                requestId: pending.requestId,
                sourceTaskId: pending.sourceTaskId,
                taskName: pending.request.taskName ?? undefined,
                expiresAt: pending.deadlineMs,
                request: pending.request
            },
            (response, settlement) => this.settle(pending, response, 'mobile', settlement)
        );
        // A failed re-offer must keep the handle from the delivery that is still open.
        if (!delivery) return false;
        pending.delivery = delivery;
        pending.deliveredGeneration = this.deliveryChannel?.endpointGeneration;
        return true;
    }

    isPrompting(): boolean {
        return this.pendingPrompts.length > 0;
    }

    cancelCurrent(): void {
        if (this.pendingPrompts.length === 0) return;
        const pendingList = this.pendingPrompts;
        this.pendingPrompts = [];
        for (const pending of pendingList) {
            this.settle(pending, { answers: {}, cancelled: true }, 'cancel');
        }
    }

    /**
     * 结束一次提问：清理定时器与监听器并 resolve。
     * 使用 removeListener（而非 removeAllListeners）保证并发的多个任务互不影响。
     */
    private settle(
        pending: PendingPrompt,
        response: AskUserResponse,
        source: 'local' | 'mobile' | 'timeout' | 'cancel' | 'fallback',
        settlement?: InteractionRemoteSettlement
    ): boolean {
        if (pending.settled) return false;
        pending.settled = true;
        // 已应答或已超时，通知的待打开记录一并作废，避免之后聚焦窗口时误跳
        clearPendingOpenTasks(pending.sourceTaskId);
        if (pending.timer) clearTimeout(pending.timer);
        const index = this.pendingPrompts.indexOf(pending);
        if (index >= 0) {
            this.pendingPrompts.splice(index, 1);
        }
        if (this.pendingPrompts.length === 0) this.unwatchEndpointReady();
        try {
            const { ipcMain } = electron();
            if (pending.handler) {
                ipcMain.removeListener('askUser:response', pending.handler);
            }
            if (source !== 'local') {
                // 广播到所有窗口：主窗口不一定是 getAllWindows() 的第一个（常驻悬浮窗可能排在前面）
                broadcastToAllWindows('askUser:dismiss', pending.requestId);
            }
        } catch (err) {
            logger.warn(`ElectronAskUserProvider.settle failed: ${err}`);
        }
        if (source === 'local' || source === 'fallback') pending.delivery?.close('superseded');
        if (source === 'timeout') pending.delivery?.close('timeout');
        if (source === 'cancel') pending.delivery?.close('cancelled');
        pending.resolve(response);
        // Resolving lets the caller ask again straight away, while this delivery still holds the exit.
        if (settlement) {
            const release = this.remoteFinish.hold();
            settlement.afterRemoteClose(() => {
                release();
                this.resumePendingMobileRequests();
            });
        } else if (source !== 'fallback') {
            // Local answers and expiry close their delivery synchronously; queued questions can now
            // use the released slot. cancelCurrent clears the collection before settling its entries.
            this.resumePendingMobileRequests();
        }
        return true;
    }

    private resumePendingMobileRequests(): void {
        this.offerPendingToCurrentEndpoint();
        for (const pending of [...this.pendingPrompts]) this.settleIfUnanswerable(pending);
    }

    async prompt(request: AskUserRequest): Promise<AskUserResponse> {
        try {
            const { BrowserWindow, ipcMain } = electron();
            const hasWindow = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed());
            if (hasWindow) {
                showTaskNotification({
                    title: t('notification.askUser.title'),
                    body: request.questions[0]?.question ?? t('notification.askUser.body'),
                    taskId: request.taskId
                });
            }

            return new Promise<AskUserResponse>((resolve) => {
                const sourceTaskId = request.taskId;
                const pending: PendingPrompt = {
                    requestId: request.requestId,
                    request,
                    sourceTaskId,
                    deadlineMs: Date.now() + ASK_USER_TIMEOUT_MS,
                    resolve,
                    timer: null,
                    handler: null,
                    settled: false
                };

                const timer = setTimeout(() => {
                    if (pending.settled) return;
                    logger.warn(`AskUser prompt timed out for request ${request.requestId}`);
                    this.settle(pending, { answers: {}, cancelled: true }, 'timeout');
                }, ASK_USER_TIMEOUT_MS);

                const handler = (_event: unknown, respRequestId: string, response: unknown) => {
                    if (respRequestId !== request.requestId) return;
                    if (pending.settled) return;
                    const data = (response ?? {}) as { answers?: Record<string, string[]>; cancelled?: boolean };
                    this.settle(pending, { answers: data.answers ?? {}, cancelled: data.cancelled ?? false }, 'local');
                };

                pending.timer = timer;
                pending.handler = handler;
                this.pendingPrompts.push(pending);

                if (sourceTaskId.trim().length > 0 && sourceTaskId !== 'unknown') {
                    // Watch before publishing: a phone that connects later must still receive this question.
                    this.watchEndpointReady();
                    this.offerPendingToCurrentEndpoint();
                }

                if (hasWindow) {
                    pending.localPrompted = true;
                    ipcMain.on('askUser:response', handler);
                    broadcastToAllWindows('askUser:request', request.requestId, {
                        questions: request.questions,
                        taskId: request.taskId,
                        taskName: request.taskName
                    });
                } else {
                    this.settleIfUnanswerable(pending);
                }
            });
        } catch (err) {
            logger.warn(`ElectronAskUserProvider failed: ${err}`);
            return { answers: {}, cancelled: true };
        }
    }
}
