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

import { Setting } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import { runSettingSideEffects, type SettingSideEffect } from '../../utils/setting-side-effects.js';
import { ApplicationRegistry, notifyWorkerSettingUpdate } from '../registry.js';
import { prepareFileMgrWorkspaceSettings } from '../filemgr/workspace.js';
import { notifyFileMgrEmbeddingConfigChanged } from '../filemgr/embedding-config.js';
import type { SettingsRuntimeOptions } from './service.js';

export type WorkspaceSelectionOptions = SettingsRuntimeOptions;

/** Persist the global selection; existing tasks retain their own workspace bindings. */
export async function applyWorkspaceSelection(
    selectedPath: string,
    options: WorkspaceSelectionOptions = {}
): Promise<void> {
    const setting = Setting.getInstance();
    const oldSettings = setting.getData();
    const prepared = prepareFileMgrWorkspaceSettings({ ...oldSettings, default_workspace: selectedPath }, oldSettings);
    // A failed write must reach the caller rather than report a selection that did not take effect.
    setting.setData(prepared.data);
    try {
        setting.addRecentWorkspace(selectedPath);
    } catch (error) {
        logger.warn(
            `[workspace] failed to update recent paths after save: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    const effects: SettingSideEffect[] = [
        { label: 'worker-settings-sync', run: () => notifyWorkerSettingUpdate(setting.getData(), options) },
        {
            label: 'filemgr-embedding-config',
            run: () => notifyFileMgrEmbeddingConfigChanged(oldSettings, setting.getData())
        }
    ];
    if (prepared.shouldNotifyWorkspaceChanged && prepared.defaultWorkspace) {
        effects.push({
            label: 'filemgr-workspace-marker',
            run: () => {
                const workspace = setting.getData().default_workspace;
                if (workspace) return ApplicationRegistry.callWorker('filemgr', 'workspaceChanged', workspace);
            }
        });
    }
    await runSettingSideEffects(effects, (label, message) => {
        logger.warn(`[workspace] ${label} failed after save: ${message}`);
    });
}
