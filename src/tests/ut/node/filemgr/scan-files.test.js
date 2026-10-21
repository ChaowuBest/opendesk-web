import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastGlob from 'fast-glob';
import fsWalk from '@nodelib/fs.walk';
import { scanPath } from './fixture-paths.js';
import {
    createFileScan,
    FILE_ATTRIBUTE_CONCURRENCY,
    DIRECTORY_READ_CONCURRENCY,
    SCAN_READ_AHEAD_LIMIT
} from '../../../../main/applications/filemgr/worker.js';

function directory(t, count = 5000) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filemgr-reader-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (let i = 0; i < count; i++) {
        const dir = path.join(root, `d${Math.floor(i / 50)}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `f${i}.${i % 10 ? 'bin' : 'txt'}`), 'test');
    }
    return root;
}
const options = (cwd, extra = {}) => ({
    cwd,
    deep: undefined,
    dot: false,
    suppressErrors: true,
    followSymbolicLinks: false,
    absolute: true,
    caseSensitiveMatch: false,
    objectMode: true,
    ...extra
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function callbackFilesystem(filesystem) {
    return {
        readdir: filesystem.readdir,
        lstat: (file, callback) => {
            void filesystem.promises.lstat(file).then(
                (stats) => callback(null, stats),
                (error) => callback(error)
            );
        }
    };
}
async function paths(patterns, opts, dependencies) {
    if (dependencies?.filesystem)
        dependencies = { ...dependencies, filesystem: callbackFilesystem(dependencies.filesystem) };
    const result = [];
    const scan = createFileScan(patterns, opts, dependencies);
    for await (const file of scan.files) if (file.stats?.isFile()) result.push(file.path);
    return result.sort();
}

test('real fast-glob rules, depth, hidden entries, Chinese paths and links match stats:true', async (t) => {
    const root = directory(t, 100);
    for (const name of ['.hidden/a.txt', 'deep/a/b/c/d/e/file.TXT', '中文/文档.txt', 'excluded/file.txt']) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), name);
    }
    fs.symlinkSync(path.join(root, 'd0/f0.txt'), path.join(root, 'linked.txt'));
    fs.symlinkSync(path.join(root, '中文'), path.join(root, 'linked-dir'));
    fs.symlinkSync(path.join(root, 'absent'), path.join(root, 'broken.txt'));
    for (const deep of [undefined, 1, 4]) {
        for (const patterns of [['**/*'], ['**/*.txt'], ['d0/*.txt', '中文/*.txt', 'missing/*.txt']]) {
            const opts = options(root, { deep, ignore: ['**/excluded/**'] });
            const original = [];
            for await (const file of fastGlob.stream(patterns, { ...opts, stats: true })) original.push(file.path);
            assert.deepEqual(await paths(patterns, opts), original.sort());
        }
    }
});

test('attribute concurrency and directory prefetch stay bounded while a consumer pauses', async (t) => {
    const root = directory(t);
    let activeStats = 0;
    let peakStats = 0;
    let activeReads = 0;
    let peakReads = 0;
    let completedReads = 0;
    let statsStarted = 0;
    let pauseReads = 0;
    const filesystem = {
        readdir: (dir, opts, cb) => {
            activeReads++;
            peakReads = Math.max(peakReads, activeReads);
            fs.readdir(dir, opts, (err, entries) => {
                activeReads--;
                completedReads++;
                cb(err, entries);
            });
        },
        promises: {
            lstat: async (file) => {
                statsStarted++;
                activeStats++;
                peakStats = Math.max(peakStats, activeStats);
                await delay(2);
                try {
                    return await fs.promises.lstat(file);
                } finally {
                    activeStats--;
                }
            }
        }
    };
    const scan = createFileScan(['**/*'], options(root), { filesystem: callbackFilesystem(filesystem) });
    let count = 0;
    for await (const file of scan.files) {
        assert.ok(file.path);
        count++;
        if (count === 1) {
            await delay(100);
            pauseReads = completedReads;
            assert.ok(completedReads < 101, 'must not enumerate the whole tree during a pause');
            assert.ok(
                completedReads * 50 <=
                    SCAN_READ_AHEAD_LIMIT + DIRECTORY_READ_CONCURRENCY * 50 + FILE_ATTRIBUTE_CONCURRENCY + 100
            );
            assert.ok(statsStarted <= FILE_ATTRIBUTE_CONCURRENCY);
        }
    }
    assert.equal(count, 5000);
    assert.ok(peakStats > 1 && peakStats <= FILE_ATTRIBUTE_CONCURRENCY);
    assert.ok(peakReads <= DIRECTORY_READ_CONCURRENCY);
    assert.equal(activeStats, 0);
    assert.equal(activeReads, 0);
    console.log(JSON.stringify({ count, peakStats, peakReads, completedReads, pauseReads }));
});

test('multiple glob bases share the directory/attribute limits and isolate one failed base', async (t) => {
    const root = directory(t, 1000);
    const failedDirectory = scanPath(path.join(root, 'd0'));
    let active = 0;
    let peak = 0;
    let injectedFailures = 0;
    const failures = [];
    const filesystem = {
        readdir: (dir, opts, cb) => {
            active++;
            peak = Math.max(peak, active);
            setTimeout(() => {
                if (dir === failedDirectory) {
                    injectedFailures++;
                    active--;
                    cb(Object.assign(new Error('denied'), { code: 'EACCES' }));
                } else
                    fs.readdir(dir, opts, (err, entries) => {
                        active--;
                        cb(err, entries);
                    });
            }, 1);
        },
        promises: fs.promises
    };
    const patterns = Array.from({ length: 20 }, (_, i) => `d${i}/*`);
    const result = await paths(patterns, options(root), { filesystem, onReadError: (error) => failures.push(error) });
    assert.equal(injectedFailures, 1);
    assert.equal(result.length, 950);
    assert.ok(peak <= DIRECTORY_READ_CONCURRENCY);
    assert.deepEqual(
        failures.map((it) => it.path),
        [failedDirectory]
    );
    assert.equal(active, 0);
});

test('Windows fault fixtures match the slash-separated paths delivered by the glob walker', async () => {
    const root = path.win32.join('C:\\filemgr-reader-fixture', 'd0');
    const failedDirectory = scanPath(root, 'win32');
    const reads = [];
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    // fast-glob uses this walker with pathSegmentSeparator: '/', including on Windows.
    const stream = fsWalk.walkStream(root, {
        pathSegmentSeparator: '/',
        fs: {
            readdir: (dir, _opts, callback) => {
                reads.push(dir);
                callback(dir === failedDirectory ? denied : null, []);
            }
        }
    });
    await assert.rejects(
        async () => {
            for await (const entry of stream) assert.fail(`Unexpected entry: ${entry.path}`);
        },
        (error) => error === denied
    );
    assert.deepEqual(reads, [failedDirectory]);
    assert.notEqual(reads[0], root);
});

for (const method of ['return', 'close', 'throw']) {
    test(`${method} drains all started tasks and wakes readers without late IO or unhandled rejection`, async (t) => {
        const root = directory(t, 1000);
        let reads = 0;
        let stats = 0;
        let active = 0;
        const unhandled = [];
        const handler = (err) => unhandled.push(err);
        process.on('unhandledRejection', handler);
        t.after(() => process.off('unhandledRejection', handler));
        const filesystem = {
            readdir: (dir, opts, cb) => {
                reads++;
                fs.readdir(dir, opts, cb);
            },
            promises: {
                lstat: async (file) => {
                    stats++;
                    active++;
                    await delay(3);
                    try {
                        if (stats % 3 === 0) throw Object.assign(new Error('denied'), { code: 'EPERM' });
                        return await fs.promises.lstat(file);
                    } finally {
                        active--;
                    }
                }
            }
        };
        let stopped = false;
        const scan = createFileScan(['**/*'], options(root), {
            filesystem: callbackFilesystem(filesystem),
            shouldStop: () => stopped
        });
        await scan.files.next();
        await delay(30);
        const startedStats = stats;
        const startedReads = reads;
        if (method === 'return') await scan.files.return();
        if (method === 'close') {
            stopped = true;
            scan.close();
            await scan.files.next();
        }
        if (method === 'throw') await assert.rejects(scan.files.throw(new Error('consumer failed')), /consumer failed/);
        assert.equal(active, 0);
        await delay(30);
        assert.equal(stats, startedStats);
        assert.equal(reads, startedReads);
        assert.deepEqual(unhandled, []);
    });
}

