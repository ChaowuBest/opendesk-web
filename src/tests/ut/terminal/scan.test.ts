import { jest } from '@jest/globals';
import { getPlatform, setPlatform, type AbstractPlatform } from '../../../platforms/base.js';

const paths = new Map<string, string>();
jest.unstable_mockModule('../../../main/utils/shellExec.js', () => ({
    findExecutableInPath: (name: string) => paths.get(name) ?? null,
    findExecutablesInPath: (name: string) => (paths.has(name) ? [paths.get(name)] : []),
    findOpenHarmonyZsh: () => paths.get('zsh') ?? null,
    findOpenHarmonyBash: () => paths.get('bash') ?? null
}));
// 沙箱组件探测：测试按需切换"组件是否随包"，避免依赖本机是否构建过产物
const sandboxComponents = { windows: true, darwin: true };
jest.unstable_mockModule('../../../main/applications/terminal/sandboxes/dynabox.js', () => ({
    resolveWindowsSandboxExecutable: () => (sandboxComponents.windows ? 'sandbox/sandbox.exe' : null)
}));
jest.unstable_mockModule('../../../main/applications/terminal/sandboxes/darwin-sandbox.js', () => ({
    resolveDarwinSandboxDylib: () => (sandboxComponents.darwin ? 'sandbox/dynobox-darwin.dylib' : null)
}));
const { scanSupportedShells, selectSupportedShell, isSandboxRuntimeAvailable } =
    await import('../../../main/applications/terminal/scan.js');
const { resolveOpenHarmonySandboxExecutable } =
    await import('../../../main/applications/terminal/sandboxes/resolve-ohos.js');

const fakePlatform = (name: string): AbstractPlatform => ({ getName: () => name }) as unknown as AbstractPlatform;

beforeEach(() => {
    paths.clear();
    sandboxComponents.windows = true;
    sandboxComponents.darwin = true;
});

test('Windows exposes pwsh sandbox variants but keeps bash unsandboxed (cygwin is detours-incompatible)', () => {
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

test('Windows hides sandbox variants when the sandbox executable is missing', () => {
    paths.set('powershell', 'C:/Windows/powershell.exe');
    sandboxComponents.windows = false;
    expect(isSandboxRuntimeAvailable('win32')).toBe(false);
    expect(scanSupportedShells('win32', null)).toEqual([
        { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: false }
    ]);
});

test('darwin hides sandbox variants when the sandbox dylib is missing', () => {
    paths.set('zsh', '/bin/zsh');
    sandboxComponents.darwin = false;
    expect(isSandboxRuntimeAvailable('darwin')).toBe(false);
    expect(scanSupportedShells('darwin', null)).toEqual([{ kind: 'zsh', path: '/bin/zsh', sandboxed: false }]);
});

test('CLI mode never advertises sandbox variants even when desktop components exist', () => {
    paths.set('powershell', 'C:/Windows/powershell.exe');
    setPlatform(fakePlatform('cli'));
    try {
        expect(isSandboxRuntimeAvailable('win32')).toBe(false);
        expect(scanSupportedShells('win32', null)).toEqual([
            { kind: 'powershell', path: 'C:/Windows/powershell.exe', sandboxed: false }
        ]);
    } finally {
        setPlatform(fakePlatform('electron'));
    }
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

// Linux 沙箱变体依赖：LD_PRELOAD 版产物存在（dynobox + 同目录 libdynobox.so，
// launcher 在自身目录查找 .so）。LD_PRELOAD 版无需 userns/fuse 探测。
// CI 未构建产物时跳过该断言。
const linuxSandboxAvailable = (() => {
    try {
        const fs = require('node:fs') as typeof import('node:fs');
        const path = require('node:path') as typeof import('node:path');
        const { linuxRuntimeTriple } =
            require('../../../main/applications/terminal/sandboxes/linux-sandbox.js') as typeof import('../../../main/applications/terminal/sandboxes/linux-sandbox.js');
        const runtimeDir = path.join(
            process.env.INIT_CWD || process.cwd(),
            'native',
            'linux',
            'sandbox',
            'runtime',
            linuxRuntimeTriple()
        );
        return fs.existsSync(path.join(runtimeDir, 'dynobox')) && fs.existsSync(path.join(runtimeDir, 'libdynobox.so'));
    } catch {
        return false;
    }
})();

(linuxSandboxAvailable ? test : test.skip)(
    'linux registers sandbox variants for bash/zsh when the LD_PRELOAD artifacts are available',
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

test('OpenHarmony exposes shells and their sandbox variants (gated on local runtime build), keeps the tablet gate', () => {
    const state: any = {
        variant: 'pc',
        commands: { zsh: '/usr/bin/zsh', bash: '/data/service/hnp/bin/bash' },
        capabilities: { zsh: true, bash: true },
        status: 'available',
        missing: []
    };
    // 沙箱变体是否注册取决于本机是否已有 runtime/aarch64-linux-ohos 产物：
    // 产物不入库，由 `make runtime` 现场构建。这里用与 scan.ts 的
    // sandboxVariantsAvailable 完全相同的解析（OPENDESK_DYNOBOX_BIN →
    // /data/app/bin/dynobox → resources/sandbox → 仓库 runtime）做双态断言，
    // 保证 CI/新 clone（无产物）与本地开发机（已构建）都成立。
    const hasSandbox = resolveOpenHarmonySandboxExecutable() !== null;
    const variants = (kind: 'zsh' | 'bash', p: string) =>
        hasSandbox
            ? [
                  { kind, path: p, sandboxed: false },
                  { kind, path: p, sandboxed: true }
              ]
            : [{ kind, path: p, sandboxed: false }];
    expect(scanSupportedShells('openharmony', state)).toEqual([
        ...variants('zsh', '/usr/bin/zsh'),
        ...variants('bash', '/data/service/hnp/bin/bash')
    ]);
    expect(scanSupportedShells('openharmony', { ...state, variant: 'tablet' })).toEqual([]);
    paths.set('bash', '/data/service/hnp/bin/bash');
    expect(scanSupportedShells('openharmony', null)).toEqual(variants('bash', '/data/service/hnp/bin/bash'));
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
    // Windows 不再为 bash 注册沙箱变体（cygwin 与 detours 不兼容）：存量"bash+沙箱"
    //     配置回退到同路径的非沙箱 bash（cygwin 本就不受管控，见 README 已知限制）
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
