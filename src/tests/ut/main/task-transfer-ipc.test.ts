import { beforeAll, beforeEach, afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const handlers = new Map<string, (...args: any[]) => Promise<any>>();
const chooseFile = jest.fn<any>();
const importTasks = jest.fn<any>();
const warn = jest.fn();
const currentWorkspace = jest.fn(() => '/default');
jest.unstable_mockModule('electron', () => ({
    app: { once: jest.fn() },
    dialog: { showOpenDialog: chooseFile },
    ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) }
}));
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: { getInstance: () => ({ getEffectiveWorkspace: currentWorkspace }) }
}));
jest.unstable_mockModule('../../../locale/index.js', () => ({ t: (key: string) => key }));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({ logger: { warn } }));

describe('task transfer workspace IPC', () => {
    let register: any;
    let directory: string;
    let token: string;
    const sender = {};
    const manager = {};
    const invoke = (name: string, ...args: any[]) => handlers.get(`taskManager:${name}`)!({ sender }, ...args);
    beforeAll(async () => {
        ({ registerTaskTransferHandlers: register } = await import('../../../main/utils/task-transfer-ipc.js'));
    });
    beforeEach(async () => {
        handlers.clear();
        chooseFile.mockClear();
        warn.mockClear();
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'od-transfer-ipc-'));
        const source = path.join(directory, 'source.json');
        fs.writeFileSync(
            source,
            JSON.stringify({ task_id: 'source', task_status: 'stopped', chat_context: { messages: [] } })
        );
        chooseFile.mockResolvedValue({ canceled: false, filePaths: [source] });
        importTasks.mockReset().mockResolvedValue(1);
        register(manager, () => ({ webContents: sender }), {
            importTaskEntries: importTasks,
            exportTaskBundle: jest.fn()
        });
        token = (await invoke('previewTaskImport')).data.token;
    });
    afterEach(async () => {
        await invoke('discardTaskImport', token);
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('returns the localized ZIP corruption error before showing a preview', async () => {
        const file = path.join(directory, 'broken.zip');
        fs.writeFileSync(file, 'PK\x03\x04');
        chooseFile.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
        expect(await invoke('previewTaskImport')).toEqual({
            status: 'error',
            message: 'taskTransfer.error.corruptArchive'
        });
        expect(importTasks).not.toHaveBeenCalled();
    });

    test('uses the chosen directory for the batch and consumes the preview once', async () => {
        expect((await invoke('importTaskBundle', token, ['source'], directory)).status).toBe('ok');
        expect(importTasks).toHaveBeenCalledWith(expect.any(Array), ['source'], manager, directory);
        expect((await invoke('importTaskBundle', token, ['source'], directory)).status).toBe('error');
        expect(importTasks).toHaveBeenCalledTimes(1);
    });

    test('keeps Windows diagnostics in logs and returns only the friendly import message', async () => {
        const { TaskTransferError } = await import('../../../main/utils/task-bundle.js');
        const cause = Object.assign(new Error('access denied'), { code: 'EPERM', syscall: 'rename' });
        importTasks.mockRejectedValue(
            new TaskTransferError('writeFailed', cause, 'writeIndex', 'C:\\data\\tasks\\task_list.json')
        );
        const result = await invoke('importTaskBundle', token, ['source'], directory);
        expect(result.status).toBe('error');
        expect(result.message).toBe('taskTransfer.error.importWriteFailed');
        const diagnostic = warn.mock.calls.flat().join('\n');
        expect(diagnostic).toContain('EPERM');
        expect(diagnostic).toContain('rename');
        expect(diagnostic).toContain('access denied');
        expect(diagnostic).toContain('C:\\data\\tasks\\task_list.json');
        expect(diagnostic).toContain('taskTransfer.stage.writeIndex');
    });

    test('retains the preview after a failed commit and consumes it after a successful retry', async () => {
        importTasks.mockRejectedValueOnce(new Error('temporary failure'));
        expect(await invoke('importTaskBundle', token, ['source'], directory)).toEqual({
            status: 'error',
            message: 'taskTransfer.error.importWriteFailed'
        });
        expect((await invoke('importTaskBundle', token, ['source'], directory)).status).toBe('ok');
        expect(importTasks).toHaveBeenCalledTimes(2);
        expect((await invoke('importTaskBundle', token, ['source'], directory)).status).toBe('error');
        expect(chooseFile).toHaveBeenCalledTimes(1);
    });

    test('rejects invalid directories without consuming the preview, allowing a corrected selection', async () => {
        const file = path.join(directory, 'file');
        fs.writeFileSync(file, 'not a directory');
        for (const workspace of [undefined, '../relative', path.join(directory, 'missing'), file]) {
            expect(await invoke('importTaskBundle', token, ['source'], workspace)).toEqual({
                status: 'error',
                message: 'taskTransfer.error.invalidWorkspace'
            });
        }
        expect(importTasks).not.toHaveBeenCalled();
        expect((await invoke('importTaskBundle', token, ['source'], directory)).status).toBe('ok');
    });
});
