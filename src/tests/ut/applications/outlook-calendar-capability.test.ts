import { afterEach, expect, jest, test } from '@jest/globals';

const spawn = jest.fn(() => ({ status: 0, stdout: Buffer.from('[]'), stderr: Buffer.alloc(0) }));
jest.unstable_mockModule('child_process', () => ({ spawnSync: spawn }));
const { OutlookUtils } = await import('../../../main/utils/outlook.js');
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    spawn.mockClear();
});

test.each(['linux', 'darwin', 'android', 'openharmony'])('Outlook COM stays unavailable on %s', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    expect(await OutlookUtils.getOutlookCalendarItems(-7, 7)).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
});

test('Windows keeps its existing Outlook PowerShell/COM query', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    expect(await OutlookUtils.getOutlookCalendarItems(-7, 7)).toEqual([]);
    expect(spawn).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining([
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            expect.stringContaining('New-Object -ComObject Outlook.Application')
        ])
    );
});
