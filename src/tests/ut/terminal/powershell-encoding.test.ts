import { jest } from '@jest/globals';

const execute = jest.fn(async (_options: any) => {});
jest.unstable_mockModule('../../../main/applications/terminal/shells/common.js', () => ({
    executeShellCommand: execute,
    getTaskWorkspace: () => 'D:/workspace',
    parseCdAndCommand: (command: string) => ({ command }),
    renderTerminalToolCall: jest.fn(),
    renderTerminalToolCallCli: jest.fn()
}));
jest.unstable_mockModule('../../../main/utils/shellExec.js', () => ({
    findExecutableInPath: (name: string) => `C:/shells/${name}.exe`,
    zshInteractiveHasExitTrapNoise: jest.fn()
}));
jest.unstable_mockModule('../../../main/applications/terminal/background.js', () => ({
    killProcessTree: jest.fn(),
    BackgroundProcessManager: class {}
}));
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    getLogDirectory: () => '/tmp/opendesk-test/logs',
    Setting: class {
        static getInstance() {
            return { data: { locale: 'zh-CN' }, getEffectiveWorkspace: () => 'D:/workspace' };
        }
    }
}));
const { ExecutePwshTool } = await import('../../../main/applications/terminal/shells/pwsh.js');

test('powershell tool injects UTF-8 defaults for Get-Content to fix ANSI mojibake', async () => {
    const tool = new ExecutePwshTool('C:/shells/powershell.exe');
    await tool.executeCommand({ command: 'Get-Content src/a.ts', timeout: 30000 }, {} as any);

    const args = execute.mock.lastCall![0].shellArgs as string[];
    const sentCommand = args[args.indexOf('-Command') + 1] as string;
    expect(sentCommand).toContain("$PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'");
    // 前缀必须位于用户命令之前才能生效
    expect(sentCommand.indexOf('Get-Content:Encoding')).toBeLessThan(sentCommand.indexOf('Get-Content src/a.ts'));
});
