import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { jest } from '@jest/globals';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('import waits for all in-progress saves', () => {
    let directory: string;
    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'od-import-pending-'));
        setCustomOpendeskDirectory(directory);
    });
    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test.each(['flush', 'timer'] as const)(
        'waits for an older %s writer and preserves the imported index',
        async (source) => {
            if (source === 'timer') {
                jest.useFakeTimers({
                    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'performance', 'hrtime']
                });
            }
            const manager = new TaskManagerState();
            const existing = new TaskState(manager);
            existing.task_name = 'original';
            existing._dirty = true;
            manager.tasks.push(existing);
            manager.saveSync();
            existing._dirty = true;
            const entered = deferred();
            const release = deferred();
            const rename = fs.promises.rename;
            let holdFirstIndex = true;
            jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
                if (holdFirstIndex && String(to).endsWith('task_list.json')) {
                    holdFirstIndex = false;
                    entered.resolve();
                    await release.promise;
                }
                return rename(from, to);
            });
            let background: Promise<void>;
            if (source === 'flush') {
                background = manager.flushAllPendingSaves();
            } else {
                manager.save();
                jest.advanceTimersByTime(2000);
                background = (manager as any)._lastWritePromise;
            }
            let importing: Promise<void> | undefined;
            try {
                await entered.promise;
                if (source === 'timer') {
                    // Finish a newer timer write first, reproducing the overwritten last-write pointer.
                    existing.task_name = 'updated';
                    existing.persistLater();
                    jest.advanceTimersByTime(2000);
                    await (manager as any)._lastWritePromise;
                }
                const imported = new TaskState(manager);
                imported.task_name = 'imported';
                let completed = false;
                importing = manager.commitImportedTasks([imported]).then(() => {
                    completed = true;
                });
                // release 未释放时，正确实现被在途写入硬阻塞、不可能完成，
                // 多轮泵送不会误报；而未等待旧写入的错误实现必然在此期间完成。
                // 单次 setImmediate 依赖调度时机，在慢速 CI 上可能漏检。
                for (let i = 0; i < 20; i++) {
                    await setImmediate();
                }
                expect(completed).toBe(false);
                release.resolve();
                await Promise.all([background, importing]);
                const index = JSON.parse(fs.readFileSync(path.join(directory, 'tasks', 'task_list.json'), 'utf8'));
                expect(index.map((item: any) => item.task_name)).toEqual([
                    source === 'timer' ? 'updated' : 'original',
                    'imported'
                ]);
            } finally {
                release.resolve();
                await Promise.allSettled([background, ...(importing ? [importing] : [])]);
                jest.clearAllTimers();
            }
        }
    );
});
