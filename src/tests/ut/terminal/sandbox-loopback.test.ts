import { jest } from '@jest/globals';

const execute = jest.fn<(...args: any[]) => void>();
jest.unstable_mockModule('node:child_process', () => ({ execFile: execute }));
jest.unstable_mockModule('../../../main/applications/terminal/locale/index.js', () => ({
    t: (key: string) => key
}));
const { ensureSandboxLoopback } = await import('../../../main/applications/terminal/sandboxes/loopback.js');

beforeEach(() => execute.mockReset());

test('concurrent launches share one setup and later launches recheck Windows configuration', async () => {
    const first = ensureSandboxLoopback('C:/sandbox.exe');
    const second = ensureSandboxLoopback('C:/sandbox.exe');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0].slice(0, 3)).toEqual([
        'C:/sandbox.exe',
        ['network-ensure'],
        { windowsHide: true, timeout: 150000 }
    ]);
    execute.mock.calls[0][3](null, '{"configured":true}', '');
    await Promise.all([first, second]);
    const later = ensureSandboxLoopback('C:/sandbox.exe');
    expect(execute).toHaveBeenCalledTimes(2);
    execute.mock.calls[1][3](null, '{"configured":true}', '');
    await later;
});

test('cancelled initialization reports a localized error and allows retry', async () => {
    const pending = ensureSandboxLoopback('C:/sandbox.exe');
    execute.mock.calls[0][3]({ code: 1223 }, '{"configured":false,"errorCode":1223}', '');
    await expect(pending).rejects.toThrow('sandbox.loopbackSetupFailed (1223)');
    const retry = ensureSandboxLoopback('C:/sandbox.exe');
    execute.mock.calls[1][3](null, '{"configured":true}', '');
    await retry;
});

test.each(['{}', '{"configured":false}', 'not JSON'])('setup must explicitly confirm success: %s', async (stdout) => {
    const pending = ensureSandboxLoopback('C:/sandbox.exe');
    execute.mock.calls[0][3](null, stdout, '');
    await expect(pending).rejects.toThrow('sandbox.loopbackSetupFailed (invalid-response)');
});
