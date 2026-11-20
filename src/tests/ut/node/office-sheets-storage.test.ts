import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { transformOfficeSheetsStorage } from '../../../../scripts/office-sheets-storage-compat.mjs';

const require = createRequire(import.meta.url);
const packagePath = require.resolve('@bitclub.ai/opendesk-office/sheets-main');
const original = await readFile(packagePath, 'utf8');
const patched = transformOfficeSheetsStorage(original);
const parsed = ts.createSourceFile('sheets-main.js', patched, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function extract(name: string, channel = false): string {
    let result: string | undefined;
    function visit(node: ts.Node) {
        if (!channel && ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(parsed);
        if (
            channel &&
            ts.isCallExpression(node) &&
            node.arguments.length > 1 &&
            ts.isPropertyAccessExpression(node.arguments[0]) &&
            node.arguments[0].expression.getText(parsed) === 'IPC_CHANNELS' &&
            node.arguments[0].name.text === name
        ) {
            result = `(${node.arguments[1].getText(parsed)})`;
        }
        ts.forEachChild(node, visit);
    }
    visit(parsed);
    assert.ok(result, `Missing actual package entry ${name}`);
    return result;
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => (resolve = complete));
    return { promise, resolve };
}

async function setup(root: string, csv = false) {
    const localPath = path.join(root, 'working.xlsx');
    const csvPath = path.join(root, 'source.csv');
    await writeFile(localPath, 'previous workbook');
    if (csv) await writeFile(csvPath, 'previous csv');
    const hashFile = async (file: string) =>
        createHash('sha256')
            .update(await readFile(file))
            .digest('hex');
    const session = {
        path: localPath,
        sha256: await hashFile(localPath),
        snapshotPath: path.join(root, 'recovery.xlsx'),
        ...(csv
            ? {
                  csvSourcePath: csvPath,
                  csvSourceSha: await hashFile(csvPath),
                  csvImport: true,
                  importTempDir: root
              }
            : {})
    };
    const sessions = new Map<string, any>([['session-1', session]]);
    const events: string[] = [];
    const entry = { sessions, client: { close: async () => events.push('close-sidecar') } };
    const runtime: { documentStorage?: unknown } = {};
    const context = vm.createContext({
        Buffer,
        Error,
        runtime,
        sessionFor: () => entry,
        resolveTransferredEdits: (_entry: unknown, input: unknown) => input,
        workbookSaveRequestSchema: { parse: (input: unknown) => input },
        workbookCreateDocumentRequestSchema: { parse: (input: unknown) => input },
        saveFileDialog: async () => ({ canceled: false, filePath: path.join(root, 'save-as.xlsx') }),
        sha256File: hashFile,
        workbookExportCsvRequestSchema: { parse: (input: unknown) => input },
        dialogParent: () => undefined,
        writeWorkbookTo: async (_client: unknown, _session: unknown, _request: unknown, destination: string) => {
            await writeFile(destination, 'updated workbook');
            return { touchedEntries: ['xl/worksheets/sheet1.xml'] };
        },
        cleanupSessionResources: async () => events.push('cleanup'),
        app: { getPath: () => root },
        openWorkbookSession: async (_client: unknown, target: string) => {
            events.push('reopen');
            const next = { path: target, sha256: await hashFile(target) };
            sessions.set('session-2', next);
            return next;
        },
        workbookOpenedHook: () => events.push('opened'),
        clearWorkbookRecovery: () => events.push('clear-recovery'),
        tm: (key: string) => key,
        uniquePathIn: (_dir: string, name: string) => path.join(root, name),
        configuredDefaultSaveDir: () => root,
        sanitizeGeneratedFileBase: (title: string) => title,
        sheetCsvToXlsxBuffer: async () => Buffer.from('new workbook'),
        openGeneratedFile: () => events.push('open-generated'),
        join7: path.join,
        dirname4: path.dirname,
        basename2: path.basename,
        randomBytes,
        writeFile2: writeFile,
        rename2: rename,
        unlink,
        RETRYABLE_RENAME_CODES: new Set(['EPERM', 'EACCES', 'EBUSY']),
        RENAME_RETRIES: 4,
        sleep: async () => {}
    });
    vm.runInContext(extract('atomicWriteFile'), context);
    vm.runInContext(extract('commitOpenDeskSheetsBytes'), context);
    return {
        context,
        runtime,
        sessions,
        session,
        events,
        localPath,
        csvPath,
        handler: (name: string) => vm.runInContext(extract(name, true), context)
    };
}

const sender = { id: 29 };

test('Sheets storage patch rejects unreviewed bundles and leaves the installed package intact', async () => {
    assert.throws(() => transformOfficeSheetsStorage(original + '\n'), /bundle changed/);
    assert.equal(await readFile(packagePath, 'utf8'), original);
});

for (const mode of ['save', 'save-as', 'csv'] as const) {
    test(`actual Sheets ${mode} waits for host commit before replacing the session and recovery`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'office-sheets-'));
        try {
            const state = await setup(root, mode === 'csv');
            const entered = deferred();
            const finished = deferred();
            state.runtime.documentStorage = {
                async commit(request: any, persist: () => Promise<void>) {
                    assert.equal(request.kind, 'sheets');
                    assert.equal(request.editorId, 29);
                    assert.equal(request.intent, mode === 'save-as' ? 'save-as' : 'save');
                    assert.equal(
                        request.localPath,
                        mode === 'csv'
                            ? state.csvPath
                            : mode === 'save-as'
                              ? path.join(root, 'save-as.xlsx')
                              : state.localPath
                    );
                    await persist();
                    assert.equal(
                        await readFile(request.localPath, 'utf8'),
                        mode === 'csv' ? '\ufeffnew,csv' : 'updated workbook'
                    );
                    entered.resolve();
                    await finished.promise;
                }
            };
            const pending = state.handler('saveWorkbook')(
                { sender },
                { sessionId: 'session-1', mode: mode === 'save-as' ? 'save-as' : 'save', csvContent: 'new,csv' }
            );
            await entered.promise;
            assert.ok(state.sessions.has('session-1'));
            assert.equal(
                state.sessions.get('session-1'),
                state.session,
                'provider wait cannot advance session identity or hashes'
            );
            if (mode === 'csv') assert.equal(await readFile(state.localPath, 'utf8'), 'previous workbook');
            assert.deepEqual(state.events, []);
            finished.resolve();
            const result = await pending;
            assert.equal(result.canceled, false);
            assert.deepEqual([...result.touchedEntries], ['xl/worksheets/sheet1.xml']);
            assert.equal(state.sessions.has('session-1'), false);
            assert.deepEqual(state.events, ['cleanup', 'reopen', 'opened', 'clear-recovery']);
            assert.deepEqual(
                (await readdir(root)).filter((name) => name.endsWith('.tmp')),
                []
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    for (const persistFirst of [false, true]) {
        test(`actual Sheets ${mode} preserves the session on provider rejection ${persistFirst ? 'after' : 'before'} working-copy write`, async () => {
            const root = await mkdtemp(path.join(os.tmpdir(), 'office-sheets-reject-'));
            try {
                const state = await setup(root, mode === 'csv');
                state.runtime.documentStorage = {
                    async commit(_request: unknown, persist: () => Promise<void>) {
                        if (persistFirst) await persist();
                        throw new Error('provider rejected');
                    }
                };
                await assert.rejects(
                    state.handler('saveWorkbook')(
                        { sender },
                        { sessionId: 'session-1', mode: mode === 'save-as' ? 'save-as' : 'save', csvContent: 'new,csv' }
                    ),
                    /provider rejected/
                );
                assert.ok(state.sessions.has('session-1'));
                assert.equal(state.sessions.get('session-1'), state.session);
                assert.equal(state.sessions.has('session-2'), false);
                assert.deepEqual(state.events, []);
                if (!persistFirst) assert.equal(await readFile(state.localPath, 'utf8'), 'previous workbook');
                if (mode === 'csv') assert.equal(await readFile(state.localPath, 'utf8'), 'previous workbook');
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }
}

for (const timing of ['serialization', 'provider'] as const) {
    test(`actual Sheets rejects a closed or replaced session during ${timing}`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'office-sheets-stale-'));
        try {
            const state = await setup(root);
            const entered = deferred();
            const finished = deferred();
            if (timing === 'serialization') {
                state.context.writeWorkbookTo = async () => {
                    entered.resolve();
                    await finished.promise;
                    return { touchedEntries: [] };
                };
            }
            state.runtime.documentStorage = {
                async commit(_request: unknown, persist: () => Promise<void>) {
                    await persist();
                    if (timing === 'provider') {
                        entered.resolve();
                        await finished.promise;
                    }
                }
            };
            const pending = state.handler('saveWorkbook')({ sender }, { sessionId: 'session-1', mode: 'save' });
            await entered.promise;
            const replacement = { path: path.join(root, 'replacement.xlsx') };
            state.sessions.set('session-1', replacement);
            finished.resolve();
            await assert.rejects(pending, /Unknown workbook session/);
            assert.equal(state.sessions.get('session-1'), replacement);
            assert.deepEqual(state.events, []);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

for (const type of ['csv', 'xlsx'] as const) {
    for (const succeeds of [true, false]) {
        test(`actual Sheets new ${type} ${succeeds ? 'waits for' : 'reports rejected'} provider commit before opening the result`, async () => {
            const root = await mkdtemp(path.join(os.tmpdir(), 'office-sheets-new-'));
            try {
                const state = await setup(root);
                const entered = deferred();
                const finished = deferred();
                state.runtime.documentStorage = {
                    async commit(request: any, persist: () => Promise<void>) {
                        assert.equal(request.kind, 'sheets');
                        assert.equal(request.editorId, 29);
                        assert.equal(request.intent, 'save-new');
                        await persist();
                        assert.equal(existsSync(request.localPath), true);
                        entered.resolve();
                        await finished.promise;
                        if (!succeeds) throw new Error('provider rejected');
                    }
                };
                const pending = state.handler('createDocument')(
                    { sender },
                    { type, title: 'new-document', content: 'a,b' }
                );
                await entered.promise;
                assert.deepEqual(state.events, []);
                finished.resolve();
                const result = await pending;
                assert.equal(result.ok, succeeds);
                if (succeeds) {
                    assert.deepEqual(state.events, ['open-generated']);
                    assert.equal(await readFile(result.path, 'utf8'), type === 'csv' ? '\ufeffa,b' : 'new workbook');
                } else {
                    assert.match(result.error, /provider rejected/);
                    assert.deepEqual(state.events, []);
                }
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }
}

for (const operation of ['saveWorkbook', 'createDocument', 'exportCsv'] as const) {
    test(`actual Sheets ${operation} maps canceled storage selection to the existing silent result`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'office-sheets-cancel-'));
        try {
            const state = await setup(root);
            state.runtime.documentStorage = {
                commit: async () => {
                    throw Object.assign(new Error('picker canceled'), { code: 'canceled' });
                }
            };
            const result = await state.handler(operation)(
                { sender },
                operation === 'saveWorkbook'
                    ? { sessionId: 'session-1', mode: 'save' }
                    : operation === 'createDocument'
                      ? { type: 'xlsx', title: 'new', content: 'a,b' }
                      : { content: 'a,b', targetPath: state.csvPath }
            );
            assert.equal(operation === 'createDocument' ? result.ok : result.canceled, operation !== 'createDocument');
            assert.equal(result.error, undefined);
            assert.equal(state.sessions.get('session-1'), state.session);
            assert.deepEqual(state.events, []);
            assert.equal(await readFile(state.localPath, 'utf8'), 'previous workbook');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

for (const succeeds of [true, false]) {
    test(`actual Sheets CSV save-as ${succeeds ? 'waits for provider success' : 'preserves hashes on provider failure'}`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'office-sheets-csv-save-as-'));
        try {
            const state = await setup(root, true);
            state.context.saveFileDialog = async () => ({ canceled: false, filePath: state.csvPath });
            const selection = await state.handler('saveWorkbook')(
                { sender },
                { sessionId: 'session-1', mode: 'save-as' }
            );
            assert.equal(selection.csvSaveAsPath, state.csvPath);
            const entered = deferred();
            const completed = deferred();
            state.runtime.documentStorage = {
                async commit(request: any, persist: () => Promise<void>) {
                    assert.equal(request.localPath, selection.csvSaveAsPath);
                    assert.equal(request.kind, 'sheets');
                    assert.equal(request.intent, 'save-as');
                    await persist();
                    entered.resolve();
                    await completed.promise;
                    if (!succeeds) throw new Error('provider rejected');
                }
            };
            const pending = state.handler('exportCsv')(
                { sender },
                { content: 'new,csv', targetPath: selection.csvSaveAsPath }
            );
            const rejected = succeeds ? undefined : assert.rejects(pending, /provider rejected/);
            await entered.promise;
            assert.equal(state.sessions.get('session-1'), state.session);
            completed.resolve();
            if (succeeds) {
                const result = await pending;
                assert.equal(result.canceled, false);
                assert.notEqual(state.sessions.get('session-1').csvSourceSha, state.session.csvSourceSha);
            } else {
                await rejected;
                assert.equal(state.sessions.get('session-1'), state.session);
            }
            assert.equal(await readFile(state.csvPath, 'utf8'), '\ufeffnew,csv');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test('a failed CSV provider write leaves the workbook baseline ready for a second save', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'office-sheets-csv-retry-'));
    try {
        const state = await setup(root, true);
        let reject = true;
        state.runtime.documentStorage = {
            async commit(request: any, persist: () => Promise<void>) {
                const baseline = await readFile(request.localPath);
                await persist();
                if (reject) {
                    await writeFile(request.localPath, baseline);
                    throw new Error('provider rejected');
                }
            }
        };
        const save = () =>
            state.handler('saveWorkbook')(
                { sender },
                { sessionId: 'session-1', mode: 'save', csvContent: 'retry,csv' }
            );
        await assert.rejects(save(), /provider rejected/);
        assert.equal(state.sessions.get('session-1'), state.session);
        assert.equal(await readFile(state.localPath, 'utf8'), 'previous workbook');
        assert.deepEqual(
            (await readdir(root)).filter((name) => name.includes('.opendesk-save-')),
            []
        );
        reject = false;
        assert.equal((await save()).canceled, false);
        assert.equal(await readFile(state.localPath, 'utf8'), 'updated workbook');
        assert.equal(await readFile(state.csvPath, 'utf8'), '\ufeffretry,csv');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
