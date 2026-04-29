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

import { REASONING_EFFORT_UI_OPTIONS as REASONING_EFFORT_OPTIONS } from '../../common/reasoning-effort.ts';

const supportedFileExtensions = ['pdf', 'docx', 'doc', 'xls', 'xlsx', 'ppt', 'pptx'];

/**
 * 更新系统设置中的 default_model 和指定模型的 reasoning_effort。
 * 只修改需要变更的字段，其余保持不变。
 */
async function updateSettingForModelChange(modelAlias, reasoningEffort) {
    try {
        if (!window.settingAPI?.saveSettingObject || !window.settingAPI?.loadSettingObject) return;
        const settingObj = await window.settingAPI.loadSettingObject();
        let changed = false;
        if (modelAlias && settingObj.default_model !== modelAlias) {
            settingObj.default_model = modelAlias;
            changed = true;
        }
        if (modelAlias && reasoningEffort !== undefined) {
            const model = (settingObj.models || []).find((m) => m.alias === modelAlias);
            if (model && model.reasoning_effort !== reasoningEffort) {
                model.reasoning_effort = reasoningEffort;
                changed = true;
            }
        }
        if (changed) {
            await window.settingAPI.saveSettingObject(settingObj);
        }
    } catch (err) {
        console.warn('Failed to persist model/effort setting:', err);
    }
}

class AgentInput extends HTMLElement {
    constructor() {
        super();
        this.attachedFilePaths = [];
        this.isDisabled = false;
        this.showStopButton = false;
        this.onStopCallback = null;
        /** @type {{ alias: string, model_name: string }[]} */
        this.availableModels = [];
        this.selectedModel = '';
        this.selectedReasoningEffort = '';
        this.defaultModelAlias = '';
        /** @type {{ id: string, name: string, description: string, icon: string, color: string }[]} */
        this.availableModes = [];
        this.selectedModeId = '';
        this.defaultModeId = '';
        /** @type {{ id: string, name: string, description: string }[]} */
        this.availableSkills = [];
        this.skillPanelOpen = false;
        this.skillSearchQuery = '';
        this.modelPanelOpen = false;
        this.modePanelOpen = false;
        this._docClickBound = false;
        /** @type {{ value: string, label: string, description: string, icon: string, iconClass: string }[]} */
        this.autocompleteItems = [];
        this.autocompleteSelectedIndex = 0;
        this.autocompleteOpen = false;
        /** @type {'skill' | 'file' | null} */
        this.autocompleteMode = null;
        /** 当前文件补全的工作区根目录 */
        this._workspacePath = '';
        /** 防抖定时器 */
        this._fileCompleteTimer = null;
    }

    connectedCallback() {
        Promise.all([this.loadModels(), this.loadModes(), this.loadSkills()]).then(() => this.render());
    }

    async loadModels() {
        try {
            if (!window.settingAPI?.loadSettingObject) return;
            const settingObj = await window.settingAPI.loadSettingObject();
            this.availableModels = settingObj.models || [];
            this.defaultModelAlias = settingObj.default_model || '';
            if (!this.selectedModel) {
                this.selectedModel = this.defaultModelAlias;
            }
            const currentModel = this.availableModels.find((m) => m.alias === this.selectedModel);
            if (currentModel && currentModel.reasoning_effort !== undefined && !this.selectedReasoningEffort) {
                this.selectedReasoningEffort = currentModel.reasoning_effort;
            }
        } catch (err) {
            console.warn('Failed to load models for agent-input:', err);
        }
    }

    async loadModes() {
        try {
            if (!window.modeAPI?.getSupportedModes) return;
            const data = await window.modeAPI.getSupportedModes();
            this.availableModes = data.modes || [];
            this.defaultModeId = data.defaultModeId || '';
            if (!this.selectedModeId) {
                this.selectedModeId = data.currentModeId || this.defaultModeId;
            }
        } catch (err) {
            console.warn('Failed to load modes for agent-input:', err);
        }
    }

    /**
     * 外部设置当前模式（同时通知主进程）
     */
    setMode(modeId) {
        this.selectedModeId = modeId;
        this.updateModeIndicator();
        if (window.modeAPI?.setCurrentMode) {
            window.modeAPI.setCurrentMode(modeId).catch((err) => {
                console.warn('Failed to set mode:', err);
            });
        }
    }

    /**
     * 更新模式指示器（预留扩展点，目前不改变边框颜色）
     */
    updateModeIndicator() {
        // 当前不做视觉变化，保持边框颜色固定
    }

    async loadSkills() {
        try {
            if (!window.applicationRegistryAPI?.callMainWorld) return;
            const skills = await window.applicationRegistryAPI.callMainWorld('skillmgr', 'getAllUserInvocableSkills');
            this.availableSkills = (skills || []).map((s) => ({
                name: s.name,
                description: s.description || '',
                bundleName: s.bundleName || ''
            }));
        } catch (err) {
            console.warn('Failed to load skills for agent-input:', err);
            this.availableSkills = [];
        }
    }

    /**
     * 外部设置当前模型（不写入系统设置，仅更新 UI 状态）
     */
    setModel(modelAlias) {
        this.selectedModel = modelAlias;
    }

    /**
     * 外部设置当前 reasoning effort（不写入系统设置，仅更新 UI 状态）
     */
    setReasoningEffort(effort) {
        this.selectedReasoningEffort = effort || '';
    }

    disconnectedCallback() {}

    attachFilePath(filePath) {
        const extname = filePath.split('.').pop();
        if (!supportedFileExtensions.includes(extname)) {
            window.notificationAPI.sendNotification(
                'error',
                '文件管理',
                '不支持的文件类型',
                `当前还不支持在对话中使用${extname} 文件`
            );
            return;
        }
        this.attachedFilePaths.push(filePath);
        this.render();
    }

    removeFilePath(filePath) {
        this.attachedFilePaths = this.attachedFilePaths.filter((p) => p !== filePath);
        this.render();
    }

    clearAttachedFilePaths() {
        this.attachedFilePaths = [];
        this.render();
    }

    setDisabled(disabled) {
        this.isDisabled = disabled;
        this.updateInputState();
    }

    setStopMode(showStop, onStopCallback = null) {
        this.showStopButton = showStop;
        this.onStopCallback = onStopCallback;
        this.updateInputState();
    }

