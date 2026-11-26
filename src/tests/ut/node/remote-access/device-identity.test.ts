import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { getOrCreateDeviceId } from '../../../../main/utils/reporter.js';

function directory() {
    return fs.mkdtempSync(join(tmpdir(), 'opendesk-identity-contract-'));
}

async function assertConcurrentPublication(linkError?: string, blank?: string, pauseBeforeRename = false) {
    const root = directory();
    if (blank !== undefined) {
        fs.mkdirSync(join(root, 'shared/identity'), { recursive: true });
        if (linkError) {
            fs.writeFileSync(join(root, 'shared/identity/.deviceid-old.data'), blank);
            fs.symlinkSync('.deviceid-old.data', join(root, 'shared/identity/deviceid.txt'), 'file');
        } else {
            fs.writeFileSync(join(root, 'shared/identity/deviceid.txt'), blank);
        }
    }
    const source = pathToFileURL(resolve('src/main/utils/reporter.ts')).href;
    const script = join(root, 'identity.mjs');
    fs.writeFileSync(
        script,
        `
import fs from 'node:fs';
import { join } from 'node:path';
import { getOrCreateDeviceId } from ${JSON.stringify(source)};
const [root, name, linkError, pauseBeforeRename] = process.argv.slice(2);
if (linkError) fs.linkSync = () => { throw Object.assign(new Error('injected hard-link restriction'), { code: linkError }); };
const target = join(root, 'shared/identity/deviceid.txt');
const originalRead = fs.readFileSync;
const originalExists = fs.existsSync;
if (pauseBeforeRename) {
    const paused = join(root, 'before-rename');
    const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    if (name === 'one') {
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => {
            if (to === fs.realpathSync(target)) {
                fs.writeFileSync(paused, '');
                sleep(3800);
            }
            return rename(from, to);
        };
    } else {
        const deadline = Date.now() + 10000;
        while (!originalExists(paused)) {
            if (Date.now() > deadline) throw new Error('first writer never reached rename');
            sleep(10);
        }
    }
}
let reached = false;
function barrier() {
    if (reached || pauseBeforeRename) return;
    reached = true;
    fs.writeFileSync(join(root, name + '.ready'), 'ready');
    const deadline = Date.now() + 10000;
    while (!originalExists(join(root, 'one.ready')) || !originalExists(join(root, 'two.ready'))) {
        if (Date.now() > deadline) throw new Error('barrier timeout');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
}
fs.existsSync = function(file) {
    const exists = originalExists(file);
    if (String(file) === target && !exists) barrier();
    return exists;
};
fs.readFileSync = function(file, ...args) {
    try {
        const value = originalRead(file, ...args);
        if (String(file) === target && !value.toString().trim()) barrier();
        return value;
    }
    catch (error) { if (String(file) === target && error.code === 'ENOENT') barrier(); throw error; }
};
process.stdout.write(JSON.stringify(getOrCreateDeviceId(join(root, 'shared'))));
`
    );
    const children: ReturnType<typeof spawn>[] = [];
    try {
        const results = await Promise.all(
            ['one', 'two'].map(
                (name) =>
                    new Promise<string>((done, reject) => {
                        const child = spawn(
                            process.execPath,
                            [
                                '--import',
                                'tsx',
                                '--import',
                                './src/tests/test-env.ts',
                                script,
                                root,
                                name,
                                linkError ?? '',
                                pauseBeforeRename ? 'pause' : ''
                            ],
                            {
                                env: {
                                    ...process.env,
                                    OPENDESK_CONFIG_DIRECTORY: join(root, name + '-profile'),
                                    OPENDDESK_CONFIG_DIRECTORY: ''
                                },
                                stdio: ['ignore', 'pipe', 'pipe']
                            }
                        );
                        children.push(child);
                        let output = '';
                        child.stdout!.on('data', (data) => {
                            output += data;
                        });
                        child.stderr!.resume();
                        child.once('error', reject);
                        child.once('exit', (code) =>
                            code === 0 ? done(JSON.parse(output)) : reject(new Error('identity child failed'))
                        );
                    })
            )
        );
        assert.match(results[0], /^[0-9a-f-]{36}$/);
        assert.equal(results[0], results[1]);
        assert.equal(fs.readFileSync(join(root, 'shared/identity/deviceid.txt'), 'utf8').trim(), results[0]);
        const identityDirectory = join(root, 'shared/identity');
        const identityFile = join(identityDirectory, 'deviceid.txt');
        if (linkError) {
            assert.equal(fs.lstatSync(identityFile).isSymbolicLink(), true);
            const payload = fs.readlinkSync(identityFile);
            if (blank === undefined) assert.match(payload, /^\.deviceid-[\da-f-]+\.data$/);
            else assert.equal(payload, '.deviceid-old.data');
            assert.deepEqual(fs.readdirSync(identityDirectory).sort(), [payload, 'deviceid.txt'].sort());
            assert.equal(fs.readFileSync(join(identityDirectory, payload), 'utf8'), results[0]);
        } else {
            assert.deepEqual(fs.readdirSync(identityDirectory), ['deviceid.txt']);
        }
        assert.equal(getOrCreateDeviceId(join(root, 'shared')), results[0]);
    } finally {
        for (const child of children) if (child.exitCode === null) child.kill();
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('first publication converges under a real two-process barrier', () => assertConcurrentPublication());

test('restricted hard links converge across processes and survive creator exit', () =>
    assertConcurrentPublication('EPERM'));

for (const blank of ['', '  \t\n']) {
    test(`two processes repair the same ${blank ? 'whitespace-only' : 'empty'} device ID`, () =>
        assertConcurrentPublication(undefined, blank));
}

for (const blank of ['', '  \t\n']) {
    test(`paused writer converges after the former lock timeout (${blank ? 'whitespace' : 'empty'})`, () =>
        assertConcurrentPublication(undefined, blank, true));
}

test('recovery continues from the first complete proposal left by a stopped writer', () => {
    const root = directory();
    const dir = join(root, 'identity');
    const winner = '6b73fb01-d8f6-4cf2-8de7-c08faec29bd1';
    try {
        fs.mkdirSync(dir);
        fs.writeFileSync(join(dir, 'deviceid.txt'), ' ');
        fs.writeFileSync(join(dir, 'deviceid.txt.repair'), '\n6b73fb01-d8\n' + winner + '\n');
        assert.equal(getOrCreateDeviceId(root), winner);
        assert.equal(fs.readFileSync(join(dir, 'deviceid.txt'), 'utf8'), winner);
        assert.deepEqual(fs.readdirSync(dir), ['deviceid.txt']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('restricted hard links also allow two processes to repair an empty symbolic-link payload', () =>
    assertConcurrentPublication('EPERM', ''));

for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']) {
    test(`hard-link ${code} publishes a complete readable identity without changing its path`, () => {
        const root = directory();
        const original = fs.linkSync;
        try {
            fs.linkSync = () => {
                throw Object.assign(new Error('injected hard-link restriction'), { code });
            };
            const value = getOrCreateDeviceId(root);
            assert.match(value, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
            assert.equal(fs.readFileSync(join(root, 'identity/deviceid.txt'), 'utf8'), value);
            assert.equal(getOrCreateDeviceId(root), value);
        } finally {
            fs.linkSync = original;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

test('fallback publication never replaces a competing identity', () => {
    const root = directory();
    const original = fs.linkSync;
    const file = join(root, 'identity/deviceid.txt');
    try {
        fs.linkSync = () => {
            fs.writeFileSync(file, 'competing-complete-identity');
            throw Object.assign(new Error('injected hard-link restriction'), { code: 'EPERM' });
        };
        assert.equal(getOrCreateDeviceId(root), 'competing-complete-identity');
        assert.equal(fs.readFileSync(file, 'utf8'), 'competing-complete-identity');
        assert.deepEqual(fs.readdirSync(join(root, 'identity')), ['deviceid.txt']);
    } finally {
        fs.linkSync = original;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('failed fallback cleans only its own payload and returns no identity', () => {
    const root = directory();
    const originalLink = fs.linkSync;
    const originalSymlink = fs.symlinkSync;
    try {
        fs.mkdirSync(join(root, 'identity'));
        fs.writeFileSync(join(root, 'identity/unrelated.tmp'), 'preserved');
        fs.linkSync = () => {
            throw Object.assign(new Error('injected hard-link restriction'), { code: 'EPERM' });
        };
        fs.symlinkSync = () => {
            throw Object.assign(new Error('injected publication failure'), { code: 'EACCES' });
        };
        assert.throws(() => getOrCreateDeviceId(root), { code: 'EACCES' });
        assert.deepEqual(fs.readdirSync(join(root, 'identity')), ['unrelated.tmp']);
        assert.equal(fs.readFileSync(join(root, 'identity/unrelated.tmp'), 'utf8'), 'preserved');
    } finally {
        fs.linkSync = originalLink;
        fs.symlinkSync = originalSymlink;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a readback failure does not delete the successfully published symbolic-link payload', () => {
    const root = directory();
    const originalLink = fs.linkSync;
    const originalRead = fs.readFileSync;
    const file = join(root, 'identity/deviceid.txt');
    let reads = 0;
    try {
        fs.linkSync = () => {
            throw Object.assign(new Error('injected hard-link restriction'), { code: 'EPERM' });
        };
        fs.readFileSync = ((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
            if (target === file && ++reads === 2) {
                throw Object.assign(new Error('injected readback failure'), { code: 'EIO' });
            }
            return Reflect.apply(originalRead, fs, [target, ...args]);
        }) as typeof fs.readFileSync;
        assert.throws(() => getOrCreateDeviceId(root), { code: 'EIO' });
        fs.readFileSync = originalRead;
        const persisted = fs.readFileSync(file, 'utf8');
        assert.equal(getOrCreateDeviceId(root), persisted);
    } finally {
        fs.linkSync = originalLink;
        fs.readFileSync = originalRead;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a publication error after creating the symbolic link does not break the persisted identity', () => {
    const root = directory();
    const originalLink = fs.linkSync;
    const originalSymlink = fs.symlinkSync;
    const file = join(root, 'identity/deviceid.txt');
    try {
        fs.linkSync = () => {
            throw Object.assign(new Error('injected hard-link restriction'), { code: 'EPERM' });
        };
        fs.symlinkSync = ((...args: Parameters<typeof fs.symlinkSync>) => {
            originalSymlink(...args);
            throw Object.assign(new Error('injected error after publication'), { code: 'EIO' });
        }) as typeof fs.symlinkSync;
        assert.throws(() => getOrCreateDeviceId(root), { code: 'EIO' });
        const persisted = fs.readFileSync(file, 'utf8');
        assert.equal(getOrCreateDeviceId(root), persisted);
    } finally {
        fs.linkSync = originalLink;
        fs.symlinkSync = originalSymlink;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('existing identity is preserved without rewriting it', () => {
    const root = directory();
    try {
        fs.mkdirSync(join(root, 'identity'));
        const file = join(root, 'identity/deviceid.txt');
        fs.writeFileSync(file, 'existing-identity\n');
        assert.equal(getOrCreateDeviceId(root), 'existing-identity');
        assert.equal(fs.readFileSync(file, 'utf8'), 'existing-identity\n');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('publish I/O failure never returns an unpersisted identity and removes only its own temporary file', () => {
    const root = directory();
    const original = fs.linkSync;
    try {
        fs.linkSync = () => {
            throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' });
        };
        assert.throws(() => getOrCreateDeviceId(root));
        assert.deepEqual(fs.readdirSync(join(root, 'identity')), []);
    } finally {
        fs.linkSync = original;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
