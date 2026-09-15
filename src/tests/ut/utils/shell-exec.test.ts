import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import type { ChildProcess, SpawnSyncReturns } from 'child_process';

// setting.ts 含 create(import.meta.url) 写法，ts-jest 编译为 CJS 后与 require 标识符冲突；
// platforms/base.js 会拉入 BaseApplication 深链，两者均与 shell 探测逻辑无关，mock 掉。
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: class {
        static getInstance() {
            throw new Error('Setting not initialized in test');
        }
    },
    getOpendeskDirectory: () => '/tmp/opendesk-test'
}));

jest.unstable_mockModule('../../../platforms/base.js', () => ({
    getPlatform: () => {
        throw new Error('Platform is not set');
    }
}));

const spawnMock = jest.fn();
const spawnSyncMock = jest.fn();

jest.unstable_mockModule('child_process', () => ({
    spawn: (...args: unknown[]) => spawnMock(...args),
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args)
}));

// findExecutableInPath 依赖 fs.existsSync/fs.accessSync 判定可执行文件是否存在；
// spawnSync 用于验证 shell 真实可运行（排除 "Error relocating" 类运行时失败）。
// ESM 下 namespace 不可变、spyOn 不生效，因此整体 mock fs 模块。
// OpenHarmony zsh 固定采用 /usr/bin/zsh，存在性由 accessSync 判定；
// existsSync 仅服务于 bash 的 PATH 回退查找。
const ZSH_PATH = '/usr/bin/zsh';

// findExecutableInPath 内部用 path.join 拼路径，Windows 下产生反斜杠分隔符；
// mock 与断言统一归一化为 POSIX 风格，保证测试在任意平台行为一致
const toPosix = (p: unknown): string => (typeof p === 'string' ? p.replace(/\\/g, '/') : '');

const existsSyncMock = jest.fn((p: unknown) => ['zsh', 'bash'].some((name) => toPosix(p).endsWith(`/${name}`)));
const accessSyncMock = jest.fn(() => undefined);

jest.unstable_mockModule('fs', () => {
    const fsMock = {
        existsSync: (p: unknown) => existsSyncMock(p),
        accessSync: (...args: unknown[]) => accessSyncMock(...args),
        mkdirSync: () => undefined,
        constants: { X_OK: 1 }
    };
    return { ...fsMock, default: fsMock };
});

const {
    asyncShellExec,
    filterShellEnvironmentWarnings,
    findOpenHarmonyZsh,
    findExecutablesInPath,
    getDefaultShell,
    shellExec,
    clearDefaultShellCache
} = await import('../../../main/utils/shellExec.js');

describe('shell inventory paths', () => {
    const originalPlatform = process.platform;
    const originalPath = process.env.PATH;
    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        process.env.PATH = originalPath;
    });

    test('finds multiple Windows installations, deduplicates PATH and includes Git outside PATH', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        process.env.PATH = 'C:/tools;C:/TOOLS;D:/tools';
        const gitBash = `${process.env.ProgramFiles || 'C:\\Program Files'}\\Git\\bin\\bash.exe`;
        existsSyncMock.mockImplementation((p) =>
            ['C:\\tools\\bash.exe', 'D:\\tools\\bash.exe', gitBash].includes(String(p))
        );
        expect(findExecutablesInPath('bash')).toEqual(['C:\\tools\\bash.exe', 'D:\\tools\\bash.exe', gitBash]);
    });

    test('finds all executable Unix paths and skips paths without execute permission', () => {
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        process.env.PATH = '/custom/bin:/custom/bin';
        existsSyncMock.mockImplementation((p) =>
            ['/custom/bin/zsh', '/bin/zsh', '/opt/homebrew/bin/zsh'].includes(String(p))
        );
        accessSyncMock.mockImplementation((p) => {
            if (p === '/custom/bin/zsh') throw new Error('EACCES');
        });
        expect(findExecutablesInPath('zsh')).toEqual(['/bin/zsh', '/opt/homebrew/bin/zsh']);
    });
});

