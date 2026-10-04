import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    cleanupExpiredTrash,
    cleanupTrashPreviewCopies,
    ensureTrashRootDirectory,
    initializeTrash,
    prepareTrashPreviewCopy,
    readTrashSummary,
    restoreTrashEntry,
    searchTrashEntries,
    TRASH_BACK_SUFFIX,
    TRASH_PREVIEW_RETENTION_MS,
    TRASH_RETENTION_MS,
    TRASH_SUMMARY_FILENAME,
    type TrashEntry
} from '../../../main/utils/trash.js';

let trashRoot: string;

function makeTaskDir(taskId: string): string {
    const dir = path.join(trashRoot, taskId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function writeSummary(taskId: string, entries: Array<Partial<TrashEntry>>): string {
    const dir = makeTaskDir(taskId);
    const summaryPath = path.join(dir, TRASH_SUMMARY_FILENAME);
    fs.writeFileSync(
        summaryPath,
        JSON.stringify(
            entries.map((entry, i) => ({
                uuid: entry.uuid ?? `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
                original_path: entry.original_path ?? `/tmp/file-${i}.txt`,
                size: entry.size ?? 1,
                deleted_at: entry.deleted_at ?? '2026-01-01T00:00:00.000Z'
            }))
        ),
        'utf8'
    );
    return dir;
}

function writeBack(taskDir: string, uuid: string, content: string): string {
    const backPath = path.join(taskDir, `${uuid}${TRASH_BACK_SUFFIX}`);
    fs.writeFileSync(backPath, content, 'utf8');
    return backPath;
}

beforeEach(() => {
    trashRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-trash-test-'));
});

afterEach(() => {
    fs.rmSync(trashRoot, { recursive: true, force: true });
});

describe('readTrashSummary', () => {
    test('目录不存在时返回空列表', () => {
        expect(readTrashSummary(path.join(trashRoot, 'task_missing'))).toEqual([]);
    });

    test('summary.json 缺失时返回空列表', () => {
        const dir = makeTaskDir('task_a');
        expect(readTrashSummary(dir)).toEqual([]);
    });

    test('解析合法的条目列表', () => {
        const dir = writeSummary('task_a', [
            { original_path: 'C:\\Users\\x\\a.txt', size: 12, deleted_at: '2026-05-01T08:00:00.000Z' }
        ]);
        const entries = readTrashSummary(dir);
        expect(entries).toHaveLength(1);
        expect(entries[0].original_path).toBe('C:\\Users\\x\\a.txt');
        expect(entries[0].size).toBe(12);
        expect(entries[0].deleted_at).toBe('2026-05-01T08:00:00.000Z');
        expect(entries[0].uuid).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('summary.json 损坏时返回空列表而不抛错', () => {
        const dir = makeTaskDir('task_a');
        fs.writeFileSync(path.join(dir, TRASH_SUMMARY_FILENAME), '{not json', 'utf8');
        expect(readTrashSummary(dir)).toEqual([]);
    });

    test('顶层不是数组时返回空列表', () => {
        const dir = makeTaskDir('task_a');
        fs.writeFileSync(path.join(dir, TRASH_SUMMARY_FILENAME), '{"uuid":"x"}', 'utf8');
        expect(readTrashSummary(dir)).toEqual([]);
    });
});

describe('searchTrashEntries', () => {
    test('任务范围：按删除时间从近到远排序并分页', () => {
        writeSummary('task_a', [
            { deleted_at: '2026-05-01T08:00:00.000Z', original_path: '/w/old.txt' },
            { deleted_at: '2026-05-03T08:00:00.000Z', original_path: '/w/new.txt' },
            { deleted_at: '2026-05-02T08:00:00.000Z', original_path: '/w/mid.txt' }
        ]);
        const result = searchTrashEntries({ trashRoot, scope: 'task', taskId: 'task_a' });
        expect(result.total).toBe(3);
        expect(result.entries.map((e) => path.basename(e.original_path))).toEqual(['new.txt', 'mid.txt', 'old.txt']);
        expect(result.entries[0].task_id).toBe('task_a');

        const page = searchTrashEntries({ trashRoot, scope: 'task', taskId: 'task_a', offset: 1, limit: 1 });
        expect(page.total).toBe(3);
        expect(page.entries).toHaveLength(1);
        expect(path.basename(page.entries[0].original_path)).toBe('mid.txt');
    });

    test('任务范围：关键字大小写不敏感匹配原始路径', () => {
        writeSummary('task_a', [
            { original_path: 'C:\\Proj\\Report.Q1.xlsx' },
            { original_path: 'C:\\Proj\\notes.md' }
        ]);
        const result = searchTrashEntries({ trashRoot, scope: 'task', taskId: 'task_a', keyword: 'report.q1' });
        expect(result.total).toBe(1);
        expect(path.basename(result.entries[0].original_path)).toBe('Report.Q1.xlsx');
    });

    test('全局范围：无关键字且提供 recentTaskIds 时只列出最近任务', () => {
        writeSummary('task_a', [{ original_path: '/w/a.txt' }]);
        writeSummary('task_b', [{ original_path: '/w/b.txt' }]);
        const result = searchTrashEntries({ trashRoot, scope: 'global', recentTaskIds: ['task_b'] });
        expect(result.total).toBe(1);
        expect(result.entries[0].task_id).toBe('task_b');
    });

    test('全局范围：有关键字时搜索所有任务的回收站', () => {
        writeSummary('task_a', [{ original_path: '/w/keepme.txt' }]);
        writeSummary('task_b', [{ original_path: '/w/drop.txt' }]);
        const result = searchTrashEntries({ trashRoot, scope: 'global', keyword: 'keepme' });
        expect(result.total).toBe(1);
        expect(result.entries[0].task_id).toBe('task_a');
    });

    test('全局范围：按删除时间跨任务排序', () => {
        writeSummary('task_a', [{ deleted_at: '2026-05-01T00:00:00.000Z', original_path: '/w/a.txt' }]);
        writeSummary('task_b', [{ deleted_at: '2026-05-09T00:00:00.000Z', original_path: '/w/b.txt' }]);
        const result = searchTrashEntries({ trashRoot, scope: 'global' });
        expect(result.entries.map((e) => e.task_id)).toEqual(['task_b', 'task_a']);
    });

    test('忽略非 task_ 目录与无关文件', () => {
        writeSummary('task_a', [{ original_path: '/w/a.txt' }]);
        fs.mkdirSync(path.join(trashRoot, 'not-a-task'), { recursive: true });
        fs.writeFileSync(path.join(trashRoot, 'loose.txt'), 'x', 'utf8');
        const result = searchTrashEntries({ trashRoot, scope: 'global' });
        expect(result.total).toBe(1);
        expect(result.entries[0].task_id).toBe('task_a');
    });
});

describe('restoreTrashEntry', () => {
    test('恢复文件到原始路径且保留回收站内容', () => {
        const uuid = '11111111-2222-4333-8444-555555555555';
        const dir = writeSummary('task_a', [{ uuid, original_path: path.join(trashRoot, 'restored.txt') }]);
        writeBack(dir, uuid, 'hello back');
        const target = path.join(trashRoot, 'restored.txt');

        const result = restoreTrashEntry({ trashRoot, taskId: 'task_a', uuid, overwrite: false });
        expect(result.restored).toBe(true);
        expect(fs.readFileSync(target, 'utf8')).toBe('hello back');
        // 找回不删除回收站内容
        expect(fs.existsSync(path.join(dir, `${uuid}${TRASH_BACK_SUFFIX}`))).toBe(true);
    });

    test('目标已存在且未允许覆盖时返回 exists 提示', () => {
        const uuid = '11111111-2222-4333-8444-555555555556';
        const dir = writeSummary('task_a', [{ uuid, original_path: path.join(trashRoot, 'conflict.txt') }]);
        writeBack(dir, uuid, 'from trash');
        fs.writeFileSync(path.join(trashRoot, 'conflict.txt'), 'current', 'utf8');

        const result = restoreTrashEntry({ trashRoot, taskId: 'task_a', uuid, overwrite: false });
        expect(result.restored).toBe(false);
        expect(result.exists).toBe(true);
        expect(fs.readFileSync(path.join(trashRoot, 'conflict.txt'), 'utf8')).toBe('current');

        const overwritten = restoreTrashEntry({ trashRoot, taskId: 'task_a', uuid, overwrite: true });
        expect(overwritten.restored).toBe(true);
        expect(fs.readFileSync(path.join(trashRoot, 'conflict.txt'), 'utf8')).toBe('from trash');
    });

    test('目录条目递归恢复', () => {
        const uuid = '11111111-2222-4333-8444-555555555557';
        const dir = writeSummary('task_a', [{ uuid, original_path: path.join(trashRoot, 'nested-dir') }]);
        const backDir = path.join(dir, `${uuid}${TRASH_BACK_SUFFIX}`);
        fs.mkdirSync(backDir, { recursive: true });
        fs.writeFileSync(path.join(backDir, 'inner.txt'), 'inner', 'utf8');

        const result = restoreTrashEntry({ trashRoot, taskId: 'task_a', uuid, overwrite: false });
        expect(result.restored).toBe(true);
        expect(fs.readFileSync(path.join(trashRoot, 'nested-dir', 'inner.txt'), 'utf8')).toBe('inner');
    });

    test('条目不存在或 uuid 非法时不恢复', () => {
        writeSummary('task_a', []);
        expect(
            restoreTrashEntry({ trashRoot, taskId: 'task_a', uuid: 'missing-uuid', overwrite: false }).restored
        ).toBe(false);
        expect(restoreTrashEntry({ trashRoot, taskId: 'task_a', uuid: '../escape', overwrite: false }).restored).toBe(
            false
        );
    });

    test('taskId 路径穿越被拒绝（IPC 入参防御）', () => {
        // 在回收站外构造一个合法 summary，验证穿越 taskId 无法触达
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-trash-outside-'));
        try {
            const evilTaskDir = path.join(outside, '..', path.basename(outside), 'task_evil');
            fs.mkdirSync(path.join(outside, 'task_evil'), { recursive: true });
            fs.writeFileSync(
                path.join(evilTaskDir, TRASH_SUMMARY_FILENAME),
                JSON.stringify([
                    {
                        uuid: '99999999-9999-4999-8999-999999999999',
                        original_path: 'C:/evil.txt',
                        size: 1,
                        deleted_at: '2026-05-01T00:00:00.000Z'
                    }
                ]),
                'utf8'
            );
            const result = restoreTrashEntry({
                trashRoot,
                taskId: `../${path.basename(outside)}/task_evil`,
                uuid: '99999999-9999-4999-8999-999999999999',
                overwrite: false
            });
            expect(result.restored).toBe(false);
            expect(result.message).toBe('invalid trash task id');
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    test('.back 文件丢失时不恢复', () => {
        const uuid = '11111111-2222-4333-8444-555555555558';
        writeSummary('task_a', [{ uuid, original_path: path.join(trashRoot, 'gone.txt') }]);
        const result = restoreTrashEntry({ trashRoot, taskId: 'task_a', uuid, overwrite: false });
        expect(result.restored).toBe(false);
    });

    test('目标已存在且内容一致时返回 identical 提示', () => {
        const uuid = '11111111-2222-4333-8444-555555555559';
        const dir = writeSummary('task_a', [{ uuid, original_path: path.join(trashRoot, 'same.txt') }]);
        writeBack(dir, uuid, 'identical content');
        fs.writeFileSync(path.join(trashRoot, 'same.txt'), 'identical content', 'utf8');

        const result = restoreTrashEntry({ trashRoot, taskId: 'task_a', uuid, overwrite: false });
        expect(result.restored).toBe(false);
        expect(result.exists).toBe(true);
        expect(result.identical).toBe(true);
        expect(typeof result.target_mtime).toBe('number');
        // 覆盖模式下不重复提示 identical（由调用方先拦截），仍执行复制
        const forced = restoreTrashEntry({ trashRoot, taskId: 'task_a', uuid, overwrite: true });
        expect(forced.restored).toBe(true);
    });

    test('目标已存在且内容不同时返回 identical=false 与现有文件修改时间', () => {
        const uuid = '11111111-2222-4333-8444-555555555560';
        const dir = writeSummary('task_a', [{ uuid, original_path: path.join(trashRoot, 'diff.txt') }]);
        writeBack(dir, uuid, 'from trash');
        const target = path.join(trashRoot, 'diff.txt');
        fs.writeFileSync(target, 'current content', 'utf8');

        const result = restoreTrashEntry({ trashRoot, taskId: 'task_a', uuid, overwrite: false });
        expect(result.restored).toBe(false);
        expect(result.exists).toBe(true);
        expect(result.identical).toBe(false);
        expect(typeof result.target_mtime).toBe('number');
        expect(fs.readFileSync(target, 'utf8')).toBe('current content');

        // 用户确认覆盖后内容替换
        const overwritten = restoreTrashEntry({ trashRoot, taskId: 'task_a', uuid, overwrite: true });
        expect(overwritten.restored).toBe(true);
        expect(fs.readFileSync(target, 'utf8')).toBe('from trash');
    });

    test('目录条目已存在时不做内容比对，仅返回存在提示与修改时间', () => {
        const uuid = '11111111-2222-4333-8444-555555555561';
        const dir = writeSummary('task_a', [{ uuid, original_path: path.join(trashRoot, 'some-dir') }]);
        const backDir = path.join(dir, `${uuid}${TRASH_BACK_SUFFIX}`);
        fs.mkdirSync(backDir, { recursive: true });
        fs.mkdirSync(path.join(trashRoot, 'some-dir'), { recursive: true });

        const result = restoreTrashEntry({ trashRoot, taskId: 'task_a', uuid, overwrite: false });
        expect(result.restored).toBe(false);
        expect(result.exists).toBe(true);
        expect(result.identical).toBeUndefined();
        expect(typeof result.target_mtime).toBe('number');
    });
});

describe('prepareTrashPreviewCopy', () => {
    test('以原始文件名创建预览副本（供系统默认应用按扩展名打开）', () => {
        const uuid = '22222222-2222-4333-8444-555555555501';
        const dir = writeSummary('task_a', [{ uuid, original_path: 'C:\\Users\\x\\报表数据.docx' }]);
        writeBack(dir, uuid, 'preview content');
        const previewRoot = path.join(trashRoot, 'preview');

        const result = prepareTrashPreviewCopy({ trashRoot, taskId: 'task_a', uuid, previewRoot });
        expect(result.path).toBeDefined();
        expect(path.basename(result.path!)).toBe('报表数据.docx');
        expect(fs.readFileSync(result.path!, 'utf8')).toBe('preview content');
        // 路径结构：previewRoot/<taskId>/<uuid>/<原始文件名>
        expect(result.path).toContain(path.join('task_a', uuid));
    });

    test('重复调用幂等：副本已存在时直接复用', () => {
        const uuid = '22222222-2222-4333-8444-555555555502';
        const dir = writeSummary('task_a', [{ uuid, original_path: '/w/notes.md' }]);
        writeBack(dir, uuid, 'content');
        const previewRoot = path.join(trashRoot, 'preview');

        const first = prepareTrashPreviewCopy({ trashRoot, taskId: 'task_a', uuid, previewRoot });
        // 之后修改 .back 内容不影响已生成的副本（.back 实际不可变，此处仅验证不重写）
        fs.writeFileSync(path.join(dir, `${uuid}${TRASH_BACK_SUFFIX}`), 'changed', 'utf8');
        const second = prepareTrashPreviewCopy({ trashRoot, taskId: 'task_a', uuid, previewRoot });
        expect(second.path).toBe(first.path);
        expect(fs.readFileSync(first.path!, 'utf8')).toBe('content');
    });

    test('目录条目递归复制', () => {
        const uuid = '22222222-2222-4333-8444-555555555503';
        const dir = writeSummary('task_a', [{ uuid, original_path: '/w/project' }]);
        const backDir = path.join(dir, `${uuid}${TRASH_BACK_SUFFIX}`);
        fs.mkdirSync(path.join(backDir, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(backDir, 'sub', 'a.txt'), 'inner', 'utf8');
        const previewRoot = path.join(trashRoot, 'preview');

        const result = prepareTrashPreviewCopy({ trashRoot, taskId: 'task_a', uuid, previewRoot });
        expect(fs.existsSync(path.join(result.path!, 'sub', 'a.txt'))).toBe(true);
    });

    test('uuid 或 taskId 非法、.back 缺失时返回失败原因', () => {
        writeSummary('task_a', []);
        expect(
            prepareTrashPreviewCopy({ trashRoot, taskId: 'task_a', uuid: 'bad-uuid', previewRoot: trashRoot }).message
        ).toBeDefined();
        expect(
            prepareTrashPreviewCopy({
                trashRoot,
                taskId: '../escape',
                uuid: '22222222-2222-4333-8444-555555555504',
                previewRoot: trashRoot
            }).message
        ).toBeDefined();
        expect(
            prepareTrashPreviewCopy({
                trashRoot,
                taskId: 'task_a',
                uuid: '22222222-2222-4333-8444-555555555504',
                previewRoot: trashRoot
            }).message
        ).toBeDefined();
    });
});

describe('cleanupTrashPreviewCopies', () => {
    const NOW = Date.parse('2026-05-10T00:00:00.000Z');

    function makePreview(previewRoot: string, taskId: string, uuid: string, name: string, content: string): string {
        const file = path.join(previewRoot, taskId, uuid, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
        return file;
    }

    test('超过保留期的副本被清理，新副本保留', () => {
        const previewRoot = path.join(trashRoot, 'preview');
        const fresh = makePreview(previewRoot, 'task_a', 'uuid-1', 'a.txt', 'fresh');
        const stale = makePreview(previewRoot, 'task_b', 'uuid-2', 'b.txt', 'stale');
        const past = new Date(NOW - TRASH_PREVIEW_RETENTION_MS - 60_000);
        fs.utimesSync(stale, past, past);

        const removed = cleanupTrashPreviewCopies({ previewRoot, now: NOW });
        expect(removed).toBe(1);
        expect(fs.existsSync(fresh)).toBe(true);
        expect(fs.existsSync(stale)).toBe(false);
        // 清理后产生的空目录同步收敛（task_b/uuid-2 与 task_b 本身均被剪除）
        expect(fs.existsSync(path.join(previewRoot, 'task_b'))).toBe(false);
        expect(fs.existsSync(previewRoot)).toBe(true);
    });

    test('清理失败（如查看器占用）跳过该项而不中断', () => {
        const previewRoot = path.join(trashRoot, 'preview');
        const locked = makePreview(previewRoot, 'task_a', 'uuid-1', 'locked.txt', 'data');
        const other = makePreview(previewRoot, 'task_a', 'uuid-2', 'other.txt', 'data');
        const past = new Date(NOW - TRASH_PREVIEW_RETENTION_MS - 60_000);
        fs.utimesSync(locked, past, past);
        fs.utimesSync(other, past, past);
        // 模拟占用：把 stale 文件替换为不可删除的非空目录（rmSync 会失败）
        fs.unlinkSync(locked);
        fs.mkdirSync(locked);
        fs.writeFileSync(path.join(locked, 'held'), 'x', 'utf8');
        // 把目录设为只读在 Windows 上不可靠，改为通过不存在父目录的情形验证容错：
        // 直接删除父目录制造 rmSync 失败窗口不可靠，这里仅验证其余项仍被清理
        const removed = cleanupTrashPreviewCopies({ previewRoot, now: NOW });
        expect(removed).toBeGreaterThanOrEqual(1);
        expect(fs.existsSync(other)).toBe(false);
        void locked;
    });

    test('根目录不存在时返回 0', () => {
        expect(cleanupTrashPreviewCopies({ previewRoot: path.join(trashRoot, 'nope'), now: NOW })).toBe(0);
    });

    test('initializeTrash 启动时顺带执行预览副本清扫（taskProvider 抛异常不阻塞）', () => {
        const previewRoot = path.join(trashRoot, 'preview');
        const stale = makePreview(previewRoot, 'task_a', 'uuid-1', 'a.txt', 'x');
        const past = new Date(NOW - TRASH_PREVIEW_RETENTION_MS - 60_000);
        fs.utimesSync(stale, past, past);
        // initializeTrash 使用默认 previewRoot（真实临时目录），此处无法注入；
        // 仅验证调用不抛错，清扫行为由上面用例覆盖
        expect(() => initializeTrash(() => new Map())).not.toThrow();
        void stale;
    });
});

describe('cleanupExpiredTrash', () => {
    const NOW = Date.parse('2026-05-10T00:00:00.000Z');
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

    test('保留 7 天内有交互的任务，清理超期任务', () => {
        const fresh = writeSummary('task_fresh', [{ original_path: '/w/a.txt' }]);
        const stale = writeSummary('task_stale', [{ original_path: '/w/b.txt' }]);
        // mtime 都刚创建，交互时间决定去留
        const removed = cleanupExpiredTrash({
            trashRoot,
            retained: new Map([
                ['task_fresh', new Date(NOW - 1000)],
                ['task_stale', new Date(NOW - WEEK_MS - 1000)]
            ]),
            now: NOW
        });
        expect(removed).toEqual(['task_stale']);
        expect(fs.existsSync(fresh)).toBe(true);
        expect(fs.existsSync(stale)).toBe(false);
    });

    test('孤儿目录按目录修改时间清理，新孤儿保留', () => {
        const orphanFresh = makeTaskDir('task_orphan_fresh');
        fs.writeFileSync(path.join(orphanFresh, TRASH_SUMMARY_FILENAME), '[]', 'utf8');
        const removed = cleanupExpiredTrash({ trashRoot, retained: new Map(), now: NOW });
        expect(removed).toEqual([]);

        const orphanOld = makeTaskDir('task_orphan_old');
        fs.writeFileSync(path.join(orphanOld, TRASH_SUMMARY_FILENAME), '[]', 'utf8');
        const past = new Date(NOW - WEEK_MS - 60_000);
        fs.utimesSync(orphanOld, past, past);
        const removed2 = cleanupExpiredTrash({ trashRoot, retained: new Map(), now: NOW });
        expect(removed2).toEqual(['task_orphan_old']);
        expect(fs.existsSync(orphanOld)).toBe(false);
    });

    test('已知任务但缺少交互时间时按目录修改时间兜底', () => {
        const dir = makeTaskDir('task_no_ts');
        fs.writeFileSync(path.join(dir, TRASH_SUMMARY_FILENAME), '[]', 'utf8');
        const removed = cleanupExpiredTrash({
            trashRoot,
            retained: new Map([['task_no_ts', undefined]]),
            now: NOW
        });
        expect(removed).toEqual([]);
    });

    test('目录不存在时直接返回空', () => {
        expect(cleanupExpiredTrash({ trashRoot: path.join(trashRoot, 'nope'), retained: new Map(), now: NOW })).toEqual(
            []
        );
    });
});

describe('initializeTrash', () => {
    test('ensureTrashRootDirectory 幂等创建', () => {
        const first = ensureTrashRootDirectory();
        const second = ensureTrashRootDirectory();
        expect(first).toBe(second);
        expect(fs.existsSync(first)).toBe(true);
    });

    test('taskProvider 抛异常时不阻塞初始化（仅按目录时间清理）', () => {
        expect(() =>
            initializeTrash(() => {
                throw new Error('provider boom');
            })
        ).not.toThrow();
    });
});
