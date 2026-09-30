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
        '- Absolute paths in commands and PowerShell, Python, or Node.js scripts use host drive paths (C:/X) directly; policy and approvals map through the root-relative convention /C/....',
    'prompt.sandbox.cwd':
        '- The sandbox working directory matches the task workspace (host real path, e.g. C:/foo); relative paths resolve from there.',
    'prompt.sandbox.trash':
        '- Deletions are always moved to the Windows Recycle Bin (same semantics as the Linux/OHOS sandbox).'
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

    test('trash instructions state that deletions always go to the Recycle Bin', () => {
        // Detours 实现与 Linux/OHOS 对齐：删除一律送回收站，不区分实例内新建
        // （Dokan 版的"实例内创建跟踪"语义已移除）。两条语言都要表达这一点。
        expect(enUs['prompt.sandbox.trash']).toMatch(/always moved to the Windows Recycle Bin/i);
        expect(enUs['prompt.sandbox.trash']).not.toContain('removed permanently');
        expect(zhCn['prompt.sandbox.trash']).toContain('一律送入 Windows 回收站');
        expect(zhCn['prompt.sandbox.trash']).not.toContain('直接清除');
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
        expect(contribution.content).toMatch(/host real path|host drive paths/);
        expect(contribution.content).not.toContain('SBX_ROOT');
        expect(contribution.content).not.toMatch(/[A-Z]:\/C\//);
        expect(contribution.content).toContain('Windows Recycle Bin');
    });
});
