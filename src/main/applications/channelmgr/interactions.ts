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
 * 渠道结构化用户交互服务。
 *
 * 职责边界：
 * - 权限审批与 askUser 的「结构化请求」由本服务构造并投递到渠道（经 channel.sendInteraction
 *   渲染为交互卡片），用户在渠道侧点击后经 dispatchInteraction 事件结算 pending 请求；
 * - 渠道不支持交互（capabilities.interactive !== true 或未实现 sendInteraction）时，
 *   审批直接返回 deny、askUser 返回 cancelled，且上层据此不挂载交互工具；
 * - 超时保护：请求带 expiresAt，到期未收到用户响应按取消结算，避免悬挂。
 *
 * 本服务只感知「渠道 id + Participant」，不感知任务系统，方便单测与复用。
 */

import crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import type { ChannelPlugin, Participant, PluginEntry } from '../../plugins/types.js';

/** 审批请求的对外形态（与 permission 系统解耦的载荷） */
export interface ChannelApprovalRequest {
    prompt: string;
    tool?: string;
    requests: unknown[];
    confirmLabel?: string;
    cancelLabel?: string;
}

/** askUser 请求的对外形态（对齐 aikernel/interaction/tools.ts 的 AskUserQuestion） */
export interface ChannelAskUserQuestion {
    question: string;
    header: string;
    options: { label: string; description: string }[];
    multiple?: boolean;
}

export interface ChannelAskUserRequest {
    questions: ChannelAskUserQuestion[];
}

/** 审批结果 */
export interface ChannelApprovalOutcome {
    decision: 'allow' | 'deny';
    /** deny 的原因（user_denied / timeout / no_interaction / send_failed） */
    denyReason?: 'user_denied' | 'timeout' | 'no_interaction' | 'send_failed';
    /** 发送失败时的底层错误信息（仅 denyReason === 'send_failed' 时携带，用于诊断） */
    error?: string;
}

/** askUser 结果（对齐 AskUserResponse） */
export interface ChannelAskUserOutcome {
    answers: Record<number, string[]>;
    cancelled?: boolean;
}

/** 入站交互事件（由 NativeChannelAdapter 的 dispatchInteraction 转发而来） */
export interface ChannelInteractionEventInput {
    kind: 'approval' | 'askUser';
    interactionId: string;
    accountId?: string;
    operator: { id: string; name?: string };
    decision?: 'allow' | 'deny';
    answers?: Record<number, string[]>;
    cancelled?: boolean;
    raw?: unknown;
}

interface PendingInteractionBase {
    interactionId: string;
    kind: 'approval' | 'askUser';
    channelId: string;
    accountId: string;
    recipientId: string;
    /** 发起交互的任务（用于任务停止时精确取消） */
    taskId?: string;
    expiresAt: number;
    timer: NodeJS.Timeout;
}

interface PendingApproval extends PendingInteractionBase {
    kind: 'approval';
    resolve: (outcome: ChannelApprovalOutcome) => void;
}

interface PendingAskUser extends PendingInteractionBase {
    kind: 'askUser';
    resolve: (outcome: ChannelAskUserOutcome) => void;
}

type PendingInteraction = PendingApproval | PendingAskUser;

/** 默认交互 TTL：5 分钟（与飞书审批卡片一致） */
const DEFAULT_INTERACTION_TTL_MS = 5 * 60_000;

function isUsableChannel(cp: ChannelPlugin | undefined): cp is ChannelPlugin {
    return Boolean(cp && cp.capabilities?.interactive === true && typeof cp.sendInteraction === 'function');
}

