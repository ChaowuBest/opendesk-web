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

import { AgentOperableHTMLElement } from '../../widget_utils.js';
import {
    getFileSystemStatus,
    loadDefaultWorkspace,
    loadEntries,
    openSettings,
    resetFileSystemStorage,
    subscribeStatus
} from './adapter.js';
import { createActions } from './actions.js';
import { createBanner } from './banner.js';
import { showDeleteRootModal, showProtectedWorkspaceModal, showResetModal } from './modal.js';
import { createSources } from './sources.js';
import {
    clearPendingCommit,
    getEntries,
    getSnapshot,
    setEntries,
    setSnapshot,
    syncStateFromSnapshot
} from './state.js';
import { createToast } from './toast.js';
import { createFileTree } from './tree.js';

const ENTRY_STYLE_ID = 'filemgr-entry-styles';

function ensureStyles(doc) {
    if (doc.getElementById(ENTRY_STYLE_ID)) {
        return;
    }

    const style = doc.createElement('style');
    style.id = ENTRY_STYLE_ID;
    style.textContent = `
filemgr-entry-widget {
    display: block;
    width: 100%;
    height: 100%;
}

filemgr-entry-widget .fs-window {
    --filemgr-panel-shadow: 0 10px 30px rgba(0, 0, 0, 0.04);
    width: 100%;
    height: 100%;
    min-height: 0;
    background: var(--od-bg);
    color: var(--od-text);
    overflow: hidden;
}

filemgr-entry-widget .fs-page {
    width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--od-bg);
}

filemgr-entry-widget .fs-content {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 18px 24px 24px;
    overflow: hidden;
}

filemgr-entry-widget .fs-upper {
    flex: 0 0 auto;
}

filemgr-entry-widget .fs-lower {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
}

filemgr-entry-widget .fs-tree-wrapper {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--od-bg-elevated);
    border: 1px solid var(--od-border);
    border-radius: 12px;
    box-shadow: var(--filemgr-panel-shadow);
}

filemgr-entry-widget .fs-tree-mount {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
}

filemgr-entry-widget .fs-loading {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--od-text-muted);
    font-size: 13px;
}

filemgr-entry-widget .fs-error {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    color: #dc2626;
    font-size: 13px;
}
`;
    doc.head.appendChild(style);
}

function basename(path) {
    if (!path || typeof path !== 'string') {
        return '该路径';
    }

    const normalizedPath = path.replace(/[\\/]+$/, '');
    const parts = normalizedPath.split(/[\\/]+/).filter(Boolean);
    return parts.at(-1) || normalizedPath || path;
}

function getSnapshotData(snapshot) {
    return snapshot?.data ?? snapshot;
}

function sourceRoot(source) {
    return source?.root ?? source?.path ?? source?.entry?.root ?? source?.entry?.path ?? null;
}

class FileMgrEntryWidget extends AgentOperableHTMLElement {
    constructor() {
        super();
        this._components = [];
        this._unsubscribeStatus = null;
        this._snapshotSignature = null;
        this._lifecycleToken = 0;
        this._treeView = null;
        this._toast = null;
    }

    connectedCallback() {
        if (this._components.length > 0) {
            return;
        }

        void this._initialize();
    }

    disconnectedCallback() {
        this._teardown();
    }

    async _initialize() {
        const token = ++this._lifecycleToken;
        const doc = this.ownerDocument || document;
        ensureStyles(doc);
        this._renderShell();

        try {
            const [entriesResult, workspaceResult] = await Promise.allSettled([loadEntries(), loadDefaultWorkspace()]);
            if (!this.isConnected || token !== this._lifecycleToken) {
                return;
            }

            const safeEntries =
                entriesResult.status === 'fulfilled' && Array.isArray(entriesResult.value) ? entriesResult.value : [];
            if (entriesResult.status === 'rejected') {
                console.warn('[filemgr] loadEntries failed; falling back to empty entries', entriesResult.reason);
            }

            const defaultWorkspace = workspaceResult.status === 'fulfilled' ? (workspaceResult.value ?? null) : null;
            if (workspaceResult.status === 'rejected') {
                console.warn('[filemgr] loadDefaultWorkspace failed; falling back to null', workspaceResult.reason);
            }

            setEntries(safeEntries);
            this._setSnapshotDirect({
                status: 'initializing',
                mode: null,
                default_workspace: defaultWorkspace,
                alerts: safeEntries.length === 0 ? [{ code: 'no_roots' }] : [],
                sources: safeEntries.map((entry) => ({
                    root: entry.root,
                    entry,
                    state: 'pending',
                    total_files: 0,
                    embedded_count: 0,
                    pending_count: 0,
                    failed_count: 0,
                    last_scan_at: null
                })),
                totals: null,
                storage_stats: null,
                storage: null,
                readonly: false
            });

            this._mountExperience(doc);
            this._subscribeStatus(token);
            void this._refreshStatus(token);
        } catch (err) {
            if (token === this._lifecycleToken) {
                this._renderError(err);
            }
        }
    }

    _renderShell() {
        this.replaceChildren();
        this.innerHTML = `
<div class="fs-window">
    <div class="fs-page">
        <div class="fs-loading">加载智能文件系统...</div>
    </div>
</div>`;
    }

    async _refreshStatus(token) {
        try {
            const snapshot = await getFileSystemStatus();
            if (!this.isConnected || token !== this._lifecycleToken) {
                return;
            }
            this._setSnapshotIfChanged(snapshot);
        } catch (err) {
            console.warn('[filemgr] initial status refresh failed', err);
        }
    }

