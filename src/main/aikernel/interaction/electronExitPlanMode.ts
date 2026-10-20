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
 * Electron 环境下的 ExitPlanModeProvider 实现。
 *
 * 通过 IPC 将计划审批请求发送到 renderer 展示，
 * 等待用户选择执行模式后回传结果并切换模式。
 *
 * 每个 provider 实例（对应一个任务）独立维护自身的 pending 状态，
 * 并通过按 taskId 索引的注册表支持任务切换后恢复审批面板：
 * renderer 可通过 exitPlanMode:getPending 查询指定任务的活跃请求。
 *
 * 注意：使用 createRequire 延迟加载 electron，避免 worker 线程中
 * 静态 import 导致 electron 模块不可用而崩溃（尤其在 OpenHarmony 平台）。
 */

import type {
    ExitPlanModeAction,
    ExitPlanModeProvider,
    ExitPlanModeRemoteContext,
    ExitPlanModeResponse
} from './contracts.js';
import type { InteractionDeliveryChannel, InteractionDeliveryHandle, InteractionRemoteSettlement } from './delivery.js';
import { logger } from '../../utils/logger.js';
import { broadcastToAllWindows } from '../../utils/electron-ipc.js';
import { showTaskNotification, clearPendingOpenTasks } from '../../utils/system-notification.js';
import { electron } from '../../../utils/electron.js';
import { t } from '../../../locale/index.js';
import { RemoteFinishBarrier } from './remote-finish-barrier.js';

interface PendingRequest {
    requestId: string;
    planContent: string;
    planFilePath: string;
}

interface PendingPrompt extends PendingRequest {
    taskId: string;
    /** Remote delivery inputs kept so a re-offer reuses the original request verbatim. */
    remote?: { sourceTaskId: string; taskName?: string; planRelativePath: string };
    /** Original expiry, so a re-offer never extends the request. */
    deadlineMs: number;
    resolve: (response: ExitPlanModeResponse) => void;
    timer: ReturnType<typeof setTimeout> | null;
    handler: ((event: unknown, respRequestId: string, respData: unknown) => void) | null;
    settled: boolean;
    delivery?: InteractionDeliveryHandle;
    /** Endpoint generation this request was published to, so a re-offer never repeats. */
    deliveredGeneration?: number;
    /** True once a local window was actually asked, so the phone is not the only answer path. */
    localPrompted?: boolean;
}

const EXIT_PLAN_MODE_TIMEOUT_MS = 600_000;

let _ipcHandleRegistered = false;
// 按 taskId 维护当前活跃的审批请求，供 renderer 通过 exitPlanMode:getPending 恢复面板。
const _pendingByTaskId = new Map<string, PendingPrompt>();

export class ElectronExitPlanModeProvider implements ExitPlanModeProvider {
    private modeSwitcher: ((modeId: string) => Promise<void>) | null = null;
    private pending: PendingPrompt | null = null;
    private readonly remoteFinish = new RemoteFinishBarrier();
    private readyUnsubscribe?: () => void;

    constructor(private readonly deliveryChannel?: InteractionDeliveryChannel) {
        this.ensureIpcHandle();
    }

    /**
     * Listens only while an approval is outstanding. This Provider is created per Task and never
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
     * Offers the outstanding approval to the endpoint registered right now, if that endpoint has not
     * received it yet. Two moments need this: a newly ready endpoint after the phone reconnected, and
     * the instant a previous delivery released the remote exit — the caller is the queue here, so a
     * follow-up approval issued while the previous one was still closing found the exit busy and was
     * never delivered. The pending entry, its settle gate and its original deadline stay here;
     * nothing is revived and no answer is replayed.
     */
    private offerPendingToCurrentEndpoint(): void {
        const pending = this.pending;
        if (!pending || pending.settled || !pending.remote) return;
        const generation = this.deliveryChannel?.endpointGeneration;
        if (generation === undefined || pending.deliveredGeneration === generation) return;
        if (pending.deadlineMs - Date.now() <= 0) return;
        this.publishToMobile(pending);
    }

