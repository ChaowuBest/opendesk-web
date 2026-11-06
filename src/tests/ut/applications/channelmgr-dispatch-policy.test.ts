import { describe, expect, jest, test } from '@jest/globals';
import {
    DEFAULT_DISPATCH_POLICY,
    SMART_FALLBACK_TIMEOUT_MS,
    SmartPolicy,
    StickyPolicy,
    TimeoutPolicy,
    createDispatchPolicy,
    normalizeDispatchPolicy
} from '../../../main/applications/channelmgr/dispatch/policy.js';

function makeCtx(overrides: Partial<Parameters<StickyPolicy['decide']>[0]> = {}) {
    return {
        lastActivityAt: 1_000_000,
        inboundText: '新消息',
        recentTurnsText: '[用户]: 之前的话题\n[助手]: 之前的回复',
        now: 1_100_000,
        ...overrides
    };
}

describe('StickyPolicy', () => {
    test('激活任务存在时总是复用', async () => {
        const policy = new StickyPolicy();
        expect(await policy.decide(makeCtx())).toEqual({ action: 'reuse' });
        expect(await policy.decide(makeCtx({ lastActivityAt: 0, now: Number.MAX_SAFE_INTEGER }))).toEqual({
            action: 'reuse'
        });
    });
});

describe('TimeoutPolicy', () => {
    test('空闲时间未超过阈值时复用', async () => {
        const policy = new TimeoutPolicy(1440 * 60_000);
        expect(await policy.decide(makeCtx({ lastActivityAt: 1_000_000, now: 1_100_000 }))).toEqual({
            action: 'reuse'
        });
    });

    test('空闲时间恰好等于阈值时复用（阈值判断为严格大于）', async () => {
        const policy = new TimeoutPolicy(100_000);
        expect(await policy.decide(makeCtx({ lastActivityAt: 1_000_000, now: 1_100_000 }))).toEqual({
            action: 'reuse'
        });
    });

    test('空闲时间超过阈值时创建新任务并给出原因', async () => {
        const policy = new TimeoutPolicy(100_000);
        const decision = await policy.decide(makeCtx({ lastActivityAt: 1_000_000, now: 1_160_000 }));
        expect(decision.action).toBe('create');
        expect(decision.action === 'create' && decision.reason).toContain('2 分钟');
        expect(decision.action === 'create' && decision.reason).toContain('1 分钟');
    });
});

describe('SmartPolicy', () => {
    test('LLM 判定为已有任务时复用', async () => {
        const judge = jest.fn(async () => true);
        const policy = new SmartPolicy(judge, SMART_FALLBACK_TIMEOUT_MS);
        expect(await policy.decide(makeCtx())).toEqual({ action: 'reuse' });
        expect(judge).toHaveBeenCalledWith({ recentTurnsText: makeCtx().recentTurnsText, inboundText: '新消息' });
    });

    test('LLM 判定为新任务时创建新任务', async () => {
        const judge = jest.fn(async () => false);
        const policy = new SmartPolicy(judge, SMART_FALLBACK_TIMEOUT_MS);
        const decision = await policy.decide(makeCtx());
        expect(decision.action).toBe('create');
    });

    test('无历史时判定器返回保持会话', async () => {
        const judge = jest.fn(async () => true); // router 侧 judgeRelevance 对 null 历史短路返回 true
        const policy = new SmartPolicy(judge, SMART_FALLBACK_TIMEOUT_MS);
        expect(await policy.decide(makeCtx({ recentTurnsText: null }))).toEqual({ action: 'reuse' });
    });

    test('LLM 判定失败且空闲未超过兜底超时时复用', async () => {
        const judge = jest.fn(async () => {
            throw new Error('timeout');
        });
        const policy = new SmartPolicy(judge, SMART_FALLBACK_TIMEOUT_MS);
        expect(await policy.decide(makeCtx({ lastActivityAt: 1_000_000, now: 1_100_000 }))).toEqual({
            action: 'reuse'
        });
    });

    test('LLM 判定失败且空闲超过兜底超时时创建新任务', async () => {
        const judge = jest.fn(async () => {
            throw new Error('timeout');
        });
        const policy = new SmartPolicy(judge, SMART_FALLBACK_TIMEOUT_MS);
        const decision = await policy.decide(makeCtx({ lastActivityAt: 0, now: SMART_FALLBACK_TIMEOUT_MS + 60_000 }));
        expect(decision.action).toBe('create');
    });

    test('判定失败会回调 onJudgeError，便于发现智能投递静默退化', async () => {
        const judge = jest.fn(async () => {
            throw new Error('model unavailable');
        });
        const onJudgeError = jest.fn();
        const policy = new SmartPolicy(judge, SMART_FALLBACK_TIMEOUT_MS, onJudgeError);

        await policy.decide(makeCtx());

        expect(onJudgeError).toHaveBeenCalledTimes(1);
        expect((onJudgeError.mock.calls[0][0] as Error).message).toBe('model unavailable');
    });
});

