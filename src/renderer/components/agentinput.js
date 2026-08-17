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
import { ENTER_KEY_ICON_SVG, SHIFT_KEY_ICON_SVG, CTRL_KEY_ICON_SVG } from '../../common/utils/keys.ts';
import { showImageLightbox } from './imageLightbox.js';
import { showConfirmModal } from './confirmModal.ts';
import { escapeHtml } from '../../common/utils/escape.js';
import { NativeBridgeProxy } from '../../platforms/bridges/renderer.ts';
import { createRendererTranslator, resolveRendererLocale } from '../locale.ts';
import { getSlashCommands, filterSlashCommands, executeSlashCommand } from './slash-command.ts';

const fallbackSupportedFileExtensions = [
    'doc',
    'docx',
    'xls',
    'xlsx',
    'csv',
    'pptx',
    'odt',
    'odp',
    'ods',
    'pdf',
    'ofd',
    'rtf'
];
const bridgeProxy = new NativeBridgeProxy();

function getFileName(filePath) {
    return (
        String(filePath || '')
            .split(/[\\/]/)
            .pop() || ''
    );
}

function getFileExtension(filePath) {
    const fileName = getFileName(filePath);
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex < 0 || dotIndex === fileName.length - 1) {
        return '';
    }
    return fileName.slice(dotIndex + 1).toLowerCase();
}

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
    return resolveRendererLocale();
}

