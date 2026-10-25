import { describe, test, expect } from '@jest/globals';
import { ChannelMgrApplication } from '../../../main/applications/channelmgr/app.js';

/**
 * 回归测试（issue #127）：reloadChannels 的并发互斥。
 *
 * 旧实现是"先检查后等待"：多个等待者在 await 恢复后不会重新检查条件，
 * 同一时刻各自启动一轮 doReloadChannels，导致两轮 stop/load/start 并发执行。
 *
 * 期望语义：
 *   - doReloadChannels 任意时刻至多一轮在执行（严格串行）；
 *   - 重载进行中到达的并发调用合并为紧随其后的一轮补跑，而不是各自一轮；
 *   - 每个调用方返回前，都有一轮"在其调用发起之后开始"的重载已完成，
 *     保证调用方先落盘的变更（配置/插件注册表）已被应用；
 *   - 某一轮失败会向等待方传播，但不阻断后续轮次，也不产生 unhandled rejection；
 *   - 重载轮体开始执行前 reloadPromise 已就位，doReloadChannels 同步前缀中
 *     重入 reloadChannels 只会排队补跑，不会并发开启第二轮。
 */

interface ReloadRecorder {
    /** 已开始的重载轮数 */
    roundCount: number;
    /** 当前正在执行的重载轮数 */
    inFlight: number;
    /** 观察到的最大并发重载轮数 */
    maxInFlight: number;
    /** 每轮的放行函数（未调用前该轮挂起） */
    gates: Array<() => void>;
    /** 指定轮次以失败结束 */
    failRounds: Set<number>;
}

/**
 * 构造一个不经过构造函数的 ChannelMgrApplication 实例：
 * reloadChannels 只依赖 reloadPromise / reloadFollowUpQueued 两个字段，
 * doReloadChannels 用可挂起的假实现替换，从而精确控制轮次交错。
 */
function makeApp() {
    const app = Object.create(ChannelMgrApplication.prototype) as any;
    app.reloadPromise = undefined;
    app.reloadFollowUpQueued = false;

    const rec: ReloadRecorder = {
        roundCount: 0,
        inFlight: 0,
        maxInFlight: 0,
        gates: [],
        failRounds: new Set()
    };
    app.doReloadChannels = (): Promise<void> => {
        const index = rec.roundCount++;
        rec.inFlight++;
        rec.maxInFlight = Math.max(rec.maxInFlight, rec.inFlight);
        return new Promise<void>((resolve, reject) => {
            rec.gates.push(() => {
                rec.inFlight--;
                if (rec.failRounds.has(index)) {
                    reject(new Error(`round ${index} failed`));
                } else {
                    resolve();
                }
            });
        });
    };
    return { app, rec };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * 反复放行挂起的重载轮次直到 calls 全部 settle。
 * 每轮只放行一个 gate 并让微任务/宏任务队列推进一次，
 * 确保任何并发开启的重载轮都会被记录进 maxInFlight。
 */
async function settleCalls(calls: Promise<void>[], rec: ReloadRecorder): Promise<void> {
    let settled = 0;
    for (const call of calls) {
        void call.then(
            () => {
                settled++;
            },
            () => {
                settled++;
            }
        );
    }
    for (let i = 0; settled < calls.length && i < 1000; i++) {
        rec.gates.shift()?.();
        await tick();
    }
    if (settled < calls.length) {
        throw new Error('reloadChannels 调用未能在有限轮次内 settle（疑似死锁）');
    }
    await Promise.allSettled(calls);
}

describe('reloadChannels 并发互斥（issue #127）', () => {
    test('一个进行中的重载 + 两个等待者：重载严格串行，等待者合并为一轮补跑', async () => {
        const { app, rec } = makeApp();

        // 第一个调用立即开启 round0 并挂起；后两个调用在其进行中到达
        const calls = [app.reloadChannels(), app.reloadChannels(), app.reloadChannels()];
        await settleCalls(calls, rec);

        expect(rec.maxInFlight).toBe(1);
        expect(rec.roundCount).toBe(2);
        const results = await Promise.allSettled(calls);
        for (const r of results) {
            expect(r.status).toBe('fulfilled');
        }
    });

    test('重载进行中到达的调用方必须等补跑轮完成后才返回', async () => {
        const { app, rec } = makeApp();

        const a = app.reloadChannels(); // round0：字段同步就位，轮体在下一微任务进入
        let bSettled = false;
        const b = app.reloadChannels().finally(() => {
            bSettled = true;
        });
        await tick(); // 等首轮轮体启动、gate 入队

        rec.gates.shift()!(); // 放行 round0
        await tick();
        await tick();

        // round0 已结束、补跑轮已开始，但 B 不能抢在补跑轮完成前返回
        expect(rec.roundCount).toBe(2);
        expect(bSettled).toBe(false);

        rec.gates.shift()!(); // 放行补跑轮
        await expect(a).resolves.toBeUndefined();
        await expect(b).resolves.toBeUndefined();
        expect(bSettled).toBe(true);
    });

    test('某轮失败向等待方传播，但不阻断后续重载轮次', async () => {
        const { app, rec } = makeApp();
        rec.failRounds.add(0);

        const a = app.reloadChannels(); // round0，将失败
        const b = app.reloadChannels(); // 进行中到达，排队补跑

        await settleCalls([a, b], rec); // round0 失败 → 补跑 round1 正常执行

        await expect(a).rejects.toThrow('round 0 failed');
        await expect(b).rejects.toThrow('round 0 failed');

        // 队列未损坏：后续调用仍能正常发起并完成一轮新的重载
        const c = app.reloadChannels();
        await settleCalls([c], rec);
        await expect(c).resolves.toBeUndefined();
        expect(rec.roundCount).toBe(3);
    });

    test('已无等待者的补跑轮失败不会产生 unhandled rejection', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);

        try {
            const { app, rec } = makeApp();
            rec.failRounds.add(0);
            rec.failRounds.add(1);

            // round0 失败后两个调用方都提前退出，补跑 round1 无人等待且同样失败
            const a = app.reloadChannels();
            const b = app.reloadChannels().catch(() => {});
            await settleCalls([a, b], rec);
            await tick();
            await tick();

            expect(unhandled).toHaveLength(0);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    test('doReloadChannels 同步前缀中重入 reloadChannels 只会排队补跑，不会并发开轮', async () => {
        const { app, rec } = makeApp();
        const baseReload = app.doReloadChannels;
        let reentered = false;
        let reenteredCall: Promise<void> | undefined;
        app.doReloadChannels = (): Promise<void> => {
            if (!reentered) {
                reentered = true;
                // 模拟插件回调在轮体同步前缀里重入：若此刻本轮尚未写入
                // reloadPromise，重入者会走"空闲"分支并发开启第二轮
                reenteredCall = app.reloadChannels();
            }
            return baseReload();
        };

        const a = app.reloadChannels();
        await tick(); // 让首轮轮体进入执行（同步重入发生在这里面）

        await settleCalls([a, reenteredCall!], rec);

        expect(rec.maxInFlight).toBe(1);
        expect(rec.roundCount).toBe(2);
        await expect(a).resolves.toBeUndefined();
        await expect(reenteredCall!).resolves.toBeUndefined();
    });
});
