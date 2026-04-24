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

function getPathFromFile(file) {
    if (!file) return null;
    const path = window.fsAPI.getFilePath(file);
    return path ? String(path).replace(/\\/g, '/') : null;
}

function getSkillsAPI() {
    if (typeof window.applicationAPI === 'undefined') return null;
    return {
        list: () => window.applicationAPI.call('list'),
        refresh: () => window.applicationAPI.call('refresh'),
        getSkillsDirectory: () => window.applicationAPI.call('getSkillsDirectory'),
        addFromDirectory: (sourceDirectory) => window.applicationAPI.call('addFromDirectory', sourceDirectory),
        addFromZip: (zipPath, skillRelPath) => window.applicationAPI.call('addFromZip', zipPath, skillRelPath),
        delete: (skillId) => window.applicationAPI.call('delete', skillId),
        searchRegistry: (registryId, query, page, limit) =>
            window.applicationAPI.call('searchRegistry', registryId, query, page, limit),
        installFromRegistry: (installUrl, force) =>
            window.applicationAPI.call('installFromRegistry', installUrl, force),
        skillExists: (skillName) => window.applicationAPI.call('skillExists', skillName),
        getSkillDetail: (skillId) => window.applicationAPI.call('getSkillDetail', skillId),
        sendNotification: (type, title, message) => window.applicationAPI.call('sendNotification', type, title, message)
    };
}

function escapeHtml(s) {
    if (s == null) return '';
    const div = document.createElement('div');
    div.textContent = String(s);
    return div.innerHTML;
}

