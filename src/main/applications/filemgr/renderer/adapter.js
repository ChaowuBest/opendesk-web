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

function getTopWindow() {
    try {
        return globalThis.window?.top ?? null;
    } catch {
        return null;
    }
}

function getSettingAPI() {
    const api = globalThis.window?.settingAPI ?? getTopWindow()?.settingAPI;
    if (!api) {
        throw new Error('settingAPI is unavailable.');
    }

    return api;
}

function getWorkspaceAPI() {
    const api = globalThis.window?.workspaceAPI ?? getTopWindow()?.workspaceAPI;
    if (!api) {
        throw new Error('workspaceAPI is unavailable.');
    }

    return api;
}

function getGlobalControlAPI() {
    return globalThis.window?.globalControlAPI ?? getTopWindow()?.globalControlAPI ?? null;
}

export async function getFileSystemStatus() {
    return window.applicationAPI.call('getFileSystemStatus');
}

function normalizeStatusPayload(payload) {
    const eventPayload = Array.isArray(payload) && payload.length === 1 ? payload[0] : payload;
    return eventPayload?.snapshot ?? eventPayload;
}

export function subscribeStatus(cb) {
    let disposed = false;
    let subscribed = false;
    const handler = (payload) => {
        if (disposed) return;
        cb(normalizeStatusPayload(payload));
    };
    const unsubscribe = () => {
        if (!subscribed) return;
        subscribed = false;
        void Promise.resolve(window.applicationAPI.unsubscribe('onStatusChanged')).catch(() => {});
    };

    void Promise.resolve(window.applicationAPI.subscribe('onStatusChanged', handler))
        .then(() => {
            subscribed = true;
            if (disposed) {
                unsubscribe();
            }
        })
        .catch(() => {
            subscribed = false;
        });

    return () => {
        disposed = true;
        unsubscribe();
    };
}

export async function loadEntries() {
    const settings = await getSettingAPI().loadSettingObject();
    return settings.applications.filemgr.entries;
}

export async function loadDefaultWorkspace() {
    const settings = await getSettingAPI().loadSettingObject();
    return settings.default_workspace;
}

export async function saveEntries(nextEntries) {
    const settingAPI = getSettingAPI();
    const settings = await settingAPI.loadSettingObject();
    await settingAPI.saveSettingObject({
        ...settings,
        applications: {
            ...settings.applications,
            filemgr: {
                ...settings.applications.filemgr,
                entries: nextEntries
            }
        }
    });
}

export async function listDirectory(path, opts) {
    return getWorkspaceAPI().listDirectory(path, { includeFiles: false, ...opts });
}

export async function listDrives() {
    return getWorkspaceAPI().listDrives();
}

export async function resetFileSystemStorage() {
    const result = await window.applicationAPI.call('resetFileSystemStorage');
    if (result?.status === 'error') {
        throw new Error(result.message || 'Reset file system storage failed.');
    }

    return result;
}

export function openSettings() {
    const globalControlAPI = getGlobalControlAPI();
    if (!globalControlAPI?.openSettingEditor) {
        console.warn('[filemgr] settings route is unavailable');
        return false;
    }

    globalControlAPI.openSettingEditor();
    return true;
}
