import { beforeAll, beforeEach, afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const handlers = new Map<string, (...args: any[]) => Promise<any>>();
const chooseFile = jest.fn<any>();
const importTasks = jest.fn<any>();
const currentWorkspace = jest.fn(() => '/default');
jest.unstable_mockModule('electron', () => ({
    dialog: { showOpenDialog: chooseFile },
    ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) }
}));
jest.unstable_mockModule('../../../main/aikernel/task/transfer.js', () => ({
    importTaskEntries: importTasks,
    exportTaskBundle: jest.fn()
}));
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: { getInstance: () => ({ getEffectiveWorkspace: currentWorkspace }) }
}));
jest.unstable_mockModule('../../../locale/index.js', () => ({ t: (key: string) => key }));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({ logger: { warn: jest.fn() } }));

describe('task transfer workspace IPC', () => {
    let register: any;
    let directory: string;
    let token: string;
    const sender = {};
    const manager = {};
    const invoke = (name: string, ...args: any[]) => handlers.get(`taskManager:${name}`)!({ sender }, ...args);
    beforeAll(async () => {
        ({ registerTaskTransferHandlers: register } = await import('../../../main/task-transfer-ipc.js'));
    });
    beforeEach(async () => {
        handlers.clear();
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'od-transfer-ipc-'));
        const source = path.join(directory, 'source.json');
        fs.writeFileSync(
            source,
            JSON.stringify({ task_id: 'source', task_status: 'stopped', chat_context: { messages: [] } })
        );
        chooseFile.mockResolvedValue({ canceled: false, filePaths: [source] });
        importTasks.mockReset().mockResolvedValue(1);
        register(manager, () => ({ webContents: sender }));
        token = (await invoke('previewTaskImport')).data.token;
    });
    afterEach(async () => {
        await invoke('discardTaskImport', token);
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('uses the chosen directory for the batch and consumes the preview once', async () => {
        expect((await invoke('importTaskBundle', token, ['source'], directory)).status).toBe('ok');
        expect(importTasks).toHaveBeenCalledWith(expect.any(Array), ['source'], manager, directory);
        expect((await invoke('importTaskBundle', token, ['source'], directory)).status).toBe('error');
        expect(importTasks).toHaveBeenCalledTimes(1);
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
