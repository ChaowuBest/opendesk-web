import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import path from 'node:path';
import {
    COMPOSE_STAGE_RETENTION_MS,
    sanitizeAttachmentFilename,
    selectExpiredStageDirs,
    stageFeedbackAttachments,
    type StageFeedbackAttachmentsDeps
} from '../../../main/applications/adminconsole/task-compose.js';
import type { AdminFeedbackItem } from '../../../main/utils/admin-stats.js';

const STAGE_DIR = '/data/apps/adminconsole/task-compose/bug-42/1700000000000-abcdef12';
// 期望路径与实现同样经 path.join 拼接，测试在 Windows/POSIX 下均成立
const stagePath = (...parts: string[]) => path.join(STAGE_DIR, ...parts);

function makeItem(overrides: Partial<AdminFeedbackItem> = {}): AdminFeedbackItem {
    return {
        id: 42,
        type: 'bug',
        content: '打开设置页面崩溃',
        contact: null,
        time: '2026-11-20T08:00:00.000Z',
        attachments: [
            { attachment_id: 11, filename: 'opendesk-system.log' },
            { attachment_id: 12, filename: 'opendesk-task.json' }
        ],
        ...overrides
    };
}

type Deps = StageFeedbackAttachmentsDeps;

function makeDeps(overrides: Partial<Deps> = {}): Deps & {
    calls: { ensured: string[]; downloaded: Array<{ id: number; dest: string }> };
} {
    const calls: { ensured: string[]; downloaded: Array<{ id: number; dest: string }> } = {
        ensured: [],
        downloaded: []
    };
    const base: Deps = {
        item: makeItem(),
        downloadAttachment: jest.fn(async (attachmentId: number, destPath: string) => {
            calls.downloaded.push({ id: attachmentId, dest: destPath });
            return { status: 'ok', data: { filePath: destPath } };
        }),
        resolveStageDir: () => STAGE_DIR,
        ensureDir: jest.fn(async (dir: string) => {
            calls.ensured.push(dir);
        })
    };
    return { ...base, ...overrides, calls };
}

describe('sanitizeAttachmentFilename', () => {
    test('keeps a plain filename unchanged', () => {
        expect(sanitizeAttachmentFilename('opendesk-system.log', 0)).toBe('opendesk-system.log');
    });

    test('strips directory components on both separators', () => {
        expect(sanitizeAttachmentFilename('..\\..\\evil.txt', 0)).toBe('evil.txt');
        expect(sanitizeAttachmentFilename('/etc/passwd', 0)).toBe('passwd');
    });

    test('falls back to attachment-<index> for empty or dot-only names', () => {
        expect(sanitizeAttachmentFilename('', 2)).toBe('attachment-2');
        expect(sanitizeAttachmentFilename('..', 1)).toBe('attachment-1');
        expect(sanitizeAttachmentFilename(undefined, 3)).toBe('attachment-3');
    });

    test('replaces windows-illegal characters instead of failing the download', () => {
        // ':' '<' '>' '"' '|' '?' '*' 与控制字符在 Windows 上无法创建文件
        expect(sanitizeAttachmentFilename('a:b<c>d"e|f?g*h.log', 0)).toBe('a_b_c_d_e_f_g_h.log');
        expect(sanitizeAttachmentFilename('bad\u0000name.log', 0)).toBe('bad_name.log');
    });

    test('trims trailing dots and spaces that windows rejects', () => {
        expect(sanitizeAttachmentFilename('log..', 0)).toBe('log');
        expect(sanitizeAttachmentFilename('log. . ', 0)).toBe('log');
    });

    test('defuses windows reserved device names, including extension forms', () => {
        expect(sanitizeAttachmentFilename('CON.log', 0)).toBe('_CON.log');
        expect(sanitizeAttachmentFilename('nul', 0)).toBe('_nul');
        expect(sanitizeAttachmentFilename('com1.txt', 0)).toBe('_com1.txt');
        // 只是前缀相同则不受影响
        expect(sanitizeAttachmentFilename('console.log', 0)).toBe('console.log');
    });

    test('truncates overlong names by utf-8 bytes while keeping the extension', () => {
        const sanitized = sanitizeAttachmentFilename(`${'日'.repeat(200)}.log`, 0);
        expect(sanitized.endsWith('.log')).toBe(true);
        expect(Buffer.byteLength(sanitized, 'utf8')).toBeLessThanOrEqual(180);
        // 多字节字符不能被截半
        expect(sanitized).toBe(sanitized.normalize('NFC'));
        expect(sanitized.includes('\uFFFD')).toBe(false);
    });
});

describe('selectExpiredStageDirs', () => {
    const now = 1_700_000_000_000;

    test('keeps dirs inside the retention window and drops older ones', () => {
        const entries = [
            { name: 'fresh', mtimeMs: now - 1000 },
            { name: 'borderline', mtimeMs: now - COMPOSE_STAGE_RETENTION_MS },
            { name: 'stale', mtimeMs: now - COMPOSE_STAGE_RETENTION_MS - 1 }
        ];
        expect(selectExpiredStageDirs(entries, now)).toEqual(['borderline', 'stale']);
    });

    test('ignores malformed entries', () => {
        const entries = [
            { name: 'bad-mtime', mtimeMs: Number.NaN },
            { name: undefined as unknown as string, mtimeMs: 0 }
        ];
        expect(selectExpiredStageDirs(entries, now)).toEqual([]);
    });
});

