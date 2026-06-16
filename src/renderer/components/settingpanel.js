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

import { createRendererTranslator } from '../locale.ts';

class SettingPanel extends HTMLElement {
    constructor() {
        super();
        this.currentData = null;
        this.providerTemplates = [];
        this._saveTimeout = null;
        this._saveDelay = 600;
        this._saving = false;
        this._pendingSave = false;
        this._editingProviderIndex = -1;
        this._editingModelIndex = -1;
        this.appVersion = null;
        this._activeTab = 'models';
        this._environEntries = [];
        this.gatewayHostOptions = [];
        this._hasRendered = false;
        this._t = createRendererTranslator();
    }

    connectedCallback() {
        (async () => {
            await this.loadData();
            this.render();
            this.setUpEventListeners();
        })();
    }

    async loadData() {
        this.currentData = await window.settingAPI.loadSettingObject();
        this._t = createRendererTranslator(this.currentData?.locale);
        this.providerTemplates = await window.settingAPI.getProviderTemplates();
        try {
            this.gatewayHostOptions = await window.settingAPI.getGatewayHostOptions();
        } catch (e) {
            console.warn('Failed to load gateway host options:', e);
            this.gatewayHostOptions = [
                { value: 'none', label: '无（关闭监听服务）' },
                { value: '127.0.0.1', label: '127.0.0.1（仅本机）' },
                { value: '0.0.0.0', label: '0.0.0.0（所有 IPv4 地址）' }
            ];
        }
        try {
            this.appVersion = await window.settingAPI.getVersion();
        } catch (e) {
            console.warn('Failed to load version:', e);
        }
    }

    render() {
        if (this._hasRendered) {
            this._switchTab(this._activeTab);
            return;
        }
        const tabs = [
            { id: 'models', icon: 'fa-brain', label: '模型设置' },
            { id: 'tasks', icon: 'fa-list-check', label: '任务设置' },
            { id: 'search', icon: 'fa-magnifying-glass', label: '搜索设置' },
            { id: 'general', icon: 'fa-sliders', label: '通用设置' }
        ];

        const tabButtons = tabs
            .map((t) => {
                const active = t.id === this._activeTab;
                return `<button class="seg-item ${active ? 'active' : ''}" data-tab="${t.id}">
                <i class="fas ${t.icon} seg-icon"></i> ${t.label}
            </button>`;
            })
            .join('');

        this.innerHTML = `
        <style>
            /* 技能中心风格的 segmented control */
            .seg-control {
                display: inline-flex; min-width: 0;
                background: var(--sp-seg-control-bg, rgba(0, 0, 0, 0.04));
                border-radius: 10px; padding: 3px; gap: 2px;
            }
            .seg-item {
                padding: 7px 13px; border-radius: 8px; border: none;
                background: transparent; color: var(--sp-seg-item-color, rgba(0, 0, 0, 0.44));
                font-size: 12px; font-weight: 500; cursor: pointer;
                transition: all 0.22s cubic-bezier(0.4, 0, 0.2, 1);
                white-space: nowrap;
                display: inline-flex; align-items: center; gap: 5px; line-height: 1;
            }
            .seg-item:hover {
                color: var(--sp-seg-item-hover-color, rgba(0, 0, 0, 0.64));
                background: var(--sp-seg-item-hover-bg, transparent);
            }
            .seg-item:focus-visible {
                outline: 2px solid var(--od-accent);
                outline-offset: 2px;
            }
            .seg-item.active {
                background: var(--sp-seg-active-bg, #fff);
                color: var(--sp-seg-active-color, #1d1d1f);
                box-shadow: var(--sp-seg-active-shadow, 0 1px 3px rgba(0,0,0,0.06), 0 0.5px 1px rgba(0,0,0,0.03));
            }
            .seg-item .seg-icon { font-size: 13px; }
            html[data-theme='dark'] setting-panel {
                --sp-seg-control-bg: rgba(255, 255, 255, 0.08);
                --sp-seg-item-color: var(--od-text-muted);
                --sp-seg-item-hover-color: var(--od-text);
                --sp-seg-item-hover-bg: rgba(255, 255, 255, 0.06);
                --sp-seg-active-bg: rgba(255, 255, 255, 0.14);
                --sp-seg-active-color: var(--od-text);
                --sp-seg-active-shadow: 0 1px 4px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.08);
            }

            /* Setting panel scrollbar */
            .sp-scroll-content::-webkit-scrollbar { width: 6px; }
            .sp-scroll-content::-webkit-scrollbar-track { background: transparent; }
            .sp-scroll-content::-webkit-scrollbar-thumb {
                background: #d1d5db;
                border-radius: 3px;
            }
            .sp-scroll-content::-webkit-scrollbar-thumb:hover { background: #9ca3af; }

            html[data-theme='dark'] setting-panel .sp-scroll-content::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.18);
            }
            html[data-theme='dark'] setting-panel .sp-scroll-content::-webkit-scrollbar-thumb:hover {
                background: rgba(255, 255, 255, 0.28);
            }
        </style>
        <div class="w-full h-full overflow-hidden flex flex-col bg-gradient-to-br from-slate-50 via-white to-blue-50/30">
            <!-- 固定在右上角的工具栏 -->
            <div id="setting-panel-toolbar" class="sp-fixed-toolbar"></div>

            <!-- 顶部标题栏 + Tab -->
            <div class="sticky top-0 z-10 bg-white/60 backdrop-blur-2xl border-b border-gray-100/50">
                <div class="px-6 py-4 flex items-center">
                    <h1 class="od-setting-title text-2xl font-bold bg-gradient-to-r from-gray-800 to-gray-600 bg-clip-text text-transparent">设置</h1>
                    <span id="save-indicator" class="ml-4 text-xs text-green-500 opacity-0 transition-opacity duration-300 flex items-center gap-1">
                        <i class="fas fa-check-circle"></i> 已保存
                    </span>
                </div>
                <!-- Tab 栏：参考技能中心风格 -->
                <div class="px-6 pb-3 flex items-center gap-3">
                    <div class="seg-control">
                        ${tabButtons}
                    </div>
                    <div class="ml-auto flex items-center">
                        ${this.renderActionButtons()}
                    </div>
                </div>
            </div>

            <!-- 可滚动内容区 -->
            <div class="sp-scroll-content flex-1 overflow-y-auto px-6 py-6">
                <div id="tab-models" class="${this._activeTab === 'models' ? '' : 'hidden'} space-y-8">
                    ${this.renderProvidersSection()}
                    ${this.renderModelsSection()}
                    ${this.renderDefaultModelsSection()}
                </div>
                <div id="tab-tasks" class="${this._activeTab === 'tasks' ? '' : 'hidden'} space-y-8">
                    ${this.renderTaskSection()}
                </div>
                <div id="tab-search" class="${this._activeTab === 'search' ? '' : 'hidden'} space-y-8">
                    ${this.renderSearchSection()}
                </div>
                <div id="tab-general" class="${this._activeTab === 'general' ? '' : 'hidden'} space-y-8">
                    ${this.renderGeneralSection()}
                </div>
            </div>

            <!-- 底部版本信息栏 -->
            <div class="shrink-0 px-6 py-3 border-t border-gray-200/50 bg-white/40 backdrop-blur-sm text-center">
                <span class="text-xs text-gray-400">OpenDesk v${this.appVersion || '...'}</span>
            </div>
        </div>

        <!-- 模态框容器 -->
        <div id="modal-overlay" class="hidden fixed inset-0 z-50 bg-black/30 backdrop-blur-sm"></div>
        <div id="modal-container" class="hidden fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div id="modal-content" class="pointer-events-auto"></div>
        </div>
        `;

        this._createSettingPanelToolbar();
        this._hasRendered = true;
    }

    _createSettingPanelToolbar() {
        const container = this.querySelector('#setting-panel-toolbar');
        if (!container) return;
        // toolbar is now empty (buttons moved to inline button group)
    }

    _switchTab(tab) {
        this._activeTab = tab;
        this.querySelectorAll('.seg-item[data-tab]').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        const tabIds = ['models', 'tasks', 'search', 'general'];
        for (const id of tabIds) {
            const el = this.querySelector(`#tab-${id}`);
            if (el) el.classList.toggle('hidden', id !== tab);
        }
    }

    renderActionButtons() {
        return `
            <div class="seg-control setting-action-control">
                <button id="quick-setup-btn" class="seg-item setting-action-item">
                    <i class="fa-solid fa-magic seg-icon"></i><span>快速设置</span>
                </button>
                <button id="import-quickpass-btn" class="seg-item setting-action-item">
                    <i class="fa-solid fa-key seg-icon"></i><span>导入口令</span>
                </button>
                <button id="export-quickpass-btn" class="seg-item setting-action-item">
                    <i class="fa-solid fa-file-export seg-icon"></i><span>导出口令</span>
                </button>
                <button id="advanced-setting-btn" class="seg-item setting-action-item">
                    <i class="fa-solid fa-cog seg-icon"></i><span>高级设置</span>
                </button>
            </div>
        `;
    }

    renderTaskSection() {
        const taskConfig = this.currentData?.task_config || {};
        const autoRetry = taskConfig.auto_retry !== false;

        return `
        <section>
            <div class="flex items-center gap-2 mb-4">
                <h2 class="text-base font-semibold text-gray-800">任务设置</h2>
            </div>
            <div class="bg-white/70 backdrop-blur-xl rounded-2xl border border-white/50 shadow-lg p-5 space-y-5">
                <label class="flex items-start justify-between gap-5 cursor-pointer">
                    <div class="min-w-0">
                        <div class="text-sm font-medium text-gray-700">LLM 请求失败时自动重试</div>
                        <p class="text-xs text-gray-400 mt-1 leading-relaxed">
                            任务中的模型请求失败后自动重试，间隔按 10 秒起步指数退避，最长不超过 10 分钟。
                        </p>
                    </div>
                    <input id="task-auto-retry-toggle" type="checkbox" ${autoRetry ? 'checked' : ''} class="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-400/30 shrink-0">
                </label>
            </div>
        </section>
        `;
    }

