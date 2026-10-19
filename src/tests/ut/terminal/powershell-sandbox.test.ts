import { jest } from '@jest/globals';

const execute = jest.fn(async (_options: any) => {});
const findExecutable = jest.fn((name: string) => `C:/shells/${name}.exe`);
jest.unstable_mockModule('../../../main/applications/terminal/shells/common.js', () => ({
    executeShellCommand: execute,
    getTaskWorkspace: () => 'D:/workspace',
    parseCdAndCommand: (command: string) => ({ command }),
    renderTerminalToolCall: jest.fn(),
    renderTerminalToolCallCli: jest.fn()
}));
jest.unstable_mockModule('../../../main/utils/shellExec.js', () => ({
    findExecutableInPath: findExecutable,
    zshInteractiveHasExitTrapNoise: jest.fn()
}));
jest.unstable_mockModule('../../../main/applications/terminal/background.js', () => ({
    killProcessTree: jest.fn(),
    BackgroundProcessManager: class {},
    SILENT_OUTPUT_HINT_ELAPSED_MS: 5 * 60 * 1000,
    silentBackgroundHint: (command: string) => `silent hint for ${command}`
}));
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    getLogDirectory: () => '/tmp/opendesk-test/logs',
    Setting: class {
        static getInstance() {
            return { data: { locale: 'zh-CN' }, getEffectiveWorkspace: () => 'D:/workspace' };
        }
    }
}));
const { ExecutePwshTool, normalizeSandboxPwshArgs } =
    await import('../../../main/applications/terminal/shells/pwsh.js');
const { ExecuteBashTool } = await import('../../../main/applications/terminal/shells/bash.js');
const { ExecuteZshTool } = await import('../../../main/applications/terminal/shells/zsh.js');
const { CheckShellStatusTool } = await import('../../../main/applications/terminal/shells/status.js');

test('only sandboxed shell tools opt into the BaseTool serial execution queue', () => {
    expect(new ExecutePwshTool('C:/shells/powershell.exe').serialExecution).toBe(false);
    expect(new ExecutePwshTool('C:/shells/pwsh.exe', true).serialExecution).toBe(true);
    expect(new ExecuteBashTool('/bin/bash').serialExecution).toBe(false);
    expect(new ExecuteZshTool('/bin/zsh').serialExecution).toBe(false);
    expect(new CheckShellStatusTool('powershell', false).serialExecution).toBe(false);
    expect(new CheckShellStatusTool('powershell', true).serialExecution).toBe(true);
});

test('sandbox powershell accepts stable root-relative working directories', () => {
    expect(
        normalizeSandboxPwshArgs({
            command: 'Get-ChildItem .',
            description: '列出当前目录内容',
            workingDirectory: '/D/workspace',
            timeout: 30000
        })
    ).toMatchObject({ command: 'Get-ChildItem .', workingDirectory: 'D:/workspace' });
});

test.each(['win32', 'linux', 'darwin'])(
    'uses the exact selected executable on %s; sandbox only on Windows',
    async (platform) => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        try {
            for (const shellPath of ['C:/shells/pwsh.exe', 'C:/shells/powershell.exe']) {
                const tool = new ExecutePwshTool(shellPath, true);
                expect(tool.name).toBe('executePwsh');
                await tool.executeCommand(
                    { command: 'Get-Date', description: '查看当前时间', timeout: 30000 },
                    {} as any
                );
                expect(execute).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        shellPath,
                        useDynamicSandbox: platform === 'win32'
                    })
                );
                const shellArgs = execute.mock.lastCall![0].shellArgs as string[];
                expect(shellArgs[shellArgs.indexOf('-Command') + 1].includes('chcp')).toBe(platform === 'win32');
                // Windows 的 AppContainer 读不到用户执行策略时按 Restricted 处理，
                // npx.ps1 等 npm shim 会被 AuthorizationManager 拦截；进程级 Bypass 绕开
                if (platform === 'win32') {
                    expect(shellArgs.slice(0, 2)).toEqual(['-ExecutionPolicy', 'Bypass']);
                } else {
                    expect(shellArgs[0]).toBe('-NoProfile');
                    expect(shellArgs).not.toContain('-ExecutionPolicy');
                }
            }
            expect(findExecutable).not.toHaveBeenCalled();
        } finally {
            Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        }
    }
);

test('forwards the recycle-bin preference only while the dynamic sandbox is active', async () => {
    const originalPlatform = process.platform;
    try {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const run = (tool: InstanceType<typeof ExecutePwshTool>) =>
            tool.executeCommand({ command: 'Get-Date', description: '查看当前时间', timeout: 30000 }, {} as any);

        await run(new ExecutePwshTool('C:/shells/powershell.exe', true, true));
        expect(execute).toHaveBeenLastCalledWith(
            expect.objectContaining({ useDynamicSandbox: true, sandboxDeleteToTrash: true })
        );

        // 未开启偏好时保持默认关闭
        await run(new ExecutePwshTool('C:/shells/powershell.exe', true));
        expect(execute.mock.lastCall![0].sandboxDeleteToTrash).toBe(false);

        // 非沙箱工具不透传该偏好
        await run(new ExecutePwshTool('C:/shells/powershell.exe', false, true));
        expect(execute).toHaveBeenLastCalledWith(
            expect.objectContaining({ useDynamicSandbox: false, sandboxDeleteToTrash: false })
        );

        // 沙箱只在 Windows 激活；非 Windows 上偏好随沙箱一并关闭
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        await run(new ExecutePwshTool('C:/shells/powershell.exe', true, true));
        expect(execute.mock.lastCall![0]).toMatchObject({ useDynamicSandbox: false, sandboxDeleteToTrash: false });
    } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
});
