/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import type { App } from 'electron';
import type { SystemStartupSettingsProvider } from '../../common/launch-at-login.js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

interface Options {
    platform?: string;
    execPath?: string;
    packaged?: boolean;
    debug?: boolean;
    configHome?: string;
    harmony?: SystemStartupSettingsProvider;
}

export class LaunchAtLogin {
    private readonly platform: string;
    private readonly executable: string;
    private readonly desktopFile: string;
    private readonly supported: boolean;
    private readonly reason: string;
    private readonly harmony?: SystemStartupSettingsProvider;

    constructor(
        private readonly app: Pick<App, 'isPackaged' | 'getLoginItemSettings' | 'setLoginItemSettings'>,
        options: Options = {}
    ) {
        this.platform = options.platform ?? process.platform;
        this.harmony = options.harmony;
        this.executable = options.execPath ?? process.env.APPIMAGE ?? process.execPath;
        this.desktopFile = path.join(
            options.configHome ?? process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'),
            'autostart',
            'opendesk.desktop'
        );
        // Harmony HAPs embed directory resources; Electron's packaging flag does not describe their installation.
        const development =
            options.debug === true || (this.platform !== 'openharmony' && !(options.packaged ?? app.isPackaged));
        this.supported =
            !development &&
            (['darwin', 'win32', 'linux'].includes(this.platform) ||
                (this.platform === 'openharmony' && !!this.harmony));
        this.reason = development ? 'development' : 'unsupported';
    }

    getState() {
        if (!this.supported) return { supported: false, enabled: false, reason: this.reason };
        if (this.platform === 'openharmony') return this.harmony!.getState();
        let enabled: boolean;
        if (this.platform === 'linux') {
            const content = existsSync(this.desktopFile) ? readFileSync(this.desktopFile, 'utf8') : '';
            enabled =
                content.includes('[Desktop Entry]') &&
                /^Exec=.+$/m.test(content) &&
                !/^Hidden=true\s*$/m.test(content) &&
                !/^X-GNOME-Autostart-enabled=false\s*$/m.test(content);
        } else {
            const state = this.app.getLoginItemSettings(
                this.platform === 'win32' ? { path: this.executable, args: [] } : undefined
            );
            enabled =
                state.openAtLogin &&
                (this.platform === 'win32'
                    ? state.executableWillLaunchAtLogin
                    : state.status !== 'requires-approval' && state.status !== 'not-found');
        }
        return { supported: true, enabled };
    }

    async openSettings(): Promise<void> {
        if (!this.supported || this.platform !== 'openharmony' || !this.harmony) {
            throw new Error('System startup settings are unavailable');
        }
        await this.harmony.openSettings();
    }

    setEnabled(enabled: boolean) {
        if (typeof enabled !== 'boolean') throw new TypeError('Expected a boolean');
        if (!this.supported) throw new Error('Launch at login is unavailable');
        if (this.platform === 'openharmony') throw new Error('Startup is managed in system settings');
        if (this.platform === 'linux') {
            if (enabled) {
                // Desktop Entry Exec quoting has two escaping layers, plus literal percent escaping.
                const quoted = this.executable
                    .replace(/(["`$\\])/g, '\\$1')
                    .replace(/\\/g, '\\\\')
                    .replace(/%/g, '%%');
                if (/[\r\n]/.test(quoted)) throw new Error('Invalid executable path');
                mkdirSync(path.dirname(this.desktopFile), { recursive: true });
                writeFileSync(
                    this.desktopFile,
                    `[Desktop Entry]\nType=Application\nName=OpenDesk\nExec="${quoted}"\nTerminal=false\n`,
                    { mode: 0o600 }
                );
            } else {
                rmSync(this.desktopFile, { force: true });
            }
        } else {
            this.app.setLoginItemSettings({
                openAtLogin: enabled,
                ...(this.platform === 'win32' ? { path: this.executable, args: [] } : {})
            });
        }
        return this.getState();
    }
}
