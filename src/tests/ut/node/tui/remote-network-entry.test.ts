import assert from 'node:assert/strict';
import test from 'node:test';
import { startTuiRemoteEntry } from '../../../../main/applications/mobileaccess/tui.js';

for (const resume of [undefined, 'synthetic-task']) {
    for (const loggedIn of [false, true]) {
        test(`Bun local ${resume ? 'resume' : 'ordinary'} continues without remote effects (${loggedIn})`, async () => {
            const counts = { load: 0, prepare: 0, subscribe: 0, register: 0, local: 0 };
            const listeners: Array<() => void> = [];
            startTuiRemoteEntry({
                args: { resume },
                route: 'interactive',
                runtime: { releaseName: 'node', bunVersion: '1.3.10', mainThread: true },
                lifecycle: {
                    start(input) {
                        void input.prepare(new AbortController().signal);
                    }
                },
                async load() {
                    counts.load++;
                    counts.prepare++;
                    counts.subscribe++;
                    listeners.push(() => counts.register++);
                    if (loggedIn) counts.register++;
                    return async () => ({ close: async () => undefined });
                },
                ready: async () => undefined
            });
            counts.local++;
            for (const listener of listeners) listener();
            assert.deepEqual(counts, { load: 0, prepare: 0, subscribe: 0, register: 0, local: 1 });
        });
    }
}
for (const args of [{ command: 'x' }, { command: '' }, { headless: true }, { command: 'x', resume: 'task' }]) {
    test(`non-target ${JSON.stringify(args)} never loads`, () => {
        let loads = 0;
        assert.equal(
            startTuiRemoteEntry({
                args,
                route: 'interactive',
                lifecycle: { start: () => loads++ },
                load: async () => {
                    throw Error('unexpected');
                },
                ready: async () => undefined
            }),
            false
        );
        assert.equal(loads, 0);
    });
}
test('standard Node ordinary/resume positives use actual gate and preserve local continuation', () => {
    for (const resume of [undefined, 'task']) {
        let starts = 0;
        assert.equal(
            startTuiRemoteEntry({
                args: { resume },
                route: 'interactive',
                lifecycle: { start: () => starts++ },
                load: async () => {
                    throw Error('unused');
                },
                ready: async () => undefined
            }),
            true
        );
        assert.equal(starts, 1);
    }
});
test('worker and subcommand are excluded', () => {
    for (const route of ['interactive', 'subcommand'] as const) {
        assert.equal(
            startTuiRemoteEntry({
                args: {},
                route,
                runtime: { releaseName: 'node', bunVersion: undefined, mainThread: false },
                lifecycle: {
                    start: () => {
                        throw Error('unexpected');
                    }
                },
                load: async () => {
                    throw Error('unexpected');
                },
                ready: async () => undefined
            }),
            false
        );
    }
});