    renderSearchSection() {
        const searchConfig = this._getSearchConfig();
        const channels = searchConfig.channels || {};
        const defaultWeb = searchConfig.defaultWebSearch || 'bing';
        const defaultAcademic = searchConfig.defaultAcademicSearch || 'arxiv';
        const webSearchEnabled = searchConfig.webSearchEnabled !== false; // 默认 true
        const academicSearchEnabled = searchConfig.academicSearchEnabled !== false; // 默认 true
        const bingChannels = channels.bing || {};
        const bingLang = bingChannels.lang || 'zh';

        const webChannels = [
            { id: 'duckduckgo', name: 'DuckDuckGo', desc: '注重隐私的免费搜索引擎', needsKey: false },
            { id: 'bing', name: 'Bing', desc: '免费的网页搜索引擎，支持中文版和全球版', needsKey: false },
            { id: 'baidu', name: '百度', desc: '中文网页搜索引擎，自动过滤广告', needsKey: false },
            { id: 'tavily', name: 'Tavily', desc: '专为AI设计的搜索引擎', needsKey: true },
            { id: 'brave', name: 'Brave', desc: '隐私优先的搜索引擎', needsKey: true },
            { id: 'bocha', name: '博查', desc: '专为AI设计的中文搜索引擎', needsKey: true },
            { id: 'exa', name: 'Exa', desc: 'AI驱动的搜索引擎', needsKey: true }
        ];

        const webChannelCards = webChannels
            .map((ch) => {
                const apiKey = channels[ch.id]?.api_key || '';
                const hasKey = apiKey !== '';
                const isDefault = ch.id === defaultWeb;
                const canSelect = !ch.needsKey || hasKey;
                const statusColor = canSelect ? (isDefault ? 'text-emerald-600' : 'text-gray-400') : 'text-orange-400';
                const statusText = isDefault ? '当前默认' : canSelect ? '可用' : '需要 API Key';
                const borderColor = isDefault ? 'border-emerald-200/60' : '';
                const bgColor = isDefault ? 'bg-emerald-50/30' : '';

                return `
            <div class="bg-white/70 backdrop-blur-xl rounded-2xl border ${borderColor || 'border-gray-100/60'} ${bgColor} shadow-sm p-4">
                <div class="flex items-start justify-between">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                            <h3 class="font-semibold text-gray-800">${ch.name}</h3>
                            <span class="text-[11px] px-2 py-0.5 rounded-full ${isDefault ? 'bg-emerald-100/70 text-emerald-700' : canSelect ? 'bg-gray-100 text-gray-500' : 'bg-orange-100 text-orange-600'}">${statusText}</span>
                        </div>
                        <p class="text-xs text-gray-400 mt-1">${ch.desc}</p>
                    </div>
                    ${
                        canSelect && !isDefault
                            ? `
                    <button class="search-set-default-btn px-3 py-1.5 text-xs text-blue-500 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors shrink-0" data-channel="${ch.id}" data-type="web">设为默认</button>
                    `
                            : ''
                    }
                </div>
                ${
                    ch.needsKey
                        ? `
                <div class="mt-2 flex items-center gap-2">
                    <input type="password" class="search-api-key-input flex-1 px-3 py-1.5 text-xs bg-white/60 border border-gray-200/60 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/30" value="${this.escapeHtml(apiKey)}" placeholder="API Key" data-channel="${ch.id}">
                    <button class="search-set-key-btn px-3 py-1.5 text-xs text-white bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors" data-channel="${ch.id}">保存</button>
                </div>
                `
                        : ''
                }
                ${
                    ch.id === 'bing'
                        ? `
                <div class="mt-2 flex items-center gap-2">
                    <label class="text-xs text-gray-500 shrink-0">搜索区域</label>
                    <select class="bing-lang-select flex-1 px-3 py-1.5 text-xs bg-white/60 border border-gray-200/60 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/30">
                        <option value="zh" ${bingLang === 'zh' ? 'selected' : ''}>中国版 (cn.bing.com)</option>
                        <option value="en" ${bingLang === 'en' ? 'selected' : ''}>全球版 (www.bing.com)</option>
                    </select>
                </div>
                `
                        : ''
                }
            </div>
            `;
            })
            .join('');

        const academicChannels = [
            { id: 'arxiv', name: 'arXiv', desc: '学术论文预印本搜索引擎' },
            { id: 'dblp', name: 'DBLP', desc: '计算机科学文献数据库' }
        ];
        const academicChannelCards = academicChannels
            .map((ch) => {
                const isDefault = ch.id === defaultAcademic;
                return `
            <div class="bg-white/70 backdrop-blur-xl rounded-2xl border ${isDefault ? 'border-emerald-200/60 bg-emerald-50/30' : 'border-gray-100/60'} shadow-sm p-4">
                <div class="flex items-start justify-between">
                    <div>
                        <div class="flex items-center gap-2">
                            <h3 class="font-semibold text-gray-800">${ch.name}</h3>
                            <span class="text-[11px] px-2 py-0.5 rounded-full ${isDefault ? 'bg-emerald-100/70 text-emerald-700' : 'bg-gray-100 text-gray-500'}">${isDefault ? '当前默认' : '可用'}</span>
                        </div>
                        <p class="text-xs text-gray-400 mt-1">${ch.desc}</p>
                    </div>
                    ${
                        !isDefault
                            ? `
                    <button class="search-set-default-btn px-3 py-1.5 text-xs text-blue-500 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors shrink-0" data-channel="${ch.id}" data-type="academic">设为默认</button>
                    `
                            : ''
                    }
                </div>
            </div>
            `;
            })
            .join('');

        return `
        <!-- 网页搜索引擎 -->
        <section>
            <div class="flex items-center gap-2 mb-4">
                <h2 class="text-base font-semibold text-gray-800">网页搜索引擎</h2>
                <span class="text-xs text-gray-400 ml-2">WebSearch 工具使用的渠道</span>
                <label class="search-toggle-label relative inline-flex items-center cursor-pointer ml-auto" data-type="web">
                    <input type="checkbox" class="search-toggle-checkbox sr-only peer" ${webSearchEnabled ? 'checked' : ''}>
                    <div class="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-500"></div>
                </label>
            </div>
            <div class="${webSearchEnabled ? '' : 'hidden'}">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    ${webChannelCards}
                </div>
                <p class="text-xs text-gray-400 mt-3 flex items-center gap-1">
                    <i class="fas fa-info-circle"></i>
                    默认渠道将用于所有 WebSearch 调用。需要 API Key 的渠道必须配置 Key 后才能设为默认。
                </p>
            </div>
            ${!webSearchEnabled ? '<p class="text-xs text-gray-400 mt-3 flex items-center gap-1"><i class="fas fa-info-circle"></i>网页搜索已关闭，WebSearch 工具将不可用</p>' : ''}
        </section>

        <!-- 学术搜索引擎 -->
        <section>
            <div class="flex items-center gap-2 mb-4">
                <h2 class="text-base font-semibold text-gray-800">学术搜索引擎</h2>
                <span class="text-xs text-gray-400 ml-2">AcademicSearch 工具使用的渠道</span>
                <label class="search-toggle-label relative inline-flex items-center cursor-pointer ml-auto" data-type="academic">
                    <input type="checkbox" class="search-toggle-checkbox sr-only peer" ${academicSearchEnabled ? 'checked' : ''}>
                    <div class="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-500"></div>
                </label>
            </div>
            <div class="${academicSearchEnabled ? '' : 'hidden'}">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    ${academicChannelCards}
                </div>
            </div>
            ${!academicSearchEnabled ? '<p class="text-xs text-gray-400 mt-3 flex items-center gap-1"><i class="fas fa-info-circle"></i>学术搜索已关闭，AcademicSearch 工具将不可用</p>' : ''}
        </section>
        `;
    }

    _getSearchConfig() {
        const apps = this.currentData?.applications || {};
        return apps.search || {};
    }

    _normalizeGatewayHost(host) {
        const value = String(host || '').trim();
        if (!value) return '127.0.0.1';
        const lower = value.toLowerCase();
        if (lower === 'none' || lower === 'off' || lower === 'disabled' || value === '无') return 'none';
        if (value === '*') return '0.0.0.0';
        return value;
    }

    _getGatewayConfig() {
        const raw = this.currentData?.applications?.devicemgr || {};
        const host = this._normalizeGatewayHost(raw.host || '127.0.0.1');
        const disabled = raw.enabled === false || host === 'none';
        const port = Number.isInteger(raw.port) && raw.port > 0 ? raw.port : 19010;
        return {
            enabled: !disabled,
            host: disabled ? 'none' : host,
            port,
            autoApproveLocal: raw.autoApproveLocal !== false
        };
    }

    _getGatewayHostOptions(currentHost) {
        const options =
            Array.isArray(this.gatewayHostOptions) && this.gatewayHostOptions.length > 0
                ? [...this.gatewayHostOptions]
                : [
                      { value: 'none', label: '无（关闭监听服务）' },
                      { value: '127.0.0.1', label: '127.0.0.1（仅本机）' },
                      { value: '0.0.0.0', label: '0.0.0.0（所有 IPv4 地址）' }
                  ];

        if (!options.some((option) => option.value === currentHost)) {
            options.push({ value: currentHost, label: `自定义：${currentHost}` });
        }
        return options;
    }

    renderGatewaySection() {
        const config = this._getGatewayConfig();
        const hostOptions = this._getGatewayHostOptions(config.host);
        const statusText = config.enabled ? `${config.host}:${config.port}` : '已关闭';
        const statusClass = config.enabled ? 'bg-emerald-100/70 text-emerald-700' : 'bg-gray-100 text-gray-500';

        return `
        <section>
            <div class="flex items-center gap-2 mb-4">
                <h2 class="text-base font-semibold text-gray-800">设备网关</h2>
                <span class="text-xs px-2 py-0.5 rounded-full ${statusClass}">${this.escapeHtml(statusText)}</span>
            </div>
            <div class="bg-white/70 backdrop-blur-xl rounded-2xl border border-white/50 shadow-lg p-5 space-y-4">
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">监听地址</label>
                        <select id="gateway-host-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            ${hostOptions
                                .map(
                                    (option) =>
                                        `<option value="${this.escapeHtml(option.value)}" ${option.value === config.host ? 'selected' : ''}>${this.escapeHtml(option.label)}</option>`
                                )
                                .join('')}
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">监听端口</label>
                        <input id="gateway-port-input" type="number" min="1" max="65535" step="1" value="${config.port}" ${config.enabled ? '' : 'disabled'} class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all disabled:opacity-50">
                    </div>
                    <div class="flex items-end">
                        <label class="flex items-center gap-2 h-[42px] text-sm text-gray-600 ${config.enabled ? '' : 'opacity-50'}">
                            <input id="gateway-auto-approve-input" type="checkbox" ${config.autoApproveLocal ? 'checked' : ''} ${config.enabled ? '' : 'disabled'} class="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-400/30">
                            自动审批本机配对
                        </label>
                    </div>
                </div>
            </div>
        </section>
        `;
    }

