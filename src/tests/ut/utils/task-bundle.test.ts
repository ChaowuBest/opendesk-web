import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
    readTaskImportFile,
    writeTaskBundle,
    normalizeImportedTask,
    type TaskImportPreview
} from '../../../main/utils/task-bundle.js';

const task = (id: string, parent: string | null = null) => ({
    task_id: id,
    parent_id: parent,
    task_name: `Task ${id}`,
    task_status: 'stopped',
    chat_context: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
});

function writeTasks(target: string, tasks: ReturnType<typeof task>[]) {
    const byId = new Map(tasks.map((entry) => [entry.task_id, entry]));
    return writeTaskBundle(target, byId.keys(), (id) => byId.get(id)!);
}

describe('task bundle format', () => {
    let dir: string;
    let previews: TaskImportPreview[];
    beforeEach(() => {
        previews = [];
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-task-bundle-'));
    });
    afterEach(async () => {
        await Promise.all(previews.map((preview) => preview.dispose()));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    async function readEntries(file: string) {
        const preview = await readTaskImportFile(file);
        previews.push(preview);
        return preview.entries;
    }

    test('one ZIP preserves relationships and freezes each snapshot before yielding', async () => {
        const target = path.join(dir, 'tasks.zip');
        const tasks = [task('parent'), task('child', 'parent')];
        await writeTaskBundle(target, ['parent', 'child'], (id) => {
            if (id === 'parent') return tasks[0];
            tasks[0].chat_context.messages[0].content[0].text = 'changed after snapshot';
            return tasks[1];
        });
        const entries = await readEntries(target);
        expect(await Promise.all(entries.map((entry) => entry.readJson()))).toEqual([
            task('parent'),
            task('child', 'parent')
        ]);
        const zip = new AdmZip(target);
        expect(JSON.parse(zip.readAsText('manifest.json'))).toMatchObject({
            format: 'opendesk-task-bundle',
            version: 1
        });
    });

    test('accepts old single-task JSON and rejects ZIPs containing malformed tasks', async () => {
        const legacy = path.join(dir, 'legacy.json');
        fs.writeFileSync(legacy, JSON.stringify(task('old')));
        expect((await readEntries(legacy))[0].id).toBe('old');
        const target = path.join(dir, 'mixed.zip');
        await writeTasks(target, [task('good'), task('bad')]);
        const zip = new AdmZip(target);
        zip.updateFile('tasks/bad.json', Buffer.from('{broken'));
        zip.writeZip(target);
        await expect(readTaskImportFile(target)).rejects.toThrow('invalidTask');
    });

    test('rejects unknown versions, duplicate task IDs, and unsafe manifest paths', async () => {
        for (const manifest of [
            { format: 'opendesk-task-bundle', version: 99, tasks: [] },
            { format: 'opendesk-task-bundle', version: 1, tasks: [{ id: 'a', path: '../a.json' }] },
            {
                format: 'opendesk-task-bundle',
                version: 1,
                tasks: [
                    { id: 'a', path: 'tasks/a.json' },
                    { id: 'a', path: 'tasks/a.json' }
                ]
            }
        ]) {
            const zip = new AdmZip();
            zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
            const target = path.join(dir, 'invalid.zip');
            zip.writeZip(target);
            await expect(readTaskImportFile(target)).rejects.toThrow();
        }
    });

    test('round-trips a task beyond the former per-task limit as ZIP and JSON', async () => {
        const target = path.join(dir, 'large.zip');
        const json = task('large');
        json.chat_context.messages[0].content[0].text = 'x'.repeat(17 * 1024 * 1024);
        await writeTasks(target, [json]);
        expect((await readEntries(target))[0].messageCount).toBe(1);
        const legacy = path.join(dir, 'large.json');
        fs.writeFileSync(legacy, JSON.stringify(json));
        expect((await readEntries(legacy))[0].messageCount).toBe(1);
    }, 30000);

    test('reads more than 1,000 tasks from the snapshot even after the source ZIP is removed', async () => {
        const target = path.join(dir, 'many.zip');
        const tasks = Array.from({ length: 1001 }, (_, index) => task(`task-${index}`));
        await writeTasks(target, tasks);
        const entries = await readEntries(target);
        expect(entries).toHaveLength(tasks.length);
        fs.unlinkSync(target);
        expect(await entries.at(-1)!.readJson()).toEqual(tasks.at(-1));
    }, 30000);

    test.each(['deflate', 'crc', 'declared size', 'truncated'] as const)(
        'classifies %s damage as ZIP corruption',
        async (kind) => {
            const target = path.join(dir, 'damaged.zip');
            const entryPath = 'tasks/a.json';
            const zip = new AdmZip();
            const manifest = { format: 'opendesk-task-bundle', version: 1, tasks: [{ id: 'a', path: entryPath }] };
            zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
            zip.addFile(entryPath, Buffer.from(JSON.stringify(task('a'))));

            const bytes = zip.toBuffer();
            const name = Buffer.from(entryPath);
            const central = bytes.lastIndexOf(name) - 46;
            const local = bytes.readUInt32LE(central + 42);
            if (kind === 'deflate') {
                const data = local + 30 + name.length + bytes.readUInt16LE(local + 28);
                bytes[data] = (bytes[data] & 0xf8) | 0x07;
            } else if (kind === 'crc') {
                bytes.writeUInt32LE(0, central + 16);
            } else if (kind === 'declared size') {
                bytes.writeUInt32LE(10, central + 24);
                bytes.writeUInt32LE(10, local + 22);
            }

            fs.writeFileSync(target, kind === 'truncated' ? bytes.subarray(0, -20) : bytes);
            await expect(readTaskImportFile(target)).rejects.toMatchObject({ code: 'corruptArchive' });
        }
    );

    test('rejects cyclic parent relationships', async () => {
        const target = path.join(dir, 'cycle.zip');
        await writeTasks(target, [task('one', 'two'), task('two', 'one')]);
        await expect(readTaskImportFile(target)).rejects.toThrow('invalidTask');
    });

    test('normalizes IDs and runtime state without rewriting message text', () => {
        const source = {
            ...task('parent'),
            task_status: 'running',
            workspace: '/old/work',
            executionNodeId: 'remote',
            origin: { channel: 'external' },
            internal: true,
            goal_state: { taskId: 'parent', status: 'active', schedulerLease: { owner: 'old' } }
        };
        const copy = normalizeImportedTask(source, new Map([['parent', 'new-id']]), '/new/work');
        expect(copy).toMatchObject({
            task_id: 'new-id',
            parent_id: null,
            task_status: 'stopped',
            workspace: '/new/work'
        });
        expect(copy.executionNodeId).toBeUndefined();
        expect(copy.origin).toBeUndefined();
        expect(copy.internal).toBeUndefined();
        expect(copy.goal_state).toMatchObject({ taskId: 'new-id', status: 'paused' });
        expect(copy.goal_state.schedulerLease).toBeUndefined();
        expect(copy.chat_context.messages[0].content).toEqual(source.chat_context.messages[0].content);
        expect(source.task_id).toBe('parent');
    });

    test('rebuilds task, message and internal metadata timestamps while preserving order and payloads', () => {
        const old = '2020-01-01T00:00:00.000Z';
        const later = '2020-01-02T00:00:00.000Z';
        const payload = { task_id: 'parent', timestamp: old };
        const source = {
            ...task('parent'),
            created_at: old,
            updated_at: later,
            started_at: old,
            finished_at: later,
            chat_context: {
                messages: [
                    { role: 'user', timestamp: Date.parse(old), content: [{ type: 'text', text: old }] },
                    {
                        role: 'assistant',
                        timestamp: Date.parse(later),
                        metadata: { taskId: 'parent', occurredAt: later },
                        content: [{ type: 'tool_call', toolcalls: [{ args_object: payload, result_object: payload }] }]
                    }
                ]
            },
            goal_state: { taskId: 'parent', status: 'active', createdAt: old, updatedAt: later },
            goal_event_log: { mode: 'inline', events: [{ taskId: 'parent', timestamp: old }] },
            auto_compact_state: { last_success_at: later },
            benchmark_usage: { task_id: 'parent', generated_at: later }
        };
        const before = Date.now();
        const copy = normalizeImportedTask(source, new Map([['parent', 'new']]), '/chosen');
        expect(Date.parse(copy.created_at)).toBeGreaterThanOrEqual(before - 100);
        expect(Date.parse(copy.updated_at)).toBeLessThanOrEqual(Date.now());
        expect(Date.parse(copy.started_at)).toBeLessThan(Date.parse(copy.finished_at));
        const [first, second] = copy.chat_context.messages;
        expect(first.timestamp).toBeGreaterThanOrEqual(Date.parse(copy.created_at));
        expect(first.timestamp).toBeLessThan(second.timestamp);
        expect(second.timestamp).toBeLessThanOrEqual(Date.parse(copy.updated_at));
        expect(first.content[0].text).toBe(old);
        expect(second.content[0].toolcalls[0]).toEqual({ args_object: payload, result_object: payload });
        expect(second.metadata.taskId).toBe('new');
        expect(second.metadata.occurredAt).not.toBe(later);
        expect(copy.goal_state.createdAt).not.toBe(old);
        expect(copy.goal_event_log.events[0]).toMatchObject({ taskId: 'new' });
        expect(copy.goal_event_log.events[0].timestamp).not.toBe(old);
        expect(copy.auto_compact_state.last_success_at).not.toBe(later);
        expect(copy.benchmark_usage.generated_at).not.toBe(later);
        expect(source.created_at).toBe(old);
        expect(source.chat_context.messages[0].timestamp).toBe(Date.parse(old));
    });
});
