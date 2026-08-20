import { describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { routeTaskFileOpenRequest } from '../../../renderer/scripts/taskFileRouting.js';

describe('task file routing', () => {
    test('routes a file only to the task view that owns the requested task and reports a blocked switch', () => {
        const { document } = parseHTML('<!doctype html><html><body></body></html>');
        const first = document.createElement('task-view') as HTMLElement & {
            openFileInSidebar: jest.Mock;
        };
        first.setAttribute('task_id', 'task-a');
        first.openFileInSidebar = jest.fn();
        const second = document.createElement('task-view') as HTMLElement & {
            openFileInSidebar: jest.Mock;
        };
        second.setAttribute('task_id', 'task-b');
        second.openFileInSidebar = jest.fn();
        document.body.append(first, second);
        const onNotOpened = jest.fn();

        expect(
            routeTaskFileOpenRequest(
                document,
                {
                    requestId: 'request-1',
                    taskId: 'task-b',
                    filePath: '/workspace/deck.pptx'
                },
                onNotOpened
            )
        ).toBe(true);
        expect(first.openFileInSidebar).not.toHaveBeenCalled();
        expect(second.openFileInSidebar).toHaveBeenCalledWith(
            '/workspace/deck.pptx',
            undefined,
            expect.any(Function)
        );

        second.openFileInSidebar.mock.calls[0][2]();
        expect(onNotOpened).toHaveBeenCalledWith('request-1');
    });

    test('rejects incomplete requests without touching task views', () => {
        const { document } = parseHTML('<!doctype html><html><body></body></html>');
        const taskView = document.createElement('task-view') as HTMLElement & {
            openFileInSidebar: jest.Mock;
        };
        taskView.setAttribute('task_id', 'task-a');
        taskView.openFileInSidebar = jest.fn();
        document.body.append(taskView);

        expect(
            routeTaskFileOpenRequest(
                document,
                { requestId: 'request-1', taskId: '', filePath: '/workspace/deck.pptx' },
                jest.fn()
            )
        ).toBe(false);
        expect(taskView.openFileInSidebar).not.toHaveBeenCalled();
    });
});
