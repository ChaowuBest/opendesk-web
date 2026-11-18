import { describe, expect, test } from '@jest/globals';
import { TaskState } from '../../../main/aikernel/states/tasks.js';

describe('host-independent task HTML rendering', () => {
    test('an external UI subscriber can request HTML without an Electron platform', () => {
        const task = Object.create(TaskState.prototype) as TaskState;
        Object.assign(task, { subscribers: [{ wantsHtmlRender: false }, { wantsHtmlRender: true }] });
        expect(task.needsHtmlRender).toBe(true);
    });

    test('headless subscribers keep the text-only path', () => {
        const task = Object.create(TaskState.prototype) as TaskState;
        Object.assign(task, { subscribers: [{ wantsHtmlRender: false }] });
        expect(task.needsHtmlRender).toBe(false);
    });
});
