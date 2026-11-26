import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileHostLifecycle, type MobileHostPlan } from '../../../../../main/applications/mobileaccess/acp/mobile/hosts/lifecycle.js';
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};
test('close during preparation cancels synchronously and late preparation cannot launch', async () => {
    const prepare = deferred<(signal: AbortSignal) => Promise<{ close(): Promise<void> }>>();
    let signal!: AbortSignal;
    let launches = 0;
    const lifecycle = createMobileHostLifecycle();
    lifecycle.start({
        prepare(s) {
            signal = s;
            return prepare.promise;
        },
        waitUntilReady: async () => undefined
    });
    const closing = lifecycle.close();
    assert.equal(signal.aborted, true);
    prepare.resolve(async () => {
        launches++;
        return { close: async () => undefined };
    });
    await closing;
    assert.equal(launches, 0);
});

for (const stage of ['prepare', 'readiness', 'start'] as const) {
    test(`one budget covers pending ${stage}, before abort, and isolates late resources`, async () => {
        let timer: (() => void) | undefined;
        let timerPresentAtAbort = false;
        let closes = 0;
        const pending = deferred<any>();
        const events: string[] = [];
        let signal!: AbortSignal;
        const handle = {
            close: async () => {
                closes++;
            }
        };
        const lifecycle = createMobileHostLifecycle({
            setTimeout: (callback, delay) => {
                assert.equal(delay, 3000);
                timer = callback;
                return 1;
            },
            clearTimeout: () => {
                timer = undefined;
            },
            diagnose: (event) => {
                events.push(event.code);
                throw Error('diagnostic consumer');
            }
        });
        const launch = async (s: AbortSignal) => {
            signal = s;
            return stage === 'start' ? pending.promise : handle;
        };
        lifecycle.start({
            prepare: async (s) => {
                signal = s;
                return stage === 'prepare' ? pending.promise : launch;
            },
            waitUntilReady: async () => {
                if (stage === 'readiness') await pending.promise;
            }
        });
        await flush();
        signal.addEventListener('abort', () => {
            timerPresentAtAbort = timer !== undefined;
        });
        const closing = lifecycle.close();
        assert.equal(lifecycle.close(), closing);
        assert.equal(signal.aborted, true);
        assert.equal(timerPresentAtAbort, true);
        let done = false;
        void closing.then(() => {
            done = true;
        });
        await flush();
        assert.equal(done, false);
        timer!();
        await closing;
        assert.deepEqual(events, ['close_timeout']);
        pending.resolve(stage === 'prepare' ? launch : stage === 'start' ? handle : undefined);
        await flush();
        assert.equal(closes, stage === 'start' ? 1 : 0);
        lifecycle.start({
            prepare: async () => {
                throw Error('cannot restart');
            },
            waitUntilReady: async () => undefined
        });
        assert.equal(lifecycle.close(), closing);
    });
    test(`rejection at ${stage} stays local and closes without rejection`, async () => {
        const events: unknown[] = [];
        const lifecycle = createMobileHostLifecycle({ diagnose: (event) => events.push(event) });
        lifecycle.start({
            prepare: async () => {
                if (stage === 'prepare') throw Error('synthetic');
                return async () => {
                    if (stage === 'start') throw Error('synthetic');
                    return { close: async () => undefined };
                };
            },
            waitUntilReady: async () => {
                if (stage === 'readiness') throw Error('synthetic');
            }
        });
        await flush();
        await lifecycle.close();
        assert.deepEqual(events, [{ code: 'start_failed', phase: stage }]);
    });
}
for (const hang of [true, false]) {
    test(`handle close ${hang ? 'hang' : 'reject'} is finite and only called once`, async () => {
        let timeout!: () => void;
        let closes = 0;
        const events: string[] = [];
        const pending = deferred<void>();
        const lifecycle = createMobileHostLifecycle({
            setTimeout: (fn) => {
                timeout = fn;
                return 1;
            },
            clearTimeout: () => undefined,
            diagnose: (event) => events.push(event.code)
        });
        lifecycle.start({
            prepare: async () => async () => ({
                close: async () => {
                    closes++;
                    if (hang) await pending.promise;
                    else throw Error('secret');
                }
            }),
            waitUntilReady: async () => undefined
        });
        await flush();
        const closing = lifecycle.close();
        await flush();
        if (hang) timeout();
        await closing;
        assert.equal(closes, 1);
        assert.equal(lifecycle.close(), closing);
        assert.deepEqual(events, [hang ? 'close_timeout' : 'close_failed']);
        pending.resolve();
        await flush();
    });
}

test('the registered mobile application starts once on host readiness without a user setting', async (t) => {
    const { MobileAccessApplication, attachMobileHost } =
        await import('../../../../../main/applications/mobileaccess/app.js');
    const { ApplicationRegistry } = await import('../../../../../main/applications/registry.js');
    const app = new MobileAccessApplication();
    ApplicationRegistry.registerApplication(app);
    assert.equal(ApplicationRegistry.getApplication('mobileaccess'), app);
    assert.equal(app.toJSON().showIcon, false);

    const config = t.mock.method(app, 'getConfig', () => ({ enabled: false }));
    const ready = deferred<void>();
    const starts: AbortSignal[] = [];
    let closes = 0;
    const plan: MobileHostPlan = {
        prepare: async () => async (signal) => {
            starts.push(signal);
            return {
                close: async () => {
                    closes++;
                }
            };
        },
        waitUntilReady: () => ready.promise
    };
    app[attachMobileHost](plan);
    app[attachMobileHost](plan);
    await flush();
    assert.equal(starts.length, 0);
    ready.resolve();
    await flush();
    assert.equal(starts.length, 1);
    assert.equal(config.mock.callCount(), 0);
    assert.equal(starts[0].aborted, false);
    await Promise.all([app.beforeExit(), app.beforeExit()]);
    assert.equal(closes, 1);
    assert.equal(starts[0].aborted, true);
    app[attachMobileHost](plan);
    await flush();
    assert.equal(starts.length, 1);
});

test('normal TUI exit waits for mobile cleanup before flushing task saves', async () => {
    const { OpenDeskTUI } = await import('../../../../../main/tui/entry.js');
    const closing = deferred<void>();
    const events: string[] = [];
    const finished = new Error('test exit');
    const tui = Object.assign(Object.create(OpenDeskTUI.prototype), {
        closeApplications: () => {
            events.push('close');
            return closing.promise;
        },
        dashboardBar: { stop() {} },
        toastManager: { stop() {} },
        inputArea: { statusBar: { stopTimer() {} } },
        shortcutManager: { detach() {} },
        tui: { stop: () => events.push('stop terminal') },
        taskManagerState: { flushAllPendingSaves: async () => events.push('save') }
    });
    const originalExit = process.exit;
    try {
        process.exit = ((code: number) => {
            events.push(`exit ${code}`);
            throw finished;
        }) as typeof process.exit;
        const exit = tui.exit();
        assert.deepEqual(events, ['close', 'stop terminal']);
        closing.resolve();
        await assert.rejects(exit, (error: unknown) => error === finished);
        assert.deepEqual(events, ['close', 'stop terminal', 'save', 'exit 0']);
    } finally {
        process.exit = originalExit;
    }
});
