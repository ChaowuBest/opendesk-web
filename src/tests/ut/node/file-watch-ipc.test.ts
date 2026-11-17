import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { sliceBalancedBlock } from './fixtures/sourceText.js';
import type { FileWatchSubscription, FileChangeEvent } from '../../../main/services/file-watch/service.js';

const mainSource = readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8');
const registrationStart = mainSource.indexOf('const registerFSAPIHandlers = () => {');
const registrationBody = sliceBalancedBlock(mainSource, mainSource.indexOf('{', registrationStart));
const registrationCode = ts.transpileModule(`function registerFSAPIHandlers() ${registrationBody}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText;

function setup(t: TestContext) {
    const handlers = new Map<string, (...args: any[]) => any>();
    const ipc = new EventEmitter() as EventEmitter & {
        handle: (channel: string, handler: (...args: any[]) => any) => void;
    };
    ipc.handle = (channel, handler) => handlers.set(channel, handler);
    const owner = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: mock.fn() });
    const subscription = { path: '/deck.pptx', dispose: mock.fn() };
    let notify!: (change: FileChangeEvent) => void;
    const service = {
        watch: mock.fn(async (_path: string, callback: typeof notify) => {
            notify = callback;
            return subscription;
        }),
        dispose: mock.fn()
    };
    const app = new EventEmitter();
    const directoryWatcher = Object.assign(new EventEmitter(), { close: mock.fn() });
    let directoryChange!: () => void;
    const watchDirectory = mock.fn((_dir: string, callback: () => void) => {
        directoryChange = callback;
        return directoryWatcher;
    });
    vm.runInNewContext(`${registrationCode}; registerFSAPIHandlers();`, {
        ipcMain: ipc,
        app,
        fs: { watch: watchDirectory },
        path,
        safeSendToWebContents: (sender: typeof owner, ...args: unknown[]) => sender.send(...args),
        FileWatchService: function () {
            return service;
        }
    });
    t.after(() => {
        app.emit('will-quit');
    });
    const event = { sender: owner, senderFrame: owner.mainFrame };
    return {
        owner,
        ipc,
        service,
        subscription,
        event,
        start: () => handlers.get('fs:watchFile')!(event, 'watch', '/deck.pptx'),
        startDirectory: () => handlers.get('fs:watchFile')!(event, 'watch-dir', '/workspace', true),
        watchDirectory,
        directoryWatcher,
        notifyDirectory: () => directoryChange(),
        notify: () => notify({ path: '/deck.pptx', type: 'changed' })
    };
}

test('forwards changes only while the owning renderer is subscribed', async (t) => {
    const s = setup(t);
    await s.start();
    s.notify();
    assert.equal(s.owner.send.mock.callCount(), 1);
    s.ipc.emit('fs:unwatchFile', setup(t).event, 'watch');
    assert.equal(s.subscription.dispose.mock.callCount(), 0);
    s.ipc.emit('fs:unwatchFile', s.event, 'watch');
    s.notify();
    assert.equal(s.owner.send.mock.callCount(), 1);
    assert.equal(s.subscription.dispose.mock.callCount(), 1);
    assert.equal(s.owner.listenerCount('did-start-navigation'), 0);
});

test('watches a single directory and stops forwarding when its renderer navigates', async (t) => {
    const s = setup(t);
    await s.startDirectory();
    assert.equal(s.service.watch.mock.callCount(), 0);
    assert.equal(s.watchDirectory.mock.calls[0].arguments[0], path.resolve('/workspace'));
    s.notifyDirectory();
    assert.deepEqual(s.owner.send.mock.calls[0].arguments, ['fs:fileChanged', 'watch-dir', undefined]);
    s.owner.emit('did-start-navigation', {}, 'about:blank', false, true);
    s.notifyDirectory();
    assert.equal(s.owner.send.mock.callCount(), 1);
    assert.equal(s.directoryWatcher.close.mock.callCount(), 1);
});

test('releases late registrations after cancellation, navigation or destruction', async (t) => {
    for (const action of ['cancel', 'navigate', 'destroy']) {
        const s = setup(t);
        let finish!: (value: FileWatchSubscription) => void;
        s.service.watch.mock.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        const pending = s.start();
        if (action === 'cancel') s.ipc.emit('fs:unwatchFile', s.event, 'watch');
        else if (action === 'navigate') s.owner.emit('did-start-navigation', {}, 'about:blank', false, true);
        else s.owner.emit('destroyed');
        finish(s.subscription);
        await pending;
        assert.equal(s.subscription.dispose.mock.callCount(), 1);
        assert.equal(s.owner.listenerCount('did-start-navigation'), 0);
    }
});

test('rejects subframes and releases owner hooks when registration fails', async (t) => {
    const s = setup(t);
    const frame = s.event.senderFrame;
    s.event.senderFrame = {};
    await assert.rejects(s.start());
    assert.equal(s.service.watch.mock.callCount(), 0);
    s.event.senderFrame = frame;
    s.service.watch.mock.mockImplementation(async () => {
        throw new Error('watch failed');
    });
    await assert.rejects(s.start());
    assert.equal(s.owner.listenerCount('destroyed'), 0);
    assert.equal(s.owner.listenerCount('did-start-navigation'), 0);
});
