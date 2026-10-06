import { jest } from '@jest/globals';
import { enUs } from '../../../main/applications/terminal/locale/en-us.js';
import { zhCn } from '../../../main/applications/terminal/locale/zh-cn.js';

const translations: Record<string, string> = {
    'prompt.title': '# Terminal environment',
    'prompt.active': '- Active terminal: ${shell} (`${path}`)',
    'prompt.shell.powershell': 'PowerShell',
    'prompt.shell.bash': 'Bash',
    'prompt.mode.host': '- Execution mode: host',
    'prompt.mode.sandbox': '- Execution mode: Windows dynamic sandbox',
    'prompt.mode.sandbox.linux': '- Execution mode: Linux dynamic sandbox',
    'prompt.sandbox.rootPaths':
        '- Use stable root-relative paths: /C/... maps to host C:/..., /D/... maps to host D:/..., and so on.',
    'prompt.sandbox.absolutePaths':
        '- Absolute paths in commands and PowerShell, Python, or Node.js scripts use host drive paths (C:/X) directly; policy and approvals map through the root-relative convention /C/....',
    'prompt.sandbox.cwd':
        '- The sandbox working directory matches the task workspace (host real path, e.g. C:/foo); relative paths resolve from there.',
    'prompt.sandbox.trash':
        '- Deletions are always moved to the OpenDesk file trash (unified trash; files created within this sandbox instance are removed permanently).',
    'prompt.sandbox.linux.transparent': '- transparent path semantics',
    'prompt.sandbox.linux.workspace': '- workspace writes, system dirs read-only',
    'prompt.sandbox.linux.system': '- system dirs mounted read-only from the host'
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

    test('trash instructions state that deletions go to the OpenDesk file trash', () => {
        // 统一回收站：删除送 OpenDesk 文件回收站（可在 GUI 中找回），实例内新建
        // 的文件删除时直接清除。两条语言都要表达这一点。
        expect(enUs['prompt.sandbox.trash']).toMatch(/OpenDesk file trash/i);
        expect(enUs['prompt.sandbox.trash']).toContain('removed permanently');
        expect(zhCn['prompt.sandbox.trash']).toContain('OpenDesk 文件回收站');
        expect(zhCn['prompt.sandbox.trash']).toContain('直接清除');
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
        // platform 缺省取 process.platform；不显式传 win32 的话，Linux CI 会走
        // Linux 沙箱分支而非 Windows 动态沙箱分支。
        const contribution = createTerminalSystemPromptContribution({
            kind: 'powershell',
            shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
            sandboxed: true,
            deleteToTrash: true,
            platform: 'win32'
        });

        expect(contribution.content).toContain('Windows dynamic sandbox');
        expect(contribution.content).toContain('/C/... maps to host C:/...');
        expect(contribution.content).toContain('/D/... maps to host D:/...');
        expect(contribution.content).toContain('PowerShell, Python, or Node.js scripts');
        expect(contribution.content).toMatch(/host real path|host drive paths/);
        expect(contribution.content).not.toContain('SBX_ROOT');
        expect(contribution.content).not.toMatch(/[A-Z]:\/C\//);
        expect(contribution.content).toContain('OpenDesk file trash');
    });

    test('uses transparent-path semantics for sandboxed linux shells', () => {
        const contribution = createTerminalSystemPromptContribution({
            kind: 'bash',
            shellPath: '/bin/bash',
            sandboxed: true,
            platform: 'linux'
        });

        expect(contribution.content).toContain('Linux dynamic sandbox');
        expect(contribution.content).toContain('transparent path semantics');
        expect(contribution.content).toContain('system dirs mounted read-only from the host');
        expect(contribution.content).not.toContain('SBX_ROOT');
        // 分支内所有条目都必须命中 mock 译文，不允许裸 i18n key 泄漏进提示词
        expect(contribution.content).not.toMatch(/prompt\./);
    });

    test('linux sandbox prompt keys exist in both real locale dictionaries', () => {
        // 回归：prompt.ts 的 Linux 分支引用 prompt.sandbox.linux.system，
        // 曾在 zh-cn/en-us 中同时缺失，导致线上提示词漏出裸 key。
        for (const key of [
            'prompt.mode.sandbox.linux',
            'prompt.sandbox.linux.transparent',
            'prompt.sandbox.linux.workspace',
            'prompt.sandbox.linux.system'
        ]) {
            expect(zhCn[key]).toBeTruthy();
            expect(enUs[key]).toBeTruthy();
        }
    });
});
