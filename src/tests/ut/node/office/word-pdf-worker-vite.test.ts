import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { resolveConfig } from 'electron-vite';
import { createServer } from 'vite';

async function verifyColdViteStartup(cacheDir: string): Promise<void> {
    const { config } = await resolveConfig({}, 'serve', 'development');
    assert.ok(config?.renderer, 'OpenDesk must provide a renderer Vite configuration');
    const renderer = config.renderer;
    const server = await createServer({
        ...renderer,
        cacheDir,
        server: { ...renderer.server, host: '127.0.0.1', port: 0, strictPort: true }
    });

    try {
        await server.listen();
        const address = server.httpServer?.address();
        assert.ok(address && typeof address === 'object');
        const origin = `http://127.0.0.1:${address.port}`;
        async function get(resource: string): Promise<string> {
            const url = new URL(resource, origin);
            assert.equal(url.origin, origin);
            const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
            const body = await response.text();
            assert.equal(response.status, 200, `${url.pathname}${url.search}: ${body.slice(0, 240)}`);
            return body;
        }

        // Exercise the real optimizer and the lazy Word import with a fresh cache.
        const optimizer = server.environments.client.depsOptimizer;
        assert.ok(optimizer, 'the renderer dependency optimizer must be enabled');
        await optimizer.scanProcessing;

        assert.match(await get('/'), /scripts\/index\.js/);
        await get('/scripts/index.js');
        assert.match(await get('/word_editor.html'), /wordEditorEntry\.ts/);
        assert.match(await get('/wordEditorEntry.ts'), /bootstrapOpenDeskOfficeWordEditor/);

        const wordRenderer = import.meta.resolve('@bitclub.ai/opendesk-office/word-renderer');
        const fileActions = new URL('../dist/vendor/apps/docs/src/renderer/file-actions.ts', wordRenderer);
        const actions = await get('/@fs' + fileActions.pathname);
        const workerUrlModule = actions.match(/["']([^"']+\/pdf\.worker\.min\.mjs\?url[^"']*)["']/)?.[1];
        assert.ok(workerUrlModule, 'Word must load its PDF worker through a Vite asset URL');

        const workerUrl = (await get(workerUrlModule)).match(/export default\s+(".*?")[;\n]/)?.[1];
        assert.ok(workerUrl, 'the asset module must export the resolved worker URL');
        assert.match(await get(JSON.parse(workerUrl)), /WorkerMessageHandler/);

        await server.waitForRequestsIdle();
        await Promise.all(Object.values(optimizer.metadata.discovered).map((dependency) => dependency.processing));
        assert.ok(optimizer.metadata.optimized.react, 'Word must receive React from the cold dependency optimizer');
        assert.match(await get('/'), /scripts\/index\.js/);
    } finally {
        await server.close();
    }
}

if (process.argv[2] === '--vite-probe') {
    await verifyColdViteStartup(process.argv[3]);
} else {
    test('the Word PDF worker loads after cold-starting the OpenDesk Vite renderer', { timeout: 70_000 }, async (t) => {
        const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'opendesk-vite-office-'));
        t.after(() => rm(cacheDir, { recursive: true, force: true }));

        // Vite can reject asynchronously from its optimizer. A standalone process
        // makes that rejection fail the test and releases the listening server.
        await promisify(execFile)(
            process.execPath,
            [
                '--unhandled-rejections=strict',
                '--import',
                'tsx',
                fileURLToPath(import.meta.url),
                '--vite-probe',
                cacheDir
            ],
            { timeout: 60_000, signal: t.signal }
        );
    });
}
