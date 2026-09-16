import { jest } from '@jest/globals';
import { enUs } from '../../../main/applications/terminal/locale/en-us.js';
import { zhCn } from '../../../main/applications/terminal/locale/zh-cn.js';

jest.unstable_mockModule('../../../main/applications/terminal/locale/index.js', () => ({
    t: (key: string) => enUs[key] ?? key
}));

const { appendSandboxPathDiagnostic } =
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
            expect(translation['sandbox.pathErrorHint']).toContain('/C/');
            expect(translation['sandbox.pathErrorHint']).toContain('/D/');
        }
    });
});
