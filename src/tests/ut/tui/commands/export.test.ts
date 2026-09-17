import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SlashCommandRegistry } from '../../../../main/tui/commands/base';

const infoOverlays: Array<{ title: string; message: string; type?: string }> = [];

jest.unstable_mockModule('../../../../main/tui/components/notice.js', () => ({
    InfoOverlay: class {
        constructor(_tui: unknown, options: { title: string; message: string; type?: string }) {
            infoOverlays.push(options);
        }
        show() {}
    },
    ConfirmOverlay: class {
        constructor(_tui: unknown, _options: unknown) {}
        show(_onConfirm?: () => void) {}
    }
}));

interface ExportCommandFixture {
    registry: SlashCommandRegistry;
    htmlExportCalls: Array<{ task: unknown; absolutePath: string }>;
    setDoExportImpl: (impl: (task: unknown, absolutePath: string) => Promise<void>) => void;
}

interface TaskStub {
    task_id: string;
    ensureLoaded: () => void;
    toJSON: () => Record<string, unknown>;
}

function createTaskStub(): TaskStub {
    return {
        task_id: 'task-export-1',
        ensureLoaded: () => {},
        toJSON: () => ({ task_id: 'task-export-1', task_name: 'export bug repro' })
    };
}

async function setup(workspace: string): Promise<ExportCommandFixture> {
    const { registerExportCommand } = await import('../../../../main/tui/commands/export.js');
    const registry = new SlashCommandRegistry();
    const htmlExportCalls: Array<{ task: unknown; absolutePath: string }> = [];
    let doExportImpl = async (task: unknown, absolutePath: string) => {
        htmlExportCalls.push({ task, absolutePath });
    };
    const task = createTaskStub();
    const tui = {
        commandRegistry: registry,
        workspace,
        activeTaskId: task.task_id,
        taskManagerState: {
            getTask: (id: string) => (id === task.task_id ? task : undefined)
        },
        doExport: (exportTask: unknown, absolutePath: string) => doExportImpl(exportTask, absolutePath)
    };
    registerExportCommand(tui as never);
    return {
        registry,
        htmlExportCalls,
        setDoExportImpl: (impl) => {
            doExportImpl = impl;
        }
    };
}

describe('/export command path handling', () => {
    let savedUserProfile: string | undefined;
    let savedHome: string | undefined;
    let workspace: string;
    let fakeHome: string;
    let fixture: ExportCommandFixture;

    beforeEach(async () => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-export-cmd-'));
        fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-export-home-'));
        infoOverlays.length = 0;
        // getHomePath 运行时读取环境变量，用临时目录避免测试写真实用户目录
        savedUserProfile = process.env.USERPROFILE;
        savedHome = process.env.HOME;
        process.env.USERPROFILE = fakeHome;
        process.env.HOME = fakeHome;
        const { setRuntimeLocale } = await import('../../../../locale/index.js');
        setRuntimeLocale('en-US');
        fixture = await setup(workspace);
    });

    afterEach(async () => {
        const { setRuntimeLocale } = await import('../../../../locale/index.js');
        setRuntimeLocale(null);
        if (savedUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = savedUserProfile;
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(fakeHome, { recursive: true, force: true });
    });

    test('json export expands ~ to the home directory instead of writing under workspace/~', async () => {
        await fixture.registry.execute('/export json ~/slow_task.json');

        const expected = path.join(fakeHome, 'slow_task.json');
        expect(fs.existsSync(expected)).toBe(true);
        expect(JSON.parse(fs.readFileSync(expected, 'utf8'))).toMatchObject({ task_id: 'task-export-1' });
        // 不应把 ~ 当作 workspace 下的普通目录名
        expect(fs.existsSync(path.join(workspace, '~'))).toBe(false);
    });

    test('html export expands ~ to the home directory', async () => {
        await fixture.registry.execute('/export html ~/session.html');

        expect(fixture.htmlExportCalls).toHaveLength(1);
        expect(fixture.htmlExportCalls[0].absolutePath).toBe(path.join(fakeHome, 'session.html'));
    });

    test('json export creates missing parent directories', async () => {
        const target = path.join(workspace, 'nested', 'dir', 'task.json');

        await fixture.registry.execute(`/export json ${target}`);

        expect(fs.existsSync(target)).toBe(true);
    });

    test('json export failure does not reject (no fatal unhandledRejection) and shows error overlay', async () => {
        // 父目录位置被一个同名文件占据，mkdirSync/writeFileSync 必然失败
        const blocker = path.join(workspace, 'blocker');
        fs.writeFileSync(blocker, 'not a directory');
        const target = path.join(blocker, 'out.json');

        await expect(fixture.registry.execute(`/export json ${target}`)).resolves.toBe(true);

        const errorOverlay = infoOverlays.find((o) => o.type === 'error');
        expect(errorOverlay).toBeDefined();
        expect(fs.existsSync(target)).toBe(false);
    });

    test('html export failure does not reject and shows error overlay', async () => {
        fixture.setDoExportImpl(async () => {
            throw new Error('EACCES: permission denied, open out.html');
        });

        await expect(fixture.registry.execute('/export html out.html')).resolves.toBe(true);

        const errorOverlay = infoOverlays.find((o) => o.type === 'error');
        expect(errorOverlay).toBeDefined();
    });

    test('relative json export still writes under workspace', async () => {
        await fixture.registry.execute('/export json plain.json');

        expect(fs.existsSync(path.join(workspace, 'plain.json'))).toBe(true);
    });
});