const STYLE = `
:host {
    display: flex; flex-direction: column; height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
    font-size: 13px; color: #1d1d1f; box-sizing: border-box;
    overflow: hidden; background: #f5f5f7;
    -webkit-font-smoothing: antialiased;
}
*, *::before, *::after { box-sizing: border-box; }

/* ── Header row (title, clears window controls) ── */
.header-row {
    flex-shrink: 0; padding: 20px 24px 8px;
    background: #f5f5f7;
    -webkit-app-region: drag;
}
.header-title {
    font-size: 20px; font-weight: 700; color: #1d1d1f; letter-spacing: -0.02em;
    -webkit-app-region: no-drag;
}

/* ── Tab bar row (tabs left, actions right) ── */
.tab-bar-row {
    flex-shrink: 0; display: flex; align-items: center; justify-content: space-between;
    padding: 0 24px; background: #f5f5f7;
    border-bottom: 1px solid #d2d2d7;
    min-height: 40px;
    -webkit-app-region: no-drag;
}
.tab-bar-left { display: flex; align-items: center; gap: 0; }
.tab-bar-right { display: flex; align-items: center; gap: 8px; position: relative; }
.header-count {
    font-size: 12px; font-weight: 500; color: #86868b; margin-right: 12px;
    white-space: nowrap;
}

/* ── Tabs ── */
.tab-btn {
    position: relative; padding: 12px 16px; border: none; background: transparent;
    font-size: 13px; font-weight: 500; color: #86868b; cursor: pointer;
    font-family: inherit; transition: color 0.15s;
    white-space: nowrap;
}
.tab-btn:hover { color: #1d1d1f; }
.tab-btn.active { color: #1d1d1f; }
.tab-btn.active::after {
    content: ''; position: absolute; bottom: -1px; left: 12px; right: 12px;
    height: 2px; background: #0071e3; border-radius: 1px;
}

/* ── Buttons ── */
.btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 14px; border-radius: 8px; border: none;
    background: #fff; color: #1d1d1f; cursor: pointer;
    font-size: 12px; font-weight: 500; line-height: 1;
    box-shadow: 0 0.5px 1px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04);
    transition: all 0.15s ease; font-family: inherit;
}
.btn:hover { background: #fafafa; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
.btn-primary { background: linear-gradient(135deg, #5e5ce6 0%, #0071e3 100%); color: #fff; }
.btn-primary:hover { background: linear-gradient(135deg, #6e6cf0 0%, #0077ED 100%); }
.btn-danger { color: #ff3b30; }
.btn-danger:hover { background: #fff5f5; }
.btn-sm { padding: 5px 10px; font-size: 11px; border-radius: 6px; }
.btn-icon { padding: 6px 8px; min-width: 30px; justify-content: center; }

/* ── Add Dropdown ── */
.add-dropdown-anchor { position: relative; }
.add-dropdown {
    display: none; flex-direction: column;
    position: absolute; top: calc(100% + 6px); right: 0;
    width: 300px; background: #fff; border-radius: 12px;
    border: 1px solid rgba(0,0,0,0.06);
    box-shadow: 0 12px 40px -8px rgba(0,0,0,0.15), 0 4px 12px -2px rgba(0,0,0,0.06);
    z-index: 9999; overflow: hidden;
    animation: dropdown-in 0.16s ease-out;
}
.add-dropdown.visible { display: flex; }
@keyframes dropdown-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
}
.add-dropdown-section { padding: 4px; }
.add-dropdown-section + .add-dropdown-section { border-top: 1px solid #f2f2f7; }
.add-dropdown-item {
    display: flex; align-items: center; gap: 10px;
    width: 100%; padding: 9px 12px; border: none; background: transparent;
    border-radius: 8px; cursor: pointer; text-align: left;
    font-size: 13px; color: #1d1d1f; font-family: inherit;
    transition: background 0.12s;
}
.add-dropdown-item:hover { background: #f5f5f7; }
.add-dropdown-item:active { background: #ebebf0; }
.add-dropdown-item .icon {
    width: 28px; height: 28px; border-radius: 7px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; flex-shrink: 0;
}
.add-dropdown-item .icon.folder { background: #e3f2fd; color: #1976d2; }
.add-dropdown-item .icon.zip { background: #fff3e0; color: #ef6c00; }
.add-dropdown-item .icon.url { background: #e8f5e9; color: #2e7d32; }
.add-dropdown-item .item-info { flex: 1; min-width: 0; }
.add-dropdown-item .item-name { font-weight: 500; line-height: 1.3; }
.add-dropdown-item .item-hint { font-size: 11px; color: #86868b; line-height: 1.3; margin-top: 1px; }
.add-dropdown-item.disabled { opacity: 0.5; cursor: not-allowed; }

/* ── URL Dialog ── */
.url-dialog-overlay {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,0.25); z-index: 10000;
    align-items: center; justify-content: center;
    backdrop-filter: blur(4px);
    animation: fade-in 0.15s ease;
}
.url-dialog-overlay.visible { display: flex; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.modal-dialog {
    background: #fff; border-radius: 14px; padding: 24px; width: 480px; max-width: 90%;
    box-shadow: 0 20px 60px -12px rgba(0,0,0,0.2);
    animation: dialog-in 0.2s ease-out;
    max-height: 80vh; overflow-y: auto;
}
@keyframes dialog-in {
    from { opacity: 0; transform: scale(0.95) translateY(8px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
}
.modal-dialog h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; color: #1d1d1f; }
.modal-dialog .hint { font-size: 12px; color: #86868b; margin-bottom: 14px; }
.modal-dialog input[type="url"] {
    width: 100%; padding: 10px 12px; border: 1px solid #d2d2d7; border-radius: 8px;
    font-size: 13px; font-family: inherit; outline: none; transition: border-color 0.15s;
}
.modal-dialog input[type="url"]:focus { border-color: #0071e3; box-shadow: 0 0 0 3px rgba(0,113,227,0.12); }
.dialog-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

/* ── Skill Detail Modal ── */
.detail-overlay {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,0.3); z-index: 10000;
    align-items: center; justify-content: center;
    backdrop-filter: blur(6px);
    animation: fade-in 0.15s ease;
}
.detail-overlay.visible { display: flex; }
.detail-dialog {
    background: #fff; border-radius: 16px; padding: 0; width: 560px; max-width: 92%;
    max-height: 80vh; overflow: hidden;
    box-shadow: 0 24px 80px -16px rgba(0,0,0,0.25);
    animation: dialog-in 0.2s ease-out;
    display: flex; flex-direction: column;
}
.detail-header {
    display: flex; align-items: center; gap: 14px;
    padding: 20px 24px 16px; border-bottom: 1px solid #f2f2f7;
}
.detail-header .detail-icon {
    width: 48px; height: 48px; border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; color: #fff; flex-shrink: 0;
}
.detail-header-info { flex: 1; min-width: 0; }
.detail-header-info .detail-name { font-size: 17px; font-weight: 700; color: #1d1d1f; margin-bottom: 2px; }
.detail-header-info .detail-id { font-size: 12px; color: #86868b; }
.detail-close {
    width: 28px; height: 28px; border-radius: 50%; border: none;
    background: #f2f2f7; color: #86868b; font-size: 16px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.12s; flex-shrink: 0;
}
.detail-close:hover { background: #e5e5ea; color: #1d1d1f; }
.detail-body {
    flex: 1; overflow-y: auto; padding: 20px 24px 24px;
}
.detail-section { margin-bottom: 16px; }
.detail-section:last-child { margin-bottom: 0; }
.detail-section-label {
    font-size: 11px; font-weight: 600; color: #86868b; text-transform: uppercase;
    letter-spacing: 0.04em; margin-bottom: 6px;
}
.detail-desc { font-size: 13px; color: #1d1d1f; line-height: 1.6; }
.detail-body-content {
    font-size: 12px; line-height: 1.7; color: #3a3a3c;
    white-space: pre-wrap; word-break: break-word;
    background: #f9f9fb; border-radius: 10px; padding: 14px 16px;
    max-height: 240px; overflow-y: auto; border: 1px solid #f2f2f7;
}
.detail-meta-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
}
.detail-meta-item {
    padding: 8px 12px; background: #f9f9fb; border-radius: 8px;
    font-size: 12px; color: #3a3a3c;
}
.detail-meta-item .meta-label { font-size: 10px; color: #86868b; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 2px; }
.detail-meta-item .meta-value { font-weight: 500; }
.detail-resources {
    display: flex; flex-wrap: wrap; gap: 6px;
}
.detail-resource-tag {
    padding: 4px 10px; background: #f2f2f7; border-radius: 6px;
    font-size: 11px; color: #3a3a3c;
}
.detail-footer {
    padding: 12px 24px 16px; border-top: 1px solid #f2f2f7;
    display: flex; justify-content: flex-end; gap: 8px;
}

/* ── Content area ── */
.content { flex: 1; min-height: 0; overflow: hidden; }
.tab-panel { display: none; height: 100%; overflow-y: auto; }
.tab-panel.active { display: block; }

/* ── Installed Skills Panel ── */
.installed-panel { padding: 20px 24px 32px; }
.installed-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 10px;
}
.skill-card {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 14px 16px; border-radius: 12px; background: #fff;
    border: 1px solid rgba(0,0,0,0.04);
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    transition: box-shadow 0.2s, transform 0.15s;
    cursor: pointer;
}
.skill-card:hover {
    box-shadow: 0 4px 14px rgba(0,0,0,0.08); transform: translateY(-1px);
}
.skill-icon {
    width: 38px; height: 38px; border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; flex-shrink: 0; color: #fff;
}
.skill-body { flex: 1; min-width: 0; }
.skill-name {
    font-size: 13px; font-weight: 600; color: #1d1d1f; line-height: 1.3; margin-bottom: 3px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.skill-desc {
    font-size: 11px; color: #86868b; line-height: 1.4;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.skill-actions { flex-shrink: 0; padding-top: 2px; }

/* ── Empty State ── */
.empty-state {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 60px 20px; color: #86868b;
}
.empty-state .empty-icon { font-size: 36px; margin-bottom: 12px; opacity: 0.5; }
.empty-state .empty-title { font-size: 15px; font-weight: 600; color: #1d1d1f; margin-bottom: 6px; }
.empty-state .empty-hint { font-size: 12px; color: #86868b; text-align: center; max-width: 320px; line-height: 1.6; }
.empty-state .empty-dir {
    display: block; padding: 10px 14px; background: #fff; border-radius: 8px;
    font-size: 11px; font-family: 'SF Mono', 'Cascadia Code', monospace;
    color: #86868b; margin-top: 12px; word-break: break-all; border: 1px solid #d2d2d7;
}

/* ── Explore Panel ── */
.explore-panel { padding: 20px 24px 32px; }

/* ── Category Tabs ── */
.category-tabs { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.category-tab {
    padding: 6px 16px; border-radius: 20px; border: 1px solid #d2d2d7;
    background: #fff; color: #1d1d1f; font-size: 12px; font-weight: 500;
    cursor: pointer; font-family: inherit; transition: all 0.15s;
}
.category-tab:hover { background: #f5f5f7; border-color: #c7c7cc; }
.category-tab.active { background: #48484a; color: #fff; border-color: #48484a; }

/* ── Search Card ── */
.search-card {
    background: #fff; border-radius: 12px; padding: 16px 18px;
    border: 1px solid rgba(0,0,0,0.04);
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    margin-bottom: 16px;
}
.search-card .search-label {
    font-size: 11px; font-weight: 600; color: #86868b;
    text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 10px;
}
.search-card .search-row {
    display: flex; gap: 8px; align-items: center;
}
.search-card .search-input {
    flex: 1; min-width: 0; padding: 9px 14px;
    border: 1px solid #d2d2d7; border-radius: 8px;
    font-size: 13px; font-family: inherit; outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
}
.search-card .search-input:focus {
    border-color: #0071e3; box-shadow: 0 0 0 3px rgba(0,113,227,0.1);
}
.search-card .search-input::placeholder { color: #aeaeb2; }
.search-card .search-btn {
    padding: 9px 20px; border-radius: 8px; border: none;
    background: linear-gradient(135deg, #5e5ce6 0%, #0071e3 100%); color: #fff;
    font-size: 13px; font-weight: 500; cursor: pointer;
    font-family: inherit; transition: all 0.15s; white-space: nowrap;
}
.search-card .search-btn:hover { background: linear-gradient(135deg, #6e6cf0 0%, #0077ED 100%); }
.search-card .search-btn:disabled { opacity: 0.45; cursor: not-allowed; }

/* ── Registry Grid ── */
.registry-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 10px;
}
.registry-card {
    display: flex; align-items: flex-start; gap: 12px;
    padding: 14px 16px; border-radius: 12px; background: #fff;
    border: 1px solid rgba(0,0,0,0.04);
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    transition: box-shadow 0.2s, transform 0.15s;
}
.registry-card:hover { box-shadow: 0 4px 14px rgba(0,0,0,0.08); transform: translateY(-1px); }
.registry-card .r-icon {
    width: 38px; height: 38px; border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px; flex-shrink: 0;
}
.registry-card .r-icon.clawhub { background: #e0f7fa; color: #00838f; }
.registry-card .r-icon.matrix { background: #fce4ec; color: #c62828; }
.registry-card .r-body { flex: 1; min-width: 0; }
.registry-card .r-name {
    font-size: 13px; font-weight: 600; color: #1d1d1f; line-height: 1.3; margin-bottom: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.registry-card .r-author { font-size: 11px; color: #aeaeb2; }
.registry-card .r-desc {
    font-size: 11px; color: #86868b; line-height: 1.4; margin-top: 4px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.registry-card .r-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.registry-card .r-stars { font-size: 11px; color: #f5a623; }
.registry-card .r-score { font-size: 10px; color: #aeaeb2; background: #f5f5f7; padding: 2px 6px; border-radius: 4px; }
.registry-card .r-install-btn {
    flex-shrink: 0; padding: 6px 12px; border-radius: 6px; border: none;
    background: #f5f5f7; color: #0071e3; font-size: 11px; font-weight: 600;
    cursor: pointer; font-family: inherit; transition: all 0.15s; align-self: center;
}
.registry-card .r-install-btn:hover { background: #e8f0fe; }
.registry-card .r-install-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.registry-card .r-install-btn.installing { color: #86868b; background: #f5f5f7; }

/* ── Progress ── */
@keyframes pulse-dot { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
.installing-dots span { display: inline-block; animation: pulse-dot 1.2s infinite; font-weight: 700; }
.installing-dots span:nth-child(2) { animation-delay: 0.2s; }
.installing-dots span:nth-child(3) { animation-delay: 0.4s; }
.progress-bar-wrap { width: 100%; height: 3px; background: #e5e5ea; border-radius: 2px; overflow: hidden; margin-top: 6px; }
.progress-bar-indeterminate { width: 40%; height: 100%; background: #0071e3; border-radius: 2px; animation: indeterminate 1.5s ease-in-out infinite; }
@keyframes indeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }

/* ── Registry message ── */
.registry-msg { font-size: 12px; color: #86868b; margin: 12px 0; text-align: center; }
.registry-msg.error { color: #d1242f; }

/* ── Loading ── */
.loading-state { display: flex; flex-direction: column; align-items: center; padding: 40px 20px; color: #86868b; }
.loading-spinner {
    width: 24px; height: 24px; border: 2.5px solid #e5e5ea;
    border-top-color: #0071e3; border-radius: 50%;
    animation: spin 0.8s linear infinite; margin-bottom: 12px;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Scrollbar ── */
.tab-panel::-webkit-scrollbar { width: 6px; }
.tab-panel::-webkit-scrollbar-thumb { background: #c7c7cc; border-radius: 3px; }
.tab-panel::-webkit-scrollbar-thumb:hover { background: #aeaeb2; }
.detail-body::-webkit-scrollbar { width: 5px; }
.detail-body::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
.detail-body-content::-webkit-scrollbar { width: 4px; }
.detail-body-content::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 2px; }
`;