describe('findOpenHarmonyZsh', () => {
    const originalPlatform = process.platform;
    const originalPath = process.env.PATH;

    beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'openharmony', configurable: true });
        process.env.PATH = '/usr/bin';
        spawnSyncMock.mockReset();
        existsSyncMock.mockReset();
        existsSyncMock.mockImplementation((p: unknown) =>
            ['zsh', 'bash'].some((name) => toPosix(p).endsWith(`/${name}`))
        );
        accessSyncMock.mockReset();
        accessSyncMock.mockImplementation(() => undefined);
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        process.env.PATH = originalPath;
    });

    test('falls back to PATH lookup when /usr/bin/zsh does not exist', () => {
        accessSyncMock.mockImplementation((p: unknown) => {
            if (toPosix(p) === ZSH_PATH) throw new Error('ENOENT');
        });
        // PATH 查找不做 spawnSync 验证，命中 accessSync 可用的 /bin/zsh
        expect(toPosix(findOpenHarmonyZsh())).toBe('/bin/zsh');
        expect(spawnSyncMock).not.toHaveBeenCalled();
    });

    test('falls back to PATH lookup when zsh exists but fails runtime verification', () => {
        spawnSyncMock.mockReturnValueOnce({ status: 127, error: undefined } as SpawnSyncReturns<Buffer>);
        // 验证失败后回退到 PATH 查找（仅 accessSync 级别），仍命中 /usr/bin/zsh
        expect(toPosix(findOpenHarmonyZsh())).toBe(ZSH_PATH);
    });

    test('returns fixed /usr/bin/zsh when runtime verification passes', () => {
        spawnSyncMock.mockReturnValueOnce({ status: 0, error: undefined } as SpawnSyncReturns<Buffer>);
        expect(findOpenHarmonyZsh()).toBe(ZSH_PATH);
        expect(spawnSyncMock).toHaveBeenCalledWith(ZSH_PATH, ['-c', 'true'], { timeout: 5000 });
    });
});

describe('getDefaultShell on OpenHarmony', () => {
    const originalPlatform = process.platform;
    const originalPath = process.env.PATH;

    beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'openharmony', configurable: true });
        process.env.PATH = '/usr/bin';
        clearDefaultShellCache();
        spawnSyncMock.mockReset();
        existsSyncMock.mockReset();
        existsSyncMock.mockImplementation((p: unknown) =>
            ['zsh', 'bash'].some((name) => toPosix(p).endsWith(`/${name}`))
        );
        accessSyncMock.mockReset();
        accessSyncMock.mockImplementation(() => undefined);
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        process.env.PATH = originalPath;
        clearDefaultShellCache();
    });

    test('prefers interactive zsh when zsh is runnable', () => {
        spawnSyncMock.mockImplementation((cmd: string) =>
            cmd.endsWith('zsh')
                ? ({ status: 0, error: undefined } as SpawnSyncReturns<Buffer>)
                : ({ status: 127, error: undefined } as SpawnSyncReturns<Buffer>)
        );

        const shell = getDefaultShell();
        expect(shell).toEqual({ shellPath: '/usr/bin/zsh', shellArgs: ['-i', '-c'] });
    });

    test('falls back to bash when zsh is not runnable', () => {
        // /usr/bin/zsh 运行验证失败，且 PATH 中亦无 zsh（existsSync 仅放行 bash），
        // findOpenHarmonyZsh 的 PATH 回退不应命中，最终回退到 HNP bash
        spawnSyncMock.mockImplementation((cmd: string) =>
            cmd.endsWith('zsh')
                ? ({ status: 127, error: undefined } as SpawnSyncReturns<Buffer>)
                : ({ status: 0, error: undefined } as SpawnSyncReturns<Buffer>)
        );
        existsSyncMock.mockImplementation((p: unknown) => toPosix(p).endsWith('/bash'));

        const shell = getDefaultShell();
        expect(shell).toEqual({ shellPath: '/data/service/hnp/bin/bash', shellArgs: ['-c'] });
    });

    test('falls back to /bin/sh when neither zsh nor bash is runnable', () => {
        // zsh 验证失败，HNP bash 验证失败，PATH 中也无 bash 文件
        spawnSyncMock.mockReturnValue({ status: 127, error: undefined } as SpawnSyncReturns<Buffer>);
        existsSyncMock.mockImplementation(() => false);

        const shell = getDefaultShell();
        expect(shell).toEqual({ shellPath: '/bin/sh', shellArgs: ['-c'] });
    });
});

