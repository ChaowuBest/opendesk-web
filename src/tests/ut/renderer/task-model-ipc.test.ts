import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const mainSource = readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../../../renderer/preload.js', import.meta.url), 'utf8');

// 执行实际 IPC handler，隔离 Electron 启动及真实模型请求。
function loadHandler(channel: string, task: object) {
    const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    const end = mainSource.indexOf('ipcMain.handle(', start + 1);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handle = jest.fn();
    const source = ts.transpileModule(mainSource.slice(start, end), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText;
    runInNewContext(source, {
        ipcMain: { handle },
        globalState: {
            taskManagerState: {
                getTask: () => task,
                refreshLazyTaskSystemPrompt: async () => undefined
            }
        },
        Setting: { getInstance: () => ({ getModelInstance: () => ({}) }) }
    });
    return handle.mock.calls[0][1] as (...args: unknown[]) => Promise<unknown>;
}

describe('task model reasoning effort IPC', () => {
    test.each(['high', 'none', ''])('preload forwards effort %s together with the model', async (effort) => {
        const start = preloadSource.indexOf('setTaskModel: async');
        const end = preloadSource.indexOf('skipRetryDelay:', start);
        const invoke = jest.fn(async () => ({ status: 'ok' }));
        const api = runInNewContext(`({ ${preloadSource.slice(start, end)} })`, { ipcRenderer: { invoke } });

        await api.setTaskModel('task-1', 'model-a', effort);

        expect(invoke).toHaveBeenCalledWith('taskManager:setTaskModel', 'task-1', 'model-a', effort);
    });

    test.each(['high', 'none', ''])('persists effort %s even when the model stays the same', async (effort) => {
        const task = {
            model: 'model-a',
            reasoningEffort: 'low',
            persistLater: jest.fn(),
            refreshToolsets: jest.fn()
        };
        const handler = loadHandler('taskManager:setTaskModel', task);

        await handler({}, 'task-1', 'model-a', effort);

        expect(task.reasoningEffort).toBe(effort);
        expect(task.persistLater).toHaveBeenCalledTimes(1);
        expect(task.refreshToolsets).not.toHaveBeenCalled();
    });

    test('a model-only caller preserves the task effort and refreshes tools', async () => {
        const task = {
            model: 'model-a',
            reasoningEffort: 'high',
            persistLater: jest.fn(),
            refreshToolsets: jest.fn()
        };
        await loadHandler('taskManager:setTaskModel', task)({}, 'task-1', 'model-b');

        expect(task.model).toBe('model-b');
        expect(task.reasoningEffort).toBe('high');
        expect(task.refreshToolsets).toHaveBeenCalledTimes(1);
    });

    test.each(['high', 'none', ''])('submission applies effort %s before starting the next turn', async (effort) => {
        const task = {
            model: 'model-a',
            reasoningEffort: 'low',
            ensureValidModelOrFallback: jest.fn(),
            submitUserMessage: jest.fn(async () => {
                expect(task.reasoningEffort).toBe(effort);
            })
        };
        await loadHandler('taskManager:submitMessage', task)({}, 'task-1', {
            selectedModel: 'model-a',
            reasoningEffort: effort,
            message: 'hello'
        });

        expect(task.submitUserMessage).toHaveBeenCalledTimes(1);
    });
});
