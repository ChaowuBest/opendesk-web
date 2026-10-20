import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// setting.ts 含 create(import.meta.url) 写法，ts-jest 编译为 CJS 后与 require 标识符冲突，mock 掉
// （status.ts 经 background.ts 与 app 级 locale 依赖 setting.ts）
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: class {
        static getInstance() {
            return {
                data: { locale: 'zh-CN' },
                getData: () => ({ locale: 'zh-CN' }),
                getEffectiveWorkspace: () => '/'
            };
        }
    },
    getOpendeskDirectory: () => '/tmp/opendesk-test'
}));

const { BackgroundProcessManager, SILENT_OUTPUT_HINT_ELAPSED_MS } =
    await import('../../../main/applications/terminal/background.js');
const { CheckShellStatusTool } = await import('../../../main/applications/terminal/shells/status.js');

function makeProcess(pid: number): ChildProcess {
    return Object.assign(new EventEmitter(), {
        pid,
        stdout: new EventEmitter(),
        stderr: new EventEmitter()
    }) as unknown as ChildProcess;
}

function registerBackground(pid: number, command: string, output: string, elapsedMs: number): void {
    const entry = BackgroundProcessManager.getInstance().getStatus(pid);
    if (entry.found) return;
    BackgroundProcessManager.getInstance().register(makeProcess(pid), command, output, Date.now() - elapsedMs);
}

describe('CheckShellStatusTool silent output hints', () => {
    const tool = new CheckShellStatusTool('powershell', false);

    const runCheck = async (pid: number): Promise<string> => {
        const updateResult = jest.fn();
        await tool.executeCheck(
            { pid, kill: false, waitMs: 0 } as any,
            {
                updateResult
            } as any,
            undefined
        );
        return updateResult.mock.lastCall![0] as string;
    };

    test('appends a buffered-pipeline hint after long silence on a piped command', async () => {
        registerBackground(
            777001,
            'npm run build-cli 2>&1 | Select-Object -Last 6',
            '',
            SILENT_OUTPUT_HINT_ELAPSED_MS + 60_000
        );

        const message = await runCheck(777001);
        expect(message).toContain('仍在执行中');
        expect(message).toContain('(暂无输出)');
        expect(message).toContain('Select-Object');
        expect(message).toContain('不代表卡死');
    });

    test('appends a generic silence hint after long silence on a non-buffering command', async () => {
        registerBackground(777002, 'long-running-build', '', SILENT_OUTPUT_HINT_ELAPSED_MS + 60_000);

        const message = await runCheck(777002);
        expect(message).toContain('没有任何输出');
        expect(message).toContain('kill=true');
        expect(message).not.toContain('不代表卡死');
    });

    test('no hint while the process is younger than the silence threshold', async () => {
        registerBackground(777003, 'long-running-build', '', 10_000);

        const message = await runCheck(777003);
        expect(message).toContain('仍在执行中');
        expect(message).not.toContain('没有任何输出');
        expect(message).not.toContain('不代表卡死');
    });

    test('no hint when the backgrounded process already produced output', async () => {
        registerBackground(
            777004,
            'npm run build-cli 2>&1 | Select-Object -Last 6',
            'built in 12s',
            SILENT_OUTPUT_HINT_ELAPSED_MS + 60_000
        );

        const message = await runCheck(777004);
        expect(message).toContain('built in 12s');
        expect(message).not.toContain('不代表卡死');
        expect(message).not.toContain('没有任何输出');
    });
});