    renderGeneralSection() {
        const currentLocale = this.currentData?.locale || 'auto';
        const fontPreset = this.currentData?.gui_config?.font_preset || 'default';
        const themePreference = this.currentData?.gui_config?.theme_preference || 'system';
        const scaleFactor = this.currentData?.gui_config?.scale_factor ?? 1;
        const developerMode = !!this.currentData?.developer_mode;
        const scaleSteps = [0.75, 0.9, 1, 1.25, 1.5];
        const scaleLabels = {
            'zh-CN': ['极小', '小', '标准', '大', '极大'],
            'en-US': ['Tiny', 'Small', 'Standard', 'Large', 'Extra Large'],
            auto: ['极小', '小', '标准', '大', '极大']
        };
        const labels = scaleLabels[currentLocale] || scaleLabels['auto'];
        const currentStepIndex = scaleSteps.indexOf(scaleFactor);
        const activeStep = currentStepIndex >= 0 ? currentStepIndex : 2;

        // 环境变量
        const environ = this.currentData?.environ || {};
        const environEntries = Object.entries(environ);

        const renderEnvironList = () => {
            const items = environEntries
                .map(
                    (entry, i) => `
                <div class="environ-item flex items-center gap-2 mb-2" data-index="${i}">
                    <input type="text" class="environ-key flex-1 px-3 py-2 text-sm bg-white/60 border border-gray-200/60 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/30" value="${this.escapeHtml(entry[0])}" placeholder="变量名">
                    <span class="text-gray-400 text-xs">=</span>
                    <input type="text" class="environ-value flex-1 px-3 py-2 text-sm bg-white/60 border border-gray-200/60 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/30" value="${this.escapeHtml(entry[1])}" placeholder="变量值">
                    <button class="remove-environ-btn w-8 h-8 flex items-center justify-center text-gray-400 hover:text-red-500 transition-colors" data-index="${i}">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `
                )
                .join('');
            return items || '<p class="text-xs text-gray-400 italic">暂无环境变量</p>';
        };

        return `
        <section>
            <div class="flex items-center gap-2 mb-4">
                <h2 class="text-base font-semibold text-gray-800">通用设置</h2>
            </div>
            <div class="bg-white/70 backdrop-blur-xl rounded-2xl border border-white/50 shadow-lg p-5 space-y-5">
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    <!-- 语言 -->
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">语言</label>
                        <select id="locale-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="auto"${currentLocale === 'auto' ? ' selected' : ''}>跟随系统</option>
                            <option value="zh-CN"${currentLocale === 'zh-CN' ? ' selected' : ''}>中文</option>
                            <option value="en-US"${currentLocale === 'en-US' ? ' selected' : ''}>English</option>
                        </select>
                    </div>
                    <!-- 字体预设 -->
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">字体 / Font</label>
                        <select id="font-preset-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="default"${fontPreset === 'default' ? ' selected' : ''}>默认 / Default</option>
                            <option value="lxgwwenkai"${fontPreset === 'lxgwwenkai' ? ' selected' : ''}>霞鹜文楷 / LXGW WenKai</option>
                        </select>
                    </div>
                    <!-- 外观主题 -->
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">外观主题 / Theme</label>
                        <select id="theme-preference-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="system"${themePreference === 'system' ? ' selected' : ''}>跟随系统</option>
                            <option value="light"${themePreference === 'light' ? ' selected' : ''}>浅色</option>
                            <option value="dark"${themePreference === 'dark' ? ' selected' : ''}>深色</option>
                        </select>
                    </div>
                    <!-- 开发者模式 -->
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">${this._t('renderer.settings.developerMode')}</label>
                        <label class="flex items-center justify-between h-[42px] px-4 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl cursor-pointer">
                            <span class="text-gray-600">${this._t('renderer.settings.enableDeveloperEntry')}</span>
                            <input id="developer-mode-toggle" type="checkbox" ${developerMode ? 'checked' : ''} class="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-400/30">
                        </label>
                    </div>
                </div>
                <!-- 显示大小 -->
                <div>
                    <label class="block text-xs font-medium text-gray-600 mb-3">显示大小 / Display Size</label>
                    <div class="px-2">
                        <div class="relative">
                            <!-- 轨道 -->
                            <div class="h-1.5 bg-gray-200 rounded-full relative">
                                <div id="scale-track-fill" class="absolute top-0 left-0 h-full bg-blue-400 rounded-full transition-all duration-200" style="width: ${(activeStep / (scaleSteps.length - 1)) * 100}%"></div>
                            </div>
                            <!-- 档位节点 -->
                            <div class="absolute top-0 left-0 right-0 flex justify-between" style="transform: translateY(-25%)">
                                ${scaleSteps
                                    .map(
                                        (step, i) => `
                                    <button class="scale-step-btn w-4 h-4 rounded-full border-2 transition-all duration-200 ${i <= activeStep ? 'bg-blue-400 border-blue-400' : 'bg-white border-gray-300'} ${i === activeStep ? 'ring-2 ring-blue-200 scale-110' : ''} hover:scale-125" data-step="${i}" data-value="${step}" title="${labels[i]} (${step}x)"></button>
                                `
                                    )
                                    .join('')}
                            </div>
                        </div>
                        <!-- 标签 -->
                        <div class="flex justify-between mt-3">
                            ${scaleSteps
                                .map(
                                    (step, i) => `
                                <span class="scale-step-label text-[11px] cursor-pointer transition-colors duration-200 ${i === activeStep ? 'text-blue-500 font-medium' : 'text-gray-400'}" data-step="${i}" data-value="${step}">${labels[i]}</span>
                            `
                                )
                                .join('')}
                        </div>
                    </div>
                    <p class="text-xs text-gray-400 mt-2 flex items-center gap-1">
                        <i class="fas fa-keyboard text-gray-300"></i>
                        Ctrl + <kbd class="px-1 py-0.5 bg-gray-100 rounded text-gray-500 text-[10px]">+</kbd> / <kbd class="px-1 py-0.5 bg-gray-100 rounded text-gray-500 text-[10px]">-</kbd>
                    </p>
                </div>
            </div>
        </section>

        ${this.renderGatewaySection()}

        <!-- 环境变量 -->
        <section>
            <div class="flex items-center gap-2 mb-4">
                <h2 class="text-base font-semibold text-gray-800">环境变量</h2>
                <span class="text-xs text-gray-400 ml-2">所有 Shell 命令执行时共享</span>
            </div>
            <div class="bg-white/70 backdrop-blur-xl rounded-2xl border border-white/50 shadow-lg p-5">
                <div id="environ-list" class="space-y-1">
                    ${renderEnvironList()}
                </div>
                <button id="add-environ-btn" class="mt-2 w-full py-2 text-sm text-gray-500 bg-gray-50/50 border border-dashed border-gray-200 rounded-lg hover:bg-gray-100/50 transition-colors">
                    <i class="fas fa-plus mr-2"></i>添加环境变量
                </button>
                <p class="text-xs text-gray-400 mt-2">配置后，所有终端命令（Bash / Zsh / PowerShell）执行时都会携带这些环境变量</p>
            </div>
        </section>
        `;
    }

    renderProvidersSection() {
        const providers = this.currentData?.providers || [];
        return `
        <section>
            <div class="flex items-center gap-2 mb-4">
                <h2 class="text-base font-semibold text-gray-800">模型提供方</h2>
                <span class="text-xs text-gray-400 ml-2">${providers.length} 个已配置</span>
            </div>
            <div id="provider-list" class="grid grid-cols-1 md:grid-cols-2 gap-3">
                ${providers.map((p, i) => this.renderProviderCard(p, i)).join('')}
            </div>
            <button id="add-provider-btn" class="sp-add-btn sp-add-provider mt-4 w-full py-3 text-sm text-gray-500 rounded-2xl border-2 border-dashed border-gray-200">
                <i class="fas fa-plus mr-2"></i>添加提供方
            </button>
        </section>
        `;
    }

    renderProviderCard(provider, index) {
        const maskedKey = this.maskApiKey(provider.api_key);
        const providerType = provider.provider_type || 'openai';
        const providerTypeLabel = providerType === 'anthropic' ? 'Anthropic' : 'OpenAI';
        return `
        <div class="sp-card sp-card-provider bg-white/70 backdrop-blur-xl rounded-2xl border border-white/50 shadow-lg p-4" data-provider-index="${index}">
            <div class="flex items-start justify-between">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <h3 class="font-semibold text-gray-800 truncate">${this.escapeHtml(provider.name)}</h3>
                        <span class="text-xs px-2 py-0.5 rounded-full ${providerType === 'anthropic' ? 'bg-teal-100 text-teal-600' : 'bg-blue-100 text-blue-600'}">${providerTypeLabel}</span>
                    </div>
                    <p class="text-xs text-gray-400 mt-1 truncate">${this.escapeHtml(provider.base_url)}</p>
                    <p class="text-xs text-gray-400 mt-0.5">${maskedKey}</p>
                    ${provider.no_proxy ? '<span class="inline-block mt-2 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-600">禁用代理</span>' : ''}
                </div>
                <div class="sp-card-actions flex gap-1">
                    <button class="edit-provider-btn sp-card-action-btn" data-index="${index}">
                        <i class="fas fa-pen text-xs"></i>
                    </button>
                    <button class="delete-provider-btn sp-card-action-btn sp-delete-btn" data-index="${index}">
                        <i class="fas fa-trash text-xs"></i>
                    </button>
                </div>
            </div>
        </div>
        `;
    }

