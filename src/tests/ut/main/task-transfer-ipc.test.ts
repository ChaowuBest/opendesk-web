import { beforeAll, beforeEach, afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OpenDialogReturnValue, SaveDialogReturnValue } from 'electron';
import type * as TaskTransfer from '../../../main/aikernel/task/transfer.js';
import type { TaskManagerState } from '../../../main/aikernel/task/manager.js';
import type { TaskTransferService } from '../../../main/utils/task-transfer-service.js';

const handlers = new Map<string, (...args: any[]) => Promise<any>>();
const chooseFile = jest.fn<() => Promise<OpenDialogReturnValue>>();
const chooseSave = jest.fn<() => Promise<SaveDialogReturnValue>>();
const importTasks = jest.fn<typeof TaskTransfer.importTaskEntries>();
const exportTasks = jest.fn<typeof TaskTransfer.exportTaskBundle>();
const warn = jest.fn();
const currentWorkspace = jest.fn(() => '/default');
jest.unstable_mockModule('electron', () => ({
    app: { once: jest.fn() },
    dialog: { showOpenDialog: chooseFile, showSaveDialog: chooseSave },
    ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) }
}));
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: { getInstance: () => ({ getEffectiveWorkspace: currentWorkspace }) }
}));
jest.unstable_mockModule('../../../locale/index.js', () => ({
    t: (key: string) => key,
    translateWithDomain: (key: string) => key
}));
jest.unstable_mockModule('../../../main/utils/logger.js', () => ({ logger: { warn } }));

describe('task transfer workspace IPC', () => {
    let register: any;
    let directory: string;
    let token: string;
    const sender = {};
    const manager = {} as TaskManagerState;
    const invoke = (name: string, ...args: any[]) => handlers.get(`taskManager:${name}`)!({ sender }, ...args);
    beforeAll(async () => {
        ({ registerTaskTransferHandlers: register } = await import('../../../main/utils/task-transfer-ipc.js'));
    });
    beforeEach(async () => {
        handlers.clear();
        chooseFile.mockClear();
        warn.mockClear();
        // 每个用例都会注册一次生命周期钩子，避免 will-quit 回调在用例之间累积
        const { app } = await import('electron');
        (app.once as unknown as jest.Mock).mockClear();
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'od-transfer-ipc-'));
        const source = path.join(directory, 'source.json');
        fs.writeFileSync(
            source,
            JSON.stringify({ task_id: 'source', task_status: 'stopped', chat_context: { messages: [] } })
        );
        chooseFile.mockResolvedValue({ canceled: false, filePaths: [source] });
        chooseSave.mockReset().mockResolvedValue({ canceled: false, filePath: path.join(directory, 'export.zip') });
        importTasks.mockReset().mockResolvedValue(1);
        exportTasks.mockReset().mockResolvedValue(2);
        register(manager, () => ({ webContents: sender }), {
            importTaskEntries: importTasks,
            exportTaskBundle: exportTasks
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

    test('drops the pending import snapshot when the host quits', async () => {
        const { app } = await import('electron');
        const quits = (app.once as unknown as jest.Mock).mock.calls.filter(([event]) => event === 'will-quit');
        expect(quits).toHaveLength(1);
        (quits[0][1] as () => void)();

        // 快照释放是异步的（关闭压缩包句柄 + 删除临时目录），等待它生效后再确认快照已失效。
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(await invoke('importTaskBundle', token, ['source'], directory)).toEqual({
            status: 'error',
            message: 'taskTransfer.error.expired'
        });
        expect(importTasks).not.toHaveBeenCalled();
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

    test('rejects other senders on all four channels without opening dialogs or discarding the preview', async () => {
        chooseFile.mockClear();
        const attempts: [string, ...unknown[]][] = [
            ['previewTaskImport'],
            ['discardTaskImport', token],
            ['importTaskBundle', token, ['source'], directory],
            ['exportTaskBundle', ['source']]
        ];
        for (const [name, ...args] of attempts) {
            expect(await handlers.get(`taskManager:${name}`)!({ sender: {} }, ...args)).toEqual({
                status: 'error',
                message: 'taskTransfer.error.expired'
            });
        }
        expect(chooseFile).not.toHaveBeenCalled();
        expect(chooseSave).not.toHaveBeenCalled();
        expect(importTasks).not.toHaveBeenCalled();
        expect(exportTasks).not.toHaveBeenCalled();
        expect((await invoke('importTaskBundle', token, ['source'], directory)).status).toBe('ok');
    });

    test('registers export with the desktop save dialog and preserves cancellation', async () => {
        const filePath = path.join(directory, 'export.zip');
        expect(await invoke('exportTaskBundle', ['source'])).toEqual({
            status: 'ok',
            data: { count: 2, filePath }
        });
        expect(exportTasks).toHaveBeenCalledWith(manager, ['source'], filePath);
        chooseSave.mockResolvedValue({ canceled: true, filePath: '' });
        expect(await invoke('exportTaskBundle', ['source'])).toEqual({ status: 'ok', data: null });
        expect(exportTasks).toHaveBeenCalledTimes(1);
    });

    test('the shared service keeps host document cleanup and business serialization outside Electron', async () => {
        const { createTaskTransferService } = await import('../../../main/utils/task-transfer-service.js');
        const release = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
        const pickImportFile = jest.fn(async () => ({ filePath: path.join(directory, 'source.json'), release }));
        const concurrent = jest.fn();
        const saveExportFile = jest.fn(async (_name: string, write: (file: string) => Promise<number>) => {
            concurrent(await service.discardTaskImport('any'));
            return {
                count: await write(path.join(directory, 'shared-export.zip')),
                filePath: path.join(directory, 'shared-export.zip')
            };
        });
        const service: TaskTransferService = createTaskTransferService({
            getManager: () => manager,
            getWorkspace: () => directory,
            transfer: { importTaskEntries: importTasks, exportTaskBundle: exportTasks },
            host: { pickImportFile, saveExportFile }
        });

        const preview = await service.previewTaskImport();
        expect(preview).toMatchObject({ status: 'ok', data: { workspace: directory, entries: [{ id: 'source' }] } });
        expect(release).toHaveBeenCalledTimes(1);
        expect(await service.exportTaskBundle(['source'])).toMatchObject({ status: 'ok', data: { count: 2 } });
        expect(concurrent).toHaveBeenCalledWith({ status: 'error', message: 'taskTransfer.error.expired' });
        if (preview.status === 'ok' && preview.data) await service.discardTaskImport(preview.data.token);
    });

    test('host import resources are released when parsing fails', async () => {
        const { createTaskTransferService } = await import('../../../main/utils/task-transfer-service.js');
        const release = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
        const service = createTaskTransferService({
            getManager: () => manager,
            getWorkspace: () => directory,
            transfer: { importTaskEntries: importTasks, exportTaskBundle: exportTasks },
            host: {
                pickImportFile: async () => ({ filePath: path.join(directory, 'missing.json'), release }),
                saveExportFile: async () => null
            }
        });

        expect((await service.previewTaskImport()).status).toBe('error');
        expect(release).toHaveBeenCalledTimes(1);
    });
});