    updateInputState() {
        const textarea = this.querySelector('#agent-input-textarea');
        const submitBtn = this.querySelector('#agent-input-submit-btn');
        const stopBtn = this.querySelector('#agent-input-stop-btn');

        if (textarea) {
            if (this.isDisabled) {
                textarea.disabled = true;
                textarea.classList.add('opacity-50', 'cursor-not-allowed');
                textarea.placeholder = '正在生成回复，请稍候...';
            } else {
                textarea.disabled = false;
                textarea.classList.remove('opacity-50', 'cursor-not-allowed');
                textarea.placeholder = '在这里输入消息，按 Ctrl+Enter 发送';
            }
        }

        if (submitBtn) {
            if (this.showStopButton) {
                submitBtn.classList.add('hidden');
            } else {
                submitBtn.classList.remove('hidden');
            }
        }

        if (stopBtn) {
            if (this.showStopButton) {
                stopBtn.classList.remove('hidden');
            } else {
                stopBtn.classList.add('hidden');
            }
        }
    }

    render() {
        let fileItems = this.attachedFilePaths
            .map((filePath) => {
                const fileName = filePath.split('/').pop();
                return `
            <div class="px-2 py-0.5 bg-blue-50 text-blue-700 hover:text-gray-600 rounded-full border border-blue-100 transition-all text-xs cursor-pointer flex items-center">
                <i class="fas fa-paperclip mr-1 text-[10px]"></i>
                <span class="max-w-[100px] truncate whitespace-nowrap overflow-hidden" style="display:inline-block;">${fileName}</span>
                <button data-file_path="${filePath}" class="agent-input-remove-file-btn hover:text-red-500 leading-none">
                    <i class="fas fa-times ml-1 text-[10px]"></i>
                </button>
            </div>
            `;
            })
            .join('');

        if (this.attachedFilePaths.length === 0) {
            fileItems = `
            <div class="flex items-center text-xs text-gray-400 py-0.5">
                <i class="fas fa-paperclip mr-1.5"></i>
                <span>拖拽文件到此处</span>
            </div>
            `;
        }

        const modelItems = this.availableModels
            .map((m) => {
                const isActive = m.alias === this.selectedModel ? 'active' : '';
                const checkMark =
                    m.alias === this.selectedModel
                        ? '<div class="popup-panel-item-check"><i class="fas fa-check"></i></div>'
                        : '';
                return `<button class="popup-panel-item ${isActive}" data-model-alias="${m.alias}">
                    <div class="popup-panel-item-icon"><i class="fas fa-robot text-blue-500 text-xs"></i></div>
                    <div class="popup-panel-item-info">
                        <div class="popup-panel-item-name">${m.alias}</div>
                    </div>
                    ${checkMark}
                    <div class="popup-panel-item-arrow"><i class="fas fa-chevron-right text-[10px] text-gray-400"></i></div>
                </button>`;
            })
            .join('');

        const modeItems = this.availableModes
            .map((m) => {
                const isActive = m.id === this.selectedModeId ? 'active' : '';
                const checkMark =
                    m.id === this.selectedModeId
                        ? '<div class="popup-panel-item-check"><i class="fas fa-check"></i></div>'
                        : '';
                return `<button class="popup-panel-item ${isActive}" data-mode-id="${m.id}">
                    <div class="popup-panel-item-icon" style="font-size:14px;font-style:normal;">${m.icon}</div>
                    <div class="popup-panel-item-info">
                        <div class="popup-panel-item-name">${m.name}</div>
                        <div class="popup-panel-item-desc">${m.description || ''}</div>
                    </div>
                    ${checkMark}
                </button>`;
            })
            .join('');

        const currentModelLabel = this.getModelButtonLabel();
        const currentMode = this.availableModes.find((m) => m.id === this.selectedModeId);
        const currentModeLabel = currentMode ? `${currentMode.name}` : '模式';
        const currentModeIcon = currentMode ? currentMode.icon : '';

        this.innerHTML = `
        <div id="agent-input-container" class="w-full p-1 rounded-[24px] bg-white/40 border border-gray-300/60 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.07)]">
            <div class="bg-white rounded-[18px] shadow-sm border border-gray-100/40 overflow-hidden">
                <!-- 主要输入区域 -->
                <div class="px-3.5 pt-2.5 pb-1">
                    <textarea
                        id="agent-input-textarea"
                        placeholder="在这里输入消息，按 Ctrl+Enter 发送"
                        class="w-full h-14 resize-none border-none outline-none placeholder-gray-400 text-gray-700 text-[13px] leading-relaxed"
                    ></textarea>
                </div>

                <!-- 工具栏 -->
                <div class="flex items-center justify-between px-2.5 py-1.5 border-t border-gray-100">
                    <!-- 左侧：模式 + 模型选择 + 技能 + 附件 -->
                    <div class="flex items-center gap-1.5 flex-wrap" style="row-gap: 0.2rem;">
                        ${
                            this.availableModes.length > 1
                                ? `
                        <div class="relative">
                            <button id="agent-input-mode-btn" class="agent-input-toolbar-control flex items-center justify-center gap-1 text-xs rounded-full px-2 py-0.5 text-gray-600 outline-none transition-colors cursor-pointer">
                                <span style="font-size:10px;">${currentModeIcon}</span>
                                <span>${currentModeLabel}</span>
                            </button>
                            <div id="agent-input-mode-panel" class="popup-panel-hidden">
                                <div id="agent-input-mode-list" class="popup-panel-list">${modeItems}</div>
                            </div>
                        </div>
                        `
                                : ''
                        }
                        ${
                            this.availableModels.length > 0
                                ? `
                        <div class="relative">
                            <button id="agent-input-model-btn" class="agent-input-toolbar-control flex items-center justify-center gap-1 text-xs rounded-full px-2 py-0.5 text-gray-600 outline-none transition-colors cursor-pointer">
                                <i class="fas fa-robot text-[10px]"></i>
                                <span>${currentModelLabel}</span>
                            </button>
                            <div id="agent-input-model-panel" class="popup-panel-hidden">
                                <div class="popup-panel-search">
                                    <i class="fas fa-search text-gray-400 text-xs"></i>
                                    <input id="agent-input-model-search" type="text" placeholder="搜索模型" class="popup-panel-search-input" />
                                </div>
                                <div id="agent-input-model-list" class="popup-panel-list">${modelItems}</div>
                            </div>
                            <div id="agent-input-effort-submenu" class="popup-panel-hidden popup-panel-submenu">
                                <div id="agent-input-effort-submenu-list" class="popup-panel-list"></div>
                            </div>
                        </div>
                        `
                                : ''
                        }
                        <!-- 技能选择按钮 -->
                        <div class="relative">
                            <button id="agent-input-skill-btn" class="agent-input-toolbar-control flex items-center justify-center gap-1 text-xs rounded-full px-2 py-0.5 text-gray-600 outline-none transition-colors cursor-pointer">
                                <i class="fas fa-wand-magic-sparkles text-[10px]"></i>
                                <span>技能</span>
                            </button>
                            <!-- 技能选择面板 -->
                            <div id="agent-input-skill-panel" class="skill-panel-hidden">
                                <div class="skill-panel-search">
                                    <i class="fas fa-search text-gray-400 text-xs"></i>
                                    <input id="agent-input-skill-search" type="text" placeholder="搜索技能" class="skill-panel-search-input" />
                                </div>
                                <div id="agent-input-skill-list" class="skill-panel-list"></div>
                                <div class="skill-panel-footer">
                                    <button id="agent-input-skill-install-btn" class="skill-panel-install-btn">
                                        <i class="fas fa-plus text-[10px]"></i>
                                        <span>安装技能</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div
                            id="agent-input-attached-file-list"
                            class="flex flex-wrap items-center gap-1"
                            style="row-gap: 0.2rem; overflow-x: auto;"
                        >
                            ${fileItems}
                        </div>
                    </div>

                    <!-- 右侧按钮 -->
                    <div class="flex items-center gap-1.5">
                        <!-- 发送按钮 -->
                        <button id="agent-input-submit-btn" class="p-1 text-gray-400 hover:text-blue-500 rounded-full transition-colors">
                            <i class="fas fa-paper-plane text-sm"></i>
                        </button>
                        <!-- 停止按钮 -->
                        <button id="agent-input-stop-btn" class="py-1 px-3 bg-red-500 hover:bg-red-600 text-white rounded-full transition-colors text-xs hidden">
                            <i class="fas fa-stop text-[10px]"></i>
                            <span class="ml-1">停止</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
        <!-- 内联补全面板 -->
        <div id="agent-input-autocomplete" class="autocomplete-panel-hidden">
            <div id="agent-input-autocomplete-list" class="autocomplete-panel-list"></div>
        </div>
        ${this.getAttribute('hide-disclaimer') !== null ? '' : '<p class="text-center text-[11px] text-gray-400 mt-1.5 select-none">内容由 AI 生成，请核实重要信息。</p>'}
        `;

        this.setUpEventListeners();
        this.updateInputState();
        this.updateModeIndicator();
    }

