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

/**
 * App theme: user preference (system / light / dark) + resolved effective appearance.
 */

import { EventEmitter } from 'events';
import {
    getSystemDarkMode,
    initSystemTheme,
    onSystemDarkModeChanged,
    type SystemThemeModuleOptions
} from './system-theme.js';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ThemeAppearance = 'light' | 'dark';

export interface ResolvedTheme {
    preference: ThemePreference;
    effective: ThemeAppearance;
    systemDark: boolean;
}

export class ThemeManager extends EventEmitter {
    private preference: ThemePreference = 'system';

    constructor(systemThemeOptions?: SystemThemeModuleOptions) {
        super();
        initSystemTheme(systemThemeOptions ?? {});
        onSystemDarkModeChanged(() => {
            if (this.preference === 'system') {
                this.emit('changed', this.getResolvedTheme());
            }
        });
    }

    getResolvedTheme(): ResolvedTheme {
        let systemDark = false;
        try {
            systemDark = getSystemDarkMode();
        } catch {
            systemDark = false;
        }
        const effective: ThemeAppearance =
            this.preference === 'system' ? (systemDark ? 'dark' : 'light') : this.preference;
        return { preference: this.preference, effective, systemDark };
    }

    setPreference(pref: ThemePreference): void {
        this.preference = pref;
        this.emit('changed', this.getResolvedTheme());
    }

    applyToDocument(doc: Document = document): void {
        const { effective } = this.getResolvedTheme();
        doc.documentElement.dataset.theme = effective;
        doc.documentElement.style.colorScheme = 'light';
    }
}