    renderModelsSection() {
        const models = this.currentData?.models || [];
        return `
        <section>
            <div class="flex items-center gap-2 mb-4">
                <h2 class="text-base font-semibold text-gray-800">模型管理</h2>
                <span class="text-xs text-gray-400 ml-2">${models.length} 个已配置</span>
            </div>
            <div id="model-list" class="grid grid-cols-1 md:grid-cols-2 gap-3">
                ${models.map((m, i) => this.renderModelCard(m, i)).join('')}
            </div>
            <button id="add-model-btn" class="sp-add-btn sp-add-model mt-4 w-full py-3 text-sm text-gray-500 rounded-2xl border-2 border-dashed border-gray-200">
                <i class="fas fa-plus mr-2"></i>添加模型
            </button>
        </section>
        `;
    }

    renderModelCard(model, index) {
        const effortLabel = this.getEffortLabel(model.reasoning_effort);
        const ctxLabel =
            model.context_length && model.context_length > 0
                ? model.context_length >= 1000
                    ? `${Math.round(model.context_length / 1000)}k`
                    : String(model.context_length)
                : '';
        return `
        <div class="sp-card sp-card-model bg-white/70 backdrop-blur-xl rounded-2xl border border-white/50 shadow-lg p-4" data-model-index="${index}">
            <div class="flex items-start justify-between">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <h3 class="font-semibold text-gray-800 truncate">${this.escapeHtml(model.alias)}</h3>
                        ${effortLabel ? `<span class="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-600">${effortLabel}</span>` : ''}
                        ${ctxLabel ? `<span class="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-600">${ctxLabel} ctx</span>` : ''}
                    </div>
                    <p class="text-xs text-gray-400 mt-1 truncate">${this.escapeHtml(model.provider_name)} / ${this.escapeHtml(model.model_name)}</p>
                </div>
                <div class="sp-card-actions flex gap-1">
                    <button class="edit-model-btn sp-card-action-btn" data-index="${index}">
                        <i class="fas fa-pen text-xs"></i>
                    </button>
                    <button class="delete-model-btn sp-card-action-btn sp-delete-btn" data-index="${index}">
                        <i class="fas fa-trash text-xs"></i>
                    </button>
                </div>
            </div>
        </div>
        `;
    }

    renderDefaultModelsSection() {
        const models = this.currentData?.models || [];
        const modelOptions = models
            .map((m) => `<option value="${this.escapeHtml(m.alias)}">${this.escapeHtml(m.alias)}</option>`)
            .join('');

        return `
        <section>
            <div class="flex items-center gap-2 mb-4">
                <h2 class="text-base font-semibold text-gray-800">默认模型选择</h2>
            </div>
            <div class="bg-white/70 backdrop-blur-xl rounded-2xl border border-white/50 shadow-lg p-5 space-y-4">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">默认对话模型</label>
                        <select id="default-model-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="">未选择</option>
                            ${modelOptions}
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">默认嵌入模型</label>
                        <select id="default-embedding-model-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="">未选择</option>
                            ${modelOptions}
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">默认重排序模型</label>
                        <select id="default-reranker-model-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="">未选择</option>
                            ${modelOptions}
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">默认视觉模型</label>
                        <select id="default-vision-model-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="">未选择</option>
                            ${modelOptions}
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">默认意图解析模型</label>
                        <select id="default-intent-model-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="">未选择</option>
                            ${modelOptions}
                        </select>
                    </div>
                </div>
            </div>
        </section>
        `;
    }