    /**
     * 生成模型按钮的显示文字：模型名 (推理配额)，默认时不显示括号
     */
    getModelButtonLabel() {
        const modelName = this.selectedModel || '模型';
        if (!this.selectedReasoningEffort) return modelName;
        const effortLabel = REASONING_EFFORT_OPTIONS.find((o) => o.value === this.selectedReasoningEffort)?.label;
        if (!effortLabel || this.selectedReasoningEffort === '') return modelName;
        return `${modelName} (${effortLabel})`;
    }

    /**
     * 通用弹出面板定位逻辑：优先向上弹出，空间不足时向下弹出并限制高度
     */
    positionPanel(btn, panel, panelWidth = 220, maxHeight = 280) {
        const rect = btn.getBoundingClientRect();
        const panelHeight = Math.min(maxHeight, panel.scrollHeight);
        let left = rect.left;
        if (left + panelWidth > window.innerWidth) {
            left = window.innerWidth - panelWidth - 8;
        }
        left = Math.max(8, left);

        const spaceAbove = rect.top;
        const spaceBelow = window.innerHeight - rect.bottom;

        if (spaceAbove >= panelHeight + 8) {
            panel.style.top = rect.top - panelHeight - 8 + 'px';
            panel.style.maxHeight = maxHeight + 'px';
        } else if (spaceBelow >= panelHeight + 8) {
            panel.style.top = rect.bottom + 8 + 'px';
            panel.style.maxHeight = maxHeight + 'px';
        } else if (spaceAbove >= spaceBelow) {
            const availHeight = Math.max(120, spaceAbove - 16);
            panel.style.top = rect.top - availHeight - 8 + 'px';
            panel.style.maxHeight = availHeight + 'px';
        } else {
            const availHeight = Math.max(120, spaceBelow - 16);
            panel.style.top = rect.bottom + 8 + 'px';
            panel.style.maxHeight = availHeight + 'px';
        }
        panel.style.left = left + 'px';
    }

    /**
     * 关闭所有弹出面板
     */
    closeAllPanels() {
        this.closeModelPanel(true);
        this.closeModePanel(true);
        this.toggleSkillPanel(true);
        this.closeAutocompletePanel();
    }

    toggleModelPanel(forceClose = false) {
        const panel = this.querySelector('#agent-input-model-panel');
        if (!panel) return;
        if (forceClose || panel.classList.contains('popup-panel-visible')) {
            this.closeModelPanel(true);
        } else {
            this.closeAllPanels();
            panel.classList.remove('popup-panel-hidden');
            panel.classList.add('popup-panel-visible');
            this.modelPanelOpen = true;
            const btn = this.querySelector('#agent-input-model-btn');
            if (btn) this.positionPanel(btn, panel);
            const searchInput = this.querySelector('#agent-input-model-search');
            if (searchInput) {
                searchInput.value = '';
                searchInput.focus();
            }
        }
    }

    closeModelPanel(force = false) {
        const panel = this.querySelector('#agent-input-model-panel');
        if (!panel) return;
        panel.classList.remove('popup-panel-visible');
        panel.classList.add('popup-panel-hidden');
        this.modelPanelOpen = false;
        this.hideEffortSubmenu();
    }

    toggleModePanel(forceClose = false) {
        const panel = this.querySelector('#agent-input-mode-panel');
        if (!panel) return;
        if (forceClose || panel.classList.contains('popup-panel-visible')) {
            this.closeModePanel(true);
        } else {
            this.closeAllPanels();
            panel.classList.remove('popup-panel-hidden');
            panel.classList.add('popup-panel-visible');
            this.modePanelOpen = true;
            const btn = this.querySelector('#agent-input-mode-btn');
            if (btn) this.positionPanel(btn, panel);
        }
    }

    closeModePanel(force = false) {
        const panel = this.querySelector('#agent-input-mode-panel');
        if (!panel) return;
        panel.classList.remove('popup-panel-visible');
        panel.classList.add('popup-panel-hidden');
        this.modePanelOpen = false;
    }

    renderModelList(filter = '') {
        const listEl = this.querySelector('#agent-input-model-list');
        if (!listEl) return;
        const lowerFilter = filter.toLowerCase();
        const filtered = lowerFilter
            ? this.availableModels.filter((m) => m.alias.toLowerCase().includes(lowerFilter))
            : this.availableModels;

        if (filtered.length === 0) {
            listEl.innerHTML = '<div class="popup-panel-empty">未找到匹配的模型</div>';
        } else {
            listEl.innerHTML = filtered
                .map((m) => {
                    const isActive = m.alias === this.selectedModel ? 'active' : '';
                    const checkMark =
                        m.alias === this.selectedModel
                            ? '<div class="popup-panel-item-check"><i class="fas fa-check"></i></div>'
                            : '';
                    return `<button class="popup-panel-item ${isActive}" data-model-alias="${m.alias}">
                        <div class="popup-panel-item-icon"><i class="fas fa-robot text-blue-500 text-xs"></i></div>
                        <div class="popup-panel-item-info">
                            <div class="popup-panel-item-name">${m.alias}</div>
                        </div>
                        ${checkMark}
                        <div class="popup-panel-item-arrow"><i class="fas fa-chevron-right text-[10px] text-gray-400"></i></div>
                    </button>`;
                })
                .join('');
        }
        this.bindModelItemEvents();
    }

