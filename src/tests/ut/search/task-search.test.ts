import { afterEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TASK_SEARCH_MAX_QUERY, TASK_SEARCH_MAX_WILDCARD_GAP } from '../../../common/task-search.js';
import { TaskSearchIndex } from '../../../main/services/task-search/index.js';
import { extractSearchDocuments } from '../../../main/services/task-search/extract.js';
import { TaskSearchSync } from '../../../main/services/task-search/sync.js';

const directories: string[] = [];
const indexes: TaskSearchIndex[] = [];
afterEach(() => {
    indexes.splice(0).forEach((index) => index.close());
    directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const task = (id: string, text: string, title = '历史任务') => ({
    task_id: id,
    task_name: title,
    workspace: '/work/OpenDesk',
    updated_at: '2026-09-15',
    chat_context: { messages: [{ role: 'user', message_id: 'u1', content: [{ type: 'text', text }] }] }
});
async function createIndex() {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-task-search-'));
    directories.push(dir);
    const index = await TaskSearchIndex.open(path.join(dir, 'search.sqlite'), true);
    indexes.push(index);
    return index;
}
describe('task content search', () => {
    test('extracts full visible text, excluding tools, reasoning, internal messages and attachments', () => {
        const data = task('one', 'visible');
        data.chat_context.messages.push(
            {
                role: 'assistant',
                message_id: 'a1',
                content: [
                    { type: 'text', text: 'answer' },
                    { type: 'reasoning', text: 'secret' }
                ]
            },
            { role: 'tool', message_id: 't1', content: [{ type: 'text', text: 'tool secret' }] },
            {
                role: 'user',
                message_id: 'i1',
                internal: true,
                content: [{ type: 'text', text: 'internal secret' }]
            } as any
        );
        const text = extractSearchDocuments(data)
            .map((doc) => doc.text)
            .join(' ');
        expect(text).toContain('visible');
        expect(text).toContain('answer');
        expect(text).not.toContain('secret');
    });
    test('finds one/two-character Chinese, code substrings, literal operators and late text', async () => {
        const index = await createIndex();
        index.replaceTask(task('one', '前文'.repeat(4000) + ' 创建项目 foo_bar <script> "OR" '), 'v1');
        for (const query of ['创', '创建', '建项目', 'oo_b', '<script>', '"OR"']) {
            const hits = index.search(query, 20).items;
            expect(hits).toHaveLength(1);
            expect(hits[0].messageId).toBe('u1');
            expect(hits[0].snippet.toLowerCase()).toContain(query.toLowerCase());
        }
        expect(index.search('不存在', 20).items).toHaveLength(0);
    });
    test('finds ordered wildcard matches within an indexed chunk and returns the matching message', async () => {
        const index = await createIndex();
        index.replaceTask(task('valid', '前文'.repeat(4000) + '开始🚀 准备版本🚀结束'), 'v1');
        index.replaceTask(task('separate-chunks', '开始🚀' + '中'.repeat(4200) + '版本🚀结束'), 'v1');
        index.replaceTask(task('wrong-order', '版本🚀结束 然后开始'), 'v1');
        index.replaceTask(task('two-characters', '开始 版本中文结束'), 'v1');
        const separate = task('separate', '开始');
        separate.chat_context.messages.push({
            role: 'assistant',
            message_id: 'a1',
            content: [{ type: 'text', text: '版本🚀结束' }]
        });
        index.replaceTask(separate, 'v1');

        const { items } = index.search('开始*版本?结束', 20);
        expect(items.map(({ taskId, messageId }) => [taskId, messageId])).toEqual([['valid', 'u1']]);
        expect(items[0].snippet).toContain('开始🚀');
        expect(items[0].snippet).toContain('版本🚀结束');
    });
    test('matches wildcards by default and handles escaped wildcards in titles, paths and messages', async () => {
        const index = await createIndex();
        index.replaceTask(task('a', '正文', 'Build[v1]'), 'v1');
        index.replaceTask(
            { ...task('b', 'Which build? result: *ready', 'Build[*]'), workspace: '\\\\server\\work' },
            'v1'
        );
        index.replaceTask(task('c', 'Which build! result: Xready', 'Build[]'), 'v1');
        const ids = (query: string) => index.search(query, 20).items.map(({ taskId }) => taskId);
        expect(ids('?')).toEqual(['a', 'b', 'c']);
        expect(ids('build[*]')).toEqual(['a', 'b', 'c']);
        expect(ids('Build[\\*]')).toEqual(['b']);
        expect(index.search('Build[\\*]', 20).items[0].priority).toBe(3);
        expect(ids('build[??]')).toEqual(['a']);
        expect(ids('/work/*Desk')).toEqual(['a', 'c']);
        expect(ids('\\\\server\\work')).toEqual(['b']);
        expect(ids('build\\?')).toEqual(['b']);
        expect(ids('build\\?*\\*read?')).toEqual(['b']);
        expect(index.search('build\\?', 20).items[0].snippet).toContain('build?');
    });
    test('keeps wildcard matches on one line and within the character budget', async () => {
        const index = await createIndex();
        index.replaceTask(task('two-lines', '/draft.pptx\r\nsource: report.doc'), 'v1');
        index.replaceTask(task('too-long', '/' + '🚀'.repeat(TASK_SEARCH_MAX_WILDCARD_GAP + 1) + '.doc'), 'v1');
        index.replaceTask(task('within-limit', '/' + '🚀'.repeat(TASK_SEARCH_MAX_WILDCARD_GAP) + '.doc'), 'v1');
        expect(index.search('/*.doc', 20).items.map((hit) => hit.taskId)).toEqual(['within-limit']);
        expect(index.search('pptx source', 20).items.map((hit) => hit.taskId)).toEqual(['two-lines']);
    });
    test.each([
        {
            label: 'long literal',
            prefixLength: 3770,
            query: 'a'.repeat(TASK_SEARCH_MAX_QUERY - 2) + '*z',
            match: 'a'.repeat(TASK_SEARCH_MAX_QUERY - 2) + '中'.repeat(TASK_SEARCH_MAX_WILDCARD_GAP) + 'z'
        },
        {
            label: 'emoji matched by both wildcards',
            prefixLength: 3680,
            query: 'a' + '?'.repeat(TASK_SEARCH_MAX_QUERY - 3) + '*z',
            match: 'a' + '🚀'.repeat(TASK_SEARCH_MAX_QUERY - 3 + TASK_SEARCH_MAX_WILDCARD_GAP) + 'z'
        }
    ])('finds $label across an index chunk boundary', async ({ prefixLength, query, match }) => {
        const index = await createIndex();
        index.replaceTask(task('one', '前'.repeat(prefixLength) + match), 'v1');
        const results = index.search(query, 20).items;
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ taskId: 'one', messageId: 'u1' });
        expect(results[0].snippet).toContain(match);
    });
    test('uses the message with the shortest wildcard match for the preview', async () => {
        const index = await createIndex();
        const data = task('one', '/work/yearly-analysis.doc');
        data.chat_context.messages.push({
            role: 'assistant',
            message_id: 'a1',
            content: [{ type: 'text', text: '例子 /a.doc' }]
        });
        index.replaceTask(data, 'v1');
        expect(index.search('/*.doc', 20).items[0]).toMatchObject({ messageId: 'a1', snippet: '例子 /a.doc' });
    });
    test('groups by task, ranks titles first, paginates and removes stale text after rewind/delete', async () => {
        const index = await createIndex();
        index.replaceTask(task('body', '创建 '.repeat(4000)), 'v1');
        index.replaceTask(task('title', 'other', '创建'), 'v1');
        expect(index.search('创建', 1).items.map((hit) => hit.taskId)).toEqual(['title']);
        expect(index.search('创建', 1).hasMore).toBe(true);
        expect(index.search('创建', 20).items).toHaveLength(2);
        index.replaceTask(task('body', 'replacement'), 'v2');
        index.removeTask('title');
        expect(index.search('创建', 20).items).toEqual([]);
        expect(index.search('replacement', 20).items[0].taskId).toBe('body');
    });
    test('expands to the 200-task cap and reports remaining matches', async () => {
        const index = await createIndex();
        for (let i = 0; i < 205; i++) index.replaceTask(task(String(i), '展开全文'), 'v1');
        expect(index.search('展开全文', 20).items).toHaveLength(20);
        expect(index.search('展开全文', 20).hasMore).toBe(true);
        const expanded = index.search('展开全文', 200);
        expect(expanded.items).toHaveLength(200);
        expect(expanded.hasMore).toBe(true);
    });
    test('persists index across reopen and excludes hidden tasks', async () => {
        const index = await createIndex();
        index.replaceTask(task('one', '持久化'), 'v1');
        index.replaceTask({ ...task('hidden', '持久化'), internal: true }, 'v1');
        const dbPath = index.dbPath;
        index.close();
        indexes.pop();
        const reopened = await TaskSearchIndex.open(dbPath, true);
        indexes.push(reopened);
        expect(reopened.search('持久化', 20).items.map((hit) => hit.taskId)).toEqual(['one']);
        expect(reopened.fingerprints().get('one')).toBe('v1');
    });
    test('reconciles external saves, missing files, visibility changes', async () => {
        const index = await createIndex();
        const directory = path.dirname(index.dbPath);
        const sync = new TaskSearchSync(directory, index);
        const first = task('one', '创建');
        const second = task('two', '创建');
        const save = (value: any) =>
            writeFileSync(path.join(directory, value.task_id + '.json'), JSON.stringify(value));
        writeFileSync(path.join(directory, 'task_list.json'), JSON.stringify([first, second]));
        save(first);
        save(second);
        await sync.refresh();
        expect(index.search('创建', 20).items).toHaveLength(2);
        const revision = sync.revision;
        await sync.refresh();
        expect(sync.revision).toBe(revision);
        save(task('one', '修改后'));
        rmSync(path.join(directory, 'two.json'));
        await sync.refresh();
        expect(index.search('创建', 20).items).toHaveLength(0);
        expect(index.search('修改后', 20).items).toHaveLength(1);
        expect(sync.failures.has('two')).toBe(true);
        writeFileSync(path.join(directory, 'task_list.json'), JSON.stringify([{ ...first, internal: true }]));
        await sync.refresh();
        expect(index.search('修改后', 20).items).toHaveLength(0);
    });
    test('does not lose matches crossing chunk boundaries or index forged task IDs', async () => {
        const index = await createIndex();
        index.replaceTask(task('one', 'x'.repeat(3998) + '边界匹配词' + 'y'.repeat(4000)), 'v1');
        expect(index.search('边界匹配词', 20).items).toHaveLength(1);
        const directory = path.dirname(index.dbPath);
        writeFileSync(path.join(directory, 'task_list.json'), JSON.stringify([task('two', '')]));
        writeFileSync(path.join(directory, 'two.json'), JSON.stringify(task('forged', '伪造')));
        const sync = new TaskSearchSync(directory, index);
        await sync.refresh();
        expect(index.search('伪造', 20).items).toHaveLength(0);
        expect(sync.failures.has('two')).toBe(true);
    });
});
