import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdminConsoleApplication } from '../../../main/applications/adminconsole/app.js';

/**
 * Windows 下 path.resolve 会给以 / 开头的路径补当前盘符（如 /home → D:/home），
 * 期望的声明路径按平台同源解析，使断言在 POSIX / Windows 双端一致。
 */
function expectedResolvedPath(posixPath: string): string {
    return path.resolve(posixPath).replace(/\\/g, '/');
}

const SAMPLE_ITEMS = [
    {
        id: 3,
        type: 'bug',
        content: 'paste lag',
        contact: 'a@b.c',
        time: '2026-10-22T10:00:00Z',
        attachments: [{ attachment_id: 9, filename: 'log.txt' }]
    },
    { id: 2, type: 'feature', content: 'dark mode', contact: null, time: '2026-10-21T09:00:00Z', attachments: [] },
    { id: 1, type: 'feature', content: 'voice input', contact: 'x', time: '2026-10-20T08:00:00Z', attachments: [] }
];

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 构造已授权实例，fetch 模拟支持 type 过滤 / offset 分页 / detail 接口的新版服务端 */
function makeAuthorizedApp(items: typeof SAMPLE_ITEMS = SAMPLE_ITEMS): AdminConsoleApplication {
    const app = new AdminConsoleApplication();
    (app as any).fetchImpl = async (input: string | URL) => {
        const url = new URL(String(input));
        const detail = url.pathname.match(/\/api\/feedback\/detail\/(\d+)$/);
        if (detail) {
            const item = items.find((entry) => entry.id === Number(detail[1]));
            return jsonResponse(item ? { ok: true, item } : { error: 'feedback not found' }, item ? 200 : 404);
        }
        const type = url.searchParams.get('type');
        const offset = Number(url.searchParams.get('offset') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? '50');
        const filtered = type ? items.filter((entry) => entry.type === type) : items;
        return jsonResponse({
            ok: true,
            total: filtered.length,
            limit,
            offset,
            items: filtered.slice(offset, offset + limit)
        });
    };
    (app as any).getTokenStore().setSession((app as any).currentServer(), 'test-admin-token');
    return app;
}

/** 已授权应用的 /admin 技能工具集 */
async function makeAuthorizedToolset(app?: AdminConsoleApplication) {
    const skills = await (app ?? makeAuthorizedApp()).getSkills();
    expect(skills).toHaveLength(1);
    return skills[0].toolsets![0];
}

describe('adminconsole /admin skill gating', () => {
    test('registers no skill and no resident toolset without an admin token', async () => {
        const app = new AdminConsoleApplication();
        expect(await app.getSkills()).toEqual([]);
        expect(await app.getToolsets()).toEqual([]);
    });

    test('registers the admin skill bundling all five tools when a token is present', async () => {
        const skills = await makeAuthorizedApp().getSkills();
        expect(skills).toHaveLength(1);
        expect(skills[0].frontmatter.name).toBe('admin');
        expect(skills[0].toolsets).toHaveLength(1);
        expect(Array.from(skills[0].toolsets![0].tools.keys()).sort()).toEqual([
            'downloadAttachment',
            'getBugDetails',
            'getRequirementDetails',
            'listRecentBugs',
            'listRecentRequirements'
        ]);
    });
});

describe('adminconsole feedback queries by type', () => {
    test('listFeedbackByType filters feature items', async () => {
        const result = await makeAuthorizedApp().listFeedbackByType('feature', 10);
        expect(result.status).toBe('ok');
        const data = result.data as { count: number; items: Array<{ id: number }> };
        expect(data.count).toBe(2);
        expect(data.items.map((item) => item.id)).toEqual([2, 1]);
    });

    test('listFeedbackByType respects limit', async () => {
        const result = await makeAuthorizedApp().listFeedbackByType('feature', 1);
        const data = result.data as { items: Array<{ id: number }> };
        expect(data.items.map((item) => item.id)).toEqual([2]);
    });

    test('listFeedbackByType filters bug items', async () => {
        const result = await makeAuthorizedApp().listFeedbackByType('bug', 10);
        const data = result.data as { items: Array<{ id: number }> };
        expect(data.items.map((item) => item.id)).toEqual([3]);
    });

    test('listFeedbackByType paginates with offset and reports total', async () => {
        const result = await makeAuthorizedApp().listFeedbackByType('feature', 1, 1);
        const data = result.data as { total: number; offset: number; items: Array<{ id: number }> };
        expect(data.total).toBe(2);
        expect(data.offset).toBe(1);
        expect(data.items.map((item) => item.id)).toEqual([1]);
    });

    test('getFeedbackDetail returns the matching item', async () => {
        const result = await makeAuthorizedApp().getFeedbackDetail('feature', 2);
        expect(result.status).toBe('ok');
        expect((result.data as { content: string }).content).toBe('dark mode');
    });

    test('getFeedbackDetail rejects id with mismatched type', async () => {
        const result = await makeAuthorizedApp().getFeedbackDetail('feature', 3);
        expect(result.status).toBe('error');
        expect(result.code).toBe('type_mismatch');
    });

    test('getFeedbackDetail reports not_found for unknown id', async () => {
        const result = await makeAuthorizedApp().getFeedbackDetail('bug', 99);
        expect(result.status).toBe('error');
        expect(result.code).toBe('not_found');
    });

    test('queries without token return unauthorized', async () => {
        const app = new AdminConsoleApplication();
        const result = await app.listFeedbackByType('feature', 10);
        expect(result.status).toBe('error');
        expect(result.code).toBe('unauthorized');
    });
});