    bindModelItemEvents() {
        const modelItems = this.querySelectorAll('#agent-input-model-list .popup-panel-item');
        modelItems.forEach((item) => {
            item.addEventListener('mouseenter', () => {
                const alias = item.dataset.modelAlias;
                if (!alias) return;
                // 清除其他模型项的 hovered 状态，给当前项加上
                this.querySelectorAll('#agent-input-model-list .popup-panel-item.hovered').forEach((el) => {
                    el.classList.remove('hovered');
                });
                item.classList.add('hovered');
                this.showEffortSubmenu(alias, item);
            });
            item.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });
    }

    /**
     * 在模型项右侧弹出 reasoning effort 子菜单
     */
    showEffortSubmenu(modelAlias, triggerItem) {
        const submenu = this.querySelector('#agent-input-effort-submenu');
        const submenuList = this.querySelector('#agent-input-effort-submenu-list');
        if (!submenu || !submenuList) return;

        // 记录当前 hover 的模型别名，供子菜单交互时使用
        this._hoveredModelAlias = modelAlias;

        // 生成子菜单内容
        submenuList.innerHTML = REASONING_EFFORT_OPTIONS.map((o) => {
            const isActive =
                modelAlias === this.selectedModel && o.value === this.selectedReasoningEffort ? 'active' : '';
            const checkMark = isActive ? '<div class="popup-panel-item-check"><i class="fas fa-check"></i></div>' : '';
            const icon =
                o.value === ''
                    ? 'fa-gauge'
                    : o.value === 'none'
                      ? 'fa-ban'
                      : o.value === 'low'
                        ? 'fa-gauge-simple'
                        : o.value === 'medium'
                          ? 'fa-gauge'
                          : 'fa-gauge-high';
            return `<button class="popup-panel-item ${isActive}" data-model-alias="${modelAlias}" data-effort-value="${o.value}">
                <div class="popup-panel-item-icon"><i class="fas ${icon} text-blue-500 text-xs"></i></div>
                <div class="popup-panel-item-info">
                    <div class="popup-panel-item-name">${o.label}</div>
                </div>
                ${checkMark}
            </button>`;
        }).join('');

        // 定位：对齐到当前模型项的右侧，并确保不溢出窗口
        const modelPanel = this.querySelector('#agent-input-model-panel');
        if (modelPanel && triggerItem) {
            const panelRect = modelPanel.getBoundingClientRect();
            const itemRect = triggerItem.getBoundingClientRect();
            let top = itemRect.top;
            let left = panelRect.right + 4;
            const submenuHeight = Math.min(280, submenu.scrollHeight || 200);
            if (top + submenuHeight > window.innerHeight - 8) {
                top = Math.max(8, window.innerHeight - submenuHeight - 8);
            }
            if (left + 180 > window.innerWidth - 8) {
                left = panelRect.left - 180 - 4;
            }
            submenu.style.top = top + 'px';
            submenu.style.left = Math.max(8, left) + 'px';
        }

        // 重播弹出动画：先移除再添加 visible 类
        submenu.classList.remove('popup-panel-visible');
        submenu.classList.add('popup-panel-hidden');
        // 强制 reflow 以重启动画
        void submenu.offsetWidth;
        submenu.classList.remove('popup-panel-hidden');
        submenu.classList.add('popup-panel-visible');

        // 绑定子菜单项事件
        this.bindEffortSubmenuEvents();
    }

    hideEffortSubmenu() {
        const submenu = this.querySelector('#agent-input-effort-submenu');
        if (!submenu) return;
        submenu.classList.remove('popup-panel-visible');
        submenu.classList.add('popup-panel-hidden');
        // 清除模型项的 hovered 状态
        this.querySelectorAll('#agent-input-model-list .popup-panel-item.hovered').forEach((el) => {
            el.classList.remove('hovered');
        });
        this._hoveredModelAlias = null;
    }

