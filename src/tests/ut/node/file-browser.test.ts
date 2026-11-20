import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {
    listFileEntries,
    listWorkspaceEntries,
    readTextFile,
    resolveWorkspaceFilePath
} from '../../../main/utils/file-browser.js';

test('the registered Electron handlers consume the shared file operations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-file-ipc-'));
    try {
        const file = path.join(root, 'note.txt');
        await fs.writeFile(file, 'content');
        const source = ts.createSourceFile(
            'main.ts',
            readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8'),
            ts.ScriptTarget.Latest,
            true
        );
        const handlers = new Map<string, (...args: unknown[]) => unknown>();
        const context = vm.createContext({
            listFileEntries,
            listWorkspaceEntries,
            readTextFile,
            resolveWorkspaceFilePath,
            Setting: { getInstance: () => ({ getEffectiveWorkspace: () => root }) },
            sandboxPathToHostPath: (value: string) => value,
            ipcMain: {
                handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)
            }
        });
        const visit = (node: ts.Node) => {
            if (
                ts.isCallExpression(node) &&
                node.expression.getText(source) === 'ipcMain.handle' &&
                ts.isStringLiteral(node.arguments[0]) &&
                ['fs:listDirectory', 'fs:readTextFile', 'fs:resolveFilePath', 'workspace:listDirectory'].includes(
                    node.arguments[0].text
                )
            ) {
                vm.runInContext(
                    ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
                        .outputText,
                    context
                );
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        const invoke = async (channel: string, ...args: unknown[]) => {
            assert.ok(handlers.has(channel), `${channel} must remain registered`);
            return JSON.parse(JSON.stringify(await handlers.get(channel)!({}, ...args)));
        };
        assert.deepEqual(await invoke('fs:readTextFile', file, 2), {
            status: 'ok',
            data: { tooLarge: true, size: 7, limit: 2, content: '', binary: false }
        });
        assert.equal((await invoke('fs:readTextFile', file)).data.content, 'content');
        assert.equal((await invoke('fs:readTextFile', root)).status, 'error');
        assert.equal((await invoke('fs:listDirectory', root)).data[0].name, 'note.txt');
        assert.deepEqual((await invoke('workspace:listDirectory', root)).data, []);
        assert.equal((await invoke('workspace:listDirectory', root, { includeFiles: true })).data[0].name, 'note.txt');
        assert.equal((await invoke('fs:resolveFilePath', 'note.txt')).data, file);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('text previews preserve empty, binary/image and too-large results after JSON transport', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-preview-'));
    try {
        const text = path.join(root, 'text.txt');
        const empty = path.join(root, 'empty.txt');
        const image = path.join(root, 'test.png');
        await fs.writeFile(text, '中文\nhello');
        await fs.writeFile(empty, '');
        await fs.writeFile(image, Buffer.from([137, 80, 78, 71, 0, 13]));
        const wire = async (file: string, limit?: number) =>
            JSON.parse(JSON.stringify(await readTextFile(file, limit)));
        assert.deepEqual(await wire(text, 3), { tooLarge: true, size: 12, limit: 3, content: '', binary: false });
        assert.equal((await wire(text, 0)).content, '中文\nhello');
        assert.deepEqual(await wire(empty), { tooLarge: false, size: 0, limit: 0, content: '', binary: false });
        assert.deepEqual(await wire(image), {
            tooLarge: false,
            size: 6,
            limit: 0,
            content: '',
            binary: true,
            dataUri: 'data:image/png;base64,iVBORwAN'
        });
        await assert.rejects(readTextFile(root), /not a file/);
        await assert.rejects(readTextFile(''), /filePath is required/);
        await assert.rejects(readTextFile(path.join(root, 'missing')), /ENOENT/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('directory results preserve sorting, metadata, symlink types and picker filters', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-list-'));
    try {
        await fs.mkdir(path.join(root, 'z-directory'));
        await fs.writeFile(path.join(root, 'b.txt'), 'b');
        await fs.writeFile(path.join(root, 'a.png'), 'a');
        await fs.writeFile(path.join(root, '.hidden.txt'), 'h');
        await fs.symlink(path.join(root, 'z-directory'), path.join(root, 'folder-link'));
        const entries = await listFileEntries(root);
        assert.deepEqual(
            entries.slice(0, 2).map((entry) => entry.name),
            ['folder-link', 'z-directory']
        );
        assert.equal(entries[0].isSymbolicLink, true);
        assert.equal(entries[0].isDirectory, true);
        assert.equal(typeof entries[0].modifiedAt, 'number');
        assert.equal(entries.find((entry) => entry.name === 'b.txt')?.size, 1);
        assert.deepEqual(
            (await listWorkspaceEntries(root)).map((entry) => entry.name),
            ['z-directory']
        );
        assert.deepEqual(
            (await listWorkspaceEntries(root, { includeFiles: true, extensions: ['.txt'] })).map((entry) => entry.name),
            ['z-directory', 'b.txt']
        );
        assert.ok(
            (await listWorkspaceEntries(root, { includeFiles: true, showHidden: true })).some(
                (entry) => entry.name === '.hidden.txt'
            )
        );
        await assert.rejects(listFileEntries(''), /dirPath is required/);
        await assert.rejects(listWorkspaceEntries(path.join(root, 'missing')), /ENOENT/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('relative paths resolve against the selected workspace and host paths are injected', () => {
    const root = path.join(os.tmpdir(), 'od-workspace');
    assert.equal(
        resolveWorkspaceFilePath(' \u200bnotes/../file.txt ', root),
        path.join(root, 'file.txt').replace(/\\/g, '/')
    );
    assert.equal(resolveWorkspaceFilePath('~/file.txt', root), path.join(os.homedir(), 'file.txt').replace(/\\/g, '/'));
    assert.equal(
        resolveWorkspaceFilePath('virtual', root, () => path.join(root, 'native.txt')),
        path.join(root, 'native.txt').replace(/\\/g, '/')
    );
    assert.throws(() => resolveWorkspaceFilePath('', root), /filePath is required/);
});
