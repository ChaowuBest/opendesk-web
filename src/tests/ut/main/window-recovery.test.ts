import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
    createReloadBudget,
    createWindowRecoveryController,
    type ChildProcessGoneDetails
} from '../../../main/utils/window-recovery.js';

/** 可控时钟：interval 由 fake timers 推进，时间戳由 clock 手动推进，两者解耦 */
function setupClock() {
    let clock = 0;
    return {
        now: () => clock,
        advance: (ms: number) => {
            clock += ms;
            jest.advanceTimersByTime(ms);
        }
    };
}

function createLogger() {
    return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function gpuDetails(overrides: Partial<ChildProcessGoneDetails> = {}): ChildProcessGoneDetails {
    return { type: 'GPU', reason: 'crashed', exitCode: 512, ...overrides };
}

function setupRecovery(overrides: Record<string, unknown> = {}) {
    const clock = setupClock();
    const log = createLogger();
    const reload = jest.fn(() => true);
    let visible = true;
    const controller = createWindowRecoveryController({
        reload,
        isWindowVisible: () => visible,
        log,
        now: clock.now,
        ...overrides
    });
    controller.start();
    return { clock, log, reload, controller, setVisible: (value: boolean) => (visible = value) };
}

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('reload budget', () => {
    test('allows reloads up to the limit and rejects the next one', () => {
        const clock = setupClock();
        const onExhausted = jest.fn();
        const budget = createReloadBudget({ maxReloads: 3, windowMs: 10_000, now: clock.now, onExhausted });

        expect(budget.tryConsume('a')).toBe(true);
        expect(budget.tryConsume('b')).toBe(true);
        expect(budget.tryConsume('c')).toBe(true);
        expect(budget.tryConsume('d')).toBe(false);
        expect(onExhausted).toHaveBeenCalledTimes(1);
        expect(onExhausted).toHaveBeenCalledWith('d');
    });

    test('grants new quota once the oldest reload falls outside the window', () => {
        const clock = setupClock();
        const budget = createReloadBudget({ maxReloads: 2, windowMs: 10_000, now: clock.now });

        expect(budget.tryConsume('a')).toBe(true);
        expect(budget.tryConsume('b')).toBe(true);
        expect(budget.tryConsume('c')).toBe(false);

        clock.advance(10_001);
        expect(budget.tryConsume('d')).toBe(true);
    });

    test('defaults to three reloads per ten seconds', () => {
        const clock = setupClock();
        const budget = createReloadBudget({ now: clock.now });

        expect(budget.tryConsume('a')).toBe(true);
        expect(budget.tryConsume('b')).toBe(true);
        expect(budget.tryConsume('c')).toBe(true);
        expect(budget.tryConsume('d')).toBe(false);
    });
});

describe('GPU process recovery', () => {
    test('reloads once for a GPU crash and logs the exit details', () => {
        const clock = setupClock();
        const log = createLogger();
        const reload = jest.fn(() => true);
        const controller = createWindowRecoveryController({
            reload,
            isWindowVisible: () => true,
            log,
            now: clock.now
        });
        controller.start();

        controller.onChildProcessGone(gpuDetails());

        expect(reload).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('GPU process gone'));
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('exitCode=512'));
    });

    test.each(['Renderer', 'Utility', 'Plugin', 'Sandbox helper'])(
        'ignores %s process exits, which are handled elsewhere',
        (type) => {
            const { reload, controller } = setupRecovery();

            controller.onChildProcessGone(gpuDetails({ type }));

            expect(reload).not.toHaveBeenCalled();
        }
    );

    test('keeps the heartbeat baseline fresh after a GPU reload so the watchdog stays quiet', () => {
        const { clock, reload, controller } = setupRecovery();

        controller.onChildProcessGone(gpuDetails());
        expect(reload).toHaveBeenCalledTimes(1);

        // renderer 重新加载后立刻恢复心跳，看门狗不应紧接着再次重载
        for (let i = 0; i < 10; i++) {
            clock.advance(3_000);
            controller.onHeartbeat();
        }
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('does not reload when the reload budget is exhausted', () => {
        const clock = setupClock();
        const log = createLogger();
        const reload = jest.fn(() => false);
        const controller = createWindowRecoveryController({
            reload,
            isWindowVisible: () => true,
            log,
            now: clock.now
        });
        controller.start();

        controller.onChildProcessGone(gpuDetails());

        expect(reload).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('budget exhausted'));
    });
});

