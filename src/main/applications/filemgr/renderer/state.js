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

export const COMMIT_DEBOUNCE_MS = 10_000;

let snapshot = null;
let entries = [];
let defaultWorkspace = '';
let isOpenHarmony = false;
let platform = '';
let systemHomePath = '';
let pendingNextEntries = null;
let pendingCommitToken = 0;

export let debounceTimer = null;
export let _undoSnapshot = null;

export const snapshotSubscribers = new Set();
export const entriesSubscribers = new Set();
export const defaultWorkspaceSubscribers = new Set();
export const isOpenHarmonySubscribers = new Set();
export const platformSubscribers = new Set();
export const systemHomePathSubscribers = new Set();

function notify(subscribers, value) {
    for (const cb of subscribers) {
        cb(value);
    }
}

export function getSnapshot() {
    return snapshot;
}

export function setSnapshot(nextSnapshot) {
    snapshot = nextSnapshot;
    notify(snapshotSubscribers, snapshot);
}

export function subscribeSnapshot(cb) {
    snapshotSubscribers.add(cb);

    return () => {
        snapshotSubscribers.delete(cb);
    };
}

export function getEntries() {
    return entries;
}

export function setEntries(nextEntries) {
    entries = nextEntries;
    notify(entriesSubscribers, entries);
}

export function subscribeEntries(cb) {
    entriesSubscribers.add(cb);

    return () => {
        entriesSubscribers.delete(cb);
    };
}

export function getDefaultWorkspace() {
    return defaultWorkspace;
}

export function setDefaultWorkspace(nextDefaultWorkspace) {
    defaultWorkspace = typeof nextDefaultWorkspace === 'string' ? nextDefaultWorkspace : '';
    notify(defaultWorkspaceSubscribers, defaultWorkspace);
}

export function subscribeDefaultWorkspace(cb) {
    defaultWorkspaceSubscribers.add(cb);

    return () => {
        defaultWorkspaceSubscribers.delete(cb);
    };
}

export function getIsOpenHarmony() {
    return isOpenHarmony;
}

export function setIsOpenHarmony(next) {
    const value = Boolean(next);
    if (isOpenHarmony === value) return;
    isOpenHarmony = value;
    notify(isOpenHarmonySubscribers, isOpenHarmony);
}

export function subscribeIsOpenHarmony(cb) {
    isOpenHarmonySubscribers.add(cb);

    return () => {
        isOpenHarmonySubscribers.delete(cb);
    };
}

export function getPlatform() {
    return platform;
}

export function setPlatform(next) {
    const value = typeof next === 'string' ? next : '';
    if (platform === value) return;
    platform = value;
    notify(platformSubscribers, platform);
}

export function subscribePlatform(cb) {
    platformSubscribers.add(cb);

    return () => {
        platformSubscribers.delete(cb);
    };
}

export function getSystemHomePath() {
    return systemHomePath;
}

export function setSystemHomePath(next) {
    const value = typeof next === 'string' ? next : '';
    if (systemHomePath === value) return;
    systemHomePath = value;
    notify(systemHomePathSubscribers, systemHomePath);
}

export function subscribeSystemHomePath(cb) {
    systemHomePathSubscribers.add(cb);

    return () => {
        systemHomePathSubscribers.delete(cb);
    };
}

export function setDebounceTimer(nextTimer) {
    debounceTimer = nextTimer;
}

export function clearDebounceTimer() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
}

export function clearPendingCommit(token) {
    if (token !== undefined && token !== pendingCommitToken) {
        return null;
    }

    clearDebounceTimer();
    pendingNextEntries = null;
    if (token === undefined) {
        pendingCommitToken++;
    }

    return pendingCommitToken;
}

export function setPendingCommit(nextEntries) {
    pendingCommitToken++;
    pendingNextEntries = cloneEntries(nextEntries);

    return pendingCommitToken;
}

export function getPendingCommit() {
    if (!pendingNextEntries) {
        return null;
    }

    return {
        entries: cloneEntries(pendingNextEntries),
        token: pendingCommitToken
    };
}

export function getPendingCommitToken() {
    return pendingCommitToken;
}

function cloneEntries(nextEntries) {
    return JSON.parse(JSON.stringify(nextEntries));
}

function getSnapshotData(nextSnapshot) {
    return nextSnapshot?.data ?? nextSnapshot;
}

function entryFromSource(source) {
    const entry = source?.entry && typeof source.entry === 'object' ? source.entry : null;
    const root = entry?.root ?? source?.root ?? source?.path ?? null;
    if (typeof root !== 'string' || root.length === 0) {
        return null;
    }

    return entry ? cloneEntries([{ ...entry, root }])[0] : { root };
}