    bindEffortSubmenuEvents() {
        const items = this.querySelectorAll('#agent-input-effort-submenu-list .popup-panel-item');
        items.forEach((item) => {
            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                const alias = item.dataset.modelAlias;
                const effortValue = item.dataset.effortValue;
                if (!alias || effortValue === undefined) return;
                this.selectedModel = alias;
                this.selectedReasoningEffort = effortValue;
                await updateSettingForModelChange(this.selectedModel, this.selectedReasoningEffort);
                this.closeModelPanel();
                this.hideEffortSubmenu();
                // 更新按钮文字
                const modelBtn = this.querySelector('#agent-input-model-btn span');
                if (modelBtn) modelBtn.textContent = this.getModelButtonLabel();
                this.dispatchEvent(
                    new CustomEvent('model-changed', {
                        detail: { model: this.selectedModel },
                        bubbles: true
                    })
                );
            });
        });
    }

    bindModeItemEvents() {
        const items = this.querySelectorAll('#agent-input-mode-list .popup-panel-item');
        items.forEach((item) => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const modeId = item.dataset.modeId;
                if (!modeId) return;
                this.setMode(modeId);
                this.closeModePanel();
                const modeBtnIcon = this.querySelector('#agent-input-mode-btn span:first-child');
                const modeBtnText = this.querySelector('#agent-input-mode-btn span:last-child');
                const mode = this.availableModes.find((m) => m.id === modeId);
                if (mode) {
                    if (modeBtnIcon) modeBtnIcon.textContent = mode.icon;
                    if (modeBtnText) modeBtnText.textContent = mode.name;
                }
            });
        });
    }

    toggleSkillPanel(forceClose = false) {
        const panel = this.querySelector('#agent-input-skill-panel');
        if (!panel) return;
        if (forceClose || panel.classList.contains('skill-panel-visible')) {
            panel.classList.remove('skill-panel-visible');
            panel.classList.add('skill-panel-hidden');
            this.skillPanelOpen = false;
        } else {
            this.closeModelPanel(true);
            this.closeModePanel(true);
            this.loadSkills().then(() => {
                this.renderSkillList();
                panel.classList.remove('skill-panel-hidden');
                panel.classList.add('skill-panel-visible');
                this.skillPanelOpen = true;

                const btn = this.querySelector('#agent-input-skill-btn');
                if (btn) {
                    this.positionPanel(btn, panel, 280, 320);
                }

                const searchInput = this.querySelector('#agent-input-skill-search');
                if (searchInput) {
                    searchInput.value = '';
                    searchInput.focus();
                }
            });
        }
    }

    renderSkillList(filter = '') {
        const listEl = this.querySelector('#agent-input-skill-list');
        if (!listEl) return;
        const lowerFilter = filter.toLowerCase();
        const filtered = lowerFilter
            ? this.availableSkills.filter(
                  (s) => s.name.toLowerCase().includes(lowerFilter) || s.description.toLowerCase().includes(lowerFilter)
              )
            : this.availableSkills;

        if (filtered.length === 0) {
            listEl.innerHTML = `<div class="skill-panel-empty">${filter ? '未找到匹配的技能' : '暂无已安装的技能'}</div>`;
        } else {
            listEl.innerHTML = filtered
                .map(
                    (s) => `
                <button class="skill-panel-item" data-skill-name="${s.name}">
                    <div class="skill-panel-item-icon">
                        <i class="fas fa-bolt text-violet-500 text-xs"></i>
                    </div>
                    <div class="skill-panel-item-info">
                        <div class="skill-panel-item-name">${s.name}</div>
                        <div class="skill-panel-item-desc">${s.description}</div>
                    </div>
                </button>
            `
                )
                .join('');
        }
        this.bindSkillItemEvents();
    }

    bindSkillItemEvents() {
        const items = this.querySelectorAll('.skill-panel-item');
        const textarea = this.querySelector('#agent-input-textarea');
        items.forEach((item) => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const skillName = item.dataset.skillName;
                if (!skillName || !textarea) return;
                const prefix = `/${skillName} `;
                const cursorPos = textarea.selectionStart;
                const textBefore = textarea.value.substring(0, cursorPos);
                const textAfter = textarea.value.substring(cursorPos);
                textarea.value = textBefore + prefix + textAfter;
                const newPos = cursorPos + prefix.length;
                textarea.setSelectionRange(newPos, newPos);
                textarea.focus();
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                this.toggleSkillPanel(true);
            });
        });
    }

    async handleInstallSkill() {
        try {
            if (!window.fsAPI?.selectFile) return;
            const filePaths = await window.fsAPI.selectFile();
            if (!filePaths || filePaths.length === 0) return;

            const zipPath = filePaths[0];
            if (!zipPath.toLowerCase().endsWith('.zip')) {
                window.notificationAPI?.sendNotification(
                    'error',
                    '技能中心',
                    '文件格式错误',
                    '请选择 .zip 格式的技能包'
                );
                return;
            }

            const result = await window.applicationRegistryAPI.callMainWorld(
                'skillmgr',
                'installSkillFromZip',
                zipPath
            );
            if (result.success) {
                window.notificationAPI?.sendNotification(
                    'success',
                    '技能中心',
                    '安装成功',
                    `技能 ${result.name} 已安装`
                );
                await this.loadSkills();
                this.renderSkillList(this.querySelector('#agent-input-skill-search')?.value || '');
            } else {
                window.notificationAPI?.sendNotification('error', '技能中心', '安装失败', result.error || '未知错误');
            }
        } catch (err) {
            console.error('Failed to install skill:', err);
            window.notificationAPI?.sendNotification('error', '技能中心', '安装失败', err.message || '未知错误');
        }
    }

    // ── 内联补全面板 ────────────────────────────────────────

    /**
     * 处理输入变化，检测 / 和 @ 触发补全
     */
    handleAutocompleteInput(textarea) {
        const value = textarea.value;
        const cursorPos = textarea.selectionStart;
        const textBefore = value.substring(0, cursorPos);

        // 检测 / 技能补全：行首的 / 或者前面是空白的 /
        const slashMatch = textBefore.match(/(?:^|\s)(\/[a-z0-9][-a-z0-9]*?)$|(?:^|\s)(\/)$/);
        if (slashMatch) {
            const prefix = slashMatch[1] || slashMatch[2];
            const nameFilter = prefix.slice(1).toLowerCase();
            const filtered = this.availableSkills.filter(
                (s) => !nameFilter || s.name.toLowerCase().includes(nameFilter)
            );
            if (filtered.length > 0) {
                this.autocompleteMode = 'skill';
                this.autocompleteItems = filtered.map((s) => ({
                    value: s.name,
                    label: s.name,
                    description: s.description.slice(0, 80),
                    icon: 'fa-bolt',
                    iconClass: 'skill-icon'
                }));
                this.autocompleteSelectedIndex = 0;
                this.showAutocompletePanel(textarea);
                return;
            }
        }

        // 检测 @ 文件补全
        const atMatch = this.extractAtQuery(textBefore);
        if (atMatch) {
            if (this._fileCompleteTimer) clearTimeout(this._fileCompleteTimer);
            this._fileCompleteTimer = setTimeout(() => {
                this.loadFileCompletions(atMatch.query, textarea);
            }, 150);
            return;
        }

        this.closeAutocompletePanel();
    }

    /**
     * 从文本末尾向前查找 @ 前缀
     */
    extractAtQuery(text) {
        const delimiters = new Set([' ', '\t', '"', "'", '=']);
        for (let i = text.length - 1; i >= 0; i--) {
            if (text[i] === '@' && (i === 0 || delimiters.has(text[i - 1]))) {
                return { fullPrefix: text.slice(i), query: text.slice(i + 1) };
            }
        }
        return null;
    }

    /**
     * 通过 IPC 获取文件列表进行补全
     */
    async loadFileCompletions(query, textarea) {
        try {
            if (!this._workspacePath && window.workspaceAPI?.getEffectiveWorkspace) {
                this._workspacePath = await window.workspaceAPI.getEffectiveWorkspace();
            }
            if (!this._workspacePath || !window.fsAPI?.listDirectory) return;

            const normalizedQuery = query.replace(/\\/g, '/');
            let searchDir, filter, displayBase;

            if (normalizedQuery.includes('/')) {
                const lastSlash = normalizedQuery.lastIndexOf('/');
                displayBase = normalizedQuery.slice(0, lastSlash + 1);
                filter = normalizedQuery.slice(lastSlash + 1).toLowerCase();
                const expandedDir = displayBase.startsWith('/') ? displayBase : this._workspacePath + '/' + displayBase;
                searchDir = expandedDir;
            } else {
                searchDir = this._workspacePath;
                filter = normalizedQuery.toLowerCase();
                displayBase = '';
            }

            const entries = await window.fsAPI.listDirectory(searchDir);
            const items = [];
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                if (filter && !entry.name.toLowerCase().startsWith(filter)) continue;
                const relativePath = displayBase ? displayBase + entry.name : entry.name;
                const displayPath = entry.isDirectory ? relativePath + '/' : relativePath;
                items.push({
                    value: '@' + displayPath,
                    label: entry.name + (entry.isDirectory ? '/' : ''),
                    description: displayPath,
                    icon: entry.isDirectory ? 'fa-folder' : 'fa-file',
                    iconClass: entry.isDirectory ? 'dir-icon' : ''
                });
                if (items.length >= 20) break;
            }

            if (items.length > 0) {
                this.autocompleteMode = 'file';
                this.autocompleteItems = items;
                this.autocompleteSelectedIndex = 0;
                this.showAutocompletePanel(textarea);
            } else {
                this.closeAutocompletePanel();
            }
        } catch {
            this.closeAutocompletePanel();
        }
    }

    /**
     * 显示补全面板并定位到 textarea
     */
    showAutocompletePanel(textarea) {
        const panel = this.querySelector('#agent-input-autocomplete');
        const listEl = this.querySelector('#agent-input-autocomplete-list');
        if (!panel || !listEl) return;

        listEl.innerHTML = this.autocompleteItems
            .map(
                (item, idx) => `
            <button class="autocomplete-panel-item${idx === this.autocompleteSelectedIndex ? ' selected' : ''}" data-idx="${idx}">
                <div class="autocomplete-panel-item-icon ${item.iconClass || ''}">
                    <i class="fas ${item.icon}"></i>
                </div>
                <div class="autocomplete-panel-item-info">
                    <div class="autocomplete-panel-item-name">${item.label}</div>
                    ${item.description ? `<div class="autocomplete-panel-item-desc">${item.description}</div>` : ''}
                </div>
            </button>
        `
            )
            .join('');

        panel.classList.remove('autocomplete-panel-hidden');
        panel.classList.add('autocomplete-panel-visible');
        this.autocompleteOpen = true;

        const textareaRect = textarea.getBoundingClientRect();
        const panelHeight = Math.min(260, panel.scrollHeight);
        const spaceAbove = textareaRect.top;
        const spaceBelow = window.innerHeight - textareaRect.bottom;

        if (spaceAbove >= panelHeight + 8) {
            panel.style.top = textareaRect.top - panelHeight - 4 + 'px';
        } else if (spaceBelow >= panelHeight + 8) {
            panel.style.top = textareaRect.bottom + 4 + 'px';
        } else if (spaceAbove >= spaceBelow) {
            const h = Math.max(100, spaceAbove - 12);
            panel.style.top = textareaRect.top - h - 4 + 'px';
            panel.style.maxHeight = h + 'px';
        } else {
            const h = Math.max(100, spaceBelow - 12);
            panel.style.top = textareaRect.bottom + 4 + 'px';
            panel.style.maxHeight = h + 'px';
        }
        let left = textareaRect.left;
        if (left + 300 > window.innerWidth) left = window.innerWidth - 300 - 8;
        panel.style.left = Math.max(8, left) + 'px';

        this.bindAutocompleteItemEvents();
    }

    closeAutocompletePanel() {
        const panel = this.querySelector('#agent-input-autocomplete');
        if (!panel) return;
        panel.classList.remove('autocomplete-panel-visible');
        panel.classList.add('autocomplete-panel-hidden');
        this.autocompleteOpen = false;
        this.autocompleteMode = null;
    }

    bindAutocompleteItemEvents() {
        const items = this.querySelectorAll('#agent-input-autocomplete-list .autocomplete-panel-item');
        items.forEach((item) => {
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const idx = parseInt(item.dataset.idx, 10);
                this.applyAutocomplete(idx);
            });
            item.addEventListener('mouseenter', () => {
                const idx = parseInt(item.dataset.idx, 10);
                this.autocompleteSelectedIndex = idx;
                this.updateAutocompleteSelection();
            });
        });
    }

    updateAutocompleteSelection() {
        const items = this.querySelectorAll('#agent-input-autocomplete-list .autocomplete-panel-item');
        items.forEach((el, i) => {
            if (i === this.autocompleteSelectedIndex) {
                el.classList.add('selected');
                el.scrollIntoView({ block: 'nearest' });
            } else {
                el.classList.remove('selected');
            }
        });
    }

    /**
     * 应用选中的补全项到 textarea
     */
    applyAutocomplete(index) {
        const textarea = this.querySelector('#agent-input-textarea');
        if (!textarea || index < 0 || index >= this.autocompleteItems.length) return;

        const item = this.autocompleteItems[index];
        const cursorPos = textarea.selectionStart;
        const textBefore = textarea.value.substring(0, cursorPos);
        const textAfter = textarea.value.substring(cursorPos);

        if (this.autocompleteMode === 'skill') {
            // 替换 /prefix 为 /skillname + 空格
            const slashMatch = textBefore.match(/(?:^|\s)(\/[a-z0-9][-a-z0-9]*?)$|(?:^|\s)(\/)$/);
            if (slashMatch) {
                const matchStr = slashMatch[1] || slashMatch[2];
                const matchStart = cursorPos - matchStr.length;
                const replacement = '/' + item.value + ' ';
                textarea.value = textBefore.substring(0, matchStart) + replacement + textAfter;
                const newPos = matchStart + replacement.length;
                textarea.setSelectionRange(newPos, newPos);
            }
        } else if (this.autocompleteMode === 'file') {
            // 替换 @query 为 @path
            const atMatch = this.extractAtQuery(textBefore);
            if (atMatch) {
                const matchStart = cursorPos - atMatch.fullPrefix.length;
                const replacement = item.value;
                // 如果是目录，不加空格（继续补全子路径）
                const suffix = replacement.endsWith('/') ? '' : ' ';
                textarea.value = textBefore.substring(0, matchStart) + replacement + suffix + textAfter;
                const newPos = matchStart + replacement.length + suffix.length;
                textarea.setSelectionRange(newPos, newPos);
            }
        }

        textarea.focus();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        this.closeAutocompletePanel();

        // 如果选中的是目录，延迟触发下一级补全
        if (this.autocompleteMode === 'file' && item.value.endsWith('/')) {
            setTimeout(() => {
                this.handleAutocompleteInput(textarea);
            }, 50);
        }
    }

    /**
     * 处理补全面板中的键盘导航
     * @returns {boolean} 是否消费了按键事件
     */
    handleAutocompleteKeydown(e) {
        if (!this.autocompleteOpen) return false;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.autocompleteSelectedIndex = (this.autocompleteSelectedIndex + 1) % this.autocompleteItems.length;
            this.updateAutocompleteSelection();
            return true;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.autocompleteSelectedIndex =
                (this.autocompleteSelectedIndex - 1 + this.autocompleteItems.length) % this.autocompleteItems.length;
            this.updateAutocompleteSelection();
            return true;
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
            // 仅在补全面板打开且不是 Ctrl+Enter 时消费
            if (e.key === 'Enter' && e.ctrlKey) return false;
            e.preventDefault();
            this.applyAutocomplete(this.autocompleteSelectedIndex);
            return true;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            this.closeAutocompletePanel();
            return true;
        }
        return false;
    }

    setUpEventListeners() {
        const container = this.querySelector('#agent-input-container');
        const textarea = this.querySelector('#agent-input-textarea');
        const submitBtn = this.querySelector('#agent-input-submit-btn');
        const stopBtn = this.querySelector('#agent-input-stop-btn');
        const removeFileBtns = this.querySelectorAll('.agent-input-remove-file-btn');

        // 模型选择面板
        const modelBtn = this.querySelector('#agent-input-model-btn');
        const modelSearch = this.querySelector('#agent-input-model-search');

        if (modelBtn) {
            modelBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleModelPanel();
            });
        }
        if (modelSearch) {
            modelSearch.addEventListener('input', (e) => {
                this.renderModelList(e.target.value);
            });
            modelSearch.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this.toggleModelPanel(true);
                    textarea.focus();
                }
                e.stopPropagation();
            });
            modelSearch.addEventListener('click', (e) => e.stopPropagation());
        }
        this.bindModelItemEvents();

        // 模式选择面板
        const modeBtn = this.querySelector('#agent-input-mode-btn');
        if (modeBtn) {
            modeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleModePanel();
            });
        }
        this.bindModeItemEvents();

        // 技能选择面板
        const skillBtn = this.querySelector('#agent-input-skill-btn');
        const skillSearch = this.querySelector('#agent-input-skill-search');

        if (skillBtn) {
            skillBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleSkillPanel();
            });
        }
        if (skillSearch) {
            skillSearch.addEventListener('input', (e) => {
                this.renderSkillList(e.target.value);
            });
            skillSearch.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this.toggleSkillPanel(true);
                    textarea.focus();
                }
                e.stopPropagation();
            });
            skillSearch.addEventListener('click', (e) => e.stopPropagation());
        }

        const skillInstallBtn = this.querySelector('#agent-input-skill-install-btn');
        if (skillInstallBtn) {
            skillInstallBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.handleInstallSkill();
            });
        }

        if (!this._docClickBound) {
            this._docClickBound = true;
            document.addEventListener('click', (e) => {
                // 关闭模型面板
                if (this.modelPanelOpen) {
                    const panel = this.querySelector('#agent-input-model-panel');
                    const submenu = this.querySelector('#agent-input-effort-submenu');
                    const btn = this.querySelector('#agent-input-model-btn');
                    const clickedPanel = panel && panel.contains(e.target);
                    const clickedSubmenu = submenu && submenu.contains(e.target);
                    if (!clickedPanel && !clickedSubmenu && e.target !== btn && !btn?.contains(e.target)) {
                        this.closeModelPanel();
                    }
                }
                // 关闭模式面板
                if (this.modePanelOpen) {
                    const panel = this.querySelector('#agent-input-mode-panel');
                    const btn = this.querySelector('#agent-input-mode-btn');
                    if (panel && !panel.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
                        this.closeModePanel();
                    }
                }
                // 关闭技能面板
                if (this.skillPanelOpen) {
                    const panel = this.querySelector('#agent-input-skill-panel');
                    const btn = this.querySelector('#agent-input-skill-btn');
                    if (panel && !panel.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
                        this.toggleSkillPanel(true);
                    }
                }
                // 关闭补全面板
                if (this.autocompleteOpen) {
                    const acPanel = this.querySelector('#agent-input-autocomplete');
                    const ta = this.querySelector('#agent-input-textarea');
                    if (acPanel && !acPanel.contains(e.target) && e.target !== ta) {
                        this.closeAutocompletePanel();
                    }
                }
            });
        }

        this.bindSkillItemEvents();

        // 提交消息的函数
        const handleSubmit = () => {
            if (this.isDisabled) {
                return;
            }

            const message = textarea.value.trim();
            if (message === '') {
                return;
            }

            const submitEvent = new CustomEvent('submit', {
                detail: {
                    message: message,
                    attachedFilePaths: this.attachedFilePaths,
                    selectedModel: this.selectedModel || undefined,
                    reasoningEffort: this.selectedReasoningEffort || undefined
                },
                bubbles: true
            });
            this.dispatchEvent(submitEvent);

            textarea.value = '';
            this.clearAttachedFilePaths();
        };

        submitBtn.addEventListener('click', handleSubmit);

        // 停止按钮事件
        if (stopBtn) {
            stopBtn.addEventListener('click', () => {
                if (this.onStopCallback) {
                    this.onStopCallback();
                }
            });
        }

        removeFileBtns.forEach((btn) => {
            btn.addEventListener('click', (e) => {
                this.removeFilePath(btn.dataset.file_path);
            });
        });

        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        container.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const files = e.dataTransfer.files;
            for (const file of files) {
                const filePath = window.fsAPI.getFilePath(file);
                /* electron前端无法获取文件完整路径，需要通过fsAPI.getFilePath获取 */

                // 检查路径类型
                const pathType = await window.fsAPI.getPathType(filePath);

                if (pathType === 'directory') {
                    // 如果是目录，直接插入到textarea当前光标位置
                    const cursorPos = textarea.selectionStart;
                    const textBefore = textarea.value.substring(0, cursorPos);
                    const textAfter = textarea.value.substring(cursorPos);
                    textarea.value = textBefore + filePath + textAfter;
                    // 设置光标位置到插入文本的末尾
                    const newCursorPos = cursorPos + filePath.length;
                    textarea.setSelectionRange(newCursorPos, newCursorPos);
                    // 触发input事件以通知内容变化
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                } else if (pathType === 'file') {
                    // 如果是文件，按原有逻辑attachFilepath
                    this.attachFilePath(filePath);
                }
                // 如果pathType为null（路径不存在），则不执行任何操作
            }
        });

        // 键盘事件：补全导航 + Ctrl+Enter 发送
        textarea.addEventListener('keydown', (e) => {
            if (this.isDisabled) {
                e.preventDefault();
                return;
            }

            // 补全面板打开时优先处理键盘导航
            if (this.handleAutocompleteKeydown(e)) return;

            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                handleSubmit();
            }
        });

        textarea.addEventListener('input', (e) => {
            this.dispatchEvent(
                new CustomEvent('contentChanged', {
                    detail: {
                        value: e.target.value
                    },
                    bubbles: true
                })
            );
            // 检测 / 和 @ 触发补全
            this.handleAutocompleteInput(textarea);
        });
    }
}