class SkillMgrEntryWidget extends HTMLElement {
    constructor() {
        super();
        this.skills = [];
        this.skillsDir = '';
        this.loading = false;
        this.error = null;
        this.activeTab = 'installed';
        this.addingFromPath = false;
        this.addingFromZip = false;
        this.addingFromUrl = false;
        this.addUrl = '';
        this.deletingId = null;
        this.showAddDropdown = false;
        this.exploreCategory = 'clawhub';
        this.registryQuery = '';
        this.registryResults = [];
        this.registryTotal = 0;
        this.registrySearching = false;
        this.registryHasSearched = false;
        this.registryMessage = null;
        this.installingRegistryIds = new Set();
        this.attachShadow({ mode: 'open' });
        this._onDocClick = (e) => {
            if (this.showAddDropdown) {
                const anchor = this.shadowRoot.querySelector('.add-dropdown-anchor');
                if (anchor && !anchor.contains(e.composedPath()[0])) {
                    this.showAddDropdown = false;
                    this._updateDropdown();
                }
            }
        };
    }

    async connectedCallback() {
        this.render();
        await this.loadSkills();
        document.addEventListener('click', this._onDocClick, true);
    }

    disconnectedCallback() {
        document.removeEventListener('click', this._onDocClick, true);
    }

    async loadSkills() {
        const api = getSkillsAPI();
        if (!api) {
            this.error = '无法连接技能服务';
            this.render();
            return;
        }
        this.loading = true;
        this.error = null;
        this.render();
        try {
            this.skills = await api.list();
            if (!Array.isArray(this.skills)) this.skills = [];
            const dir = await api.getSkillsDirectory();
            if (dir) this.skillsDir = dir;
        } catch (e) {
            this.error = e?.message || '加载失败';
            this.skills = [];
        } finally {
            this.loading = false;
            this.render();
        }
    }

