import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createFileScan, DIRECTORY_READ_CONCURRENCY } from '../../../../main/applications/filemgr/worker.js';

function dirent(name, directory) {
    return {
        name,
        isDirectory: () => directory,
        isFile: () => !directory,
        isSymbolicLink: () => false
    };
}

// The filesystem is entirely in memory. Directory breadth, rather than file count,
// creates the fast-glob queue that caused synchronous cancellation to overflow.
function queuedScan({ bufferedFiles = 1000 } = {}) {
    let stopped = false;
    let reads = 0;
    let attributes = 0;
    const inFlight = [];
    const scan = createFileScan(
        ['**/*'],
        { cwd: '/filemgr-memory', absolute: true, suppressErrors: true, followSymbolicLinks: false },
        {
            shouldStop: () => stopped,
            filesystem: {
                readdir(_directory, _options, callback) {
                    reads++;
                    if (reads === 1) {
                        setImmediate(() =>
                            callback(null, [
                                ...Array.from({ length: bufferedFiles }, (_, i) => dirent(`f${i}.txt`, false)),
                                ...Array.from({ length: 20000 }, (_, i) => dirent(`d${i}`, true))
                            ])
                        );
                    } else inFlight.push(callback);
                },
                lstat(_file, callback) {
                    attributes++;
                    setImmediate(() => callback(null, { isFile: () => true }));
                }
            }
        }
    );
    return {
        scan,
        stop: () => {
            stopped = true;
        },
        counts: () => ({ reads, attributes }),
        inFlight
    };
}

for (const method of ['close', 'yield', 'return', 'throw']) {
    test(
        `large directory backlog: ${method} settles without recursion, late I/O or unhandled rejection`,
        { timeout: 10000 },
        async (t) => {
            const errors = [];
            const onUnhandled = (error) => errors.push(error);
            process.on('unhandledRejection', onUnhandled);
            t.after(() => process.off('unhandledRejection', onUnhandled));
            const f = queuedScan();
            assert.equal((await f.scan.files.next()).done, false);
            await nextTurn();
            const before = f.counts();
            assert.equal(before.reads, 1, 'pre-read pressure must leave directory readers waiting');
            if (method === 'close' || method === 'yield') f.stop();
            if (method === 'close') assert.doesNotThrow(() => f.scan.close());
            if (method === 'throw') {
                const failure = Error('consumer failed');
                await assert.rejects(f.scan.files.throw(failure), (error) => error === failure);
            } else if (method === 'return' || method === 'close') await f.scan.files.return();
            else assert.equal((await f.scan.files.next()).done, true);
            await f.scan.drain();
            f.scan.close();
            await f.scan.drain();
            await nextTurn();
            assert.deepEqual(f.counts(), before);
            assert.deepEqual(errors, []);
        }
    );
}

test('large directory backlog drains all active reads before reporting stopped', { timeout: 10000 }, async () => {
    const f = queuedScan({ bufferedFiles: 0 });
    let ended = false;
    const consumed = (async () => {
        for await (const file of f.scan.files) assert.fail(`fixture has no files: ${file.path}`);
        ended = true;
    })();
    // Attach immediately so an old-reader failure is a test failure, not an unhandled rejection.
    consumed.catch(() => {});
    while (f.inFlight.length < DIRECTORY_READ_CONCURRENCY) await nextTurn();
    const before = f.counts();
    f.stop();
    f.scan.close();
    await nextTurn();
    assert.equal(ended, false);
    const callbacks = f.inFlight.splice(0);
    for (const callback of callbacks.slice(0, -1)) callback(null, []);
    await nextTurn();
    assert.equal(ended, false, 'the last real I/O must still be awaited');
    callbacks.at(-1)(Object.assign(Error('late permission error'), { code: 'EPERM' }));
    await consumed;
    await f.scan.drain();
    assert.equal(ended, true);
    await nextTurn();
    assert.deepEqual(f.counts(), before);
});
