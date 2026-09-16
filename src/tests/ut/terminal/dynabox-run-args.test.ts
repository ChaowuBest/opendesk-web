import {
    mapHostPathToSandboxRoot,
    sandboxRunArgs,
    withSandboxWorkingDirectory
} from '../../../main/applications/terminal/sandboxes/dynabox.js';

describe('sandboxRunArgs', () => {
    const base = {
        policyPath: 'C:/od/dynamic-sandbox-x.toml',
        endpoint: 'http://127.0.0.1:1/decide',
        logPath: 'C:/od/logs/dynamic-sandbox-x.log',
        childCommand: '"C:/Windows/powershell.exe" -Command Get-Date'
    };

    test('默认不携带 --del-to-trash，子命令位于 -- 之后', () => {
        const args = sandboxRunArgs(base);
        expect(args).not.toContain('--del-to-trash');
        expect(args[0]).toBe('run');
        expect(args[1]).toBe('--automount');
        expect(args[args.length - 2]).toBe('--');
        expect(args[args.length - 1]).toBe(base.childCommand);
    });

    test('deleteToTrash 开启时在 -- 之前追加 --del-to-trash', () => {
        const args = sandboxRunArgs({ ...base, deleteToTrash: true });
        expect(args).toContain('--del-to-trash');
        expect(args.indexOf('--del-to-trash')).toBeGreaterThan(args.indexOf('--automount'));
        expect(args.indexOf('--del-to-trash')).toBeLessThan(args.indexOf('--policy'));
        expect(args.indexOf('--del-to-trash')).toBeLessThan(args.indexOf('--'));
        expect(args.filter((arg) => arg === '--del-to-trash')).toHaveLength(1);
    });

    test('deleteToTrash 为 false 与缺省一致', () => {
        expect(sandboxRunArgs({ ...base, deleteToTrash: false })).toEqual(sandboxRunArgs(base));
    });
});

describe('sandbox working directory', () => {
    test.each([
        ['C:\\foo\\bar', '/C/foo/bar'],
        ['d:/workspace', '/D/workspace'],
        ['E:\\', '/E/']
    ])('maps host path %s to stable sandbox path %s', (hostPath, sandboxPath) => {
        expect(mapHostPathToSandboxRoot(hostPath)).toBe(sandboxPath);
    });

    test('rejects paths that cannot be represented by automount', () => {
        expect(mapHostPathToSandboxRoot('relative/path')).toBeNull();
        expect(mapHostPathToSandboxRoot('\\\\server\\share')).toBeNull();
    });

    test('enters the mapped task workspace before running a PowerShell command', () => {
        expect(
            withSandboxWorkingDirectory(
                'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
                ['-NoProfile', '-Command', 'Get-ChildItem .'],
                'C:\\foo bar'
            )
        ).toEqual(['-NoProfile', '-Command', "Set-Location -LiteralPath '/C/foo bar'; Get-ChildItem ."]);
    });

    test('escapes apostrophes in the mapped PowerShell working directory', () => {
        expect(
            withSandboxWorkingDirectory(
                'C:/Program Files/PowerShell/7/pwsh.exe',
                ['-NoProfile', '-Command', 'Get-Location'],
                "D:/team's/work"
            )[2]
        ).toBe("Set-Location -LiteralPath '/D/team''s/work'; Get-Location");
    });
});
