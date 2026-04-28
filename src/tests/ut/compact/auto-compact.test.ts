import { jest } from '@jest/globals';
import {
    MAX_RESERVED_SUMMARY_OUTPUT,
    AutoCompactStates,
    DEFAULT_AUTO_COMPACT_BUFFER,
    DEFAULT_AUTO_COMPACT_COOLDOWN_MS,
    DEFAULT_AUTO_COMPACT_FAILURE_THRESHOLD,
    DEFAULT_AUTO_COMPACT_RESERVED_SUMMARY_OUTPUT,
    createAutoCompactDecision,
    resolveReservedSummaryOutput
} from '../../../main/aikernel/compaction/auto-compact';
import { ModelInstance, Setting } from '../../../main/utils/setting';

afterEach(() => {
    jest.restoreAllMocks();
});

describe('自动压缩决策', () => {
    test('缺少 context tokens 时不触发自动压缩，并保留 Claude 风格默认阈值计算结果', () => {
        const decision = createAutoCompactDecision({
            contextWindow: 50000
        });

        expect(decision.shouldCompact).toBe(false);
        expect(decision.reason).toBe('missing_context_tokens');
        expect(decision.contextWindow).toBe(50000);
        expect(decision.reservedSummaryOutput).toBe(DEFAULT_AUTO_COMPACT_RESERVED_SUMMARY_OUTPUT);
        expect(decision.effectiveWindow).toBe(50000 - DEFAULT_AUTO_COMPACT_RESERVED_SUMMARY_OUTPUT);
        expect(decision.buffer).toBe(DEFAULT_AUTO_COMPACT_BUFFER);
        expect(decision.autoCompactThreshold).toBe(
            50000 - DEFAULT_AUTO_COMPACT_RESERVED_SUMMARY_OUTPUT - DEFAULT_AUTO_COMPACT_BUFFER
        );
    });

    test('上下文窗口未知时不触发自动压缩', () => {
        const decision = createAutoCompactDecision({
            contextWindow: 0,
            estimatedContextTokens: 500
        });

        expect(decision.shouldCompact).toBe(false);
        expect(decision.reason).toBe('unknown_context_window');
        expect(decision.estimatedContextTokens).toBe(500);
        expect(decision.contextWindow).toBe(0);
        expect(decision.autoCompactThreshold).toBe(0);
        expect(decision.windowUsageRatio).toBeUndefined();
        expect(decision.marginTokens).toBeUndefined();
    });

    test('默认固定 buffer 下，阈值以下不触发自动压缩', () => {
        const decision = createAutoCompactDecision({
            contextWindow: 100000,
            estimatedContextTokens: 66999,
            reservedSummaryOutput: 20000,
            baseUsageTokens: 64000,
            tailEstimatedTokens: 2000,
            assistantInternalTailTokens: 999,
            tokenEstimateSource: 'usage_plus_tail_estimate'
        });

        expect(decision.shouldCompact).toBe(false);
        expect(decision.reason).toBe('below_threshold');
        expect(decision.effectiveWindow).toBe(80000);
        expect(decision.buffer).toBe(DEFAULT_AUTO_COMPACT_BUFFER);
        expect(decision.autoCompactThreshold).toBe(67000);
        expect(decision.marginTokens).toBe(1);
        expect(decision.windowUsageRatio).toBeCloseTo(0.66999);
        expect(decision.baseUsageTokens).toBe(64000);
        expect(decision.tailEstimatedTokens).toBe(2000);
        expect(decision.assistantInternalTailTokens).toBe(999);
        expect(decision.tokenEstimateSource).toBe('usage_plus_tail_estimate');
    });

    test('到达阈值时触发自动压缩', () => {
        const decision = createAutoCompactDecision({
            contextWindow: 100000,
            estimatedContextTokens: 67000,
            reservedSummaryOutput: 20000
        });

        expect(decision.shouldCompact).toBe(true);
        expect(decision.reason).toBe('at_or_above_threshold');
        expect(decision.autoCompactThreshold).toBe(67000);
        expect(decision.marginTokens).toBe(0);
    });

    test('自定义 buffer 会覆盖默认 buffer 计算', () => {
        const decision = createAutoCompactDecision({
            contextWindow: 1000,
            estimatedContextTokens: 849,
            reservedSummaryOutput: 100,
            buffer: 50
        });

        expect(decision.shouldCompact).toBe(false);
        expect(decision.buffer).toBe(50);
        expect(decision.autoCompactThreshold).toBe(850);
        expect(decision.marginTokens).toBe(1);
    });

    test('已知模型名会通过最大输出 lookup 推导 reserved summary output', async () => {
        await expect(resolveReservedSummaryOutput('anthropic/claude-4-sonnet')).resolves.toBe(
            MAX_RESERVED_SUMMARY_OUTPUT
        );
        await expect(resolveReservedSummaryOutput('openai/gpt-4o-2024-11-20')).resolves.toBe(
            DEFAULT_AUTO_COMPACT_RESERVED_SUMMARY_OUTPUT
        );
    });

    test('API 返回的最大输出 token 会在 reserved summary output 中被 capped 到 20k', async () => {
        jest.spyOn(Setting, 'getInstance').mockReturnValue({
            getModelInstance: () => new ModelInstance('custom-summary-model', 'https://example.com', 'test-key', false),
            getDefaultModelInstance: () =>
                new ModelInstance('custom-summary-model', 'https://example.com', 'test-key', false)
        } as unknown as Setting);
        const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                token_limits: {
                    max_output_tokens: 65536
                }
            })
        } as Response);

        await expect(resolveReservedSummaryOutput('custom-model-alias')).resolves.toBe(MAX_RESERVED_SUMMARY_OUTPUT);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://example.com/models/custom-summary-model');
    });
});

