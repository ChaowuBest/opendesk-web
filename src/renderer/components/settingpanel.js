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
        this.appVersion = null;
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
        try {
            this.appVersion = await window.settingAPI.getVersion();
        } catch (e) {
            console.warn('Failed to load version:', e);
        }
    }

    render() {
        this.innerHTML = `
        <div class="w-full h-full overflow-hidden flex flex-col bg-gradient-to-br from-slate-50 via-white to-blue-50/30">
            <!-- 固定在右上角的工具栏（窗口控制按钮下方） -->
            <div id="setting-panel-toolbar" class="sp-fixed-toolbar"></div>

            <!-- 顶部标题栏 -->
            <div class="sticky top-0 z-10 px-6 py-4 flex items-center bg-white/60 backdrop-blur-2xl border-b border-gray-100/50">
                <h1 class="text-2xl font-bold bg-gradient-to-r from-gray-800 to-gray-600 bg-clip-text text-transparent">设置</h1>
                <span id="save-indicator" class="ml-4 text-xs text-green-500 opacity-0 transition-opacity duration-300 flex items-center gap-1">
                    <i class="fas fa-check-circle"></i> 已保存
                </span>
            </div>

            <!-- 可滚动内容区 -->
            <div class="flex-1 overflow-y-auto px-6 py-6 space-y-8">
                ${this.renderActionButtonGroup()}
                ${this.renderProvidersSection()}
                ${this.renderModelsSection()}
                ${this.renderDefaultModelsSection()}
                ${this.renderGeneralSection()}
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
    }

    _createSettingPanelToolbar() {
        const container = this.querySelector('#setting-panel-toolbar');
        if (!container) return;
        // toolbar is now empty (buttons moved to inline button group)
    }

    renderActionButtonGroup() {
        return `
        <section>
            <div class="flex items-center gap-2 mb-4">
                <div class="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center">
                    <i class="fas fa-toolbox text-indigo-500 text-sm"></i>
                </div>
                <h2 class="text-lg font-semibold text-gray-800">快捷操作</h2>
            </div>
            <div class="flex flex-wrap gap-3">
                <button id="quick-setup-btn" class="sp-toolbar-btn">
                    <i class="fa-solid fa-magic"></i><span>快速设置</span>
                </button>
                <button id="import-quickpass-btn" class="sp-toolbar-btn">
                    <i class="fa-solid fa-key"></i><span>导入口令</span>
                </button>
                <button id="export-quickpass-btn" class="sp-toolbar-btn">
                    <i class="fa-solid fa-file-export"></i><span>导出口令</span>
                </button>
                <button id="advanced-setting-btn" class="sp-toolbar-btn sp-toolbar-primary">
                    <i class="fa-solid fa-cog"></i><span>高级设置</span>
                </button>
            </div>
        </section>
        `;
    }

    renderGeneralSection() {
        const currentLocale = this.currentData?.locale || 'auto';
        const fontPreset = this.currentData?.gui_config?.font_preset || 'default';
        const scaleFactor = this.currentData?.gui_config?.scale_factor ?? 1;
        const scaleSteps = [0.75, 0.9, 1, 1.25, 1.5];
        const scaleLabels = {
            'zh-CN': ['极小', '小', '标准', '大', '极大'],
            'en-US': ['Tiny', 'Small', 'Standard', 'Large', 'Extra Large'],
            auto: ['极小', '小', '标准', '大', '极大']
        };
        const labels = scaleLabels[currentLocale] || scaleLabels['auto'];
        const currentStepIndex = scaleSteps.indexOf(scaleFactor);
        const activeStep = currentStepIndex >= 0 ? currentStepIndex : 2;

        return `
        <section>
            <div class="flex items-center gap-2 mb-4">
                <div class="w-8 h-8 rounded-lg bg-slate-500/10 flex items-center justify-center">
                    <i class="fas fa-sliders text-slate-500 text-sm"></i>
                </div>
                <h2 class="text-lg font-semibold text-gray-800">通用设置</h2>
            </div>
            <div class="bg-white/70 backdrop-blur-xl rounded-2xl border border-white/50 shadow-lg p-5 space-y-5">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <!-- 语言 -->
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">语言</label>
                        <select id="locale-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="auto"${currentLocale === 'auto' ? ' selected' : ''}>跟随系统</option>
                            <option value="zh-CN"${currentLocale === 'zh-CN' ? ' selected' : ''}>中文</option>
                            <option value="en-US"${currentLocale === 'en-US' ? ' selected' : ''}>English</option>
                        </select>
                    </div>
                    <!-- 字体预设 -->
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">字体 / Font</label>
                        <select id="font-preset-select" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="default"${fontPreset === 'default' ? ' selected' : ''}>默认 / Default</option>
                            <option value="lxgwwenkai"${fontPreset === 'lxgwwenkai' ? ' selected' : ''}>霞鹜文楷 / LXGW WenKai</option>
                        </select>
                    </div>
                </div>
                <!-- 显示大小 -->
                <div>
                    <label class="block text-sm font-medium text-gray-600 mb-3">显示大小 / Display Size</label>
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
                <h2 class="text-lg font-semibold text-gray-800">模型提供方</h2>
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
        return `
        <div class="sp-card sp-card-provider bg-white/70 backdrop-blur-xl rounded-2xl border border-white/50 shadow-lg p-4" data-provider-index="${index}">
            <div class="flex items-start justify-between">
                <div class="flex-1 min-w-0">
                    <h3 class="font-semibold text-gray-800 truncate">${this.escapeHtml(provider.name)}</h3>
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
                <div class="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
                    <i class="fas fa-brain text-purple-500 text-sm"></i>
                </div>
                <h2 class="text-lg font-semibold text-gray-800">模型管理</h2>
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
            </button>
        `
            )
            .join('');

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full max-w-2xl mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-lg font-semibold text-gray-800">选择提供方模板</h3>
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
            : template || { name: '', base_url: '', api_key: '', no_proxy: false };
        this._editingProviderIndex = index;

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full min-w-[480px] max-w-xl mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-lg font-semibold text-gray-800">${isEdit ? '编辑提供方' : '添加提供方'}</h3>
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
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
        const base_url = this.querySelector('#provider-url-input')?.value?.trim();
        const api_key = this.querySelector('#provider-key-input')?.value || '';
        const no_proxy = this.querySelector('#provider-no-proxy-input')?.checked || false;

        if (!name) {
            window.notificationAPI.sendNotification('error', '设置', '请输入提供方名称');
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

        const modelCount = modelsUsingProvider.length;
        const message =
            modelCount > 0
                ? `提供方「${provider.name}」下有 ${modelCount} 个关联模型，删除提供方将同时删除这些模型。`
                : `确定要删除提供方「${provider.name}」吗？`;

        this.showModal(`
            <div class="bg-white/95 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/50 w-full max-w-md mx-4 overflow-hidden">
                <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                    <h3 class="text-lg font-semibold text-gray-800">删除提供方</h3>
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
        const sections = this.querySelectorAll('section');
        const section = sections.length >= 2 ? sections[1] : null;
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
            : { alias: '', provider_name: '', model_name: '', reasoning_effort: '', context_length: undefined };
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
                    <button class="modal-close-btn sp-modal-close w-8 h-8 rounded-lg text-gray-400">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="px-6 py-5 space-y-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">别名</label>
                        <input id="model-alias-input" type="text" value="${this.escapeHtml(model.alias)}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="例如: gpt-4o">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">提供方</label>
                        <select id="model-provider-input" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all">
                            <option value="">选择提供方</option>
                            ${providerOptions}
                        </select>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">模型名称</label>
                        <div class="relative" id="model-name-combo">
                            <input id="model-name-input" type="text" value="${this.escapeHtml(model.model_name)}" autocomplete="off" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="例如: gpt-4o">
                            <div id="model-name-dropdown" class="hidden absolute z-10 left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto"></div>
                        </div>
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
                    <div>
                        <label class="block text-sm font-medium text-gray-600 mb-1.5">上下文长度</label>
                        <input id="model-context-length-input" type="number" min="0" step="1" value="${model.context_length || ''}" class="w-full px-4 py-2.5 text-sm bg-white/60 backdrop-blur-sm border border-gray-200/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all" placeholder="留空则自动估算">
                    </div>
                </div>
                <div id="model-verify-result" class="mx-6 mb-1 text-sm hidden"></div>
                <div class="px-6 py-4 border-t border-gray-100 flex justify-end gap-3">
                    <button class="modal-close-btn sp-modal-cancel px-4 py-2 text-sm text-gray-600 rounded-xl">取消</button>
                    <button id="save-model-btn" class="sp-modal-save px-4 py-2 text-sm text-white bg-gradient-to-r from-purple-500 to-purple-600 rounded-xl">${isEdit ? '验证并保存' : '验证并添加'}</button>
                </div>
            </div>
        `);

        this.querySelectorAll('.modal-close-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.closeModal();
            });
        });
        this.querySelector('#save-model-btn')?.addEventListener('click', () => {
            this.verifyAndSaveModel();
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
                    api_key: provider.api_key || ''
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
            resultDiv.className = 'mx-6 text-sm p-3 text-blue-600 bg-blue-50 rounded-xl border border-blue-200';
            resultDiv.innerHTML = '<i class="fas fa-info-circle mr-2"></i>正在验证模型配置...';
        }

        try {
            await window.settingAPI.verifyModel({
                base_url: provider.base_url,
                api_key: provider.api_key,
                model_name: model_name
            });
            if (resultDiv) {
                resultDiv.className = 'mx-6 text-sm p-3 text-green-600 bg-green-50 rounded-xl border border-green-200';
                resultDiv.innerHTML = '<i class="fas fa-check-circle mr-2"></i>验证成功，正在保存...';
            }
            this.saveModel();
        } catch (error) {
            if (resultDiv) {
                resultDiv.className = 'mx-6 text-sm p-3 text-red-600 bg-red-50 rounded-xl border border-red-200';
                resultDiv.innerHTML = `<i class="fas fa-times-circle mr-2"></i>验证失败：${this.escapeHtml(error.message)}`;
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

        const model = { alias, provider_name, model_name, reasoning_effort };
        if (contextLengthNum && contextLengthNum > 0) {
            model.context_length = contextLengthNum;
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
        const sections = this.querySelectorAll('section');
        if (sections.length >= 3) {
            sections[2].outerHTML = this.renderModelsSection();
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
        const sections = this.querySelectorAll('section');
        // General section is the 5th section (index 4)
        if (sections.length >= 5) {
            sections[4].outerHTML = this.renderGeneralSection();
            // 重新绑定事件
            this.querySelector('#locale-select')?.addEventListener('change', (e) => {
                this.currentData.locale = e.target.value;
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
        }
    }

    refreshDefaultModelsSection() {
        const sections = this.querySelectorAll('section');
        if (sections.length >= 4) {
            sections[3].outerHTML = this.renderDefaultModelsSection();
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
                    <h3 class="text-lg font-semibold text-gray-800">导入口令</h3>
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
