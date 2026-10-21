import { describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LaunchAtLogin } from '../../../main/utils/launch-at-login.js';

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
        service: new LaunchAtLogin(app as any, {
            platform,
            execPath: '/Applications/OpenDesk.app/Contents/MacOS/OpenDesk',
            ...extras
        })
    };
}

describe('launch at login', () => {
    test.each(['darwin', 'win32'])('reads actual state and enables/disables on %s', (platform) => {
        const { app, service } = setup(platform);
        expect(service.getState()).toEqual({ supported: true, enabled: false });
        expect(service.setEnabled(true).enabled).toBe(true);
        expect(service.setEnabled(false).enabled).toBe(false);
        expect(app.setLoginItemSettings).toHaveBeenCalledTimes(2);
        if (platform === 'win32') {
            expect(app.getLoginItemSettings).toHaveBeenLastCalledWith({
                path: '/Applications/OpenDesk.app/Contents/MacOS/OpenDesk',
                args: []
            });
        }
    });
    test('reflects Windows startup approval and macOS approval state', () => {
        const win = setup('win32');
        win.app.getLoginItemSettings.mockReturnValue({ openAtLogin: true, executableWillLaunchAtLogin: false });
        expect(win.service.getState().enabled).toBe(false);
        const mac = setup();
        mac.app.getLoginItemSettings.mockReturnValue({ openAtLogin: true, status: 'requires-approval' } as any);
        expect(mac.service.getState().enabled).toBe(false);
    });
    test('rejects non-boolean IPC input and propagates native failures', () => {
        const { app, service } = setup();
        expect(() => service.setEnabled('false' as any)).toThrow();
        expect(app.setLoginItemSettings).not.toHaveBeenCalled();
        app.setLoginItemSettings.mockImplementation(() => {
            throw new Error('denied');
        });
        expect(() => service.setEnabled(true)).toThrow('denied');
    });
    test('does not touch OS settings for development, debug, or unsupported hosts', () => {
        for (const extras of [{ debug: true }, { packaged: false }, { platform: 'ohos' }]) {
            const { app, service } = setup('darwin', extras);
            expect(service.getState().supported).toBe(false);
            expect(() => service.setEnabled(true)).toThrow();
            expect(app.setLoginItemSettings).not.toHaveBeenCalled();
            expect(app.getLoginItemSettings).not.toHaveBeenCalled();
        }
    });
    test('Linux writes a quoted user autostart entry and removes only its own file', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'opendesk-autostart-'));
        try {
            const { service } = setup('linux', {
                configHome: directory,
                execPath: '/opt/Open Desk/app$`"\\%.AppImage'
            });
            expect(service.getState().enabled).toBe(false);
            expect(service.setEnabled(true).enabled).toBe(true);
            const file = path.join(directory, 'autostart', 'opendesk.desktop');
            expect(readFileSync(file, 'utf8')).toContain('Exec="/opt/Open Desk/app\\\\$\\\\`\\\\"\\\\\\\\%%.AppImage"');
            writeFileSync(file, readFileSync(file, 'utf8') + 'Hidden=true\n');
            expect(service.getState().enabled).toBe(false);
            const other = path.join(directory, 'autostart', 'other.desktop');
            writeFileSync(other, 'keep');
            expect(service.setEnabled(false).enabled).toBe(false);
            expect(readFileSync(other, 'utf8')).toBe('keep');
            expect(service.setEnabled(false).enabled).toBe(false);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

test('Harmony delegates to the native status/settings provider and never writes desktop login items', async () => {
    const harmony = {
        getState: jest.fn(async () => ({ supported: true, enabled: true, mode: 'system-settings' })),
        openSettings: jest.fn(async () => undefined)
    };
    const { app, service } = setup('openharmony', { harmony });
    expect(await service.getState()).toEqual({ supported: true, enabled: true, mode: 'system-settings' });
    await service.openSettings();
    expect(harmony.openSettings).toHaveBeenCalledTimes(1);
    expect(() => service.setEnabled(true)).toThrow();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
});

test('Harmony HAP directory resources can query and open native settings even when Electron reports unpackaged', async () => {
    const harmony = {
        getState: jest.fn(async () => ({ supported: true, enabled: true, mode: 'system-settings' })),
        openSettings: jest.fn(async () => undefined)
    };
    const { app, service } = setup('openharmony', { harmony, packaged: false });
    expect(await service.getState()).toEqual({ supported: true, enabled: true, mode: 'system-settings' });
    await service.openSettings();
    expect(harmony.openSettings).toHaveBeenCalledTimes(1);
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    const debug = setup('openharmony', { harmony, packaged: false, debug: true });
    expect(debug.service.getState().supported).toBe(false);
    await expect(debug.service.openSettings()).rejects.toThrow();
});
