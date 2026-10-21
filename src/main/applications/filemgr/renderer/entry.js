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
    forceRefreshScan,
    getFileSystemStatus,
    loadFileMgrSettings,
    saveEntries,
    openSettings,
    resetFileSystemStorage,
    setSourcePaused,
    subscribeStatus
} from './adapter.js';
import { createActions } from './actions.js';
import { createBanner } from './banner.js';
import { showDeleteRootModal, showProtectedWorkspaceModal, showResetModal } from './modal.js';
import { createSources } from './sources.js';
import {
    beginSelectionSession,
    closeSelectionSession,
    entriesEqual,
    getDefaultWorkspace,
    getEntries,
    getSavedEntries,
    initializeSelectionSession,
    isSelectionSession,
    requestSettingsSync,
    setSnapshot,
    syncStateFromSnapshot
} from './state.js';
import { createToast } from './toast.js';
import { createFileTree } from './tree.js';
import { normalizePath } from './tree/utils.js';
import { createRendererTranslator } from '../../../../renderer/locale.ts';

const ENTRY_STYLE_ID = 'filemgr-entry-styles';

function getTopWindow() {
    try {
        return globalThis.window?.top ?? null;
    } catch {
        return null;
    }
}

function getSettingAPI() {
    return globalThis.window?.settingAPI ?? getTopWindow()?.settingAPI;
}

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

class FileMgrEntryWidget extends AgentOperableHTMLElement {
    constructor() {
        super();
        this._components = [];
        this._unsubscribeStatus = null;
        this._snapshotSignature = null;
        this._lifecycleToken = 0;
        this._treeView = null;
        this._toast = null;
        this._t = createRendererTranslator();
        this._settingUnsubscribe = null;
        this._selectionOwner = null;
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

        this._snapshotSignature = null;
        const owner = beginSelectionSession({
            load: loadFileMgrSettings,
            save: saveEntries,
            onFeedback: (kind) => {
                if (kind === 'saved') return;
                if (this.isConnected && token === this._lifecycleToken) {
                    this._toast?.show({ variant: 'info', text: this._t(`renderer.filemgr.selection.${kind}`) });
                }
            }
        });
        this._selectionOwner = owner;
        let localeChanged = false;
        this._subscribeSettingChanges(token, owner, () => {
            localeChanged = true;
        });
        try {
            const settings = await initializeSelectionSession(owner);
            if (!settings || !this.isConnected || token !== this._lifecycleToken) return;
            if (!localeChanged) this._t = createRendererTranslator(settings);

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
        <div class="fs-loading">${this._t('renderer.filemgr.selection.loading')}</div>
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
            t: this._t,
            onOpenSettings: () => {
                openSettings();
            },
            onForceRefresh: () => forceRefreshScan()
        });
        page.prepend(banner.element);

        const sources = createSources({
            document: doc,
            t: this._t,
            onSetSourcePaused: (request) => this._setSourcePaused(request),
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
                void this._showDeleteRootModal(payload.path);
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
            t: this._t,
            tree: this._treeView
        });

        this._components = [banner, sources, actions, this._treeView, this._toast];
    }

    async _setSourcePaused(request) {
        const token = this._lifecycleToken;
        try {
            const snapshot = await setSourcePaused(request);
            if (this.isConnected && token === this._lifecycleToken) this._setSnapshotDirect(snapshot);
            return snapshot;
        } catch (error) {
            if (error?.snapshot && this.isConnected && token === this._lifecycleToken) {
                this._setSnapshotDirect(error.snapshot);
            }
            throw error;
        }
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

    async _showDeleteRootModal(root) {
        const token = this._lifecycleToken;
        const owner = this._selectionOwner;
        if (!root || !isSelectionSession(owner)) return false;
        const protectedRoot = () =>
            Boolean(getDefaultWorkspace()) && normalizePath(root) === normalizePath(getDefaultWorkspace());
        if (protectedRoot()) return this._showProtectedWorkspaceModal();
        const entries = getEntries();
        const target =
            entries.find((entry) => entry.root === root) ??
            entries.find((entry) => normalizePath(entry.root) === normalizePath(root));
        if (!target) return false;
        // Resolve tree/display paths once; confirmation must retain this raw source identity.
        const targetRoot = target.root;
        return showDeleteRootModal({
            rootName: basename(root),
            mountTarget: this,
            t: this._t,
            onConfirm: async () => {
                if (!this.isConnected || token !== this._lifecycleToken || !isSelectionSession(owner)) return false;
                if (protectedRoot()) return this._showProtectedWorkspaceModal();
                const current = getEntries();
                if (!current.some((entry) => entry.root === targetRoot)) return false;
                await this._treeView?.commitNow(current.filter((entry) => entry.root !== targetRoot));
                if (this.isConnected && token === this._lifecycleToken) this._treeView?.refreshCheckboxes();
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
        const token = this._lifecycleToken;
        return showResetModal({
            mountTarget: this,
            onConfirm: () => (this.isConnected && token === this._lifecycleToken ? resetFileSystemStorage() : false)
        });
    }

    _renderError(err) {
        console.error('[filemgr] failed to initialize', err);
        this.replaceChildren();
        this.innerHTML = `
<div class="fs-window">
    <div class="fs-page">
        <div class="fs-error">${this._t('renderer.filemgr.selection.loadError')}</div>
    </div>
</div>`;
    }

    _subscribeSettingChanges(token, owner, onLocale) {
        const api = getSettingAPI();
        this._settingUnsubscribe = api?.onSettingChanged?.((setting) => {
            if (!this.isConnected || token !== this._lifecycleToken) return;
            onLocale();
            this._t = createRendererTranslator(setting);
            for (const component of this._components) component.setTranslator?.(this._t);
            const config = setting?.applications?.filemgr;
            const hasWorkspace = Object.prototype.hasOwnProperty.call(setting ?? {}, 'default_workspace');
            if (
                (owner.reading && (config || hasWorkspace)) ||
                (config && !entriesEqual(config.entries ?? [], getSavedEntries())) ||
                (hasWorkspace && (setting.default_workspace ?? '') !== getDefaultWorkspace())
            ) {
                requestSettingsSync(owner);
            }
        });
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
        this._settingUnsubscribe?.();
        this._settingUnsubscribe = null;
        closeSelectionSession(this._selectionOwner);
        this._selectionOwner = null;

        for (const component of [...this._components].reverse()) {
            component.destroy?.();
        }

        this._components = [];
        this._treeView = null;
        this._toast = null;
    }
}

customElements.define('filemgr-entry-widget', FileMgrEntryWidget);