test('unknown errors in an in-flight attribute task reject the scan and settle every other task', async (t) => {
    const root = directory(t, 1000);
    let active = 0;
    const error = new Error('programming failure');
    const filesystem = {
        readdir: fs.readdir.bind(fs),
        promises: {
            lstat: async (file) => {
                active++;
                await delay(1);
                try {
                    if (file.endsWith('f49.bin')) throw error;
                    return await fs.promises.lstat(file);
                } finally {
                    active--;
                }
            }
        }
    };
    await assert.rejects(paths(['**/*'], options(root), { filesystem }), (err) => err === error);
    assert.equal(active, 0);
});

test('a programming exception while interpreting a Dirent aborts and drains the directory callback', async (t) => {
    const root = directory(t, 1);
    const error = new Error('malformed Dirent');
    const filesystem = {
        readdir: (_dir, _opts, cb) =>
            setImmediate(() =>
                cb(null, [
                    {
                        name: 'file',
                        isFile: () => {
                            throw error;
                        }
                    }
                ])
            ),
        promises: fs.promises
    };
    await assert.rejects(paths(['**/*'], options(root), { filesystem }), (err) => err === error);
});

test('close before consuming the generator drains a slow in-flight readdir', async (t) => {
    const root = directory(t, 1);
    let active = 0;
    const filesystem = {
        readdir: (dir, opts, cb) => {
            active++;
            setTimeout(
                () =>
                    fs.readdir(dir, opts, (err, entries) => {
                        active--;
                        cb(err, entries);
                    }),
                20
            );
        },
        promises: fs.promises
    };
    const scan = createFileScan(['**/*'], options(root), { filesystem: callbackFilesystem(filesystem) });
    await delay(5);
    assert.equal(active, 1);
    scan.close();
    await scan.files.return();
    await scan.drain();
    assert.equal(active, 0);
});

test('stop waits for the bounded slow attribute tasks, consumes late rejections and starts no further reads', async (t) => {
    const root = directory(t, 1000);
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    let active = 0;
    let started = 0;
    const filesystem = {
        readdir: fs.readdir.bind(fs),
        promises: {
            lstat: async (file) => {
                const number = ++started;
                active++;
                try {
                    if (number > 1) await gate;
                    if (number === 2) throw new Error('late rejected IO after stop');
                    return await fs.promises.lstat(file);
                } finally {
                    active--;
                }
            }
        }
    };
    const scan = createFileScan(['**/*'], options(root), { filesystem: callbackFilesystem(filesystem) });
    try {
        await scan.files.next();
        assert.ok(active > 0 && active < FILE_ATTRIBUTE_CONCURRENCY);
        scan.close();
        let returned = false;
        const stopped = scan.files.return().then(() => {
            returned = true;
        });
        await delay(10);
        assert.equal(returned, false, 'must drain rather than leave background IO');
        release();
        await stopped;
        assert.equal(active, 0);
        assert.equal(started, FILE_ATTRIBUTE_CONCURRENCY);
    } finally {
        release();
        scan.close();
        await scan.files.return();
        await scan.drain();
    }
});