    setUpEventListeners() {
        // Tab 切换
        this.querySelectorAll('.seg-item[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const newTab = btn.dataset.tab;
                if (newTab === this._activeTab) return;
                this._switchTab(newTab);
            });
        });

        // 快捷操作按钮组
        this.querySelector('#quick-setup-btn')?.addEventListener('click', () => {
            window.globalControlAPI.openWizard();
        });
        this.querySelector('#import-quickpass-btn')?.addEventListener('click', () => {
            this.showImportQuickPassModal();
        });
        this.querySelector('#export-quickpass-btn')?.addEventListener('click', () => {
            this.showExportQuickPassModal();
        });
        this.querySelector('#advanced-setting-btn')?.addEventListener('click', () => {
            window.globalControlAPI.openAdvancedSettingEditor();
        });

        this.querySelector('#task-auto-retry-toggle')?.addEventListener('change', (e) => {
            if (!this.currentData.task_config) this.currentData.task_config = {};
            this.currentData.task_config.auto_retry = e.target.checked;
            this.saveImmediately();
        });

        // 搜索设置 - API Key 保存按钮
        this.querySelectorAll('.search-set-key-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const channel = btn.dataset.channel;
                const input = this.querySelector(`.search-api-key-input[data-channel="${channel}"]`);
                const apiKey = input?.value?.trim() || '';
                this._saveSearchChannelApiKey(channel, apiKey);
            });
        });

        // 搜索设置 - 设为默认按钮
        this.querySelectorAll('.search-set-default-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const channel = btn.dataset.channel;
                const type = btn.dataset.type;
                this._setDefaultSearchChannel(channel, type);
            });
        });

        // 搜索设置 - 开关切换
        this.querySelectorAll('.search-toggle-checkbox').forEach((checkbox) => {
            checkbox.addEventListener('change', (e) => {
                const label = e.target.closest('.search-toggle-label');
                const type = label?.dataset.type;
                if (type === 'web') {
                    this._setWebSearchEnabled(e.target.checked);
                } else if (type === 'academic') {
                    this._setAcademicSearchEnabled(e.target.checked);
                }
            });
        });

        // Bing 搜索语言/区域切换
        this.querySelectorAll('.bing-lang-select').forEach((select) => {
            select.addEventListener('change', (e) => {
                this._setBingLang(e.target.value);
            });
        });

        // 设置默认模型选择框的初始值
        this.updateDefaultModelSelects();

        // 默认模型选择框变化时立即保存
        const selects = [
            'default-model-select',
            'default-embedding-model-select',
            'default-reranker-model-select',
            'default-vision-model-select',
            'default-intent-model-select'
        ];
        selects.forEach((id) => {
            this.querySelector(`#${id}`)?.addEventListener('change', (e) => {
                const field = id.replace('-select', '').replace(/-/g, '_');
                this.currentData[field] = e.target.value;
                this.saveImmediately();
            });
        });

        // 语言选择
        this.querySelector('#locale-select')?.addEventListener('change', (e) => {
            this.currentData.locale = e.target.value;
            this._t = createRendererTranslator(this.currentData.locale);
            this.saveImmediately();
            this.refreshGeneralSection();
        });

        // 字体预设
        this.querySelector('#font-preset-select')?.addEventListener('change', (e) => {
            const preset = e.target.value;
            if (!this.currentData.gui_config) this.currentData.gui_config = {};
            this.currentData.gui_config.font_preset = preset;
            document.documentElement.setAttribute('data-font-preset', preset);
            window.broadcastFontSettings?.(preset);
            this.saveImmediately();
        });

        // 外观主题
        this.querySelector('#theme-preference-select')?.addEventListener('change', async (e) => {
            const pref = e.target.value;
            if (!this.currentData.gui_config) this.currentData.gui_config = {};
            this.currentData.gui_config.theme_preference = pref;
            if (window.themeAPI?.setPreference) {
                try {
                    const result = await window.themeAPI.setPreference(pref);
                    if (result.status === 'ok' && result.data) {
                        const { applyResolvedTheme } = await import('../theme/theme-renderer.ts');
                        applyResolvedTheme(result.data);
                        window.broadcastThemeSettings?.(result.data);
                    }
                } catch (err) {
                    console.warn('[setting] theme setPreference failed', err);
                }
            }
            this.saveImmediately();
        });

        this.querySelector('#developer-mode-toggle')?.addEventListener('change', (e) => {
            this.currentData.developer_mode = e.target.checked;
            this.saveImmediately();
        });

        // 显示大小（分档点击）
        const bindScaleStepEvents = () => {
            this.querySelectorAll('.scale-step-btn, .scale-step-label').forEach((el) => {
                el.addEventListener('click', async () => {
                    const value = parseFloat(el.dataset.value);
                    if (!this.currentData.gui_config) this.currentData.gui_config = {};
                    this.currentData.gui_config.scale_factor = value;
                    if (window.displayAPI?.setScaleFactor) {
                        await window.displayAPI.setScaleFactor(value);
                    }
                    this.refreshGeneralSection();
                    this.saveImmediately();
                });
            });
        };
        bindScaleStepEvents();

        // 添加提供方按钮
        this.querySelector('#add-provider-btn')?.addEventListener('click', () => {
            this.showProviderTemplateModal();
        });

        // 编辑/删除提供方
        this.querySelectorAll('.edit-provider-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.dataset.index);
                this.showProviderEditModal(index);
            });
        });
        this.querySelectorAll('.delete-provider-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.dataset.index);
                this.deleteProvider(index);
            });
        });

        // 添加模型按钮
        this.querySelector('#add-model-btn')?.addEventListener('click', () => {
            this.showModelEditModal(-1);
        });

        // 编辑/删除模型
        this.querySelectorAll('.edit-model-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.dataset.index);
                this.showModelEditModal(index);
            });
        });
        this.querySelectorAll('.delete-model-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.dataset.index);
                this.deleteModel(index);
            });
        });

        // 模态框关闭
        this.querySelector('#modal-overlay')?.addEventListener('click', () => {
            this.closeModal();
        });

        // 环境变量管理
        this._bindGatewayEvents();
        this._bindEnvironEvents();
    }

    _saveSearchChannelApiKey(channel, apiKey) {
        if (!this.currentData.applications) this.currentData.applications = {};
        if (!this.currentData.applications.search) this.currentData.applications.search = {};
        const searchConfig = this.currentData.applications.search;
        if (!searchConfig.channels) searchConfig.channels = {};
        if (!searchConfig.channels[channel]) searchConfig.channels[channel] = {};
        searchConfig.channels[channel].api_key = apiKey;
        this.saveImmediately();
        // 刷新搜索 tab
        this.refreshSearchSection();
    }

    _setDefaultSearchChannel(channel, type) {
        if (!this.currentData.applications) this.currentData.applications = {};
        if (!this.currentData.applications.search) this.currentData.applications.search = {};
        const searchConfig = this.currentData.applications.search;
        if (type === 'web') {
            searchConfig.defaultWebSearch = channel;
        } else if (type === 'academic') {
            searchConfig.defaultAcademicSearch = channel;
        }
        this.saveImmediately();
        this.refreshSearchSection();
    }

    _setWebSearchEnabled(enabled) {
        if (!this.currentData.applications) this.currentData.applications = {};
        if (!this.currentData.applications.search) this.currentData.applications.search = {};
        this.currentData.applications.search.webSearchEnabled = enabled;
        this.saveImmediately();
        this.refreshSearchSection();
    }

    _setAcademicSearchEnabled(enabled) {
        if (!this.currentData.applications) this.currentData.applications = {};
        if (!this.currentData.applications.search) this.currentData.applications.search = {};
        this.currentData.applications.search.academicSearchEnabled = enabled;
        this.saveImmediately();
        this.refreshSearchSection();
    }

    _setBingLang(lang) {
        if (!this.currentData.applications) this.currentData.applications = {};
        if (!this.currentData.applications.search) this.currentData.applications.search = {};
        const searchConfig = this.currentData.applications.search;
        if (!searchConfig.channels) searchConfig.channels = {};
        if (!searchConfig.channels.bing) searchConfig.channels.bing = {};
        searchConfig.channels.bing.lang = lang;
        this.saveImmediately();
    }

    refreshSearchSection() {
        const tabSearch = this.querySelector('#tab-search');
        if (tabSearch) {
            tabSearch.innerHTML = this.renderSearchSection();
            // 重新绑定搜索设置事件
            this.querySelectorAll('.search-set-key-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const channel = btn.dataset.channel;
                    const input = this.querySelector(`.search-api-key-input[data-channel="${channel}"]`);
                    const apiKey = input?.value?.trim() || '';
                    this._saveSearchChannelApiKey(channel, apiKey);
                });
            });
            this.querySelectorAll('.search-set-default-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const channel = btn.dataset.channel;
                    const type = btn.dataset.type;
                    this._setDefaultSearchChannel(channel, type);
                });
            });
            this.querySelectorAll('.search-toggle-checkbox').forEach((checkbox) => {
                checkbox.addEventListener('change', (e) => {
                    const label = e.target.closest('.search-toggle-label');
                    const type = label?.dataset.type;
                    if (type === 'web') {
                        this._setWebSearchEnabled(e.target.checked);
                    } else if (type === 'academic') {
                        this._setAcademicSearchEnabled(e.target.checked);
                    }
                });
            });
            this.querySelectorAll('.bing-lang-select').forEach((select) => {
                select.addEventListener('change', (e) => {
                    this._setBingLang(e.target.value);
                });
            });
        }
    }

    updateDefaultModelSelects() {
        const mapping = {
            'default-model-select': 'default_model',
            'default-embedding-model-select': 'default_embedding_model',
            'default-reranker-model-select': 'default_reranker_model',
            'default-vision-model-select': 'default_vision_model',
            'default-intent-model-select': 'default_intent_parsing_model'
        };
        for (const [selectId, field] of Object.entries(mapping)) {
            const select = this.querySelector(`#${selectId}`);
            if (select && this.currentData) {
                select.value = this.currentData[field] || '';
            }
        }
    }

    // --- 自动保存机制 ---
    scheduleSave() {
        if (this._saveTimeout) clearTimeout(this._saveTimeout);
        this._saveTimeout = setTimeout(() => {
            this.saveCurrentData();
        }, this._saveDelay);
    }

    saveImmediately() {
        if (this._saveTimeout) clearTimeout(this._saveTimeout);
        this.saveCurrentData();
    }

    async saveCurrentData() {
        if (this._saving) {
            this._pendingSave = true;
            return;
        }
        this._saving = true;
        try {
            await window.settingAPI.saveSettingObject(this.currentData);
            this.showSaveIndicator();
        } catch (error) {
            window.notificationAPI.sendNotification('error', '设置', '自动保存失败', error.message);
        } finally {
            this._saving = false;
            if (this._pendingSave) {
                this._pendingSave = false;
                this.scheduleSave();
            }
        }
    }

    showSaveIndicator() {
        const indicator = this.querySelector('#save-indicator');
        if (indicator) {
            indicator.classList.remove('opacity-0');
            indicator.classList.add('opacity-100');
            setTimeout(() => {
                indicator.classList.remove('opacity-100');
                indicator.classList.add('opacity-0');
            }, 2000);
        }
    }

    // --- 提供方管理 ---
    showProviderTemplateModal() {
        const templates = this.providerTemplates;
        const templateCards = templates
            .map(
                (t, i) => `
            <button class="provider-template-btn sp-template-btn flex flex-col items-center justify-center p-4 rounded-xl border border-gray-200" data-index="${i}">
                <span class="font-medium text-gray-800">${this.escapeHtml(t.displayName)}</span>
                <span class="text-xs text-gray-400 mt-1 truncate max-w-full">${this.escapeHtml(t.base_url)}</span>
                ${t.provider_type === 'anthropic' ? '<span class="text-[11px] text-teal-500 mt-1">Anthropic</span>' : ''}
            </button>
        `
            )
            .join('');

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full max-w-2xl mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">选择提供方模板</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5">
                    <div class="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-[400px] overflow-y-auto">
                        ${templateCards}
                        <button class="provider-custom-btn sp-template-custom-btn flex flex-col items-center justify-center p-4 rounded-xl border border-dashed border-gray-300">
                            <i class="fas fa-plus text-gray-400 mb-1"></i>
                            <span class="text-sm text-gray-500">自定义</span>
                        </button>
                    </div>
                </div>
            </div>
        `);

        // 绑定模板选择事件
        this.querySelectorAll('.provider-template-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.dataset.index);
                const template = templates[index];
                this.closeModal();
                this.showProviderEditModal(-1, template);
            });
        });
        this.querySelector('.provider-custom-btn')?.addEventListener('click', () => {
            this.closeModal();
            this.showProviderEditModal(-1, null);
        });
        this.querySelectorAll('.modal-close-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.closeModal();
            });
        });
    }

    showProviderEditModal(index, template = null) {
        const isEdit = index >= 0;
        const provider = isEdit
            ? this.currentData.providers[index]
            : template || { name: '', provider_type: 'openai', base_url: '', api_key: '', no_proxy: false };
        const providerType = provider.provider_type === 'anthropic' ? 'anthropic' : 'openai';
        this._editingProviderIndex = index;

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full min-w-[480px] max-w-xl mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">${isEdit ? '编辑提供方' : '添加提供方'}</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">名称</label>
                        <input id="provider-name-input" type="text" value="${this.escapeHtml(provider.name)}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="例如: openai">
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">协议类型</label>
                        <select id="provider-type-input" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="openai" ${providerType === 'openai' ? 'selected' : ''}>OpenAI</option>
                            <option value="anthropic" ${providerType === 'anthropic' ? 'selected' : ''}>Anthropic</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">API 地址</label>
                        <input id="provider-url-input" type="text" value="${this.escapeHtml(provider.base_url)}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="https://api.example.com/v1">
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">API 密钥</label>
                        <div class="relative">
                            <input id="provider-key-input" type="password" value="${this.escapeHtml(provider.api_key)}" class="w-full px-4 py-2.5 pr-10 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="sk-...">
                            <button id="toggle-key-visibility" class="sp-toggle-key absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                                <i class="fas fa-eye text-xs"></i>
                            </button>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        <input id="provider-no-proxy-input" type="checkbox" ${provider.no_proxy ? 'checked' : ''} class="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-400/30">
                        <label for="provider-no-proxy-input" class="text-sm text-gray-600">禁用代理</label>
                    </div>
                </div>
                <div class="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
                    <button class="modal-close-btn sp-modal-cancel px-4 py-2 text-sm text-gray-600 rounded-xl">取消</button>
                    <button id="save-provider-btn" class="sp-modal-save px-4 py-2 text-sm text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-xl">${isEdit ? '保存' : '添加'}</button>
                </div>
            </div>
        `);

        // 绑定事件
        this.querySelectorAll('.modal-close-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.closeModal();
            });
        });
        this.querySelector('#toggle-key-visibility')?.addEventListener('click', () => {
            const input = this.querySelector('#provider-key-input');
            const icon = this.querySelector('#toggle-key-visibility i');
            if (input.type === 'password') {
                input.type = 'text';
                icon.classList.remove('fa-eye');
                icon.classList.add('fa-eye-slash');
            } else {
                input.type = 'password';
                icon.classList.remove('fa-eye-slash');
                icon.classList.add('fa-eye');
            }
        });
        this.querySelector('#save-provider-btn')?.addEventListener('click', () => {
            this.saveProvider();
        });
    }

    saveProvider() {
        const name = this.querySelector('#provider-name-input')?.value?.trim();
        const provider_type =
            this.querySelector('#provider-type-input')?.value === 'anthropic' ? 'anthropic' : 'openai';
        const base_url = this.querySelector('#provider-url-input')?.value?.trim();
        const api_key = this.querySelector('#provider-key-input')?.value || '';
        const no_proxy = this.querySelector('#provider-no-proxy-input')?.checked || false;

        if (!name) {
            window.notificationAPI.sendNotification('error', '设置', '请输入提供方名称');
            return;
        }

        const provider = { name, provider_type, base_url, api_key, no_proxy };

        if (this._editingProviderIndex >= 0) {
            this.currentData.providers[this._editingProviderIndex] = provider;
        } else {
            if (!this.currentData.providers) this.currentData.providers = [];
            this.currentData.providers.push(provider);
        }

        this.closeModal();
        this.refreshProvidersSection();
        this.scheduleSave();
    }

    deleteProvider(index) {
        const provider = this.currentData.providers[index];
        const modelsUsingProvider = this.currentData.models?.filter((m) => m.provider_name === provider.name) || [];

        const modelCount = modelsUsingProvider.length;
        const message =
            modelCount > 0
                ? `提供方「${provider.name}」下有 ${modelCount} 个关联模型，删除提供方将同时删除这些模型。`
                : `确定要删除提供方「${provider.name}」吗？`;

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full max-w-md mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">删除提供方</h3>
                    <button class="modal-close-btn sp-modal-close text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5">
                    <div class="flex items-start gap-3">
                        <div class="shrink-0 w-10 h-10 rounded-full ${modelCount > 0 ? 'bg-amber-50 text-amber-500' : 'bg-red-50 text-red-500'} flex items-center justify-center">
                            <i class="fas ${modelCount > 0 ? 'fa-exclamation-triangle' : 'fa-trash-alt'}"></i>
                        </div>
                        <div class="text-sm text-gray-600 leading-relaxed">${message}</div>
                    </div>
                    ${
                        modelCount > 0
                            ? `
                    <div class="mt-3 ml-[52px] text-xs text-gray-400 bg-gray-50 rounded-lg p-2.5 space-y-0.5">
                        ${modelsUsingProvider.map((m) => `<div class="truncate">· ${m.alias || m.model_name}</div>`).join('')}
                    </div>`
                            : ''
                    }
                </div>
                <div class="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
                    <button class="modal-close-btn sp-modal-cancel px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-xl">取消</button>
                    <button id="confirm-delete-provider-btn" class="sp-confirm-delete px-4 py-2 text-sm text-white bg-red-500 rounded-xl">确认删除</button>
                </div>
            </div>
        `);

        this.querySelectorAll('.modal-close-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.closeModal();
            });
        });
        this.querySelector('#confirm-delete-provider-btn')?.addEventListener('click', () => {
            if (modelCount > 0) {
                this.currentData.models = this.currentData.models.filter((m) => m.provider_name !== provider.name);
                this.refreshModelsSection();
                this.refreshDefaultModelsSection();
            }
            this.currentData.providers.splice(index, 1);
            this.closeModal();
            this.refreshProvidersSection();
            this.scheduleSave();
        });
    }

    refreshProvidersSection() {
        const tabModels = this.querySelector('#tab-models');
        if (!tabModels) return;
        const sections = tabModels.querySelectorAll('section');
        if (sections.length >= 1) {
            sections[0].outerHTML = this.renderProvidersSection();
            // 重新绑定事件
            this.querySelector('#add-provider-btn')?.addEventListener('click', () => {
                this.showProviderTemplateModal();
            });
            this.querySelectorAll('.edit-provider-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.currentTarget.dataset.index);
                    this.showProviderEditModal(index);
                });
            });
            this.querySelectorAll('.delete-provider-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.currentTarget.dataset.index);
                    this.deleteProvider(index);
                });
            });
        }
    }

    // --- 模型管理 ---
    showModelEditModal(index) {
        const isEdit = index >= 0;
        const model = isEdit
            ? this.currentData.models[index]
            : {
                  alias: '',
                  provider_name: '',
                  model_name: '',
                  reasoning_effort: '',
                  context_length: undefined,
                  custom_headers: undefined
              };
        this._editingModelIndex = index;

        const providers = this.currentData?.providers || [];
        const providerOptions = providers
            .map(
                (p) =>
                    `<option value="${this.escapeHtml(p.name)}" ${p.name === model.provider_name ? 'selected' : ''}>${this.escapeHtml(p.name)}</option>`
            )
            .join('');

        // 将 custom_headers 转换为 JSON 字符串用于编辑
        // 将 custom_headers 转换为键值对数组
        const headersArray = model.custom_headers
            ? Object.entries(model.custom_headers).map(([k, v]) => ({ key: k, value: v }))
            : [];
        this._customHeaders = headersArray;

        // 生成 headers 列表的 HTML
        const renderHeadersList = () => {
            const items = this._customHeaders
                .map(
                    (h, i) => `
                <div class="header-item flex items-center gap-2 mb-2" data-index="${i}">
                    <input type="text" class="header-key flex-1 px-3 py-2 text-sm bg-white/60 border border-gray-200/60 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/30" value="${this.escapeHtml(h.key)}" placeholder="Header 名称">
                    <input type="text" class="header-value flex-1 px-3 py-2 text-sm bg-white/60 border border-gray-200/60 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/30" value="${this.escapeHtml(h.value)}" placeholder="Header 值">
                    <button class="remove-header-btn w-8 h-8 flex items-center justify-center text-gray-400 hover:text-red-500 transition-colors" data-index="${i}">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `
                )
                .join('');
            return items || '<p class="text-xs text-gray-400 italic">暂无自定义 Headers</p>';
        };

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full min-w-[480px] max-w-xl mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">${isEdit ? '编辑模型' : '添加模型'}</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4 max-h-[60vh] overflow-y-auto">
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">别名</label>
                        <input id="model-alias-input" type="text" value="${this.escapeHtml(model.alias)}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="例如: gpt-4o">
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">提供方</label>
                        <select id="model-provider-input" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="">选择提供方</option>
                            ${providerOptions}
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">模型名称</label>
                        <div class="relative" id="model-name-combo">
                            <input id="model-name-input" type="text" value="${this.escapeHtml(model.model_name)}" autocomplete="off" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="例如: gpt-4o">
                            <div id="model-name-dropdown" class="hidden absolute z-10 left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto"></div>
                        </div>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">推理模式</label>
                        <select id="model-effort-input" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="" ${!model.reasoning_effort ? 'selected' : ''}>默认</option>
                            <option value="none" ${model.reasoning_effort === 'none' ? 'selected' : ''}>none</option>
                            <option value="low" ${model.reasoning_effort === 'low' ? 'selected' : ''}>low</option>
                            <option value="medium" ${model.reasoning_effort === 'medium' ? 'selected' : ''}>medium</option>
                            <option value="high" ${model.reasoning_effort === 'high' ? 'selected' : ''}>high</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">上下文长度</label>
                        <input id="model-context-length-input" type="number" min="0" step="1" value="${model.context_length || ''}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="留空则自动估算">
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-600 mb-1.5">自定义 Headers</label>
                        <div id="headers-list" class="space-y-1">
                            ${renderHeadersList()}
                        </div>
                        <button id="add-header-btn" class="mt-2 w-full py-2 text-sm text-gray-500 bg-gray-50/50 border border-dashed border-gray-200 rounded-lg hover:bg-gray-100/50 transition-colors">
                            <i class="fas fa-plus mr-2"></i>添加 Header
                        </button>
                        <p class="text-xs text-gray-400 mt-2">在向模型服务器发送请求时携带的自定义 HTTP 头</p>
                    </div>
                </div>
                <div id="model-verify-result" class="mx-6 mb-1 text-sm hidden max-h-48 overflow-y-auto"></div>
                <div class="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
                    <button class="modal-close-btn sp-modal-cancel px-4 py-2 text-sm text-gray-600 rounded-xl">取消</button>
                    <button id="save-model-without-verify-btn" class="sp-modal-save px-4 py-2 text-sm text-white bg-gradient-to-r from-gray-400 to-gray-500 rounded-xl hidden">仅保存</button>
                    <button id="save-model-btn" class="sp-modal-save px-4 py-2 text-sm text-white bg-gradient-to-r from-purple-500 to-purple-600 rounded-xl">${isEdit ? '验证并保存' : '验证并添加'}</button>
                </div>
            </div>
        `);

        // Headers 列表操作
        const syncHeadersFromDom = () => {
            this.querySelectorAll('.header-item').forEach((item) => {
                const idx = parseInt(item.dataset.index);
                if (!isNaN(idx) && idx >= 0 && idx < this._customHeaders.length) {
                    this._customHeaders[idx].key = item.querySelector('.header-key')?.value || '';
                    this._customHeaders[idx].value = item.querySelector('.header-value')?.value || '';
                }
            });
        };

        const refreshHeadersList = () => {
            syncHeadersFromDom();
            const container = this.querySelector('#headers-list');
            if (container) {
                container.innerHTML = renderHeadersList();
                bindHeaderItemEvents();
            }
        };

        const bindHeaderItemEvents = () => {
            this.querySelectorAll('.remove-header-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    const idx = parseInt(e.currentTarget.dataset.index);
                    this._customHeaders.splice(idx, 1);
                    refreshHeadersList();
                });
            });
        };

        this.querySelector('#add-header-btn')?.addEventListener('click', () => {
            this._customHeaders.push({ key: '', value: '' });
            refreshHeadersList();
        });

        bindHeaderItemEvents();

        this.querySelectorAll('.modal-close-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.closeModal();
            });
        });
        this.querySelector('#save-model-btn')?.addEventListener('click', () => {
            this.verifyAndSaveModel();
        });
        this.querySelector('#save-model-without-verify-btn')?.addEventListener('click', () => {
            this.saveModel();
        });

        // 模型名称 combo 下拉逻辑
        this._modelNameList = [];
        const nameInput = this.querySelector('#model-name-input');
        const dropdown = this.querySelector('#model-name-dropdown');
        const providerSelect = this.querySelector('#model-provider-input');

        const renderDropdownItems = (filter) => {
            const keyword = (filter || '').toLowerCase();
            const filtered = keyword
                ? this._modelNameList.filter((n) => n.toLowerCase().includes(keyword))
                : this._modelNameList;
            if (filtered.length === 0) {
                dropdown.classList.add('hidden');
                return;
            }
            dropdown.innerHTML = filtered
                .map(
                    (n) =>
                        `<div class="model-name-option px-4 py-2 text-sm cursor-pointer hover:bg-blue-50 transition-colors truncate" data-value="${this.escapeHtml(n)}">${this.escapeHtml(n)}</div>`
                )
                .join('');
            dropdown.classList.remove('hidden');
            dropdown.querySelectorAll('.model-name-option').forEach((opt) => {
                opt.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    nameInput.value = opt.dataset.value;
                    dropdown.classList.add('hidden');
                });
            });
        };

        const fetchModelsForProvider = async (providerName) => {
            this._modelNameList = [];
            dropdown.classList.add('hidden');
            if (!providerName) return;
            const provider = this.currentData?.providers?.find((p) => p.name === providerName);
            if (!provider || !provider.base_url) return;
            try {
                const models = await window.settingAPI.fetchProviderModels({
                    base_url: provider.base_url,
                    api_key: provider.api_key || '',
                    provider_type: provider.provider_type === 'anthropic' ? 'anthropic' : 'openai'
                });
                if (Array.isArray(models) && models.length > 0) {
                    this._modelNameList = models;
                }
            } catch {
                // 获取失败时静默处理，用户仍可手动输入
            }
        };

        nameInput.addEventListener('focus', () => {
            if (this._modelNameList.length > 0) {
                renderDropdownItems(nameInput.value);
            }
        });
        nameInput.addEventListener('input', () => {
            if (this._modelNameList.length > 0) {
                renderDropdownItems(nameInput.value);
            }
        });
        nameInput.addEventListener('blur', () => {
            // 延迟隐藏以允许 mousedown 事件触发
            setTimeout(() => dropdown.classList.add('hidden'), 150);
        });

        providerSelect.addEventListener('change', () => {
            fetchModelsForProvider(providerSelect.value);
        });

        // 初始加载：如果已有选中的提供方，尝试获取模型列表
        if (providerSelect.value) {
            fetchModelsForProvider(providerSelect.value);
        }
    }

    async verifyAndSaveModel() {
        const alias = this.querySelector('#model-alias-input')?.value?.trim();
        const provider_name = this.querySelector('#model-provider-input')?.value || '';
        const model_name = this.querySelector('#model-name-input')?.value?.trim();
        const resultDiv = this.querySelector('#model-verify-result');
        const saveBtn = this.querySelector('#save-model-btn');

        if (!alias) {
            window.notificationAPI.sendNotification('error', '设置', '请输入模型别名');
            return;
        }
        if (!provider_name) {
            window.notificationAPI.sendNotification('error', '设置', '请选择提供方');
            return;
        }
        if (!model_name) {
            window.notificationAPI.sendNotification('error', '设置', '请输入模型名称');
            return;
        }

        // 从键值对列表收集自定义 headers
        const headersItems = this.querySelectorAll('.header-item');
        const custom_headers = {};
        for (const item of headersItems) {
            const key = item.querySelector('.header-key')?.value?.trim();
            const value = item.querySelector('.header-value')?.value?.trim();
            if (key && value) {
                custom_headers[key] = value;
            }
        }
        this._parsedCustomHeaders = Object.keys(custom_headers).length > 0 ? custom_headers : undefined;

        const provider = this.currentData?.providers?.find((p) => p.name === provider_name);
        if (!provider) {
            window.notificationAPI.sendNotification('error', '设置', '未找到对应的提供方配置');
            return;
        }

        const origText = saveBtn.innerHTML;
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>验证中...';
        if (resultDiv) {
            resultDiv.classList.remove('hidden');
            resultDiv.className =
                'mx-6 text-sm p-3 text-blue-600 bg-blue-50 rounded-xl border border-blue-200 max-h-48 overflow-y-auto';
            resultDiv.innerHTML = '<i class="fas fa-info-circle mr-2"></i>正在验证模型配置...';
        }

        try {
            await window.settingAPI.verifyModel({
                base_url: provider.base_url,
                api_key: provider.api_key,
                provider_type: provider.provider_type === 'anthropic' ? 'anthropic' : 'openai',
                model_name: model_name,
                custom_headers: this._parsedCustomHeaders
            });
            if (resultDiv) {
                resultDiv.className =
                    'mx-6 text-sm p-3 text-green-600 bg-green-50 rounded-xl border border-green-200 max-h-48 overflow-y-auto';
                resultDiv.innerHTML = '<i class="fas fa-check-circle mr-2"></i>验证成功，正在保存...';
            }
            this.saveModel();
        } catch (error) {
            if (resultDiv) {
                resultDiv.className =
                    'mx-6 text-sm p-3 text-red-600 bg-red-50 rounded-xl border border-red-200 max-h-48 overflow-y-auto';
                resultDiv.innerHTML = `<i class="fas fa-times-circle mr-2"></i>验证失败：${this.escapeHtml(error.message)}`;
            }
            // 显示"仅保存"按钮
            const saveWithoutVerifyBtn = this.querySelector('#save-model-without-verify-btn');
            if (saveWithoutVerifyBtn) {
                saveWithoutVerifyBtn.classList.remove('hidden');
            }
        } finally {
            saveBtn.disabled = false;
            saveBtn.innerHTML = origText;
        }
    }

    saveModel() {
        const alias = this.querySelector('#model-alias-input')?.value?.trim();
        const provider_name = this.querySelector('#model-provider-input')?.value || '';
        const model_name = this.querySelector('#model-name-input')?.value?.trim();
        const reasoning_effort = this.querySelector('#model-effort-input')?.value || '';
        const contextLengthRaw = this.querySelector('#model-context-length-input')?.value?.trim();
        const contextLengthNum = contextLengthRaw ? parseInt(contextLengthRaw, 10) : undefined;

        if (!alias) {
            window.notificationAPI.sendNotification('error', '设置', '请输入模型别名');
            return;
        }

        if (contextLengthRaw && (!Number.isFinite(contextLengthNum) || contextLengthNum < 0)) {
            window.notificationAPI.sendNotification('error', '设置', '上下文长度必须为非负整数');
            return;
        }

        // 检查别名是否重复
        const existingIndex = this.currentData.models?.findIndex((m) => m.alias === alias);
        if (existingIndex !== undefined && existingIndex !== -1 && existingIndex !== this._editingModelIndex) {
            window.notificationAPI.sendNotification('error', '设置', '模型别名已存在');
            return;
        }

        // 从 DOM 收集自定义 headers
        const custom_headers = {};
        const headersItems = this.querySelectorAll('.header-item');
        for (const item of headersItems) {
            const key = item.querySelector('.header-key')?.value?.trim();
            const value = item.querySelector('.header-value')?.value?.trim();
            if (key && value) {
                custom_headers[key] = value;
            }
        }

        const model = { alias, provider_name, model_name, reasoning_effort };
        if (contextLengthNum && contextLengthNum > 0) {
            model.context_length = contextLengthNum;
        }
        if (Object.keys(custom_headers).length > 0) {
            model.custom_headers = custom_headers;
        }

        if (this._editingModelIndex >= 0) {
            this.currentData.models[this._editingModelIndex] = model;
        } else {
            if (!this.currentData.models) this.currentData.models = [];
            this.currentData.models.push(model);
        }

        this.closeModal();
        this.refreshModelsSection();
        this.refreshDefaultModelsSection();
        this.scheduleSave();
    }

    deleteModel(index) {
        const model = this.currentData.models[index];

        // 检查是否是默认模型
        const isDefault = [
            'default_model',
            'default_embedding_model',
            'default_reranker_model',
            'default_vision_model',
            'default_intent_parsing_model'
        ].some((field) => this.currentData[field] === model.alias);

        if (isDefault) {
            window.notificationAPI.sendNotification(
                'warning',
                '设置',
                '无法删除',
                '此模型被设置为默认模型，请先更换默认模型'
            );
            return;
        }

        this.currentData.models.splice(index, 1);
        this.refreshModelsSection();
        this.refreshDefaultModelsSection();
        this.scheduleSave();
    }

    refreshModelsSection() {
        const tabModels = this.querySelector('#tab-models');
        if (!tabModels) return;
        const sections = tabModels.querySelectorAll('section');
        if (sections.length >= 2) {
            sections[1].outerHTML = this.renderModelsSection();
            this.querySelector('#add-model-btn')?.addEventListener('click', () => {
                this.showModelEditModal(-1);
            });
            this.querySelectorAll('.edit-model-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.currentTarget.dataset.index);
                    this.showModelEditModal(index);
                });
            });
            this.querySelectorAll('.delete-model-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.currentTarget.dataset.index);
                    this.deleteModel(index);
                });
            });
        }
    }

    refreshGeneralSection() {
        const tabGeneral = this.querySelector('#tab-general');
        if (!tabGeneral) return;
        const sections = tabGeneral.querySelectorAll('section');
        if (sections.length >= 1) {
            sections.forEach((s) => s.remove());
            tabGeneral.innerHTML = this.renderGeneralSection();
            // 重新绑定事件
            this.querySelector('#locale-select')?.addEventListener('change', (e) => {
                this.currentData.locale = e.target.value;
                this._t = createRendererTranslator(this.currentData.locale);
                this.saveImmediately();
                this.refreshGeneralSection();
            });
            this.querySelector('#font-preset-select')?.addEventListener('change', (e) => {
                const preset = e.target.value;
                if (!this.currentData.gui_config) this.currentData.gui_config = {};
                this.currentData.gui_config.font_preset = preset;
                document.documentElement.setAttribute('data-font-preset', preset);
                window.broadcastFontSettings?.(preset);
                this.saveImmediately();
            });
            this.querySelector('#theme-preference-select')?.addEventListener('change', async (e) => {
                const pref = e.target.value;
                if (!this.currentData.gui_config) this.currentData.gui_config = {};
                this.currentData.gui_config.theme_preference = pref;
                if (window.themeAPI?.setPreference) {
                    try {
                        const result = await window.themeAPI.setPreference(pref);
                        if (result.status === 'ok' && result.data) {
                            const { applyResolvedTheme } = await import('../theme/theme-renderer.ts');
                            applyResolvedTheme(result.data);
                            window.broadcastThemeSettings?.(result.data);
                        }
                    } catch (err) {
                        console.warn('[setting] theme setPreference failed', err);
                    }
                }
                this.saveImmediately();
            });
            this.querySelector('#developer-mode-toggle')?.addEventListener('change', (e) => {
                this.currentData.developer_mode = e.target.checked;
                this.saveImmediately();
            });
            this.querySelectorAll('.scale-step-btn, .scale-step-label').forEach((el) => {
                el.addEventListener('click', async () => {
                    const value = parseFloat(el.dataset.value);
                    if (!this.currentData.gui_config) this.currentData.gui_config = {};
                    this.currentData.gui_config.scale_factor = value;
                    if (window.displayAPI?.setScaleFactor) {
                        await window.displayAPI.setScaleFactor(value);
                    }
                    this.refreshGeneralSection();
                    this.saveImmediately();
                });
            });
            this._bindGatewayEvents();
            this._bindEnvironEvents();
        }
    }

    refreshDefaultModelsSection() {
        const tabModels = this.querySelector('#tab-models');
        if (!tabModels) return;
        const sections = tabModels.querySelectorAll('section');
        if (sections.length >= 3) {
            sections[2].outerHTML = this.renderDefaultModelsSection();
            this.updateDefaultModelSelects();
            const selects = [
                'default-model-select',
                'default-embedding-model-select',
                'default-reranker-model-select',
                'default-vision-model-select',
                'default-intent-model-select'
            ];
            selects.forEach((id) => {
                this.querySelector(`#${id}`)?.addEventListener('change', (e) => {
                    const field = id.replace('-select', '').replace(/-/g, '_');
                    this.currentData[field] = e.target.value;
                    this.saveImmediately();
                });
            });
        }
    }

    // --- QuickPass 模态框 ---
    showExportQuickPassModal() {
        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full min-w-[480px] max-w-lg mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">导出口令</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <div class="flex gap-3">
                        <button id="export-base-btn" class="sp-export-option-btn sp-export-base flex-1 py-3 text-sm text-gray-700 bg-white border border-gray-200 rounded-xl">
                            <i class="fas fa-cog mr-2 text-blue-500"></i>基础设置口令
                        </button>
                        <button id="export-all-btn" class="sp-export-option-btn sp-export-all flex-1 py-3 text-sm text-gray-700 bg-white border border-gray-200 rounded-xl">
                            <i class="fas fa-box mr-2 text-purple-500"></i>全部设置口令
                        </button>
                    </div>
                    <textarea id="export-result" readonly class="w-full h-32 px-4 py-3 text-xs font-mono bg-gray-50 border border-gray-200 rounded-xl resize-none focus:outline-none" placeholder="点击上方按钮生成口令..."></textarea>
                    <button id="copy-quickpass-btn" class="sp-modal-save w-full py-2.5 text-sm text-white bg-gradient-to-r from-gray-700 to-gray-600 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed" disabled>
                        <i class="fas fa-copy mr-2"></i>复制到剪贴板
                    </button>
                </div>
            </div>
        `);

        this.querySelectorAll('.modal-close-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.closeModal();
            });
        });
        this.querySelector('#export-base-btn')?.addEventListener('click', async () => {
            try {
                const quickpass = await window.quickpassAPI.exportBaseConfig();
                this.querySelector('#export-result').value = quickpass;
                this.querySelector('#copy-quickpass-btn').disabled = false;
            } catch (error) {
                window.notificationAPI.sendNotification('error', '设置', '导出失败', error.message);
            }
        });
        this.querySelector('#export-all-btn')?.addEventListener('click', async () => {
            try {
                const quickpass = await window.quickpassAPI.exportAllConfig();
                this.querySelector('#export-result').value = quickpass;
                this.querySelector('#copy-quickpass-btn').disabled = false;
            } catch (error) {
                window.notificationAPI.sendNotification('error', '设置', '导出失败', error.message);
            }
        });
        this.querySelector('#copy-quickpass-btn')?.addEventListener('click', async () => {
            const text = this.querySelector('#export-result')?.value;
            if (text) {
                await navigator.clipboard.writeText(text);
                window.notificationAPI.sendNotification('info', '设置', '导出成功', '口令已复制到剪贴板');
            }
        });
    }

    showImportQuickPassModal() {
        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full min-w-[480px] max-w-lg mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-base font-semibold text-gray-800">导入口令</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <textarea id="import-input" class="w-full h-32 px-4 py-3 text-xs font-mono bg-white/60 border border-gray-200/60 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="粘贴口令..."></textarea>
                    <div id="import-result" class="text-sm"></div>
                    <button id="import-quickpass-confirm-btn" class="sp-modal-save w-full py-2.5 text-sm text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-xl">
                        <i class="fas fa-check mr-2"></i>导入
                    </button>
                </div>
            </div>
        `);

        this.querySelectorAll('.modal-close-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.closeModal();
            });
        });
        this.querySelector('#import-quickpass-confirm-btn')?.addEventListener('click', async () => {
            const quickpass = this.querySelector('#import-input')?.value?.trim();
            if (!quickpass) {
                window.notificationAPI.sendNotification('error', '设置', '请输入口令');
                return;
            }

            const resultDiv = this.querySelector('#import-result');
            resultDiv.innerHTML =
                '<span class="text-gray-500"><i class="fas fa-spinner fa-spin mr-2"></i>正在导入...</span>';

            try {
                const result = await window.quickpassAPI.importQuickPass(quickpass);
                const hasApps = result.hasApplications;
                resultDiv.innerHTML = `<span class="text-green-500"><i class="fas fa-check-circle mr-2"></i>导入成功：${this.escapeHtml(result.name)}${hasApps ? '（含应用配置）' : '（基础设置）'}</span>`;

                // 刷新数据
                await this.loadData();
                this._hasRendered = false;
                this.render();
                this.setUpEventListeners();
            } catch (error) {
                resultDiv.innerHTML = `<span class="text-red-500"><i class="fas fa-times-circle mr-2"></i>导入失败：${this.escapeHtml(error.message)}</span>`;
            }
        });
    }

    // --- 设备网关设置 ---
    _saveGatewayConfig(config) {
        if (!this.currentData.applications) this.currentData.applications = {};
        const existing = this.currentData.applications.devicemgr || {};
        this.currentData.applications.devicemgr = {
            ...existing,
            enabled: config.enabled,
            host: config.host,
            port: config.port,
            autoApproveLocal: config.autoApproveLocal
        };
        this.saveImmediately();
    }

    _bindGatewayEvents() {
        this.querySelector('#gateway-host-select')?.addEventListener('change', (e) => {
            const host = this._normalizeGatewayHost(e.target.value);
            const current = this._getGatewayConfig();
            this._saveGatewayConfig({
                ...current,
                enabled: host !== 'none',
                host
            });
            this.refreshGeneralSection();
        });

        this.querySelector('#gateway-port-input')?.addEventListener('change', (e) => {
            const port = parseInt(e.target.value, 10);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                window.notificationAPI.sendNotification('error', '设置', '网关端口必须是 1-65535 之间的整数');
                e.target.value = String(this._getGatewayConfig().port);
                return;
            }
            const current = this._getGatewayConfig();
            this._saveGatewayConfig({
                ...current,
                port
            });
            this.refreshGeneralSection();
        });

        this.querySelector('#gateway-auto-approve-input')?.addEventListener('change', (e) => {
            const current = this._getGatewayConfig();
            this._saveGatewayConfig({
                ...current,
                autoApproveLocal: e.target.checked
            });
        });
    }

    // --- 环境变量管理 ---
    _bindEnvironEvents() {
        const syncEnvironFromDom = () => {
            this.querySelectorAll('.environ-item').forEach((item) => {
                const idx = parseInt(item.dataset.index);
                if (!isNaN(idx) && idx >= 0 && idx < this._environEntries.length) {
                    this._environEntries[idx].key = item.querySelector('.environ-key')?.value || '';
                    this._environEntries[idx].value = item.querySelector('.environ-value')?.value || '';
                }
            });
        };

        const refreshEnvironList = () => {
            syncEnvironFromDom();
            // 保存到 currentData
            const environ = {};
            for (const entry of this._environEntries) {
                if (entry.key && entry.value) {
                    environ[entry.key] = entry.value;
                }
            }
            this.currentData.environ = Object.keys(environ).length > 0 ? environ : {};
            this.saveImmediately();

            const container = this.querySelector('#environ-list');
            if (container) {
                const items = this._environEntries
                    .map(
                        (entry, i) => `
                    <div class="environ-item flex items-center gap-2 mb-2" data-index="${i}">
                        <input type="text" class="environ-key flex-1 px-3 py-2 text-sm bg-white/60 border border-gray-200/60 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/30" value="${this.escapeHtml(entry.key)}" placeholder="变量名">
                        <span class="text-gray-400 text-xs">=</span>
                        <input type="text" class="environ-value flex-1 px-3 py-2 text-sm bg-white/60 border border-gray-200/60 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/30" value="${this.escapeHtml(entry.value)}" placeholder="变量值">
                        <button class="remove-environ-btn w-8 h-8 flex items-center justify-center text-gray-400 hover:text-red-500 transition-colors" data-index="${i}">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                `
                    )
                    .join('');
                container.innerHTML = items || '<p class="text-xs text-gray-400 italic">暂无环境变量</p>';
                bindEnvironItemEvents();
            }
        };

        const bindEnvironItemEvents = () => {
            this.querySelectorAll('.remove-environ-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    const idx = parseInt(e.currentTarget.dataset.index);
                    this._environEntries.splice(idx, 1);
                    refreshEnvironList();
                });
            });
            // 监听输入变化，自动保存
            this.querySelectorAll('.environ-key, .environ-value').forEach((input) => {
                input.addEventListener('change', () => {
                    refreshEnvironList();
                });
            });
        };

        // 初始填充 _environEntries
        const environ = this.currentData?.environ || {};
        this._environEntries = Object.entries(environ).map(([k, v]) => ({ key: k, value: v }));

        this.querySelector('#add-environ-btn')?.addEventListener('click', () => {
            this._environEntries.push({ key: '', value: '' });
            refreshEnvironList();
        });

        bindEnvironItemEvents();
    }

    // --- 模态框工具方法 ---
    showModal(content) {
        const overlay = this.querySelector('#modal-overlay');
        const container = this.querySelector('#modal-container');
        const contentEl = this.querySelector('#modal-content');

        if (overlay && container && contentEl) {
            contentEl.innerHTML = content;
            overlay.classList.remove('hidden');
            container.classList.remove('hidden');
        }

        // ESC 关闭模态框（capture 阶段，优先于 guiShortcutManager）
        if (this._modalEscHandler) {
            document.removeEventListener('keydown', this._modalEscHandler, true);
        }
        this._modalEscHandler = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this.closeModal();
            }
        };
        document.addEventListener('keydown', this._modalEscHandler, true);
    }

    closeModal() {
        const overlay = this.querySelector('#modal-overlay');
        const container = this.querySelector('#modal-container');

        if (overlay && container) {
            overlay.classList.add('hidden');
            container.classList.add('hidden');
        }

        if (this._modalEscHandler) {
            document.removeEventListener('keydown', this._modalEscHandler, true);
            this._modalEscHandler = null;
        }
    }

    // --- 工具方法 ---
    maskApiKey(key) {
        if (!key) return '未设置';
        if (key.length <= 8) return '****';
        return key.substring(0, 4) + '****' + key.substring(key.length - 4);
    }

    getEffortLabel(effort) {
        const labels = { none: '无推理', low: '低', medium: '中', high: '高' };
        return labels[effort] || '';
    }

    escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

customElements.define('setting-panel', SettingPanel);
