import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rename, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { localOfficeDocumentStorage } from '../../../main/office/documentStorage.js';
import {
    createOfficeWordStoragePlugin,
    transformOfficeWordStorage
} from '../../../../scripts/office-word-storage-compat.mjs';

const require = createRequire(import.meta.url);
const wordMainPath = require.resolve('@bitclub.ai/opendesk-office/word-main');
const originalSource = await readFile(wordMainPath, 'utf8');
const patchedSource = transformOfficeWordStorage(originalSource);
const parsed = ts.createSourceFile('word-main.js', patchedSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function findFunction(name: string): string {
    let result: string | undefined;
    function visit(node: ts.Node) {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(parsed);
        ts.forEachChild(node, visit);
    }
    visit(parsed);
    assert.ok(result, `Missing real package function ${name}`);
    return result;
}

function findHandler(channel: string): string {
    let result: string | undefined;
    function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && node.arguments.length >= 2 && ts.isStringLiteral(node.arguments[0])) {
            if (node.arguments[0].text === channel) result = node.arguments[1].getText(parsed);
        }
        ts.forEachChild(node, visit);
    }
    visit(parsed);
    assert.ok(result, `Missing real package handler ${channel}`);
    return result;
}

function createPackageRuntime(root: string, storage: unknown, bookkeeping: string[], overrides = {}) {
    const context = vm.createContext({
        Buffer,
        runtime: { documentStorage: storage },
        join7: path.join,
        dirname3: path.dirname,
        basename2: path.basename,
        randomBytes,
        rename,
        unlink,
        unlink2: unlink,
        writeFile2: writeFile,
        RETRYABLE_RENAME_CODES: new Set(['EPERM', 'EACCES', 'EBUSY']),
        RENAME_RETRIES: 4,
        sleep: async () => {},
        tornDownWcIds: new Set(),
        canDocWrite: () => true,
        diskChangedExternally: async () => false,
        snapshotDocPassword: () => ({}),
        rememberDiskState: async () => bookkeeping.push('disk-state'),
        commitDocPasswordSave: () => {
            bookkeeping.push('password');
            return false;
        },
        clearRecoveryCopy: () => bookkeeping.push('clear-recovery'),
        pushRecent: () => bookkeeping.push('recent'),
        notifyFileSaved: () => bookkeeping.push('saved-event'),
        allowDocWrite: () => bookkeeping.push('allow-write'),
        saveDialog: async () => ({ canceled: false, filePath: path.join(root, 'saved-as.docx') }),
        uniquePathIn: () => path.join(root, 'new.docx'),
        defaultSaveDir: () => root,
        tm: (key: string) => key,
        ...overrides
    });
    vm.runInContext(findFunction('atomicWriteFile'), context);
    vm.runInContext(findFunction('commitOpenDeskWordDocument'), context);
    return (channel: string) => vm.runInContext(`(${findHandler(channel)})`, context);
}

test('versioned build patch leaves installed package unchanged and rejects unreviewed input', async () => {
    const plugin = createOfficeWordStoragePlugin();
    assert.equal(plugin.transform(originalSource, '/unrelated/word-main.js'), null);
    assert.equal(plugin.transform(originalSource, wordMainPath).code, patchedSource);
    assert.throws(() => transformOfficeWordStorage(originalSource + '\n'), /bundle changed/);
    assert.equal(await readFile(wordMainPath, 'utf8'), originalSource);
});

