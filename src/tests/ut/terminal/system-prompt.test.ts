import { jest } from '@jest/globals';
import { enUs } from '../../../main/applications/terminal/locale/en-us.js';
import { zhCn } from '../../../main/applications/terminal/locale/zh-cn.js';

const translations: Record<string, string> = {
    'prompt.title': '# Terminal environment',
    'prompt.active': '- Active terminal: ${shell} (`${path}`)',
    'prompt.mode.host': '- Execution mode: host',
    'prompt.mode.sandbox': '- Execution mode: Windows dynamic sandbox',
    'prompt.sandbox.rootPaths':
        '- Use stable root-relative paths: /C/... maps to host C:/..., /D/... maps to host D:/..., and so on.',
    'prompt.sandbox.absolutePaths':
        '- Absolute paths in commands and PowerShell, Python, or Node.js scripts must use /<drive>/... form.',
    'prompt.sandbox.cwd':
        '- The sandbox working directory matches the task workspace; C:/foo becomes /C/foo, and relative paths resolve from there.',
    'prompt.sandbox.trash': '- Direct deletion sends files to the Windows Recycle Bin.'
};

jest.unstable_mockModule('../../../main/applications/terminal/locale/index.js', () => ({
    t: (key: string, params?: Record<string, string>) => {
        let value = translations[key] ?? key;
        for (const [name, replacement] of Object.entries(params ?? {})) {
            value = value.replaceAll(`\${${name}}`, replacement);
        }
        return value;
    }
}));

const { createTerminalSystemPromptContribution } = await import('../../../main/applications/terminal/prompt.js');

describe('terminal system prompt contribution', () => {
    test('localized sandbox instructions do not expose the internal root environment variable', () => {
        for (const translations of [zhCn, enUs]) {
            const promptText = Object.entries(translations)
                .filter(([key]) => key.startsWith('prompt.sandbox.'))
                .map(([, value]) => value)
                .join('\n');
            expect(promptText).not.toContain('SBX_ROOT');
        }
    });

    test.each([
        ['powershell', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
        ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe'],
        ['zsh', '/bin/zsh']
    ] as const)('describes the selected %s executable', (kind, shellPath) => {
        const contribution = createTerminalSystemPromptContribution({ kind, shellPath, sandboxed: false });

        expect(contribution.id).toBe('terminal.environment');
        expect(contribution.content).toContain(shellPath);
        expect(contribution.content).toContain('Execution mode: host');
        expect(contribution.content).not.toContain('SBX_ROOT');
    });

    test('uses stable root-relative paths for sandboxed powershell', () => {
        const contribution = createTerminalSystemPromptContribution({
            kind: 'powershell',
            shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
            sandboxed: true,
            deleteToTrash: true
        });

        expect(contribution.content).toContain('Windows dynamic sandbox');
        expect(contribution.content).toContain('/C/... maps to host C:/...');
        expect(contribution.content).toContain('/D/... maps to host D:/...');
        expect(contribution.content).toContain('PowerShell, Python, or Node.js scripts');
        expect(contribution.content).toContain('C:/foo becomes /C/foo');
        expect(contribution.content).not.toContain('SBX_ROOT');
        expect(contribution.content).not.toMatch(/[A-Z]:\/C\//);
        expect(contribution.content).toContain('Windows Recycle Bin');
    });
});
