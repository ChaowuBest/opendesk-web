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

import { listDirectory, listDrives, loadDefaultWorkspace, saveEntries } from './adapter.js';
import {
    COMMIT_DEBOUNCE_MS,
    applyOptimisticSnapshotUpdate,
    clearPendingCommit,
    clearDebounceTimer,
    getDefaultWorkspace,
    getEntries,
    getPendingCommit,
    getPendingCommitToken,
    getSnapshot,
    invalidateUndo,
    setDefaultWorkspace,
    setEntries,
    setDebounceTimer,
    setPendingCommit,
    setUndoSnapshot,
    subscribeEntries,
    subscribeSnapshot
} from './state.js';
import { FileTreeChecks } from './tree/fileTreeChecks.ts';
import { DRIVE_ROOT_PATH, getHomeRoot, normalizePath } from './tree/utils.js';

function getSnapshotSources() {
    const snapshot = getSnapshot();
    const data = snapshot?.data ?? snapshot;
    return Array.isArray(data?.sources) ? data.sources : [];
}

function getTreeContext(options) {
    return {
        ...(options?.context ?? {}),
        sources: getSnapshotSources(),
        defaultWorkspace: getDefaultWorkspace()
    };
}

function pathDisplayName(path) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath || normalizedPath === '/') {
        return normalizedPath || '';
    }

    const parts = normalizedPath.split('/').filter(Boolean);
    return parts.at(-1) ?? normalizedPath;
}

async function listTreeDirectory(path, opts) {
    if (path === DRIVE_ROOT_PATH) {
        const drives = await listDrives();
        return Array.isArray(drives) ? drives : [];
    }

    const entries = await listDirectory(path, { includeFiles: false, ...opts });
    return Array.isArray(entries) ? entries : [];
}

function injectFileTreeFooterStyle() {
    if (document.querySelector('#filemgr-tree-footer-style')) {
        return;
    }

    const style = document.createElement('style');
    style.id = 'filemgr-tree-footer-style';
    style.textContent = `
.fs-tree-shell {
    display: flex;
    flex-direction: column;
    min-height: 0;
}
.fs-tree-shell.fs-tree-shell-fill {
    flex: 1;
}
.fs-tree-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    padding: 10px 18px;
    color: var(--od-text-muted);
    border-top: 1px solid var(--od-border);
    background: var(--od-bg-muted);
    font-size: 11.5px;
    line-height: 1.3;
    font-weight: 500;
}
.fs-tree-footer .count-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    padding: 1px 7px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--od-accent) 14%, var(--od-bg-elevated));
    color: var(--od-accent);
    font-weight: 600;
    font-size: 11px;
}
.fs-tree-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    color: var(--od-text-muted);
    font-size: 13px;
    text-align: center;
    background: var(--od-bg);
    z-index: 1;
}
.fs-tree-overlay.fs-tree-overlay-error {
    color: var(--od-text);
}
.fs-tree-shell {
    position: relative;
}
`;
    document.head.appendChild(style);
}

function createFooter() {
    const footer = document.createElement('div');
    footer.className = 'fs-tree-footer';

    const prefix = document.createElement('span');
    prefix.textContent = '已选择 ';

    const count = document.createElement('span');
    count.className = 'count-badge';

    const suffix = document.createElement('span');
    suffix.textContent = ' 条扫描路径';

    footer.append(prefix, count, suffix);

    return { footer, count };
}

function notifyHook(callback, payload) {
    if (typeof callback !== 'function') {
        return;
    }

    callback(payload);
}

function scheduleEntriesCommit(nextEntries) {
    clearDebounceTimer();
    const token = setPendingCommit(nextEntries);
    setDebounceTimer(
        setTimeout(() => {
            void commitEntriesNow(undefined, token);
        }, COMMIT_DEBOUNCE_MS)
    );
}

async function commitEntriesNow(nextEntries, token) {
    let entriesToSave = nextEntries;
    let commitToken = token;
    if (!Array.isArray(entriesToSave)) {
        const pendingCommit = getPendingCommit();
        entriesToSave = pendingCommit?.entries;
        commitToken = pendingCommit?.token;
    }

    if (!Array.isArray(entriesToSave)) {
        return null;
    }

    const consumedToken = clearPendingCommit(commitToken);
    if (consumedToken === null) {
        return null;
    }

    await saveEntries(entriesToSave);
    if (getPendingCommitToken() === consumedToken) {
        invalidateUndo();
        applyOptimisticSnapshotUpdate(entriesToSave);
    }

    return entriesToSave;
}

async function commitEntriesImmediately(nextEntries) {
    if (!Array.isArray(nextEntries)) {
        return null;
    }

    const commitToken = clearPendingCommit();
    await saveEntries(nextEntries);
    if (getPendingCommitToken() === commitToken) {
        invalidateUndo();
        applyOptimisticSnapshotUpdate(nextEntries);
    }

    return nextEntries;
}

