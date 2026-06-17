import { PermissionPendingStore } from '../../../renderer/permissionPendingStore';

describe('PermissionPendingStore', () => {
    test('replays pending permission requests to late subscribers', () => {
        const store = new PermissionPendingStore<{ taskId: string; toolName: string }>();
        const received: Array<{ requestId: string; taskId: string; toolName: string }> = [];

        store.receiveRequest('perm-1', { taskId: 'task-a', toolName: 'readFile' });
        store.onRequest((requestId, data) => {
            received.push({ requestId, taskId: data.taskId, toolName: data.toolName });
        });

        expect(received).toEqual([{ requestId: 'perm-1', taskId: 'task-a', toolName: 'readFile' }]);
    });

    test('clears pending requests after user response', () => {
        const store = new PermissionPendingStore<{ taskId: string }>();
        const received: string[] = [];

        store.receiveRequest('perm-1', { taskId: 'task-a' });
        store.respond('perm-1');
        store.onRequest((requestId) => {
            received.push(requestId);
        });

        expect(received).toEqual([]);
        expect(store.getPendingRequests()).toEqual([]);
    });

    test('dismiss removes pending request and notifies dismiss subscribers', () => {
        const store = new PermissionPendingStore<{ taskId: string }>();
        const dismissed: string[] = [];

        store.receiveRequest('perm-1', { taskId: 'task-a' });
        store.onDismiss((requestId) => {
            dismissed.push(requestId);
        });
        store.receiveDismiss('perm-1');

        expect(dismissed).toEqual(['perm-1']);
        expect(store.getPendingRequests()).toEqual([]);
    });
});
