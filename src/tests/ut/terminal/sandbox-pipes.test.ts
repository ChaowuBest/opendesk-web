import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execute = jest.fn<(...args: any[]) => void>();
jest.unstable_mockModule('node:child_process', () => ({ execFile: execute }));

// os.uptime 可控，用于模拟"同一次开机"与"重启后"
let uptimeSeconds = 100000;
jest.unstable_mockModule('node:os', () => ({
    default: { uptime: () => uptimeSeconds },
    uptime: () => uptimeSeconds
}));

const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-pipes-config-'));
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    getOpendeskDirectory: () => configDirectory
}));

const loadEnsureSandboxPipes = async () => {
    const module = await import('../../../main/applications/terminal/sandboxes/pipes.js');
    return module.ensureSandboxPipes;
};

beforeEach(() => {
    execute.mockReset();
    uptimeSeconds = 100000;
    jest.resetModules();
    for (const file of fs.readdirSync(configDirectory)) {
        fs.rmSync(path.join(configDirectory, file), { force: true });
    }
});

afterAll(() => {
    fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('reports success once per process and never re-checks after confirmation', async () => {
    const ensureSandboxPipes = await loadEnsureSandboxPipes();
    const first = ensureSandboxPipes('C:/sandbox.exe');
    const second = ensureSandboxPipes('C:/sandbox.exe');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0].slice(0, 3)).toEqual([
        'C:/sandbox.exe',
        ['pipes-ensure'],
        { windowsHide: true, timeout: 150000 }
    ]);
    execute.mock.calls[0][3](null, '{"configured":true}', '');
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    // 配置成功后本进程内不再重复检查；拒绝标记被清除，后续进程可静默复检
    const later = ensureSandboxPipes('C:/sandbox.exe');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await later).toBe(false);
    expect(fs.existsSync(path.join(configDirectory, 'sandbox-pipes-declined.json'))).toBe(false);
});

test('a declined elevation is remembered for the whole boot, across process restarts', async () => {
    // 第一个"进程"：用户取消 UAC
    let ensureSandboxPipes = await loadEnsureSandboxPipes();
    const pending = ensureSandboxPipes('C:/sandbox.exe');
    execute.mock.calls[0][3]({ code: 1223 }, '{"configured":false,"errorCode":1223}', '');
    expect(await pending).toBe(false);
    expect(fs.existsSync(path.join(configDirectory, 'sandbox-pipes-declined.json'))).toBe(true);

    // 第二个"进程"（模块重载）：同一开机内不再打扰，也不发起子进程
    jest.resetModules();
    execute.mockClear();
    ensureSandboxPipes = await loadEnsureSandboxPipes();
    expect(await ensureSandboxPipes('C:/sandbox.exe')).toBe(false);
    expect(execute).not.toHaveBeenCalled();
});

test('after a reboot the decline no longer suppresses the attempt', async () => {
    let ensureSandboxPipes = await loadEnsureSandboxPipes();
    const pending = ensureSandboxPipes('C:/sandbox.exe');
    execute.mock.calls[0][3]({ code: 1223 }, '{"configured":false,"errorCode":1223}', '');
    expect(await pending).toBe(false);

    // 重启：uptime 归零再增长，开机指纹随之改变（偏差超过 2 分钟容忍带）
    jest.resetModules();
    uptimeSeconds = 500;
    execute.mockClear();
    ensureSandboxPipes = await loadEnsureSandboxPipes();
    const retried = ensureSandboxPipes('C:/sandbox.exe');
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mock.calls[0][3](null, '{"configured":true}', '');
    expect(await retried).toBe(true);
});

test.each(['{}', '{"configured":false}', 'not JSON'])(
    'treats an inconclusive check as not configured: %s',
    async (stdout) => {
        const ensureSandboxPipes = await loadEnsureSandboxPipes();
        const pending = ensureSandboxPipes('C:/sandbox.exe');
        execute.mock.calls[0][3](null, stdout, '');
        expect(await pending).toBe(false);
    }
);
