import { describe, expect, test } from '@jest/globals';
import * as fs from 'node:fs';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getGuiApplicationClasses } from '../../../platforms/applications.js';
import { AdminConsoleApplication } from '../../../main/applications/adminconsole/app.js';
import { isApplicationVisibleInMenu } from '../../../renderer/utils/application-visibility.js';

const sidebarSource = readFileSync(new URL('../../../renderer/components/sidebar.js', import.meta.url), 'utf8');
const rendererHtml = readFileSync(new URL('../../../renderer/index.html', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8');

describe('adminconsole application registration', () => {
    const application = new AdminConsoleApplication();

    test('registers under the adminconsole bundle name', () => {
        expect(application.bundleName).toBe('adminconsole');
    });

    test('stays hidden from the application list', () => {
        expect(application.showIcon).toBe(false);
        expect(isApplicationVisibleInMenu(application.toJSON(), undefined)).toBe(false);
    });

    test('exposes the main-world methods the entry widget calls', () => {
        const methods = [
            'getServerUrl',
            'loadToken',
            'verifyToken',
            'clearToken',
            'getDailyStats',
            'getSummaryStats',
            'getFeedbackList',
            'downloadAttachment',
            'prepareTaskCompose'
        ];
        for (const method of methods) {
            expect(typeof (application as any)[method]).toBe('function');
        }
    });
});

describe('adminconsole compose stage dirs', () => {
    // 历史任务的附件只保存路径引用，暂存目录必须按 mtime 过期回收而不是每次清空复用
    test('prunes stage dirs past the retention window and keeps fresh ones', async () => {
        const baseDir = mkdtempSync(path.join(tmpdir(), 'admin-compose-'));
        try {
            const freshDir = path.join(baseDir, 'fresh');
            const staleDir = path.join(baseDir, 'stale');
            mkdirSync(freshDir);
            mkdirSync(staleDir);
            writeFileSync(path.join(staleDir, 'old.log'), 'x');
            const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
            utimesSync(staleDir, tenDaysAgo, tenDaysAgo);

            const application = new AdminConsoleApplication();
            await (application as any).pruneComposeStageDirs(baseDir);

            expect(existsSync(freshDir)).toBe(true);
            expect(existsSync(staleDir)).toBe(false);
        } finally {
            rmSync(baseDir, { recursive: true, force: true });
        }
    });

    test('ignores a missing stage root instead of failing the compose', async () => {
        const application = new AdminConsoleApplication();
        const missing = path.join(tmpdir(), `admin-compose-missing-${Date.now()}`);
        await expect((application as any).pruneComposeStageDirs(missing)).resolves.toBeUndefined();
    });
});

describe('adminconsole server address handling', () => {
    test('keeps an explicitly uppercase scheme instead of prefixing https again', () => {
        const application = new AdminConsoleApplication();
        // 令牌存储保留用户原始输入，currentServer 的协议判断必须大小写不敏感
        (application as any).getTokenStore().setSession('HTTP://127.0.0.1:8788', 'token');
        expect((application as any).currentServer()).toBe('HTTP://127.0.0.1:8788');
    });

    test('verifyToken requests the uppercase scheme host as-is', async () => {
        const application = new AdminConsoleApplication();
        const requested: string[] = [];
        (application as any).fetchImpl = async (url: string) => {
            requested.push(String(url));
            return new Response(JSON.stringify({ ok: true, total: {}, last_1d: {}, last_7d: {} }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        };
        const result = await application.verifyToken('HTTP://127.0.0.1:8788', 'token');
        expect(result.status).toBe('ok');
        expect(requested).toHaveLength(1);
        expect(requested[0].startsWith('HTTP://127.0.0.1:8788')).toBe(true);
        expect(requested[0]).not.toContain('https://HTTP://');
    });
});

describe('adminconsole prepareTaskCompose', () => {
    function makeApp(rootDir: string, responses: Record<string, unknown>): AdminConsoleApplication {
        const application = new AdminConsoleApplication();
        (application as any).getDataDirectory = () => rootDir;
        (application as any).fetchImpl = async (url: string) => {
            const key = Object.keys(responses).find((pattern) => String(url).includes(pattern));
            if (!key) throw new Error(`unexpected url ${url}`);
            const body = responses[key];
            if (body instanceof Uint8Array) {
                return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
            }
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        };
        (application as any).getTokenStore().setSession('https://admin.example.com', 'token');
        return application;
    }

    const detail = {
        ok: true,
        item: {
            id: 7,
            type: 'bug',
            content: '打开设置页面崩溃',
            contact: null,
            time: '2026-11-20T08:00:00.000Z',
            attachments: [
                { attachment_id: 11, filename: 'opendesk-system.log' },
                { attachment_id: 12, filename: 'opendesk-task.json' }
            ]
        }
    };

    test('stages each click into a fresh directory so old tasks keep their files', async () => {
        const rootDir = mkdtempSync(path.join(tmpdir(), 'admin-compose-'));
        try {
            const application = makeApp(rootDir, {
                '/api/feedback/detail/7': detail,
                '/api/feedback/attachment/': new Uint8Array([1, 2, 3])
            });
            const first = await application.prepareTaskCompose('bug', 7);
            const second = await application.prepareTaskCompose('bug', 7);
            expect(first.status).toBe('ok');
            expect(second.status).toBe('ok');

            const firstPaths = (first.data as any).attachmentPaths as string[];
            const secondPaths = (second.data as any).attachmentPaths as string[];
            expect(firstPaths).toHaveLength(2);
            expect(secondPaths).toHaveLength(2);
            const feedbackDir = path.join(rootDir, 'task-compose', 'bug-7');
            expect(fs.readdirSync(feedbackDir)).toHaveLength(2);
            // 第二次点击不能复用（更不能清空）第一次的目录
            expect(path.dirname(firstPaths[0])).not.toBe(path.dirname(secondPaths[0]));
            for (const filePath of [...firstPaths, ...secondPaths]) {
                expect(fs.existsSync(filePath)).toBe(true);
                expect(fs.readFileSync(filePath)).toEqual(Buffer.from([1, 2, 3]));
            }
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    test('rejects invalid arguments before touching the network or disk', async () => {
        const rootDir = mkdtempSync(path.join(tmpdir(), 'admin-compose-'));
        try {
            const application = makeApp(rootDir, {});
            await expect(application.prepareTaskCompose('other' as any, 7)).resolves.toMatchObject({
                status: 'error'
            });
            await expect(application.prepareTaskCompose('bug', 0)).resolves.toMatchObject({ status: 'error' });
            await expect(application.prepareTaskCompose('bug', 1.5)).resolves.toMatchObject({ status: 'error' });
            expect(fs.existsSync(path.join(rootDir, 'task-compose'))).toBe(false);
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    test('surfaces detail fetch failures without staging anything', async () => {
        const rootDir = mkdtempSync(path.join(tmpdir(), 'admin-compose-'));
        try {
            const application = makeApp(rootDir, {
                '/api/feedback/detail/7': { ok: false, message: 'boom' }
            });
            const result = await application.prepareTaskCompose('bug', 7);
            expect(result.status).toBe('error');
            expect(fs.existsSync(path.join(rootDir, 'task-compose'))).toBe(false);
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    test('keeps going when one attachment download fails', async () => {
        const rootDir = mkdtempSync(path.join(tmpdir(), 'admin-compose-'));
        try {
            const application = new AdminConsoleApplication();
            (application as any).getDataDirectory = () => rootDir;
            (application as any).fetchImpl = async (url: string) => {
                if (String(url).includes('/api/feedback/detail/7')) {
                    return new Response(JSON.stringify(detail), { status: 200 });
                }
                if (String(url).includes('/attachment/11')) {
                    return new Response('nope', { status: 404 });
                }
                return new Response(new Uint8Array([9]), { status: 200 });
            };
            (application as any).getTokenStore().setSession('https://admin.example.com', 'token');

            const result = await application.prepareTaskCompose('bug', 7);
            expect(result.status).toBe('ok');
            expect((result.data as any).attachmentPaths).toHaveLength(1);
            expect((result.data as any).failedFilenames).toEqual(['opendesk-system.log']);
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });
});

describe('adminconsole wiring', () => {
    test('is registered as a platform application', () => {
        expect(getGuiApplicationClasses()).toContain(AdminConsoleApplication);
    });

    test('opens from the debug menu instead of a dedicated renderer overlay', () => {
        const debugMenuSource = sidebarSource.slice(
            sidebarSource.indexOf('_showDebugMenu(event) {'),
            sidebarSource.indexOf('_showTaskInfoModal(')
        );
        expect(debugMenuSource).toContain("this._t('renderer.toolbar.admin')");
        expect(debugMenuSource).toContain("openApplication('adminconsole')");
        expect(sidebarSource).not.toContain('openAdminPanel');
        expect(rendererHtml).not.toContain('openAdminPanel');
    });

    test('no longer exposes admin endpoints through global main-process IPC', () => {
        expect(mainSource).not.toContain("ipcMain.handle('admin:");
    });
});