    _notify(type, title, message) {
        const api = getSkillsAPI();
        api?.sendNotification(type, title, message);
    }

    async refresh() {
        const api = getSkillsAPI();
        if (!api) return;
        this.loading = true;
        this.error = null;
        this.render();
        try {
            await api.refresh();
            await this.loadSkills();
        } catch (e) {
            this.error = e?.message || '刷新失败';
            this.render();
        }
    }

    async searchRegistry() {
        const api = getSkillsAPI();
        if (!api?.searchRegistry) {
            this.registryMessage = { text: '无法连接技能服务', isError: true };
            this.render();
            return;
        }
        this.registrySearching = true;
        this.registryMessage = null;
        this.registryResults = [];
        this.render();
        const timeoutMs = 30000;
        const searchPromise = api.searchRegistry(this.exploreCategory, this.registryQuery, 1, 30);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('搜索超时，请检查网络或稍后重试')), timeoutMs)
        );
        try {
            const res = await Promise.race([searchPromise, timeoutPromise]);
            this.registryResults = res?.skills ?? [];
            this.registryTotal = res?.total ?? this.registryResults.length;
            if (res?.error) this.registryMessage = { text: res.error, isError: true };
            else if (res?.message) this.registryMessage = { text: res.message, isError: false };
        } catch (e) {
            this.registryMessage = { text: e?.message || '搜索失败', isError: true };
            this.registryResults = [];
        } finally {
            this.registrySearching = false;
            this.registryHasSearched = true;
            this.render();
        }
    }

    async installFromRegistry(installUrl, skillId) {
        const api = getSkillsAPI();
        if (!installUrl || !api?.installFromRegistry) return;

        let force = false;
        try {
            const exists = await api.skillExists(skillId);
            if (exists) {
                const confirmed = confirm(`技能「${skillId}」已存在，是否覆盖安装？`);
                if (!confirmed) return;
                force = true;
            }
        } catch {
            // skillExists 调用失败时继续正常安装流程
        }

        this.installingRegistryIds.add(skillId);
        this._updateRegistryCard(skillId, true);
        try {
            const addRes = await api.installFromRegistry(installUrl, force);
            this._notify('info', '安装成功', `技能「${addRes?.name ?? ''}」已${force ? '覆盖' : ''}安装`);
            await this.loadSkills();
        } catch (e) {
            this._notify('error', '安装失败', e?.message || '未知错误');
        } finally {
            this.installingRegistryIds.delete(skillId);
            this._updateRegistryCard(skillId, false);
        }
    }

    _updateRegistryCard(skillId, installing) {
        const btn = this.shadowRoot.querySelector(`[data-skill-id="${skillId}"] .r-install-btn`);
        if (!btn) return;
        const card = btn.closest('.registry-card');
        const progressWrap = card?.querySelector('.progress-bar-wrap');
        if (installing) {
            btn.disabled = true;
            btn.innerHTML = '<span class="installing-dots"><span>.</span><span>.</span><span>.</span></span> 安装中';
            btn.classList.add('installing');
            if (!progressWrap && card) {
                const bar = document.createElement('div');
                bar.className = 'progress-bar-wrap';
                bar.innerHTML = '<div class="progress-bar-indeterminate"></div>';
                card.querySelector('.r-body')?.appendChild(bar);
            }
        } else {
            btn.disabled = false;
            btn.textContent = '安装';
            btn.classList.remove('installing');
            if (progressWrap) progressWrap.remove();
        }
    }

    async onPathPicked(file) {
        const filePath = getPathFromFile(file);
        if (!filePath) return;
        const dirPath = filePath.replace(/[/\\][^/\\]*$/, '');
        if (!dirPath) return;
        const api = getSkillsAPI();
        if (!api?.addFromDirectory) return;
        this.addingFromPath = true;
        this.showAddDropdown = false;
        this._updateDropdown();
        try {
            const addRes = await api.addFromDirectory(dirPath);
            this._notify('info', '安装成功', `技能「${addRes?.name ?? ''}」已添加`);
            await this.loadSkills();
        } catch (e) {
            this._notify('error', '添加失败', e?.message || '未知错误');
        } finally {
            this.addingFromPath = false;
        }
    }

    async onZipPicked(file) {
        const path = getPathFromFile(file);
        if (!path) return;
        const api = getSkillsAPI();
        if (!api?.addFromZip) return;
        this.addingFromZip = true;
        this.showAddDropdown = false;
        this._updateDropdown();
        try {
            const addRes = await api.addFromZip(path);
            this._notify('info', '安装成功', `技能「${addRes?.name ?? ''}」已添加`);
            await this.loadSkills();
        } catch (e) {
            this._notify('error', '添加失败', e?.message || '未知错误');
        } finally {
            this.addingFromZip = false;
        }
    }

    async addFromUrl() {
        const api = getSkillsAPI();
        const url = this.addUrl.trim();
        if (!api?.installFromRegistry || !url) return;
        this.addingFromUrl = true;
        this.render();
        try {
            const addRes = await api.installFromRegistry(url);
            this._notify('info', '安装成功', `技能「${addRes?.name ?? ''}」已添加`);
            this.addUrl = '';
            await this.loadSkills();
        } catch (e) {
            this._notify('error', '添加失败', e?.message || '未知错误');
        } finally {
            this.addingFromUrl = false;
            this.render();
        }
    }

    async deleteSkill(skillId) {
        const api = getSkillsAPI();
        if (!api?.delete) return;
        if (!confirm(`确定要删除技能「${skillId}」吗？`)) return;
        this.deletingId = skillId;
        this.render();
        try {
            await api.delete(skillId);
            this._notify('info', '已删除', `技能「${skillId}」已移除`);
            await this.loadSkills();
        } catch (e) {
            this._notify('error', '删除失败', e?.message || '未知错误');
        } finally {
            this.deletingId = null;
            this.render();
        }
    }

    async showSkillDetail(skillId) {
        const api = getSkillsAPI();
        if (!api) return;
        let detail;
        try {
            detail = await api.getSkillDetail(skillId);
        } catch {
            detail = null;
        }
        if (!detail) {
            const skill = this.skills.find((s) => s.id === skillId);
            if (skill) detail = { ...skill, body: '', resources: { references: [], scripts: [], assets: [] } };
            else return;
        }
        this._renderDetailModal(detail);
    }

    _renderDetailModal(detail) {
        this._removeDetailModal();
        const overlay = document.createElement('div');
        overlay.className = 'detail-overlay visible';
        overlay.id = 'detail-overlay';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this._removeDetailModal();
        });

        const metaItems = [];
        if (detail.license) metaItems.push({ label: '许可证', value: detail.license });
        if (detail.compatibility) metaItems.push({ label: '兼容性', value: detail.compatibility });
        if (detail.allowedTools?.length) metaItems.push({ label: '允许工具', value: detail.allowedTools.join(', ') });
        if (detail.skillDir) metaItems.push({ label: '安装路径', value: detail.skillDir });

        const metaHtml =
            metaItems.length > 0
                ? `
          <div class="detail-section">
            <div class="detail-section-label">元信息</div>
            <div class="detail-meta-grid">${metaItems
                .map(
                    (m) =>
                        `<div class="detail-meta-item"><div class="meta-label">${escapeHtml(m.label)}</div><div class="meta-value">${escapeHtml(m.value)}</div></div>`
                )
                .join('')}</div>
          </div>`
                : '';

        const res = detail.resources || {};
        const hasResources = (res.references?.length || 0) + (res.scripts?.length || 0) + (res.assets?.length || 0) > 0;
        const resourceHtml = hasResources
            ? `
          <div class="detail-section">
            <div class="detail-section-label">资源</div>
            <div class="detail-resources">
              ${(res.references || []).map((r) => `<span class="detail-resource-tag">📄 ${escapeHtml(r.name || r)}</span>`).join('')}
              ${(res.scripts || []).map((s) => `<span class="detail-resource-tag">📜 ${escapeHtml(s)}</span>`).join('')}
              ${(res.assets || []).map((a) => `<span class="detail-resource-tag">🖼️ ${escapeHtml(a)}</span>`).join('')}
            </div>
          </div>`
            : '';

        overlay.innerHTML = `
          <div class="detail-dialog">
            <div class="detail-header">
              <div class="detail-icon" style="background: ${this._getSkillColor(detail.name || detail.id)}">${this._getSkillInitial(detail.name || detail.id)}</div>
              <div class="detail-header-info">
                <div class="detail-name">${escapeHtml(detail.name || detail.id)}</div>
                <div class="detail-id">${escapeHtml(detail.id)}</div>
              </div>
              <button type="button" class="detail-close" id="detail-close-btn">×</button>
            </div>
            <div class="detail-body">
              ${detail.description ? `<div class="detail-section"><div class="detail-section-label">简介</div><div class="detail-desc">${escapeHtml(detail.description)}</div></div>` : ''}
              ${detail.body ? `<div class="detail-section"><div class="detail-section-label">技能内容</div><div class="detail-body-content">${escapeHtml(detail.body)}</div></div>` : ''}
              ${metaHtml}
              ${resourceHtml}
            </div>
            <div class="detail-footer">
              <button type="button" class="btn btn-danger btn-sm" id="detail-delete-btn">删除技能</button>
              <button type="button" class="btn btn-sm" id="detail-done-btn">完成</button>
            </div>
          </div>`;
        this.shadowRoot.appendChild(overlay);
        overlay.querySelector('#detail-close-btn')?.addEventListener('click', () => this._removeDetailModal());
        overlay.querySelector('#detail-done-btn')?.addEventListener('click', () => this._removeDetailModal());
        overlay.querySelector('#detail-delete-btn')?.addEventListener('click', () => {
            this._removeDetailModal();
            this.deleteSkill(detail.id);
        });
    }

    _removeDetailModal() {
        this.shadowRoot.getElementById('detail-overlay')?.remove();
    }

    _updateDropdown() {
        const el = this.shadowRoot.querySelector('.add-dropdown');
        if (el) el.classList.toggle('visible', this.showAddDropdown);
    }

    _getSkillInitial(name) {
        if (!name) return '⚡';
        const first = name.charAt(0).toUpperCase();
        return /[A-Z0-9\u4e00-\u9fff]/.test(first) ? first : '⚡';
    }

    _getSkillColor(name) {
        const colors = [
            'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
            'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
            'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
            'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
            'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
            'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)',
            'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)'
        ];
        let hash = 0;
        for (let i = 0; i < (name || '').length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
        return colors[Math.abs(hash) % colors.length];
    }

    render() {
        const scrollPositions = {};
        ['installed-panel-scroll', 'explore-panel-scroll'].forEach((id) => {
            const el = this.shadowRoot.querySelector(`#${id}`);
            if (el) scrollPositions[id] = el.scrollTop;
        });

        const skillCount = this.skills.length;
        const category = this.exploreCategory;
        const categoryLabel = category === 'clawhub' ? 'ClawHub' : 'OpenHarmony Matrix';

        const installedHtml = this.loading
            ? `<div class="loading-state"><div class="loading-spinner"></div><span>加载中…</span></div>`
            : this.error
              ? `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">${escapeHtml(this.error)}</div></div>`
              : skillCount === 0
                ? `<div class="empty-state">
                    <div class="empty-icon">📦</div>
                    <div class="empty-title">暂无已安装技能</div>
                    <div class="empty-hint">通过右上角「添加技能」或「寻找技能」面板安装</div>
                    ${this.skillsDir ? `<code class="empty-dir">${escapeHtml(this.skillsDir)}</code>` : ''}
                  </div>`
                : `<div class="installed-grid">${this.skills
                      .map(
                          (s) => `
                    <div class="skill-card" data-view-skill="${escapeHtml(s.id)}">
                      <div class="skill-icon" style="background: ${this._getSkillColor(s.name || s.id)}">${this._getSkillInitial(s.name || s.id)}</div>
                      <div class="skill-body">
                        <div class="skill-name">${escapeHtml(s.name || s.id || '')}</div>
                        ${s.description ? `<div class="skill-desc">${escapeHtml(s.description)}</div>` : ''}
                      </div>
                      <div class="skill-actions">
                        <button type="button" class="btn btn-sm btn-danger" data-delete="${escapeHtml(s.id)}" ${this.deletingId === s.id ? 'disabled' : ''}>${this.deletingId === s.id ? '…' : '删除'}</button>
                      </div>
                    </div>`
                      )
                      .join('')}</div>`;

        const resultsHtml = this.registrySearching
            ? `<div class="loading-state"><div class="loading-spinner"></div><span>搜索中…</span></div>`
            : this.registryHasSearched && this.registryResults.length > 0
              ? `<div class="registry-grid">${this.registryResults
                    .map((s) => {
                        const isInstalling = this.installingRegistryIds.has(s.id);
                        const iconClass = category === 'clawhub' ? 'clawhub' : 'matrix';
                        return `
                    <div class="registry-card" data-skill-id="${escapeHtml(s.id)}">
                      <div class="r-icon ${iconClass}">${category === 'clawhub' ? '🐾' : '🔷'}</div>
                      <div class="r-body">
                        <div class="r-name">${escapeHtml(s.name || s.id)}</div>
                        ${s.author ? `<div class="r-author">@${escapeHtml(s.author)}</div>` : ''}
                        ${s.description ? `<div class="r-desc">${escapeHtml(s.description)}</div>` : ''}
                        <div class="r-meta">
                          ${s.stars ? `<span class="r-stars">★ ${s.stars}</span>` : ''}
                          ${s.score ? `<span class="r-score">匹配 ${s.score}</span>` : ''}
                        </div>
                        ${isInstalling ? '<div class="progress-bar-wrap"><div class="progress-bar-indeterminate"></div></div>' : ''}
                      </div>
                      <button type="button" class="r-install-btn ${isInstalling ? 'installing' : ''}"
                        data-install-url="${escapeHtml(s.installUrl || '')}"
                        ${!s.canInstall || isInstalling ? 'disabled' : ''}>
                        ${isInstalling ? '<span class="installing-dots"><span>.</span><span>.</span><span>.</span></span> 安装中' : s.canInstall ? '安装' : '不可用'}
                      </button>
                    </div>`;
                    })
                    .join('')}</div>`
              : this.registryHasSearched
                ? `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">未找到结果</div><div class="empty-hint">换个关键词试试</div></div>`
                : `<div class="empty-state"><div class="empty-icon">${category === 'clawhub' ? '🐾' : '🔷'}</div><div class="empty-title">${categoryLabel}</div><div class="empty-hint">输入关键词搜索高质量技能</div></div>`;

        const regMsgHtml = this.registryMessage
            ? `<div class="registry-msg ${this.registryMessage.isError ? 'error' : ''}">${escapeHtml(this.registryMessage.text)}</div>`
            : '';

        this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <div class="header-row">
        <span class="header-title">技能中心</span>
      </div>
      <div class="tab-bar-row">
        <div class="tab-bar-left">
          <button type="button" class="tab-btn ${this.activeTab === 'installed' ? 'active' : ''}" data-tab="installed">已安装 ${skillCount}</button>
          <button type="button" class="tab-btn ${this.activeTab === 'explore' ? 'active' : ''}" data-tab="explore">寻找技能</button>
        </div>
        <div class="tab-bar-right">
          <button type="button" class="btn btn-icon" id="refresh-btn" title="刷新" ${this.loading ? 'disabled' : ''}>↻</button>
          <div class="add-dropdown-anchor">
            <button type="button" class="btn btn-primary" id="add-btn">+ 添加技能</button>
            <div class="add-dropdown" id="add-dropdown">
              <div class="add-dropdown-section">
                <label class="add-dropdown-item ${this.addingFromPath ? 'disabled' : ''}">
                  <input type="file" id="add-from-path-input" webkitdirectory directory style="display:none" ${this.addingFromPath ? 'disabled' : ''} />
                  <span class="icon folder">📁</span>
                  <span class="item-info"><span class="item-name">从目录安装</span><span class="item-hint">选择含 SKILL.md 的目录</span></span>
                </label>
                <label class="add-dropdown-item ${this.addingFromZip ? 'disabled' : ''}">
                  <input type="file" id="add-from-zip-input" accept=".zip" style="display:none" ${this.addingFromZip ? 'disabled' : ''} />
                  <span class="icon zip">📦</span>
                  <span class="item-info"><span class="item-name">从 ZIP 安装</span><span class="item-hint">选择 .zip 技能压缩包</span></span>
                </label>
              </div>
              <div class="add-dropdown-section">
                <button type="button" class="add-dropdown-item" id="add-url-item">
                  <span class="icon url">🔗</span>
                  <span class="item-info"><span class="item-name">从 URL 安装</span><span class="item-hint">ZIP 下载链接 / GitHub tree URL</span></span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="content">
        <div class="tab-panel ${this.activeTab === 'installed' ? 'active' : ''}" id="installed-panel-scroll">
          <div class="installed-panel">${installedHtml}</div>
        </div>
        <div class="tab-panel ${this.activeTab === 'explore' ? 'active' : ''}" id="explore-panel-scroll">
          <div class="explore-panel">
            <div class="category-tabs">
              <button type="button" class="category-tab ${category === 'clawhub' ? 'active' : ''}" data-category="clawhub">🐾 ClawHub</button>
              <button type="button" class="category-tab ${category === 'matrix' ? 'active' : ''}" data-category="matrix">🔷 OpenHarmony Matrix</button>
            </div>
            <div class="search-card">
              <div class="search-label">搜索 ${categoryLabel} 中的技能</div>
              <div class="search-row">
                <input type="text" class="search-input" id="explore-search-input"
                  placeholder="输入关键词搜索…"
                  value="${escapeHtml(this.registryQuery)}" ${this.registrySearching ? 'disabled' : ''} />
                <button type="button" class="search-btn" id="explore-search-btn" ${this.registrySearching ? 'disabled' : ''}>${this.registrySearching ? '搜索中…' : '搜索'}</button>
              </div>
            </div>
            ${regMsgHtml}
            ${resultsHtml}
          </div>
        </div>
      </div>
      <div class="url-dialog-overlay" id="url-dialog-overlay">
        <div class="modal-dialog">
          <h3>从 URL 安装技能</h3>
          <div class="hint">支持 .zip URL 或 GitHub tree URL（如 https://github.com/user/repo/tree/branch）</div>
          <input type="url" id="url-dialog-input" placeholder="https://..." value="${escapeHtml(this.addUrl)}" />
          <div class="dialog-actions">
            <button type="button" class="btn" id="url-dialog-cancel">取消</button>
            <button type="button" class="btn btn-primary" id="url-dialog-ok" ${this.addingFromUrl ? 'disabled' : ''}>${this.addingFromUrl ? '安装中…' : '安装'}</button>
          </div>
        </div>
      </div>`;

        this._bindEvents();

        Object.entries(scrollPositions).forEach(([id, top]) => {
            const el = this.shadowRoot.querySelector(`#${id}`);
            if (el) el.scrollTop = top;
        });
    }

    _bindEvents() {
        const $ = (sel) => this.shadowRoot.querySelector(sel);
        const $$ = (sel) => this.shadowRoot.querySelectorAll(sel);

        $('#refresh-btn')?.addEventListener('click', () => this.refresh());

        $('#add-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showAddDropdown = !this.showAddDropdown;
            this._updateDropdown();
        });

        const pathInput = $('#add-from-path-input');
        if (pathInput)
            pathInput.addEventListener('change', (e) => {
                const f = e.target.files?.[0];
                if (f) this.onPathPicked(f);
                e.target.value = '';
            });

        const zipInput = $('#add-from-zip-input');
        if (zipInput)
            zipInput.addEventListener('change', (e) => {
                const f = e.target.files?.[0];
                if (f) this.onZipPicked(f);
                e.target.value = '';
            });

        $('#add-url-item')?.addEventListener('click', () => {
            this.showAddDropdown = false;
            this._updateDropdown();
            $('#url-dialog-overlay')?.classList.add('visible');
            setTimeout(() => $('#url-dialog-input')?.focus(), 50);
        });

        $('#url-dialog-cancel')?.addEventListener('click', () => $('#url-dialog-overlay')?.classList.remove('visible'));
        $('#url-dialog-overlay')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) e.currentTarget.classList.remove('visible');
        });
        const urlInput = $('#url-dialog-input');
        if (urlInput) {
            urlInput.addEventListener('input', (e) => {
                this.addUrl = e.target.value;
            });
            urlInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.addFromUrl();
            });
        }
        $('#url-dialog-ok')?.addEventListener('click', () => this.addFromUrl());

        $$('.tab-btn').forEach((btn) =>
            btn.addEventListener('click', () => {
                this.activeTab = btn.dataset.tab;
                this.render();
            })
        );

        $$('.category-tab').forEach((btn) =>
            btn.addEventListener('click', () => {
                if (this.exploreCategory !== btn.dataset.category) {
                    this.exploreCategory = btn.dataset.category;
                    this.registryResults = [];
                    this.registryTotal = 0;
                    this.registryHasSearched = false;
                    this.registryMessage = null;
                    this.registryQuery = '';
                    this.render();
                }
            })
        );

        const searchInput = $('#explore-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.registryQuery = e.target.value;
            });
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.searchRegistry();
            });
        }
        $('#explore-search-btn')?.addEventListener('click', () => this.searchRegistry());

        $$('.r-install-btn').forEach((el) => {
            const installUrl = el.getAttribute('data-install-url');
            const card = el.closest('.registry-card');
            const skillId = card?.getAttribute('data-skill-id');
            if (installUrl && !el.disabled)
                el.addEventListener('click', () => this.installFromRegistry(installUrl, skillId));
        });

        $$('[data-view-skill]').forEach((el) => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('[data-delete]')) return;
                this.showSkillDetail(el.getAttribute('data-view-skill'));
            });
        });

        $$('[data-delete]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteSkill(el.getAttribute('data-delete'));
            });
        });
    }
}

customElements.define('skillmgr-entry-widget', SkillMgrEntryWidget);
