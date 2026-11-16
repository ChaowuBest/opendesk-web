import { beforeEach, jest } from '@jest/globals';
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
    getOpendeskDirectory: () => '/tmp/opendesk-test',
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

beforeEach(() => {
    taskConfig = {};
    launches.length = 0;
    scan.mockReset();
    scan.mockReturnValue(shells);
});

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
    expect(scan).toHaveBeenCalledTimes(shells.length);
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

test('unlimited mode forces every shell to run without the sandbox and drops the recycle-bin preference', async () => {
    // 模拟 Linux/macOS/OpenHarmony 形态：bash、zsh 各有沙箱变体（LD_PRELOAD/DYLD/dynobox）
    const platformShells = [
        { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: false },
        { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: true },
        { kind: 'bash', path: '/bin/bash', sandboxed: false },
        { kind: 'bash', path: '/bin/bash', sandboxed: true },
        { kind: 'zsh', path: '/bin/zsh', sandboxed: false },
        { kind: 'zsh', path: '/bin/zsh', sandboxed: true }
    ];
    scan.mockReturnValue(platformShells);
    const app = new TerminalApplication();

    // Windows PowerShell 沙箱变体 + 回收站偏好：unlimited 下强制降级为非沙箱
    taskConfig = { shell_path: shells[1].path, shell_sandboxed: true, shell_sandbox_del_to_trash: true };
    launches.length = 0;
    await app.getToolsets({ activeModeId: 'unlimited' } as never);
    expect(launches[0]).toEqual({ name: 'executePwsh', args: [shells[1].path, false, false] });
    expect(launches[1]).toEqual({ name: 'checkShellStatus', args: ['powershell', false] });

    // Linux/macOS/OpenHarmony 的 bash 沙箱变体同样被禁用，回收站随沙箱失效
    taskConfig = { shell_path: '/bin/bash', shell_sandboxed: true, shell_sandbox_del_to_trash: true };
    launches.length = 0;
    await app.getToolsets({ activeModeId: 'unlimited' } as never);
    expect(launches[0]).toEqual({ name: 'executeBash', args: ['/bin/bash', false, false] });
    expect(launches[1]).toEqual({ name: 'checkShellStatus', args: ['bash', false] });

    // zsh（macOS/OpenHarmony 默认 shell）沙箱变体同样被禁用
    taskConfig = { shell_path: '/bin/zsh', shell_sandboxed: true, shell_sandbox_del_to_trash: true };
    launches.length = 0;
    await app.getToolsets({ activeModeId: 'unlimited' } as never);
    expect(launches[0]).toEqual({ name: 'executeZsh', args: ['/bin/zsh', false, false, false] });
    expect(launches[1]).toEqual({ name: 'checkShellStatus', args: ['zsh', false] });

    // 非 unlimited 模式（standard）不受影响：bash 沙箱变体与回收站偏好照常生效
    taskConfig = { shell_path: '/bin/bash', shell_sandboxed: true, shell_sandbox_del_to_trash: true };
    launches.length = 0;
    await app.getToolsets({ activeModeId: 'standard' } as never);
    expect(launches[0]).toEqual({ name: 'executeBash', args: ['/bin/bash', true, true] });
    expect(launches[1]).toEqual({ name: 'checkShellStatus', args: ['bash', true] });
});

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

test('the same application discovers a shell that becomes ready after its initial empty inventory', async () => {
    let available: typeof shells = [];
    scan.mockImplementation(() => available);
    const app = new TerminalApplication();

    expect(await app.getToolsets()).toEqual([]);
    expect(launches).toEqual([]);
    expect(scan).toHaveBeenCalledTimes(1);

    available = [{ kind: 'bash', path: '/host/runtime/bin/bash', sandboxed: false }];
    const recovered = await app.getToolsets();
    expect(recovered).toHaveLength(1);
    const [toolset] = recovered;
    expect([...toolset.tools.keys()]).toEqual(['executeBash', 'checkShellStatus']);
    expect(launches).toEqual([
        { name: 'executeBash', args: ['/host/runtime/bin/bash', false, false] },
        { name: 'checkShellStatus', args: ['bash', false] }
    ]);
    expect(scan).toHaveBeenCalledTimes(2);
});

test('the same application drops an unavailable shell and uses its new path on a later resolution', async () => {
    let available = [{ kind: 'bash', path: '/host/runtime-old/bin/bash', sandboxed: false }];
    scan.mockImplementation(() => available);
    const app = new TerminalApplication();
    taskConfig = { shell_path: available[0].path, shell_sandboxed: false };
    await app.getToolsets();
    expect(launches[0]).toEqual({ name: 'executeBash', args: ['/host/runtime-old/bin/bash', false, false] });

    available = [];
    launches.length = 0;
    expect(await app.getToolsets()).toEqual([]);
    expect(launches).toEqual([]);

    available = [{ kind: 'bash', path: '/host/runtime-new/bin/bash', sandboxed: false }];
    const [toolset] = await app.getToolsets();
    expect([...toolset.tools.keys()]).toEqual(['executeBash', 'checkShellStatus']);
    expect(launches[0]).toEqual({ name: 'executeBash', args: ['/host/runtime-new/bin/bash', false, false] });
    expect(scan).toHaveBeenCalledTimes(3);
});
