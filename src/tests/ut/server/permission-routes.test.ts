import { jest } from '@jest/globals';
import { PermissionRoutes } from '../../../main/server/opencode/routes/permission.js';
import { ServerPermissionBroker } from '../../../main/server/opencode/permission-broker.js';

describe('opencode permission routes', () => {
    let broker: ServerPermissionBroker;

    beforeEach(() => {
        jest.useFakeTimers();
        broker = new ServerPermissionBroker(10_000);
    });

    afterEach(() => {
        broker.dispose();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('lists pending permission requests', async () => {
        void broker.prompt(
            [{ resourceType: 'file', action: 'read', resourcePath: 'D:/repo/README.md' }],
            'readFile',
            [
                { label: 'README.md', pattern: 'D:/repo/README.md' },
                { label: 'D:/repo/', pattern: 'D:/repo/**' }
            ],
            { taskId: 'task_abc', taskName: 'test' },
            { toolCallId: 'call_1', messageId: 'msg_1', input: { file_path: 'D:/repo/README.md' } }
        );

        const response = await PermissionRoutes(broker).request('/permission');
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body).toHaveLength(1);
        expect(body[0]).toMatchObject({
            sessionID: 'ses_abc',
            permission: 'read',
            patterns: ['D:/repo/README.md'],
            always: ['D:/repo/**'],
            tool: { messageID: 'msg_1', callID: 'call_1' }
        });
        expect(body[0].id).toMatch(/^per_/);
        expect(body[0].metadata.input).toEqual({ file_path: 'D:/repo/README.md' });
    });

    test('resolves once reply as one-shot allow', async () => {
        const prompt = broker.prompt(
            [{ resourceType: 'file', action: 'write', resourcePath: 'D:/repo/a.txt' }],
            'writeFile',
            [{ label: 'a.txt', pattern: 'D:/repo/a.txt' }],
            { taskId: 'task_abc', taskName: null },
            { input: { path: 'D:/repo/a.txt' } }
        );
        const request = broker.list()[0];

        const response = await PermissionRoutes(broker).request(`/permission/${request.id}/reply`, {
            method: 'POST',
            body: JSON.stringify({ reply: 'once' }),
            headers: { 'content-type': 'application/json' }
        });

        await expect(prompt).resolves.toEqual({ decision: 'allow', rememberScope: 'none' });
        expect(response.status).toBe(200);
        expect(await response.json()).toBe(true);
        expect(broker.list()).toEqual([]);
    });

    test('resolves always reply as prefix allow', async () => {
        const prompt = broker.prompt(
            [{ resourceType: 'file', action: 'write', resourcePath: 'D:/repo/src/a.ts' }],
            'editFile',
            [
                { label: 'a.ts', pattern: 'D:/repo/src/a.ts' },
                { label: 'src/', pattern: 'D:/repo/src/**' }
            ],
            { taskId: 'task_abc', taskName: null },
            { input: { filePath: 'D:/repo/src/a.ts' } }
        );
        const request = broker.list()[0];

        await PermissionRoutes(broker).request(`/permission/${request.id}/reply`, {
            method: 'POST',
            body: JSON.stringify({ body: { reply: 'always' } }),
            headers: { 'content-type': 'application/json' }
        });

        await expect(prompt).resolves.toEqual({
            decision: 'allow',
            rememberScope: 'prefix',
            selectedPrefixPattern: 'D:/repo/src/**'
        });
    });

    test('keeps an exact file pattern when no directory prefix is available', async () => {
        void broker.prompt(
            [{ resourceType: 'file', action: 'read', resourcePath: 'D:/repo/README.md' }],
            'readFile',
            [{ label: 'README.md', pattern: 'D:/repo/README.md' }],
            { taskId: 'task_abc', taskName: null }
        );

        expect(broker.list()[0].always).toEqual(['D:/repo/README.md']);
    });

    test('resolves reject reply as user denial', async () => {
        const prompt = broker.prompt(
            [{ resourceType: 'file', action: 'read', resourcePath: 'D:/repo/secret.txt' }],
            'readFile',
            [{ label: 'secret.txt', pattern: 'D:/repo/secret.txt' }],
            { taskId: 'task_abc', taskName: null }
        );
        const request = broker.list()[0];

        await PermissionRoutes(broker).request(`/permission/${request.id}/reply`, {
            method: 'POST',
            body: JSON.stringify({ reply: 'reject', message: 'no' }),
            headers: { 'content-type': 'application/json' }
        });

        await expect(prompt).resolves.toEqual({
            decision: 'deny',
            rememberScope: 'none',
            denyReason: 'user_denied'
        });
    });

    test('returns opencode not-found error shape for missing permission', async () => {
        const response = await PermissionRoutes(broker).request('/permission/per_missing/reply', {
            method: 'POST',
            body: JSON.stringify({ reply: 'once' }),
            headers: { 'content-type': 'application/json' }
        });

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            _tag: 'PermissionNotFoundError',
            requestID: 'per_missing',
            message: 'Permission request not found: per_missing'
        });
    });

    test('rejects invalid reply payloads', async () => {
        const response = await PermissionRoutes(broker).request('/permission/per_missing/reply', {
            method: 'POST',
            body: JSON.stringify({ reply: 'allow' }),
            headers: { 'content-type': 'application/json' }
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'Invalid permission reply' });
    });
});