async function getConfiguredSpeechLocale() {
    try {
        const settingObj = await window.settingAPI?.loadSettingObject?.();
        return resolveRendererLocale(settingObj);
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
        if (options.updateReasoningEffort !== false && modelAlias && reasoningEffort !== undefined) {
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

function isChatModel(model) {
    return model?.model_type !== 'embedding';
}

function filterChatModels(models) {
    return (models || []).filter(isChatModel);
}

// --- SVG icon tiles for toolbar (scheme E: soft-colored tiles) ---

const MODE_SVG = {
    standard: '<path d="M9 2 4 9h3.5l-1 5L12 7H8.5l.5-5Z"/>',
    readonly: '<rect x="3.5" y="7" width="9" height="6" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
    plan: '<path d="M5 2.5h6v2H5z"/><path d="M4 4.5h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z"/><path d="M5.5 8h5M5.5 10.5h3"/>',
    solo: '<path d="M4.5 5a2 2 0 0 0-2 2v2.5a2 2 0 0 0 2 2c.7 0 1.2-.3 1.4-.9l.2-.6h3.8l.2.6c.2.6.7.9 1.4.9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-7Z"/><path d="M6 8.5h2M7 7.5v2"/><circle cx="10" cy="7.5" r=".7" fill="currentColor" stroke="none"/><circle cx="10" cy="9.5" r=".7" fill="currentColor" stroke="none"/>',
    unlimited:
        '<path d="M4.5 5C2.5 5 1.5 6.3 1.5 8s1 3 3 3c2.5 0 3.5-3 3.5-3s1-3 3.5-3c2 0 3 1.3 3 3s-1 3-3 3c-2.5 0-3.5-3-3.5-3S7 5 4.5 5Z"/>'
};

function getModeIconTile(modeId) {
    const svgPath = MODE_SVG[modeId];
    if (!svgPath) return '';
    return `<span class="agent-icon-tile mode-${modeId}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${svgPath}</svg></span>`;
}

function getModelIconTile(hasVision) {
    const cls = hasVision ? 'model-vision' : 'model-chat';
    const svgPath = hasVision
        ? '<path d="M1.5 8S3.5 4.5 8 4.5s6.5 3.5 6.5 3.5-2 3.5-6.5 3.5S1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>'
        : '<path d="M3 5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6l-3 2.5V5Z"/>';
    return `<span class="agent-icon-tile ${cls}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${svgPath}</svg></span>`;
}

const SKILL_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/></svg>';

// --- Reasoning effort SVG icons (scheme 1: energy bars, 4 cells) ---
// 四格能量条：none=全灰+斜线、low=1 格、medium=2 格、high=3 格、max=4 格，
// 默认('')=4 格淡色。

const EFFORT_BAR_X = [1.125, 4.875, 8.625, 12.375];
const EFFORT_BAR_GREEN = '#1F9D66';
const EFFORT_BAR_GREY = '#E7E5E2';

function effortBarRects(filledCount) {
    return EFFORT_BAR_X.map(
        (x, i) =>
            `<rect x="${x}" y="2.5" width="2.5" height="11" rx=".5" fill="${i < filledCount ? EFFORT_BAR_GREEN : EFFORT_BAR_GREY}"/>`
    ).join('');
}

const EFFORT_BAR_SVG = {
    '': EFFORT_BAR_X.map(
        (x) => `<rect x="${x}" y="2.5" width="2.5" height="11" rx=".5" fill="${EFFORT_BAR_GREEN}" opacity=".35"/>`
    ).join(''),
    none:
        effortBarRects(0) + '<path d="M1.5 13.5 14.5 2.5" stroke="#8A8580" stroke-width="1.4" stroke-linecap="round"/>',
    low: effortBarRects(1),
    medium: effortBarRects(2),
    high: effortBarRects(3),
    max: effortBarRects(4)
};

function getEffortIconSVG(effortValue) {
    const paths = EFFORT_BAR_SVG[effortValue] || EFFORT_BAR_SVG[''];
    return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">${paths}</svg>`;
}

/** 主页 AgentInput 草稿文本，在组件销毁/重建之间持久化 */
let _homeDraftText = '';

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
        this.runningInputMode = 'queue';
        this.showStopButton = false;
        this.onStopCallback = null;
        this.slashCommandExecuting = false;
        /** @type {{ alias: string, model_name: string }[]} */
        this.availableModels = [];
        /** @type {Record<string, boolean>} alias → 是否支持视觉 */
        this.visionMap = {};
        /** @type {Record<string, string[]>} alias → 支持的推理档位（存储值列表，含 '' 默认项） */
        this.modelEffortsMap = {};
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
        this.supportedFileExtensions = [...fallbackSupportedFileExtensions];
        this.knownUnsupportedFileExtensions = [];
        this._attachmentSupportPromise = null;
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
        this._t = createRendererTranslator();
    }

    ensureInputExpanded() {
        this.querySelector('#agent-input-textarea')?.focus();
    }

    connectedCallback() {
        this.addEventListener('pointerdown', this._handleSpeechButtonPointerDown, true);
        // 先立即渲染基础 UI，避免等待异步数据加载导致长时间白屏
        this.render();
        // 后台异步加载数据，完成后重新渲染以更新下拉列表等内容。
        // 注意：推理档位映射（loadReasoningEffortSupport）不在此并发列表里，
        // 它依赖 availableModels 已就绪，必须在 loadSettings 完成模型列表后加载，
        // 否则会在模型列表尚未填充时提前退出，导致启动后菜单显示全部档位。
        Promise.all([
            this.loadSettings(),
            this.loadModes(),
            this.loadExecutionNodes(),
            this.loadSkills(),
            this.loadAttachmentFileSupport(),
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
            this._t = createRendererTranslator(newData);
            // 发送快捷键设置变化时实时同步 placeholder 与提交按钮提示
            this.applySendShortcutSetting(newData);
            const newModels = filterChatModels(newData.models);
            this.availableModels = newModels;
            this.defaultModelAlias = newModels.some((m) => m.alias === newData.default_model)
                ? newData.default_model
                : '';
            // 如果当前选中的模型已被删除，回退到默认模型
            if (this.selectedModel && !newModels.find((m) => m.alias === this.selectedModel)) {
                this.selectedModel = this.defaultModelAlias;
            }
            this.isModelNotSelected = this.availableModels.length > 0 && !this.selectedModel;
            await this.loadModes();
            await this.loadVisionSupport();
            await this.loadReasoningEffortSupport();
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
            this._t = createRendererTranslator(settingObj);
            // 加载模型列表
            this.availableModels = filterChatModels(settingObj.models);
            this.defaultModelAlias = this.availableModels.some((m) => m.alias === settingObj.default_model)
                ? settingObj.default_model
                : '';
            if (!this.selectedModel) {
                this.selectedModel = this.defaultModelAlias;
            } else if (!this.availableModels.find((m) => m.alias === this.selectedModel)) {
                this.selectedModel = this.defaultModelAlias;
            }
            const currentModel = this.availableModels.find((m) => m.alias === this.selectedModel);
            if (currentModel && currentModel.reasoning_effort !== undefined && !this.selectedReasoningEffort) {
                this.selectedReasoningEffort = currentModel.reasoning_effort;
            }
            this.isModelNotSelected = this.availableModels.length > 0 && !this.selectedModel;
            // 加载 Ctrl+Enter 设置
            this.ctrlEnterSend = !!settingObj.gui_config?.ctrl_enter_send;
            // 加载视觉能力映射
            await this.loadVisionSupport();
            // 模型列表已就绪后再加载各模型支持的推理档位（修复：并发加载时
            // 模型列表未填充会导致该映射为空，推理档位菜单显示全部选项）
            await this.loadReasoningEffortSupport();
        } catch (err) {
            console.warn('Failed to load settings for agent-input:', err);
        }
    }

    async loadVisionSupport() {
        if (!this.availableModels.length || !window.settingAPI?.checkVisionSupport) return;
        try {
            this.visionMap = await window.settingAPI.checkVisionSupport(this.availableModels);
        } catch {
            this.visionMap = {};
        }
    }

    /**
     * 加载每个模型支持的推理档位（alias → 存储值列表，含 '' 默认项）。
     * 查不到时保持为空，由消费方回退到系统全部档位。
     */
    async loadReasoningEffortSupport() {
        if (!this.availableModels.length || !window.settingAPI?.checkReasoningEfforts) return;
        try {
            this.modelEffortsMap = await window.settingAPI.checkReasoningEfforts(this.availableModels);
        } catch {
            this.modelEffortsMap = {};
        }
    }

    /**
     * 获取指定模型的可用推理档位值列表（含 '' 默认项）。
     * model-context 未匹配到时回退到系统全部档位。
     */
    getSupportedEffortValues(modelAlias) {
        const model = this.availableModels.find((m) => m.alias === modelAlias);
        if (!model) return REASONING_EFFORT_OPTIONS.map((o) => o.value);
        const supported = this.modelEffortsMap[modelAlias];
        if (Array.isArray(supported) && supported.length > 0) {
            return supported;
        }
        // 回退：系统全部档位
        return REASONING_EFFORT_OPTIONS.map((o) => o.value);
    }

    async loadCtrlEnterSend() {
        // 保留以兼容外部调用，逻辑已合并到 loadSettings
        await this.loadSettings();
    }

    async checkSpeechAvailable() {
        this.speechAvailable = await getSpeechAvailable();
    }

    async loadAttachmentFileSupport() {
        if (this._attachmentSupportPromise) {
            return this._attachmentSupportPromise;
        }
        this._attachmentSupportPromise = (async () => {
            try {
                const support = await window.taskManagerAPI?.getAttachmentFileSupport?.();
                if (Array.isArray(support?.supportedExtensions) && support.supportedExtensions.length > 0) {
                    this.supportedFileExtensions = support.supportedExtensions
                        .map((ext) =>
                            String(ext || '')
                                .replace(/^\./, '')
                                .toLowerCase()
                        )
                        .filter(Boolean);
                }
                if (Array.isArray(support?.knownUnsupportedExtensions)) {
                    this.knownUnsupportedFileExtensions = support.knownUnsupportedExtensions
                        .map((ext) =>
                            String(ext || '')
                                .replace(/^\./, '')
                                .toLowerCase()
                        )
                        .filter(Boolean);
                }
            } catch (err) {
                console.warn('Failed to load attachment file support:', err);
            }
            if (this.supportedFileExtensions.length === 0) {
                this.supportedFileExtensions = [...fallbackSupportedFileExtensions];
            }
            return this.supportedFileExtensions;
        })();
        return this._attachmentSupportPromise;
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

    /**
     * 应用设置变更中的发送快捷键配置（设置面板切换时实时同步已有组件）。
     * @param {object} newData 设置对象
     */
    applySendShortcutSetting(newData) {
        const newCtrlEnterSend = !!newData?.gui_config?.ctrl_enter_send;
        if (this.ctrlEnterSend === newCtrlEnterSend) return;
        this.ctrlEnterSend = newCtrlEnterSend;
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
            // 如果没有 taskId（新建任务界面），加载全局默认执行节点
            if (!this.taskId && !this.selectedExecutionNodeId && window.nodeAPI?.getDefaultExecutionNode) {
                try {
                    const defaultNode = await window.nodeAPI.getDefaultExecutionNode();
                    if (defaultNode?.nodeId && this.availableNodes.some((n) => n.nodeId === defaultNode.nodeId)) {
                        this.selectedExecutionNodeId = defaultNode.nodeId;
                        this.selectedExecutionNodeLabel = defaultNode.label || '';
                    }
                } catch {
                    // 静默失败，不影响节点列表加载
                }
            }
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
        // 如果有 taskId（任务内），设置任务级执行节点
        // 如果没有 taskId（新建任务界面），设置全局默认执行节点
        if (this.taskId && window.nodeAPI?.setTaskExecutionNode) {
            await window.nodeAPI.setTaskExecutionNode(this.taskId, this.selectedExecutionNodeId || null);
        } else if (!this.taskId && window.nodeAPI?.setDefaultExecutionNode) {
            await window.nodeAPI.setDefaultExecutionNode(
                this.selectedExecutionNodeId || null,
                this.selectedExecutionNodeLabel
            );
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
        const modeBtnIcon = this.querySelector('#agent-input-mode-btn > span:first-child');
        const modeBtnText = this.querySelector('#agent-input-mode-btn > span:last-child');
        if (modeBtnIcon) modeBtnIcon.innerHTML = getModeIconTile(mode.id);
        if (modeBtnText) modeBtnText.textContent = mode.name;
    }

    renderModeItem(mode) {
        const isActive = mode.id === this.selectedModeId ? 'active' : '';
        const checkMark =
            mode.id === this.selectedModeId ? '<span class="ctx-item-check"><i class="fas fa-check"></i></span>' : '';
        // Hide the ID annotation when the display name already matches the ID (e.g. English "Standard" vs id "standard")
        const idAnnotation =
            mode.name.toLowerCase() === mode.id.toLowerCase()
                ? ''
                : `<span class="ctx-item-id">(${escapeHtml(mode.id)})</span>`;
        return `<button class="ctx-item-block mode-panel-item ${isActive}" data-mode-id="${escapeHtml(mode.id)}">
            <span class="ctx-icon-xl">${getModeIconTile(mode.id)}</span>
            <span class="ctx-block-body">
                <span class="ctx-block-label">
                    ${escapeHtml(mode.name)}
                    ${idAnnotation}
                </span>
                <span class="ctx-block-desc">${escapeHtml(mode.description || '')}</span>
            </span>
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
        if (
            modelAlias &&
            this.availableModels.length > 0 &&
            !this.availableModels.find((m) => m.alias === modelAlias)
        ) {
            this.selectedModel = this.defaultModelAlias || '';
        } else {
            this.selectedModel = modelAlias || this.defaultModelAlias || '';
        }
        // 同步更新按钮 DOM，避免按钮文字与下拉菜单选中态不一致
        this._updateModelButton();
        // 如果之前因为模型未选择而禁用，现在启用了输入
        if (this.isModelNotSelected && this.selectedModel) {
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
        if (!this.taskId) {
            _homeDraftText = this.getCurrentText();
        }
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

    async attachFilePath(filePath) {
        return this.attachFilePaths([filePath]);
    }

    async attachFilePaths(filePaths) {
        const uniquePaths = [...new Set((filePaths || []).filter(Boolean))];
        if (uniquePaths.length === 0) {
            return true;
        }
        const unsupported = await this.getUnsupportedFilePaths(uniquePaths);
        const supportedPaths = uniquePaths.filter((p) => !unsupported.includes(p));
        let changed = false;
        for (const filePath of supportedPaths) {
            if (!this.attachedFilePaths.includes(filePath)) {
                this.attachedFilePaths.push(filePath);
                changed = true;
            }
        }
        const cursorPos = this.querySelector('#agent-input-textarea')?.selectionStart;
        if (changed) {
            this.render();
        }
        if (unsupported.length > 0) {
            this.pasteFilePathsToTextarea(unsupported, cursorPos);
        }
        return supportedPaths.length > 0;
    }

    pasteFilePathsToTextarea(filePaths, cursorPos) {
        const textarea = this.querySelector('#agent-input-textarea');
        if (!textarea) return;
        if (cursorPos === undefined) {
            cursorPos = textarea.selectionStart;
        }
        const pathsText = filePaths.map((p) => ` ${p} `).join('');
        const textBefore = textarea.value.substring(0, cursorPos);
        const textAfter = textarea.value.substring(cursorPos);
        textarea.value = textBefore + pathsText + textAfter;
        const newPos = cursorPos + pathsText.length;
        textarea.setSelectionRange(newPos, newPos);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
    }

    async getUnsupportedFilePaths(filePaths) {
        await this.loadAttachmentFileSupport();
        const supported = new Set(this.supportedFileExtensions);
        return (filePaths || []).filter((filePath) => !supported.has(getFileExtension(filePath)));
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

    setRunningInputMode(mode) {
        this.runningInputMode = mode === 'goal_supplement' ? 'goal_supplement' : 'queue';
        this.updateInputState();
    }

    /**
     * 设置 slash command 执行所需的上下文
     * @param {object} ctx
     * @param {object} ctx.globalControlAPI
     * @param {object} ctx.taskManagerAPI
     * @param {string|null} ctx.currentTaskId
     * @param {Function|null} ctx.clearMessageQueue
     */
    setSlashCommandContext(ctx) {
        this._slashCommandContext = ctx || {};
    }

    /**
     * 执行 slash command
     */
    async _executeSlashCommand(name, args = '') {
        if (this.slashCommandExecuting) return;
        this.slashCommandExecuting = true;
        const ctx = this._slashCommandContext || {};
        const textarea = this.querySelector('#agent-input-textarea');
        const inputValueBeforeExecution = textarea?.value;
        let outcome;
        try {
            outcome = await executeSlashCommand(
                name,
                {
                    globalControlAPI: ctx.globalControlAPI || window.globalControlAPI,
                    taskManagerAPI: ctx.taskManagerAPI || window.taskManagerAPI,
                    currentTaskId: ctx.currentTaskId ?? null,
                    stopCallback: this.onStopCallback || null,
                    clearMessageQueue: ctx.clearMessageQueue || null
                },
                args
            );
        } catch (error) {
            console.error('Failed to execute slash command:', error);
            outcome = { inputDisposition: 'preserve' };
        } finally {
            this.slashCommandExecuting = false;
        }
        if (!textarea) return;
        if (
            outcome?.inputDisposition !== 'preserve' &&
            (inputValueBeforeExecution === undefined || textarea.value === inputValueBeforeExecution)
        ) {
            textarea.value = '';
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        textarea.focus();
    }

    setSearchMode(enabled) {
        const nextSearchMode = Boolean(enabled);
        if (this.searchMode === nextSearchMode) return;
        this.searchMode = nextSearchMode;
        this.closeAutocompletePanel();
        this._clearAutocompleteState();
        this._updateSearchModeUI();
        this.updateInputState();
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

    _updateSearchModeUI() {
        const searchBtn = this.querySelector('#agent-search-toggle');
        if (!searchBtn) return;
        searchBtn.classList.toggle('is-active', this.searchMode);
        searchBtn.setAttribute('aria-pressed', this.searchMode ? 'true' : 'false');
    }

    updateInputState() {
        const textarea = this.querySelector('#agent-input-textarea');
        const stopBtn = this.querySelector('#agent-input-stop-btn');
        const queueHint = this.querySelector('#agent-input-queue-hint');

        if (textarea) {
            // 判断是否需要禁用：仅对话输入依赖对话模型，文件搜索不依赖。
            const shouldDisable = this.isModelNotSelected && !this.searchMode;
            const overlay = this.querySelector('#agent-input-placeholder');
            if (shouldDisable) {
                textarea.disabled = true;
                textarea.classList.add('opacity-50', 'cursor-not-allowed');
                const requiredText = this.t('renderer.agentInput.modelRequired');
                textarea.placeholder = requiredText;
                if (overlay) {
                    overlay.textContent = requiredText;
                    overlay.classList.add('is-muted');
                }
            } else {
                textarea.disabled = false;
                textarea.classList.remove('opacity-50', 'cursor-not-allowed');
                overlay?.classList.remove('is-muted');
                this.updatePlaceholder();
            }
        }

        // 显示或隐藏队列提示
        if (queueHint) {
            queueHint.style.display = this.isRunning && this.runningInputMode === 'queue' ? 'flex' : 'none';
        }

        // 任务运行中时发送和停止按钮同时显示，用户可以将消息加入队列
        const sendGroup = this.querySelector('.agent-send-group');
        if (sendGroup) {
            sendGroup.style.display = '';
        }

        const speechBtn = this.querySelector('#agent-input-speech-btn');
        if (speechBtn) {
            speechBtn.style.display = this.speechAvailable ? '' : 'none';
            speechBtn.disabled = this.isModelNotSelected && !this.searchMode && !this.speechRecording;
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
        const overlay = this.querySelector('#agent-input-placeholder');
        if (!textarea || this.isDisabled || (this.isModelNotSelected && !this.searchMode)) return;
        const text = this.getInputPlaceholder();
        textarea.placeholder = text;
        if (overlay) overlay.innerHTML = this.buildPlaceholderHTML();
    }

    /**
     * 生成富文本 placeholder：对话输入在「{iconEnter}」「{iconShift}」占位处插入对应键图标，
     * 其余场景（搜索/禁用/录音等）回退为纯文本。
     * @returns {string}
     */
    buildPlaceholderHTML() {
        const tpl = this._placeholderTemplate();
        if (this.searchMode) return escapeHtml(tpl);
        // 先整体转义模板文本，再替换键名占位符为对应图标 HTML
        return escapeHtml(tpl)
            .replaceAll('{iconEnter}', `<span class="agent-input-ph-key">${ENTER_KEY_ICON_SVG}</span>`)
            .replaceAll('{iconShift}', `<span class="agent-input-ph-key">${SHIFT_KEY_ICON_SVG}</span>`)
            .replaceAll('{iconCtrl}', `<span class="agent-input-ph-key">${CTRL_KEY_ICON_SVG}</span>`);
    }

    t(key, params) {
        return this._t?.(key, params) ?? key;
    }

    getInputPlaceholder() {
        return this._placeholderTemplate()
            .replaceAll('{iconEnter}', '')
            .replaceAll('{iconShift}', '')
            .replaceAll('{iconCtrl}', '');
    }

    _placeholderTemplate() {
        if (this.searchMode) {
            return this.t('renderer.agentInput.placeholder.search');
        }
        return this.ctrlEnterSend
            ? this.t('renderer.agentInput.placeholder.ctrlEnter')
            : this.t('renderer.agentInput.placeholder.enter');
    }

    getSubmitTitle() {
        return this.ctrlEnterSend
            ? this.t('renderer.agentInput.submit.ctrlEnterTitle')
            : this.t('renderer.agentInput.submit.enterTitle');
    }

    getSubmitLabel() {
        return this.t('renderer.agentInput.submit.sendLabel');
    }

    updateSubmitTooltip() {
        const submitBtn = this.querySelector('#agent-input-submit-btn');
        if (submitBtn) {
            submitBtn.title = this.getSubmitTitle();
        }
    }

    /**
     * 在 textarea 光标处插入换行并保持焦点
     * （用于 Enter 发送模式下 Ctrl+Enter / Ctrl+Shift+Enter 换行）。
     * @param {HTMLTextAreaElement} textarea
     */
    insertNewlineAtCursor(textarea) {
        if (!textarea) return;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.setRangeText('\n', start, end, 'end');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
    }

    updateSendButtonState() {
        const textarea = this.querySelector('#agent-input-textarea');
        const submitBtn = this.querySelector('#agent-input-submit-btn');
        const clearBtn = this.querySelector('#agent-input-clear-btn');
        if (!textarea || !submitBtn) return;

        const hasText = textarea.value.trim().length > 0;
        const hasImages = this.attachedImages.length > 0;
        const hasContent = hasText || hasImages;
        const active = hasContent && !this.isModelNotSelected && !this.speechRecording;
        submitBtn.disabled = this.speechRecording;
        if (active) {
            submitBtn.classList.add('agent-send-active');
            submitBtn.classList.remove('agent-send-inactive');
        } else {
            submitBtn.classList.remove('agent-send-active');
            submitBtn.classList.add('agent-send-inactive');
        }

        if (clearBtn) {
            clearBtn.disabled = !hasText || this.speechRecording;
        }
    }

    render() {
        const prevTextarea = this.querySelector('#agent-input-textarea');
        const savedValue = prevTextarea ? prevTextarea.value : this.hasAttribute('hide-goal') ? _homeDraftText : '';
        const savedSelStart = prevTextarea ? prevTextarea.selectionStart : 0;
        const savedSelEnd = prevTextarea ? prevTextarea.selectionEnd : 0;

        const fileTags =
            this.attachedFilePaths.length > 0
                ? this.attachedFilePaths
                      .map((filePath) => {
                          const fileName = getFileName(filePath);
                          return `
                <div class="agent-input-file-tag">
                    <i class="fas fa-paperclip"></i>
                    <span class="agent-input-file-tag-name">${escapeHtml(fileName)}</span>
                    <button data-file_path="${escapeHtml(filePath)}" class="agent-input-remove-file-btn">
                        <i class="fas fa-times"></i>
                    </button>
                </div>`;
                      })
                      .join('')
                : '';

        const modelItems = this.availableModels
            .map((m) => {
                const isActive = m.alias === this.selectedModel ? 'active' : '';
                const checkMark =
                    m.alias === this.selectedModel
                        ? '<span class="ctx-item-check"><i class="fas fa-check"></i></span>'
                        : '';
                const hasVision = this.visionMap[m.alias] === true;
                const iconHTML = getModelIconTile(hasVision);
                const visionTagHTML = hasVision
                    ? `<span class="ctx-badge blue">${this.t('renderer.agentInput.model.visionTag')}</span>`
                    : '';
                return `<button class="ctx-item model-panel-item ${isActive}" data-model-alias="${m.alias}">
                    ${iconHTML}
                    <span class="ctx-label">${m.alias}${visionTagHTML}</span>
                    ${checkMark}
                    <span class="ctx-arrow"><i class="fas fa-chevron-right"></i></span>
                </button>`;
            })
            .join('');

        const modeItems = this.availableModes.map((m) => this.renderModeItem(m)).join('');

        const nodeItems = [
            `<button class="ctx-item-rich ${this.selectedExecutionNodeId ? '' : 'active'}" data-node-id="">
                <span class="ctx-icon-lg"><i class="fas fa-laptop"></i></span>
                <span class="ctx-rich-body">
                    <span class="ctx-rich-label">Local</span>
                    <span class="ctx-rich-desc">本机执行</span>
                </span>
                ${this.selectedExecutionNodeId ? '' : '<span class="ctx-item-check"><i class="fas fa-check"></i></span>'}
            </button>`,
            ...this.availableNodes.map((node) => {
                const label = node.displayName || node.nodeId;
                const isActive = node.nodeId === this.selectedExecutionNodeId ? 'active' : '';
                const checkMark =
                    node.nodeId === this.selectedExecutionNodeId
                        ? '<span class="ctx-item-check"><i class="fas fa-check"></i></span>'
                        : '';
                const shells =
                    Array.isArray(node.shells) && node.shells.length > 0 ? node.shells.join(', ') : '无 shell 声明';
                const workspace = typeof node.workspace === 'string' && node.workspace ? `cwd: ${node.workspace}` : '';
                const desc = [node.platform || '未知平台', shells, workspace].filter(Boolean).join(' · ');
                return `<button class="ctx-item-rich ${isActive}" data-node-id="${escapeHtml(node.nodeId)}" data-node-label="${escapeHtml(label)}">
                    <span class="ctx-icon-lg"><i class="fas fa-network-wired" style="color:#10b981"></i></span>
                    <span class="ctx-rich-body">
                        <span class="ctx-rich-label">${escapeHtml(label)}</span>
                        <span class="ctx-rich-desc">${escapeHtml(desc)}</span>
                    </span>
                    ${checkMark}
                </button>`;
            })
        ].join('');

        const currentModelLabel = this.getModelButtonLabel();
        const currentModelHasVision = this.visionMap[this.selectedModel] === true;
        const currentEffortIcon =
            this.selectedReasoningEffort && this.selectedReasoningEffort !== ''
                ? getEffortIconSVG(this.selectedReasoningEffort)
                : '';
        const currentMode = this.availableModes.find((m) => m.id === this.selectedModeId);
        const currentModeLabel = currentMode ? `${currentMode.name}` : '模式';
        const currentNodeLabel = this.selectedExecutionNodeLabel || 'Local';
        const inputPlaceholder = this.getInputPlaceholder();
        const inputPlaceholderHTML = this.buildPlaceholderHTML();
        const submitTitle = this.getSubmitTitle();
        const submitIcon = 'fa-arrow-up';
        const submitLabel = this.getSubmitLabel();
        const searchToggleTitle = this.t('renderer.agentInput.searchToggle.title');
        const searchToggleLabel = this.t('renderer.agentInput.searchToggle.label');
        const searchButton =
            this.getAttribute('hide-search') !== null
                ? ''
                : `
                        <button
                            id="agent-search-toggle"
                            class="agent-input-toolbar-control agent-search-toggle ${this.searchMode ? 'is-active' : ''}"
                            title="${searchToggleTitle}"
                            aria-pressed="${this.searchMode ? 'true' : 'false'}"
                        >
                            <i class="fa-solid fa-magnifying-glass"></i>
                            <span>${searchToggleLabel}</span>
                        </button>`;
        const goalButton =
            this.getAttribute('hide-goal') !== null
                ? ''
                : `
                        <button
                            id="agent-goal-btn"
                            class="agent-input-toolbar-control"
                            title="${escapeHtml(this._t('goal.renderer.create'))}"
                        >
                            <i class="fa-solid fa-bullseye"></i>
                            <span>${escapeHtml(this._t('goal.renderer.create'))}</span>
                        </button>`;

        this.innerHTML = `
        <div id="agent-input-container" class="w-full p-1 rounded-[24px] bg-white/40 border border-gray-300/60 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.07)]">
            <div class="bg-white rounded-[18px] shadow-sm border border-gray-100/40 overflow-hidden">
                <!-- 图片预览区域 -->
                <div id="agent-input-image-previews" class="agent-input-image-previews" style="display:${this.attachedImages.length > 0 ? 'flex' : 'none'};"></div>
                <!-- 任务运行时的队列提示 -->
                <div id="agent-input-queue-hint" class="agent-input-queue-hint" style="display: ${this.isRunning && this.runningInputMode === 'queue' ? 'flex' : 'none'};">
                    <i class="fas fa-clock"></i>
                    <span class="agent-input-queue-hint-text">${escapeHtml(this.t('renderer.agentInput.queueHint'))}</span>
                </div>
                <!-- 主要输入区域 -->
                <div class="px-3.5 pt-2.5 pb-1">
                    ${this.attachedFilePaths.length > 0 ? `<div class="agent-input-file-tags">${fileTags}</div>` : ''}
                    <div class="relative">
                        <textarea
                            id="agent-input-textarea"
                            placeholder="${inputPlaceholder}"
                            aria-label="${inputPlaceholder}"
                            class="w-full h-14 resize-none border-none outline-none text-gray-700 text-[13px] leading-relaxed"
                        ></textarea>
                        <div id="agent-input-placeholder" class="agent-input-placeholder" aria-hidden="true">${inputPlaceholderHTML}</div>
                    </div>
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
                                ${getModelIconTile(currentModelHasVision)}
                                ${currentEffortIcon ? `<span class="agent-effort-icon">${currentEffortIcon}</span>` : ''}
                                <span>${currentModelLabel}</span>
                            </button>
                            <div id="agent-input-model-panel" class="ctx-menu ctx-menu-hidden">
                                <div class="ctx-search">
                                    <i class="fas fa-search"></i>
                                    <input id="agent-input-model-search" type="text" placeholder="搜索模型" />
                                </div>
                                <div id="agent-input-model-list" class="ctx-menu-list">${modelItems}</div>
                            </div>
                            <div id="agent-input-effort-submenu" class="ctx-menu ctx-menu-hidden">
                                <div id="agent-input-effort-submenu-list" class="ctx-menu-list"></div>
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
                                <span>${getModeIconTile(this.selectedModeId)}</span>
                                <span>${escapeHtml(currentModeLabel)}</span>
                            </button>
                            <div id="agent-input-mode-panel" class="ctx-menu ctx-menu-hidden">
                                <div id="agent-input-mode-list" class="ctx-menu-list">${modeItems}</div>
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
                            <div id="agent-input-node-panel" class="ctx-menu ctx-menu-hidden">
                                <div id="agent-input-node-list" class="ctx-menu-list">${nodeItems}</div>
                            </div>
                        </div>
                        `
                                : ''
                        }
                        <div class="agent-input-toolbar-item" data-toolbar-priority="4">
                            <button id="agent-input-skill-btn" class="agent-input-toolbar-control">
                                ${SKILL_ICON_SVG}
                                <span>${this.t('renderer.agentInput.skillLabel')}</span>
                            </button>
                            <div id="agent-input-skill-panel" class="ctx-menu ctx-menu-hidden">
                                <div class="ctx-search">
                                    <i class="fas fa-search"></i>
                                    <input id="agent-input-skill-search" type="text" placeholder="${this.t('renderer.agentInput.skill.searchPlaceholder')}" />
                                </div>
                                <div id="agent-input-skill-list" class="ctx-menu-list"></div>
                                <div class="ctx-menu-footer">
                                    <button id="agent-input-skill-install-btn" class="ctx-install-btn">
                                        <i class="fas fa-plus"></i>
                                        <span>${this.t('renderer.agentInput.skill.install')}</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                        ${searchButton}
                        ${goalButton}
                        <div
                            id="agent-input-attached-file-list"
                            class="agent-input-toolbar-item"
                            data-toolbar-priority="5"
                        >
                            <button id="agent-input-file-add-btn" class="agent-input-toolbar-control" title="${this.t('renderer.agentInput.fileDrop.hint')}">
                                <i class="fas fa-paperclip"></i>
                                <span>${this.t('renderer.agentInput.fileDrop.hint')}</span>
                            </button>
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
                                title="${submitTitle}">
                                <i class="fas ${submitIcon}"></i>
                                <span>${submitLabel}</span>
                            </button>
                            <div class="agent-send-divider"></div>
                            <button id="agent-input-clear-btn" class="agent-clear-btn" disabled
                                title="${this.t('renderer.agentInput.clearInput')}">
                                <i class="fas fa-trash-can"></i>
                            </button>
                        </div>
                        <button id="agent-input-stop-btn" class="agent-stop-btn" style="display:none;">
                            <span class="agent-stop-icon"><i class="fas fa-stop"></i></span>
                            <span>${this.t('renderer.agentInput.stop')}</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
        <!-- 底部信息区：固定高度，录音提示和免责声明互斥显示，避免布局跳动 -->
        <div class="agent-input-footer">
            <div id="agent-input-recording-hint" class="agent-recording-hint" style="display:none;">
                <i class="fas fa-microphone-alt"></i>
                <span>${this.t('renderer.agentInput.recording.hint')}</span>
            </div>
            ${this.getAttribute('hide-disclaimer') !== null ? '' : `<p id="agent-input-disclaimer" class="agent-input-footer-text">${this.t('common.aiDisclaimer')}</p>`}
        </div>
        <!-- 内联补全面板 -->
        <div id="agent-input-autocomplete" class="ctx-menu ctx-menu-hidden">
            <div id="agent-input-autocomplete-list" class="ctx-menu-list"></div>
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
     * 生成模型按钮的显示文字：模型名
     */
    getModelButtonLabel() {
        return this.selectedModel || '模型';
    }

    /**
     * 仅更新模型按钮的图标和文字，不全量重渲染。
     * 当外部通过 setModel() 切换任务时调用。
     */
    _updateModelButton() {
        const btn = this.querySelector('#agent-input-model-btn');
        if (!btn) return;
        const hasVision = this.visionMap[this.selectedModel] === true;
        const iconSpan = btn.querySelector(':scope > span:first-child');
        if (iconSpan) {
            iconSpan.className = `agent-icon-tile ${hasVision ? 'model-vision' : 'model-chat'}`;
        }
        const labelSpan = btn.querySelector(':scope > span:last-child');
        if (labelSpan) labelSpan.textContent = this.getModelButtonLabel();
        this._updateEffortIcon();
    }

    /**
     * 更新模型按钮中的推理深度图标（非默认时显示）
     */
    _updateEffortIcon() {
        const btn = this.querySelector('#agent-input-model-btn');
        if (!btn) return;
        const existing = btn.querySelector('.agent-effort-icon');
        if (this.selectedReasoningEffort && this.selectedReasoningEffort !== '') {
            const svg = getEffortIconSVG(this.selectedReasoningEffort);
            if (existing) {
                existing.innerHTML = svg;
            } else {
                const span = document.createElement('span');
                span.className = 'agent-effort-icon';
                span.innerHTML = svg;
                // 注意：必须使用 `:scope >` 形式，裸的 `> span` 在 Chromium 的
                // querySelector 中会抛 SyntaxError，导致图标无法插入
                const labelSpan = btn.querySelector(':scope > span:last-child');
                if (labelSpan) btn.insertBefore(span, labelSpan);
            }
        } else if (existing) {
            existing.remove();
        }
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
    }

    toggleModelPanel(forceClose = false) {
        const panel = this.querySelector('#agent-input-model-panel');
        if (!panel) return;
        if (forceClose || panel.classList.contains('ctx-menu-visible')) {
            this.closeModelPanel(true);
        } else {
            this.closeAllPanels();
            panel.classList.remove('ctx-menu-hidden');
            panel.classList.add('ctx-menu-visible');
            this.modelPanelOpen = true;
            this.renderModelList();
            const btn = this.querySelector('#agent-input-model-btn');
            if (btn) this.positionPanel(btn, panel, 240);
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
        panel.classList.remove('ctx-menu-visible');
        panel.classList.add('ctx-menu-hidden');
        this.modelPanelOpen = false;
        this.hideEffortSubmenu();
    }

    toggleModePanel(forceClose = false) {
        const panel = this.querySelector('#agent-input-mode-panel');
        if (!panel) return;
        if (forceClose || panel.classList.contains('ctx-menu-visible')) {
            this.closeModePanel(true);
        } else {
            this.closeAllPanels();
            this.renderModeList();
            panel.classList.remove('ctx-menu-hidden');
            panel.classList.add('ctx-menu-visible');
            this.modePanelOpen = true;
            const btn = this.querySelector('#agent-input-mode-btn');
            // 模式面板不限制高度，让所有可选模式直接暴露（无需滚动）
            if (btn) this.positionPanel(btn, panel, 340, 9999);
        }
    }

    closeModePanel(_force = false) {
        const panel = this.querySelector('#agent-input-mode-panel');
        if (!panel) return;
        panel.classList.remove('ctx-menu-visible');
        panel.classList.add('ctx-menu-hidden');
        this.modePanelOpen = false;
    }

    toggleNodePanel(forceClose = false) {
        const panel = this.querySelector('#agent-input-node-panel');
        if (!panel) return;
        if (forceClose || panel.classList.contains('ctx-menu-visible')) {
            this.closeNodePanel(true);
        } else {
            this.closeAllPanels();
            this.renderNodeList();
            panel.classList.remove('ctx-menu-hidden');
            panel.classList.add('ctx-menu-visible');
            this.nodePanelOpen = true;
            const btn = this.querySelector('#agent-input-node-btn');
            if (btn) this.positionPanel(btn, panel, 260, 320);
        }
    }

    closeNodePanel(_force = false) {
        const panel = this.querySelector('#agent-input-node-panel');
        if (!panel) return;
        panel.classList.remove('ctx-menu-visible');
        panel.classList.add('ctx-menu-hidden');
        this.nodePanelOpen = false;
    }

    renderNodeList() {
        const listEl = this.querySelector('#agent-input-node-list');
        if (!listEl) return;
        const items = [
            `<button class="ctx-item-rich ${this.selectedExecutionNodeId ? '' : 'active'}" data-node-id="">
                <span class="ctx-icon-lg"><i class="fas fa-laptop"></i></span>
                <span class="ctx-rich-body">
                    <span class="ctx-rich-label">Local</span>
                    <span class="ctx-rich-desc">本机执行</span>
                </span>
                ${this.selectedExecutionNodeId ? '' : '<span class="ctx-item-check"><i class="fas fa-check"></i></span>'}
            </button>`,
            ...this.availableNodes.map((node) => {
                const label = node.displayName || node.nodeId;
                const isActive = node.nodeId === this.selectedExecutionNodeId ? 'active' : '';
                const checkMark =
                    node.nodeId === this.selectedExecutionNodeId
                        ? '<span class="ctx-item-check"><i class="fas fa-check"></i></span>'
                        : '';
                const shells =
                    Array.isArray(node.shells) && node.shells.length > 0 ? node.shells.join(', ') : '无 shell 声明';
                const workspace = typeof node.workspace === 'string' && node.workspace ? `cwd: ${node.workspace}` : '';
                const desc = [node.platform || '未知平台', shells, workspace].filter(Boolean).join(' · ');
                return `<button class="ctx-item-rich ${isActive}" data-node-id="${escapeHtml(node.nodeId)}" data-node-label="${escapeHtml(label)}">
                    <span class="ctx-icon-lg"><i class="fas fa-network-wired" style="color:#10b981"></i></span>
                    <span class="ctx-rich-body">
                        <span class="ctx-rich-label">${escapeHtml(label)}</span>
                        <span class="ctx-rich-desc">${escapeHtml(desc)}</span>
                    </span>
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
            listEl.innerHTML = '<div class="ctx-empty">未找到匹配的模型</div>';
        } else {
            listEl.innerHTML = filtered
                .map((m) => {
                    const isActive = m.alias === this.selectedModel ? 'active' : '';
                    const checkMark =
                        m.alias === this.selectedModel
                            ? '<span class="ctx-item-check"><i class="fas fa-check"></i></span>'
                            : '';
                    const hasVision = this.visionMap[m.alias] === true;
                    const iconHTML = getModelIconTile(hasVision);
                    const visionTagHTML = hasVision
                        ? `<span class="ctx-badge blue">${this.t('renderer.agentInput.model.visionTag')}</span>`
                        : '';
                    return `<button class="ctx-item model-panel-item ${isActive}" data-model-alias="${m.alias}">
                        ${iconHTML}
                        <span class="ctx-label">${m.alias}${visionTagHTML}</span>
                        ${checkMark}
                        <span class="ctx-arrow"><i class="fas fa-chevron-right"></i></span>
                    </button>`;
                })
                .join('');
        }
        this.bindModelItemEvents();
    }

    bindModelItemEvents() {
        const modelItems = this.querySelectorAll('#agent-input-model-list .ctx-item');
        modelItems.forEach((item) => {
            item.addEventListener('mouseenter', () => {
                const alias = item.dataset.modelAlias;
                if (!alias) return;
                // 清除其他模型项的 hovered 状态，给当前项加上
                this.querySelectorAll('#agent-input-model-list .ctx-item.hovered').forEach((el) => {
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

        // 生成子菜单内容：按该模型支持的档位过滤；若当前选中值不在支持列表中
        // （如旧配置残留），仍插入展示以保留激活态
        const supportedValues = this.getSupportedEffortValues(modelAlias);
        const effortOptions = REASONING_EFFORT_OPTIONS.filter((o) => supportedValues.includes(o.value));
        if (
            modelAlias === this.selectedModel &&
            this.selectedReasoningEffort &&
            !supportedValues.includes(this.selectedReasoningEffort)
        ) {
            const activeOption = REASONING_EFFORT_OPTIONS.find((o) => o.value === this.selectedReasoningEffort);
            if (activeOption) effortOptions.splice(1, 0, activeOption);
        }
        submenuList.innerHTML = effortOptions
            .map((o) => {
                const isActive =
                    modelAlias === this.selectedModel && o.value === this.selectedReasoningEffort ? 'active' : '';
                const checkMark = isActive ? '<span class="ctx-item-check"><i class="fas fa-check"></i></span>' : '';
                const effortIcon = getEffortIconSVG(o.value);
                return `<button class="ctx-item ${isActive}" data-model-alias="${modelAlias}" data-effort-value="${o.value}">
                ${effortIcon}
                <span class="ctx-label">${o.label}</span>
                ${checkMark}
            </button>`;
            })
            .join('');

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
        submenu.classList.remove('ctx-menu-visible');
        submenu.classList.add('ctx-menu-hidden');
        // 强制 reflow 以重启动画
        void submenu.offsetWidth;
        submenu.classList.remove('ctx-menu-hidden');
        submenu.classList.add('ctx-menu-visible');

        // 绑定子菜单项事件
        this.bindEffortSubmenuEvents();
    }

    hideEffortSubmenu() {
        const submenu = this.querySelector('#agent-input-effort-submenu');
        if (!submenu) return;
        submenu.classList.remove('ctx-menu-visible');
        submenu.classList.add('ctx-menu-hidden');
        // 清除模型项的 hovered 状态
        this.querySelectorAll('#agent-input-model-list .ctx-item.hovered').forEach((el) => {
            el.classList.remove('hovered');
        });
        this._hoveredModelAlias = null;
    }

    bindEffortSubmenuEvents() {
        const items = this.querySelectorAll('#agent-input-effort-submenu-list .ctx-item');
        items.forEach((item) => {
            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                const alias = item.dataset.modelAlias;
                const effortValue = item.dataset.effortValue;
                if (!alias || effortValue === undefined) return;
                this.selectedModel = alias;
                this.selectedReasoningEffort = effortValue;
                await updateSettingForModelChange(this.selectedModel, this.selectedReasoningEffort, {
                    updateDefaultModel: !this.taskId,
                    updateReasoningEffort: !this.taskId
                });
                this.closeModelPanel();
                this.hideEffortSubmenu();
                // 更新按钮文字和推理图标
                const modelBtn = this.querySelector('#agent-input-model-btn > span:last-child');
                if (modelBtn) modelBtn.textContent = this.getModelButtonLabel();
                this._updateEffortIcon();
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
        const items = this.querySelectorAll('#agent-input-mode-list .ctx-item-block');
        items.forEach((item) => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const modeId = item.dataset.modeId;
                if (!modeId) return;
                this.setMode(modeId);
                this.closeModePanel();
                const modeBtnIcon = this.querySelector('#agent-input-mode-btn > span:first-child');
                const modeBtnText = this.querySelector('#agent-input-mode-btn > span:last-child');
                const mode = this.availableModes.find((m) => m.id === modeId);
                if (mode) {
                    if (modeBtnIcon) modeBtnIcon.innerHTML = getModeIconTile(mode.id);
                    if (modeBtnText) modeBtnText.textContent = mode.name;
                }
            });
        });
    }

    bindNodeItemEvents() {
        const items = this.querySelectorAll('#agent-input-node-list .ctx-item-rich');
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
        if (forceClose || panel.classList.contains('ctx-menu-visible')) {
            panel.classList.remove('ctx-menu-visible');
            panel.classList.add('ctx-menu-hidden');
            this.skillPanelOpen = false;
        } else {
            this.closeModelPanel(true);
            this.closeModePanel(true);
            this.closeNodePanel(true);
            this.loadSkills().then(() => {
                this.renderSkillList();
                panel.classList.remove('ctx-menu-hidden');
                panel.classList.add('ctx-menu-visible');
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
            listEl.innerHTML = `<div class="ctx-empty">${filter ? this.t('renderer.agentInput.skill.empty.search') : this.t('renderer.agentInput.skill.empty.none')}</div>`;
        } else {
            listEl.innerHTML = filtered
                .map((s) => {
                    const color = getSkillPastel(s.name);
                    const initial = getSkillInitial(s.name);
                    return `
                <button class="ctx-item-rich" data-skill-name="${s.name}">
                    <span class="ctx-icon-lg" style="background:${color.bg};color:${color.text};border-color:transparent;font-weight:700;font-size:14px;">
                        ${initial}
                    </span>
                    <span class="ctx-rich-body">
                        <span class="ctx-rich-label">${s.name}</span>
                        <span class="ctx-rich-desc">${s.description}</span>
                    </span>
                </button>
            `;
                })
                .join('');
        }
        this.bindSkillItemEvents();
    }

    bindSkillItemEvents() {
        const items = this.querySelectorAll('#agent-input-skill-list .ctx-item-rich');
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

    _parseSlashCommandInput(message) {
        const trimmed = message.trim();
        if (!trimmed.startsWith('/')) return null;
        const match = trimmed.match(/^\/([a-z0-9][-a-z0-9]*)(?:\s+([\s\S]*))?$/i);
        if (!match) return null;
        const name = match[1].toLowerCase();
        if (!getSlashCommands().some((cmd) => cmd.name === name)) return null;
        return { name, args: match[2] || '' };
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

            // 收集匹配的技能
            const filteredSkills = this.availableSkills.filter(
                (s) => !nameFilter || s.name.toLowerCase().includes(nameFilter)
            );
            // 收集匹配的 slash command
            const matchedCommands = filterSlashCommands(nameFilter);

            const items = [];

            // 先放技能（带 skill 柔和色图标）
            for (const s of filteredSkills) {
                const color = getSkillPastel(s.name);
                const initial = getSkillInitial(s.name);
                items.push({
                    value: s.name,
                    label: s.name,
                    description: s.description.slice(0, 80),
                    icon: null,
                    iconClass: 'skill-icon',
                    pastelBg: color.bg,
                    pastelText: color.text,
                    initial,
                    isCommand: false
                });
            }

            // 再放 slash commands（带 command 图标）
            for (const cmd of matchedCommands) {
                items.push({
                    value: cmd.name,
                    label: cmd.name,
                    description: cmd.description,
                    icon: cmd.icon,
                    iconClass: 'command-icon',
                    pastelBg: cmd.iconBg,
                    pastelText: cmd.iconColor,
                    initial: null,
                    isCommand: true,
                    acceptsArgs: cmd.acceptsArgs === true
                });
            }

            if (items.length > 0) {
                // 如果是新触发（之前没有打开），记录光标位置
                if (!this.autocompleteOpen) {
                    this._autocompleteTriggerPosition = this.getCaretCoordinates(textarea);
                }
                this.autocompleteMode = 'slash';
                this.autocompleteItems = items;
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
            // 每次触发补全都重新读取当前有效工作空间，避免切换工作空间后补全范围仍停留在旧目录
            if (window.workspaceAPI?.getEffectiveWorkspace) {
                const effective = await window.workspaceAPI.getEffectiveWorkspace();
                if (effective) {
                    this._workspacePath = effective.replace(/\\/g, '/');
                }
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
                            let relativePath = result.path.replace(/\\/g, '/');
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
                    let relativePath = result.path.replace(/\\/g, '/');
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
                let iconContent;
                if (item.isCommand) {
                    // Slash command：使用 FontAwesome 图标
                    iconContent = `<span class="ctx-icon-lg ${item.iconClass || ''}" style="background:${item.pastelBg};color:${item.pastelText};"><i class="fas ${item.icon}" style="font-size:14px;"></i></span>`;
                } else if (item.initial) {
                    // Skill：首字母 / 表情图标
                    iconContent = `<span class="ctx-icon-lg ${item.iconClass || ''}" style="background:${item.pastelBg};color:${item.pastelText};font-weight:700;font-size:12px;">${item.initial}</span>`;
                } else {
                    iconContent = `<span class="ctx-icon-lg ${item.iconClass || ''}"><i class="fas ${item.icon}"></i></span>`;
                }
                return `
            <button class="ctx-item-rich${idx === this.autocompleteSelectedIndex ? ' selected' : ''}" data-idx="${idx}">
                ${iconContent}
                <span class="ctx-rich-body">
                    <span class="ctx-rich-label">${this.autocompleteMode === 'file' ? '' : '/'}${item.label}</span>
                    ${item.description ? `<span class="ctx-rich-desc">${item.description}</span>` : ''}
                </span>
            </button>
        `;
            })
            .join('');

        panel.classList.remove('ctx-menu-hidden');
        panel.classList.add('ctx-menu-visible');
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
            panel.style.maxHeight = '';
        } else if (spaceBelow >= panelHeight + 8) {
            panel.style.top = baseTop + 20 + 'px'; // 光标高度约 20px
            panel.style.maxHeight = '';
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
        panel.classList.remove('ctx-menu-visible');
        panel.classList.add('ctx-menu-hidden');
        this.autocompleteOpen = false;
        this.autocompleteMode = null;
        this._autocompleteTriggerPosition = null;
    }

    bindAutocompleteItemEvents() {
        const items = this.querySelectorAll('#agent-input-autocomplete-list .ctx-item-rich');
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
        const items = this.querySelectorAll('#agent-input-autocomplete-list .ctx-item-rich');
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

        if (this.autocompleteMode === 'slash') {
            if (item.isCommand) {
                if (item.acceptsArgs) {
                    const slashMatch = textBefore.match(/(?:^|\s)(\/[a-z0-9][-a-z0-9]*?)$|(?:^|\s)(\/)$/);
                    if (slashMatch) {
                        const matchStr = slashMatch[1] || slashMatch[2];
                        const matchStart = cursorPos - matchStr.length;
                        const replacement = '/' + item.value + ' ';
                        textarea.value = textBefore.substring(0, matchStart) + replacement + textAfter;
                        const newPos = matchStart + replacement.length;
                        textarea.setSelectionRange(newPos, newPos);
                        textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    textarea.focus();
                    this.closeAutocompletePanel();
                    return;
                }
                // 无参数 Slash command：直接执行命令
                this.closeAutocompletePanel();
                textarea.focus();
                this._executeSlashCommand(item.value);
                return;
            }
            // Skill（slash 模式下）：替换 /prefix 为 /skillname + 空格
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
        const fileAddBtn = this.querySelector('#agent-input-file-add-btn');

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

        const goalBtn = this.querySelector('#agent-goal-btn');
        if (goalBtn) {
            goalBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.dispatchEvent(
                    new CustomEvent('open-goal-creation', {
                        bubbles: true,
                        composed: true
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
            });
        }

        this.bindSkillItemEvents();

        // 提交消息的函数
        const handleSubmit = async () => {
            if (this.speechRecording) {
                return;
            }

            const message = textarea.value.trim();

            // 模型未选择时禁止发送；任务运行中则允许加入队列。
            if (this.isModelNotSelected) {
                return;
            }

            if (message === '' && this.attachedImages.length === 0) {
                return;
            }

            const unsupported = await this.getUnsupportedFilePaths(this.attachedFilePaths);
            if (unsupported.length > 0) {
                const cursorPos = textarea.selectionStart;
                this.attachedFilePaths = this.attachedFilePaths.filter((p) => !unsupported.includes(p));
                this.render();
                this.pasteFilePathsToTextarea(unsupported, cursorPos);
                return;
            }
            const slashCommand = this._parseSlashCommandInput(message);
            if (slashCommand && this.attachedImages.length === 0 && this.attachedFilePaths.length === 0) {
                this._executeSlashCommand(slashCommand.name, slashCommand.args);
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

        submitBtn.addEventListener('click', () => {
            void handleSubmit();
        });

        const speechBtn = this.querySelector('#agent-input-speech-btn');
        if (speechBtn) {
            speechBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (performance.now() - this._lastSpeechButtonPointerAt < 350) {
                    return;
                }
                this.toggleSpeechInput(textarea, speechBtn, {
                    isBlocked: () => this.isModelNotSelected && !this.searchMode,
                    idlePlaceholder: this.getInputPlaceholder(),
                    recordingPlaceholder: this.t('renderer.agentInput.recording.listening')
                });
            });
        }

        // 清除输入按钮
        const clearBtn = this.querySelector('#agent-input-clear-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.clearInput();
                this.querySelector('#agent-input-textarea')?.focus();
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

        if (fileAddBtn) {
            fileAddBtn.addEventListener('click', async () => {
                const paths = await window.fsAPI?.selectFile?.();
                if (paths && paths.length > 0) {
                    await this.attachFilePaths(paths);
                }
            });
        }

        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });

        container.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const files = e.dataTransfer.files;
            const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
            const images = [];
            const directories = [];
            const attachableFiles = [];

            for (const file of files) {
                const filePath = window.fsAPI.getFilePath(file);
                /* electron前端无法获取文件完整路径，需要通过fsAPI.getFilePath获取 */
                const ext = getFileExtension(filePath);

                if (file.type.startsWith('image/')) {
                    images.push(file);
                    continue;
                }

                if (imageExts.includes(ext)) {
                    images.push(file);
                    continue;
                }

                // 检查路径类型
                const pathType = await window.fsAPI.getPathType(filePath);

                if (pathType === 'directory') {
                    directories.push(filePath);
                } else if (pathType === 'file') {
                    attachableFiles.push(filePath);
                }
                // 如果pathType为null（路径不存在），则不执行任何操作
            }

            for (const image of images) {
                const reader = new FileReader();
                reader.onload = () => {
                    this.addImage(reader.result, image.name || this.t('renderer.agentInput.image.dropped'));
                };
                reader.readAsDataURL(image);
            }

            for (const directory of directories) {
                // 如果是目录，直接插入到textarea当前光标位置
                const cursorPos = textarea.selectionStart;
                const textBefore = textarea.value.substring(0, cursorPos);
                const textAfter = textarea.value.substring(cursorPos);
                textarea.value = textBefore + directory + textAfter;
                // 设置光标位置到插入文本的末尾
                const newCursorPos = cursorPos + directory.length;
                textarea.setSelectionRange(newCursorPos, newCursorPos);
                // 触发input事件以通知内容变化
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }

            await this.attachFilePaths(attachableFiles);
        });

        // 键盘事件：补全导航 + Enter/Ctrl+Enter 发送
        textarea.addEventListener('keydown', (e) => {
            // 普通对话模式下，未选择对话模型时禁止输入。
            if (this.isModelNotSelected && !this.searchMode) {
                e.preventDefault();
                return;
            }

            // 输入法组字过程中不处理
            if (e.isComposing || e.keyCode === 229) return;

            // 补全面板打开时优先处理键盘导航
            if (this.handleAutocompleteKeydown(e)) return;

            if (this.ctrlEnterSend) {
                if (e.ctrlKey && e.key === 'Enter') {
                    e.preventDefault();
                    void handleSubmit();
                }
            } else {
                if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) {
                    e.preventDefault();
                    void handleSubmit();
                } else if (e.key === 'Enter' && e.ctrlKey) {
                    // Ctrl+Enter（含 Ctrl+Shift+Enter）换行：textarea 默认仅 Enter/Shift+Enter 换行
                    e.preventDefault();
                    this.insertNewlineAtCursor(textarea);
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

            // 如果有图片，优先处理图片；文本由 textarea 原生粘贴逻辑处理
            const hasImage = Array.from(items).some((item) => item.type.startsWith('image/'));
            if (!hasImage) return;

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
        });
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
            isBlocked: () => this.isModelNotSelected && !this.searchMode,
            idlePlaceholder: this.getInputPlaceholder(),
            recordingPlaceholder: this.t('renderer.agentInput.recording.listening')
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
            const ph = idlePlaceholder || this.getInputPlaceholder();
            textarea.placeholder = ph;
            const overlay = this.querySelector('#agent-input-placeholder');
            if (overlay) overlay.innerHTML = this.buildPlaceholderHTML();
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
            speechBtn.title = this.t('renderer.agentInput.recording.stopTitle');
            const recordingText = recordingPlaceholder || this.t('renderer.agentInput.recording.listening');
            textarea.placeholder = recordingText;
            const overlay = this.querySelector('#agent-input-placeholder');
            if (overlay) overlay.textContent = recordingText;
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
                speechBtn.title = this.t('renderer.agentInput.recording.endTitle');
                textarea.placeholder = this.t('renderer.agentInput.recording.listening');
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
        this.queueRenderSignature = '';
        this.activeGoalRunning = false;
        /** @type {Function | null} 立即发送回调 */
        this.onSendNow = null;
        /** @type {Function | null} 编辑回调 */
        this.onEdit = null;
        /** @type {Function | null} 删除回调 */
        this.onDelete = null;
        this._t = createRendererTranslator();
        this._unsubSettingChanged = null;
    }

    connectedCallback() {
        this.render();
        this._unsubSettingChanged = window.settingAPI?.onSettingChanged?.((newData) => {
            this._t = createRendererTranslator(newData);
            this.queueRenderSignature = '';
            this.render();
        });
    }

    disconnectedCallback() {
        this._unsubSettingChanged?.();
    }

    t(key, params) {
        return this._t?.(key, params) ?? key;
    }

    /**
     * 设置队列内容
     * @param {Array} queue 消息队列
     */
    setQueue(queue, options = {}) {
        const nextQueue = queue || [];
        const nextActiveGoalRunning = Boolean(options.activeGoalRunning);
        const nextSignature = JSON.stringify({
            activeGoalRunning: nextActiveGoalRunning,
            queue: nextQueue.map((item) => ({
                id: item.id,
                message: item.message,
                attachedFileCount: item.attachedFilePaths?.length ?? 0,
                attachedImageCount: item.attachedImages?.length ?? 0,
                selectedModel: item.selectedModel,
                reasoningEffort: item.reasoningEffort,
                selectedExecutionNodeId: item.selectedExecutionNodeId
            }))
        });
        if (nextSignature === this.queueRenderSignature) {
            this.queue = nextQueue;
            this.activeGoalRunning = nextActiveGoalRunning;
            return;
        }
        this.queue = nextQueue;
        this.activeGoalRunning = nextActiveGoalRunning;
        this.queueRenderSignature = nextSignature;
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
        const sendNowTitle = this.activeGoalRunning
            ? this.t('renderer.messageQueue.sendNow.goalTitle')
            : this.t('renderer.messageQueue.sendNow.title');
        this.innerHTML = `
        <div class="message-queue-container">
            <div class="message-queue-header">
                <i class="fas fa-layer-group text-xs"></i>
                <span class="message-queue-title">${escapeHtml(
                    this.t('renderer.messageQueue.title', { count: this.queue.length })
                )}</span>
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
                            <button class="message-queue-action-btn" data-action="send" title="${escapeHtml(sendNowTitle)}" aria-label="${escapeHtml(sendNowTitle)}">
                                <i class="fas fa-paper-plane"></i>
                                <span class="action-label">${escapeHtml(this.t('renderer.messageQueue.sendNow'))}</span>
                            </button>
                            <button class="message-queue-action-btn" data-action="edit">
                                <i class="fas fa-pen"></i>
                                <span class="action-label">${escapeHtml(this.t('renderer.messageQueue.edit'))}</span>
                            </button>
                            <button class="message-queue-action-btn" data-action="delete">
                                <i class="fas fa-trash"></i>
                                <span class="action-label">${escapeHtml(this.t('renderer.messageQueue.delete'))}</span>
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
        if (!text) return escapeHtml(this.t('renderer.messageQueue.empty'));
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