describe('OpenHarmony interactive shell output filtering', () => {
    const originalPlatform = process.platform;
    const originalPath = process.env.PATH;

    beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'openharmony', configurable: true });
        process.env.PATH = '/usr/bin';
        clearDefaultShellCache();
        spawnMock.mockReset();
        spawnSyncMock.mockReset();
        existsSyncMock.mockReset();
        existsSyncMock.mockImplementation((p: unknown) =>
            ['zsh', 'bash'].some((name) => toPosix(p).endsWith(`/${name}`))
        );
        accessSyncMock.mockReset();
        accessSyncMock.mockImplementation(() => undefined);
    });

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        process.env.PATH = originalPath;
        clearDefaultShellCache();
    });

    test('shellExec runs command via zsh -i -c and filters OSC noise from stdout', () => {
        spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
            // findOpenHarmonyZsh 的运行验证调用
            if (args.join(' ') === '-c true') {
                return { status: 0, error: undefined } as SpawnSyncReturns<Buffer>;
            }
            return {
                status: 0,
                error: undefined,
                stdout: Buffer.from('\x1b]9278;f;{"event": "SetupComplete"}\x07{"dependencies":{}}\n'),
                stderr: Buffer.from(
                    'chdir: error retrieving current directory: getcwd: cannot access parent directories: Permission denied\n'
                )
            } as SpawnSyncReturns<Buffer>;
        });

        const result = shellExec('npm list --json');
        expect(spawnSyncMock).toHaveBeenCalledWith('/usr/bin/zsh', ['-i', '-c', 'npm list --json'], expect.anything());
        expect(result.stdout).toBe('{"dependencies":{}}\n');
        expect(result.stderr).toBe('');
    });

    test('asyncShellExec runs command via zsh -i -c and filters OSC noise from stdout', async () => {
        spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
            if (args.join(' ') === '-c true') {
                return { status: 0, error: undefined } as SpawnSyncReturns<Buffer>;
            }
            throw new Error('unexpected spawnSync call');
        });

        const proc = new EventEmitter() as unknown as ChildProcess;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdin = { end: () => undefined };
        spawnMock.mockReturnValueOnce(proc);

        const pending = asyncShellExec('npm list --json');
        proc.stdout.emit('data', Buffer.from('\x1b]9278;f;{"event": "SetupComplete"}\x07'));
        proc.stdout.emit('data', Buffer.from('{"dependencies":{}}\n'));
        proc.stderr.emit(
            'data',
            Buffer.from(
                'shell-init: error retrieving current directory: getcwd: cannot access parent directories: Permission denied\n'
            )
        );
        proc.emit('close', 0);
        const result = await pending;

        expect(spawnMock).toHaveBeenCalledWith('/usr/bin/zsh', ['-i', '-c', 'npm list --json'], expect.anything());
        expect(result.stdout).toBe('{"dependencies":{}}\n');
        expect(result.stderr).toBe('');
    });
});

describe('filterShellEnvironmentWarnings: getcwd noise', () => {
    const CWD_TAIL = 'error retrieving current directory: getcwd: cannot access parent directories';

    test('filters all OpenDesk-reachable bash tags (TUI cd/pwd wrapper and startup paths)', () => {
        for (const tag of ['shell-init', 'shell_init', 'chdir', 'cd', 'pwd']) {
            expect(filterShellEnvironmentWarnings(`${tag}: ${CWD_TAIL}: Permission denied\n`)).toBe('');
        }
    });

    test('filters strerror variants beyond the observed whitelist (musl out-of-table errno etc.)', () => {
        expect(filterShellEnvironmentWarnings(`shell-init: ${CWD_TAIL}: No error information\r\n`)).toBe('');
        expect(filterShellEnvironmentWarnings(`cd: ${CWD_TAIL}: No such file or directory\n`)).toBe('');
    });

    test('strips warnings embedded between normal output including trailing newline', () => {
        const text = `start\npwd: ${CWD_TAIL}: Not a tty\nend`;
        expect(filterShellEnvironmentWarnings(text)).toBe('start\nend');
    });

    test('removes truncated warning lacking trailing newline at end of output', () => {
        // 极端场景：进程被 SIGKILL 等导致残缺警告落在输出末尾且无换行符。
        // [^\r\n]* 贪婪匹配至串尾，移除的只是残缺警告自身，其后无文本可误伤。
        // 正常场景下换行符必然存在：bash 5.3 源码 fprintf 模板硬编码尾部 \n
        // （common.c:609），stderr 无缓冲且警告总长 < PIPE_BUF，单次 write 原子完成。
        const text = `out\nshell-init: ${CWD_TAIL}: Permi`;
        expect(filterShellEnvironmentWarnings(text)).toBe('out\n');
    });

    test('keeps real bash command errors (bash: line N: ... format)', () => {
        const errors = [
            'bash: line 1: cd: /no/such/dir: No such file or directory\n',
            'bash: line 1: nosuchcmd_xyz: command not found\n'
        ];
        for (const err of errors) {
            expect(filterShellEnvironmentWarnings(err)).toBe(err);
        }
    });
});
