import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';

/**
 * 手写最小 ZIP（store 方法、无 extra/comment）：AdmZip / yazl 都会拒绝或规范化
 * 非法条目名（..、反斜杠），要原样构造它们必须绕开两者的写入校验。
 */
function buildRawZip(entries: { name: string; data: Buffer }[]): Buffer {
    const chunks: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const checksum = zlib.crc32(data) >>> 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0x21, 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        chunks.push(local, nameBuf, data);
        const directory = Buffer.alloc(46);
        directory.writeUInt32LE(0x02014b50, 0);
        directory.writeUInt16LE(20, 4);
        directory.writeUInt16LE(20, 6);
        directory.writeUInt16LE(0, 8);
        directory.writeUInt16LE(0, 10);
        directory.writeUInt16LE(0, 12);
        directory.writeUInt16LE(0x21, 14);
        directory.writeUInt32LE(checksum, 16);
        directory.writeUInt32LE(data.length, 20);
        directory.writeUInt32LE(data.length, 24);
        directory.writeUInt16LE(nameBuf.length, 28);
        directory.writeUInt32LE(offset, 42);
        central.push(directory, nameBuf);
        offset += local.length + nameBuf.length + data.length;
    }
    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, centralBuf, eocd]);
}
import {
    readTaskImportFile,
    writeTaskBundle,
    normalizeImportedTask,
    type TaskImportPreview
} from '../../../main/utils/task-bundle.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { exportTaskBundle } from '../../../main/aikernel/task/transfer.js';

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

