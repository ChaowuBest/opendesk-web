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

const supportedFileExtensions = ['pdf', 'docx', 'doc', 'xls', 'xlsx', 'ppt', 'pptx'];

const REASONING_EFFORT_OPTIONS = [
    { value: '', label: '默认' },
    { value: 'none', label: '无推理' },
    { value: 'low', label: '简洁推理' },
    { value: 'medium', label: '推理适中' },
    { value: 'high', label: '推理深入' }
];

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
        /** @type {{ id: string, name: string, description: string }[]} */
        this.availableSkills = [];
        this.skillPanelOpen = false;
        this.skillSearchQuery = '';
    }

    connectedCallback() {
        Promise.all([this.loadModels(), this.loadSkills()]).then(() => this.render());
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
        const modelSelect = this.querySelector('#agent-input-model-select');
        if (modelSelect) modelSelect.value = modelAlias;
    }

    /**
     * 外部设置当前 reasoning effort（不写入系统设置，仅更新 UI 状态）
     */
    setReasoningEffort(effort) {
        this.selectedReasoningEffort = effort || '';
        const effortSelect = this.querySelector('#agent-input-effort-select');
        if (effortSelect) effortSelect.value = this.selectedReasoningEffort;
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

        const modelOptions = this.availableModels
            .map((m) => {
                const selected = m.alias === this.selectedModel ? 'selected' : '';
                return `<option value="${m.alias}" ${selected}>${m.alias}</option>`;
            })
            .join('');

        const effortOptions = REASONING_EFFORT_OPTIONS.map((o) => {
            const selected = o.value === this.selectedReasoningEffort ? 'selected' : '';
            return `<option value="${o.value}" ${selected}>${o.label}</option>`;
        }).join('');

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
                    <!-- 左侧：模型选择 + 推理模式 + 技能 + 附件 -->
                    <div class="flex items-center gap-1.5 flex-wrap" style="row-gap: 0.2rem;">
                        ${
                            this.availableModels.length > 0
                                ? `
                        <select id="agent-input-model-select"
                            class="agent-input-toolbar-control text-xs bg-gray-50 border border-gray-200 rounded-full px-2 py-0.5 text-gray-600 outline-none hover:border-gray-400 transition-colors cursor-pointer"
                            style="max-width: 130px;">
                            ${modelOptions}
                        </select>
                        <select id="agent-input-effort-select"
                            class="agent-input-toolbar-control text-xs bg-gray-50 border border-gray-200 rounded-full px-2 py-0.5 text-gray-600 outline-none hover:border-gray-400 transition-colors cursor-pointer">
                            ${effortOptions}
                        </select>
                        `
                                : ''
                        }
                        <!-- 技能选择按钮 -->
                        <div class="relative">
                            <button id="agent-input-skill-btn" class="agent-input-toolbar-control flex items-center justify-center gap-1 text-xs bg-gray-50 border border-gray-200 rounded-full px-2 py-0.5 text-gray-600 outline-none hover:border-purple-400 hover:text-purple-600 transition-colors cursor-pointer">
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
        ${this.getAttribute('hide-disclaimer') !== null ? '' : '<p class="text-center text-[11px] text-gray-400 mt-1.5 select-none">内容由 AI 生成，请核实重要信息。</p>'}
        `;

        this.setUpEventListeners();
        this.updateInputState();
    }

    toggleSkillPanel(forceClose = false) {
        const panel = this.querySelector('#agent-input-skill-panel');
        if (!panel) return;
        if (forceClose || panel.classList.contains('skill-panel-visible')) {
            panel.classList.remove('skill-panel-visible');
            panel.classList.add('skill-panel-hidden');
            this.skillPanelOpen = false;
        } else {
            this.loadSkills().then(() => {
                this.renderSkillList();
                panel.classList.remove('skill-panel-hidden');
                panel.classList.add('skill-panel-visible');
                this.skillPanelOpen = true;

                const btn = this.querySelector('#agent-input-skill-btn');
                if (btn) {
                    const rect = btn.getBoundingClientRect();
                    const panelHeight = Math.min(320, panel.scrollHeight);
                    let left = rect.left;
                    if (left + 280 > window.innerWidth) {
                        left = window.innerWidth - 280 - 8;
                    }
                    panel.style.top = rect.top - panelHeight - 8 + 'px';
                    panel.style.left = left + 'px';
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
                        <i class="fas fa-bolt text-purple-500 text-xs"></i>
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
                    '技能管理',
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
                    '技能管理',
                    '安装成功',
                    `技能 ${result.name} 已安装`
                );
                await this.loadSkills();
                this.renderSkillList(this.querySelector('#agent-input-skill-search')?.value || '');
            } else {
                window.notificationAPI?.sendNotification('error', '技能管理', '安装失败', result.error || '未知错误');
            }
        } catch (err) {
            console.error('Failed to install skill:', err);
            window.notificationAPI?.sendNotification('error', '技能管理', '安装失败', err.message || '未知错误');
        }
    }

    setUpEventListeners() {
        const container = this.querySelector('#agent-input-container');
        const textarea = this.querySelector('#agent-input-textarea');
        const submitBtn = this.querySelector('#agent-input-submit-btn');
        const stopBtn = this.querySelector('#agent-input-stop-btn');
        const removeFileBtns = this.querySelectorAll('.agent-input-remove-file-btn');
        const modelSelect = this.querySelector('#agent-input-model-select');
        const effortSelect = this.querySelector('#agent-input-effort-select');

        if (modelSelect) {
            modelSelect.addEventListener('change', async () => {
                this.selectedModel = modelSelect.value;
                const currentModel = this.availableModels.find((m) => m.alias === this.selectedModel);
                if (currentModel) {
                    this.selectedReasoningEffort = currentModel.reasoning_effort || '';
                    if (effortSelect) effortSelect.value = this.selectedReasoningEffort;
                }
                await updateSettingForModelChange(this.selectedModel, undefined);
            });
        }
        if (effortSelect) {
            effortSelect.addEventListener('change', async () => {
                this.selectedReasoningEffort = effortSelect.value;
                await updateSettingForModelChange(this.selectedModel, this.selectedReasoningEffort);
            });
        }

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

        if (!this._skillPanelDocClickBound) {
            this._skillPanelDocClickBound = true;
            document.addEventListener('click', (e) => {
                if (this.skillPanelOpen) {
                    const panel = this.querySelector('#agent-input-skill-panel');
                    const btn = this.querySelector('#agent-input-skill-btn');
                    if (panel && !panel.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
                        this.toggleSkillPanel(true);
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

        // Ctrl+Enter 快捷键
        textarea.addEventListener('keydown', (e) => {
            // 如果输入框被禁用，阻止所有输入
            if (this.isDisabled) {
                e.preventDefault();
                return;
            }

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
