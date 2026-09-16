import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { readTaskImportFile, writeTaskBundle, normalizeImportedTask } from '../../../main/utils/task-bundle.js';

const task = (id: string, parent: string | null = null) => ({
    task_id: id,
    parent_id: parent,
    task_name: `Task ${id}`,
    task_status: 'stopped',
    chat_context: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
});

describe('task bundle format', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-task-bundle-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('one ZIP preserves relationships and freezes each snapshot before yielding', async () => {
        const target = path.join(dir, 'tasks.zip');
        const tasks = [task('parent'), task('child', 'parent')];
        await writeTaskBundle(target, tasks, (done) => {
            if (done === 1) tasks[0].chat_context.messages[0].content[0].text = 'changed after snapshot';
        });
        const entries = await readTaskImportFile(target);
        expect(entries.map((entry) => entry.json)).toEqual([task('parent'), task('child', 'parent')]);
        const zip = new AdmZip(target);
        expect(JSON.parse(zip.readAsText('manifest.json'))).toMatchObject({
            format: 'opendesk-task-bundle',
            version: 1
        });
    });

    test('accepts old single-task JSON and isolates malformed task entries in a ZIP', async () => {
        const legacy = path.join(dir, 'legacy.json');
        fs.writeFileSync(legacy, JSON.stringify(task('old')));
        expect((await readTaskImportFile(legacy))[0].json.task_id).toBe('old');
        const target = path.join(dir, 'mixed.zip');
        await writeTaskBundle(target, [task('good'), task('bad')]);
        const zip = new AdmZip(target);
        zip.updateFile('tasks/bad.json', Buffer.from('{broken'));
        zip.writeZip(target);
        const entries = await readTaskImportFile(target);
        expect(entries[0].json.task_id).toBe('good');
        expect(entries[1].error).toBe('invalidTask');
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

    test('rejects oversized exports without creating a partial output', async () => {
        const target = path.join(dir, 'large.zip');
        const json = task('large');
        json.chat_context.messages[0].content[0].text = 'x'.repeat(17 * 1024 * 1024);
        await expect(writeTaskBundle(target, [json])).rejects.toThrow('tooLarge');
        expect(fs.existsSync(target)).toBe(false);
    });

    test('bounds actual inflation even when ZIP size headers lie', async () => {
        const zip = new AdmZip();
        zip.addFile(
            'manifest.json',
            Buffer.from(
                JSON.stringify({
                    format: 'opendesk-task-bundle',
                    version: 1,
                    tasks: [{ id: 'large', path: 'tasks/large.json' }]
                })
            )
        );
        zip.addFile('tasks/large.json', Buffer.from('x'.repeat(17 * 1024 * 1024)));
        const bytes = zip.toBuffer();
        for (let offset = 0; offset < bytes.length - 46; offset++) {
            if (bytes.readUInt32LE(offset) === 0x02014b50) {
                const length = bytes.readUInt16LE(offset + 28);
                if (bytes.subarray(offset + 46, offset + 46 + length).toString() === 'tasks/large.json') {
                    const local = bytes.readUInt32LE(offset + 42);
                    bytes.writeUInt32LE(10, offset + 24);
                    bytes.writeUInt32LE(10, local + 22);
                    break;
                }
            }
        }
        const target = path.join(dir, 'forged.zip');
        fs.writeFileSync(target, bytes);
        await expect(readTaskImportFile(target)).rejects.toThrow('tooLarge');
    });

    test('invalidates damaged families and cyclic parents but keeps unrelated tasks usable', async () => {
        const target = path.join(dir, 'family.zip');
        await writeTaskBundle(target, [task('parent'), task('child', 'parent'), task('healthy')]);
        const zip = new AdmZip(target);
        zip.updateFile('tasks/child.json', Buffer.from('{broken'));
        zip.writeZip(target);
        const entries = await readTaskImportFile(target);
        expect(entries.filter((entry) => entry.error).map((entry) => entry.id)).toEqual(['parent', 'child']);
        expect(entries[2].json.task_id).toBe('healthy');
        await writeTaskBundle(target, [task('one', 'two'), task('two', 'one')]);
        expect((await readTaskImportFile(target)).every((entry) => entry.error)).toBe(true);
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