    /**
     * Gives up only when nothing can answer any more. A follow-up approval issued while the previous
     * delivery was still closing has no delivery yet purely because the exit was busy: settling it
     * here would continue-edit an approval the phone is about to receive.
     */
    private settleIfUnanswerable(pending: PendingPrompt): void {
        if (pending.settled || pending.delivery || pending.localPrompted) return;
        if (this.remoteFinish.blocked) return;
        logger.warn('ElectronExitPlanModeProvider: no window or mobile endpoint available, returning continue-editing');
        this.settle(pending, { action: 'continue-editing' }, 'fallback');
    }

    private publishToMobile(pending: PendingPrompt): boolean {
        const remote = pending.remote;
        if (!remote) return false;
        const delivery = this.deliveryChannel?.publishExitPlanMode(
            {
                type: 'exitPlanMode',
                requestId: pending.requestId,
                sourceTaskId: remote.sourceTaskId,
                ...(remote.taskName === undefined ? {} : { taskName: remote.taskName }),
                expiresAt: pending.deadlineMs,
                planContent: pending.planContent,
                planRelativePath: remote.planRelativePath
            },
            (response, settlement) => this.settle(pending, response, 'mobile', settlement)
        );
        // A failed re-offer must keep the handle from the delivery that is still open.
        if (!delivery) return false;
        pending.delivery = delivery;
        pending.deliveredGeneration = this.deliveryChannel?.endpointGeneration;
        return true;
    }

    setModeSwitcher(fn: (modeId: string) => Promise<void>): void {
        this.modeSwitcher = fn;
    }

    cancelCurrent(): void {
        if (!this.pending) return;
        this.settle(this.pending, { action: 'continue-editing' }, 'cancel');
    }

    /**
     * 结束一次审批请求：清理定时器与监听器、注销注册表条目并 resolve。
     * 使用 removeListener（而非 removeAllListeners）保证并发的多个任务互不影响。
     */
    private settle(
        pending: PendingPrompt,
        response: ExitPlanModeResponse,
        source: 'local' | 'mobile' | 'timeout' | 'cancel' | 'fallback',
        settlement?: InteractionRemoteSettlement
    ): boolean {
        if (pending.settled) return false;
        pending.settled = true;
        // 已审批或已超时，通知的待打开记录一并作废，避免之后聚焦窗口时误跳
        clearPendingOpenTasks(pending.taskId);
        if (pending.timer) clearTimeout(pending.timer);
        if (this.pending === pending) {
            this.pending = null;
            this.unwatchEndpointReady();
        }
        if (_pendingByTaskId.get(pending.taskId) === pending) {
            _pendingByTaskId.delete(pending.taskId);
        }
        try {
            const { ipcMain } = electron();
            if (pending.handler) {
                ipcMain.removeListener('exitPlanMode:response', pending.handler);
            }
            if (source !== 'local') {
                broadcastToAllWindows('exitPlanMode:dismiss', pending.requestId);
            }
        } catch (err) {
            logger.warn(`ElectronExitPlanModeProvider.settle failed: ${err}`);
        }
        if (source === 'local' || source === 'fallback') pending.delivery?.close('superseded');
        if (source === 'timeout') pending.delivery?.close('timeout');
        if (source === 'cancel') pending.delivery?.close('cancelled');
        // Registered synchronously: resolving below lets the caller ask again straight away, while
        // this delivery still holds the exit. The endpoint runs it immediately if already free.
        if (settlement) {
            const release = this.remoteFinish.hold();
            settlement.afterRemoteClose(() => {
                release();
                this.offerPendingToCurrentEndpoint();
                if (this.pending) this.settleIfUnanswerable(this.pending);
            });
        }
        this.resolveAfterModeSwitch(pending, response);
        return true;
    }