describe('自动压缩状态机', () => {
    test('create 返回默认失败阈值和冷却时长', () => {
        const state = AutoCompactStates.create();

        expect(state.consecutiveFailures).toBe(0);
        expect(state.failureThreshold).toBe(DEFAULT_AUTO_COMPACT_FAILURE_THRESHOLD);
        expect(state.cooldownMs).toBe(DEFAULT_AUTO_COMPACT_COOLDOWN_MS);
        expect(state.lastAttemptAt).toBeUndefined();
        expect(state.cooldownUntil).toBeUndefined();
    });

    test('deserialize 会归一化序列化字段、时间戳和非法数字', () => {
        const state = AutoCompactStates.deserialize({
            consecutive_failures: 2.8,
            last_attempt_at: '2026-04-17T10:00:00+08:00',
            last_failure_at: 'invalid-date',
            cooldown_until: '2026-04-17T10:10:00+08:00',
            failure_threshold: 0,
            cooldown_ms: -1,
            last_failure_reason: '  compact failed  '
        });

        expect(state.consecutiveFailures).toBe(2);
        expect(state.lastAttemptAt).toBe('2026-04-17T02:00:00.000Z');
        expect(state.lastFailureAt).toBeUndefined();
        expect(state.cooldownUntil).toBe('2026-04-17T02:10:00.000Z');
        expect(state.failureThreshold).toBe(1);
        expect(state.cooldownMs).toBe(0);
        expect(state.lastFailureReason).toBe('compact failed');
    });

    test('recordAttempt 仅更新时间，不改变失败计数', () => {
        const at = new Date('2026-04-17T02:00:00.000Z');
        const previous = AutoCompactStates.deserialize({
            consecutive_failures: 1,
            failure_threshold: 3,
            cooldown_ms: 60000
        });

        const state = AutoCompactStates.recordAttempt(previous, at);

        expect(state.consecutiveFailures).toBe(1);
        expect(state.lastAttemptAt).toBe(at.toISOString());
        expect(state.lastFailureAt).toBeUndefined();
        expect(state.cooldownUntil).toBeUndefined();
    });

    test('recordFailure 在未达到阈值前只累加失败次数，不进入冷却期', () => {
        const at = new Date('2026-04-17T02:00:00.000Z');
        const previous = AutoCompactStates.deserialize({
            consecutive_failures: 1,
            failure_threshold: 3,
            cooldown_ms: 60000
        });

        const state = AutoCompactStates.recordFailure(previous, at, '  network timeout  ');

        expect(state.consecutiveFailures).toBe(2);
        expect(state.lastAttemptAt).toBe(at.toISOString());
        expect(state.lastFailureAt).toBe(at.toISOString());
        expect(state.cooldownUntil).toBeUndefined();
        expect(state.lastFailureReason).toBe('network timeout');
        expect(AutoCompactStates.hasReachedFailureThreshold(state)).toBe(false);
        expect(AutoCompactStates.isCoolingDown(state, at)).toBe(false);
    });

    test('recordFailure 达到阈值后进入冷却期，并可计算剩余时长', () => {
        const at = new Date('2026-04-17T02:00:00.000Z');
        const previous = AutoCompactStates.deserialize({
            consecutive_failures: 1,
            failure_threshold: 2,
            cooldown_ms: 60000
        });

        const state = AutoCompactStates.recordFailure(previous, at, 'compact failed');

        expect(state.consecutiveFailures).toBe(2);
        expect(state.cooldownUntil).toBe('2026-04-17T02:01:00.000Z');
        expect(AutoCompactStates.hasReachedFailureThreshold(state)).toBe(true);
        expect(AutoCompactStates.isCoolingDown(state, at)).toBe(true);
        expect(AutoCompactStates.getCooldownRemainingMs(state, new Date('2026-04-17T02:00:30.000Z'))).toBe(30000);
        expect(AutoCompactStates.getCooldownRemainingMs(state, new Date('2026-04-17T02:01:01.000Z'))).toBe(0);
        expect(AutoCompactStates.isCoolingDown(state, new Date('2026-04-17T02:01:01.000Z'))).toBe(false);
    });

    test('recordSuccess 会清空失败次数、冷却期和失败原因', () => {
        const at = new Date('2026-04-17T02:02:00.000Z');
        const previous = AutoCompactStates.deserialize({
            consecutive_failures: 3,
            last_attempt_at: '2026-04-17T02:01:00.000Z',
            last_failure_at: '2026-04-17T02:01:00.000Z',
            cooldown_until: '2026-04-17T02:11:00.000Z',
            failure_threshold: 3,
            cooldown_ms: 600000,
            last_failure_reason: 'compact failed'
        });

        const state = AutoCompactStates.recordSuccess(previous, at);

        expect(state.consecutiveFailures).toBe(0);
        expect(state.lastAttemptAt).toBe(at.toISOString());
        expect(state.lastSuccessAt).toBe(at.toISOString());
        expect(state.cooldownUntil).toBeUndefined();
        expect(state.lastFailureReason).toBeUndefined();
        expect(state.failureThreshold).toBe(3);
        expect(state.cooldownMs).toBe(600000);
    });

    test('serialize 和 deserialize 可以稳定往返', () => {
        const original = AutoCompactStates.deserialize({
            consecutive_failures: 2,
            last_attempt_at: '2026-04-17T02:00:00.000Z',
            last_failure_at: '2026-04-17T02:00:00.000Z',
            last_success_at: '2026-04-17T01:55:00.000Z',
            cooldown_until: '2026-04-17T02:10:00.000Z',
            failure_threshold: 4,
            cooldown_ms: 120000,
            last_failure_reason: 'compact failed'
        });

        const serialized = AutoCompactStates.serialize(original);
        const restored = AutoCompactStates.deserialize(serialized);

        expect(serialized).toEqual({
            consecutive_failures: 2,
            last_attempt_at: '2026-04-17T02:00:00.000Z',
            last_failure_at: '2026-04-17T02:00:00.000Z',
            last_success_at: '2026-04-17T01:55:00.000Z',
            cooldown_until: '2026-04-17T02:10:00.000Z',
            failure_threshold: 4,
            cooldown_ms: 120000,
            last_failure_reason: 'compact failed'
        });
        expect(restored).toEqual(original);
    });
});