/** 创建交互超时定时器（unref，避免 pending 交互阻止进程退出）。 */
function createInteractionTimer(ttlMs: number, callback: () => void): NodeJS.Timeout {
    const timer = setTimeout(callback, ttlMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
}

export class ChannelInteractionService {
    private readonly pending = new Map<string, PendingInteraction>();

    constructor(
        private readonly findEntry: (channelId: string) => PluginEntry | undefined,
        private readonly now: () => number = Date.now
    ) {}

    /** 渠道是否支持结构化用户交互（据此决定是否挂载交互工具）。 */
    supportsInteractive(channelId: string): boolean {
        return isUsableChannel(this.findEntry(channelId)?.channelPlugin);
    }

    /**
     * 发起权限审批请求到渠道。返回 Promise，用户在渠道侧点击或超时后结算。
     * 渠道不支持交互时立即返回 deny（no_interaction）。
     */
    requestApproval(
        participant: Participant,
        request: ChannelApprovalRequest,
        ttlMs: number = DEFAULT_INTERACTION_TTL_MS,
        taskId?: string
    ): Promise<ChannelApprovalOutcome> {
        const entry = this.findEntry(participant.channel);
        const cp = entry?.channelPlugin;
        if (!isUsableChannel(cp)) {
            logger.warn(
                `[channel-interaction] approval requested but channel ${participant.channel} has no interaction capability, denying`
            );
            return Promise.resolve({ decision: 'deny', denyReason: 'no_interaction' });
        }

        const interactionId = this.createInteractionId();
        const expiresAt = this.now() + ttlMs;

        return new Promise<ChannelApprovalOutcome>((resolve) => {
            const pendingApproval: PendingApproval = {
                interactionId,
                kind: 'approval',
                channelId: participant.channel,
                accountId: participant.accountId,
                recipientId: participant.recipientId,
                taskId,
                expiresAt,
                timer: createInteractionTimer(ttlMs, () => {
                    this.pending.delete(interactionId);
                    logger.info(`[channel-interaction] approval ${interactionId} timed out, denying`);
                    resolve({ decision: 'deny', denyReason: 'timeout' });
                }),
                resolve
            };
            this.pending.set(interactionId, pendingApproval);

            const requestPayload = {
                interactionId,
                kind: 'approval' as const,
                to: {
                    chatType: (participant as { chatType?: 'direct' | 'group' }).chatType ?? 'direct',
                    recipientId: participant.recipientId
                },
                accountId: participant.accountId,
                expiresAt,
                payload: request
            };
            cp.sendInteraction!(requestPayload).catch((err: unknown) => {
                const current = this.pending.get(interactionId);
                if (current !== pendingApproval) return; // 已被用户响应结算
                this.pending.delete(interactionId);
                clearTimeout(pendingApproval.timer);
                const errorMessage = err instanceof Error ? err.message : String(err);
                logger.error(`[channel-interaction] send approval ${interactionId} failed: ${errorMessage}`);
                resolve({ decision: 'deny', denyReason: 'send_failed', error: errorMessage });
            });
        });
    }

    /**
     * 发起 askUser 提问到渠道。返回 Promise，用户在渠道侧选择（或取消/超时）后结算。
     * 渠道不支持交互时立即返回 cancelled。
     */
    askUser(
        participant: Participant,
        request: ChannelAskUserRequest,
        ttlMs: number = DEFAULT_INTERACTION_TTL_MS,
        taskId?: string
    ): Promise<ChannelAskUserOutcome> {
        const entry = this.findEntry(participant.channel);
        const cp = entry?.channelPlugin;
        if (!isUsableChannel(cp)) {
            logger.warn(
                `[channel-interaction] askUser requested but channel ${participant.channel} has no interaction capability, cancelling`
            );
            return Promise.resolve({ answers: {}, cancelled: true });
        }

        const interactionId = this.createInteractionId();
        const expiresAt = this.now() + ttlMs;

        return new Promise<ChannelAskUserOutcome>((resolve) => {
            const pendingAsk: PendingAskUser = {
                interactionId,
                kind: 'askUser',
                channelId: participant.channel,
                accountId: participant.accountId,
                recipientId: participant.recipientId,
                taskId,
                expiresAt,
                timer: createInteractionTimer(ttlMs, () => {
                    this.pending.delete(interactionId);
                    logger.info(`[channel-interaction] askUser ${interactionId} timed out, cancelling`);
                    resolve({ answers: {}, cancelled: true });
                }),
                resolve
            };
            this.pending.set(interactionId, pendingAsk);

            const requestPayload = {
                interactionId,
                kind: 'askUser' as const,
                to: {
                    chatType: (participant as { chatType?: 'direct' | 'group' }).chatType ?? 'direct',
                    recipientId: participant.recipientId
                },
                accountId: participant.accountId,
                expiresAt,
                payload: request
            };
            cp.sendInteraction!(requestPayload).catch((err: unknown) => {
                const current = this.pending.get(interactionId);
                if (current !== pendingAsk) return;
                this.pending.delete(interactionId);
                clearTimeout(pendingAsk.timer);
                logger.error(
                    `[channel-interaction] send askUser ${interactionId} failed: ${err instanceof Error ? err.message : String(err)}`
                );
                resolve({ answers: {}, cancelled: true });
            });
        });
    }

    /** 结算入站交互事件（用户在渠道侧点击了按钮/选项）。返回是否匹配到 pending 请求。 */
    handleInteractionEvent(channelId: string, accountId: string, event: ChannelInteractionEventInput): boolean {
        const pending = this.pending.get(event.interactionId);
        if (!pending) {
            logger.warn(
                `[channel-interaction] received event for unknown/expired interaction ${event.interactionId} ` +
                    `(${channelId}:${accountId})`
            );
            return false;
        }
        if (pending.channelId !== channelId || pending.accountId !== accountId) {
            logger.warn(
                `[channel-interaction] interaction ${event.interactionId} belongs to ` +
                    `${pending.channelId}:${pending.accountId}, event from ${channelId}:${accountId}`
            );
            return false;
        }
        this.pending.delete(event.interactionId);
        clearTimeout(pending.timer);

        if (pending.kind === 'approval') {
            const decision = event.cancelled ? 'deny' : event.decision === 'allow' ? 'allow' : 'deny';
            logger.info(
                `[channel-interaction] approval ${event.interactionId} settled: ${decision} by ${event.operator?.id}`
            );
            pending.resolve({ decision, denyReason: decision === 'deny' ? 'user_denied' : undefined });
        } else {
            const cancelled = event.cancelled === true;
            logger.info(
                `[channel-interaction] askUser ${event.interactionId} settled` +
                    (cancelled ? ' (cancelled)' : ` by ${event.operator?.id}`)
            );
            pending.resolve(
                cancelled ? { answers: event.answers ?? {}, cancelled: true } : { answers: event.answers ?? {} }
            );
        }
        return true;
    }

    /** 取消某渠道（可按账号/会话过滤）的所有 pending 交互，按取消结算。 */
    cancelChannelInteractions(channelId: string, accountId?: string, recipientId?: string): void {
        for (const [id, pending] of [...this.pending.entries()]) {
            if (pending.channelId !== channelId) continue;
            if (accountId !== undefined && pending.accountId !== accountId) continue;
            if (recipientId !== undefined && pending.recipientId !== recipientId) continue;
            this.settleCancelled(pending, id);
        }
    }

    /** 取消指定任务发起的 pending 交互（任务停止时调用），按取消结算。 */
    cancelTaskPrompts(taskIds: string[]): void {
        const ids = new Set(taskIds);
        for (const [id, pending] of [...this.pending.entries()]) {
            if (pending.taskId !== undefined && ids.has(pending.taskId)) {
                this.settleCancelled(pending, id);
            }
        }
    }

    private settleCancelled(pending: PendingInteraction, id: string): void {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (pending.kind === 'approval') {
            pending.resolve({ decision: 'deny', denyReason: 'user_denied' });
        } else {
            pending.resolve({ answers: {}, cancelled: true });
        }
    }

    /** 当前挂起的交互数量（诊断/测试用）。 */
    pendingCount(): number {
        return this.pending.size;
    }

    private createInteractionId(): string {
        return `odk-${crypto.randomBytes(8).toString('hex')}`;
    }
}
