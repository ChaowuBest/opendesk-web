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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { StartupKit, StartupState } from '../common.js';

export class LinuxStartupKit implements StartupKit {
    private readonly executable: string;
    private readonly desktopFile: string;

    constructor(options: { execPath?: string; configHome?: string } = {}) {
        this.executable = options.execPath ?? process.env.APPIMAGE ?? process.execPath;
        this.desktopFile = path.join(
            options.configHome ?? process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'),
            'autostart',
            'opendesk.desktop'
        );
    }

    async getState(): Promise<StartupState> {
        const content = existsSync(this.desktopFile) ? readFileSync(this.desktopFile, 'utf8') : '';
        return {
            supported: true,
            enabled:
                content.includes('[Desktop Entry]') &&
                /^Exec=.+$/m.test(content) &&
                !/^Hidden=true\s*$/m.test(content) &&
                !/^X-GNOME-Autostart-enabled=false\s*$/m.test(content),
            mode: 'toggle'
        };
    }

    async delegateSetting(enabled?: boolean): Promise<void> {
        if (typeof enabled !== 'boolean') throw new TypeError('Expected a boolean');
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
    }
}