class ApplicationAgentInput extends HTMLElement {
    /**
     * 这个组件用于显示嵌入在应用之中的悬浮AI输入框
     */

    constructor() {
        super();
        /**
         * 当前任务状态
         * @type {string}
         */
        this.taskStatus = 'waiting';
        /**
         * 停止任务的回调函数
         * @type {function | null}
         */
        this.onStopCallback = null;
    }

    /**
     * 设置任务状态
     * @param {string} status 任务状态 ('running', 'waiting', 'stopped' 等)
     * @param {function | null} onStopCallback 停止任务的回调函数
     */
    setTaskStatus(status, onStopCallback = null) {
        this.taskStatus = status;
        this.onStopCallback = onStopCallback;
        this.updateDisplay();
    }

    /**
     * 更新显示状态（停止图标或渐变背景）
     */
    updateDisplay() {
        const gradientContainer = this.querySelector('#gradient-container');
        const stopButton = this.querySelector('#stop-task-button');
        const textarea = this.querySelector('#application-agent-input-textarea');

        if (!gradientContainer || !stopButton) {
            return;
        }

        if (this.taskStatus === 'running') {
            // 显示停止图标，隐藏渐变背景
            gradientContainer.classList.add('hidden');
            stopButton.classList.remove('hidden');
            // 禁用输入框
            if (textarea) {
                textarea.disabled = true;
                textarea.classList.add('opacity-50', 'cursor-not-allowed');
            }
        } else {
            // 显示渐变背景，隐藏停止图标
            gradientContainer.classList.remove('hidden');
            stopButton.classList.add('hidden');
            // 启用输入框
            if (textarea) {
                textarea.disabled = false;
                textarea.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        }
    }

    connectedCallback() {
        this.render();
    }

    render() {
        this.innerHTML = `
        <style>
        /* Siri 风格的多色液态旋转背景 */
        @keyframes siri-rotate {
            0% { transform: rotate(0deg) scale(1); }
            50% { transform: rotate(180deg) scale(1.2); }
            100% { transform: rotate(360deg) scale(1); }
        }
        .animate-siri {
            background: conic-gradient(from 0deg, #3b82f6, #8b5cf6, #ec4899, #3b82f6);
            filter: blur(8px);
            animation: siri-rotate 4s linear infinite;
        }
        /* 贝塞尔曲线让展开更有弹性感 */
        .transition-liquid {
            transition: all 0.6s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        /* 展开状态样式 */
        #input-container.expanded,
        .group:hover #input-container {
            width: 450px;
        }
        #input-content.expanded,
        .group:hover #input-content {
            opacity: 1;
        }
        </style>

        <div class="flex-none p-3 flex justify-center items-center">
            <!-- pointer-events-auto 确保球体区域可以响应鼠标事件（父元素 application-agent-input 为 none） -->
            <div class="group relative flex items-center justify-center pointer-events-auto">

                <!-- 外部动态光晕 (只在圆框状态下明显) -->
                <div class="absolute inset-0 bg-blue-500/30 blur-2xl rounded-full opacity-0 group-hover:opacity-0 transition-opacity duration-1500"></div>

                <!-- 对话框/圆框主体 -->

                <!-- 初始：w-14 (圆) -> 悬停或焦点：w-[450px] (长条) -->
                <div id="input-container" class="transition-liquid relative flex items-center bg-white/[0.18] backdrop-blur-md border border-white/20 shadow-2xl overflow-hidden
                            w-14 h-14 rounded-full px-2">

                    <!-- 内部液态背景 (Siri 核心) - 任务非运行状态时显示 -->
                    <!-- 即使展开了，这个圆形发光体也可以作为图标保留在左侧 -->
                    <div id="gradient-container" class="flex-shrink-0 w-10 h-10 relative overflow-hidden rounded-full flex items-center justify-center">
                        <div class="absolute inset-0 animate-siri opacity-80"></div>
                    </div>

                    <!-- 停止按钮 - 任务运行状态时显示 -->
                    <button id="stop-task-button" class="flex-shrink-0 w-10 h-10 rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-colors shadow-lg hidden">
                        <i class="fas fa-stop text-sm"></i>
                    </button>

                    <!-- 展开后的内容：输入框和按钮 -->
                    <!-- 使用 expanded 状态和 hover 控制透明度和显示 -->
                    <div id="input-content" class="flex flex-1 items-center opacity-0 transition-opacity duration-500 delay-100 pl-3">
                        <input
                            id="application-agent-input-textarea"
                            type="text"
                            placeholder="告诉我你想做什么..."
                            class="w-full bg-transparent border-none p-2 rounded-full focus:ring-0 text-black placeholder-black/50 text-sm"
                        />

                        <!-- 快捷按钮 -->
                        <div class="flex items-center gap-2 pr-1">
                            <button class="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-black/70 transition-colors">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                                </svg>
                            </button>
                        </div>
                    </div>

                </div>

            </div>
        </div>
        `;

        const textarea = this.querySelector('#application-agent-input-textarea');
        const container = this.querySelector('#input-container');
        const content = this.querySelector('#input-content');
        const group = container.closest('.group');
        const stopButton = this.querySelector('#stop-task-button');

        // 停止按钮点击事件
        if (stopButton) {
            stopButton.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.onStopCallback) {
                    this.onStopCallback();
                }
            });
        }

        // 跟踪hover和focus状态
        let isHovered = false;
        let isFocused = false;

        // 更新展开状态的函数
        const updateExpandedState = () => {
            if (isFocused || isHovered) {
                container.classList.add('expanded');
                content.classList.add('expanded');
            } else {
                container.classList.remove('expanded');
                content.classList.remove('expanded');
            }
        };

        // 焦点时展开
        textarea.addEventListener('focus', () => {
            isFocused = true;
            const focusEvent = new CustomEvent('focus', {
                bubbles: true
            });
            this.dispatchEvent(focusEvent);
            updateExpandedState();
        });

        // 失去焦点时检查状态
        textarea.addEventListener('blur', () => {
            isFocused = false;
            // 延迟检查，以便能够检测到hover状态
            setTimeout(() => {
                updateExpandedState();
            }, 0);
        });

        textarea.addEventListener('keydown', (event) => {
            // 如果正在输入法组字过程中，直接返回，不执行提交逻辑
            if (event.isComposing || event.keyCode === 229) {
                return;
            }

            if (event.key === 'Enter') {
                event.preventDefault();
                const submitEvent = new CustomEvent('submit', {
                    detail: {
                        message: textarea.value,
                        attachedFilePaths: []
                    },
                    bubbles: true
                });
                this.dispatchEvent(submitEvent);
                textarea.value = '';
            }
        });

        // 处理鼠标进入和离开时的状态
        group.addEventListener('mouseenter', () => {
            isHovered = true;
            updateExpandedState();
        });

        group.addEventListener('mouseleave', () => {
            isHovered = false;
            updateExpandedState();
        });

        // 初始化显示状态
        this.updateDisplay();
    }
}

customElements.define('agent-input', AgentInput);
customElements.define('application-agent-input', ApplicationAgentInput);
