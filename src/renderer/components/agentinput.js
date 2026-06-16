/* eslint-disable no-console */
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
import { showImageLightbox } from './imageLightbox.js';
import { escapeHtml } from '../../common/utils/escape.js';
import { NativeBridgeProxy } from '../../platforms/bridges/renderer.ts';
import TurndownService from 'turndown';

const supportedFileExtensions = ['pdf', 'docx', 'doc', 'xls', 'xlsx', 'ppt', 'pptx'];
const bridgeProxy = new NativeBridgeProxy();

/** 模块级语音可用性缓存，避免每个 AgentInput 实例重复异步检查 */
let _speechAvailableCache = null;
let _speechCheckPromise = null;

async function getSpeechAvailable() {
    if (_speechAvailableCache !== null) return _speechAvailableCache;
    if (_speechCheckPromise) return _speechCheckPromise;
    _speechCheckPromise = (async () => {
        try {
            const kit = await bridgeProxy.getSpeechKit();
            _speechAvailableCache = await kit.available();
        } catch {
            _speechAvailableCache = false;
        }
        return _speechAvailableCache;
    })();
    return _speechCheckPromise;
}

function detectSystemSpeechLocale() {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

async function getConfiguredSpeechLocale() {
    try {
        const settingObj = await window.settingAPI?.loadSettingObject?.();
        const locale = settingObj?.locale;
        if (locale === 'zh-CN' || locale === 'en-US') {
            return locale;
        }
    } catch {
        /* fall back to system locale */
    }
    return detectSystemSpeechLocale();
}

const SKILL_PASTEL_COLORS = [
    { bg: '#EBF3FE', text: '#5B8DEF' },
    { bg: '#FEF1E6', text: '#E8935A' },
    { bg: '#E7F6EA', text: '#4CAF6E' },
    { bg: '#F2E8FD', text: '#9B6DD7' },
    { bg: '#FDE9E9', text: '#E06060' },
    { bg: '#E5F7F4', text: '#3DB49E' },
    { bg: '#FFF7E0', text: '#D4A028' },
    { bg: '#FBE5EE', text: '#D45D8A' }
];

function getSkillPastel(name) {
    let hash = 0;
    for (let i = 0; i < (name || '').length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    return SKILL_PASTEL_COLORS[Math.abs(hash) % SKILL_PASTEL_COLORS.length];
}

function getSkillInitial(name) {
    if (!name) return '⚡';
    const first = name.charAt(0).toUpperCase();
    return /[A-Z0-9\u4e00-\u9fff]/.test(first) ? first : '⚡';
}

/**
 * 更新系统设置中的 default_model 和指定模型的 reasoning_effort。
 * 只修改需要变更的字段，其余保持不变。
 */
async function updateSettingForModelChange(modelAlias, reasoningEffort, options = {}) {
    try {
        if (!window.settingAPI?.saveSettingObject || !window.settingAPI?.loadSettingObject) return;
        const settingObj = await window.settingAPI.loadSettingObject();
        let changed = false;
        if (options.updateDefaultModel !== false && modelAlias && settingObj.default_model !== modelAlias) {
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
        /** @type {{ dataUrl: string, name: string }[]} */
        this.attachedImages = [];
        this.isDisabled = false;
        /** 是否因为没有选择模型而禁用 */
        this.isModelNotSelected = false;
        /** 任务是否正在运行（用于消息队列提示） */
        this.isRunning = false;
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
        this.nodePanelOpen = false;
        /** @type {{ nodeId: string, displayName?: string, platform?: string, workspace?: string, commands: string[], shells: string[], defaultShell?: string }[]} */
        this.availableNodes = [];
        this.selectedExecutionNodeId = '';
        this.selectedExecutionNodeLabel = '';
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
        /** 触发补全时的光标像素位置（用于固定菜单位置） */
        this._autocompleteTriggerPosition = null;
        /** 是否使用 Ctrl+Enter 发送（false=Enter 发送） */
        this.ctrlEnterSend = false;
        /** 发送选项菜单是否打开 */
        this.sendMenuOpen = false;
        /** 关联的任务 ID，用于per-task模式管理 */
        this.taskId = null;
        this.speechSession = null;
        this.speechRecording = false;
        this._speechStopping = false;
        this._speechBaseText = '';
        this._speechPollTimer = null;
        this.speechAvailable = false;
        this._lastSpeechButtonPointerAt = 0;
        this._handleSpeechButtonPointerDown = this.handleSpeechButtonPointerDown.bind(this);
        this.searchMode = false;
    }

    disconnectedCallback() {
        this.stopSpeechPreviewPolling();
        this.speechSession?.release().catch(() => {});
        this.speechSession = null;
    }

    ensureInputExpanded() {
        this.querySelector('#agent-input-textarea')?.focus();
    }

    connectedCallback() {
        this.addEventListener('pointerdown', this._handleSpeechButtonPointerDown, true);
        // 先立即渲染基础 UI，避免等待异步数据加载导致长时间白屏
        this.render();
        // 后台异步加载数据，完成后重新渲染以更新下拉列表等内容
        Promise.all([
            this.loadSettings(),
            this.loadModes(),
            this.loadExecutionNodes(),
            this.loadSkills(),
            this.checkSpeechAvailable()
        ]).then(() => {
            if (this.isConnected) this.render();
        });

        window.modeAPI?.onTaskModeChanged?.((taskId, modeId) => {
            if (this.taskId && this.taskId === taskId && this.selectedModeId !== modeId) {
                this.selectedModeId = modeId;
                this._updateModeButton();
            }
        });

        // 监听设置变更（如模型列表修改），自动刷新模型下拉列表
        this._unsubSettingChanged = window.settingAPI?.onSettingChanged?.(async (newData) => {
            const newModels = newData.models || [];
            this.availableModels = newModels;
            this.defaultModelAlias = newData.default_model || '';
            this.isModelNotSelected = this.availableModels.length > 0 && !this.selectedModel;
            // 如果当前选中的模型已被删除，回退到默认模型
            if (this.selectedModel && !newModels.find((m) => m.alias === this.selectedModel)) {
                this.selectedModel = this.defaultModelAlias || (newModels[0]?.alias ?? '');
            }
            await this.loadModes();
            this.render();
        });

        this._unsubExecutionNodesChanged = window.nodeAPI?.onExecutionNodesChanged?.(() => {
            this.loadExecutionNodes().then(() => this.render());
        });
    }

    disconnectedCallback() {
        this._unsubSettingChanged?.();
        this._unsubExecutionNodesChanged?.();
    }

    async loadSettings() {
        try {
            if (!window.settingAPI?.loadSettingObject) return;
            const settingObj = await window.settingAPI.loadSettingObject();
            // 加载模型列表
            this.availableModels = settingObj.models || [];
            this.defaultModelAlias = settingObj.default_model || '';
            if (!this.selectedModel) {
                this.selectedModel = this.defaultModelAlias;
            }
            const currentModel = this.availableModels.find((m) => m.alias === this.selectedModel);
            if (currentModel && currentModel.reasoning_effort !== undefined && !this.selectedReasoningEffort) {
                this.selectedReasoningEffort = currentModel.reasoning_effort;
            }
            this.isModelNotSelected = this.availableModels.length > 0 && !this.selectedModel;
            // 加载 Ctrl+Enter 设置
            this.ctrlEnterSend = !!settingObj.gui_config?.ctrl_enter_send;
        } catch (err) {
            console.warn('Failed to load settings for agent-input:', err);
        }
    }

    async loadCtrlEnterSend() {
        // 保留以兼容外部调用，逻辑已合并到 loadSettings
        await this.loadSettings();
    }

    async checkSpeechAvailable() {
        this.speechAvailable = await getSpeechAvailable();
    }

    async saveCtrlEnterSend(value) {
        this.ctrlEnterSend = value;
        try {
            if (!window.settingAPI?.saveSettingObject || !window.settingAPI?.loadSettingObject) return;
            const settingObj = await window.settingAPI.loadSettingObject();
            if (!settingObj.gui_config) settingObj.gui_config = {};
            settingObj.gui_config.ctrl_enter_send = value;
            await window.settingAPI.saveSettingObject(settingObj);
        } catch (err) {
            console.warn('Failed to save ctrl_enter_send setting:', err);
        }
        this.updateSubmitTooltip();
        this.updatePlaceholder();
    }

    async loadModels() {
        // 保留以兼容外部调用，逻辑已合并到 loadSettings
        await this.loadSettings();
        if (this.isModelNotSelected) {
            this.updateInputState();
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

    async loadExecutionNodes() {
        try {
            if (!window.nodeAPI?.listExecutionNodes) return;
            const nodes = await window.nodeAPI.listExecutionNodes();
            this.availableNodes = Array.isArray(nodes) ? nodes : [];
            if (
                this.selectedExecutionNodeId &&
                !this.availableNodes.some((node) => node.nodeId === this.selectedExecutionNodeId)
            ) {
                this.selectedExecutionNodeId = '';
                this.selectedExecutionNodeLabel = '';
                this._updateNodeButton();
                if (this.taskId && window.nodeAPI?.setTaskExecutionNode) {
                    await window.nodeAPI.setTaskExecutionNode(this.taskId, null).catch((err) => {
                        console.warn('Failed to fall back to local execution:', err);
                    });
                }
                this.dispatchEvent(
                    new CustomEvent('execution-node-changed', {
                        detail: { nodeId: null },
                        bubbles: true
                    })
                );
            }
        } catch (err) {
            console.warn('Failed to load execution nodes:', err);
            this.availableNodes = [];
        }
    }

    async setExecutionNode(nodeId, label = '') {
        this.selectedExecutionNodeId = nodeId || '';
        const node = this.availableNodes.find((item) => item.nodeId === this.selectedExecutionNodeId);
        this.selectedExecutionNodeLabel = label || node?.displayName || node?.nodeId || '';
        if (this.taskId && window.nodeAPI?.setTaskExecutionNode) {
            await window.nodeAPI.setTaskExecutionNode(this.taskId, this.selectedExecutionNodeId || null);
        }
        this._updateNodeButton();
    }

    /**
     * 外部设置当前模式（同时通知主进程）
     */
    setMode(modeId) {
        this.selectedModeId = modeId;
        this.updateModeIndicator();
        if (this.taskId && window.modeAPI?.setTaskMode) {
            window.modeAPI.setTaskMode(this.taskId, modeId).catch((err) => {
                console.warn('Failed to set task mode:', err);
            });
        } else if (window.modeAPI?.setCurrentMode) {
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

    /**
     * 仅更新模式按钮文本，不全量重渲染。
     * 当主进程程序化切换模式（如 ExitPlanMode）时调用。
     */
    _updateModeButton() {
        const mode = this.availableModes.find((m) => m.id === this.selectedModeId);
        if (!mode) return;
        const modeBtnIcon = this.querySelector('#agent-input-mode-btn span:first-child');
        const modeBtnText = this.querySelector('#agent-input-mode-btn span:last-child');
        if (modeBtnIcon) modeBtnIcon.textContent = mode.icon;
        if (modeBtnText) modeBtnText.textContent = mode.name;
    }

    renderModeItem(mode) {
        const isActive = mode.id === this.selectedModeId ? 'active' : '';
        const checkMark =
            mode.id === this.selectedModeId
                ? '<div class="popup-panel-item-check"><i class="fas fa-check"></i></div>'
                : '';
        return `<button class="popup-panel-item mode-panel-item ${isActive}" data-mode-id="${escapeHtml(mode.id)}">
            <div class="popup-panel-item-icon mode-panel-item-icon">${escapeHtml(mode.icon)}</div>
            <div class="popup-panel-item-info">
                <div class="popup-panel-item-name">
                    ${escapeHtml(mode.name)}
                    <span class="popup-panel-item-id">(${escapeHtml(mode.id)})</span>
                </div>
                <div class="popup-panel-item-desc">${escapeHtml(mode.description || '')}</div>
            </div>
            ${checkMark}
        </button>`;
    }

    _updateNodeButton() {
        const nodeBtnText = this.querySelector('#agent-input-node-btn span');
        if (nodeBtnText) {
            nodeBtnText.textContent = this.selectedExecutionNodeLabel || 'Local';
        }
        this.renderNodeList();
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
        // 如果之前因为模型未选择而禁用，现在启用了输入
        if (this.isModelNotSelected && modelAlias) {
            this.isModelNotSelected = false;
            this.updateInputState();
        }
    }

    /**
     * 外部设置当前 reasoning effort（不写入系统设置，仅更新 UI 状态）
     */
    setReasoningEffort(effort) {
        this.selectedReasoningEffort = effort || '';
    }

    /**
     * 设置输入框文本内容
     * @param {string} text 文本内容
     */
    setText(text) {
        const textarea = this.querySelector('#agent-input-textarea');
        if (textarea) {
            textarea.value = text || '';
            this.updateSendButtonState();
        }
    }

    /**
     * 获取输入框焦点
     */
    focus() {
        const textarea = this.querySelector('#agent-input-textarea');
        if (textarea) {
            textarea.focus();
        }
    }

    disconnectedCallback() {
        this._unsubSettingChanged?.();
        this._unsubExecutionNodesChanged?.();
        this.removeEventListener('pointerdown', this._handleSpeechButtonPointerDown, true);
        this.stopSpeechPreviewPolling();
        this.speechSession?.release().catch(() => {});
        this.speechSession = null;
        if (this._toolbarResizeObserver) {
            this._toolbarResizeObserver.disconnect();
            this._toolbarResizeObserver = null;
        }
    }

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
        this.attachedImages = [];
        this.render();
    }

    addImage(dataUrl, name = '图片') {
        this.attachedImages.push({ dataUrl, name });
        this._renderImagePreviews();
        this.updateSendButtonState();
    }

    removeImage(index) {
        this.attachedImages.splice(index, 1);
        this._renderImagePreviews();
        this.updateSendButtonState();
    }

    _renderImagePreviews() {
        const container = this.querySelector('#agent-input-image-previews');
        if (!container) return;

        if (this.attachedImages.length === 0) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';
        container.innerHTML = this.attachedImages
            .map(
                (img, idx) => `
                <div class="agent-input-image-thumb" data-img-idx="${idx}">
                    <img src="${img.dataUrl}" alt="${img.name}" class="agent-input-image-thumb-img" />
                    <button class="agent-input-image-thumb-remove" data-img-idx="${idx}" title="删除图片">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `
            )
            .join('');

        container.querySelectorAll('.agent-input-image-thumb-img').forEach((imgEl) => {
            imgEl.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(imgEl.closest('.agent-input-image-thumb').dataset.imgIdx, 10);
                this._showImageLightbox(this.attachedImages[idx]?.dataUrl);
            });
        });
        container.querySelectorAll('.agent-input-image-thumb-remove').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeImage(parseInt(btn.dataset.imgIdx, 10));
            });
        });
    }

    _showImageLightbox(src) {
        showImageLightbox(src);
    }

    setDisabled(disabled) {
        this.isDisabled = disabled;
        this.isRunning = disabled && this.showStopButton;
        this.updateInputState();
    }

    setStopMode(showStop, onStopCallback = null) {
        this.showStopButton = showStop;
        this.onStopCallback = onStopCallback;
        this.isRunning = showStop;
        this.updateInputState();
    }

    setSearchMode(enabled) {
        this.searchMode = Boolean(enabled);
        this._clearAutocompleteState();
        this.render();
        this.querySelector('#agent-input-textarea')?.focus();
    }

    isSearchMode() {
        return this.searchMode;
    }

    getCurrentText() {
        return this.querySelector('#agent-input-textarea')?.value ?? '';
    }

    // Do not clear attachedFilePaths here; homepage search attach relies on search-mode exit preserving attachments.
    clearInput() {
        const textarea = this.querySelector('#agent-input-textarea');
        if (!textarea) return;
        textarea.value = '';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    _clearAutocompleteState() {
        if (this._fileCompleteTimer) {
            clearTimeout(this._fileCompleteTimer);
            this._fileCompleteTimer = null;
        }
        this.autocompleteItems = [];
        this.autocompleteSelectedIndex = 0;
        this.autocompleteOpen = false;
        this.autocompleteMode = null;
        this._autocompleteTriggerPosition = null;
    }

    updateInputState() {
        const textarea = this.querySelector('#agent-input-textarea');
        const stopBtn = this.querySelector('#agent-input-stop-btn');
        const queueHint = this.querySelector('#agent-input-queue-hint');

        if (textarea) {
            // 判断是否需要禁用：仅模型未选择时禁用，任务运行中允许输入
            const shouldDisable = this.isModelNotSelected;
            if (shouldDisable) {
                textarea.disabled = true;
                textarea.classList.add('opacity-50', 'cursor-not-allowed');
                textarea.placeholder = '请先选择模型才能开始对话';
            } else {
                textarea.disabled = false;
                textarea.classList.remove('opacity-50', 'cursor-not-allowed');
                this.updatePlaceholder();
            }
        }

        // 显示或隐藏队列提示
        if (queueHint) {
            queueHint.style.display = this.isRunning ? 'flex' : 'none';
        }

        // 任务运行中时发送和停止按钮同时显示，用户可以将消息加入队列
        const sendGroup = this.querySelector('.agent-send-group');
        if (sendGroup) {
            sendGroup.style.display = '';
        }

        const speechBtn = this.querySelector('#agent-input-speech-btn');
        if (speechBtn) {
            speechBtn.style.display = this.speechAvailable ? '' : 'none';
            speechBtn.disabled = this.isModelNotSelected && !this.speechRecording;
            speechBtn.classList.toggle('opacity-50', speechBtn.disabled);
            speechBtn.classList.toggle('cursor-not-allowed', speechBtn.disabled);
        }

        const recordingHint = this.querySelector('#agent-input-recording-hint');
        if (recordingHint) {
            recordingHint.style.display = this.speechRecording ? 'flex' : 'none';
        }
        const disclaimer = this.querySelector('#agent-input-disclaimer');
        if (disclaimer) {
            disclaimer.style.display = this.speechRecording ? 'none' : '';
        }

        const container = this.querySelector('#agent-input-container');
        if (container) {
            container.classList.toggle('agent-recording', this.speechRecording);
        }

        if (stopBtn) {
            stopBtn.style.display = this.showStopButton ? '' : 'none';
        }

        this.updateSendButtonState();
    }

    updatePlaceholder() {
        const textarea = this.querySelector('#agent-input-textarea');
        if (!textarea || this.isDisabled || this.isModelNotSelected) return;
        textarea.placeholder = this.searchMode
            ? '搜索文件、文档或关键词'
            : this.ctrlEnterSend
              ? '在这里输入消息，按 Ctrl+Enter 发送'
              : '在这里输入消息，按 Enter 发送';
    }

    updateSubmitTooltip() {
        const submitBtn = this.querySelector('#agent-input-submit-btn');
        if (submitBtn) {
            submitBtn.title = this.ctrlEnterSend ? '发送 (Ctrl+Enter)' : '发送 (Enter)';
        }
    }

    updateSendButtonState() {
        const textarea = this.querySelector('#agent-input-textarea');
        const submitBtn = this.querySelector('#agent-input-submit-btn');
        const sendMenuBtn = this.querySelector('#agent-input-send-menu-btn');
        if (!textarea || !submitBtn) return;

        const hasText = textarea.value.trim().length > 0;
        const hasImages = this.attachedImages.length > 0;
        const hasContent = hasText || hasImages;
        // 录音或搜索模式下发送按钮不可用；任务运行中仍允许排队。
        const active = hasContent && !this.isModelNotSelected && !this.speechRecording && !this.searchMode;
        for (const btn of [submitBtn, sendMenuBtn]) {
            if (!btn) continue;
            btn.disabled = this.searchMode || this.speechRecording;
            if (active) {
                btn.classList.add('agent-send-active');
                btn.classList.remove('agent-send-inactive');
            } else {
                btn.classList.remove('agent-send-active');
                btn.classList.add('agent-send-inactive');
            }
        }
    }

    render() {
        const prevTextarea = this.querySelector('#agent-input-textarea');
        const savedValue = prevTextarea ? prevTextarea.value : '';
        const savedSelStart = prevTextarea ? prevTextarea.selectionStart : 0;
        const savedSelEnd = prevTextarea ? prevTextarea.selectionEnd : 0;

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
            <div class="agent-input-file-hint">
                <i class="fas fa-paperclip"></i>
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

        const modeItems = this.availableModes.map((m) => this.renderModeItem(m)).join('');

        const nodeItems = [
            `<button class="popup-panel-item ${this.selectedExecutionNodeId ? '' : 'active'}" data-node-id="">
                <div class="popup-panel-item-icon"><i class="fas fa-laptop text-gray-500 text-xs"></i></div>
                <div class="popup-panel-item-info">
                    <div class="popup-panel-item-name">Local</div>
                    <div class="popup-panel-item-desc">本机执行</div>
                </div>
                ${this.selectedExecutionNodeId ? '' : '<div class="popup-panel-item-check"><i class="fas fa-check"></i></div>'}
            </button>`,
            ...this.availableNodes.map((node) => {
                const label = node.displayName || node.nodeId;
                const isActive = node.nodeId === this.selectedExecutionNodeId ? 'active' : '';
                const checkMark =
                    node.nodeId === this.selectedExecutionNodeId
                        ? '<div class="popup-panel-item-check"><i class="fas fa-check"></i></div>'
                        : '';
                const shells =
                    Array.isArray(node.shells) && node.shells.length > 0 ? node.shells.join(', ') : '无 shell 声明';
                const workspace = typeof node.workspace === 'string' && node.workspace ? `cwd: ${node.workspace}` : '';
                const desc = [node.platform || '未知平台', shells, workspace].filter(Boolean).join(' · ');
                return `<button class="popup-panel-item ${isActive}" data-node-id="${escapeHtml(node.nodeId)}" data-node-label="${escapeHtml(label)}">
                    <div class="popup-panel-item-icon"><i class="fas fa-network-wired text-emerald-500 text-xs"></i></div>
                    <div class="popup-panel-item-info">
                        <div class="popup-panel-item-name">${escapeHtml(label)}</div>
                        <div class="popup-panel-item-desc">${escapeHtml(desc)}</div>
                    </div>
                    ${checkMark}
                </button>`;
            })
        ].join('');

        const currentModelLabel = this.getModelButtonLabel();
        const currentMode = this.availableModes.find((m) => m.id === this.selectedModeId);
        const currentModeLabel = currentMode ? `${currentMode.name}` : '模式';
        const currentModeIcon = currentMode ? currentMode.icon : '';
        const currentNodeLabel = this.selectedExecutionNodeLabel || 'Local';

        this.innerHTML = `
        <div id="agent-input-container" class="w-full p-1 rounded-[24px] bg-white/40 border border-gray-300/60 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.07)]">
            <div class="bg-white rounded-[18px] shadow-sm border border-gray-100/40 overflow-hidden">
                <!-- 图片预览区域 -->
                <div id="agent-input-image-previews" class="agent-input-image-previews" style="display:${this.attachedImages.length > 0 ? 'flex' : 'none'};"></div>
                <!-- 任务运行时的队列提示 -->
                <div id="agent-input-queue-hint" class="agent-input-queue-hint" style="display: ${this.isRunning ? 'flex' : 'none'};">
                    <i class="fas fa-clock"></i>
                    <span class="agent-input-queue-hint-text">任务进行中，发送的消息将进入队列</span>
                </div>
                <!-- 主要输入区域 -->
                <div class="px-3.5 pt-2.5 pb-1">
                    <textarea
                        id="agent-input-textarea"
                        placeholder="${this.searchMode ? '搜索文件、文档或关键词' : this.ctrlEnterSend ? '在这里输入消息，按 Ctrl+Enter 发送' : '在这里输入消息，按 Enter 发送'}"
                        class="w-full h-14 resize-none border-none outline-none placeholder-gray-400 text-gray-700 text-[13px] leading-relaxed"
                    ></textarea>
                </div>

                <!-- 工具栏 -->
                <div class="agent-input-toolbar">
                    <!-- 左侧：模型 + 模式 + 技能 + 附件（按优先级从左到右，宽度不足时从右向左隐藏） -->
                    <div class="agent-input-toolbar-left">
                        ${
                            this.availableModels.length > 0
                                ? `
                        <div class="agent-input-toolbar-item" data-toolbar-priority="1">
                            <button id="agent-input-model-btn" class="agent-input-toolbar-control">
                                <i class="fas fa-robot"></i>
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
                        ${
                            this.availableModes.length > 1
                                ? `
                        <div class="agent-input-toolbar-item" data-toolbar-priority="2">
                            <button id="agent-input-mode-btn" class="agent-input-toolbar-control">
                                <span>${currentModeIcon}</span>
                                <span>${escapeHtml(currentModeLabel)}</span>
                            </button>
                            <div id="agent-input-mode-panel" class="popup-panel-hidden">
                                <div id="agent-input-mode-list" class="popup-panel-list">${modeItems}</div>
                            </div>
                        </div>
                        `
                                : ''
                        }
                        ${
                            this.availableNodes.length > 0
                                ? `
                        <div class="agent-input-toolbar-item" data-toolbar-priority="3">
                            <button id="agent-input-node-btn" class="agent-input-toolbar-control">
                                <i class="fas fa-network-wired"></i>
                                <span>${escapeHtml(currentNodeLabel)}</span>
                            </button>
                            <div id="agent-input-node-panel" class="popup-panel-hidden">
                                <div id="agent-input-node-list" class="popup-panel-list">${nodeItems}</div>
                            </div>
                        </div>
                        `
                                : ''
                        }
                        <div class="agent-input-toolbar-item" data-toolbar-priority="4">
                            <button id="agent-input-skill-btn" class="agent-input-toolbar-control">
                                <i class="fas fa-wand-magic-sparkles"></i>
                                <span>技能</span>
                            </button>
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
                        <button
                            id="agent-search-toggle"
                            class="agent-input-toolbar-control agent-search-toggle flex flex-none items-center justify-center gap-1 text-xs rounded-full px-2.5 py-0.5 outline-none transition-colors cursor-pointer whitespace-nowrap ${this.searchMode ? 'is-active text-blue-700 border border-blue-200' : 'text-gray-600'}"
                            title="切换文件搜索模式"
                            aria-pressed="${this.searchMode ? 'true' : 'false'}"
                        >
                            <i class="fa-solid fa-magnifying-glass text-[10px]"></i>
                            <span>搜索文件</span>
                        </button>
                        <div
                            id="agent-input-attached-file-list"
                            class="agent-input-toolbar-item"
                            data-toolbar-priority="5"
                            style="display: flex; flex-wrap: nowrap; align-items: center; gap: 4px; overflow: hidden;"
                        >
                            ${fileItems}
                        </div>
                    </div>

                    <div class="agent-input-toolbar-right">
                        <button
                            id="agent-input-speech-btn"
                            type="button"
                            class="agent-speech-btn-round"
                            title="语音输入（点击开始，再次点击结束）"
                        >
                            <i class="fas fa-microphone"></i>
                        </button>
                        <div class="agent-send-group">
                            <button id="agent-input-submit-btn" class="agent-send-btn agent-send-inactive"
                                ${this.searchMode ? 'disabled' : ''}
                                title="${this.ctrlEnterSend ? '发送 (Ctrl+Enter)' : '发送 (Enter)'}">
                                <i class="fas fa-arrow-up"></i>
                                <span>发送</span>
                            </button>
                            <div class="agent-send-divider"></div>
                            <button id="agent-input-send-menu-btn" class="agent-send-menu-btn agent-send-inactive"
                                ${this.searchMode ? 'disabled' : ''}
                                title="发送选项">
                                <i class="fas fa-ellipsis"></i>
                            </button>
                        </div>
                        <button id="agent-input-stop-btn" class="agent-stop-btn" style="display:none;">
                            <span class="agent-stop-icon"><i class="fas fa-stop"></i></span>
                            <span>停止</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
        <!-- 底部信息区：固定高度，录音提示和免责声明互斥显示，避免布局跳动 -->
        <div class="agent-input-footer">
            <div id="agent-input-recording-hint" class="agent-recording-hint" style="display:none;">
                <i class="fas fa-microphone-alt"></i>
                <span>正在录音，点击麦克风按钮可停止录制</span>
            </div>
            ${this.getAttribute('hide-disclaimer') !== null ? '' : '<p id="agent-input-disclaimer" class="agent-input-footer-text">内容由 AI 生成，请核实重要信息。</p>'}
        </div>
        <!-- 内联补全面板 -->
        <div id="agent-input-autocomplete" class="autocomplete-panel-hidden">
            <div id="agent-input-autocomplete-list" class="autocomplete-panel-list"></div>
        </div>
        `;

        this.setUpEventListeners();

        if (savedValue) {
            const newTextarea = this.querySelector('#agent-input-textarea');
            if (newTextarea) {
                newTextarea.value = savedValue;
                newTextarea.setSelectionRange(savedSelStart, savedSelEnd);
            }
        }

        this.updateInputState();
        this.updateModeIndicator();
        this._renderImagePreviews();
        this._initToolbarOverflow();
    }

    /**
     * 监听工具栏容器宽度变化，从右向左隐藏优先级低的工具项。
     * priority 数值越大越先隐藏。
     */
    _initToolbarOverflow() {
        if (this._toolbarResizeObserver) {
            this._toolbarResizeObserver.disconnect();
        }

        const toolbar = this.querySelector('.agent-input-toolbar-left');
        if (!toolbar) return;

        const items = Array.from(toolbar.querySelectorAll('.agent-input-toolbar-item'));
        if (items.length === 0) return;

        // 按 priority 降序排列（高优先级数值 = 最先隐藏）
        const sortedByHidePriority = [...items].sort(
            (a, b) => parseInt(b.dataset.toolbarPriority || '0', 10) - parseInt(a.dataset.toolbarPriority || '0', 10)
        );

        const rightButtons = this.querySelector('.agent-input-toolbar-right');
        const rightWidth = rightButtons ? rightButtons.offsetWidth : 120;

        const recalc = () => {
            const containerEl = toolbar.closest('.agent-input-toolbar');
            if (!containerEl) return;
            const availableWidth = containerEl.clientWidth - rightWidth - 24;

            // 先全部显示以测量真实宽度
            for (const item of items) {
                item.style.display = '';
            }

            let totalWidth = 0;
            for (const item of items) {
                totalWidth += item.offsetWidth + 6;
            }

            if (totalWidth <= availableWidth) return;

            // 从高 priority 开始隐藏
            for (const item of sortedByHidePriority) {
                if (totalWidth <= availableWidth) break;
                totalWidth -= item.offsetWidth + 6;
                item.style.display = 'none';
            }
        };

        recalc();

        this._toolbarResizeObserver = new ResizeObserver(() => {
            requestAnimationFrame(recalc);
        });
        const containerEl = toolbar.closest('.agent-input-toolbar');
        if (containerEl) {
            this._toolbarResizeObserver.observe(containerEl);
        }
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
        this.closeNodePanel(true);
        this.toggleSkillPanel(true);
        this.closeAutocompletePanel();
        this.closeSendMenu();
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

    closeModelPanel(_force = false) {
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
            this.renderModeList();
            panel.classList.remove('popup-panel-hidden');
            panel.classList.add('popup-panel-visible');
            this.modePanelOpen = true;
            const btn = this.querySelector('#agent-input-mode-btn');
            if (btn) this.positionPanel(btn, panel, 340, 340);
        }
    }

    closeModePanel(_force = false) {
        const panel = this.querySelector('#agent-input-mode-panel');
        if (!panel) return;
        panel.classList.remove('popup-panel-visible');
        panel.classList.add('popup-panel-hidden');
        this.modePanelOpen = false;
    }

    toggleNodePanel(forceClose = false) {
        const panel = this.querySelector('#agent-input-node-panel');
        if (!panel) return;
        if (forceClose || panel.classList.contains('popup-panel-visible')) {
            this.closeNodePanel(true);
        } else {
            this.closeAllPanels();
            this.renderNodeList();
            panel.classList.remove('popup-panel-hidden');
            panel.classList.add('popup-panel-visible');
            this.nodePanelOpen = true;
            const btn = this.querySelector('#agent-input-node-btn');
            if (btn) this.positionPanel(btn, panel, 260, 320);
        }
    }

    closeNodePanel(_force = false) {
        const panel = this.querySelector('#agent-input-node-panel');
        if (!panel) return;
        panel.classList.remove('popup-panel-visible');
        panel.classList.add('popup-panel-hidden');
        this.nodePanelOpen = false;
    }

    renderNodeList() {
        const listEl = this.querySelector('#agent-input-node-list');
        if (!listEl) return;
        const items = [
            `<button class="popup-panel-item ${this.selectedExecutionNodeId ? '' : 'active'}" data-node-id="">
                <div class="popup-panel-item-icon"><i class="fas fa-laptop text-gray-500 text-xs"></i></div>
                <div class="popup-panel-item-info">
                    <div class="popup-panel-item-name">Local</div>
                    <div class="popup-panel-item-desc">本机执行</div>
                </div>
                ${this.selectedExecutionNodeId ? '' : '<div class="popup-panel-item-check"><i class="fas fa-check"></i></div>'}
            </button>`,
            ...this.availableNodes.map((node) => {
                const label = node.displayName || node.nodeId;
                const isActive = node.nodeId === this.selectedExecutionNodeId ? 'active' : '';
                const checkMark =
                    node.nodeId === this.selectedExecutionNodeId
                        ? '<div class="popup-panel-item-check"><i class="fas fa-check"></i></div>'
                        : '';
                const shells =
                    Array.isArray(node.shells) && node.shells.length > 0 ? node.shells.join(', ') : '无 shell 声明';
                const workspace = typeof node.workspace === 'string' && node.workspace ? `cwd: ${node.workspace}` : '';
                const desc = [node.platform || '未知平台', shells, workspace].filter(Boolean).join(' · ');
                return `<button class="popup-panel-item ${isActive}" data-node-id="${escapeHtml(node.nodeId)}" data-node-label="${escapeHtml(label)}">
                    <div class="popup-panel-item-icon"><i class="fas fa-network-wired text-emerald-500 text-xs"></i></div>
                    <div class="popup-panel-item-info">
                        <div class="popup-panel-item-name">${escapeHtml(label)}</div>
                        <div class="popup-panel-item-desc">${escapeHtml(desc)}</div>
                    </div>
                    ${checkMark}
                </button>`;
            })
        ];
        listEl.innerHTML = items.join('');
        this.bindNodeItemEvents();
    }

    renderModeList() {
        const listEl = this.querySelector('#agent-input-mode-list');
        if (!listEl) return;
        listEl.innerHTML = this.availableModes.map((m) => this.renderModeItem(m)).join('');
        this.bindModeItemEvents();
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
                await updateSettingForModelChange(this.selectedModel, this.selectedReasoningEffort, {
                    updateDefaultModel: !this.taskId
                });
                this.closeModelPanel();
                this.hideEffortSubmenu();
                // 更新按钮文字
                const modelBtn = this.querySelector('#agent-input-model-btn span');
                if (modelBtn) modelBtn.textContent = this.getModelButtonLabel();
                // 如果之前因为模型未选择而禁用，现在启用了输入
                if (this.isModelNotSelected) {
                    this.isModelNotSelected = false;
                    this.updateInputState();
                }
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

    bindNodeItemEvents() {
        const items = this.querySelectorAll('#agent-input-node-list .popup-panel-item');
        items.forEach((item) => {
            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                const nodeId = item.dataset.nodeId || '';
                const label = item.dataset.nodeLabel || '';
                try {
                    await this.setExecutionNode(nodeId, label);
                    this.closeNodePanel();
                    this.dispatchEvent(
                        new CustomEvent('execution-node-changed', {
                            detail: { nodeId: this.selectedExecutionNodeId || null },
                            bubbles: true
                        })
                    );
                } catch (err) {
                    console.warn('Failed to set execution node:', err);
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
            this.closeNodePanel(true);
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
                .map((s) => {
                    const color = getSkillPastel(s.name);
                    const initial = getSkillInitial(s.name);
                    return `
                <button class="skill-panel-item" data-skill-name="${s.name}">
                    <div class="skill-panel-item-icon" style="background:${color.bg};color:${color.text};border-color:transparent;font-weight:700;font-size:14px;">
                        ${initial}
                    </div>
                    <div class="skill-panel-item-info">
                        <div class="skill-panel-item-name">${s.name}</div>
                        <div class="skill-panel-item-desc">${s.description}</div>
                    </div>
                </button>
            `;
                })
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

    handleInstallSkill() {
        // 关闭技能面板，跳转到技能中心让用户选择安装方式（市场或手动导入）
        this.toggleSkillPanel(true);
        window.globalControlAPI?.openApplication('skillmgr');
    }

    // ── 发送选项菜单 ────────────────────────────────────────

    showSendMenu() {
        this.closeSendMenu();
        const groupEl = this.querySelector('.agent-send-group');
        if (!groupEl) return;

        const menu = document.createElement('div');
        menu.id = 'agent-send-options-menu';
        menu.className = 'agent-send-options-panel';

        Object.assign(menu.style, {
            position: 'fixed',
            zIndex: '10002',
            animation: 'od-ctx-appear 0.12s ease-out'
        });

        const checked = this.ctrlEnterSend;
        menu.innerHTML = `
            <div class="agent-send-menu-item" data-action="toggle-ctrl-enter">
                <span class="agent-send-menu-item-label">按 Ctrl+Enter 发送</span>
                <label class="agent-send-toggle">
                    <input type="checkbox" ${checked ? 'checked' : ''}>
                    <span class="agent-send-toggle-slider"></span>
                </label>
            </div>
        `;

        document.body.appendChild(menu);

        // 定位：向下弹出，右对齐到按钮组
        const groupRect = groupEl.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        let top = groupRect.bottom + 6;
        let left = groupRect.right - menuRect.width;
        if (top + menuRect.height > window.innerHeight - 8) {
            top = groupRect.top - menuRect.height - 6;
        }
        if (left < 8) left = 8;
        menu.style.top = top + 'px';
        menu.style.left = left + 'px';

        this.sendMenuOpen = true;

        // 事件绑定 — 点击整行或直接点 checkbox 都切换
        const menuItem = menu.querySelector('[data-action="toggle-ctrl-enter"]');
        const checkbox = menu.querySelector('input[type="checkbox"]');
        if (menuItem && checkbox) {
            menuItem.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                checkbox.checked = !checkbox.checked;
                this.saveCtrlEnterSend(checkbox.checked);
            });
        }
    }

    closeSendMenu() {
        const existing = document.querySelector('#agent-send-options-menu');
        if (existing) existing.remove();
        this.sendMenuOpen = false;
    }

    // ── 内联补全面板 ────────────────────────────────────────

    /**
     * 获取 textarea 中光标的像素位置（相对于视口）
     * 用于定位补全面板跟随光标位置
     */
    getCaretCoordinates(textarea) {
        const value = textarea.value;
        const cursorPos = textarea.selectionStart;

        // 获取计算后的样式
        const computedStyle = window.getComputedStyle(textarea);

        // 创建镜像元素来测量光标位置
        const mirror = document.createElement('div');
        mirror.style.cssText = `
            position: absolute;
            visibility: hidden;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow: hidden;
            font-family: ${computedStyle.fontFamily};
            font-size: ${computedStyle.fontSize};
            line-height: ${computedStyle.lineHeight};
            padding: ${computedStyle.padding};
            border: ${computedStyle.border};
            box-sizing: ${computedStyle.boxSizing};
            width: ${textarea.clientWidth}px`;

        document.body.appendChild(mirror);

        // 将光标位置之前的文本放入镜像
        const textBeforeCursor = value.substring(0, cursorPos);
        mirror.textContent = textBeforeCursor;

        // 在光标位置放置一个标记元素
        const marker = document.createElement('span');
        marker.textContent = '|';
        mirror.appendChild(marker);

        // 获取标记元素的位置（在移除之前）
        const markerRect = marker.getBoundingClientRect();
        const mirrorRect = mirror.getBoundingClientRect();
        const textareaRect = textarea.getBoundingClientRect();

        // 清理镜像元素
        document.body.removeChild(mirror);

        // 计算光标相对于 textarea 的位置
        return {
            left: textareaRect.left + (markerRect.left - mirrorRect.left),
            top: textareaRect.top + (markerRect.top - mirrorRect.top),
            textareaRect: textareaRect
        };
    }

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
                // 如果是新触发（之前没有打开），记录光标位置
                if (!this.autocompleteOpen) {
                    this._autocompleteTriggerPosition = this.getCaretCoordinates(textarea);
                }
                this.autocompleteMode = 'skill';
                this.autocompleteItems = filtered.map((s) => {
                    const color = getSkillPastel(s.name);
                    const initial = getSkillInitial(s.name);
                    return {
                        value: s.name,
                        label: s.name,
                        description: s.description.slice(0, 80),
                        icon: null,
                        iconClass: 'skill-icon',
                        pastelBg: color.bg,
                        pastelText: color.text,
                        initial
                    };
                });
                this.autocompleteSelectedIndex = 0;
                this.showAutocompletePanel(textarea);
                return;
            }
        }

        // 检测 @ 文件补全
        const atMatch = this.extractAtQuery(textBefore);
        if (atMatch) {
            // 如果是新触发（之前没有打开），记录光标位置
            if (!this.autocompleteOpen) {
                this._autocompleteTriggerPosition = this.getCaretCoordinates(textarea);
            }
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
     * 支持两种模式：
     * 1. 路径浏览模式：输入包含 / 时，浏览指定目录
     * 2. 关键词搜索模式：输入只是关键词时，全局搜索匹配文件
     */
    async loadFileCompletions(query, textarea) {
        try {
            if (!this._workspacePath && window.workspaceAPI?.getEffectiveWorkspace) {
                this._workspacePath = await window.workspaceAPI.getEffectiveWorkspace();
            }
            if (!this._workspacePath) return;

            const normalizedQuery = query.replace(/\\/g, '/');
            const items = [];

            if (normalizedQuery.includes('/')) {
                // 路径浏览模式：列出目录内容并前缀匹配
                const lastSlash = normalizedQuery.lastIndexOf('/');
                const displayBase = normalizedQuery.slice(0, lastSlash + 1);
                const filter = normalizedQuery.slice(lastSlash + 1).toLowerCase();
                const expandedDir = displayBase.startsWith('/') ? displayBase : this._workspacePath + '/' + displayBase;

                let dirEntries = null;
                if (window.fsAPI?.listDirectory) {
                    try {
                        dirEntries = await window.fsAPI.listDirectory(expandedDir);
                    } catch {
                        // 目录不存在，回退到关键词搜索
                    }
                }

                if (dirEntries) {
                    for (const entry of dirEntries) {
                        if (entry.name.startsWith('.')) continue;
                        if (filter && !entry.name.toLowerCase().startsWith(filter)) continue;
                        const relativePath = displayBase + entry.name;
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
                } else {
                    // 目录不存在：回退到关键词搜索，用路径片段过滤
                    if (window.fsAPI?.searchFilesByKeywordInPath) {
                        const searchKeyword =
                            filter || displayBase.replace(/\/$/, '').split('/').pop() || normalizedQuery;
                        const results = await window.fsAPI.searchFilesByKeywordInPath(
                            searchKeyword,
                            this._workspacePath
                        );
                        for (const result of results) {
                            let relativePath = result.path;
                            if (relativePath.startsWith(this._workspacePath)) {
                                relativePath = relativePath.slice(this._workspacePath.length);
                                if (relativePath.startsWith('/')) relativePath = relativePath.slice(1);
                            }
                            if (!relativePath.toLowerCase().includes(normalizedQuery.toLowerCase())) continue;
                            const isDir = relativePath.endsWith('/');
                            const fileName = relativePath.split('/').pop() || relativePath;
                            items.push({
                                value: '@' + relativePath,
                                label: fileName + (isDir ? '/' : ''),
                                description: relativePath,
                                icon: isDir ? 'fa-folder' : 'fa-file',
                                iconClass: isDir ? 'dir-icon' : ''
                            });
                            if (items.length >= 20) break;
                        }
                    }
                }
            } else {
                // 关键词搜索模式：在工作空间范围内搜索文件名
                if (!window.fsAPI?.searchFilesByKeywordInPath) return;

                const keyword = normalizedQuery.toLowerCase();
                const results = await window.fsAPI.searchFilesByKeywordInPath(keyword, this._workspacePath);

                for (const result of results) {
                    // result.path 是绝对路径，转换为相对于工作区的路径
                    let relativePath = result.path;
                    if (relativePath.startsWith(this._workspacePath)) {
                        relativePath = relativePath.slice(this._workspacePath.length);
                        if (relativePath.startsWith('/')) relativePath = relativePath.slice(1);
                    }

                    const isDir = relativePath.endsWith('/');
                    const displayPath = isDir ? relativePath : relativePath;
                    const fileName = relativePath.split('/').pop() || relativePath;

                    items.push({
                        value: '@' + displayPath,
                        label: fileName + (isDir ? '/' : ''),
                        description: displayPath,
                        icon: isDir ? 'fa-folder' : 'fa-file',
                        iconClass: isDir ? 'dir-icon' : ''
                    });
                    if (items.length >= 20) break;
                }
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
            .map((item, idx) => {
                const iconContent = item.initial
                    ? `<div class="autocomplete-panel-item-icon ${item.iconClass || ''}" style="background:${item.pastelBg};color:${item.pastelText};font-weight:700;font-size:12px;">${item.initial}</div>`
                    : `<div class="autocomplete-panel-item-icon ${item.iconClass || ''}"><i class="fas ${item.icon}"></i></div>`;
                return `
            <button class="autocomplete-panel-item${idx === this.autocompleteSelectedIndex ? ' selected' : ''}" data-idx="${idx}">
                ${iconContent}
                <div class="autocomplete-panel-item-info">
                    <div class="autocomplete-panel-item-name">${item.label}</div>
                    ${item.description ? `<div class="autocomplete-panel-item-desc">${item.description}</div>` : ''}
                </div>
            </button>
        `;
            })
            .join('');

        panel.classList.remove('autocomplete-panel-hidden');
        panel.classList.add('autocomplete-panel-visible');
        this.autocompleteOpen = true;

        // 使用触发时记录的光标位置，如果没有则使用 textarea 位置作为后备
        const triggerPos = this._autocompleteTriggerPosition;
        const textareaRect = textarea.getBoundingClientRect();

        // 计算基准位置（光标位置或 textarea 左边界）
        const baseLeft = triggerPos ? triggerPos.left : textareaRect.left;
        const baseTop = triggerPos ? triggerPos.top : textareaRect.top;

        const panelHeight = Math.min(260, panel.scrollHeight);
        const spaceAbove = baseTop;
        const spaceBelow = window.innerHeight - baseTop;

        if (spaceAbove >= panelHeight + 8) {
            panel.style.top = baseTop - panelHeight - 4 + 'px';
        } else if (spaceBelow >= panelHeight + 8) {
            panel.style.top = baseTop + 20 + 'px'; // 光标高度约 20px
        } else if (spaceAbove >= spaceBelow) {
            const h = Math.max(100, spaceAbove - 12);
            panel.style.top = baseTop - h - 4 + 'px';
            panel.style.maxHeight = h + 'px';
        } else {
            const h = Math.max(100, spaceBelow - 32);
            panel.style.top = baseTop + 20 + 'px';
            panel.style.maxHeight = h + 'px';
        }

        // 水平位置：使用触发时的光标位置
        let left = baseLeft;
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
        this._autocompleteTriggerPosition = null;
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

        // Node 执行环境选择面板
        const nodeBtn = this.querySelector('#agent-input-node-btn');
        if (nodeBtn) {
            nodeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleNodePanel();
            });
        }
        this.bindNodeItemEvents();

        // 技能选择面板
        const skillBtn = this.querySelector('#agent-input-skill-btn');
        const skillSearch = this.querySelector('#agent-input-skill-search');
        const searchBtn = this.querySelector('#agent-search-toggle');

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
            skillInstallBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.handleInstallSkill();
            });
        }
        if (searchBtn) {
            searchBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.setSearchMode(!this.searchMode);
                this.dispatchEvent(
                    new CustomEvent('searchModeChanged', {
                        detail: { enabled: this.searchMode },
                        bubbles: true
                    })
                );
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
                // 关闭 node 面板
                if (this.nodePanelOpen) {
                    const panel = this.querySelector('#agent-input-node-panel');
                    const btn = this.querySelector('#agent-input-node-btn');
                    if (panel && !panel.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
                        this.closeNodePanel();
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
                // 关闭发送选项菜单
                if (this.sendMenuOpen) {
                    const sendMenu = document.querySelector('#agent-send-options-menu');
                    const sendMenuBtn = this.querySelector('#agent-input-send-menu-btn');
                    if (
                        sendMenu &&
                        !sendMenu.contains(e.target) &&
                        e.target !== sendMenuBtn &&
                        !sendMenuBtn?.contains(e.target)
                    ) {
                        this.closeSendMenu();
                    }
                }
            });
        }

        this.bindSkillItemEvents();

        // 提交消息的函数
        const handleSubmit = () => {
            // 模型未选择或搜索模式下禁止发送；任务运行中则允许加入队列。
            if (this.isModelNotSelected || this.searchMode) {
                return;
            }

            const message = textarea.value.trim();
            if (message === '' && this.attachedImages.length === 0) {
                return;
            }

            // 任务运行中时，消息进入队列
            if (this.isRunning && message) {
                const queueEvent = new CustomEvent('queue', {
                    detail: {
                        message: message,
                        attachedFilePaths: [...this.attachedFilePaths],
                        attachedImages: this.attachedImages.map((img) => img.dataUrl),
                        selectedModel: this.selectedModel || undefined,
                        reasoningEffort: this.selectedReasoningEffort || undefined,
                        selectedExecutionNodeId: this.selectedExecutionNodeId || null
                    },
                    bubbles: true
                });
                this.dispatchEvent(queueEvent);
                textarea.value = '';
                this.attachedFilePaths = [];
                this.attachedImages = [];
                this._renderImagePreviews();
                this.updateSendButtonState();
                textarea.focus();
                return;
            }

            // 正常发送
            const submitEvent = new CustomEvent('submit', {
                detail: {
                    message: message,
                    attachedFilePaths: this.attachedFilePaths,
                    attachedImages: this.attachedImages.map((img) => img.dataUrl),
                    selectedModel: this.selectedModel || undefined,
                    reasoningEffort: this.selectedReasoningEffort || undefined,
                    selectedExecutionNodeId: this.selectedExecutionNodeId || null
                },
                bubbles: true
            });
            this.dispatchEvent(submitEvent);

            textarea.value = '';
            this.clearAttachedFilePaths();
        };

        submitBtn.addEventListener('click', handleSubmit);

        const speechBtn = this.querySelector('#agent-input-speech-btn');
        if (speechBtn) {
            speechBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (performance.now() - this._lastSpeechButtonPointerAt < 350) {
                    return;
                }
                this.toggleSpeechInput(textarea, speechBtn, {
                    isBlocked: () => this.isModelNotSelected,
                    idlePlaceholder: this.ctrlEnterSend
                        ? '在这里输入消息，按 Ctrl+Enter 发送'
                        : '在这里输入消息，按 Enter 发送',
                    recordingPlaceholder: '正在聆听，识别文字将显示在输入框…'
                });
            });
        }

        // 发送选项菜单按钮
        const sendMenuBtn = this.querySelector('#agent-input-send-menu-btn');
        if (sendMenuBtn) {
            sendMenuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.sendMenuOpen) {
                    this.closeSendMenu();
                } else {
                    this.closeAllPanels();
                    this.showSendMenu();
                }
            });
        }

        // 停止按钮事件
        if (stopBtn) {
            stopBtn.addEventListener('click', () => {
                if (this.onStopCallback) {
                    this.onStopCallback();
                }
            });
        }

        removeFileBtns.forEach((btn) => {
            btn.addEventListener('click', (_e) => {
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
            const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
            for (const file of files) {
                if (file.type.startsWith('image/')) {
                    const reader = new FileReader();
                    reader.onload = () => {
                        this.addImage(reader.result, file.name || '拖放的图片');
                    };
                    reader.readAsDataURL(file);
                    continue;
                }

                const filePath = window.fsAPI.getFilePath(file);
                /* electron前端无法获取文件完整路径，需要通过fsAPI.getFilePath获取 */

                const ext = (filePath.split('.').pop() || '').toLowerCase();
                if (imageExts.includes(ext)) {
                    const reader = new FileReader();
                    reader.onload = () => {
                        this.addImage(reader.result, file.name || '拖放的图片');
                    };
                    reader.readAsDataURL(file);
                    continue;
                }

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

        // 键盘事件：补全导航 + Enter/Ctrl+Enter 发送
        textarea.addEventListener('keydown', (e) => {
            // 模型未选择时禁止所有输入
            if (this.isModelNotSelected) {
                e.preventDefault();
                return;
            }

            // 输入法组字过程中不处理
            if (e.isComposing || e.keyCode === 229) return;

            // 补全面板打开时优先处理键盘导航
            if (this.handleAutocompleteKeydown(e)) return;

            if (this.searchMode && e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                return;
            }

            if (this.ctrlEnterSend) {
                if (e.ctrlKey && e.key === 'Enter') {
                    e.preventDefault();
                    handleSubmit();
                }
            } else {
                if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit();
                }
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
            // 更新发送按钮状态
            this.updateSendButtonState();
        });

        textarea.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;

            // 检查是否有HTML内容（从富文本编辑器复制），转为Markdown保留格式
            let hasHtml = false;
            let htmlContent = '';
            for (const item of items) {
                if (item.type === 'text/html') {
                    hasHtml = true;
                    htmlContent = e.clipboardData.getData('text/html');
                    break;
                }
            }

            // 如果有图片，优先处理图片
            let hasImage = false;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    hasImage = true;
                    break;
                }
            }

            if (hasImage) {
                e.preventDefault();
                for (const item of items) {
                    if (item.type.startsWith('image/')) {
                        const file = item.getAsFile();
                        if (!file) continue;
                        const reader = new FileReader();
                        reader.onload = () => {
                            this.addImage(reader.result, file.name || '粘贴的图片');
                        };
                        reader.readAsDataURL(file);
                    }
                }
                return;
            }

            // 如果有HTML内容，转为Markdown保留格式（列表、编号等）
            if (hasHtml && htmlContent) {
                // 从 macOS 终端等复制的 HTML 中可能包含 <style> 标签（CSS 代码），
                // 先将其清除，防止 turndown 误将 CSS 代码当作正文输出。
                const cleanedHtml = htmlContent.replace(/<style[\s\S]*?<\/style>/gi, '');

                const rawMarkdown = this._htmlToMarkdown(cleanedHtml);
                const markdown = rawMarkdown ? rawMarkdown.trim() : '';
                if (markdown) {
                    e.preventDefault();
                    // 在光标位置插入Markdown文本
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    const before = textarea.value.substring(0, start);
                    const after = textarea.value.substring(end);
                    textarea.value = before + markdown + after;
                    textarea.selectionStart = textarea.selectionEnd = start + markdown.length;
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        });
    }

    /**
     * 将HTML内容转换为Markdown格式，使用 turndown 库
     */
    _htmlToMarkdown(html) {
        if (!this._turndownService) {
            this._turndownService = new TurndownService({
                headingStyle: 'atx',
                codeBlockStyle: 'fenced',
                bulletListMarker: '-'
            });
            // 支持 strikethrough
            this._turndownService.addRule('strikethrough', {
                filter: ['del', 's', 'strike'],
                replacement: (content) => '~~' + content + '~~'
            });
        }
        return this._turndownService.turndown(html);
    }

    handleSpeechButtonPointerDown(e) {
        const speechBtn = e.target?.closest?.('#agent-input-speech-btn');
        if (!speechBtn || !this.contains(speechBtn)) {
            return;
        }
        if (speechBtn.disabled && !this.speechRecording) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        this._lastSpeechButtonPointerAt = performance.now();
        const textarea = this.querySelector('#agent-input-textarea');
        this.toggleSpeechInput(textarea, speechBtn, {
            isBlocked: () => this.isModelNotSelected,
            idlePlaceholder: this.ctrlEnterSend
                ? '在这里输入消息，按 Ctrl+Enter 发送'
                : '在这里输入消息，按 Enter 发送',
            recordingPlaceholder: '正在聆听，识别文字将显示在输入框…'
        });
    }

    fillSpeechTextInInput(textarea, text, options = {}) {
        const trimmed = (text || '').trim();
        const base = (this._speechBaseText || '').trim();
        if (trimmed) {
            textarea.value = base ? `${base} ${trimmed}` : trimmed;
        } else if (!options.interim) {
            textarea.value = base;
        }
        textarea.classList.toggle('speech-interim', !!options.interim && !!trimmed);
        this.ensureInputExpanded();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        const len = textarea.value.length;
        textarea.setSelectionRange(len, len);
        this.updateSendButtonState();
    }

    _safeSpeechCleanup(textarea, speechBtn, idlePlaceholder) {
        // 每个操作独立 try-catch，确保一个失败不影响其他清理
        try {
            this.speechRecording = false;
        } catch {
            /* ignore */
        }
        try {
            this._speechStopping = false;
        } catch {
            /* ignore */
        }
        try {
            this.speechSession?.release().catch(() => {});
        } catch {
            /* ignore */
        }
        this.speechSession = null;
        try {
            speechBtn?.classList.remove('speech-recording');
        } catch {
            /* ignore */
        }
        try {
            speechBtn && (speechBtn.title = '语音输入（点击开始，再次点击结束）');
        } catch {
            /* ignore */
        }
        try {
            textarea.placeholder =
                idlePlaceholder ||
                (this.ctrlEnterSend ? '在这里输入消息，按 Ctrl+Enter 发送' : '在这里输入消息，按 Enter 发送');
        } catch {
            /* ignore */
        }
        try {
            textarea.classList.remove('speech-interim');
        } catch {
            /* ignore */
        }
        try {
            this.updateInputState();
        } catch {
            /* ignore */
        }
    }

    stopSpeechPreviewPolling() {
        if (this._speechPollTimer) {
            clearInterval(this._speechPollTimer);
            this._speechPollTimer = null;
        }
    }

    startSpeechPreviewPolling(textarea, speechBtn, options = {}) {
        this.stopSpeechPreviewPolling();
        this._speechPollTimer = setInterval(async () => {
            if (!this.speechRecording || !this.speechSession) {
                return;
            }
            try {
                const result = await this.speechSession.peek();
                if (result) {
                    if (result.content) {
                        this.fillSpeechTextInInput(textarea, result.content, { interim: true });
                    }
                    if (result.finished) {
                        // ASR 引擎判定用户已停止说话，自动结束录音
                        this.stopSpeechPreviewPolling();
                        try {
                            const finalText = await this.speechSession.stop();
                            if (finalText) {
                                this.fillSpeechTextInInput(textarea, finalText, { interim: false });
                            }
                        } catch (err) {
                            console.error('[speech] auto-stop failed:', err);
                        } finally {
                            this.stopSpeechPreviewPolling();
                            this._safeSpeechCleanup(textarea, speechBtn, options.idlePlaceholder);
                        }
                    }
                }
            } catch {
                /* ignore poll errors */
            }
        }, 200);
    }

    async toggleSpeechInput(textarea, speechBtn, options = {}) {
        const { isBlocked = () => false, idlePlaceholder = '', recordingPlaceholder = '' } = options;

        if (!textarea) {
            return;
        }

        // 如果已经在录制中，优先处理停止（不受 isBlocked 限制）
        if (this.speechRecording) {
            if (this._speechStopping) return;
            this._speechStopping = true;
            this.stopSpeechPreviewPolling();

            try {
                const text = await this.speechSession.stop();
                if (text) {
                    this.fillSpeechTextInInput(textarea, text, { interim: false });
                } else {
                    this.fillSpeechTextInInput(textarea, '', { interim: false });
                }
            } catch (err) {
                console.error('[speech] stop failed:', err);
            } finally {
                this.stopSpeechPreviewPolling();
                this._safeSpeechCleanup(textarea, speechBtn, idlePlaceholder);
            }
            return;
        }

        // 非录音状态，检查是否被阻止
        if (isBlocked()) {
            return;
        }

        // 开始录制
        try {
            const kit = await bridgeProxy.getSpeechKit();
            if (!(await kit.available())) {
                return;
            }
            await kit.initialize(await getConfiguredSpeechLocale());
            await kit.start();
            this.speechSession = kit;
            this.speechRecording = true;
            this._speechBaseText = textarea.value;
            speechBtn?.classList.add('speech-recording');
            speechBtn.title = '正在录音，点击停止';
            textarea.placeholder = recordingPlaceholder || '正在聆听，识别文字将显示在输入框…';
            textarea.classList.add('speech-interim');
            this.updateInputState();
            this.startSpeechPreviewPolling(textarea, speechBtn, options);
        } catch (err) {
            console.error('[speech] start failed:', err);
            this.speechSession?.release().catch(() => {});
            this.speechSession = null;
        }
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
        this.speechSession = null;
        this.speechRecording = false;
        this._speechStopping = false;
        this._speechBaseText = '';
        this._speechPollTimer = null;
    }

    disconnectedCallback() {
        this.stopSpeechPreviewPolling();
        this.speechSession?.release().catch(() => {});
        this.speechSession = null;
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
            // 任务运行时允许输入（不再禁用 textarea）
            // 用户可以在任务进行中输入消息，发送后进入队列
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
        @keyframes speech-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.45); }
            50% { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }
        }
        #application-agent-speech-btn.speech-recording {
            background: rgba(239, 68, 68, 0.85) !important;
            color: #fff !important;
            animation: speech-pulse 1.2s ease-in-out infinite;
        }
        #application-agent-input-textarea.speech-interim {
            color: #1f2937;
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
                    <button id="stop-task-button" class="flex-shrink-0 w-10 h-10 rounded-full text-white flex items-center justify-center transition-all shadow-lg hidden"
                        style="background: rgba(239,115,115,0.78);">
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

                        <!-- 语音输入 -->
                        <div class="flex items-center gap-2 pr-1">
                            <button
                                id="application-agent-speech-btn"
                                type="button"
                                title="语音输入（点击开始，再次点击结束）"
                                class="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-black/70 transition-colors"
                            >
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
        const speechBtn = this.querySelector('#application-agent-speech-btn');

        if (speechBtn) {
            speechBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleSpeechInput(textarea, speechBtn);
            });
        }

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

    /** 保持悬浮条展开，便于查看输入内容 */
    ensureInputExpanded() {
        const container = this.querySelector('#input-container');
        const content = this.querySelector('#input-content');
        container?.classList.add('expanded');
        content?.classList.add('expanded');
    }

    /**
     * 将识别文字写入输入框并展示
     * @param {HTMLInputElement} textarea
     * @param {string} text
     * @param {{ interim?: boolean }} [options]
     */
    fillSpeechTextInInput(textarea, text, options = {}) {
        const trimmed = (text || '').trim();
        const base = (this._speechBaseText || '').trim();
        if (trimmed) {
            textarea.value = base ? `${base} ${trimmed}` : trimmed;
        } else if (!options.interim) {
            textarea.value = base;
        }
        textarea.classList.toggle('speech-interim', !!options.interim && !!trimmed);
        this.ensureInputExpanded();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        const len = textarea.value.length;
        textarea.setSelectionRange(len, len);
    }

    stopSpeechPreviewPolling() {
        if (this._speechPollTimer) {
            clearInterval(this._speechPollTimer);
            this._speechPollTimer = null;
        }
    }

    /**
     * 录音过程中轮询中间结果，实时显示在输入框
     * @param {HTMLInputElement} textarea
     */
    startSpeechPreviewPolling(textarea) {
        this.stopSpeechPreviewPolling();
        this._speechPollTimer = setInterval(async () => {
            if (!this.speechRecording || !this.speechSession) {
                return;
            }
            try {
                const partial = await this.speechSession.peek();
                if (partial) {
                    this.fillSpeechTextInInput(textarea, partial, { interim: true });
                }
            } catch {
                /* ignore poll errors */
            }
        }, 200);
    }

    /**
     * 切换语音识别：首次点击开始，再次点击结束并填入输入框
     * @param {HTMLInputElement | null} textarea
     * @param {HTMLButtonElement | null} speechBtn
     */
    async toggleSpeechInput(textarea, speechBtn) {
        if (!textarea || this.taskStatus === 'running') {
            return;
        }

        if (!isSpeechInputAvailable()) {
            window.notificationAPI?.sendNotification?.(
                'warning',
                '语音输入',
                '当前环境不可用',
                '请确认已授予麦克风权限，或使用支持语音识别的浏览器。'
            );
            return;
        }

        if (!this.speechSession) {
            this.speechSession = createSpeechSession();
        }
        if (!this.speechSession) {
            return;
        }

        if (!this.speechRecording) {
            try {
                this._speechBaseText = textarea.value;
                this.ensureInputExpanded();
                await this.speechSession.start();
                this.speechRecording = true;
                speechBtn?.classList.add('speech-recording');
                speechBtn.title = '正在录音，点击结束';
                textarea.placeholder = '正在聆听，识别文字将显示在输入框…';
                textarea.classList.add('speech-interim');
                this.startSpeechPreviewPolling(textarea);
            } catch (err) {
                console.error('[speech] start failed:', err);
                window.notificationAPI?.sendNotification?.(
                    'error',
                    '语音输入',
                    '无法开始录音',
                    err?.message || String(err)
                );
            }
            return;
        }

        if (this._speechStopping) {
            return;
        }
        this._speechStopping = true;
        this.stopSpeechPreviewPolling();

        try {
            const text = await this.speechSession.stop();
            if (text) {
                this.fillSpeechTextInInput(textarea, text, { interim: false });
            } else {
                this.fillSpeechTextInInput(textarea, '', { interim: false });
                window.notificationAPI?.sendNotification?.('info', '语音输入', '未识别到内容', '请靠近麦克风重试。');
            }
        } catch (err) {
            console.error('[speech] stop failed:', err);
            window.notificationAPI?.sendNotification?.('error', '语音输入', '识别失败', err?.message || String(err));
        } finally {
            this._speechStopping = false;
            this.speechRecording = false;
            speechBtn?.classList.remove('speech-recording');
            speechBtn.title = '语音输入（点击开始，再次点击结束）';
            textarea.placeholder = '告诉我你想做什么…';
            textarea.classList.remove('speech-interim');
        }
    }
}

/**
 * 消息队列面板组件
 * 显示在 AgentInput 上方，仅在队列非空时显示
 * 每条消息有立即发送、编辑、删除三个操作按钮
 */
class MessageQueuePanel extends HTMLElement {
    constructor() {
        super();
        /** @type {Array<{id: string, message: string, attachedFilePaths: string[], attachedImages: string[], selectedModel?: string, reasoningEffort?: string}>} */
        this.queue = [];
        /** @type {Function | null} 立即发送回调 */
        this.onSendNow = null;
        /** @type {Function | null} 编辑回调 */
        this.onEdit = null;
        /** @type {Function | null} 删除回调 */
        this.onDelete = null;
    }

    connectedCallback() {
        this.render();
    }

    /**
     * 设置队列内容
     * @param {Array} queue 消息队列
     */
    setQueue(queue) {
        this.queue = queue || [];
        this.render();
    }

    /**
     * 设置操作回调
     * @param {Function} onSendNow 立即发送回调 (id)
     * @param {Function} onEdit 编辑回调 (item)
     * @param {Function} onDelete 删除回调 (id)
     */
    setCallbacks(onSendNow, onEdit, onDelete) {
        this.onSendNow = onSendNow;
        this.onEdit = onEdit;
        this.onDelete = onDelete;
    }

    render() {
        if (this.queue.length === 0) {
            this.style.display = 'none';
            this.innerHTML = '';
            return;
        }

        this.style.display = 'block';
        this.innerHTML = `
        <div class="message-queue-container">
            <div class="message-queue-header">
                <i class="fas fa-layer-group text-xs"></i>
                <span class="message-queue-title">消息队列 (${this.queue.length})</span>
            </div>
            <div class="message-queue-list">
                ${this.queue
                    .map(
                        (item, idx) => `
                    <div class="message-queue-item" data-queue-id="${item.id}" data-queue-index="${idx}">
                        <div class="message-queue-item-content">
                            <span class="message-queue-item-index">${idx + 1}</span>
                            <span class="message-queue-item-text">${this._truncateText(item.message, 60)}</span>
                        </div>
                        <div class="message-queue-item-actions">
                            <button class="message-queue-action-btn" data-action="send">
                                <i class="fas fa-paper-plane"></i>
                                <span class="action-label">立即发送</span>
                            </button>
                            <button class="message-queue-action-btn" data-action="edit">
                                <i class="fas fa-pen"></i>
                                <span class="action-label">编辑</span>
                            </button>
                            <button class="message-queue-action-btn" data-action="delete">
                                <i class="fas fa-trash"></i>
                                <span class="action-label">删除</span>
                            </button>
                        </div>
                    </div>
                `
                    )
                    .join('')}
            </div>
        </div>
        `;

        this._bindEvents();
    }

    _truncateText(text, maxLength) {
        if (!text) return '(空消息)';
        const escaped = escapeHtml(text);
        if (escaped.length <= maxLength) return escaped;
        return escaped.substring(0, maxLength) + '...';
    }

    _bindEvents() {
        const items = this.querySelectorAll('.message-queue-item');
        items.forEach((item) => {
            const id = item.dataset.queueId;
            const idx = parseInt(item.dataset.queueIndex, 10);
            const queueItem = this.queue[idx];

            item.querySelector('[data-action="send"]')?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.onSendNow) this.onSendNow(id);
            });

            item.querySelector('[data-action="edit"]')?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.onEdit) this.onEdit(queueItem);
            });

            item.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.onDelete) this.onDelete(id);
            });
        });
    }
}

customElements.define('message-queue-panel', MessageQueuePanel);
customElements.define('agent-input', AgentInput);
customElements.define('application-agent-input', ApplicationAgentInput);
