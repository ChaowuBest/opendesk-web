import { jest } from '@jest/globals';
import { selectSupportedShell } from '../../../common/shells.js';

let taskConfig: Record<string, unknown> = {};
const afterSetDataCallbacks: Array<(previous: any, next: any) => void | Promise<void>> = [];
const shells = [
    { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: false },
    { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: true },
    { kind: 'bash', path: 'C:/Git/bash.exe', sandboxed: false },
    { kind: 'zsh', path: '/bin/zsh', sandboxed: false }
];
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    getLogDirectory: () => '/tmp/opendesk-test',
    Setting: class {
        static afterSetDataCallbacks = afterSetDataCallbacks;
        static getInstance() {
            return { data: { locale: 'zh-CN' }, getData: () => ({ task_config: taskConfig }) };
        }
    }
}));
jest.unstable_mockModule('../../../main/applications/base.js', () => ({ BaseApplication: class {} }));
const scan = jest.fn(() => shells);
jest.unstable_mockModule('../../../main/applications/terminal/scan.js', () => ({
    scanSupportedShells: scan,
    selectSupportedShell
}));
const launches: unknown[] = [];
function tool(name: string) {
    return class {
        name = name;
        constructor(...args: unknown[]) {
            launches.push({ name, args });
        }
    };
}
jest.unstable_mockModule('../../../main/applications/terminal/shells/pwsh.js', () => ({
    ExecutePwshTool: tool('executePwsh')
}));
jest.unstable_mockModule('../../../main/applications/terminal/shells/bash.js', () => ({
    ExecuteBashTool: tool('executeBash')
}));
jest.unstable_mockModule('../../../main/applications/terminal/shells/zsh.js', () => ({
    ExecuteZshTool: tool('executeZsh')
}));
jest.unstable_mockModule('../../../main/applications/terminal/shells/status.js', () => ({
    CheckShellStatusTool: tool('checkShellStatus')
}));
const { TerminalApplication } = await import('../../../main/applications/terminal/app.js');

test('only the selected execution tool and status tool are registered, using the exact selected path', async () => {
    const app = new TerminalApplication();
    for (const shell of shells) {
        taskConfig = { shell_path: shell.path, shell_sandboxed: shell.sandboxed };
        launches.length = 0;
        const [toolset] = await app.getToolsets();
        const name = { powershell: 'executePwsh', bash: 'executeBash', zsh: 'executeZsh' }[shell.kind];
        expect([...toolset.tools.keys()]).toEqual([name, 'checkShellStatus']);
        const args =
            shell.kind === 'powershell'
                ? [shell.path, shell.sandboxed, false]
                : shell.kind === 'zsh'
                  ? [shell.path, false, shell.sandboxed, false]
                  : [shell.path, shell.sandboxed, false];
        expect(launches[0]).toEqual({ name, args });
    }
    expect(scan).toHaveBeenCalledTimes(1);
});

test.each([{}, { shell_path: 'C:/missing.exe', shell_sandboxed: true }])(
    'unset or unavailable selection uses the first shell',
    async (config) => {
        taskConfig = config;
        const app = new TerminalApplication();
        launches.length = 0;
        const [toolset] = await app.getToolsets();
        expect([...toolset.tools.keys()]).toEqual(['executePwsh', 'checkShellStatus']);
        expect(launches[0]).toEqual({ name: 'executePwsh', args: [shells[0].path, false, false] });
    }
);

test('passes the recycle-bin preference only to an enabled sandboxed powershell', async () => {
    const app = new TerminalApplication();
    taskConfig = { shell_path: shells[1].path, shell_sandboxed: true, shell_sandbox_del_to_trash: true };
    launches.length = 0;
    await app.getToolsets();
    expect(launches[0]).toEqual({ name: 'executePwsh', args: [shells[1].path, true, true] });

    taskConfig = { shell_path: shells[0].path, shell_sandboxed: false, shell_sandbox_del_to_trash: true };
    launches.length = 0;
    await app.getToolsets();
    expect(launches[0]).toEqual({ name: 'executePwsh', args: [shells[0].path, false, false] });
});

test('empty discovery registers no terminal tools', async () => {
    scan.mockReturnValueOnce([]);
    expect(await new TerminalApplication().getToolsets()).toEqual([]);
});

test('a saved sandboxed selection falls back to the plain shell when the platform offers no sandbox variant', async () => {
    // CLI 平台不注册沙箱变体（见 scan.test.ts 的平台门控），桌面端保存的
    // shell_sandboxed: true 必须回退到同路径的普通 PowerShell，而不是报错
    taskConfig = { shell_path: 'C:/Windows/powershell.exe', shell_sandboxed: true, shell_sandbox_del_to_trash: true };
    scan.mockReturnValueOnce([
        { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: false },
        { kind: 'bash', path: 'C:/Git/bash.exe', sandboxed: false }
    ]);
    launches.length = 0;
    await new TerminalApplication().getToolsets();
    expect(launches[0]).toEqual({ name: 'executePwsh', args: ['C:/Windows/powershell.exe', false, false] });
    expect(launches[1]).toEqual({ name: 'checkShellStatus', args: ['powershell', false] });
});

test('reads the latest shell selection without registering an eager task refresh', async () => {
    const callbackCount = afterSetDataCallbacks.length;
    const app = new TerminalApplication();
    taskConfig = { shell_path: shells[0].path, shell_sandboxed: false };
    expect([...(await app.getToolsets())[0].tools.keys()]).toEqual(['executePwsh', 'checkShellStatus']);

    taskConfig = { shell_path: shells[2].path, shell_sandboxed: false };
    expect([...(await app.getToolsets())[0].tools.keys()]).toEqual(['executeBash', 'checkShellStatus']);
    expect(afterSetDataCallbacks).toHaveLength(callbackCount);
});
