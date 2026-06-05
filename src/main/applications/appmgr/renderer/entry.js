/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

function getAppMgrAPI() {
    return {
        listAllApps: () => window.applicationAPI.callMainWorld('listAllApps'),
        installFromZip: (zipPath) => window.applicationAPI.callMainWorld('installFromZip', zipPath),
        createApp: (input) => window.applicationAPI.callMainWorld('createApp', input),
        setActive: (bundleName, active) => window.applicationAPI.callMainWorld('setActive', bundleName, active),
        setCurrentVersion: (bundleName, versionId) =>
            window.applicationAPI.callMainWorld('setCurrentVersion', bundleName, versionId),
        updateMetadata: (input) => window.applicationAPI.callMainWorld('updateMetadata', input),
        deleteApp: (bundleName) => window.applicationAPI.callMainWorld('deleteApp', bundleName),
        getPreviewUrl: (bundleName, versionId) =>
            window.applicationAPI.callMainWorld('getPreviewUrl', bundleName, versionId)
    };
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function appInitial(name) {
    const text = String(name || '?').trim();
    return escapeHtml(text.slice(0, 1).toUpperCase() || '?');
}

const STYLE = `
:host {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: #fff;
    color: #1d1d1f;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    font-size: 13px;
}
* { box-sizing: border-box; }
.header-area {
    flex-shrink: 0;
    padding: 20px 24px 16px;
    background: rgba(255,255,255,0.9);
    border-bottom: 1px solid rgba(0,0,0,0.06);
    backdrop-filter: blur(24px) saturate(180%);
    position: relative;
    z-index: 20;
}
.header-title { font-size: 22px; font-weight: 700; margin-bottom: 14px; }
.seg-row { display: flex; align-items: center; gap: 8px; }
.seg-control { display: inline-flex; flex: 1; min-width: 0; gap: 2px; padding: 3px; border-radius: 10px; background: rgba(0,0,0,0.04); overflow-x: auto; }
.seg-item {
    border: 0;
    background: transparent;
    border-radius: 8px;
    color: rgba(0,0,0,0.45);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 8px 13px;
}
.seg-item.active { background: #fff; color: #1d1d1f; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
.header-actions { position: relative; display: flex; gap: 6px; }
.icon-btn {
    width: 34px;
    height: 34px;
    border-radius: 9px;
    border: 1px solid rgba(0,0,0,0.08);
    background: #fff;
    color: #444;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.icon-btn:hover { background: #f8f8f8; }
.add-menu {
    display: none;
    position: absolute;
    top: 40px;
    right: 0;
    width: 220px;
    padding: 4px;
    border: 1px solid rgba(0,0,0,0.06);
    border-radius: 12px;
    background: #fff;
    box-shadow: 0 16px 50px rgba(0,0,0,0.14);
    z-index: 100;
}
.add-menu.visible { display: block; }
.menu-item {
    width: 100%;
    border: 0;
    background: transparent;
    border-radius: 9px;
    padding: 10px;
    display: flex;
    align-items: center;
    gap: 10px;
    font: inherit;
    cursor: pointer;
    text-align: left;
}
.menu-item:hover { background: #f5f5f5; }
.content { flex: 1; min-height: 0; overflow: hidden; }
.tab-panel { height: 100%; overflow: auto; padding: 20px 24px 60px; }
.cards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 12px; }
.app-card {
    border: 1px solid rgba(0,0,0,0.06);
    border-radius: 14px;
    background: #fff;
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.02);
}
.app-card:hover { box-shadow: 0 4px 20px rgba(0,0,0,0.06); border-color: rgba(0,0,0,0.09); }
.card-header { display: flex; gap: 12px; min-width: 0; }
.card-icon {
    width: 42px;
    height: 42px;
    border-radius: 12px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: #ebf3fe;
    color: #5b8def;
    font-weight: 800;
}
.card-icon img { width: 100%; height: 100%; object-fit: cover; }
.card-info { flex: 1; min-width: 0; }
.card-title { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px; }
.card-sub { font-size: 11px; color: #999; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-desc { min-height: 36px; color: #777; font-size: 12px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card-footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: auto; }
.pill { padding: 4px 9px; border-radius: 999px; background: #f3f4f6; color: #6b7280; font-size: 11px; }
.card-actions { display: flex; align-items: center; gap: 6px; }
.mini-btn {
    height: 28px;
    min-width: 28px;
    padding: 0 9px;
    border-radius: 8px;
    border: 1px solid rgba(0,0,0,0.08);
    background: #fff;
    cursor: pointer;
    color: #555;
}
.mini-btn:hover { background: #f8f8f8; }
.mini-btn.danger { color: #d9534f; }
.toggle { position: relative; width: 40px; height: 24px; display: inline-block; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle-slider { position: absolute; inset: 0; border-radius: 999px; background: #d1d1d6; cursor: pointer; transition: background .2s; }
.toggle-slider::after { content: ''; position: absolute; width: 20px; height: 20px; left: 2px; top: 2px; background: #fff; border-radius: 50%; box-shadow: 0 1px 3px rgba(0,0,0,.18); transition: transform .2s; }
.toggle input:checked + .toggle-slider { background: #34c759; }
.toggle input:checked + .toggle-slider::after { transform: translateX(16px); }
.empty-state { height: 100%; min-height: 360px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #999; text-align: center; }
.empty-icon { width: 54px; height: 54px; border-radius: 16px; display: flex; align-items: center; justify-content: center; background: #ebf3fe; color: #5b8def; font-size: 22px; }
.empty-title { color: #1d1d1f; font-weight: 700; font-size: 16px; }
.empty-hint { max-width: 420px; line-height: 1.6; }
.editor { height: 100%; min-height: 0; }
.editor-left { height: 100%; overflow: auto; padding: 20px 20px 60px 24px; background: #fbfbfc; border-right: 1px solid rgba(0,0,0,0.04); }
.editor-right { height: 100%; min-width: 0; display: flex; flex-direction: column; background: #f8fafc; }
.editor-toolbar { height: 54px; flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 0 16px; border-bottom: 1px solid #e5e7eb; background: #fff; }
.preview-frame { flex: 1; min-height: 0; border: 0; width: 100%; background: #fff; }
.form-section { margin-bottom: 22px; }
.section-title { font-size: 12px; font-weight: 700; color: #666; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 10px; }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.field label { font-size: 12px; color: #666; font-weight: 600; }
.field input, .field textarea, .field select {
    width: 100%;
    border: 1px solid rgba(0,0,0,0.1);
    border-radius: 10px;
    padding: 9px 11px;
    background: #fff;
    font: inherit;
    outline: none;
}
.field textarea { resize: vertical; min-height: 76px; }
.field input:focus, .field textarea:focus, .field select:focus { border-color: #8bb8f0; box-shadow: 0 0 0 3px rgba(90,140,240,.1); }
.icon-edit-row { display: flex; align-items: center; gap: 12px; }
.version-list { display: flex; flex-direction: column; gap: 6px; }
.version-item { border: 1px solid #edf0f3; border-radius: 10px; padding: 9px 11px; background: #fff; }
.version-item.current { border-color: #bcd7ff; background: #f4f8ff; }
.version-name { font-weight: 700; font-size: 12px; }
.version-meta { color: #999; font-size: 11px; margin-top: 3px; }
.modal-overlay { display: none; position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,.18); align-items: center; justify-content: center; backdrop-filter: blur(6px); }
.modal-overlay.visible { display: flex; }
.modal { width: 460px; max-width: calc(100vw - 32px); background: #fff; border-radius: 16px; padding: 22px; box-shadow: 0 24px 80px rgba(0,0,0,.2); }
.modal h3 { margin: 0 0 14px; font-size: 16px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.btn { border: 1px solid rgba(0,0,0,.08); border-radius: 9px; background: #fff; padding: 8px 14px; font: inherit; cursor: pointer; }
.btn.primary { border-color: #5b8def; background: #5b8def; color: #fff; }
.btn.danger { color: #d9534f; }
.status-line { min-height: 18px; color: #d9534f; font-size: 12px; margin-top: 8px; }
`;

class AppMgrEntryWidget extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.api = getAppMgrAPI();
        this.activeTab = 'installed';
        this.userApps = [];
        this.builtinApps = [];
        this.editingApp = null;
        this.addMenuVisible = false;
        this.createDialogVisible = false;
        this.status = '';
    }

    connectedCallback() {
        this.load().catch((error) => {
            this.status = error.message || String(error);
            this.render();
        });
    }

    async load() {
        const data = await this.api.listAllApps();
        this.userApps = data.userApps || [];
        this.builtinApps = data.builtinApps || [];
        if (this.editingApp) {
            this.editingApp = this.userApps.find((app) => app.bundleName === this.editingApp.bundleName) || null;
        }
        this.render();
    }

    render() {
        this.shadowRoot.innerHTML = `
            <style>${STYLE}</style>
            ${this.renderShell()}
            ${this.renderCreateDialog()}
        `;
        this.bindEvents();
    }

    renderShell() {
        if (this.editingApp) {
            return this.renderEditor();
        }
        return `
            <div class="header-area">
                <div class="header-title">应用管理</div>
                <div class="seg-row">
                    <div class="seg-control">
                        ${this.renderTabButton('market', '应用市场', 'fa-store')}
                        ${this.renderTabButton('installed', '已安装应用', 'fa-box-archive')}
                        ${this.renderTabButton('builtin', '内置应用', 'fa-layer-group')}
                    </div>
                    <div class="header-actions">
                        <button class="icon-btn" data-action="toggle-add" title="添加应用"><i class="fa-solid fa-plus"></i></button>
                        <div class="add-menu ${this.addMenuVisible ? 'visible' : ''}">
                            <button class="menu-item" data-action="create"><i class="fa-solid fa-file-circle-plus"></i><span>创建应用</span></button>
                            <button class="menu-item" data-action="import"><i class="fa-solid fa-file-zipper"></i><span>导入应用</span></button>
                        </div>
                    </div>
                </div>
            </div>
            <div class="content">
                ${this.renderCurrentTab()}
            </div>
        `;
    }

    renderTabButton(id, label, icon) {
        return `
            <button class="seg-item ${this.activeTab === id ? 'active' : ''}" data-tab="${id}">
                <i class="fa-solid ${icon}"></i>
                <span>${label}</span>
            </button>
        `;
    }

    renderCurrentTab() {
        if (this.activeTab === 'market') {
            return `
                <div class="tab-panel">
                    <div class="empty-state">
                        <div class="empty-icon"><i class="fa-solid fa-store"></i></div>
                        <div class="empty-title">应用市场即将开放</div>
                        <div class="empty-hint">这里会用于发现、搜索和安装由社区发布的 OpenDesk 应用。当前版本可以先通过右上角导入 zip 应用包。</div>
                    </div>
                </div>
            `;
        }
        if (this.activeTab === 'builtin') {
            return `
                <div class="tab-panel">
                    <div class="cards-grid">${this.builtinApps.map((app) => this.renderBuiltinCard(app)).join('')}</div>
                </div>
            `;
        }
        return `
            <div class="tab-panel">
                ${
                    this.userApps.length === 0
                        ? `<div class="empty-state">
                            <div class="empty-icon"><i class="fa-solid fa-box-open"></i></div>
                            <div class="empty-title">还没有后装应用</div>
                            <div class="empty-hint">点击右上角加号创建一个最小应用模板，或导入符合 AppSDK 清单格式的 zip 应用包。</div>
                        </div>`
                        : `<div class="cards-grid">${this.userApps.map((app) => this.renderUserCard(app)).join('')}</div>`
                }
                <div class="status-line">${escapeHtml(this.status)}</div>
            </div>
        `;
    }

    renderIcon(app) {
        if (app.iconUrl) {
            return `<img src="${escapeHtml(app.iconUrl)}" alt="${escapeHtml(app.name)}">`;
        }
        return `<span>${appInitial(app.name)}</span>`;
    }

    renderUserCard(app) {
        const current = (app.versions || []).find((version) => version.versionId === app.currentVersionId);
        return `
            <div class="app-card" data-bundle-name="${escapeHtml(app.bundleName)}">
                <div class="card-header">
                    <div class="card-icon">${this.renderIcon(app)}</div>
                    <div class="card-info">
                        <div class="card-title">${escapeHtml(app.name)}</div>
                        <div class="card-sub">${escapeHtml(app.bundleName)}</div>
                    </div>
                    <label class="toggle" title="激活应用">
                        <input type="checkbox" data-action="toggle-active" ${app.active ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="card-desc">${escapeHtml(app.description || '无描述')}</div>
                <div class="card-footer">
                    <span class="pill">${escapeHtml(current?.versionName || app.currentVersionId || '未命名版本')}</span>
                    <div class="card-actions">
                        <button class="mini-btn" data-action="edit" title="编辑"><i class="fa-solid fa-pen"></i></button>
                        <button class="mini-btn danger" data-action="delete" title="删除"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>
        `;
    }

    renderBuiltinCard(app) {
        return `
            <div class="app-card">
                <div class="card-header">
                    <div class="card-icon">${this.renderIcon(app)}</div>
                    <div class="card-info">
                        <div class="card-title">${escapeHtml(app.name)}</div>
                        <div class="card-sub">${escapeHtml(app.bundleName)}</div>
                    </div>
                </div>
                <div class="card-desc">OpenDesk 内置系统应用，随主体一起安装和更新。</div>
                <div class="card-footer"><span class="pill">系统应用</span></div>
            </div>
        `;
    }

    renderEditor() {
        const app = this.editingApp;
        const versions = app.versions || [];
        return `
            <splitter-widget class="editor" initial-width="360">
                <div slot="left" class="editor-left">
                    <div class="form-section">
                        <button class="mini-btn" data-action="back"><i class="fa-solid fa-arrow-left"></i> 返回</button>
                    </div>
                    <div class="form-section">
                        <div class="section-title">基本信息</div>
                        <div class="icon-edit-row">
                            <div class="card-icon">${this.renderIcon(app)}</div>
                            <label class="mini-btn">
                                <i class="fa-solid fa-upload"></i> 上传图标
                                <input type="file" accept="image/*" data-action="upload-icon" style="display:none">
                            </label>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="field">
                            <label>包名</label>
                            <input value="${escapeHtml(app.bundleName)}" disabled>
                        </div>
                        <div class="field">
                            <label>显示名称</label>
                            <input id="displayNameInput" value="${escapeHtml(app.name)}">
                        </div>
                        <div class="field">
                            <label>描述</label>
                            <textarea id="descriptionInput">${escapeHtml(app.description || '')}</textarea>
                        </div>
                        <button class="btn primary" data-action="save-metadata">保存信息</button>
                    </div>
                    <div class="form-section">
                        <div class="section-title">当前版本</div>
                        <div class="field">
                            <select id="versionSelect">
                                ${versions
                                    .map(
                                        (version) =>
                                            `<option value="${escapeHtml(version.versionId)}" ${version.versionId === app.currentVersionId ? 'selected' : ''}>${escapeHtml(version.versionName)} (${escapeHtml(version.versionId)})</option>`
                                    )
                                    .join('')}
                            </select>
                        </div>
                    </div>
                    <div class="form-section">
                        <div class="section-title">版本树</div>
                        <div class="version-list">
                            ${versions.map((version) => this.renderVersionItem(version, app.currentVersionId)).join('')}
                        </div>
                    </div>
                    <div class="status-line">${escapeHtml(this.status)}</div>
                </div>
                <div slot="right" class="editor-right">
                    <div class="editor-toolbar">
                        <strong>${escapeHtml(app.name)}</strong>
                        <span class="pill">${escapeHtml(app.currentVersionId)}</span>
                        <button class="mini-btn" data-action="reload-preview" title="刷新预览"><i class="fa-solid fa-rotate-right"></i></button>
                    </div>
                    <iframe class="preview-frame" src="${escapeHtml(app.entryUrl)}"></iframe>
                </div>
            </splitter-widget>
        `;
    }

    renderVersionItem(version, currentVersionId) {
        return `
            <div class="version-item ${version.versionId === currentVersionId ? 'current' : ''}">
                <div class="version-name">${escapeHtml(version.versionName)}</div>
                <div class="version-meta">ID ${escapeHtml(version.versionId)} · 父版本 ${escapeHtml(version.parentVersionId || '无')}</div>
            </div>
        `;
    }

    renderCreateDialog() {
        return `
            <div class="modal-overlay ${this.createDialogVisible ? 'visible' : ''}">
                <div class="modal">
                    <h3>创建应用</h3>
                    <div class="field">
                        <label>包名</label>
                        <input id="createBundleInput" placeholder="my-app">
                    </div>
                    <div class="field">
                        <label>显示名称</label>
                        <input id="createNameInput" placeholder="我的应用">
                    </div>
                    <div class="field">
                        <label>描述</label>
                        <textarea id="createDescriptionInput" placeholder="应用说明"></textarea>
                    </div>
                    <div class="status-line">${escapeHtml(this.status)}</div>
                    <div class="modal-actions">
                        <button class="btn" data-action="cancel-create">取消</button>
                        <button class="btn primary" data-action="confirm-create">创建</button>
                    </div>
                </div>
            </div>
        `;
    }

    bindEvents() {
        this.shadowRoot.querySelectorAll('[data-tab]').forEach((button) => {
            button.addEventListener('click', () => {
                this.activeTab = button.dataset.tab;
                this.addMenuVisible = false;
                this.status = '';
                this.render();
            });
        });
        this.shadowRoot.querySelector('[data-action="toggle-add"]')?.addEventListener('click', (event) => {
            event.stopPropagation();
            this.addMenuVisible = !this.addMenuVisible;
            this.render();
        });
        this.shadowRoot.querySelector('[data-action="create"]')?.addEventListener('click', () => {
            this.addMenuVisible = false;
            this.createDialogVisible = true;
            this.status = '';
            this.render();
        });
        this.shadowRoot.querySelector('[data-action="import"]')?.addEventListener('click', () => this.importApp());
        this.shadowRoot.querySelector('[data-action="cancel-create"]')?.addEventListener('click', () => {
            this.createDialogVisible = false;
            this.status = '';
            this.render();
        });
        this.shadowRoot
            .querySelector('[data-action="confirm-create"]')
            ?.addEventListener('click', () => this.createApp());

        this.shadowRoot.querySelectorAll('.app-card[data-bundle-name]').forEach((card) => {
            const bundleName = card.dataset.bundleName;
            card.querySelector('[data-action="toggle-active"]')?.addEventListener('change', (event) => {
                this.setActive(bundleName, event.target.checked);
            });
            card.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
                this.editingApp = this.userApps.find((app) => app.bundleName === bundleName) || null;
                this.status = '';
                this.render();
            });
            card.querySelector('[data-action="delete"]')?.addEventListener('click', () => this.deleteApp(bundleName));
        });

        this.shadowRoot.querySelector('[data-action="back"]')?.addEventListener('click', () => {
            this.editingApp = null;
            this.status = '';
            this.render();
        });
        this.shadowRoot
            .querySelector('[data-action="save-metadata"]')
            ?.addEventListener('click', () => this.saveMetadata());
        this.shadowRoot
            .querySelector('[data-action="upload-icon"]')
            ?.addEventListener('change', (event) => this.uploadIcon(event));
        this.shadowRoot
            .querySelector('#versionSelect')
            ?.addEventListener('change', (event) => this.setCurrentVersion(event.target.value));
        this.shadowRoot.querySelector('[data-action="reload-preview"]')?.addEventListener('click', () => {
            const frame = this.shadowRoot.querySelector('.preview-frame');
            if (frame?.contentWindow) {
                frame.contentWindow.location.reload();
            }
        });
    }

    async importApp() {
        try {
            this.addMenuVisible = false;
            const paths = await window.fsAPI.selectFile();
            const zipPath = (paths || []).find((item) => String(item).toLowerCase().endsWith('.zip'));
            if (!zipPath) {
                this.status = '请选择 .zip 应用包';
                this.render();
                return;
            }
            const result = await this.api.installFromZip(zipPath);
            await this.load();
            this.activeTab = 'installed';
            this.editingApp = this.userApps.find((app) => app.bundleName === result.app.bundleName) || null;
            this.status = '';
            this.render();
        } catch (error) {
            this.status = error.message || String(error);
            this.render();
        }
    }

    async createApp() {
        try {
            const bundleName = this.shadowRoot.querySelector('#createBundleInput')?.value.trim();
            const displayName = this.shadowRoot.querySelector('#createNameInput')?.value.trim();
            const description = this.shadowRoot.querySelector('#createDescriptionInput')?.value.trim();
            if (!bundleName || !displayName) {
                this.status = '包名和显示名称不能为空';
                this.render();
                return;
            }
            const result = await this.api.createApp({ bundleName, displayName, description });
            this.createDialogVisible = false;
            await this.load();
            this.activeTab = 'installed';
            this.editingApp = this.userApps.find((app) => app.bundleName === result.app.bundleName) || null;
            this.status = '';
            this.render();
        } catch (error) {
            this.status = error.message || String(error);
            this.render();
        }
    }

    async setActive(bundleName, active) {
        try {
            await this.api.setActive(bundleName, active);
            await this.load();
        } catch (error) {
            this.status = error.message || String(error);
            this.render();
        }
    }

    async deleteApp(bundleName) {
        if (!confirm(`删除应用 ${bundleName}？`)) {
            return;
        }
        try {
            await this.api.deleteApp(bundleName);
            if (this.editingApp?.bundleName === bundleName) {
                this.editingApp = null;
            }
            await this.load();
        } catch (error) {
            this.status = error.message || String(error);
            this.render();
        }
    }

    async saveMetadata() {
        if (!this.editingApp) return;
        try {
            const displayName = this.shadowRoot.querySelector('#displayNameInput')?.value.trim();
            const description = this.shadowRoot.querySelector('#descriptionInput')?.value;
            await this.api.updateMetadata({
                bundleName: this.editingApp.bundleName,
                displayName,
                description
            });
            this.status = '';
            await this.load();
        } catch (error) {
            this.status = error.message || String(error);
            this.render();
        }
    }

    async uploadIcon(event) {
        if (!this.editingApp) return;
        try {
            const file = event.target.files?.[0];
            const iconSourcePath = window.fsAPI.getFilePath(file);
            if (!iconSourcePath) return;
            await this.api.updateMetadata({
                bundleName: this.editingApp.bundleName,
                iconSourcePath
            });
            this.status = '';
            await this.load();
        } catch (error) {
            this.status = error.message || String(error);
            this.render();
        }
    }

    async setCurrentVersion(versionId) {
        if (!this.editingApp) return;
        try {
            await this.api.setCurrentVersion(this.editingApp.bundleName, versionId);
            this.status = '';
            await this.load();
        } catch (error) {
            this.status = error.message || String(error);
            this.render();
        }
    }
}

customElements.define('appmgr-entry-widget', AppMgrEntryWidget);
