import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import {
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    readlink,
    realpath,
    rm,
    stat,
    symlink,
    writeFile
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { persistOfficeWorkingCopyAtomically } from '../../../main/office/atomicWorkingCopy.js';
import { transformOfficeSlidesStorage } from '../../../../scripts/office-slides-storage-compat.mjs';
import { createOfficeStorageEsbuildPlugin } from '../../../../scripts/office-storage-build-compat.mjs';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const packagePath = require.resolve('@bitclub.ai/opendesk-office/main');
const original = await readFile(packagePath, 'utf8');
const patched = transformOfficeSlidesStorage(original);
const parsed = ts.createSourceFile('slides-main.js', patched, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function extract(name: string, channel = false, method = false): string {
    let result: string | undefined;
    function visit(node: ts.Node) {
        if (!channel && ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(parsed);
        if (method && ts.isMethodDeclaration(node) && node.name.getText(parsed) === name) {
            result = `({${node.getText(parsed)}}).${name}`;
        }
        if (
            channel &&
            ts.isCallExpression(node) &&
            node.arguments.length > 1 &&
            ts.isStringLiteral(node.arguments[0]) &&
            node.arguments[0].text === name
        ) {
            result = `(${node.arguments[1].getText(parsed)})`;
        }
        ts.forEachChild(node, visit);
    }
    visit(parsed);
    assert.ok(result, `Missing actual package entry ${name}`);
    return result;
}

function createRuntime(root: string, session: any, storage: unknown, events: string[]) {
    const resultBytes = Buffer.from('automation result');
    const context = vm.createContext({
        Buffer,
        path,
        runtime: { documentStorage: storage },
        persistOpenDeskSlidesWorkingCopy: persistOfficeWorkingCopyAtomically,
        savePptxToFile: async (_opened: unknown, destination: string) => writeFile(destination, 'presentation bytes'),
        existsSync5: existsSync,
        mkdirSync5: mkdirSync,
        getDraftsDir: () => root,
        pickDraftPath: () => path.join(root, 'new.pptx'),
        tm: (key: string) => key,
        pushRecent: async () => events.push('recent'),
        slidesOpenedHook: () => events.push('opened'),
        autosaveBackoff: new Map(),
        rm,
        autosavePathFor: () => path.join(root, 'recovery.pptx'),
        dropUntitledRecovery: () => events.push('drop-recovery'),
        commitSaved: () => events.push('commit-saved'),
        readStableDiskSnapshot: async () => ({ state: 'saved-state' }),
        buildAllRenderSlides: () => [],
        deckDefaultFont: () => 'Arial',
        sessions: new Map([[17, session]]),
        sessions2: { has: () => true },
        dialogParent: () => undefined,
        dialog2: {},
        showSaveDialogWithMemory: async () => ({ canceled: false, filePath: path.join(root, 'saved-as.pptx') }),
        syncAttachedPaths: () => events.push('sync-paths'),
        enterPresentationProgramStage: () => {},
        requestSlidesRendererFlush: async () => true,
        synchronizeSlidesSessionFromDisk: async () => 'unchanged',
        slidesIsDirty: () => false,
        savePptx: async () => Buffer.from('snapshot'),
        presentationRevision: () => 'revision-1',
        runPresentationProgram: async () => ({
            ok: true,
            bytes: resultBytes,
            revision: { after: 'revision-2' },
            diff: { slidesAdded: [1] }
        }),
        openPptx: async () => ({ deck: { size: { cx: 1, cy: 1 } } }),
        mkdirSync6: mkdirSync,
        randomUUID3: randomUUID,
        writeFileSync5: writeFileSync,
        existsSync6: existsSync,
        unlinkSync2: unlinkSync,
        renameSync2: renameSync,
        pushHistory: () => events.push('history'),
        statSync4: statSync,
        createHash7: createHash,
        PresentationProgramAbortedError: class extends Error {},
        PRESENTATION_AUTOMATION_API_VERSION: 'test'
    });
    vm.runInContext(extract('commitOpenDeskSlidesDocument'), context);
    vm.runInContext(extract('saveSessionToCurrentPath'), context);
    vm.runInContext(extract('saveSlidesSessionForAutomation'), context);
    return {
        context,
        handler: (name: string) =>
            vm.runInContext(
                name.startsWith('slides:') || name === 'runPresentationProgram'
                    ? extract(name, name.startsWith('slides:'), name === 'runPresentationProgram')
                    : name,
                context
            )
    };
}

test('Slides patch rejects unreviewed packages without changing the installed bundle', async () => {
    assert.throws(() => transformOfficeSlidesStorage(original + '\n'), /bundle changed/);
    assert.equal(await readFile(packagePath, 'utf8'), original);
});

test('the shared esbuild plugin applies the same Word, Slides and Sheets storage ports to actual package inputs', async () => {
    const result = await build({
        entryPoints: [
            packagePath,
            require.resolve('@bitclub.ai/opendesk-office/word-main'),
            require.resolve('@bitclub.ai/opendesk-office/sheets-main')
        ],
        bundle: false,
        outdir: 'unused-office-test-output',
        write: false,
        platform: 'node',
        plugins: [createOfficeStorageEsbuildPlugin()]
    });
    assert.equal(result.outputFiles.length, 3);
    for (const output of result.outputFiles) {
        assert.match(output.text, /Office document storage is not configured/);
        assert.match(output.text, /documentStorage\.commit/);
    }
});

for (const intent of ['save', 'save-as', 'save-new', 'automation-save'] as const) {
    test(`actual Slides ${intent} keeps canceled selections silent and dirty`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'office-slides-cancel-'));
        try {
            const oldPath = intent === 'save-new' ? '' : path.join(root, 'original.pptx');
            const session = { path: oldPath, opened: { deck: { size: {} } }, metaDirty: true };
            const events: string[] = [];
            const runtime = createRuntime(
                root,
                session,
                {
                    commit: async () => {
                        throw Object.assign(new Error('picker canceled'), { code: 'canceled' });
                    }
                },
                events
            );
            const contents = { id: 17, isDestroyed: () => false, send: (event: string) => events.push(event) };
            const result =
                intent === 'save-as'
                    ? await runtime.handler('slides:save-as')({ sender: contents }, 'new.pptx')
                    : intent === 'automation-save'
                      ? await runtime.handler('saveSlidesSessionForAutomation')(contents)
                      : await runtime.handler('slides:save')({ sender: contents });
            assert.equal(intent === 'automation-save' ? result : result.ok, false);
            if (intent !== 'automation-save') assert.equal(result.error, undefined);
            assert.equal(session.metaDirty, true);
            assert.equal(session.path, oldPath);
            assert.deepEqual(events, []);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test(`actual Slides ${intent} waits for provider commit before changing session or saved events`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'office-slides-'));
        try {
            const originalPath = path.join(root, 'original.pptx');
            const session = {
                path: intent === 'save-new' ? '' : originalPath,
                opened: { deck: { size: { cx: 1, cy: 1 } } },
                metaDirty: true
            };
            await writeFile(originalPath, 'previous');
            const events: string[] = [];
            let entered!: () => void, complete!: () => void;
            const started = new Promise<void>((resolve) => (entered = resolve));
            const finished = new Promise<void>((resolve) => (complete = resolve));
            const runtime = createRuntime(
                root,
                session,
                {
                    async commit(request: any, persist: () => Promise<void>) {
                        assert.equal(request.kind, 'slides');
                        assert.equal(request.editorId, 17);
                        assert.equal(request.intent, intent === 'automation-save' ? 'save' : intent);
                        await persist();
                        assert.equal(await readFile(request.localPath, 'utf8'), 'presentation bytes');
                        entered();
                        await finished;
                    }
                },
                events
            );
            const contents = { id: 17, isDestroyed: () => false, send: (event: string) => events.push(event) };
            const promise =
                intent === 'save-as'
                    ? runtime.handler('slides:save-as')({ sender: contents }, 'new.pptx')
                    : intent === 'automation-save'
                      ? runtime.handler('saveSlidesSessionForAutomation')(contents)
                      : runtime.handler('slides:save')({ sender: contents });
            await started;
            assert.deepEqual(events, []);
            assert.equal(session.metaDirty, true);
            assert.equal(session.path, intent === 'save-new' ? '' : originalPath);
            complete();
            const result = await promise;
            assert.equal(intent === 'automation-save' ? result : result.ok, true);
            assert.equal(session.metaDirty, false);
            assert.ok(events.includes('commit-saved'));
            if (intent === 'automation-save') assert.ok(events.includes('slides:host-saved'));
            assert.deepEqual(
                (await readdir(root)).filter((name) => name.endsWith('.office-tmp')),
                []
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test(`actual Slides ${intent} keeps dirty state and old identity when provider rejects`, async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'office-slides-reject-'));
        try {
            const oldPath = intent === 'save-new' ? '' : path.join(root, 'original.pptx');
            const session = { path: oldPath, opened: { deck: { size: {} } }, metaDirty: true };
            const events: string[] = [];
            const runtime = createRuntime(
                root,
                session,
                {
                    commit: async () => {
                        throw new Error('provider rejected');
                    }
                },
                events
            );
            const contents = { id: 17, isDestroyed: () => false, send: (event: string) => events.push(event) };
            const result =
                intent === 'save-as'
                    ? await runtime.handler('slides:save-as')({ sender: contents }, 'new.pptx')
                    : intent === 'automation-save'
                      ? await runtime.handler('saveSlidesSessionForAutomation')(contents)
                      : await runtime.handler('slides:save')({ sender: contents });
            assert.equal(intent === 'automation-save' ? result : result.ok, false);
            assert.equal(session.metaDirty, true);
            assert.equal(session.path, oldPath);
            assert.deepEqual(events, []);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test('actual presentation-program commit waits before replacing editor state and notifying renderer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'office-slides-program-'));
    try {
        const target = path.join(root, 'deck.pptx');
        const initialOpened = { deck: { size: {} } };
        const session = { path: target, opened: initialOpened, metaDirty: false };
        const events: string[] = [];
        let entered!: () => void, complete!: () => void;
        const started = new Promise<void>((resolve) => (entered = resolve));
        const finished = new Promise<void>((resolve) => (complete = resolve));
        const runtime = createRuntime(
            root,
            session,
            {
                async commit(_request: any, persist: () => Promise<void>) {
                    await persist();
                    entered();
                    await finished;
                }
            },
            events
        );
        const contents = { id: 17, send: (event: string) => events.push(event) };
        const promise = runtime.handler('runPresentationProgram')(contents, { startFrom: 'blank' });
        await started;
        assert.equal(session.opened, initialOpened);
        assert.deepEqual(events, []);
        complete();
        assert.equal((await promise).ok, true);
        assert.notEqual(session.opened, initialOpened);
        assert.ok(events.includes('opendesk-office:presentation-program-committed'));
        assert.equal(await readFile(target, 'utf8'), 'automation result');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('streaming saves retain existing document permissions without changing new-file defaults', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX file permission semantics');
    const root = await mkdtemp(path.join(os.tmpdir(), 'office-stream-mode-'));
    try {
        const target = path.join(root, 'private.pptx');
        await writeFile(target, 'original', { mode: 0o600 });
        await persistOfficeWorkingCopyAtomically(target, (temporary) => writeFile(temporary, 'updated'));
        assert.equal((await stat(target)).mode & 0o777, 0o600);
        assert.equal(await readFile(target, 'utf8'), 'updated');

        const newTarget = path.join(root, 'new.pptx');
        let serializerMode = 0;
        await persistOfficeWorkingCopyAtomically(newTarget, async (temporary) => {
            await writeFile(temporary, 'created');
            serializerMode = (await stat(temporary)).mode & 0o777;
        });
        assert.equal((await stat(newTarget)).mode & 0o777, serializerMode);
        assert.deepEqual((await readdir(root)).sort(), ['new.pptx', 'private.pptx']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('streaming saves preserve a read-only document instead of replacing it through directory permissions', async (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0)
        return t.skip('Unprivileged POSIX permission semantics');
    const root = await mkdtemp(path.join(os.tmpdir(), 'office-stream-readonly-'));
    try {
        const target = path.join(root, 'readonly.pptx');
        await writeFile(target, 'original', { mode: 0o400 });
        await assert.rejects(
            persistOfficeWorkingCopyAtomically(target, (temporary) => writeFile(temporary, 'must not publish')),
            { code: 'EACCES' }
        );
        assert.equal(await readFile(target, 'utf8'), 'original');
        assert.equal((await stat(target)).mode & 0o777, 0o400);
        assert.deepEqual(await readdir(root), ['readonly.pptx']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('streaming saves follow document links through a linked parent and leave both links intact', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX symbolic link semantics');
    const root = await mkdtemp(path.join(os.tmpdir(), 'office-stream-links-'));
    try {
        const actual = path.join(root, 'actual', 'documents');
        await mkdir(actual, { recursive: true });
        const target = path.join(actual, 'original.pptx');
        await writeFile(target, 'original', { mode: 0o600 });
        const documentLink = path.join(actual, 'linked.pptx');
        await symlink('./original.pptx', documentLink);
        const parentLink = path.join(root, 'workspace');
        await symlink(actual, parentLink);
        await persistOfficeWorkingCopyAtomically(path.join(parentLink, 'linked.pptx'), async (temporary) => {
            assert.equal(path.dirname(temporary), await realpath(actual));
            await writeFile(temporary, 'updated');
        });
        assert.equal((await lstat(documentLink)).isSymbolicLink(), true);
        assert.equal((await lstat(parentLink)).isSymbolicLink(), true);
        assert.equal(await readlink(documentLink), './original.pptx');
        assert.equal(await readFile(target, 'utf8'), 'updated');
        assert.equal((await stat(target)).mode & 0o777, 0o600);
        assert.deepEqual((await readdir(actual)).sort(), ['linked.pptx', 'original.pptx']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('streaming saves create a dangling link target without replacing the link chain', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX symbolic link semantics');
    const root = await mkdtemp(path.join(os.tmpdir(), 'office-stream-dangling-'));
    try {
        const first = path.join(root, 'first.pptx');
        const second = path.join(root, 'second.pptx');
        const target = path.join(root, 'created.pptx');
        await symlink('./second.pptx', first);
        await symlink('./created.pptx', second);
        await persistOfficeWorkingCopyAtomically(first, (temporary) => writeFile(temporary, 'created'));
        assert.equal((await lstat(first)).isSymbolicLink(), true);
        assert.equal((await lstat(second)).isSymbolicLink(), true);
        assert.equal(await readFile(target, 'utf8'), 'created');
        assert.deepEqual((await readdir(root)).sort(), ['created.pptx', 'first.pptx', 'second.pptx']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('streaming saves reject link cycles and missing target parents without replacing links', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX symbolic link semantics');
    const root = await mkdtemp(path.join(os.tmpdir(), 'office-stream-link-failure-'));
    try {
        const first = path.join(root, 'first.pptx');
        const second = path.join(root, 'second.pptx');
        await symlink('./second.pptx', first);
        await symlink('./first.pptx', second);
        await assert.rejects(
            persistOfficeWorkingCopyAtomically(first, (temporary) => writeFile(temporary, 'must not publish')),
            { code: 'ELOOP' }
        );
        const dangling = path.join(root, 'dangling.pptx');
        await symlink('./missing/created.pptx', dangling);
        await assert.rejects(
            persistOfficeWorkingCopyAtomically(dangling, (temporary) => writeFile(temporary, 'must not publish')),
            { code: 'ENOENT' }
        );
        for (const link of [first, second, dangling]) assert.equal((await lstat(link)).isSymbolicLink(), true);
        assert.deepEqual((await readdir(root)).sort(), ['dangling.pptx', 'first.pptx', 'second.pptx']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('streaming atomic working copies preserve original files and remove partial temp files on serializer failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'office-stream-fail-'));
    try {
        const target = path.join(root, 'deck.pptx');
        await writeFile(target, 'original');
        await assert.rejects(
            persistOfficeWorkingCopyAtomically(target, async (temporary) => {
                await writeFile(temporary, 'partial');
                throw new Error('serialization failed');
            }),
            /serialization failed/
        );
        assert.equal(await readFile(target, 'utf8'), 'original');
        assert.deepEqual(await readdir(root), ['deck.pptx']);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a rejected presentation-program storage commit leaves editor state intact and cleans the staged result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'office-slides-program-reject-'));
    try {
        const target = path.join(root, 'deck.pptx');
        await writeFile(target, 'original');
        const initialOpened = { deck: { size: {} } };
        const session = { path: target, opened: initialOpened, metaDirty: false };
        const events: string[] = [];
        const runtime = createRuntime(
            root,
            session,
            {
                commit: async () => {
                    throw new Error('provider rejected');
                }
            },
            events
        );
        await assert.rejects(
            runtime.handler('runPresentationProgram')(
                { id: 17, send: (event: string) => events.push(event) },
                { startFrom: 'blank' }
            ),
            /provider rejected/
        );
        assert.equal(session.opened, initialOpened);
        assert.equal(await readFile(target, 'utf8'), 'original');
        assert.deepEqual(await readdir(root), ['deck.pptx']);
        assert.deepEqual(events, []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a presentation session replaced during an external commit does not receive a late program result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'office-slides-program-stale-'));
    try {
        const session = { path: path.join(root, 'deck.pptx'), opened: { deck: { size: {} } }, metaDirty: false };
        const originalOpened = session.opened;
        const events: string[] = [];
        let runtime: ReturnType<typeof createRuntime>;
        runtime = createRuntime(
            root,
            session,
            {
                async commit(_request: unknown, persist: () => Promise<void>) {
                    await persist();
                    (runtime.context.sessions as Map<number, unknown>).delete(17);
                }
            },
            events
        );
        const result = await runtime.handler('runPresentationProgram')(
            { id: 17, send: (event: string) => events.push(event) },
            { startFrom: 'blank' }
        );
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'REVISION_CONFLICT');
        assert.equal(session.opened, originalOpened);
        assert.deepEqual(events, []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
