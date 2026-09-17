import { jest } from '@jest/globals';

import { createTaskListUpdateSubscription } from '../../../renderer/taskListSubscription.js';

describe('task list update subscription', () => {
    test('installs the renderer listener before awaiting the main-process subscription', async () => {
        let resolveSubscription: ((value: { status: string; data: string }) => void) | undefined;
        const pendingSubscription = new Promise<{ status: string; data: string }>((resolve) => {
            resolveSubscription = resolve;
        });
        let listener: ((event: unknown, tasks: unknown[]) => void) | undefined;
        const ipc = {
            on: jest.fn((_channel: string, nextListener: typeof listener) => {
                listener = nextListener;
            }),
            removeListener: jest.fn(),
            invoke: jest.fn(() => pendingSubscription)
        };
        const callback = jest.fn();

        const subscription = createTaskListUpdateSubscription(ipc, callback);

        expect(ipc.on).toHaveBeenCalledWith('taskManager:taskListUpdate', expect.any(Function));
        listener?.({}, [{ task_id: 'card-refresh', internal: true }]);
        expect(callback).toHaveBeenCalledWith([{ task_id: 'card-refresh', internal: true }]);

        resolveSubscription?.({ status: 'ok', data: 'subscription-1' });
        await expect(subscription).resolves.toMatchObject({ subscriptionId: 'subscription-1' });
    });

    test('removes the early listener when main-process subscription fails', async () => {
        const ipc = {
            on: jest.fn(),
            removeListener: jest.fn(),
            invoke: jest.fn(async () => ({ status: 'error', message: 'failed' }))
        };

        await expect(createTaskListUpdateSubscription(ipc, jest.fn())).rejects.toThrow('failed');
        expect(ipc.removeListener).toHaveBeenCalledWith('taskManager:taskListUpdate', expect.any(Function));
    });
});
