import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
test('search worker pushes file changes and preserves startup errors', { timeout: 15000 }, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'od-search-worker-'));
    const services = [];
    t.after(async () => {
        await Promise.all(services.map((service) => service.dispose()));
        await rm(directory, { recursive: true, force: true });
    });
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
    await build({
        entryPoints: {
            service: path.join(root, 'src/main/services/task-search/service.ts'),
            'task-search-worker': path.join(root, 'src/main/services/task-search/worker.ts')
        },
        bundle: true,
        packages: 'external',
        platform: 'node',
        format: 'esm',
        outdir: directory
    });
    const { TaskSearchService } = await import(pathToFileURL(path.join(directory, 'service.js')).href);
    const events = new EventEmitter();
    const errors = [];
    const service = new TaskSearchService(directory, path.join(directory, 'search.sqlite'), {
        onChange: () => events.emit('change'),
        onError: (error) => errors.push(error)
    });
    services.push(service);
    const task = {
        task_id: 'one',
        task_name: '历史任务',
        chat_context: { messages: [{ role: 'user', message_id: 'm1', content: [{ type: 'text', text: '原始正文' }] }] }
    };
    await writeFile(path.join(directory, 'task_list.json'), JSON.stringify([task]));
    await writeFile(path.join(directory, 'one.json'), JSON.stringify(task));
    // Query again only when the worker reports a change; no polling fixture.
    const nextMatch = (query, count) =>
        new Promise((resolve, reject) => {
            let completed = false;
            let chain = Promise.resolve();
            const check = () => {
                chain = chain.then(async () => {
                    if (completed) return;
                    try {
                        const result = await service.search(query, 20);
                        if (!result.indexing && result.items.length === count) {
                            completed = true;
                            events.off('change', check);
                            resolve(result);
                        }
                    } catch (error) {
                        completed = true;
                        events.off('change', check);
                        reject(error);
                    }
                });
            };
            events.on('change', check);
        });
    const initial = nextMatch('原始正文', 1);
    service.start();
    assert.equal((await initial).items[0].messageId, 'm1');
    const updated = nextMatch('更新正文', 1);
    task.chat_context.messages[0].content[0].text = '更新正文';
    await writeFile(path.join(directory, 'one.json'), JSON.stringify(task));
    await updated;
    assert.equal((await service.search('原始正文', 20)).items.length, 0);
    assert.deepEqual(errors, []);
    await service.dispose();

    // A real worker failure must remain diagnosable even before the first query.
    await writeFile(path.join(directory, 'task-search-worker.js'), 'throw new Error("search-startup-sentinel");');
    let reportError;
    const reported = new Promise((resolve) => {
        reportError = resolve;
    });
    const failing = new TaskSearchService(directory, path.join(directory, 'unused.sqlite'), {
        onChange: () => {},
        onError: reportError
    });
    services.push(failing);
    failing.start();
    assert.match((await reported).message, /search-startup-sentinel/);
    await assert.rejects(failing.search('告诉', 20), /search-startup-sentinel/);
});
