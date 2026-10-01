import { jest } from '@jest/globals';
import { enUs } from '../../../main/applications/terminal/locale/en-us.js';
import { zhCn } from '../../../main/applications/terminal/locale/zh-cn.js';

jest.unstable_mockModule('../../../main/applications/terminal/locale/index.js', () => ({
    t: (key: string) => enUs[key] ?? key
}));

const { appendSandboxPathDiagnostic, appendSandboxPipeDiagnostic } =
    await import('../../../main/applications/terminal/sandboxes/path-diagnostic.js');

describe('sandbox drive path diagnostic', () => {
    const hint = enUs['sandbox.pathErrorHint'];

    test.each([
        "Access to the path 'C:\\Users\\a\\file.txt' is denied.",
        'Get-Content : Access is denied: C:\\Users\\a\\file.txt',
        'D:/work/data.txt: UnauthorizedAccessException',
        '拒绝访问 C:\\Users\\a\\file.txt',
        '访问被拒绝 D:/work/data.txt',
        'EACCES: permission denied, open C:\\Temp\\data.txt'
    ])('appends the hint to a sandbox access denial: %s', (output) => {
        expect(appendSandboxPathDiagnostic(output, true)).toBe(`${output}\n\n${hint}`);
    });

    test.each([
        'Read C:\\Users\\a\\file.txt successfully',
        'Access is denied',
        'Access is denied: /C/Users/a/file.txt',
        'Permission denied: relative/path.txt'
    ])('does not infer a sandbox path failure from %s', (output) => {
        expect(appendSandboxPathDiagnostic(output, true)).toBe(output);
    });

    test('does not modify host shell errors or append the hint twice', () => {
        const output = 'Access is denied: C:\\Temp\\file.txt';
        expect(appendSandboxPathDiagnostic(output, false)).toBe(output);
        expect(appendSandboxPathDiagnostic(`${output}\n\n${hint}`, true)).toBe(`${output}\n\n${hint}`);
    });

    test('ignores the host path in a truncated-output artifact notice', () => {
        const output = `Access is denied\n${enUs['output.artifactSaved']}: C:\\Users\\a\\terminal.log`;
        expect(appendSandboxPathDiagnostic(output, true)).toBe(output);
    });

    test('provides localized guidance for both supported languages', () => {
        for (const translation of [zhCn, enUs]) {
            expect(translation['sandbox.pathErrorHint']).toMatch(/host drive paths|宿主盘符路径/i);
        }
    });
});

describe('sandbox named pipe diagnostic', () => {
    const hint = enUs['sandbox.pipeErrorHint'];

    test.each([
        String.raw`Error: listen EADDRINUSE: address already in use \\?\pipe\Z:\C\Users\a\AppData\Local\Temp\tsx-me\44876.pipe`,
        String.raw`Error: listen EACCES \\.\pipe\tsx-ipc: permission denied`,
        String.raw`tsx : Error { code: 'EADDRINUSE', address: '\\\\?\\pipe\\Z:\\ipc.pipe' }`
    ])('appends the pipe hint to a named pipe failure: %s', (output) => {
        expect(appendSandboxPipeDiagnostic(output, true)).toBe(`${output}\n\n${hint}`);
    });

    test.each([
        'listen EADDRINUSE: address already in use 127.0.0.1:8080',
        String.raw`EACCES: permission denied, open C:\Temp\data.txt`,
        'pipe connected successfully'
    ])('does not infer a pipe failure from %s', (output) => {
        expect(appendSandboxPipeDiagnostic(output, true)).toBe(output);
    });

    test('does not modify host shell errors or append the hint twice', () => {
        const output = String.raw`listen EADDRINUSE \\?\pipe\ipc`;
        expect(appendSandboxPipeDiagnostic(output, false)).toBe(output);
        expect(appendSandboxPipeDiagnostic(`${output}\n\n${hint}`, true)).toBe(`${output}\n\n${hint}`);
    });

    test('provides actionable localized guidance for both supported languages', () => {
        for (const translation of [zhCn, enUs]) {
            // Detours 实现普通令牌下命名管道可用：提示应说明可用性而非替代命令
            expect(translation['sandbox.pipeErrorHint']).toMatch(/named pipes|命名管道/);
        }
    });
});
