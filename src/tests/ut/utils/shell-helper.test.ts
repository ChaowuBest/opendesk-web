import { jest } from '@jest/globals';
import path from 'node:path';

const exec = jest.fn<(...args: unknown[]) => Promise<{ stdout: string; stderr: string }>>();
const getDefaultShell = jest.fn(() => ({ shellPath: '/bin/sh', shellArgs: ['-c'] }));
const lstat = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('node:fs', () => ({ default: { promises: { lstat } } }));
jest.unstable_mockModule('../../../main/utils/shellExec.js', () => ({
    asyncShellExec: exec,
    getDefaultShell
}));

const { getDiskUsage } = await import('../../../main/utils/shell-helper.js');
const originalPlatform = process.platform;

beforeEach(() => {
    exec.mockReset();
    lstat.mockReset();
    lstat.mockResolvedValue({});
    getDefaultShell.mockReturnValue({ shellPath: '/bin/sh', shellArgs: ['-c'] });
});

afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
});

test.each(['darwin', 'linux', 'openharmony'])('%s uses portable du units and literal paths', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    exec.mockResolvedValue({ stdout: '12\t/a path\nwith newline\n', stderr: '' });
    const target = "./-files '$(touch injected)' [x]\n";
    await expect(getDiskUsage(target, { timeout: 1234 })).resolves.toEqual({ bytes: 12288, kind: 'allocated' });
    const [command, options] = exec.mock.calls[0] as [string, { timeout: number; env: NodeJS.ProcessEnv }];
    expect(command).toBe('du -sk "$OPENDESK_DISK_USAGE_PATH"');
    expect(command).not.toContain(target);
    expect(options.timeout).toBe(1234);
    expect(options.env.OPENDESK_DISK_USAGE_PATH).toBe(path.resolve(target));
});

test('Windows uses PowerShell literal paths and includes hidden files without counting reparse points', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    getDefaultShell.mockReturnValue({
        shellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        shellArgs: ['-NoProfile', '-Command']
    });
    exec.mockResolvedValue({ stdout: '1537\r\n', stderr: '' });
    const target = "C:\\files [1]\\it's $data";
    await expect(getDiskUsage(target)).resolves.toEqual({ bytes: 1537, kind: 'apparent' });
    const [command, options] = exec.mock.calls[0] as [string, { env: NodeJS.ProcessEnv }];
    expect(command).toContain("$ErrorActionPreference = 'Stop'");
    expect(command).toContain('-LiteralPath $env:OPENDESK_DISK_USAGE_PATH');
    expect(command).toContain('-Recurse -File -Force');
    expect(command).toContain('-Attributes !ReparsePoint');
    expect(command).toContain('Measure-Object -Property Length -Sum');
    expect(command).not.toContain(target);
    expect(options.env.OPENDESK_DISK_USAGE_PATH).toBe(path.win32.resolve(target));
});

test('Windows uses du through a bash fallback like other POSIX shells', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    getDefaultShell.mockReturnValue({ shellPath: 'C:\\Git\\bin\\bash.exe', shellArgs: ['-c'] });
    exec.mockResolvedValue({ stdout: '12\tC:\\files\n', stderr: '' });
    const target = 'C:\\files [1]';
    await expect(getDiskUsage(target)).resolves.toEqual({ bytes: 12288, kind: 'allocated' });
    const [command, options] = exec.mock.calls[0] as [string, { env: NodeJS.ProcessEnv }];
    expect(command).toBe('du -sk "$OPENDESK_DISK_USAGE_PATH"');
    expect(options.env.OPENDESK_DISK_USAGE_PATH).toBe(path.win32.resolve(target));
});

test('a PowerShell default shell is honored even off Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    getDefaultShell.mockReturnValue({ shellPath: '/usr/bin/pwsh', shellArgs: ['-NoProfile', '-Command'] });
    exec.mockResolvedValue({ stdout: '1537\r\n', stderr: '' });
    await expect(getDiskUsage('/tmp')).resolves.toEqual({ bytes: 1537, kind: 'apparent' });
    const [command] = exec.mock.calls[0] as [string];
    expect(command).toContain("$ErrorActionPreference = 'Stop'");
    expect(command).not.toContain('du ');
});

test('Windows rejects unsupported shells such as cmd', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    getDefaultShell.mockReturnValue({ shellPath: 'C:\\Windows\\System32\\cmd.exe', shellArgs: ['/c'] });
    await expect(getDiskUsage('C:\\files')).rejects.toThrow('cmd.exe');
    expect(exec).not.toHaveBeenCalled();
});

test.each(['', 'garbage', '-1\t/tmp', '1.2\t/tmp', '9007199254740991\t/tmp'])(
    'rejects invalid or unsafe du output: %j',
    async (stdout) => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        exec.mockResolvedValue({ stdout, stderr: '' });
        await expect(getDiskUsage('/tmp')).rejects.toThrow();
    }
);

test('a successful zero is distinct from command failure', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    exec.mockResolvedValueOnce({ stdout: '0\t/tmp\n', stderr: '' });
    await expect(getDiskUsage('/tmp')).resolves.toEqual({ bytes: 0, kind: 'allocated' });
    const error = new Error('du: Permission denied');
    exec.mockRejectedValueOnce(error);
    await expect(getDiskUsage('/tmp')).rejects.toBe(error);
});

test.each(['', 'a\0b'])('rejects invalid path %j before launching a command', async (target) => {
    await expect(getDiskUsage(target)).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
});

test('uses a bounded default timeout', async () => {
    exec.mockResolvedValue({ stdout: '1\t/tmp\n', stderr: '' });
    await getDiskUsage('/tmp');
    expect(exec).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ timeout: 120000 }));
});

test('only a missing path returns zero without executing a command', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    lstat.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    await expect(getDiskUsage('/missing')).resolves.toEqual({ bytes: 0, kind: 'allocated' });
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    lstat.mockRejectedValueOnce(denied);
    await expect(getDiskUsage('/denied')).rejects.toBe(denied);
    expect(exec).not.toHaveBeenCalled();
});