for (const [channel, intent] of [
    ['docs:save', 'save'],
    ['docs:save-as', 'save-as'],
    ['docs:save-new', 'save-new']
] as const) {
    test(`real ${channel} treats canceled storage selection as the existing silent cancel result`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'office-word-cancel-'));
        try {
            const bookkeeping: string[] = [];
            const handler = createPackageRuntime(
                root,
                {
                    commit: async () => {
                        throw Object.assign(new Error('picker canceled'), { code: 'canceled' });
                    }
                },
                bookkeeping
            )(channel);
            const result = await handler({ sender: { id: 17 } }, 'new.docx', Buffer.from('new bytes'));
            assert.equal(result.ok, false);
            assert.equal(result.error, undefined);
            assert.deepEqual(bookkeeping, []);
            assert.deepEqual(await readdir(root), []);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test(`real ${channel} awaits storage commit before reporting success or saved state`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'office-word-storage-'));
        try {
            const originalPath = path.join(root, 'original.docx');
            await writeFile(originalPath, 'previous document');
            const bookkeeping: string[] = [];
            let completeCommit!: () => void;
            let enteredCommit!: () => void;
            const entered = new Promise<void>((resolve) => (enteredCommit = resolve));
            const completed = new Promise<void>((resolve) => (completeCommit = resolve));
            const storage = {
                async commit(request: any, persist: () => Promise<void>) {
                    assert.equal(request.kind, 'word');
                    assert.equal(request.editorId, 17);
                    assert.equal(request.intent, intent);
                    await localOfficeDocumentStorage.commit(request, persist);
                    assert.equal((await readFile(request.localPath)).toString(), 'new document bytes');
                    enteredCommit();
                    await completed;
                }
            };
            const handler = createPackageRuntime(root, storage, bookkeeping)(channel);
            const event = { sender: { id: 17 } };
            const bytes = Buffer.from('new document bytes');
            const result =
                channel === 'docs:save' ? handler(event, originalPath, bytes) : handler(event, 'new.docx', bytes);
            await entered;
            assert.deepEqual(bookkeeping, []);
            assert.deepEqual(
                (await readdir(root)).filter((name) => name.endsWith('.tmp')),
                []
            );
            completeCommit();
            assert.equal((await result).ok, true);
            assert.ok(bookkeeping.includes('disk-state'));
            assert.ok(bookkeeping.includes('password'));
            if (channel !== 'docs:save') assert.ok(bookkeeping.includes('saved-event'));
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test(`real ${channel} preserves dirty/recovery bookkeeping when provider commit fails`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'office-word-reject-'));
        try {
            const bookkeeping: string[] = [];
            const storage = {
                commit: async () => {
                    throw new Error('provider write rejected');
                }
            };
            const handler = createPackageRuntime(root, storage, bookkeeping)(channel);
            const event = { sender: { id: 17 } };
            const bytes = Buffer.from('new document bytes');
            const result = await (channel === 'docs:save'
                ? handler(event, path.join(root, 'original.docx'), bytes)
                : handler(event, 'new.docx', bytes));
            assert.equal(result.ok, false);
            assert.match(result.error, /provider write rejected/);
            assert.deepEqual(bookkeeping, []);
            assert.deepEqual(await readdir(root), []);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test(`real ${channel} retains recoverable local bytes when an external commit rejects after persistence`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'office-word-external-reject-'));
        try {
            const bookkeeping: string[] = [];
            let localPath = '';
            const storage = {
                async commit(request: any, persist: () => Promise<void>) {
                    localPath = request.localPath;
                    await persist();
                    throw new Error('external provider failed');
                }
            };
            const handler = createPackageRuntime(root, storage, bookkeeping)(channel);
            const event = { sender: { id: 17 } };
            const bytes = Buffer.from('recoverable document bytes');
            const result = await (channel === 'docs:save'
                ? handler(event, path.join(root, 'original.docx'), bytes)
                : handler(event, 'new.docx', bytes));
            assert.equal(result.ok, false);
            assert.match(result.error, /external provider failed/);
            assert.deepEqual(bookkeeping, []);
            assert.equal((await readFile(localPath)).toString(), 'recoverable document bytes');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test('the package atomic writer preserves an existing document and cleans its temporary file on rename failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'office-word-atomic-'));
    try {
        const target = path.join(root, 'original.docx');
        await writeFile(target, 'original document');
        const bookkeeping: string[] = [];
        const handler = createPackageRuntime(root, localOfficeDocumentStorage, bookkeeping, {
            rename: async () => {
                throw Object.assign(new Error('disk error'), { code: 'EIO' });
            }
        })('docs:save');
        const result = await handler({ sender: { id: 17 } }, target, Buffer.from('replacement'));
        assert.equal(result.ok, false);
        assert.equal(await readFile(target, 'utf8'), 'original document');
        assert.deepEqual(await readdir(root), ['original.docx']);
        assert.deepEqual(bookkeeping, []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
