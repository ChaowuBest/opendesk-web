import { describe, expect, jest, test } from '@jest/globals';
import { releaseTaskMemory } from '../../../main/aikernel/task/memory.js';

describe('releaseTaskMemory', () => {
    test('rejects malformed IDs before touching tasks or host caches', () => {
        const clear = jest.fn();
        const tasks = new Proxy([], {
            get() {
                throw new Error('task collection must not be read');
            }
        });
        expect(releaseTaskMemory(null, tasks, clear)).toEqual({
            status: 'error',
            message: 'taskId must be a string'
        });
        expect(clear).not.toHaveBeenCalled();
    });

    test('a missing task is an idempotent success without altering host caches', () => {
        const clear = jest.fn();
        expect(releaseTaskMemory('deleted', [], clear)).toEqual({
            status: 'ok',
            data: { released: false }
        });
        expect(clear).not.toHaveBeenCalled();
    });

    test('clears the rendered cache before unloading only the requested task', () => {
        const events: string[] = [];
        const other = { task_id: 'other', unload: jest.fn(() => true) };
        const task = {
            task_id: 'target',
            ensureLoaded() {
                throw new Error('releasing must not reload a task');
            },
            unload() {
                events.push('unload');
                return true;
            }
        };
        expect(releaseTaskMemory('target', [other, task], (id) => events.push(`clear:${id}`))).toEqual({
            status: 'ok',
            data: { released: true }
        });
        expect(events).toEqual(['clear:target', 'unload']);
        expect(other.unload).not.toHaveBeenCalled();
    });

    test('keeps the unload result when a task is already unloaded or cannot be released', () => {
        const clear = jest.fn();
        const task = { task_id: 'target', unload: jest.fn(() => false) };
        expect(releaseTaskMemory('target', [task], clear)).toEqual({
            status: 'ok',
            data: { released: false }
        });
        expect(clear).toHaveBeenCalledWith('target');
    });

    test('does not turn an unloading failure into a successful release', () => {
        const failure = new Error('unload failed');
        const task = {
            task_id: 'target',
            unload() {
                throw failure;
            }
        };
        expect(() => releaseTaskMemory('target', [task], () => {})).toThrow(failure);
    });
});
