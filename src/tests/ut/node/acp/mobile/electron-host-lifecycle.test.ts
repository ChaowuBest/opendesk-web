import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileQuitBarrier } from '../../../../../main/applications/mobileaccess/acp/mobile/hosts/electron-lifecycle.js';
import {
    createMobileHostLifecycle,
    type MobileHostHandle as RemoteCompositionHandle,
    type MobileHostPlan as RemoteLaunchPlan
} from '../../../../../main/applications/mobileaccess/acp/mobile/hosts/lifecycle.js';

type RemoteStartAction = NonNullable<Awaited<ReturnType<RemoteLaunchPlan['prepare']>>>;
function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

async function flush(times = 12): Promise<void> {
    for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

class ManualClock {
    private now = 0;
    private next = 1;
    private readonly timers = new Map<number, { at: number; callback: () => void }>();

    readonly setTimer = (callback: () => void, delayMs: number): unknown => {
        const id = this.next++;
        this.timers.set(id, { at: this.now + delayMs, callback });
        return id;
    };

    readonly clearTimer = (handle: unknown): void => {
        this.timers.delete(handle as number);
    };

    get pending(): number {
        return this.timers.size;
    }

    async advance(ms: number): Promise<void> {
        this.now += ms;
        for (const [id, timer] of [...this.timers]) {
            if (timer.at <= this.now) {
                this.timers.delete(id);
                timer.callback();
            }
        }
        await flush();
    }
}

function harness() {
    const clock = new ManualClock();
    const diagnostics: Array<{ code: string; phase?: string }> = [];
    const calls = { quit: 0 };
    const remote = createMobileHostLifecycle({
        setTimeout: clock.setTimer,
        clearTimeout: clock.clearTimer,
        diagnose: (event) => diagnostics.push(event)
    });
    const deferQuit = createMobileQuitBarrier(
        () => remote.close(),
        () => {
            calls.quit++;
        }
    );
    return { clock, diagnostics, calls, remote, deferQuit };
}

function plan(parts: Partial<RemoteLaunchPlan> = {}): RemoteLaunchPlan {
    return {
        prepare: async () => undefined,
        waitUntilReady: async () => undefined,
        ...parts
    };
}

function handleDouble(): { handle: RemoteCompositionHandle; closes: () => number } {
    let closes = 0;
    return {
        handle: {
            close: async () => {
                closes += 1;
            }
        },
        closes: () => closes
    };
}

function hangingHandle(): { handle: RemoteCompositionHandle; closes: () => number; release: () => void } {
    let closes = 0;
    const released = deferred();
    return {
        handle: {
            close: async () => {
                closes += 1;
                await released.promise;
            }
        },
        closes: () => closes,
        release: () => released.resolve()
    };
}

test('a disabled configuration never waits for readiness or starts a composition', async () => {
    const context = harness();
    const seen: string[] = [];
    context.remote.start(
        plan({
            prepare: async () => {
                seen.push('prepare');
                return undefined;
            },
            waitUntilReady: async () => {
                seen.push('ready');
            }
        })
    );
    await flush();
    assert.deepEqual(seen, ['prepare']);
    assert.deepEqual(context.diagnostics, []);
});

test('preparation, readiness and start failures stay inside the remote branch', async () => {
    for (const stage of ['prepare', 'ready', 'start'] as const) {
        const context = harness();
        const failure = new Error(`${stage} failed`);
        let localContinuationRan = false;
        context.remote.start(
            plan({
                prepare: async () => {
                    if (stage === 'prepare') throw failure;
                    return async () => {
                        if (stage === 'start') throw failure;
                        return handleDouble().handle;
                    };
                },
                waitUntilReady: async () => {
                    if (stage === 'ready') throw failure;
                }
            })
        );
        localContinuationRan = true;
        await flush();
        assert.equal(localContinuationRan, true, stage);
        assert.deepEqual(
            context.diagnostics,
            [{ code: 'start_failed', phase: stage === 'ready' ? 'readiness' : stage }],
            stage
        );
        assert.equal(context.calls.quit, 0, stage);
    }
});

test('a repeated start reuses the pending task and both stages receive the same host signal', async () => {
    const context = harness();
    let prepareCalls = 0;
    const gate = deferred<RemoteStartAction>();
    const signals: AbortSignal[] = [];
    let localContinuationRan = false;

    const launch = plan({
        prepare: async (signal) => {
            prepareCalls += 1;
            signals.push(signal);
            return gate.promise;
        }
    });
    context.remote.start(launch);
    context.remote.start(launch);
    localContinuationRan = true;
    await flush();

    assert.equal(localContinuationRan, true);
    assert.equal(prepareCalls, 1);
    gate.resolve(async (signal) => {
        signals.push(signal);
        return handleDouble().handle;
    });
    await flush();
    assert.equal(signals.length, 2);
    assert.equal(signals[0], signals[1]);
    assert.equal(signals[0], context.remote.signal);
});

test('a cancellation while preparing skips readiness and start, and the late rejection is observed', async () => {
    const context = harness();
    const gate = deferred<RemoteStartAction | undefined>();
    let readyCalls = 0;
    let startCalls = 0;
    const steps: string[] = [];

    context.remote.start(
        plan({
            prepare: async (signal) => {
                steps.push('step-1');
                await gate.promise;
                if (signal.aborted) return undefined;
                steps.push('step-2');
                return async () => {
                    startCalls += 1;
                    return handleDouble().handle;
                };
            },
            waitUntilReady: async () => {
                readyCalls += 1;
            }
        })
    );
    await flush();

    assert.equal(context.deferQuit(), true);
    await flush();
    assert.equal(context.remote.signal.aborted, true);
    gate.resolve(undefined);
    await flush();

    assert.deepEqual(steps, ['step-1']);
    assert.equal(readyCalls, 0);
    assert.equal(startCalls, 0);

    const lateContext = harness();
    const lateGate = deferred<RemoteStartAction>();
    lateContext.remote.start(plan({ prepare: async () => lateGate.promise }));
    await flush();
    assert.equal(lateContext.deferQuit(), true);
    await flush();
    const lateFailure = new Error('preparation rejected after cancellation');
    lateGate.reject(lateFailure);
    await flush();
    assert.deepEqual(lateContext.diagnostics, []);
});

test('the composition start waits for readiness and is skipped when the barrier completes late', async () => {
    const context = harness();
    const ready = deferred();
    let startCalls = 0;
    let localContinuationRan = false;

    context.remote.start(
        plan({
            prepare: async () => async () => {
                startCalls += 1;
                return handleDouble().handle;
            },
            waitUntilReady: () => ready.promise
        })
    );
    localContinuationRan = true;
    await flush();
    assert.equal(localContinuationRan, true);
    assert.equal(startCalls, 0);

    assert.equal(context.deferQuit(), true);
    await flush();
    ready.resolve();
    await flush();
    assert.equal(startCalls, 0);
});

test('repeated approved quits wait for the same service shutdown and retry once', async () => {
    const { remote, deferQuit, calls, clock } = harness();
    const live = hangingHandle();
    remote.start(plan({ prepare: async () => async () => live.handle }));
    await flush();

    assert.equal(deferQuit(), true);
    assert.equal(deferQuit(), true);
    assert.equal(remote.signal.aborted, true);
    assert.equal(live.closes(), 1);
    assert.equal(calls.quit, 0);

    live.release();
    await flush();
    assert.equal(deferQuit(), false);
    assert.equal(calls.quit, 1);
    assert.equal(clock.pending, 0);
});

test('a failing remote close is reported and still continues the quit', async () => {
    const context = harness();
    const failure = new Error('composition close failed');
    context.remote.start(
        plan({
            prepare: async () => async () => ({
                close: async () => {
                    throw failure;
                }
            })
        })
    );
    await flush();

    assert.equal(context.deferQuit(), true);
    await flush();
    assert.deepEqual(context.diagnostics, [{ code: 'close_failed' }]);
    assert.equal(context.calls.quit, 1);
});

test('nothing to wait for releases the quit immediately, before and after any start', async () => {
    const never = harness();
    assert.equal(never.deferQuit(), true);
    await flush();
    assert.equal(never.calls.quit, 1);
    assert.equal(never.clock.pending, 0);

    let startCalls = 0;
    never.remote.start(
        plan({
            prepare: async () => async () => {
                startCalls += 1;
                return handleDouble().handle;
            }
        })
    );
    await flush();
    assert.equal(startCalls, 0);

    const disabled = harness();
    disabled.remote.start(plan());
    await flush();
    assert.equal(disabled.deferQuit(), true);
    await flush();
    assert.equal(disabled.calls.quit, 1);
});

test('every pending remote stage shares one budget that releases at 3000ms and not before', async () => {
    const stages: Array<{ name: string; launch: () => { plan: RemoteLaunchPlan; release: () => void } }> = [
        {
            name: 'prepare',
            launch: () => {
                const gate = deferred<RemoteStartAction | undefined>();
                return { plan: plan({ prepare: () => gate.promise }), release: () => gate.resolve(undefined) };
            }
        },
        {
            name: 'ready',
            launch: () => {
                const gate = deferred();
                return {
                    plan: plan({
                        prepare: async () => async () => handleDouble().handle,
                        waitUntilReady: () => gate.promise
                    }),
                    release: () => gate.resolve()
                };
            }
        },
        {
            name: 'start',
            launch: () => {
                const gate = deferred<RemoteCompositionHandle>();
                return {
                    plan: plan({ prepare: async () => () => gate.promise }),
                    release: () => gate.resolve(handleDouble().handle)
                };
            }
        },
        {
            name: 'late-close',
            launch: () => {
                const late = hangingHandle();
                const gate = deferred<RemoteCompositionHandle>();
                queueMicrotask(() => gate.resolve(late.handle));
                return { plan: plan({ prepare: async () => () => gate.promise }), release: () => late.release() };
            }
        }
    ];

    for (const stage of stages) {
        const context = harness();
        const launched = stage.launch();
        context.remote.start(launched.plan);
        await flush();

        assert.equal(context.deferQuit(), true, stage.name);
        await flush();
        await context.clock.advance(3000 - 1);
        assert.equal(context.calls.quit, 0, stage.name);
        await context.clock.advance(1);
        assert.equal(context.calls.quit, 1, stage.name);
        assert.deepEqual(context.diagnostics, [{ code: 'close_timeout' }], stage.name);

        launched.release();
        await flush();
        assert.equal(context.calls.quit, 1, stage.name);
    }
});

test('work released after the timeout cannot revive the composition or schedule a second quit', async () => {
    const context = harness();
    const late = hangingHandle();
    const gate = deferred<RemoteStartAction>();
    let startCalls = 0;
    context.remote.start(plan({ prepare: async () => gate.promise }));
    await flush();

    assert.equal(context.deferQuit(), true);
    await flush();
    await context.clock.advance(3000);
    assert.equal(context.calls.quit, 1);

    gate.resolve(async () => {
        startCalls += 1;
        return late.handle;
    });
    await flush();
    assert.equal(startCalls, 0, 'a released preparation must not start a composition after the budget expired');
    assert.equal(context.calls.quit, 1);
    assert.equal(context.deferQuit(), false);
    assert.equal(context.calls.quit, 1);
    assert.equal(context.clock.pending, 0);
});

test('a late composition success after the timeout is closed instead of published', async () => {
    const context = harness();
    const late = handleDouble();
    const gate = deferred<RemoteCompositionHandle>();
    context.remote.start(plan({ prepare: async () => () => gate.promise }));
    await flush();

    assert.equal(context.deferQuit(), true);
    await flush();
    await context.clock.advance(3000);
    assert.equal(context.calls.quit, 1);

    gate.resolve(late.handle);
    await flush();
    assert.equal(late.closes(), 1);
    assert.equal(context.calls.quit, 1);
});

test('a rejected application cleanup still releases the approved quit', async () => {
    let retries = 0;
    const deferQuit = createMobileQuitBarrier(
        async () => {
            throw new Error('cleanup failed');
        },
        () => {
            retries++;
        }
    );
    assert.equal(deferQuit(), true);
    await flush();
    assert.equal(deferQuit(), false);
    assert.equal(retries, 1);
});
