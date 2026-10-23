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
import type { StartupKit, StartupState } from '../common.js';

export class WindowsStartupKit implements StartupKit {
    constructor(
        private readonly app: Pick<App, 'getLoginItemSettings' | 'setLoginItemSettings'>,
        private readonly executable = process.execPath
    ) {}

    async getState(): Promise<StartupState> {
        const state = this.app.getLoginItemSettings({ path: this.executable, args: [] });
        return {
            supported: true,
            enabled: state.openAtLogin && state.executableWillLaunchAtLogin,
            mode: 'toggle'
        };
    }

    async delegateSetting(enabled?: boolean): Promise<void> {
        if (typeof enabled !== 'boolean') throw new TypeError('Expected a boolean');
        this.app.setLoginItemSettings({ openAtLogin: enabled, path: this.executable, args: [] });
    }
}
