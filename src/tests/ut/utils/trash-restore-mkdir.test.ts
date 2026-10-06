import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 回归：Windows 盘符根（如 D:\）作为目标父目录时 fs.mkdirSync(…, {recursive:true})
// 会抛 EPERM（目录实际已存在），导致根目录文件的找回失败。
// trash.ts 的修复策略：父目录已存在则跳过 mkdir；mkdir 失败但目录已存在时容忍。
//
// 本文件把 node:fs 的 mkdirSync mock 为可控抛 EPERM，验证上述策略。
// 注意：被测模块必须在 mock 注册之后动态 import（静态 import 会先于 mock 求值，
// 绑定到真实 fs 导致 mock 不生效）；本文件的静态 fs 导入求值早于 mock 注册，
// 因此拿到的是真实 fs，用于测试数据准备。

let failMkdir = false;
let createThenThrow = false;
const mkdirSyncMock = jest.fn((p: unknown, opts?: unknown) => {
    const actual = jest.requireActual('node:fs') as typeof fs;
    if (!failMkdir) return actual.mkdirSync(p as string, opts as object);
    if (createThenThrow) {
        // 模拟并发场景：目录实际已创建，但仍抛出 EPERM
        actual.mkdirSync(p as string, opts as object);
        throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${String(p)}'`), { code: 'EPERM' });
    }
    throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${String(p)}'`), { code: 'EPERM' });
});

jest.unstable_mockModule('node:fs', () => {
    const actual = jest.requireActual('node:fs') as typeof fs;
    const mocked = { ...actual, mkdirSync: mkdirSyncMock as unknown as typeof actual.mkdirSync };
    return { ...(mocked as object), default: mocked };
});

const trash = (await import('../../../main/utils/trash.js')) as {
    restoreTrashEntry: (options: { trashRoot?: string; taskId: string; uuid: string; overwrite: boolean }) => {
        restored: boolean;
        message?: string;
    };
    TRASH_BACK_SUFFIX: string;
    TRASH_SUMMARY_FILENAME: string;
};
const { restoreTrashEntry, TRASH_BACK_SUFFIX, TRASH_SUMMARY_FILENAME } = trash;

const UUID = '11111111-2222-4333-8444-555555555570';
let trashRoot: string;

function setupEntry(originalPath: string, content: string): void {
    const taskDir = path.join(trashRoot, 'task_root');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
        path.join(taskDir, TRASH_SUMMARY_FILENAME),
        JSON.stringify([
            { uuid: UUID, original_path: originalPath, size: content.length, deleted_at: '2026-05-01T00:00:00.000Z' }
        ]),
        'utf8'
    );
    fs.writeFileSync(path.join(taskDir, `${UUID}${TRASH_BACK_SUFFIX}`), content, 'utf8');
}

beforeEach(() => {
    trashRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-trash-mkdir-test-'));
    failMkdir = false;
    createThenThrow = false;
});

afterEach(() => {
    fs.rmSync(trashRoot, { recursive: true, force: true });
});

test('父目录已存在时跳过 mkdir（盘符根场景等价），找回成功', () => {
    failMkdir = true;
    // 目标直接位于 trashRoot（已存在）下：dirname 即已存在目录，
    // 与 D:\xxx.txt 的 dirname === 'D:\' 同构
    const target = path.join(trashRoot, 'root-file.txt');
    setupEntry(target, 'restored data');

    const result = restoreTrashEntry({ trashRoot, taskId: 'task_root', uuid: UUID, overwrite: false });
    expect(result.restored).toBe(true);
    expect(result.message).toBeUndefined();
    expect(fs.readFileSync(target, 'utf8')).toBe('restored data');
});

test('mkdir 失败但目录实际已存在时容忍（并发创建竞态）', () => {
    failMkdir = true;
    createThenThrow = true;
    const target = path.join(trashRoot, 'made-anyway', 'file.txt');
    setupEntry(target, 'restored data');

    const result = restoreTrashEntry({ trashRoot, taskId: 'task_root', uuid: UUID, overwrite: false });
    expect(result.restored).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('restored data');
});

test('父目录缺失且 mkdir 失败时返回明确的失败原因', () => {
    failMkdir = true;
    const target = path.join(trashRoot, 'missing-sub', 'file.txt');
    setupEntry(target, 'restored data');

    const result = restoreTrashEntry({ trashRoot, taskId: 'task_root', uuid: UUID, overwrite: false });
    expect(result.restored).toBe(false);
    expect(result.message).toContain('cannot create parent directory');
    expect(result.message).toContain('EPERM');
    expect(fs.existsSync(target)).toBe(false);
});