describe('normalizeDispatchPolicy', () => {
    test('空值/非对象回退默认策略 timeout + 1440', () => {
        expect(normalizeDispatchPolicy(undefined)).toEqual(DEFAULT_DISPATCH_POLICY);
        expect(normalizeDispatchPolicy(null)).toEqual(DEFAULT_DISPATCH_POLICY);
        expect(normalizeDispatchPolicy('sticky')).toEqual(DEFAULT_DISPATCH_POLICY);
        expect(DEFAULT_DISPATCH_POLICY).toEqual({ mode: 'timeout', timeoutMinutes: 1440 });
    });

    test('mode 非法时整体回退默认', () => {
        expect(normalizeDispatchPolicy({ mode: 'random' })).toEqual(DEFAULT_DISPATCH_POLICY);
    });

    test('合法 mode 保留，timeoutMinutes 缺省/非法回退 1440', () => {
        expect(normalizeDispatchPolicy({ mode: 'sticky' })).toEqual({ mode: 'sticky', timeoutMinutes: 1440 });
        expect(normalizeDispatchPolicy({ mode: 'smart', timeoutMinutes: 'abc' })).toEqual({
            mode: 'smart',
            timeoutMinutes: 1440
        });
        expect(normalizeDispatchPolicy({ mode: 'timeout', timeoutMinutes: -5 })).toEqual({
            mode: 'timeout',
            timeoutMinutes: 1440
        });
    });

    test('合法配置原样保留', () => {
        expect(normalizeDispatchPolicy({ mode: 'timeout', timeoutMinutes: 30 })).toEqual({
            mode: 'timeout',
            timeoutMinutes: 30
        });
    });
});

describe('createDispatchPolicy', () => {
    test('按配置构建对应策略实例', () => {
        const deps = { judge: async () => true };
        expect(createDispatchPolicy({ mode: 'sticky' }, deps).id).toBe('sticky');
        expect(createDispatchPolicy({ mode: 'smart' }, deps).id).toBe('smart');
        expect(createDispatchPolicy({ mode: 'timeout', timeoutMinutes: 30 }, deps).id).toBe('timeout');
    });

    test('timeout 模式按分钟数转换毫秒阈值', async () => {
        const policy = createDispatchPolicy({ mode: 'timeout', timeoutMinutes: 30 }, { judge: async () => true });
        const decision = await policy.decide(makeCtx({ lastActivityAt: 0, now: 30 * 60_000 + 1 }));
        expect(decision.action).toBe('create');
    });

    test('timeoutMinutes 非法时回退默认 1440 分钟', async () => {
        const policy = createDispatchPolicy({ mode: 'timeout' }, { judge: async () => true });
        // 1440 分钟内复用
        expect(await policy.decide(makeCtx({ lastActivityAt: 0, now: 1439 * 60_000 }))).toEqual({ action: 'reuse' });
        // 超过 1440 分钟新建
        expect(await policy.decide(makeCtx({ lastActivityAt: 0, now: 1441 * 60_000 })).then((d) => d.action)).toBe(
            'create'
        );
    });
});
