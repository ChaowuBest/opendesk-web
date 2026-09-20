import { jest } from '@jest/globals';
import { getPlatform, setPlatform, type AbstractPlatform } from '../../../platforms/base.js';

const paths = new Map<string, string>();
jest.unstable_mockModule('../../../main/utils/shellExec.js', () => ({
    findExecutableInPath: (name: string) => paths.get(name) ?? null,
    findExecutablesInPath: (name: string) => (paths.has(name) ? [paths.get(name)] : []),
    findOpenHarmonyZsh: () => paths.get('zsh') ?? null,
    findOpenHarmonyBash: () => paths.get('bash') ?? null
}));
const { scanSupportedShells, selectSupportedShell } = await import('../../../main/applications/terminal/scan.js');

const fakePlatform = (name: string): AbstractPlatform => ({ getName: () => name }) as unknown as AbstractPlatform;

beforeEach(() => paths.clear());

test('Windows exposes both pwsh executables and their sandbox variants with one kind', () => {
    paths.set('powershell', 'C:/Windows/powershell.exe');
    paths.set('pwsh', 'C:/Program Files/pwsh.exe');
    paths.set('bash', 'C:/Git/bash.exe');
    expect(scanSupportedShells('win32', null)).toEqual([
        { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: false },
        { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: true },
        { kind: 'powershell', path: 'C:/Program Files/pwsh.exe', sandboxed: false },
        { kind: 'powershell', path: 'C:/Program Files/pwsh.exe', sandboxed: true },
        { kind: 'bash', path: 'C:/Git/bash.exe', sandboxed: false }
    ]);
});

test('Windows does not advertise command wrappers that cannot be launched as a shell executable', () => {
    paths.set('pwsh', 'C:/tools/pwsh.cmd');
    expect(scanSupportedShells('win32', null)).toEqual([]);
});

test.each(['darwin', 'linux'])('%s exposes all available supported kinds without sandbox variants', (platform) => {
    paths.set('zsh', '/bin/zsh');
    paths.set('bash', '/bin/bash');
    paths.set('pwsh', '/usr/local/bin/pwsh');
    const shells = scanSupportedShells(platform, null);
    expect(shells.map((shell) => shell.kind)).toEqual(['zsh', 'bash', 'powershell']);
    expect(shells.every((shell) => shell.sandboxed === false)).toBe(true);
    paths.clear();
    expect(scanSupportedShells(platform, null)).toEqual([]);
});

test('OpenHarmony exposes both verified shells and keeps the tablet gate', () => {
    const state: any = {
        variant: 'pc',
        commands: { zsh: '/usr/bin/zsh', bash: '/data/service/hnp/bin/bash' },
        capabilities: { zsh: true, bash: true },
        status: 'available',
        missing: []
    };
    expect(scanSupportedShells('openharmony', state)).toEqual([
        { kind: 'zsh', path: '/usr/bin/zsh', sandboxed: false },
        { kind: 'bash', path: '/data/service/hnp/bin/bash', sandboxed: false }
    ]);
    expect(scanSupportedShells('openharmony', { ...state, variant: 'tablet' })).toEqual([]);
    paths.set('bash', '/data/service/hnp/bin/bash');
    expect(scanSupportedShells('openharmony', null)).toEqual([
        { kind: 'bash', path: '/data/service/hnp/bin/bash', sandboxed: false }
    ]);
});

test('selection matches path and sandbox together, and falls back to the first available shell', () => {
    paths.set('powershell', 'C:/Windows/powershell.exe');
    paths.set('bash', 'C:/Git/bash.exe');
    const shells = scanSupportedShells('win32', null);
    expect(
        selectSupportedShell(shells, { shell_path: 'c:\\WINDOWS\\powershell.exe', shell_sandboxed: true }, 'win32')
    ).toEqual(shells[1]);
    expect(selectSupportedShell(shells, {}, 'win32')).toEqual(shells[0]);
    expect(selectSupportedShell(shells, { shell_path: 'C:/removed.exe', shell_sandboxed: true }, 'win32')).toEqual(
        shells[0]
    );
    expect(selectSupportedShell(shells, { shell_path: 'C:/Git/bash.exe', shell_sandboxed: true }, 'win32')).toEqual(
        shells[2]
    );
    expect(selectSupportedShell([], {})).toBeNull();
});

test('a desktop platform keeps registering sandbox variants', () => {
    setPlatform(fakePlatform('electron'));
    paths.set('powershell', 'C:/Windows/powershell.exe');
    expect(scanSupportedShells('win32', null)).toEqual([
        { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: false },
        { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: true }
    ]);
});

test('CLI platform does not register sandbox variants, and a saved sandboxed selection falls back', () => {
    let previous: AbstractPlatform | null = null;
    try {
        previous = getPlatform();
    } catch {
        previous = null;
    }
    setPlatform(fakePlatform('cli'));
    try {
        paths.set('powershell', 'C:/Windows/powershell.exe');
        paths.set('pwsh', 'C:/Program Files/pwsh.exe');
        const shells = scanSupportedShells('win32', null);
        expect(shells).toEqual([
            { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: false },
            { kind: 'powershell', path: 'C:/Program Files/pwsh.exe', sandboxed: false }
        ]);
        // 桌面端保存的 shell_sandboxed: true 在 CLI 下回退到同路径的普通 shell
        expect(
            selectSupportedShell(shells, { shell_path: 'C:/Windows/powershell.exe', shell_sandboxed: true }, 'win32')
        ).toEqual(shells[0]);
    } finally {
        // 平台单例没有重置 API：恢复原有实例，原本未设置时以桌面平台占位
        setPlatform(previous ?? fakePlatform('electron'));
    }
});
