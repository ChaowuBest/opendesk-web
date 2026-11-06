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
 * 消息分发策略：决定渠道入站消息复用当前激活任务还是创建新任务。
 *
 * 公共前置规则（绑定不存在 / 绑定任务已失效 → 一律新建）由 router 的会话解析层处理，
 * 策略只负责「存在有效激活任务」时的判定，保证各策略实现彼此独立且可单测。
 */

/** 消息分发策略模式 */
export type DispatchMode = 'sticky' | 'timeout' | 'smart';

/** 账号级消息分发策略配置（存于 accountRuntime.dispatchPolicy） */
export interface DispatchPolicyConfig {
    mode: DispatchMode;
    /** mode === 'timeout' 时的切换周期（分钟），缺省 1440（1 天） */
    timeoutMinutes?: number;
}

/** 默认策略：一定时间后切换到新任务，周期 1 天 */
export const DEFAULT_DISPATCH_POLICY: DispatchPolicyConfig = { mode: 'timeout', timeoutMinutes: 1440 };

/** smart 策略 LLM 判定失败时的时间兜底（与历史行为的 15 分钟超时一致） */
export const SMART_FALLBACK_TIMEOUT_MS = 15 * 60 * 1000;

export interface DispatchContext {
    /** 激活任务最后一条消息（含 assistant 回复）的时间戳 */
    lastActivityAt: number;
    /** 入站消息文本 */
    inboundText: string;
    /** 激活任务最近对话文本摘要（供 smart 判定）；无历史时为 null */
    recentTurnsText: string | null;
    now: number;
}

export type DispatchDecision = { action: 'reuse' } | { action: 'create'; reason: string };

export interface TaskDispatchPolicy {
    readonly id: DispatchMode;
    decide(ctx: DispatchContext): Promise<DispatchDecision>;
}

/**
 * 关联性判定器：true = 发给已有任务，false = 应开新任务。
 * 抛错表示判定不可用（网络/超时等），由策略自行决定兜底方式。
 */
export type RelevanceJudge = (input: { recentTurnsText: string | null; inboundText: string }) => Promise<boolean>;

/** 总是分发到同一任务：激活任务存在即复用 */
export class StickyPolicy implements TaskDispatchPolicy {
    readonly id = 'sticky' as const;

    async decide(): Promise<DispatchDecision> {
        return { action: 'reuse' };
    }
}

/** 一定时间后切换到新任务：激活任务空闲超过阈值即新建 */
export class TimeoutPolicy implements TaskDispatchPolicy {
    readonly id = 'timeout' as const;

    constructor(private readonly timeoutMs: number) {}

    async decide(ctx: DispatchContext): Promise<DispatchDecision> {
        const idleMs = ctx.now - ctx.lastActivityAt;
        if (idleMs > this.timeoutMs) {
            return {
                action: 'create',
                reason: `空闲 ${Math.floor(idleMs / 60000)} 分钟超过阈值 ${Math.floor(this.timeoutMs / 60000)} 分钟`
            };
        }
        return { action: 'reuse' };
    }
}

/** 智能投递：LLM 判定消息归属，判定失败回退时间兜底 */
export class SmartPolicy implements TaskDispatchPolicy {
    readonly id = 'smart' as const;

    constructor(
        private readonly judge: RelevanceJudge,
        private readonly fallbackTimeoutMs: number,
        private readonly onJudgeError?: (err: unknown) => void
    ) {}

    async decide(ctx: DispatchContext): Promise<DispatchDecision> {
        try {
            const related = await this.judge({ recentTurnsText: ctx.recentTurnsText, inboundText: ctx.inboundText });
            if (!related) {
                return { action: 'create', reason: 'smart: LLM 判定为新任务' };
            }
            return { action: 'reuse' };
        } catch (err) {
            // 判定失败是「智能投递悄悄退化成超时判断」，必须留痕，否则线上无从排查
            this.onJudgeError?.(err);
            const idleMs = ctx.now - ctx.lastActivityAt;
            if (idleMs > this.fallbackTimeoutMs) {
                return {
                    action: 'create',
                    reason: `smart: LLM 判定失败回退超时（空闲 ${Math.floor(idleMs / 60000)} 分钟）`
                };
            }
            return { action: 'reuse' };
        }
    }
}

export interface DispatchPolicyDeps {
    /** smart 模式的关联性判定器 */
    judge: RelevanceJudge;
    /** smart 判定失败时的回调（由宿主接日志/指标，策略本身不依赖日志实现） */
    onJudgeError?: (err: unknown) => void;
}

/** 按配置构建策略实例；timeoutMinutes 非法时回退默认周期 */
export function createDispatchPolicy(config: DispatchPolicyConfig, deps: DispatchPolicyDeps): TaskDispatchPolicy {
    switch (config.mode) {
        case 'sticky':
            return new StickyPolicy();
        case 'smart':
            return new SmartPolicy(deps.judge, SMART_FALLBACK_TIMEOUT_MS, deps.onJudgeError);
        case 'timeout':
        default:
            return new TimeoutPolicy(normalizeTimeoutMinutes(config.timeoutMinutes) * 60_000);
    }
}

/** 把账号配置中的原始 dispatchPolicy 解析为合法配置，非法值逐字段回退默认 */
export function normalizeDispatchPolicy(raw: unknown): DispatchPolicyConfig {
    if (!raw || typeof raw !== 'object') {
        return { ...DEFAULT_DISPATCH_POLICY };
    }
    const mode = (raw as Record<string, unknown>).mode;
    if (mode !== 'sticky' && mode !== 'timeout' && mode !== 'smart') {
        return { ...DEFAULT_DISPATCH_POLICY };
    }
    return { mode, timeoutMinutes: normalizeTimeoutMinutes((raw as Record<string, unknown>).timeoutMinutes) };
}

function normalizeTimeoutMinutes(raw: unknown): number {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        return raw;
    }
    return DEFAULT_DISPATCH_POLICY.timeoutMinutes ?? 1440;
}