describe('stageFeedbackAttachments', () => {
    beforeEach(() => {
        jest.resetAllMocks();
    });

    test('downloads every attachment into the fresh stage dir and returns the item', async () => {
        const deps = makeDeps();
        const result = await stageFeedbackAttachments(deps);
        expect(result.item).toEqual(makeItem());
        expect(result.attachmentPaths).toEqual([stagePath('opendesk-system.log'), stagePath('opendesk-task.json')]);
        expect(result.failedFilenames).toEqual([]);
        expect(deps.calls.ensured).toEqual([STAGE_DIR]);
        expect(deps.downloadAttachment).toHaveBeenNthCalledWith(1, 11, stagePath('opendesk-system.log'));
        expect(deps.downloadAttachment).toHaveBeenNthCalledWith(2, 12, stagePath('opendesk-task.json'));
    });

    test('does not delete an existing dir: the fresh stage dir is only created', async () => {
        // 历史任务的附件只存路径引用，暂存目录不能被清空复用
        const resolveStageDir = jest.fn(() => STAGE_DIR);
        const deps = makeDeps({ item: makeItem({ attachments: [] }), resolveStageDir });
        const result = await stageFeedbackAttachments(deps);
        expect(resolveStageDir).toHaveBeenCalledTimes(1);
        expect(deps.calls.ensured).toEqual([STAGE_DIR]);
        expect(result.attachmentPaths).toEqual([]);
        expect(deps.downloadAttachment).not.toHaveBeenCalled();
    });

    test('sanitizes hostile filenames into the stage dir', async () => {
        const deps = makeDeps({
            item: makeItem({
                attachments: [
                    { attachment_id: 21, filename: '..\\..\\evil.log' },
                    { attachment_id: 22, filename: '' }
                ]
            })
        });
        const result = await stageFeedbackAttachments(deps);
        expect(result.attachmentPaths).toEqual([stagePath('evil.log'), stagePath('attachment-1')]);
    });

    test('dedupes colliding filenames even when the prefixed name is taken', async () => {
        const deps = makeDeps({
            item: makeItem({
                attachments: [
                    { attachment_id: 31, filename: '1_same.log' },
                    { attachment_id: 32, filename: 'same.log' },
                    { attachment_id: 33, filename: 'same.log' }
                ]
            })
        });
        const result = await stageFeedbackAttachments(deps);
        // 第二次冲突不能退化成 '1_same.log'（已占用），否则会覆盖已下载的附件
        expect(result.attachmentPaths).toEqual([
            stagePath('1_same.log'),
            stagePath('same.log'),
            stagePath('2_same.log')
        ]);
        expect(new Set(result.attachmentPaths).size).toBe(3);
    });

    test('dedupes case-insensitively for case-insensitive filesystems', async () => {
        const deps = makeDeps({
            item: makeItem({
                attachments: [
                    { attachment_id: 41, filename: 'System.log' },
                    { attachment_id: 42, filename: 'system.log' }
                ]
            })
        });
        const result = await stageFeedbackAttachments(deps);
        expect(result.attachmentPaths).toEqual([stagePath('System.log'), stagePath('1_system.log')]);
    });

    test('keeps going when a download fails and reports the failed filename', async () => {
        const deps = makeDeps({
            downloadAttachment: jest.fn(async (attachmentId: number, destPath: string) => {
                if (attachmentId === 11) {
                    return { status: 'error', message: 'HTTP 404' };
                }
                return { status: 'ok', data: { filePath: destPath } };
            }) as Deps['downloadAttachment']
        });
        const result = await stageFeedbackAttachments(deps);
        expect(result.attachmentPaths).toEqual([stagePath('opendesk-task.json')]);
        expect(result.failedFilenames).toEqual(['opendesk-system.log']);
    });

    test('treats a missing attachment id as a failed download instead of throwing', async () => {
        const deps = makeDeps({
            item: makeItem({
                attachments: [{ attachment_id: undefined as unknown as number, filename: 'broken.log' }]
            }),
            downloadAttachment: jest.fn(async () => ({
                status: 'error',
                message: 'invalid attachment id'
            })) as Deps['downloadAttachment']
        });
        const result = await stageFeedbackAttachments(deps);
        expect(result.attachmentPaths).toEqual([]);
        expect(result.failedFilenames).toEqual(['broken.log']);
        expect(deps.downloadAttachment).toHaveBeenCalledWith(Number.NaN, stagePath('broken.log'));
    });

    test('propagates ensureDir failures', async () => {
        const deps = makeDeps({
            ensureDir: jest.fn(async () => {
                throw new Error('EACCES');
            }) as Deps['ensureDir']
        });
        await expect(stageFeedbackAttachments(deps)).rejects.toThrow('EACCES');
        expect(deps.downloadAttachment).not.toHaveBeenCalled();
    });
});
