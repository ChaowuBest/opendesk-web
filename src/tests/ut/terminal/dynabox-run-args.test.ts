import { sandboxRunArgs } from '../../../main/applications/terminal/sandboxes/dynabox.js';

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
