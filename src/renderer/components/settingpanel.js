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
        this.providerTemplates = await window.settingAPI.getProviderTemplates();
    }

    render() {
        this.innerHTML = `
        <div class="w-full h-full overflow-hidden flex flex-col bg-gradient-to-br from-slate-50 via-white to-blue-50/30">
            <!-- 顶部标题栏 -->
            <div class="sticky top-0 z-10 px-6 py-4 pr-[140px] flex items-center justify-between bg-white/60 backdrop-blur-2xl border-b border-gray-100/50">
                <h1 class="text-2xl font-bold bg-gradient-to-r from-gray-800 to-gray-600 bg-clip-text text-transparent">设置</h1>
                <div class="flex items-center gap-3">
                    <span id="save-indicator" class="text-xs text-green-500 opacity-0 transition-opacity duration-300 flex items-center gap-1">
                        <i class="fas fa-check-circle"></i> 已保存
                    </span>
                    <button id="import-quickpass-btn" class="px-4 py-2 text-xs rounded-full bg-white text-gray-600 border border-gray-200 shadow-sm hover:bg-gray-50 hover:shadow-md transition-all duration-200">
                        <i class="fas fa-key mr-1"></i> 导入口令
                    </button>
                    <button id="export-quickpass-btn" class="px-4 py-2 text-xs rounded-full bg-white text-gray-600 border border-gray-200 shadow-sm hover:bg-gray-50 hover:shadow-md transition-all duration-200">
                        <i class="fas fa-file-export mr-1"></i> 导出口令
                    </button>
                    <button id="advanced-setting-btn" class="px-4 py-2 text-xs rounded-full bg-gradient-to-r from-gray-700 to-gray-600 text-white shadow-sm hover:shadow-md transition-all duration-200">
                        <i class="fas fa-cog mr-1"></i> 高级设置
                    </button>
                </div>
            </div>

            <!-- 可滚动内容区 -->
            <div class="flex-1 overflow-y-auto px-6 py-6 space-y-8">
                ${this.renderProvidersSection()}
                ${this.renderModelsSection()}
                ${this.renderDefaultModelsSection()}
            </div>
        </div>

        <!-- 模态框容器 -->
        <div id="modal-overlay" class="hidden fixed inset-0 z-50 bg-black/30 backdrop-blur-sm"></div>
        <div id="modal-container" class="hidden fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div id="modal-content" class="pointer-events-auto"></div>
        </div>
        `;
    }

    renderProvidersSection() {
        const providers = this.currentData?.providers || [];
        return `
        <section>
            <div class="flex items-center gap-2 mb-4">
                <div class="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <i class="fas fa-server text-blue-500 text-sm"></i>
                </div>
                <h2 class="text-lg font-semibold text-gray-800">模型提供商</h2>
                <span class="text-xs text-gray-400 ml-2">${providers.length} 个已配置</span>
            </div>
            <div id="provider-list" class="grid grid-cols-1 md:grid-cols-2 gap-3">
                ${providers.map((p, i) => this.renderProviderCard(p, i)).join('')}
            </div>
            <button id="add-provider-btn" class="mt-4 w-full py-3 text-sm text-gray-500 rounded-2xl border-2 border-dashed border-gray-200 hover:border-blue-300 hover:text-blue-500 hover:bg-blue-50/50 transition-all duration-200">
                <i class="fas fa-plus mr-2"></i>添加提供商
            </button>
        </section>
        `;
    }

    renderProviderCard(provider, index) {
        const maskedKey = this.maskApiKey(provider.api_key);
        return `
        <div class="group bg-white/70 backdrop-blur-xl rounded-2xl border border-white/50 shadow-lg hover:shadow-xl hover:border-blue-200/50 transition-all duration-300 p-4" data-provider-index="${index}">
            <div class="flex items-start justify-between">
                <div class="flex-1 min-w-0">
                    <h3 class="font-semibold text-gray-800 truncate">${this.escapeHtml(provider.name)}</h3>
                    <p class="text-xs text-gray-400 mt-1 truncate">${this.escapeHtml(provider.base_url)}</p>
                    <p class="text-xs text-gray-400 mt-0.5">${maskedKey}</p>
                    ${provider.no_proxy ? '<span class="inline-block mt-2 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-600">禁用代理</span>' : ''}
                </div>
                <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button class="edit-provider-btn w-8 h-8 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors" data-index="${index}">
                        <i class="fas fa-pen text-xs"></i>
                    </button>
                    <button class="delete-provider-btn w-8 h-8 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors" data-index="${index}">
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
                <div class="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
                    <i class="fas fa-brain text-purple-500 text-sm"></i>
                </div>
                <h2 class="text-lg font-semibold text-gray-800">模型管理</h2>
                <span class="text-xs text-gray-400 ml-2">${models.length} 个已配置</span>
            </div>
            <div id="model-list" class="grid grid-cols-1 md:grid-cols-2 gap-3">
                ${models.map((m, i) => this.renderModelCard(m, i)).join('')}
            </div>
            <button id="add-model-btn" class="mt-4 w-full py-3 text-sm text-gray-500 rounded-2xl border-2 border-dashed border-gray-200 hover:border-purple-300 hover:text-purple-500 hover:bg-purple-50/50 transition-all duration-200">
                <i class="fas fa-plus mr-2"></i>添加模型
            </button>
        </section>
        `;
    }

    renderModelCard(model, index) {
        const effortLabel = this.getEffortLabel(model.reasoning_effort);
        return `
        <div class="group bg-white/70 backdrop-blur-xl rounded-2xl border border-white/50 shadow-lg hover:shadow-xl hover:border-purple-200/50 transition-all duration-300 p-4" data-model-index="${index}">
            <div class="flex items-start justify-between">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <h3 class="font-semibold text-gray-800 truncate">${this.escapeHtml(model.alias)}</h3>
                        ${effortLabel ? `<span class="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-600">${effortLabel}</span>` : ''}
                    </div>
                    <p class="text-xs text-gray-400 mt-1 truncate">${this.escapeHtml(model.provider_name)} / ${this.escapeHtml(model.model_name)}</p>
                </div>
                <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button class="edit-model-btn w-8 h-8 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors" data-index="${index}">
                        <i class="fas fa-pen text-xs"></i>
                    </button>
                    <button class="delete-model-btn w-8 h-8 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors" data-index="${index}">
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
                <div class="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                    <i class="fas fa-star text-amber-500 text-sm"></i>
                </div>
                <h2 class="text-lg font-semibold text-gray-800">默认模型选择</h2>
            </div>
            <div class="bg-white/70 backdrop-blur-xl rounded-2xl border border-white/50 shadow-lg p-5 space-y-4">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">默认对话模型</label>
                        <select id="default-model-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="">未选择</option>
                            ${modelOptions}
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">默认嵌入模型</label>
                        <select id="default-embedding-model-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="">未选择</option>
                            ${modelOptions}
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">默认重排序模型</label>
                        <select id="default-reranker-model-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="">未选择</option>
                            ${modelOptions}
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">默认视觉模型</label>
                        <select id="default-vision-model-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="">未选择</option>
                            ${modelOptions}
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">默认意图解析模型</label>
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

        // 添加提供商按钮
        this.querySelector('#add-provider-btn')?.addEventListener('click', () => {
            this.showProviderTemplateModal();
        });

        // 编辑/删除提供商
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

        // 导入口令
        this.querySelector('#import-quickpass-btn')?.addEventListener('click', () => {
            this.showImportQuickPassModal();
        });

        // 导出口令
        this.querySelector('#export-quickpass-btn')?.addEventListener('click', () => {
            this.showExportQuickPassModal();
        });

        // 高级设置
        this.querySelector('#advanced-setting-btn')?.addEventListener('click', () => {
            window.globalControlAPI.openAdvancedSettingEditor();
        });

        // 模态框关闭
        this.querySelector('#modal-overlay')?.addEventListener('click', () => {
            this.closeModal();
        });
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

    // --- 提供商管理 ---
    showProviderTemplateModal() {
        const templates = this.providerTemplates;
        const templateCards = templates
            .map(
                (t, i) => `
            <button class="provider-template-btn flex flex-col items-center justify-center p-4 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50/50 transition-all" data-index="${i}">
                <span class="font-medium text-gray-800">${this.escapeHtml(t.displayName)}</span>
                <span class="text-xs text-gray-400 mt-1 truncate max-w-full">${this.escapeHtml(t.base_url)}</span>
            </button>
        `
            )
            .join('');

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full max-w-2xl mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-lg font-semibold text-gray-800">选择提供商模板</h3>
                    <button class="modal-close-btn w-8 h-8 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5">
                    <div class="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-[400px] overflow-y-auto">
                        ${templateCards}
                        <button class="provider-custom-btn flex flex-col items-center justify-center p-4 rounded-xl border border-dashed border-gray-300 hover:border-blue-400 hover:bg-blue-50/50 transition-all">
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
            : template || { name: '', base_url: '', api_key: '', no_proxy: false };
        this._editingProviderIndex = index;

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full min-w-[480px] max-w-xl mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-lg font-semibold text-gray-800">${isEdit ? '编辑提供商' : '添加提供商'}</h3>
                    <button class="modal-close-btn w-8 h-8 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">名称</label>
                        <input id="provider-name-input" type="text" value="${this.escapeHtml(provider.name)}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="例如: openai">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">API 地址</label>
                        <input id="provider-url-input" type="text" value="${this.escapeHtml(provider.base_url)}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="https://api.example.com/v1">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">API 密钥</label>
                        <div class="relative">
                            <input id="provider-key-input" type="password" value="${this.escapeHtml(provider.api_key)}" class="w-full px-4 py-2.5 pr-10 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="sk-...">
                            <button id="toggle-key-visibility" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
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
                    <button class="modal-close-btn px-4 py-2 text-sm text-gray-600 rounded-xl hover:bg-gray-100 transition-colors">取消</button>
                    <button id="save-provider-btn" class="px-4 py-2 text-sm text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-xl hover:shadow-lg transition-all">${isEdit ? '保存' : '添加'}</button>
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
        const base_url = this.querySelector('#provider-url-input')?.value?.trim();
        const api_key = this.querySelector('#provider-key-input')?.value || '';
        const no_proxy = this.querySelector('#provider-no-proxy-input')?.checked || false;

        if (!name) {
            window.notificationAPI.sendNotification('error', '设置', '请输入提供商名称');
            return;
        }

        const provider = { name, base_url, api_key, no_proxy };

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

        if (modelsUsingProvider.length > 0) {
            window.notificationAPI.sendNotification(
                'warning',
                '设置',
                '无法删除',
                `有 ${modelsUsingProvider.length} 个模型正在使用此提供商`
            );
            return;
        }

        this.currentData.providers.splice(index, 1);
        this.refreshProvidersSection();
        this.scheduleSave();
    }

    refreshProvidersSection() {
        const section = this.querySelector('section:first-of-type');
        if (section) {
            section.outerHTML = this.renderProvidersSection();
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
            : { alias: '', provider_name: '', model_name: '', reasoning_effort: '' };
        this._editingModelIndex = index;

        const providers = this.currentData?.providers || [];
        const providerOptions = providers
            .map(
                (p) =>
                    `<option value="${this.escapeHtml(p.name)}" ${p.name === model.provider_name ? 'selected' : ''}>${this.escapeHtml(p.name)}</option>`
            )
            .join('');

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full min-w-[480px] max-w-xl mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-lg font-semibold text-gray-800">${isEdit ? '编辑模型' : '添加模型'}</h3>
                    <button class="modal-close-btn w-8 h-8 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">别名</label>
                        <input id="model-alias-input" type="text" value="${this.escapeHtml(model.alias)}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="例如: gpt-4o">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">提供商</label>
                        <select id="model-provider-input" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="">选择提供商</option>
                            ${providerOptions}
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">模型名称</label>
                        <input id="model-name-input" type="text" value="${this.escapeHtml(model.model_name)}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="例如: gpt-4o">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">推理模式</label>
                        <select id="model-effort-input" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="" ${!model.reasoning_effort ? 'selected' : ''}>默认</option>
                            <option value="none" ${model.reasoning_effort === 'none' ? 'selected' : ''}>none</option>
                            <option value="low" ${model.reasoning_effort === 'low' ? 'selected' : ''}>low</option>
                            <option value="medium" ${model.reasoning_effort === 'medium' ? 'selected' : ''}>medium</option>
                            <option value="high" ${model.reasoning_effort === 'high' ? 'selected' : ''}>high</option>
                        </select>
                    </div>
                </div>
                <div class="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
                    <button class="modal-close-btn px-4 py-2 text-sm text-gray-600 rounded-xl hover:bg-gray-100 transition-colors">取消</button>
                    <button id="save-model-btn" class="px-4 py-2 text-sm text-white bg-gradient-to-r from-purple-500 to-purple-600 rounded-xl hover:shadow-lg transition-all">${isEdit ? '保存' : '添加'}</button>
                </div>
            </div>
        `);

        this.querySelectorAll('.modal-close-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.closeModal();
            });
        });
        this.querySelector('#save-model-btn')?.addEventListener('click', () => {
            this.saveModel();
        });
    }

    saveModel() {
        const alias = this.querySelector('#model-alias-input')?.value?.trim();
        const provider_name = this.querySelector('#model-provider-input')?.value || '';
        const model_name = this.querySelector('#model-name-input')?.value?.trim();
        const reasoning_effort = this.querySelector('#model-effort-input')?.value || '';

        if (!alias) {
            window.notificationAPI.sendNotification('error', '设置', '请输入模型别名');
            return;
        }

        // 检查别名是否重复
        const existingIndex = this.currentData.models?.findIndex((m) => m.alias === alias);
        if (existingIndex !== undefined && existingIndex !== -1 && existingIndex !== this._editingModelIndex) {
            window.notificationAPI.sendNotification('error', '设置', '模型别名已存在');
            return;
        }

        const model = { alias, provider_name, model_name, reasoning_effort };

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
        const sections = this.querySelectorAll('section');
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

    refreshDefaultModelsSection() {
        const sections = this.querySelectorAll('section');
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
                    <h3 class="text-lg font-semibold text-gray-800">导出口令</h3>
                    <button class="modal-close-btn w-8 h-8 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <div class="flex gap-3">
                        <button id="export-base-btn" class="flex-1 py-3 text-sm text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 hover:border-blue-300 transition-all">
                            <i class="fas fa-cog mr-2 text-blue-500"></i>基础设置口令
                        </button>
                        <button id="export-all-btn" class="flex-1 py-3 text-sm text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 hover:border-purple-300 transition-all">
                            <i class="fas fa-box mr-2 text-purple-500"></i>全部设置口令
                        </button>
                    </div>
                    <textarea id="export-result" readonly class="w-full h-32 px-4 py-3 text-xs font-mono bg-gray-50 border border-gray-200 rounded-xl resize-none focus:outline-none" placeholder="点击上方按钮生成口令..."></textarea>
                    <button id="copy-quickpass-btn" class="w-full py-2.5 text-sm text-white bg-gradient-to-r from-gray-700 to-gray-600 rounded-xl hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed" disabled>
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
                    <h3 class="text-lg font-semibold text-gray-800">导入口令</h3>
                    <button class="modal-close-btn w-8 h-8 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <textarea id="import-input" class="w-full h-32 px-4 py-3 text-xs font-mono bg-white/60 border border-gray-200/60 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="粘贴口令..."></textarea>
                    <div id="import-result" class="text-sm"></div>
                    <button id="import-quickpass-confirm-btn" class="w-full py-2.5 text-sm text-white bg-gradient-to-r from-blue-500 to-blue-600 rounded-xl hover:shadow-lg transition-all">
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
                this.render();
                this.setUpEventListeners();
            } catch (error) {
                resultDiv.innerHTML = `<span class="text-red-500"><i class="fas fa-times-circle mr-2"></i>导入失败：${this.escapeHtml(error.message)}</span>`;
            }
        });
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
    }

    closeModal() {
        const overlay = this.querySelector('#modal-overlay');
        const container = this.querySelector('#modal-container');

        if (overlay && container) {
            overlay.classList.add('hidden');
            container.classList.add('hidden');
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
