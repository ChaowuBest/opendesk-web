import { setRuntimeLocale } from '../../../locale/index.js';
import {
    mapHostPathToSandboxRoot,
    sandboxRunArgs,
    withSandboxWorkingDirectory
} from '../../../main/applications/terminal/sandboxes/dynabox.js';

// 错误文案经真实 i18n 管道输出，语言随环境变化（CI 为 en-US），
// 固定为 zh-CN 使断言与运行环境解耦。
beforeAll(() => setRuntimeLocale('zh-CN'));
afterAll(() => setRuntimeLocale(null));

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

    test('envExtra 展开为 --env NAME=VALUE 且位于 -- 之前', () => {
        const args = sandboxRunArgs({
            ...base,
            envExtra: {
                npm_config_cache: 'C:/Users/x/.cache/opendesk-sandbox/npm',
                NODE_OPTIONS: '--preserve-symlinks'
            }
        });
        expect(args).toContain('--env');
        expect(args.filter((arg) => arg === '--env')).toHaveLength(2);
        expect(args).toContain('npm_config_cache=C:/Users/x/.cache/opendesk-sandbox/npm');
        expect(args).toContain('NODE_OPTIONS=--preserve-symlinks');
        // --env 参数对必须在 -- 分隔符之前
        const dashIdx = args.indexOf('--');
        expect(args.indexOf('--env')).toBeLessThan(dashIdx);
        expect(args.indexOf('npm_config_cache=C:/Users/x/.cache/opendesk-sandbox/npm')).toBeLessThan(dashIdx);
    });

    test('envExtra 缺省时不产生 --env 参数', () => {
        expect(sandboxRunArgs(base)).not.toContain('--env');
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

    test('validates the cwd is a mappable drive path but leaves shell args untouched', () => {
        // Detours 实现子进程直接使用宿主真实路径：cwd 经宿主 spawn 的 cwd 继承，
        // 不再注入 Set-Location（Dokan 卷语义已移除）。
        expect(
            withSandboxWorkingDirectory(
                'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
                ['-NoProfile', '-Command', 'Get-ChildItem .'],
                'C:\\foo bar'
            )
        ).toEqual(['-NoProfile', '-Command', 'Get-ChildItem .']);
    });

    test('bash shell args are left untouched for a mappable cwd', () => {
        expect(
            withSandboxWorkingDirectory('C:/Program Files/Git/bin/bash.exe', ['-c', 'ls -la'], 'D:\\workspace')
        ).toEqual(['-c', 'ls -la']);
    });

    test('rejects a non-drive cwd regardless of shell', () => {
        expect(() =>
            withSandboxWorkingDirectory('C:/Program Files/Git/bin/bash.exe', ['-c', 'pwd'], '\\\\server\\share')
        ).toThrow(/cwdUnsupported|沙箱工作目录/);
        expect(() =>
            withSandboxWorkingDirectory(
                'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
                ['-Command', 'pwd'],
                'relative/path'
            )
        ).toThrow();
    });
});
