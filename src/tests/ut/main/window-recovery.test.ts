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
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
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
