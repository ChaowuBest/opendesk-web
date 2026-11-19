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

import { isLocaleSetting, LocaleRuntime, type LocaleRuntimeSnapshot } from '../../../common/locale.js';

interface SettingsWithLocale {
    locale?: unknown;
}

export interface RuntimeLocaleOptions<Settings extends SettingsWithLocale> {
    getSettings: () => Settings;
    preferredSystemLanguages: readonly unknown[];
    applyPreferredSystemLanguages: (languages: readonly string[]) => void;
    notifyWorkers: (settings: Settings, options: { preferredSystemLanguages: readonly string[] }) => Promise<void>;
    broadcastSettings: (settings: Settings & { resolved_locale: string }) => void;
}

/** Shared locale update semantics; hosts supply observation, transport, and worker delivery. */
export class RuntimeLocaleService<Settings extends SettingsWithLocale> {
    private readonly runtime: LocaleRuntime;
    private pendingWorkerSync = false;
    private workerSyncGeneration = 0;

    constructor(private readonly options: RuntimeLocaleOptions<Settings>) {
        const settings = options.getSettings();
        this.runtime = new LocaleRuntime(
            isLocaleSetting(settings.locale) ? settings.locale : 'auto',
            options.preferredSystemLanguages
        );
        options.applyPreferredSystemLanguages(this.runtime.getSnapshot().preferredSystemLanguages);
    }

    getSnapshot(): LocaleRuntimeSnapshot {
        return this.runtime.getSnapshot();
    }

    /** Refresh system preferences without writing the user's persisted locale setting. */
    async handleSystemLanguagesChanged(languages: readonly unknown[]): Promise<boolean> {
        const settings = this.options.getSettings();
        const changed = this.runtime.update(isLocaleSetting(settings.locale) ? settings.locale : 'auto', languages);
        const snapshot = this.runtime.getSnapshot();
        this.options.applyPreferredSystemLanguages(snapshot.preferredSystemLanguages);
        if (changed) this.pendingWorkerSync = true;
        if (!this.pendingWorkerSync) return false;

        // Publish synchronously before awaiting worker acknowledgment: a slower
        // old worker response must never broadcast an obsolete locale afterward.
        if (changed) this.broadcast(settings, snapshot);
        const generation = ++this.workerSyncGeneration;
        await this.options.notifyWorkers(settings, {
            preferredSystemLanguages: snapshot.preferredSystemLanguages
        });
        // Failed syncs remain pending and can retry on the next host refresh,
        // even if that refresh resolves to the same visible locale.
        if (generation === this.workerSyncGeneration) this.pendingWorkerSync = false;
        return changed;
    }

    /** Existing settings save paths retain worker synchronization and emit one full setting event. */
    handleSettingChanged(): void {
        const settings = this.options.getSettings();
        this.runtime.update(isLocaleSetting(settings.locale) ? settings.locale : 'auto');
        this.broadcast(settings, this.runtime.getSnapshot());
    }

    private broadcast(settings: Settings, snapshot: LocaleRuntimeSnapshot): void {
        this.options.broadcastSettings({ ...settings, resolved_locale: snapshot.locale });
    }
}
