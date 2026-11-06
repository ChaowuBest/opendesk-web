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
import type { Participant } from '../../aikernel/types/index.js';
import type { ChannelPlugin } from './types.js';

/** 审批请求的对外形态（与 permission 系统解耦的载荷） */
export interface ChannelApprovalRequest {
    prompt: string;
    tool?: string;
    requests: unknown[];
    confirmLabel?: string;
    cancelLabel?: string;
    /** 是否展示"本次会话始终允许"按钮；文案由渠道插件自行本地化 */
    allowRemember?: boolean;
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

/** selection 请求的对外形态：单选列表（渠道按能力渲染为卡片按钮或编号文本） */
export interface ChannelSelectionRequest {
    /** 列表标题 */
    header: string;
    /** 选项列表；value 为回传标识（如 taskId），label 为展示文本 */
    options: { label: string; value: string }[];
    /** 列表末尾的提示文案（如分页语法说明），可选 */
    hint?: string;
}

/** 审批结果 */
export interface ChannelApprovalOutcome {
    decision: 'allow' | 'deny';
    /** 用户选择的记住范围：'session' 表示本次会话内同类操作始终允许（仅当用户点击"始终允许"时携带） */
    rememberScope?: 'none' | 'session';
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

/** selection 结果；cancelled 表示用户取消或交互超时 */
export interface ChannelSelectionOutcome {
    selected?: string;
    cancelled?: boolean;
    /** 发送失败时的底层错误信息（用于诊断） */
    error?: string;
}

/** 入站交互事件（由 NativeChannelAdapter 的 dispatchInteraction 转发而来） */
export interface ChannelInteractionEventInput {
    kind: 'approval' | 'askUser' | 'selection';
    interactionId: string;
    accountId?: string;
    operator: { id: string; name?: string };
    decision?: 'allow' | 'deny';
    /** 用户点击"始终允许"按钮时回传 'session'（仅 decision === 'allow' 时有意义） */
    rememberScope?: 'none' | 'session';
    answers?: Record<number, string[]>;
    /** selection 事件：用户选中的选项 value */
    selected?: string;
    cancelled?: boolean;
    raw?: unknown;
}

/** 交互类型：权限审批 / 向用户提问 / 单选列表 */
export type PendingInteractionKind = 'approval' | 'askUser' | 'selection';

interface PendingInteractionBase {
    interactionId: string;
    kind: PendingInteractionKind;
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

interface PendingSelection extends PendingInteractionBase {
    kind: 'selection';
    resolve: (outcome: ChannelSelectionOutcome) => void;
}

type PendingInteraction = PendingApproval | PendingAskUser | PendingSelection;

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
        private readonly findEntry: (channelId: string) => { channelPlugin: ChannelPlugin } | undefined,
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
                    chatType: participant.chatType ?? 'direct',
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
                    chatType: participant.chatType ?? 'direct',
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

    /**
     * 发起单选列表到渠道（如 /list 会话切换卡片）。返回 Promise，用户点选（或取消/超时）后结算。
     * 渠道不支持交互时立即返回 cancelled（调用方应先用 supportsInteractive 预判并走文本回退）。
     */
    requestSelection(
        participant: Participant,
        request: ChannelSelectionRequest,
        ttlMs: number = DEFAULT_INTERACTION_TTL_MS,
        taskId?: string
    ): Promise<ChannelSelectionOutcome> {
        const entry = this.findEntry(participant.channel);
        const cp = entry?.channelPlugin;
        if (!isUsableChannel(cp)) {
            logger.warn(
                `[channel-interaction] selection requested but channel ${participant.channel} has no interaction capability, cancelling`
            );
            return Promise.resolve({ cancelled: true });
        }

        const interactionId = this.createInteractionId();
        const expiresAt = this.now() + ttlMs;

        return new Promise<ChannelSelectionOutcome>((resolve) => {
            const pendingSelection: PendingSelection = {
                interactionId,
                kind: 'selection',
                channelId: participant.channel,
                accountId: participant.accountId,
                recipientId: participant.recipientId,
                taskId,
                expiresAt,
                timer: createInteractionTimer(ttlMs, () => {
                    this.pending.delete(interactionId);
                    logger.info(`[channel-interaction] selection ${interactionId} timed out, cancelling`);
                    resolve({ cancelled: true });
                }),
                resolve
            };
            this.pending.set(interactionId, pendingSelection);

            const requestPayload = {
                interactionId,
                kind: 'selection' as const,
                to: {
                    chatType: participant.chatType ?? 'direct',
                    recipientId: participant.recipientId
                },
                accountId: participant.accountId,
                expiresAt,
                payload: request
            };
            cp.sendInteraction!(requestPayload).catch((err: unknown) => {
                const current = this.pending.get(interactionId);
                if (current !== pendingSelection) return;
                this.pending.delete(interactionId);
                clearTimeout(pendingSelection.timer);
                const errorMessage = err instanceof Error ? err.message : String(err);
                logger.error(`[channel-interaction] send selection ${interactionId} failed: ${errorMessage}`);
                resolve({ cancelled: true, error: errorMessage });
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
                `[channel-interaction] approval ${event.interactionId} settled: ${decision} by ${event.operator?.id}` +
                    (decision === 'allow' && event.rememberScope === 'session' ? ' (remember session)' : '')
            );
            pending.resolve({
                decision,
                rememberScope: decision === 'allow' ? (event.rememberScope ?? 'none') : undefined,
                denyReason: decision === 'deny' ? 'user_denied' : undefined
            });
        } else if (pending.kind === 'selection') {
            const cancelled = event.cancelled === true;
            logger.info(
                `[channel-interaction] selection ${event.interactionId} settled` +
                    (cancelled ? ' (cancelled)' : ` by ${event.operator?.id}: ${event.selected ?? ''}`)
            );
            pending.resolve(cancelled ? { cancelled: true } : { selected: event.selected });
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

    /**
     * 取消某渠道（可按账号/会话/交互类型过滤）的 pending 交互，按取消结算。
     *
     * @param kinds 只取消这些类型；缺省取消全部。任务级取消必须带上类型，
     *              否则会把与任务无关、仍可点击的 /list 列表卡片一起废掉。
     */
    cancelChannelInteractions(
        channelId: string,
        accountId?: string,
        recipientId?: string,
        kinds?: PendingInteractionKind[]
    ): void {
        const kindSet = kinds ? new Set<PendingInteractionKind>(kinds) : undefined;
        for (const [id, pending] of [...this.pending.entries()]) {
            if (pending.channelId !== channelId) continue;
            if (accountId !== undefined && pending.accountId !== accountId) continue;
            if (recipientId !== undefined && pending.recipientId !== recipientId) continue;
            if (kindSet && !kindSet.has(pending.kind)) continue;
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
        } else if (pending.kind === 'selection') {
            pending.resolve({ cancelled: true });
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