describe('task bundle artifacts (v2)', () => {
    let dir: string;
    let dataDir: string;
    let previews: TaskImportPreview[];
    beforeEach(() => {
        previews = [];
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-task-bundle-art-'));
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-task-bundle-data-'));
        setCustomOpendeskDirectory(dataDir);
    });
    afterEach(async () => {
        await Promise.all(previews.map((preview) => preview.dispose()));
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    async function readPreview(file: string) {
        const preview = await readTaskImportFile(file);
        previews.push(preview);
        return preview;
    }

    test('carries artifact files in a v2 bundle and restores them under the new task id', async () => {
        const imageBytes = Buffer.from('fake-png-bytes-0123456789');
        const toolResultText = 'original tool output line\n'.repeat(64);
        const imageDir = path.join(dir, 'src-artifacts', 'a', 'images');
        fs.mkdirSync(imageDir, { recursive: true });
        fs.writeFileSync(path.join(imageDir, 'img-hash.png'), imageBytes);
        const toolResultDir = path.join(dir, 'src-artifacts', 'a', 'tool-results');
        fs.mkdirSync(toolResultDir, { recursive: true });
        fs.writeFileSync(path.join(toolResultDir, 'result-1.txt'), toolResultText, 'utf8');

        const target = path.join(dir, 'with-artifacts.zip');
        await writeTaskBundle(target, ['a'], () => task('a'), [
            { entryName: 'artifacts/a/images/img-hash.png', diskPath: path.join(imageDir, 'img-hash.png') },
            {
                entryName: 'artifacts/a/tool-results/result-1.txt',
                diskPath: path.join(toolResultDir, 'result-1.txt')
            }
        ]);
        const zip = new AdmZip(target);
        expect(JSON.parse(zip.readAsText('manifest.json'))).toMatchObject({
            format: 'opendesk-task-bundle',
            version: 2
        });
        expect(zip.getEntry('artifacts/a/images/img-hash.png')).toBeDefined();
        expect(zip.getEntry('artifacts/a/tool-results/result-1.txt')).toBeDefined();

        const preview = await readPreview(target);
        expect(preview.entries.map((entry) => entry.id)).toEqual(['a']);
        const summary = await preview.restoreArtifacts(new Map([['a', 'new-task-id']]));
        expect(summary).toEqual({ restored: 2, failed: 0 });
        expect(fs.readFileSync(path.join(dataDir, 'artifacts', 'new-task-id', 'images', 'img-hash.png'))).toEqual(
            imageBytes
        );
        expect(
            fs.readFileSync(path.join(dataDir, 'artifacts', 'new-task-id', 'tool-results', 'result-1.txt'), 'utf8')
        ).toBe(toolResultText);
        // 未勾选的任务其 artifacts 条目被跳过
        const skipped = await preview.restoreArtifacts(new Map());
        expect(skipped).toEqual({ restored: 0, failed: 0 });
    });

    test('an artifact-less export keeps the v1 manifest for cross-version compatibility', async () => {
        const target = path.join(dir, 'plain.zip');
        await writeTaskBundle(target, ['a'], () => task('a'));
        const zip = new AdmZip(target);
        expect(JSON.parse(zip.readAsText('manifest.json'))).toMatchObject({ version: 1 });
    });

    test('export skips unsafe artifact entry names instead of failing the whole bundle', async () => {
        // 不合规名只可能来自人工放进 artifacts 目录的文件（非 ASCII/空格等）：
        // 跳过并告警，不能因单个文件让整个导出失败；导入端白名单同样会拒绝这类条目
        const target = path.join(dir, 'skip-unsafe.zip');
        await writeTaskBundle(target, ['a'], () => task('a'), [
            { entryName: 'artifacts/a/images/截图 1.png', diskPath: path.join(dir, 'never-read.png') }
        ]);
        const zip = new AdmZip(target);
        expect(zip.getEntry('artifacts/a/images/截图 1.png')).toBeNull();
        // 空条目的 targets 仍需完整可导入
        const preview = await readPreview(target);
        expect(preview.entries.map((entry) => entry.id)).toEqual(['a']);
    });

    test('rejects v1 bundles that carry artifact entries and artifacts of unknown tasks', async () => {
        const manifest = (version: number) => ({
            format: 'opendesk-task-bundle',
            version,
            tasks: [{ id: 'a', path: 'tasks/a.json' }]
        });
        const build = (version: number, artifactName: string) => {
            const zip = new AdmZip();
            zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest(version))));
            zip.addFile('tasks/a.json', Buffer.from(JSON.stringify(task('a'))));
            zip.addFile(artifactName, Buffer.from('payload'));
            const target = path.join(dir, `v${version}-${artifactName.replace(/[^\w]+/g, '_')}.zip`);
            zip.writeZip(target);
            return target;
        };
        // v1 不允许 artifacts 条目（落入 leftover 检查 → invalidBundle）
        await expect(readPreview(build(1, 'artifacts/a/images/x.png'))).rejects.toThrow('invalidBundle');
        // artifacts 条目归属 manifest 未声明的任务 → invalidBundle
        await expect(readPreview(build(2, 'artifacts/unknown/images/x.png'))).rejects.toThrow('invalidBundle');
    });

    test('rejects artifact entries with traversal, hidden, or backslash names', async () => {
        // AdmZip / yazl 都会拒绝或规范化非法条目名，这里手写原始 ZIP 字节（store 方法）
        // 原样落条目，直接打在 indexArchive 的白名单边界上
        const manifest = {
            format: 'opendesk-task-bundle',
            version: 2,
            tasks: [{ id: 'a', path: 'tasks/a.json' }]
        };
        for (const artifactName of [
            'artifacts/a/../x.png',
            'artifacts/a/images/.hidden.png',
            'artifacts\\a\\images\\x.png',
            'artifacts/a/images/sub/../x.png',
            // Win32 归一化边界：保留设备名会被解析为设备、段尾 `.` 会被静默剥离成另一个文件
            'artifacts/a/images/CON',
            'artifacts/a/images/nul.png',
            'artifacts/a/images/x.',
            'artifacts/a/images/LPT1.txt'
        ]) {
            const target = path.join(dir, `unsafe-${artifactName.replace(/[^\w]+/g, '_')}.zip`);
            fs.writeFileSync(
                target,
                buildRawZip([
                    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
                    { name: 'tasks/a.json', data: Buffer.from(JSON.stringify(task('a'))) },
                    { name: artifactName, data: Buffer.from('payload') }
                ])
            );
            await expect(readTaskImportFile(target)).rejects.toThrow('invalidBundle');
        }
    });

    test('re-zipped bundles that carry directory entries still import', async () => {
        // 用户把 bundle 解开后用系统/第三方工具重新打包会写入目录条目（zip -r、资源
        // 管理器、macOS 归档）。目录条目没有内容，应按白名单前缀校验后丢弃，不能拒绝整包
        const manifest = {
            format: 'opendesk-task-bundle',
            version: 2,
            tasks: [{ id: 'a', path: 'tasks/a.json' }]
        };
        const target = path.join(dir, 'with-directories.zip');
        fs.writeFileSync(
            target,
            buildRawZip([
                { name: 'tasks/', data: Buffer.alloc(0) },
                { name: 'artifacts/', data: Buffer.alloc(0) },
                { name: 'artifacts/a/', data: Buffer.alloc(0) },
                { name: 'artifacts/a/images/', data: Buffer.alloc(0) },
                { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
                { name: 'tasks/a.json', data: Buffer.from(JSON.stringify(task('a'))) },
                { name: 'artifacts/a/images/x.png', data: Buffer.from('pixel-bytes') }
            ])
        );
        const preview = await readPreview(target);
        expect(preview.entries.map((entry) => entry.id)).toEqual(['a']);
        const summary = await preview.restoreArtifacts(new Map([['a', 'new-task-id']]));
        expect(summary).toEqual({ restored: 1, failed: 0 });
        expect(fs.readFileSync(path.join(dataDir, 'artifacts', 'new-task-id', 'images', 'x.png'), 'utf8')).toBe(
            'pixel-bytes'
        );
    });

    test('export surfaces artifact enumeration errors instead of silently exporting without artifacts', async () => {
        // artifacts/<id> 位置被一个普通文件占位：readdir 抛 ENOTDIR。必须让导出失败，
        // 不能静默降级成无产物的 v1 包——任务 JSON 里已压缩条目的原文已被剥离，
        // 导入端既无 artifacts 也无 result，原文将永久丢失
        const blockingPath = path.join(dataDir, 'artifacts', 'enum-fail');
        fs.mkdirSync(path.dirname(blockingPath), { recursive: true });
        fs.writeFileSync(blockingPath, 'not a directory');
        const manager = {
            tasks: [
                {
                    task_id: 'enum-fail',
                    parent_id: null,
                    _corrupted: false,
                    _fullyLoaded: true,
                    toJSON: () => task('enum-fail')
                }
            ]
        } as unknown as import('../../../main/aikernel/task/manager.js').TaskManagerState;
        await expect(exportTaskBundle(manager, ['enum-fail'], path.join(dir, 'enum-fail.zip'))).rejects.toThrow();
    });

    test('normalizeImportedTask rewrites artifact relative paths into the new task namespace', () => {
        const source = task('a') as Record<string, any>;
        source.chat_context.messages.push({
            role: 'assistant',
            timestamp: '2026-01-01T00:00:00.000Z',
            content: [
                {
                    type: 'tool_call',
                    toolcalls: [
                        {
                            id: 'call-1',
                            index: 0,
                            tool_name: 'browser-screenshot',
                            args_string: '{"path":"/tmp/x"}',
                            args_object: { path: '/tmp/x', relative_path: 'artifacts\\a\\images\\keep-args.txt' },
                            result_storage: {
                                result_id: 'result-1',
                                relative_path: 'artifacts\\a\\tool-results\\result-1.txt'
                            },
                            result_object: {
                                type: 'image',
                                images: [
                                    {
                                        image_url: 'data:image/png;base64,thumb',
                                        media_type: 'image/png',
                                        externalized: {
                                            version: 1,
                                            relative_path: 'artifacts\\a\\images\\img-hash.png'
                                        }
                                    }
                                ]
                            }
                        }
                    ]
                }
            ]
        });
        source.tool_result_replacement_state = {
            replacements: {
                'result-1': { result_id: 'result-1', relative_path: 'artifacts\\a\\tool-results\\result-1.txt' }
            }
        };

        const ids = new Map([['a', 'new-task-id']]);
        const imported = normalizeImportedTask(source, ids, '/new/work');
        const importedCall = imported.chat_context.messages[1].content[0].toolcalls[0];
        const native = (...segments: string[]) => path.join('artifacts', 'new-task-id', ...segments);
        expect(importedCall.result_storage.relative_path).toBe(native('tool-results', 'result-1.txt'));
        expect(importedCall.result_object.images[0].externalized.relative_path).toBe(native('images', 'img-hash.png'));
        // 工具参数是用户载荷，保持原样
        expect(importedCall.args_object.relative_path).toBe('artifacts\\a\\images\\keep-args.txt');
        expect(imported.tool_result_replacement_state.replacements['result-1'].relative_path).toBe(
            native('tool-results', 'result-1.txt')
        );

        // 非本任务前缀的路径原样保留（无请求期读盘消费方）
        const foreignSource = task('a') as Record<string, any>;
        foreignSource.chat_context.messages.push({
            role: 'assistant',
            timestamp: '2026-01-01T00:00:00.000Z',
            content: [
                {
                    type: 'tool_call',
                    toolcalls: [
                        {
                            id: 'call-2',
                            index: 0,
                            tool_name: 'filemgr-readFile',
                            result_storage: { result_id: 'result-2', relative_path: 'artifacts\\other\\keep.txt' },
                            result_object: {
                                type: 'image',
                                images: [
                                    {
                                        image_url: 'data:image/png;base64,thumb',
                                        externalized: { version: 1, relative_path: 'artifacts\\other\\images\\x.png' }
                                    },
                                    {
                                        image_url: 'data:image/png;base64,thumb',
                                        externalized: {
                                            version: 1,
                                            relative_path: 'artifacts\\other\\tool-results\\x.txt'
                                        }
                                    }
                                ]
                            }
                        }
                    ]
                }
            ]
        });
        const foreign = normalizeImportedTask(foreignSource, ids, '/new/work');
        expect(foreign.chat_context.messages[1].content[0].toolcalls[0].result_storage.relative_path).toBe(
            'artifacts\\other\\keep.txt'
        );
        const foreignImages = foreign.chat_context.messages[1].content[0].toolcalls[0].result_object.images;
        // 跨任务 images 引用被清洗：否则恶意导入包可借无 taskId 的宽松回灌路径读出
        // 本机其他任务的图片发给模型服务；工具结果原文目录的跨任务引用不受影响
        expect(foreignImages[0].externalized).toBeUndefined();
        expect(foreignImages[0].image_url).toBe('data:image/png;base64,thumb');
        expect(foreignImages[1].externalized.relative_path).toBe('artifacts\\other\\tool-results\\x.txt');
    });

    test('normalizeImportedTask rewrites structured artifact references and keeps legacy text untouched', () => {
        // 新格式：存储层只有「结构化预览 + 相对路径」。导入时改写结构化路径字段即可，
        // 预览不含路径、原样保留；模型可见文本在读取时按当前数据根重新渲染
        const source = task('a') as Record<string, any>;
        source.chat_context.messages.push({
            role: 'assistant',
            timestamp: '2026-01-01T00:00:00.000Z',
            content: [
                {
                    type: 'tool_call',
                    toolcalls: [
                        {
                            id: 'call-3',
                            index: 0,
                            tool_name: 'filemgr-readFile',
                            result_storage: {
                                result_id: 'result-3',
                                relative_path: 'artifacts\\a\\tool-results\\result-1.txt',
                                replacement_preview: '输出预览'
                            },
                            microcompact: {
                                strategy: 'local_clear',
                                cleared_at: '2026-01-01T00:00:00.000Z',
                                original_chars: 100,
                                original_lines: 3
                            }
                        },
                        {
                            id: 'call-legacy',
                            index: 1,
                            tool_name: 'web_search',
                            result_storage: {
                                result_id: 'result-legacy',
                                relative_path: 'artifacts\\a\\tool-results\\result-legacy.txt',
                                replacement_text:
                                    '完整输出已保存至: D:\\source-machine\\artifacts\\a\\tool-results\\result-legacy.txt'
                            }
                        }
                    ]
                }
            ]
        });
        source.tool_result_replacement_state = {
            replacements: {
                'result-3': {
                    result_id: 'result-3',
                    replacement_preview: '输出预览',
                    relative_path: 'artifacts\\a\\tool-results\\result-1.txt'
                }
            }
        };

        const imported = normalizeImportedTask(source, new Map([['a', 'new-task-id']]), '/new/work');
        const calls = imported.chat_context.messages[1].content[0].toolcalls;
        const native = (...segments: string[]) => path.join('artifacts', 'new-task-id', ...segments);
        // 结构化路径字段改写；预览不含路径、原样保留
        expect(calls[0].result_storage.relative_path).toBe(native('tool-results', 'result-1.txt'));
        expect(calls[0].result_storage.replacement_preview).toBe('输出预览');
        expect(imported.tool_result_replacement_state.replacements['result-3'].relative_path).toBe(
            native('tool-results', 'result-1.txt')
        );
        expect(imported.tool_result_replacement_state.replacements['result-3'].replacement_preview).toBe('输出预览');
        // 旧自由文本原样保留（跨机导入后其中源机路径不可用是已接受的降级：不报错、不改写）
        expect(calls[1].result_storage.replacement_text).toBe(
            '完整输出已保存至: D:\\source-machine\\artifacts\\a\\tool-results\\result-legacy.txt'
        );
        expect(calls[1].result_storage.relative_path).toBe(native('tool-results', 'result-legacy.txt'));
    });

    test('legacy absolute-path text imports without errors or corruption, only structured paths are rewritten', () => {
        // 老格式（内嵌源机绝对路径的自由文本）：导入端**不改写也不解析**文本——
        // 拿不到本机正确路径是可接受的降级，但绝不抛错、不破坏文本。
        // 覆盖容易踩坑的根路径：空格、`$`、中文、正反斜杠混排，引用重复出现，
        // 以及文本里完全没有引用的情况
        const weirdRoot = 'C:\\Program Files\\$OpenDesk$\\任务 资料';
        const sourceRelative = 'artifacts\\a\\tool-results\\result-9.txt';
        const embedded = `${weirdRoot}\\${sourceRelative}`;
        const legacyText = `预览引用一次: ${embedded}\n重复引用: ${embedded}`;
        const source = task('a') as Record<string, any>;
        source.chat_context.messages.push({
            role: 'assistant',
            timestamp: '2026-01-01T00:00:00.000Z',
            content: [
                {
                    type: 'tool_call',
                    toolcalls: [
                        {
                            id: 'call-legacy-robust',
                            index: 0,
                            tool_name: 'filemgr-readFile',
                            result_storage: {
                                result_id: 'result-legacy-robust',
                                relative_path: sourceRelative,
                                replacement_text: legacyText
                            }
                        },
                        {
                            id: 'call-legacy-no-ref',
                            index: 1,
                            tool_name: 'web_search',
                            result_storage: {
                                result_id: 'result-legacy-no-ref',
                                relative_path: 'artifacts/a/tool-results/no-ref.txt',
                                replacement_text: '纯文本预览，没有任何产物引用'
                            }
                        }
                    ]
                }
            ]
        });

        const imported = normalizeImportedTask(source, new Map([['a', 'new-task-id']]), '/new/work');
        const calls = imported.chat_context.messages[1].content[0].toolcalls;
        // 旧文本逐字节不变（含重复引用与特殊字符），不抛错
        expect(calls[0].result_storage.replacement_text).toBe(legacyText);
        expect(calls[1].result_storage.replacement_text).toBe('纯文本预览，没有任何产物引用');
        // 结构化路径字段仍然正确改写
        expect(calls[0].result_storage.relative_path).toBe(
            path.join('artifacts', 'new-task-id', 'tool-results', 'result-9.txt')
        );
        expect(calls[1].result_storage.relative_path).toBe(
            path.join('artifacts', 'new-task-id', 'tool-results', 'no-ref.txt')
        );
    });

    test('normalizeImportedTask never rewrites payload keys named like artifact fields', () => {
        // 工具参数是用户载荷：args_object 中恰好叫 replacement_text / artifact_path_hint
        // 的字符串字段不得被导入改写逻辑误伤；协议字段（result_storage.relative_path）正常改写
        const source = task('a') as Record<string, any>;
        source.chat_context.messages.push({
            role: 'assistant',
            timestamp: '2026-01-01T00:00:00.000Z',
            content: [
                {
                    type: 'tool_call',
                    toolcalls: [
                        {
                            id: 'call-args',
                            index: 0,
                            tool_name: 'filemgr-readFile',
                            args_string: '{"note":"see artifacts\\\\a\\\\tool-results\\\\x.txt"}',
                            args_object: {
                                note: 'see artifacts\\a\\tool-results\\x.txt',
                                replacement_text: '完整输出已保存至: C:\\src\\artifacts\\a\\tool-results\\y.txt',
                                artifact_path_hint: 'artifacts/a/tool-results/z.txt'
                            },
                            result_storage: {
                                result_id: 'result-args',
                                relative_path: 'artifacts\\a\\tool-results\\result-1.txt',
                                replacement_text: '完整输出已保存至: C:\\src\\artifacts\\a\\tool-results\\result-1.txt'
                            }
                        }
                    ]
                }
            ]
        });

        const imported = normalizeImportedTask(source, new Map([['a', 'new-task-id']]), '/new/work');
        const importedCall = imported.chat_context.messages[1].content[0].toolcalls[0];
        // 载荷原样保留
        expect(importedCall.args_object.note).toBe('see artifacts\\a\\tool-results\\x.txt');
        expect(importedCall.args_object.replacement_text).toBe(
            '完整输出已保存至: C:\\src\\artifacts\\a\\tool-results\\y.txt'
        );
        expect(importedCall.args_object.artifact_path_hint).toBe('artifacts/a/tool-results/z.txt');
        expect(importedCall.args_string).toContain('artifacts\\\\a\\\\tool-results\\\\x.txt');
        // 协议字段：结构化路径改写；旧自由文本原样保留
        expect(importedCall.result_storage.relative_path).toBe(
            path.join('artifacts', 'new-task-id', 'tool-results', 'result-1.txt')
        );
        expect(importedCall.result_storage.replacement_text).toBe(
            '完整输出已保存至: C:\\src\\artifacts\\a\\tool-results\\result-1.txt'
        );
    });

    test('normalizeImportedTask drops traversal and absolute artifact paths from imported JSON', () => {
        // 安全（路径穿越防护）：relative_path 随任务 JSON 持久化，恶意包可构造指向
        // 数据根之外的指针；导入时必须丢弃而非原样落地，下游回退缩略图/替代文本
        const source = task('a') as Record<string, any>;
        source.chat_context.messages.push({
            role: 'assistant',
            timestamp: '2026-01-01T00:00:00.000Z',
            content: [
                {
                    type: 'tool_call',
                    toolcalls: [
                        {
                            id: 'call-evil',
                            index: 0,
                            tool_name: 'browser-screenshot',
                            result_storage: { result_id: 'result-evil', relative_path: '../../../../etc/passwd' },
                            result_object: {
                                type: 'image',
                                images: [
                                    {
                                        image_url: 'data:image/png;base64,thumb',
                                        externalized: { version: 1, relative_path: 'D:\\evil\\secret.png' }
                                    },
                                    {
                                        image_url: 'data:image/png;base64,thumb',
                                        externalized: { version: 1, relative_path: 'artifacts\\a\\..\\..\\x.png' }
                                    }
                                ]
                            }
                        }
                    ]
                }
            ]
        });

        const imported = normalizeImportedTask(source, new Map([['a', 'new-task-id']]), '/new/work');
        const importedCall = imported.chat_context.messages[1].content[0].toolcalls[0];
        // 穿越与绝对路径被删除（而非改写或保留）；marker 只剩空壳时整字段移除
        expect(importedCall.result_storage.relative_path).toBeUndefined();
        expect(importedCall.result_object.images[0].externalized).toBeUndefined();
        expect(importedCall.result_object.images[1].externalized).toBeUndefined();
        // 合法字段不受影响
        expect(importedCall.result_storage.result_id).toBe('result-evil');
        expect(importedCall.result_object.images[0].image_url).toBe('data:image/png;base64,thumb');
    });
});
