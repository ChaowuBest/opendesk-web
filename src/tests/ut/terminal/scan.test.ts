import { jest } from '@jest/globals';

const paths = new Map<string, string>();
jest.unstable_mockModule('../../../main/utils/shellExec.js', () => ({
    findExecutableInPath: (name: string) => paths.get(name) ?? null,
    findExecutablesInPath: (name: string) => (paths.has(name) ? [paths.get(name)] : []),
    findOpenHarmonyZsh: () => paths.get('zsh') ?? null,
    findOpenHarmonyBash: () => paths.get('bash') ?? null
}));
const { scanSupportedShells, selectSupportedShell } = await import('../../../main/applications/terminal/scan.js');

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
