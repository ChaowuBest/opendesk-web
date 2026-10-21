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

export const COMMIT_DEBOUNCE_MS = 3_000;

let snapshot = null;
let entries = [];
let defaultWorkspace = '';
let isOpenHarmony = false;
let platform = '';
let systemHomePath = '';
let savedEntries = null;
let editToken = 0;
let dueAt = null;
let timer = null;
let undo = null;
let page = null;
let inFlight = null;
export const selectionSubscribers = new Set();

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

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

export function entriesEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return (
        keys.length === Object.keys(b).length &&
        keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && entriesEqual(a[key], b[key]))
    );
}

export function getSavedEntries() {
    return savedEntries;
}

export function getUndo() {
    return undo && undo.token === editToken && Date.now() < undo.expiresAt ? undo : null;
}

export function getSelectionStatus() {
    return {
        editToken,
        dueAt,
        undo: getUndo(),
        submitting: Boolean(inFlight && inFlight.page === page),
        unsaved: savedEntries === null || !entriesEqual(entries, savedEntries)
    };
}

export function subscribeSelection(cb) {
    selectionSubscribers.add(cb);
    return () => selectionSubscribers.delete(cb);
}

function changed() {
    notify(selectionSubscribers, getSelectionStatus());
}

function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
}

export function hasLocalSelection() {
    return (
        savedEntries === null ||
        !entriesEqual(entries, savedEntries) ||
        dueAt !== null ||
        Boolean(getUndo()) ||
        Boolean(inFlight && inFlight.page === page)
    );
}

function acceptSettings(settings) {
    savedEntries = clone(settings?.applications?.filemgr?.entries ?? []);
    setDefaultWorkspace(settings?.default_workspace ?? '');
    setEntries(clone(savedEntries));
    changed();
}

export function beginSelectionSession(options) {
    closeSelectionSession(page);
    page = { ...options, initialized: false, reading: null, needsRead: false, notice: 0 };
    savedEntries = null;
    setEntries([]);
    setDefaultWorkspace('');
    setSnapshot(null);
    return page;
}

export function closeSelectionSession(owner) {
    if (!owner || page !== owner) return;
    page = null;
    clearTimer();
    dueAt = null;
    undo = null;
    changed();
}

export function isSelectionSession(owner) {
    return page === owner;
}

async function readSettings(owner, initial) {
    const guard = { editToken, baseline: savedEntries, notice: owner.notice };
    const handle = {};
    owner.reading = handle;
    owner.needsRead = false;
    try {
        const settings = await owner.load();
        if (page !== owner) return null;
        if (
            guard.notice !== owner.notice ||
            guard.editToken !== editToken ||
            (!initial && (guard.baseline !== savedEntries || hasLocalSelection()))
        ) {
            owner.needsRead = true;
            return null;
        }
        acceptSettings(settings);
        owner.initialized = true;
        return settings;
    } finally {
        if (owner.reading === handle) owner.reading = null;
    }
}

export async function initializeSelectionSession(owner) {
    // A closed page's issued request remains the read barrier for an immediate reopen.
    if (inFlight) await inFlight.promise;
    while (page === owner && !owner.initialized) {
        const settings = await readSettings(owner, true);
        if (settings) return settings;
    }
    return null;
}

function checkSettings(owner = page) {
    if (!owner || page !== owner || !owner.initialized || owner.reading || !owner.needsRead || hasLocalSelection())
        return;
    void readSettings(owner, false)
        .catch((error) => {
            if (page === owner) owner.onFeedback?.('readFailed');
            console.warn('[filemgr] settings refresh failed', error);
        })
        .finally(() => {
            if (page === owner) checkSettings(owner);
        });
}

export function requestSettingsSync(owner) {
    if (page !== owner) return;
    owner.notice++;
    owner.needsRead = true;
    checkSettings(owner);
}

function armCommit() {
    clearTimer();
    if (!page?.initialized || dueAt === null) return;
    const owner = page;
    const wait = dueAt - Date.now();
    if (wait > 0) {
        timer = setTimeout(() => {
            timer = null;
            if (page === owner) pumpCommit();
        }, wait);
    } else {
        pumpCommit();
    }
}

export function editEntries(nextEntries, { undoable = false, immediate = false } = {}) {
    if (!page?.initialized) return false;
    const previous = clone(entries);
    editToken++;
    undo = undoable ? { entries: previous, token: editToken, expiresAt: Date.now() + COMMIT_DEBOUNCE_MS } : null;
    dueAt = Date.now() + (immediate ? 0 : COMMIT_DEBOUNCE_MS);
    setEntries(clone(nextEntries));
    changed();
    armCommit();
    return true;
}

