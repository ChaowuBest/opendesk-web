/**
 * App theme: user preference (system / light / dark) + resolved effective appearance.
 */

import { EventEmitter } from 'events';
import {
  getSystemDarkMode,
  initSystemTheme,
  onSystemDarkModeChanged,
  type SystemThemeModuleOptions,
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
    const systemDark = getSystemDarkMode();
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
    doc.documentElement.style.colorScheme = effective;
  }
}