function createPlaceholderHooks(options) {
    function commitImmediate(nextEntries) {
        if (Array.isArray(nextEntries)) {
            setEntries(nextEntries);
        }

        return commitEntriesImmediately(nextEntries);
    }

    return {
        commit(payload) {
            const nextEntries = payload.result?.nextEntries;
            if (Array.isArray(nextEntries)) {
                const previousEntries = getEntries();
                invalidateUndo();
                if (payload.result?.toast === 'undo') {
                    setUndoSnapshot(previousEntries);
                }
                setEntries(nextEntries);
                scheduleEntriesCommit(nextEntries);
            }

            notifyHook(options?.onCommit, payload);
            notifyHook(options?.onDebounce, { ...payload, delayMs: COMMIT_DEBOUNCE_MS });
        },
        modal(payload) {
            notifyHook(options?.onShowModal, { ...payload, commitNow: commitImmediate });
        },
        toast(payload) {
            notifyHook(options?.onToast, payload);
        }
    };
}

export function createFileTree(container, options = {}) {
    const hooks = createPlaceholderHooks(options);
    let currentRoot = null;
    let currentSelectedPath = null;
    let pendingNavigationKey = null;
    const tree = new FileTreeChecks({
        height: options.height ?? '100%',
        listDirectory: listTreeDirectory,
        getEntries,
        getVisualContext: () => getTreeContext(options),
        onCommit: (payload) => {
            hooks.commit(payload);
            tree.refreshCheckboxes();
        },
        onShowModal: hooks.modal,
        onToast: hooks.toast,
        onSelect: (path) => {
            currentSelectedPath = normalizePath(path);
            notifyHook(options.onSelect, currentSelectedPath || null);
        }
    });

    injectFileTreeFooterStyle();

    const element = document.createElement('div');
    element.className = 'fs-tree-shell';
    if ((options.height ?? '100%') === '100%') {
        element.classList.add('fs-tree-shell-fill');
    }

    const footer = createFooter();

    function refreshFooter() {
        footer.count.textContent = String(getEntries().length);
    }

    const overlay = document.createElement('div');
    overlay.className = 'fs-tree-overlay';
    overlay.textContent = '加载中...';

    element.append(tree.element, footer.footer, overlay);
    container.appendChild(element);
    refreshFooter();

    function setOverlayText(message, { error = false } = {}) {
        overlay.classList.toggle('fs-tree-overlay-error', error);
        overlay.textContent = message;
        if (!overlay.isConnected) {
            element.append(overlay);
        }
    }

    function hideOverlay() {
        overlay.remove();
    }

    let initialRootRendered = false;
    let initialRootInFlight = false;
    let unsubscribePlatformSnapshot = null;
    let overlayTimer = null;
    let resolveFirstRender;
    const firstRenderPromise = new Promise((resolve) => {
        resolveFirstRender = resolve;
    });

    function clearOverlayTimer() {
        if (overlayTimer) {
            clearTimeout(overlayTimer);
            overlayTimer = null;
        }
    }

    function snapshotHasPlatform(snap) {
        const data = snap?.data ?? snap;
        return (
            Boolean(data) &&
            Object.prototype.hasOwnProperty.call(data, 'is_openharmony') &&
            typeof data.platform === 'string' &&
            data.platform.length > 0
        );
    }

    const unsubscribeEntries = subscribeEntries(() => {
        tree.refreshCheckboxes();
        refreshFooter();
    });
    const unsubscribeSnapshot = subscribeSnapshot(() => {
        tree.refreshCheckboxes();
    });

    async function renderInitialRoot(defaultWorkspace) {
        if (initialRootRendered || initialRootInFlight) return;
        initialRootInFlight = true;
        try {
            const home = getHomeRoot(defaultWorkspace);

            if (home === DRIVE_ROOT_PATH) {
                await setRoot(DRIVE_ROOT_PATH);
            } else if (home && home !== '/') {
                await setRootEntry(home);
            } else {
                await setRoot(home);
            }

            initialRootRendered = true;
            clearOverlayTimer();
            if (unsubscribePlatformSnapshot) {
                unsubscribePlatformSnapshot();
                unsubscribePlatformSnapshot = null;
            }
            hideOverlay();
            resolveFirstRender();
        } finally {
            initialRootInFlight = false;
        }
    }

    function handleLateRenderError(err) {
        setOverlayText('文件管理服务初始化失败，请稍后重试', { error: true });
        notifyHook(options.onError, err);
    }

    async function initializeRoot() {
        const defaultWorkspace = normalizePath(await loadDefaultWorkspace());
        setDefaultWorkspace(defaultWorkspace);

        if (snapshotHasPlatform(getSnapshot())) {
            await renderInitialRoot(defaultWorkspace);
            return;
        }

        unsubscribePlatformSnapshot = subscribeSnapshot((snap) => {
            if (!snapshotHasPlatform(snap)) return;
            renderInitialRoot(defaultWorkspace).catch(handleLateRenderError);
        });

        const timeoutMs = typeof options.overlayTimeoutMs === 'number' ? options.overlayTimeoutMs : 5000;
        overlayTimer = setTimeout(() => {
            if (initialRootRendered || initialRootInFlight) return;
            setOverlayText('文件管理服务未响应，请稍后重试', { error: true });
        }, timeoutMs);

        await firstRenderPromise;
    }

    function getNavigationState() {
        return {
            root: currentRoot,
            selectedPath: currentSelectedPath || null
        };
    }

    async function setRoot(path) {
        const normalizedPath = normalizePath(path);
        const navigationKey = `root:${normalizedPath}`;
        if (pendingNavigationKey === navigationKey || (currentRoot === normalizedPath && !currentSelectedPath)) {
            return null;
        }

        pendingNavigationKey = navigationKey;
        try {
            await tree.setRoot(normalizedPath);
            currentRoot = normalizedPath;
            currentSelectedPath = null;
        } finally {
            if (pendingNavigationKey === navigationKey) {
                pendingNavigationKey = null;
            }
        }

        return getNavigationState();
    }

    async function setRootAndExpandTo(rootPath, targetPath) {
        const normalizedRootPath = normalizePath(rootPath);
        const normalizedTargetPath = normalizePath(targetPath);
        const navigationKey = `expand:${normalizedRootPath}:${normalizedTargetPath}`;
        if (
            pendingNavigationKey === navigationKey ||
            (currentRoot === normalizedRootPath && currentSelectedPath === normalizedTargetPath) ||
            (normalizedRootPath === normalizedTargetPath && currentRoot === normalizedRootPath && !currentSelectedPath)
        ) {
            return null;
        }

        pendingNavigationKey = navigationKey;
        try {
            await tree.setRootAndExpandTo(normalizedRootPath, normalizedTargetPath);
            currentRoot = normalizedRootPath;
            currentSelectedPath = normalizePath(tree.selectedPath);
        } finally {
            if (pendingNavigationKey === navigationKey) {
                pendingNavigationKey = null;
            }
        }

        return getNavigationState();
    }

    async function setRootEntryAndExpandTo(rootPath, targetPath) {
        const normalizedRootPath = normalizePath(rootPath);
        const normalizedTargetPath = normalizePath(targetPath);
        const navigationKey = `entry-expand:${normalizedRootPath}:${normalizedTargetPath}`;
        if (
            pendingNavigationKey === navigationKey ||
            (currentRoot === normalizedRootPath && currentSelectedPath === normalizedTargetPath)
        ) {
            return null;
        }

        pendingNavigationKey = navigationKey;
        try {
            await tree.setRootEntryAndExpandTo(
                {
                    path: normalizedRootPath,
                    name: pathDisplayName(normalizedRootPath),
                    isDirectory: true
                },
                normalizedTargetPath
            );
            currentRoot = normalizedRootPath;
            currentSelectedPath = normalizePath(tree.selectedPath);
        } finally {
            if (pendingNavigationKey === navigationKey) {
                pendingNavigationKey = null;
            }
        }

        return getNavigationState();
    }

    async function setRootEntry(path) {
        const normalizedPath = normalizePath(path);
        const navigationKey = `entry:${normalizedPath}`;
        if (
            pendingNavigationKey === navigationKey ||
            (currentRoot === normalizedPath && currentSelectedPath === normalizedPath)
        ) {
            return null;
        }

        pendingNavigationKey = navigationKey;
        try {
            await tree.setRootEntry({
                path: normalizedPath,
                name: pathDisplayName(normalizedPath),
                isDirectory: true
            });
            currentRoot = normalizedPath;
            currentSelectedPath = normalizedPath;
        } finally {
            if (pendingNavigationKey === navigationKey) {
                pendingNavigationKey = null;
            }
        }

        return getNavigationState();
    }

    const ready = initializeRoot().catch((err) => {
        notifyHook(options.onError, err);
        throw err;
    });

    return {
        element,
        tree,
        ready,
        refreshCheckboxes() {
            tree.refreshCheckboxes();
        },
        getNavigationState,
        setRoot,
        setRootAndExpandTo,
        setRootEntryAndExpandTo,
        setRootEntry,
        commitNow(nextEntries) {
            return commitEntriesImmediately(nextEntries);
        },
        get selectedPath() {
            return tree.selectedPath;
        },
        destroy() {
            unsubscribeEntries();
            unsubscribeSnapshot();
            if (unsubscribePlatformSnapshot) {
                unsubscribePlatformSnapshot();
                unsubscribePlatformSnapshot = null;
            }
            clearOverlayTimer();
            tree.destroy();
            element.remove();
        }
    };
}