export function entriesFromSnapshot(nextSnapshot) {
    const data = getSnapshotData(nextSnapshot);
    if (!Array.isArray(data?.sources)) {
        return null;
    }

    return data.sources.map(entryFromSource).filter(Boolean);
}

function defaultWorkspaceFromSnapshot(nextSnapshot) {
    const data = getSnapshotData(nextSnapshot);
    if (typeof data?.default_workspace === 'string') {
        return data.default_workspace;
    }

    const workspaceSource = Array.isArray(data?.sources)
        ? data.sources.find((source) => source?.is_workspace === true)
        : null;
    return workspaceSource ? (getSourceRoot(workspaceSource) ?? '') : '';
}

function isOpenHarmonyFromSnapshot(nextSnapshot) {
    const data = getSnapshotData(nextSnapshot);
    return Boolean(data?.is_openharmony);
}

function platformFromSnapshot(nextSnapshot) {
    const data = getSnapshotData(nextSnapshot);
    return typeof data?.platform === 'string' ? data.platform : '';
}

function systemHomePathFromSnapshot(nextSnapshot) {
    const data = getSnapshotData(nextSnapshot);
    return typeof data?.home_path === 'string' ? data.home_path : '';
}

export function syncStateFromSnapshot(nextSnapshot) {
    setIsOpenHarmony(isOpenHarmonyFromSnapshot(nextSnapshot));
    setPlatform(platformFromSnapshot(nextSnapshot));
    setSystemHomePath(systemHomePathFromSnapshot(nextSnapshot));

    const nextDefaultWorkspace = defaultWorkspaceFromSnapshot(nextSnapshot);
    const defaultWorkspaceUpdated = nextDefaultWorkspace !== defaultWorkspace;
    if (defaultWorkspaceUpdated) {
        setDefaultWorkspace(nextDefaultWorkspace);
    }

    const nextEntries = entriesFromSnapshot(nextSnapshot);
    const pendingCommit = getPendingCommit();
    let entriesUpdated = false;
    let entriesSkippedBecausePending = false;

    if (Array.isArray(nextEntries)) {
        if (pendingCommit) {
            entriesSkippedBecausePending = true;
        } else if (JSON.stringify(nextEntries) !== JSON.stringify(entries)) {
            setEntries(nextEntries);
            entriesUpdated = true;
        }
    }

    return {
        entriesUpdated,
        entriesSkippedBecausePending,
        defaultWorkspaceUpdated
    };
}

function getSourceRoot(source) {
    return source?.root ?? source?.path ?? source?.entry?.root ?? source?.entry?.path ?? null;
}

function createPendingSource(entry) {
    return {
        root: entry.root,
        path: entry.root,
        state: 'pending',
        total_files: 0,
        embedded_count: 0,
        pending_count: 0,
        last_scan_at: null
    };
}

export function applyOptimisticSnapshotUpdate(nextEntries) {
    const currentSnapshot = snapshot;
    const data = currentSnapshot?.data ?? currentSnapshot;
    const currentSources = Array.isArray(data?.sources) ? data.sources : [];
    const sourceRoots = new Set(currentSources.map(getSourceRoot).filter(Boolean));
    const newSources = nextEntries
        .filter((entry) => entry?.root && !sourceRoots.has(entry.root))
        .map(createPendingSource);

    if (newSources.length === 0) {
        return;
    }

    const nextData = {
        ...(data ?? {}),
        sources: [...currentSources, ...newSources]
    };

    if (currentSnapshot && Object.prototype.hasOwnProperty.call(currentSnapshot, 'data')) {
        setSnapshot({
            ...currentSnapshot,
            data: nextData
        });
        return;
    }

    setSnapshot(nextData);
}

export function setUndoSnapshot(nextEntries) {
    _undoSnapshot = cloneEntries(nextEntries);
}

export function clearUndoSnapshot() {
    invalidateUndo();
}

export function invalidateUndo() {
    _undoSnapshot = null;
}

export function rollbackUndo() {
    if (!_undoSnapshot) {
        return null;
    }

    const restoredEntries = cloneEntries(_undoSnapshot);
    setEntries(restoredEntries);
    clearPendingCommit();
    invalidateUndo();

    return restoredEntries;
}

export function __resetForTesting() {
    snapshot = null;
    entries = [];
    defaultWorkspace = '';
    isOpenHarmony = false;
    platform = '';
    systemHomePath = '';
    pendingNextEntries = null;
    pendingCommitToken = 0;
    clearDebounceTimer();
    _undoSnapshot = null;

    snapshotSubscribers.clear();
    entriesSubscribers.clear();
    defaultWorkspaceSubscribers.clear();
    isOpenHarmonySubscribers.clear();
    platformSubscribers.clear();
    systemHomePathSubscribers.clear();
}
