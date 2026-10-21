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

import { resolveDriveRootPath } from '../utils.js';
import { getPlatform } from './state.js';

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

function getApplicationAPI() {
    return globalThis.window?.applicationAPI ?? getTopWindow()?.applicationAPI ?? null;
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

export async function loadFileMgrSettings() {
    const settings = await getSettingAPI().loadSettingObject();
    if (!settings || typeof settings !== 'object') throw new Error('FileMgr settings response is unavailable.');
    const configuredEntries = settings.applications?.filemgr?.entries;
    if (configuredEntries !== undefined && !Array.isArray(configuredEntries))
        throw new Error('FileMgr settings entries are invalid.');
    return settings;
}

export async function saveEntries(nextEntries) {
    const settingAPI = getSettingAPI();
    const settings = await settingAPI.loadSettingObject();
    const applications = settings?.applications ?? {};
    const filemgr = applications.filemgr ?? {};
    const nextFilemgrConfig = {
        ...filemgr,
        entries: Array.isArray(nextEntries) ? nextEntries : []
    };

    let effective;
    try {
        effective = await settingAPI.saveSettingObject({
            ...settings,
            applications: {
                ...applications,
                filemgr: nextFilemgrConfig
            }
        });
        if (!Array.isArray(effective?.applications?.filemgr?.entries)) {
            throw new Error('FileMgr save returned no effective configuration.');
        }
    } catch (cause) {
        const error = new Error('FileMgr save result is unknown.', { cause });
        error.saveAttempted = true;
        throw error;
    }

    const applicationAPI = getApplicationAPI();
    const reconciliation = Promise.resolve()
        .then(() => {
            if (!applicationAPI?.call) throw new Error('FileMgr applicationAPI is unavailable.');
            return applicationAPI.call('reconcileConfig', effective.applications.filemgr);
        })
        .then((result) => {
            if (result?.status === 'error') throw new Error(result.message || 'FileMgr reconcile failed.');
            return { ok: true };
        })
        .catch((error) => {
            console.warn('[filemgr] reconcile config failed', error);
            return { ok: false };
        });
    return { settings: effective, reconciliation };
}

export async function listDirectory(path, opts) {
    const platform = getPlatform();
    if (!platform && typeof path === 'string' && /^[A-Za-z]:[/\\]?$/.test(path)) {
        throw new Error('FileMgr platform is not ready for drive-root directory access.');
    }
    return getWorkspaceAPI().listDirectory(resolveDriveRootPath(path, platform), { includeFiles: false, ...opts });
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

export async function forceRefreshScan() {
    const result = await window.applicationAPI.call('forceRefreshScan');
    if (result?.status === 'error') {
        throw new Error(result.message || 'Force refresh scan failed.');
    }
    return result;
}

export async function setSourcePaused(request) {
    const result = await window.applicationAPI.call('setSourcePaused', request);
    if (result?.status !== 'ok') {
        const error = new Error('Source pause state was not applied.');
        error.code = result?.code ?? 'generic';
        error.snapshot = result?.data ?? null;
        throw error;
    }
    return result.data;
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