export function rollbackUndo(token = getUndo()?.token) {
    const operation = getUndo();
    if (!operation || token !== operation.token) return null;
    undo = null;
    editToken++;
    const restored = clone(operation.entries);
    setEntries(restored);
    dueAt =
        !inFlight && savedEntries !== null && entriesEqual(entries, savedEntries)
            ? null
            : Date.now() + COMMIT_DEBOUNCE_MS;
    changed();
    armCommit();
    checkSettings();
    return restored;
}

function pumpCommit() {
    if (!page?.initialized || dueAt === null) return;
    if (undo && !getUndo()) undo = null;
    if (inFlight) {
        changed();
        return;
    }
    if (savedEntries !== null && entriesEqual(entries, savedEntries) && !getUndo()) {
        dueAt = null;
        clearTimer();
        changed();
        checkSettings();
        return;
    }
    if (Date.now() < dueAt) {
        armCommit();
        return;
    }
    const request = { entries: clone(entries), token: editToken, page, promise: null };
    dueAt = null;
    clearTimer();
    if (undo?.token === request.token) undo = null;
    inFlight = request;
    // Install the slot before invoking any IPC or subscriber callback.
    request.promise = Promise.resolve()
        .then(() => settleRequest(request))
        .catch((error) => {
            console.warn('[filemgr] selection settlement failed', error);
        })
        .finally(() => {
            if (inFlight === request) inFlight = null;
            if (page === request.page) {
                changed();
                pumpCommit();
                checkSettings();
            }
        });
    changed();
}

async function settleRequest(request) {
    const owner = request.page;
    let result;
    try {
        result = await owner.save(request.entries);
    } catch (error) {
        console.warn('[filemgr] selection save failed', error);
        if (page !== owner) return;
        if (error?.saveAttempted) {
            try {
                const notice = owner.notice;
                const settings = await owner.load();
                if (page !== owner) return;
                if (owner.notice === notice) owner.needsRead = false;
                savedEntries = clone(settings?.applications?.filemgr?.entries ?? []);
                setDefaultWorkspace(settings?.default_workspace ?? '');
                if (editToken === request.token) {
                    setEntries(clone(savedEntries));
                    owner.onFeedback?.('unknownReloaded');
                }
            } catch (readError) {
                if (page === owner) savedEntries = null;
                console.warn('[filemgr] unknown save reread failed', readError);
                if (page === owner && editToken === request.token) owner.onFeedback?.('unknownFailed');
            }
        } else if (editToken === request.token) {
            owner.onFeedback?.('saveFailed');
        }
        if (page === owner) changed();
        return;
    }
    let feedbackToken;
    if (page === owner) {
        const effective = result.settings;
        savedEntries = clone(effective.applications.filemgr.entries);
        setDefaultWorkspace(effective.default_workspace ?? '');
        if (entriesEqual(entries, request.entries) && !getUndo()) {
            setEntries(clone(savedEntries));
            dueAt = null;
            clearTimer();
            feedbackToken = editToken;
        }
        changed();
    }
    const reconciliation = await result.reconciliation;
    if (page === owner && editToken === feedbackToken && entriesEqual(entries, savedEntries) && !getUndo()) {
        owner.onFeedback?.(reconciliation.ok ? 'saved' : 'reconcileFailed');
    }
}

export async function commitEntriesNow(nextEntries) {
    const owner = page;
    if (!editEntries(nextEntries, { immediate: true })) return null;
    while (inFlight && page === owner) await inFlight.promise;
    return page === owner ? getEntries() : null;
}

export function syncStateFromSnapshot(nextSnapshot) {
    const data = nextSnapshot?.data ?? nextSnapshot;
    setIsOpenHarmony(Boolean(data?.is_openharmony));
    setPlatform(typeof data?.platform === 'string' ? data.platform : '');
    setSystemHomePath(typeof data?.home_path === 'string' ? data.home_path : '');
}

export function __resetForTesting() {
    closeSelectionSession(page);
    snapshot = null;
    entries = [];
    savedEntries = null;
    editToken = 0;
    defaultWorkspace = '';
    isOpenHarmony = false;
    platform = '';
    systemHomePath = '';
    for (const subscribers of [
        snapshotSubscribers,
        entriesSubscribers,
        defaultWorkspaceSubscribers,
        isOpenHarmonySubscribers,
        platformSubscribers,
        systemHomePathSubscribers,
        selectionSubscribers
    ])
        subscribers.clear();
}
