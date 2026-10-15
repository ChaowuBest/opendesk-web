import { jest } from '@jest/globals';

jest.unstable_mockModule('../../../main/applications/terminal/shells/common.js', () => ({
    executeShellCommand: jest.fn(),
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

const { ExecuteBashTool } = await import('../../../main/applications/terminal/shells/bash.js');
const { ExecuteZshTool } = await import('../../../main/applications/terminal/shells/zsh.js');
const { ExecutePwshTool } = await import('../../../main/applications/terminal/shells/pwsh.js');

/**
 * 终端工具调用在界面上的标题取自 description；它必须是 required 参数，
 * 否则模型可以合法地省略它，标题会退化成整条命令。
 */
test.each([
    ['bash', () => new ExecuteBashTool('/bin/bash')],
    ['zsh', () => new ExecuteZshTool('/bin/zsh')],
    ['pwsh', () => new ExecutePwshTool('C:/shells/powershell.exe')]
])('%s 工具的 description 为必填参数', (_shell, createTool) => {
    const tool = createTool();
    const schema = tool.getJsonSchema();
    expect(schema['required']).toContain('description');
    expect(schema['properties']).toHaveProperty('description');

    expect(tool.validateArgs({ command: 'ls -la' }).success).toBe(false);

    const valid = tool.validateArgs({ command: 'ls -la', description: '列出目录文件' });
    expect(valid.success).toBe(true);
    if (valid.success) {
        expect(valid.data.description).toBe('列出目录文件');
    }
});