describe('renderer freeze watchdog', () => {
    test('stays quiet while the renderer keeps reporting heartbeats', () => {
        const { clock, reload, controller } = setupRecovery();

        for (let i = 0; i < 20; i++) {
            clock.advance(3_000);
            controller.onHeartbeat();
        }

        expect(reload).not.toHaveBeenCalled();
    });

    test('reloads once the heartbeat has been silent past the timeout', () => {
        const { clock, reload, log } = setupRecovery();

        clock.advance(15_001);

        expect(reload).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('heartbeat silent'));
    });

    test('does not reload before the timeout elapses', () => {
        const { clock, reload } = setupRecovery();

        clock.advance(14_000);

        expect(reload).not.toHaveBeenCalled();
    });

    test('stops reloading once the reloaded renderer resumes heartbeats', () => {
        const { clock, reload, controller } = setupRecovery();

        // 小步推进模拟时间连续流动，一次性跳变会让每次巡检都看到完整静默时长
        for (let i = 0; i < 4; i++) clock.advance(5_000);
        expect(reload).toHaveBeenCalledTimes(1);

        for (let i = 0; i < 8; i++) {
            clock.advance(3_000);
            controller.onHeartbeat();
        }
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('keeps retrying while the renderer stays silent after a reload', () => {
        const { clock, reload } = setupRecovery();

        for (let i = 0; i < 8; i++) clock.advance(5_000);

        expect(reload.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    test('tolerates a throttled heartbeat while the window is hidden', () => {
        const { clock, reload, setVisible } = setupRecovery();

        setVisible(false);
        clock.advance(60_000);

        expect(reload).not.toHaveBeenCalled();
    });

    test('re-arms the watchdog after the window becomes visible again', () => {
        const { clock, reload, setVisible, controller } = setupRecovery();

        setVisible(false);
        clock.advance(60_000);
        expect(reload).not.toHaveBeenCalled();

        setVisible(true);
        controller.onHeartbeat();
        clock.advance(15_001);

        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('stops watching after stop() is called', () => {
        const { clock, reload, controller } = setupRecovery();

        controller.stop();
        clock.advance(60_000);

        expect(reload).not.toHaveBeenCalled();
    });

    test('start() is idempotent and does not stack watchdogs', () => {
        const { clock, reload, controller } = setupRecovery();

        controller.start();
        controller.start();
        clock.advance(15_001);

        expect(reload).toHaveBeenCalledTimes(1);
    });
});

/*
 * 探活路径：窗口被其他窗口遮挡时 Chromium 会把 renderer 定时器节流到分钟级，
 * 此时心跳静默不代表冻结，主进程需先经 IPC 探活确认再决定是否重载。
 */
describe('renderer freeze watchdog with heartbeat probe', () => {
    function setupProbedRecovery(overrides: Record<string, unknown> = {}) {
        const clock = setupClock();
        const log = createLogger();
        const reload = jest.fn(() => true);
        const probe = jest.fn();
        let visible = true;
        const controller = createWindowRecoveryController({
            reload,
            isWindowVisible: () => visible,
            log,
            now: clock.now,
            requestHeartbeatProbe: probe,
            ...overrides
        });
        controller.start();
        return { clock, log, reload, probe, controller, setVisible: (value: boolean) => (visible = value) };
    }

    test('probes the renderer before reloading once heartbeats stall', () => {
        const { clock, log, reload, probe } = setupProbedRecovery();

        for (let i = 0; i < 4; i++) clock.advance(5_000);

        expect(probe).toHaveBeenCalledTimes(1);
        expect(reload).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('probing renderer before reload'));
    });

    test('skips the reload while the probed renderer keeps answering', () => {
        const { clock, reload, probe, controller } = setupProbedRecovery();
        probe.mockImplementation(() => controller.onHeartbeat());

        for (let i = 0; i < 20; i++) clock.advance(5_000);

        expect(probe.mock.calls.length).toBeGreaterThan(1);
        expect(reload).not.toHaveBeenCalled();
    });

    test('warns once while the window stays behind other windows', () => {
        const { clock, log, probe, controller } = setupProbedRecovery();
        probe.mockImplementation(() => controller.onHeartbeat());

        for (let i = 0; i < 20; i++) clock.advance(5_000);

        // 遮挡期间每轮巡检都会探活，日志只在进入该状态时记一条
        expect(probe.mock.calls.length).toBeGreaterThan(1);
        expect(log.warn).toHaveBeenCalledTimes(1);
        // 兜底状态内的后续探活降级为 debug，不再逐条刷 warn
        expect(log.debug).toHaveBeenCalledTimes(1);
    });

    test('reloads when the probed renderer never answers', () => {
        const { clock, log, reload } = setupProbedRecovery();

        for (let i = 0; i < 8; i++) clock.advance(5_000);

        expect(reload).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('probe timed out'));
    });

    test('re-probes after the window becomes visible instead of trusting a stale probe', () => {
        const { clock, reload, probe, setVisible, controller } = setupProbedRecovery();

        // t=20s 静默超时并发出探活
        for (let i = 0; i < 4; i++) clock.advance(5_000);
        expect(probe).toHaveBeenCalledTimes(1);

        // 探活未及回应窗口就被隐藏：在途探活必须丢弃，但重新可见后要发起全新探活验证，
        // 而不是沿用旧结果直接重载
        setVisible(false);
        clock.advance(5_000);
        setVisible(true);
        probe.mockImplementation(() => controller.onHeartbeat());
        for (let i = 0; i < 2; i++) clock.advance(5_000);

        expect(probe).toHaveBeenCalledTimes(2);
        expect(reload).not.toHaveBeenCalled();
    });

    test('recovers quickly when the renderer died while the window was occluded', () => {
        const { clock, log, reload, probe, setVisible, controller } = setupProbedRecovery();
        probe.mockImplementation(() => controller.onHeartbeat());

        // 遮挡 3 分钟，退避到 60s 档
        for (let i = 0; i < 36; i++) clock.advance(5_000);
        expect(reload).not.toHaveBeenCalled();

        // renderer 死在遮挡期间；用户切回窗口后应立即重新探活并快速恢复，
        // 而不是等满 60s 退避周期
        probe.mockImplementation(() => {});
        setVisible(false);
        clock.advance(5_000);
        setVisible(true);
        for (let i = 0; i < 3; i++) clock.advance(5_000);

        expect(probe).toHaveBeenCalledTimes(4);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('probe timed out'));
    });

    test('ignores a probe dispatch failure without crashing', () => {
        const { clock, log, reload, probe } = setupProbedRecovery();
        probe.mockImplementation(() => {
            throw new Error('channel closed');
        });

        for (let i = 0; i < 8; i++) clock.advance(5_000);

        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('failed to dispatch'));
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('reports the return to a normal heartbeat cadence at debug level after the window is unoccluded', () => {
        const { clock, log, probe, controller } = setupProbedRecovery();
        probe.mockImplementation(() => controller.onHeartbeat());

        for (let i = 0; i < 6; i++) clock.advance(5_000);
        clock.advance(3_000);
        // 遮挡解除：心跳定时器恢复常态上报，不再依赖探活
        controller.onHeartbeat();
        clock.advance(3_000);
        controller.onHeartbeat();

        // 需要连续两个正常间隔自然心跳才确认节流解除；恢复日志降级为 debug
        expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('resumed at normal cadence'));
        expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('resumed at normal cadence'));
    });

    test('keeps the pre-probe behaviour when no probe is wired up', () => {
        const clock = setupClock();
        const log = createLogger();
        const reload = jest.fn(() => true);
        const controller = createWindowRecoveryController({
            reload,
            isWindowVisible: () => true,
            log,
            now: clock.now
        });
        controller.start();

        clock.advance(15_001);

        expect(reload).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('heartbeat silent'));
    });

    test('never probes while the window stays hidden', () => {
        const { clock, reload, probe, setVisible } = setupProbedRecovery();
        setVisible(false);

        // 最小化 5 分钟：隐藏窗口本来就该省电，看门狗不应再额外唤醒 renderer
        for (let i = 0; i < 60; i++) clock.advance(5_000);

        expect(probe).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
    });

    test('backs off the probe cadence while the window stays occluded', () => {
        const { clock, reload, probe, controller } = setupProbedRecovery();
        probe.mockImplementation(() => controller.onHeartbeat());

        // 持续遮挡 3 分钟：不退避会每轮巡检探活一次（约 9 次），退避后 15s→30s→60s
        for (let i = 0; i < 36; i++) clock.advance(5_000);

        expect(probe).toHaveBeenCalledTimes(3);
        expect(reload).not.toHaveBeenCalled();
    });

    test('keeps the probe backoff while a throttled natural heartbeat follows a probe reply', () => {
        const { clock, log, reload, probe, controller } = setupProbedRecovery();
        probe.mockImplementation(() => controller.onHeartbeat());

        // t=15s 首次探活并得到回应（warn），t=55s 第二次探活并得到回应（debug，退避档位 30s）
        for (let i = 0; i < 11; i++) clock.advance(5_000);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.debug).toHaveBeenCalledTimes(1);

        // 模拟熄屏节流：t≈62s 出现一次自然心跳，随后定时器又被节流到约 16s 一跳。
        // 旧逻辑会把它误判为「节流已解除」→ 退避归零 → 之后每轮静默超时都重新 warn 刷屏；
        // 新逻辑要求连续两个正常间隔自然心跳才解除，单次短间隔不得复位退避
        clock.advance(12_000);
        controller.onHeartbeat();
        for (let i = 0; i < 6; i++) clock.advance(5_000);

        // 退避档位保持 60s：自然心跳后的静默最长约 30s，不再触发新探活，也不重载
        expect(probe).toHaveBeenCalledTimes(2);
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.debug).toHaveBeenCalledTimes(1);
        expect(reload).not.toHaveBeenCalled();
    });

    test('exits the probe-assisted state after two consecutive natural heartbeats', () => {
        const { clock, log, probe, controller } = setupProbedRecovery();
        probe.mockImplementation(() => controller.onHeartbeat());
        for (let i = 0; i < 4; i++) clock.advance(5_000);
        expect(probe).toHaveBeenCalledTimes(1);

        // 遮挡解除：两个连续正常间隔（3s 周期）的自然心跳才确认节流解除
        clock.advance(3_000);
        controller.onHeartbeat();
        expect(log.debug).not.toHaveBeenCalledWith(expect.stringContaining('resumed at normal cadence'));
        clock.advance(3_000);
        controller.onHeartbeat();

        expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('resumed at normal cadence'));
    });

    test('ignores a natural heartbeat following a probe reply when the window stays occluded', () => {
        const { clock, log, reload, probe, controller } = setupProbedRecovery();
        probe.mockImplementation(() => controller.onHeartbeat());
        for (let i = 0; i < 11; i++) clock.advance(5_000);
        expect(probe).toHaveBeenCalledTimes(2);

        // 探活回应后的自然心跳不参与节流解除判定：探活会打乱定时器节拍，
        // 单个短间隔心跳可能是补报后的自然节拍而非节流解除
        clock.advance(2_000);
        controller.onHeartbeat();

        expect(log.debug).not.toHaveBeenCalledWith(expect.stringContaining('resumed at normal cadence'));
        expect(reload).not.toHaveBeenCalled();
    });

    test('re-arms the probe cycle after the heartbeat cadence truly recovers', () => {
        const { clock, log, reload, probe, controller } = setupProbedRecovery();
        probe.mockImplementation(() => controller.onHeartbeat());

        // 持续遮挡 3 分钟：退避档位走到 60s，共探活 3 次
        for (let i = 0; i < 36; i++) clock.advance(5_000);
        expect(probe).toHaveBeenCalledTimes(3);

        // 遮挡解除：两个连续正常间隔的自然心跳确认节流恢复，兜底状态与退避一起复位
        probe.mockImplementation(() => {});
        clock.advance(3_000);
        controller.onHeartbeat();
        clock.advance(3_000);
        controller.onHeartbeat();
        expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('resumed at normal cadence'));

        // 此后 renderer 重新卡死：按初始阈值重新进入探活流程（新一轮 warn），
        // 探活无人回应后按配额重载
        for (let i = 0; i < 6; i++) clock.advance(5_000);

        expect(probe).toHaveBeenCalledTimes(4);
        expect(log.warn).toHaveBeenCalledTimes(2);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('probe timed out'));
    });

    test('paces recovery attempts once the reload budget is exhausted', () => {
        const clock = setupClock();
        const log = createLogger();
        const reload = jest.fn(() => false);
        const probe = jest.fn();
        const controller = createWindowRecoveryController({
            reload,
            isWindowVisible: () => true,
            log,
            now: clock.now,
            requestHeartbeatProbe: probe
        });
        controller.start();

        // 125s 内 renderer 持续无心跳且重载配额耗尽：每轮恢复尝试由「15s 静默 + 10s 探活
        // 超时」组成，即约 15s 一轮探活、15s 一次重载尝试，共 7 次；
        // 而不是退回旧逻辑的每轮巡检（5s）都尝试重载
        for (let i = 0; i < 25; i++) clock.advance(5_000);

        expect(reload).toHaveBeenCalledTimes(7);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('budget exhausted'));
    });
});
