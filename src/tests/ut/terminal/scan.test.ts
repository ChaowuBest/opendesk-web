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

test('darwin exposes all available supported kinds plus sandbox variants', () => {
    paths.set('zsh', '/bin/zsh');
    paths.set('bash', '/bin/bash');
    paths.set('pwsh', '/usr/local/bin/pwsh');
    const shells = scanSupportedShells('darwin', null);
    // zsh/bash 各注册普通与沙箱两个变体（darwin 沙箱组件随桌面安装包提供）
    expect(shells.map((shell) => `${shell.kind}:${shell.sandboxed}`)).toEqual([
        'zsh:false',
        'zsh:true',
        'bash:false',
        'bash:true',
        'powershell:false'
    ]);
    paths.clear();
    expect(scanSupportedShells('darwin', null)).toEqual([]);
});

// Linux 沙箱变体依赖：dynobox-linux 二进制存在 + 非特权 userns 可用
// （否则注册变体必然运行失败）。CI 未构建二进制或 userns 受限时跳过该断言。
const linuxSandboxAvailable = (() => {
    try {
        const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
        const usernsOk = spawnSync('unshare', ['-U', 'true'], { timeout: 3000 }).status === 0;
        if (!usernsOk) return false;
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const dev = path.join(
            process.env.INIT_CWD || process.cwd(),
            'native',
            'linux',
            'sandbox',
            'target',
            'release',
            'dynobox-linux'
        );
        return fs.existsSync(dev);
    } catch {
        return false;
    }
})();

(linuxSandboxAvailable ? test : test.skip)(
    'linux registers sandbox variants for bash/zsh when the binary is available',
    () => {
        paths.set('zsh', '/bin/zsh');
        paths.set('bash', '/bin/bash');
        paths.set('pwsh', '/usr/local/bin/pwsh');
        const shells = scanSupportedShells('linux', null);
        // zsh/bash 各注册普通与沙箱两个变体（开发环境二进制存在时）
        expect(shells.map((shell) => `${shell.kind}:${shell.sandboxed}`)).toEqual([
            'zsh:false',
            'zsh:true',
            'bash:false',
            'bash:true',
            'powershell:false'
        ]);
        paths.clear();
    }
);

test('OpenHarmony exposes shells and their sandbox variants (runtime ships with repo), keeps the tablet gate', () => {
    const state: any = {
        variant: 'pc',
        commands: { zsh: '/usr/bin/zsh', bash: '/data/service/hnp/bin/bash' },
        capabilities: { zsh: true, bash: true },
        status: 'available',
        missing: []
    };
    // repo 携带 runtime/aarch64-linux-ohos 产物（git 管理），且 openharmony 平台
    // 已接入动态沙箱：zsh/bash 各注册普通与沙箱变体（与 linux 分支一致）
    expect(scanSupportedShells('openharmony', state)).toEqual([
        { kind: 'zsh', path: '/usr/bin/zsh', sandboxed: false },
        { kind: 'zsh', path: '/usr/bin/zsh', sandboxed: true },
        { kind: 'bash', path: '/data/service/hnp/bin/bash', sandboxed: false },
        { kind: 'bash', path: '/data/service/hnp/bin/bash', sandboxed: true }
    ]);
    expect(scanSupportedShells('openharmony', { ...state, variant: 'tablet' })).toEqual([]);
    paths.set('bash', '/data/service/hnp/bin/bash');
    expect(scanSupportedShells('openharmony', null)).toEqual([
        { kind: 'bash', path: '/data/service/hnp/bin/bash', sandboxed: false },
        { kind: 'bash', path: '/data/service/hnp/bin/bash', sandboxed: true }
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