describe('adminconsole agent tool executors', () => {
    test('listRecentBugs executor returns JSON payload', async () => {
        const toolset = await makeAuthorizedToolset();
        const result = await toolset.callTool('listRecentBugs', {});
        expect(result.status).toBe('success');
        const payload = JSON.parse(result.result as string) as {
            items: Array<{ id: number; attachments: unknown[] }>;
        };
        expect(payload.items[0].id).toBe(3);
    });

    test('getBugDetails executor returns attachment metadata', async () => {
        const toolset = await makeAuthorizedToolset();
        const result = await toolset.callTool('getBugDetails', { id: 3 });
        expect(result.status).toBe('success');
        const payload = JSON.parse(result.result as string) as { attachments: Array<{ attachment_id: number }> };
        expect(payload.attachments[0].attachment_id).toBe(9);
    });

    test('detail executor reports error status on unknown id', async () => {
        const toolset = await makeAuthorizedToolset();
        const result = await toolset.callTool('getRequirementDetails', { id: 12345 });
        expect(result.status).toBe('error');
        expect(result.result).toMatch(/not found/);
    });
});

describe('adminconsole downloadAttachment tool', () => {
    /** 返回内容固定为附件字节的已授权应用 */
    function makeDownloadApp(body: string): AdminConsoleApplication {
        const app = new AdminConsoleApplication();
        (app as any).fetchImpl = async () =>
            new Response(Buffer.from(body), { headers: { 'content-type': 'text/plain' } });
        (app as any).getTokenStore().setSession((app as any).currentServer(), 'test-admin-token');
        return app;
    }

    test('declares file/write permission on the resolved absolute path like writeFile', async () => {
        const toolset = await makeAuthorizedToolset();
        const tool = toolset.getTool('downloadAttachment')!;
        const taskState = { getWorkspace: () => '/home/dev/project' } as any;
        expect(tool.getDeclaredPermissions({ attachmentId: 9, path: 'logs/attachment.txt' }, taskState)).toEqual([
            {
                resourceType: 'file',
                action: 'write',
                resourcePath: expectedResolvedPath('/home/dev/project/logs/attachment.txt')
            }
        ]);
        expect(tool.getDeclaredPermissions({ attachmentId: 9, path: '/abs/a.txt' }, taskState)).toEqual([
            { resourceType: 'file', action: 'write', resourcePath: expectedResolvedPath('/abs/a.txt') }
        ]);
    });

    test('downloads attachment bytes to the target path and creates parent dirs', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adminconsole-dl-'));
        const dest = path.join(dir, 'nested', 'attachment_name.txt');
        const toolset = await makeAuthorizedToolset(makeDownloadApp('log-content'));
        const result = await toolset.callTool('downloadAttachment', { attachmentId: 9, path: dest });
        expect(result.status).toBe('success');
        const payload = JSON.parse(result.result as string) as { filePath: string; size: number };
        expect(payload.filePath).toBe(dest.replace(/\\/g, '/'));
        expect(payload.size).toBe('log-content'.length);
        expect(fs.readFileSync(dest, 'utf8')).toBe('log-content');
    });

    test('download without token returns unauthorized', async () => {
        const app = new AdminConsoleApplication();
        const result = await app.downloadAttachmentToFile(9, '/tmp/whatever.txt');
        expect(result.status).toBe('error');
        expect(result.code).toBe('unauthorized');
    });
});