    _mountExperience(doc) {
        this.replaceChildren();

        const windowElement = doc.createElement('div');
        windowElement.className = 'fs-window';

        const page = doc.createElement('div');
        page.className = 'fs-page';

        const content = doc.createElement('div');
        content.className = 'fs-content';

        const upper = doc.createElement('div');
        upper.className = 'fs-upper';

        const lower = doc.createElement('div');
        lower.className = 'fs-lower';

        const treeWrapper = doc.createElement('div');
        treeWrapper.className = 'fs-tree-wrapper';

        const treeMount = doc.createElement('div');
        treeMount.className = 'fs-tree-mount';

        treeWrapper.appendChild(treeMount);
        lower.appendChild(treeWrapper);
        content.append(upper, lower);
        page.appendChild(content);
        windowElement.appendChild(page);
        this.appendChild(windowElement);

        const banner = createBanner({
            document: doc,
            onOpenSettings: () => {
                openSettings();
            }
        });
        page.prepend(banner.element);

        const sources = createSources({
            document: doc,
            onProtectedWorkspaceDelete: () => {
                void this._showProtectedWorkspaceModal();
            },
            onRequestDeleteRoot: (_source, normalizedSource) => {
                void this._showDeleteRootModal(normalizedSource?.path);
            }
        });
        upper.appendChild(sources.element);

        this._treeView = createFileTree(treeMount, {
            onShowModal: (payload) => {
                void this._showDeleteRootModal(payload.path, payload);
            },
            onToast: (payload) => {
                this._toast?.showFromPayload(payload);
            },
            onError: (err) => {
                console.error('[filemgr] tree initialization failed', err);
            }
        });

        const actions = createActions(lower, {
            tree: this._treeView,
            onShowModal: () => this._showResetModal()
        });
        lower.insertBefore(actions.element, treeWrapper);

        this._toast = createToast({
            tree: this._treeView
        });

        this._components = [banner, sources, actions, this._treeView, this._toast];
    }

    _subscribeStatus(token) {
        this._unsubscribeStatus = subscribeStatus((snapshot) => {
            if (!this.isConnected || token !== this._lifecycleToken) {
                return;
            }

            this._setSnapshotIfChanged(snapshot);
        });
    }

    _setSnapshotIfChanged(nextSnapshot) {
        const nextSignature = JSON.stringify(nextSnapshot ?? null);
        if (nextSignature === this._snapshotSignature) {
            return false;
        }

        this._snapshotSignature = nextSignature;
        syncStateFromSnapshot(nextSnapshot);
        setSnapshot(nextSnapshot);
        return true;
    }

    _setSnapshotDirect(nextSnapshot) {
        this._snapshotSignature = JSON.stringify(nextSnapshot ?? null);
        syncStateFromSnapshot(nextSnapshot);
        setSnapshot(nextSnapshot);
    }

    _removeSnapshotSource(root) {
        const normalizedRoot = root;
        const snapshot = getSnapshot();
        const data = getSnapshotData(snapshot);
        if (!data || !Array.isArray(data.sources)) {
            return;
        }

        const nextSources = data.sources.filter((source) => sourceRoot(source) !== normalizedRoot);
        if (nextSources.length === data.sources.length) {
            return;
        }

        const nextData = {
            ...data,
            sources: nextSources
        };

        if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, 'data')) {
            this._setSnapshotDirect({
                ...snapshot,
                data: nextData
            });
            return;
        }

        this._setSnapshotDirect(nextData);
    }

    async _showDeleteRootModal(root, payload = null) {
        if (!root) {
            return false;
        }
        if (payload?.result?.action === 'protectedWorkspace' || root === (await loadDefaultWorkspace())) {
            return this._showProtectedWorkspaceModal();
        }

        return showDeleteRootModal({
            rootName: basename(root),
            mountTarget: this,
            onConfirm: async () => {
                const nextEntries = Array.isArray(payload?.result?.nextEntries)
                    ? payload.result.nextEntries
                    : getEntries().filter((entry) => entry.root !== root);

                setEntries(nextEntries);
                this._removeSnapshotSource(root);

                if (typeof payload?.commitNow === 'function') {
                    await payload.commitNow(nextEntries);
                } else {
                    await this._treeView?.commitNow(nextEntries);
                }

                this._treeView?.refreshCheckboxes();
                return true;
            }
        });
    }

    async _showProtectedWorkspaceModal() {
        return showProtectedWorkspaceModal({
            mountTarget: this
        });
    }

    async _showResetModal() {
        return showResetModal({
            mountTarget: this,
            onConfirm: () => resetFileSystemStorage()
        });
    }

    _renderError(err) {
        console.error('[filemgr] failed to initialize', err);
        this.replaceChildren();
        this.innerHTML = `
<div class="fs-window">
    <div class="fs-page">
        <div class="fs-error">智能文件系统加载失败，请稍后重试。</div>
    </div>
</div>`;
    }

    _closeOpenModals() {
        this.querySelectorAll('.od-confirm-modal-overlay').forEach((element) => {
            const cancelButton = element.querySelector('[data-action="cancel"]');
            if (cancelButton instanceof HTMLElement) {
                cancelButton.click();
                return;
            }

            element.remove();
        });
    }

    _teardown() {
        this._lifecycleToken++;
        this._closeOpenModals();
        this._unsubscribeStatus?.();
        this._unsubscribeStatus = null;
        clearPendingCommit();

        for (const component of [...this._components].reverse()) {
            component.destroy?.();
        }

        this._components = [];
        this._treeView = null;
        this._toast = null;
    }
}

customElements.define('filemgr-entry-widget', FileMgrEntryWidget);
