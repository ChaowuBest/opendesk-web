import path from 'path';
import { Hono } from 'hono';
import {
    getRequestOrTaskWorkspace,
    getRequestWorkspace,
    getRequestWorkspaceID,
    getTaskWorkspace
} from '../../../main/server/workspace.js';

describe('opencode workspace routing helpers', () => {
    test('uses directory query parameter as request workspace', async () => {
        const app = new Hono();
        app.get('/path', (c) => c.json({ directory: getRequestWorkspace(c) }));

        const directory = path.resolve('attach-query');
        const response = await app.request(`/path?directory=${encodeURIComponent(directory)}`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ directory });
    });

    test('uses x-opencode-directory header as request workspace', async () => {
        const app = new Hono();
        app.get('/path', (c) => c.json({ directory: getRequestWorkspace(c) }));

        const directory = path.resolve('attach-header');
        const response = await app.request('/path', {
            headers: { 'x-opencode-directory': encodeURIComponent(directory) }
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ directory });
    });

    test('falls back to persisted task workspace when request has no directory', async () => {
        const app = new Hono();
        const directory = path.resolve('session-workspace');
        const task = { workspace: directory };
        app.get('/session/ses_test/message', (c) => c.json({ directory: getRequestOrTaskWorkspace(c, task) }));

        const response = await app.request('/session/ses_test/message');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ directory });
        expect(getTaskWorkspace(task)).toBe(directory);
    });

    test('keeps opencode workspace id separate from filesystem workspace', async () => {
        const app = new Hono();
        const directory = path.resolve('workspace-id-query');
        app.get('/path', (c) =>
            c.json({
                directory: getRequestWorkspace(c),
                workspaceID: getRequestWorkspaceID(c)
            })
        );

        const response = await app.request(
            `/path?directory=${encodeURIComponent(directory)}&workspace=wrk_test_workspace`
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            directory,
            workspaceID: 'wrk_test_workspace'
        });
    });
});