    private resolveAfterModeSwitch(pending: PendingPrompt, response: ExitPlanModeResponse): void {
        void (async () => {
            try {
                if (response.action === 'execute-standard' && this.modeSwitcher) {
                    await this.modeSwitcher('standard');
                } else if (response.action === 'execute-solo' && this.modeSwitcher) {
                    await this.modeSwitcher('solo');
                }
                pending.resolve(response);
            } catch (error) {
                logger.warn(`ElectronExitPlanModeProvider mode switch failed: ${error}`);
                pending.resolve({ action: 'continue-editing' });
            }
        })();
    }

    private ensureIpcHandle(): void {
        if (_ipcHandleRegistered) return;
        _ipcHandleRegistered = true;

        const { ipcMain } = electron();
        ipcMain.handle('exitPlanMode:getPending', (_event, taskId?: string) => {
            const pending = taskId ? _pendingByTaskId.get(taskId) : Array.from(_pendingByTaskId.values()).at(-1);
            if (!pending) return { status: 'ok', data: null };
            return {
                status: 'ok',
                data: {
                    requestId: pending.requestId,
                    planContent: pending.planContent,
                    planFilePath: pending.planFilePath
                }
            };
        });
    }

    async promptAndSwitch(
        planContent: string,
        planFilePath: string,
        taskId?: string,
        taskName?: string,
        remoteContext?: ExitPlanModeRemoteContext
    ): Promise<ExitPlanModeResponse> {
        try {
            this.ensureIpcHandle();

            const { BrowserWindow, ipcMain } = electron();

            const hasWindow = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed());
            if (hasWindow) {
                showTaskNotification({
                    title: t('notification.exitPlanMode.title'),
                    body: t('notification.exitPlanMode.body'),
                    taskId
                });
            }

            const requestId = `exitPlan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const pendingTaskId = taskId || requestId;

            return await new Promise<ExitPlanModeResponse>((resolve) => {
                const pending: PendingPrompt = {
                    requestId,
                    planContent,
                    planFilePath,
                    taskId: pendingTaskId,
                    deadlineMs: Date.now() + EXIT_PLAN_MODE_TIMEOUT_MS,
                    resolve,
                    timer: null,
                    handler: null,
                    settled: false
                };

                const timer = setTimeout(() => {
                    if (pending.settled) return;
                    logger.warn(`ExitPlanMode prompt timed out for request ${requestId}`);
                    this.settle(pending, { action: 'continue-editing' }, 'timeout');
                }, EXIT_PLAN_MODE_TIMEOUT_MS);

                const handler = (_event: unknown, respRequestId: string, respData: unknown) => {
                    if (respRequestId !== requestId) return;
                    if (pending.settled) return;
                    const action = ((respData as { action?: string })?.action ??
                        'continue-editing') as ExitPlanModeAction;
                    this.settle(pending, { action }, 'local');
                };

                pending.timer = timer;
                pending.handler = handler;
                this.pending = pending;
                _pendingByTaskId.set(pendingTaskId, pending);

                if (
                    typeof taskId === 'string' &&
                    taskId.trim().length > 0 &&
                    taskId !== 'unknown' &&
                    typeof remoteContext?.planRelativePath === 'string' &&
                    remoteContext.planRelativePath.trim().length > 0
                ) {
                    pending.remote = {
                        sourceTaskId: taskId,
                        ...(taskName === undefined ? {} : { taskName }),
                        planRelativePath: remoteContext.planRelativePath
                    };
                    // Watch before publishing: a phone that connects later must still receive this approval.
                    this.watchEndpointReady();
                    this.publishToMobile(pending);
                }

                if (hasWindow) {
                    pending.localPrompted = true;
                    ipcMain.on('exitPlanMode:response', handler);
                    broadcastToAllWindows('exitPlanMode:request', requestId, {
                        planContent,
                        planFilePath
                    });
                } else {
                    this.settleIfUnanswerable(pending);
                }
            });
        } catch (err) {
            logger.warn(`ElectronExitPlanModeProvider failed: ${err}`);
            return { action: 'continue-editing' };
        }
    }
}
