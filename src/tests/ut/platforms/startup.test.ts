import { describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DarwinStartupKit } from '../../../platforms/bridges/darwin/startup.js';
import { WindowsStartupKit } from '../../../platforms/bridges/win32/startup.js';
import { LinuxStartupKit } from '../../../platforms/bridges/linux/startup.js';
import { guardStartupKit, NaiveStartupKit } from '../../../platforms/bridges/common.js';

function setup(platform = 'darwin', extras = {}) {
    let enabled = false;
    const app = {
        isPackaged: true,
        getLoginItemSettings: jest.fn(() => ({ openAtLogin: enabled, executableWillLaunchAtLogin: enabled })),
        setLoginItemSettings: jest.fn((settings: { openAtLogin: boolean }) => {
            enabled = settings.openAtLogin;
        })
    };
    return {
        app,
        service:
            platform === 'linux'
                ? new LinuxStartupKit(extras)
                : platform === 'win32'
                  ? new WindowsStartupKit(app as any, '/Applications/OpenDesk.app/Contents/MacOS/OpenDesk')
                  : new DarwinStartupKit(app as any)
    };
}

describe('launch at login', () => {
    test.each(['darwin', 'win32'])('reads actual state and enables/disables on %s', async (platform) => {
        const { app, service } = setup(platform);
        expect(await service.getState()).toEqual({ supported: true, enabled: false, mode: 'toggle' });
        await service.delegateSetting(true);
        expect((await service.getState()).enabled).toBe(true);
        await service.delegateSetting(false);
        expect((await service.getState()).enabled).toBe(false);
        expect(app.setLoginItemSettings).toHaveBeenCalledTimes(2);
        if (platform === 'win32') {
            expect(app.getLoginItemSettings).toHaveBeenLastCalledWith({
                path: '/Applications/OpenDesk.app/Contents/MacOS/OpenDesk',
                args: []
            });
        }
    });
    test('reflects Windows startup approval and macOS approval state', async () => {
        const win = setup('win32');
        win.app.getLoginItemSettings.mockReturnValue({ openAtLogin: true, executableWillLaunchAtLogin: false });
        expect((await win.service.getState()).enabled).toBe(false);
        const mac = setup();
        mac.app.getLoginItemSettings.mockReturnValue({ openAtLogin: true, status: 'requires-approval' } as any);
        expect((await mac.service.getState()).enabled).toBe(false);
    });
    test('rejects non-boolean IPC input and propagates native failures', async () => {
        const { app, service: raw } = setup();
        const service = guardStartupKit(raw, 'toggle');
        await expect(service.delegateSetting('false' as any)).rejects.toThrow();
        expect(app.setLoginItemSettings).not.toHaveBeenCalled();
        app.setLoginItemSettings.mockImplementation(() => {
            throw new Error('denied');
        });
        await expect(service.delegateSetting(true)).rejects.toThrow('denied');
    });
    test('unknown hosts stay unsupported', async () => {
        expect((await new NaiveStartupKit().getState()).supported).toBe(false);
        await expect(new NaiveStartupKit().delegateSetting(true)).rejects.toThrow();
    });
    test('read failures preserve delegation capability and return unknown rather than off', async () => {
        // 实现读取失败时会 console.error 记录原因，该降级路径正是本用例验证的行为
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const delegateSetting = jest.fn(async () => undefined);
            const service = guardStartupKit(
                {
                    getState: async () => {
                        throw new Error('old host');
                    },
                    delegateSetting
                },
                'system-settings'
            );
            expect(await service.getState()).toEqual({
                supported: true,
                enabled: null,
                mode: 'system-settings',
                reason: 'unavailable'
            });
            await service.delegateSetting();
            expect(delegateSetting).toHaveBeenCalledTimes(1);
        } finally {
            errorSpy.mockRestore();
        }
    });
    test('Linux writes a quoted user autostart entry and removes only its own file', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'opendesk-autostart-'));
        try {
            const { service } = setup('linux', {
                configHome: directory,
                execPath: '/opt/Open Desk/app$`"\\%.AppImage'
            });
            expect((await service.getState()).enabled).toBe(false);
            await service.delegateSetting(true);
            expect((await service.getState()).enabled).toBe(true);
            const file = path.join(directory, 'autostart', 'opendesk.desktop');
            expect(readFileSync(file, 'utf8')).toContain('Exec="/opt/Open Desk/app\\\\$\\\\`\\\\"\\\\\\\\%%.AppImage"');
            writeFileSync(file, readFileSync(file, 'utf8') + 'Hidden=true\n');
            expect((await service.getState()).enabled).toBe(false);
            const other = path.join(directory, 'autostart', 'other.desktop');
            writeFileSync(other, 'keep');
            await service.delegateSetting(false);
            expect((await service.getState()).enabled).toBe(false);
            expect(readFileSync(other, 'utf8')).toBe('keep');
            await service.delegateSetting(false);
            expect((await service.getState()).enabled).toBe(false);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
