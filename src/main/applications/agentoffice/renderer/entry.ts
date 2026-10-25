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

import { OVERLAY_CSS } from '../../../../common/overlay-styles.js';
import { AgentOperableHTMLElement } from '../../widget_utils.js';
import { hasPowerPointClipboardText } from '../../../../common/clipboard.js';
import { escapeHtml } from '../../../../common/utils/escape.js';
import { resolveRendererLocale } from '../../../../renderer/locale.js';
import { ENTER_KEY_ICON_SVG, SHIFT_KEY_ICON_SVG, CTRL_KEY_ICON_SVG } from '../../../../common/utils/keys.ts';
import { OPENDESK_THEME_CHANGED } from '../../../../renderer/theme/theme-iframe-bridge.ts';
import { syncShadowHostTheme } from '../../../../renderer/theme/theme-shadow-overrides.ts';
import { renderSafeMarkdown } from '../../../../renderer/utils/markdown.js';
import {
    SkillDetailCard,
    getSkillInitial,
    getSkillPastel,
    type SkillDetailCardModel
} from '../../../../renderer/components/skills/skill-detail-card.js';
import {
    generateStaffServiceToken,
    normalizeStaffLocalService,
    unwrapAgentOfficeCallResult,
    type InstalledSkillSummary,
    type LocalServiceRuntime,
    type StaffDetail,
    type StaffListItem,
    type StaffLocalService,
    type StaffMessage,
    type StaffSkillBatchImportResult,
    type StaffSkillImportCandidate,
    type StaffSkillSummary,
    type StaffUpdateInput
} from '../common.js';
import type {
    AgentFlowDetail,
    AgentFlowMessage,
    AgentFlowMessageHistoryResult,
    AgentFlowStatus,
    AgentFlowSummary
} from '../flow/common.js';
import css from './style.css?raw';
import type { FlowReadingView } from '../flow/reading-view.js';
import contextMenuCss from '../../../../renderer/styles/context-menu.css?raw';
import { renderIcon } from '../../../../renderer/components/confirmModal.ts';

type DetailSection = 'basic' | 'skills' | 'mcp' | 'security' | 'tasks';

interface ChatModelSummary {
    alias: string;
    provider_name: string;
    model_name: string;
}

interface ModelCatalog {
    default_model: string;
    models: ChatModelSummary[];
}

type AutoSaveState = 'idle' | 'saving' | 'saved' | 'invalid' | 'error';
type AgentOfficeTab = 'office' | 'management' | 'flows';
type FlowListStatus = AgentFlowStatus | 'all';

const PORTRAIT_CANVAS_SIZE = 512;
const PORTRAIT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const FLOW_MESSAGE_EXCERPT_MAX_CHARACTERS = 96;
const AVATAR_GRADIENTS = ['av-g1', 'av-g2', 'av-g3', 'av-g4'] as const;

export class AgentOfficeEntryWidget extends AgentOperableHTMLElement {
    private strings: Record<string, string> = {};
    private locale = 'en-US';
    private staffs: StaffListItem[] = [];
    private selectedStaffId: string | null = null;
    private messages: StaffMessage[] = [];
    private historyCursor?: string;
    private activeTab: AgentOfficeTab = 'office';
    private flowFeatureEnabled = false;
    private flowEventsSubscribed = false;
    private flows: AgentFlowSummary[] = [];
    private selectedFlow: AgentFlowDetail | null = null;
    private flowMessages: AgentFlowMessage[] = [];
    private readonly flowReferencedMessages = new Map<string, AgentFlowMessage>();
    private flowHistoryCursor?: string;
    private flowHistoryFloor?: number;
    private flowReadingView?: FlowReadingView;
    private flowReadingRequest = 0;
    private flowMessagesRequest = 0;
    private flowOpenRequest = 0;
    private flowReadingTimer?: ReturnType<typeof setInterval>;
    private readonly flowDrafts = new Map<
        string,
        {
            text: string;
            attachments: { path: string; name: string }[];
            images: { dataUrl: string; name: string }[];
            reply?: string;
            caret?: [number, number];
            scroll?: number;
            oldestSequence?: number;
        }
    >();
    private flowView: 'chat' | 'settings' = 'chat';
    private flowAttachments: { path: string; name: string }[] = [];
    private flowImageDataUris: { dataUrl: string; name: string }[] = [];
    private flowDraftText = '';
    private flowReplyToMessageId?: string;
    private flowDeleteMessageId?: string;
    private flowPendingRequestId?: string;
    private flowPendingPayloadKey?: string;
    private flowPendingRequestFlowId?: string;
    private readonly flowPendingRequests = new Map<string, string>();
    private flowScrollToBottomOnNextRender = false;
    private flowQuery = '';
    private flowStatusFilter: FlowListStatus = 'active';
    private detail: StaffDetail | null = null;
    private detailSection: DetailSection = 'basic';
    private skills: StaffSkillSummary[] = [];
    private installedSkills: InstalledSkillSummary[] = [];
    private selectedInstalledSkillIds = new Set<string>();
    private batchSkillCandidates: StaffSkillImportCandidate[] = [];
    private selectedBatchSkillPaths = new Set<string>();
    private skillBatchResult: StaffSkillBatchImportResult | null = null;
    private skillUrl = '';
    private skillModalError = '';
    private selectedSkill: StaffSkillSummary | null = null;
    private skillAddMenuOpen = false;
    private modelCatalog: ModelCatalog = { default_model: '', models: [] };
    private attachments: { path: string; name: string }[] = [];
    private imageDataUris: { dataUrl: string; name: string }[] = [];
    private ctrlEnterSend = false;
    private sendMenuOpen = false;
    private query = '';
    private busy = false;
    /** 首次 staff 数据尚未返回时为 true，office/management 空列表先渲染加载态而不是"无员工" */
    private loading = true;
    private modal:
        | 'new'
        | 'delete'
        | 'portrait'
        | 'installed-skills'
        | 'batch-skills'
        | 'skill-url'
        | 'skill-detail'
        | 'new-flow'
        | 'archive-flow'
        | 'delete-flow'
        | 'delete-flow-message'
        | null = null;
    private status = '';
    private previewHideTimer?: ReturnType<typeof setTimeout>;
    private portraitImage?: HTMLImageElement;
    private portraitZoom = 1;
    private portraitOffsetX = 0;
    private portraitOffsetY = 0;
    private portraitError = '';
    private autoSaveTimer?: ReturnType<typeof setTimeout>;
    private autoSaveIndicatorTimer?: ReturnType<typeof setTimeout>;
    private autoSaveRunning = false;
    private autoSaveState: AutoSaveState = 'idle';
    private autoSaveDetail = '';
    private readonly pendingAutoSaves = new Map<string, StaffUpdateInput>();
    private readonly failedAutoSaveStaffIds = new Set<string>();
    private readonly portraitCache = new Map<string, string>();
    private localAddresses: Array<{ address: string; name: string }> = [];
    private localServiceRuntime: LocalServiceRuntime | null = null;
    private localServicePending = false;
    private readonly onStaffsChanged = () => {
        void this.refreshStaffSummaries();
        if (this.flowFeatureEnabled) void this.reloadFlows();
    };
    private readonly onFlowsChanged = () => void this.reloadFlows();
    private readonly onFlowMessagesChanged = (flowId: string) => {
        if (this.activeTab === 'flows' && flowId === this.selectedFlow?.id) void this.loadFlowMessages();
    };
    private readonly onFlowReadingChanged = (flowId: string) => {
        if (flowId === this.selectedFlow?.id) void this.loadFlowReading();
    };
    private readonly flowEventHandlers = [
        ['flowsChanged', this.onFlowsChanged],
        ['flowMessagesChanged', this.onFlowMessagesChanged],
        ['flowReadingChanged', this.onFlowReadingChanged]
    ] as const;
    private subscribeFlowEvents(): void {
        if (!this.flowFeatureEnabled || this.flowEventsSubscribed || !this.isConnected) return;
        for (const [name, handler] of this.flowEventHandlers) window.applicationAPI.subscribe(name, handler);
        this.flowReadingTimer = setInterval(() => void this.loadFlowReading(), 15_000);
        this.flowEventsSubscribed = true;
    }
    private unsubscribeFlowEvents(): void {
        if (!this.flowEventsSubscribed) return;
        for (const [name, handler] of this.flowEventHandlers) window.applicationAPI.unsubscribe(name, handler);
        if (this.flowReadingTimer) clearInterval(this.flowReadingTimer);
        this.flowEventsSubscribed = false;
    }
    private readonly onMessagesChanged = (staffId: string) => {
        if (staffId !== this.selectedStaffId) return;
        if (this.activeTab === 'office') void this.loadMessages();
        else void this.refreshStaffSummaries();
    };
    private readonly onLocalServiceChanged = (staffId: string, runtime: LocalServiceRuntime) => {
        if (this.detail?.id !== staffId) return;
        // 服务重启（如切换 HTTPS）时的无错误 stopped 是过渡态：保持"正在应用"直到
        // 重新监听或报错，避免状态行在 运行→未启动→运行 之间闪一下
        if (this.localServicePending && !runtime.listening && !runtime.error) return;
        this.localServicePending = false;
        this.localServiceRuntime = runtime;
        this.updateLocalServiceStatusUI();
    };
    private readonly onThemeChanged = (event: Event) => {
        const detail = (event as CustomEvent<{ effective?: 'light' | 'dark' }>).detail;
        syncShadowHostTheme(this, detail?.effective);
        const skillDetail = this.shadowRoot?.querySelector<SkillDetailCard>('#staff-skill-detail-card');
        if (skillDetail && detail?.effective) skillDetail.dataset.theme = detail.effective;
    };
    private settingUnsubscribe?: () => void;
    /** 语言刷新串行化状态：running 表示取词在途；pending 表示在途期间又有语言变更，完成后需尾随取词 */
    private localeRefreshRunning = false;
    private localeRefreshPending = false;
    private readonly dismissMessageContextMenu = (event?: Event) => {
        const target = event?.composedPath()[0];
        if (target instanceof Element && target.closest('.ctx-menu')) return;
        this.shadowRoot?.querySelector('.ctx-menu')?.remove();
        window.removeEventListener('mousedown', this.dismissMessageContextMenu);
        window.removeEventListener('keydown', this.dismissContextMenuOnKeydown);
    };
    private readonly dismissContextMenuOnKeydown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') this.dismissMessageContextMenu();
    };
    /** Skill 添加菜单：点击菜单锚点以外或按 Escape 时关闭（菜单本体为 fixed 浮层） */
    private readonly closeSkillAddMenuOnOutside = (event: Event): void => {
        if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
        if (event instanceof MouseEvent) {
            const target = event.composedPath()[0];
            if (
                target instanceof Element &&
                (target.closest('.skills-add-anchor') || target.closest('.skills-add-menu'))
            )
                return;
        }
        this.closeSkillAddMenu();
    };
    private removeSkillAddMenuListeners(): void {
        document.removeEventListener('mousedown', this.closeSkillAddMenuOnOutside);
        document.removeEventListener('keydown', this.closeSkillAddMenuOnOutside);
    }
    private closeSkillAddMenu(): void {
        this.removeSkillAddMenuListeners();
        if (!this.skillAddMenuOpen) return;
        this.skillAddMenuOpen = false;
        this.shadowRoot?.querySelector('.skills-add-menu')?.remove();
    }

    /**
     * 以 fixed 浮层打开 Skill 添加菜单：详情内容区是 overflow:auto 的滚动容器，
     * 内联的 absolute 菜单会被裁剪到需要滚动才能看全，浮层贴着锚点按钮定位即可完整显示
     */
    private openSkillAddMenu(): void {
        if (!this.shadowRoot) return;
        this.shadowRoot.querySelector('.skills-add-menu')?.remove();
        const anchor = this.shadowRoot.querySelector<HTMLElement>('[data-action="toggle-skill-menu"]');
        const menu = document.createElement('div');
        menu.innerHTML = this.renderSkillAddMenu();
        const menuElement = menu.firstElementChild as HTMLElement | null;
        if (!menuElement || !anchor) return;
        this.shadowRoot.appendChild(menuElement);
        const rect = anchor.getBoundingClientRect();
        menuElement.style.position = 'fixed';
        menuElement.style.top = `${rect.bottom + 6}px`;
        menuElement.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;
        // 输入区贴近窗口底部时改为向上展开，避免菜单被视口截断
        const menuHeight = menuElement.getBoundingClientRect().height;
        if (rect.bottom + menuHeight + 8 > window.innerHeight) {
            menuElement.style.top = `${Math.max(8, rect.top - menuHeight - 6)}px`;
        }
        this.skillAddMenuOpen = true;
        this.bindSkillAddMenuActions(menuElement);
        setTimeout(() => {
            document.addEventListener('mousedown', this.closeSkillAddMenuOnOutside);
            document.addEventListener('keydown', this.closeSkillAddMenuOnOutside);
        }, 0);
    }

    /** Skill 添加菜单的动作项（浮层在渲染后才创建，动作绑定随元素一起进行） */
    private bindSkillAddMenuActions(menu: HTMLElement): void {
        menu.querySelector('[data-action="add-skill-directory"]')?.addEventListener('click', () => {
            this.closeSkillAddMenu();
            void this.addSkillFromDirectory();
        });
        menu.querySelector('[data-action="add-skill-zip"]')?.addEventListener('click', () => {
            this.closeSkillAddMenu();
            void this.addSkillFromZip();
        });
        menu.querySelector('[data-action="batch-import-skills"]')?.addEventListener('click', () => {
            this.closeSkillAddMenu();
            void this.openBatchSkillPicker();
        });
        menu.querySelector('[data-action="add-skill-url"]')?.addEventListener('click', () => {
            this.closeSkillAddMenu();
            this.skillUrl = '';
            this.skillModalError = '';
            this.modal = 'skill-url';
            this.render();
            this.shadowRoot?.querySelector<HTMLInputElement>('#skill-url-input')?.focus();
        });
        menu.querySelector('[data-action="add-installed-skills"]')?.addEventListener('click', () => {
            this.closeSkillAddMenu();
            void this.openInstalledSkillPicker();
        });
    }
    private readonly closeSendMenuHandler = (event?: Event) => {
        const target = event?.composedPath()[0];
        if (
            target instanceof Element &&
            (target.closest('.composer-send-options-panel') || target.closest('[data-action="send-menu"]'))
        )
            return;
        this.closeSendMenu();
    };
    private readonly closeSendMenuOnKeydown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') this.closeSendMenu();
    };

    connectedCallback(): void {
        if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
        if (this.selectedFlow && this.flowView === 'chat') this.flowScrollToBottomOnNextRender = true;
        syncShadowHostTheme(this);
        document.addEventListener(OPENDESK_THEME_CHANGED, this.onThemeChanged);
        window.applicationAPI.subscribe('staffsChanged', this.onStaffsChanged);
        window.applicationAPI.subscribe('messagesChanged', this.onMessagesChanged);
        window.applicationAPI.subscribe('staffTaskChanged', this.onStaffsChanged);
        window.applicationAPI.subscribe('localServiceChanged', this.onLocalServiceChanged);
        this.subscribeFlowEvents();
        void this.initialize();
    }

    disconnectedCallback(): void {
        if (this.previewHideTimer) clearTimeout(this.previewHideTimer);
        if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
        if (this.autoSaveIndicatorTimer) clearTimeout(this.autoSaveIndicatorTimer);
        window.removeEventListener('mousedown', this.dismissMessageContextMenu);
        this.removeSkillAddMenuListeners();
        this.closeSendMenu();
        this.settingUnsubscribe?.();
        this.settingUnsubscribe = undefined;
        void this.flushAutoSave();
        document.removeEventListener(OPENDESK_THEME_CHANGED, this.onThemeChanged);
        window.applicationAPI.unsubscribe('staffsChanged', this.onStaffsChanged);
        window.applicationAPI.unsubscribe('messagesChanged', this.onMessagesChanged);
        window.applicationAPI.unsubscribe('staffTaskChanged', this.onStaffsChanged);
        window.applicationAPI.unsubscribe('localServiceChanged', this.onLocalServiceChanged);
        this.unsubscribeFlowEvents();
    }

    private tr(key: string): string {
        return this.strings[key] ?? key;
    }

    /** 发送快捷键模式对应的 placeholder 模板（含 {iconEnter}/{iconShift} 图标占位） */
    private placeholderTemplate(): string {
        return this.ctrlEnterSend
            ? this.tr('agentoffice.messagePlaceholder.ctrlEnter')
            : this.tr('agentoffice.messagePlaceholder');
    }

    /** 纯文本 placeholder（移除图标占位符，用于原生 placeholder 属性与无障碍） */
    private getInputPlaceholder(): string {
        return this.placeholderTemplate()
            .replaceAll('{iconEnter}', '')
            .replaceAll('{iconShift}', '')
            .replaceAll('{iconCtrl}', '');
    }

    /** 富文本 placeholder（在键名占位处插入对应键图标） */
    private getPlaceholderHTML(): string {
        const tpl = this.placeholderTemplate();
        return escapeHtml(tpl)
            .replaceAll('{iconEnter}', `<span class="composer-placeholder-icon">${ENTER_KEY_ICON_SVG}</span>`)
            .replaceAll('{iconShift}', `<span class="composer-placeholder-icon">${SHIFT_KEY_ICON_SVG}</span>`)
            .replaceAll('{iconCtrl}', `<span class="composer-placeholder-icon">${CTRL_KEY_ICON_SVG}</span>`);
    }

    private formatText(key: string, values: Record<string, string | number>): string {
        let result = this.tr(key);
        for (const [name, value] of Object.entries(values)) {
            result = result.replaceAll(`\${${name}}`, String(value));
        }
        return result;
    }

    private async call<T>(method: string, ...args: unknown[]): Promise<T> {
        return unwrapAgentOfficeCallResult<T>(
            await window.applicationAPI.callMainWorld(method, ...args),
            this.tr('agentoffice.operationFailed')
        );
    }

    private async initialize(): Promise<void> {
        try {
            const [strings, locale, modelCatalog, flowFeature, localAddresses] = await Promise.all([
                this.call<Record<string, string>>('getLocalizedStrings'),
                this.call<string>('getLocale'),
                this.call<ModelCatalog>('listChatModels'),
                this.call<{ enabled: boolean }>('getFlowFeatureState'),
                this.call<Array<{ address: string; name: string }>>('listLocalAddresses')
            ]);
            this.strings = strings;
            this.locale = locale;
            this.modelCatalog = modelCatalog;
            this.flowFeatureEnabled = flowFeature.enabled;
            this.subscribeFlowEvents();
            this.localAddresses = localAddresses;
            // 本地化文案就绪后立即渲染壳（加载态），staff 数据继续异步加载
            this.render();
            await this.reloadStaffs();
            if (this.flowFeatureEnabled) await this.reloadFlows();
        } catch (error) {
            this.loading = false;
            this.status = `${this.tr('agentoffice.loadFailed')}: ${this.errorText(error)}`;
            this.render();
        } finally {
            this.subscribeSettingChanges();
        }
    }

    /** 初始化完成后订阅设置广播：设置界面切换语言时重拉文案并按新语言重建界面 */
    private subscribeSettingChanges(): void {
        // 初始化在途时元素可能已断连：此时不订阅（避免泄漏监听器），重连会重跑 initialize 再补上
        if (this.settingUnsubscribe || !this.isConnected) return;
        const unsubscribe = window.settingAPI?.onSettingChanged?.(this.onSettingChanged);
        if (typeof unsubscribe === 'function') this.settingUnsubscribe = unsubscribe;
    }

    private readonly onSettingChanged = (
        setting: Record<string, unknown> & { locale?: string; resolved_locale?: string }
    ) => {
        if (!this.isConnected) return;
        // 刷新在途时 this.locale 尚未反映最新广播，无法判重：记为待刷新，由在途取词完成后尾随一次
        if (this.localeRefreshRunning) {
            this.localeRefreshPending = true;
            return;
        }
        // frame 侧按广播数据快速判重（auto 模式取主进程解析结果），避免无关设置保存触发重拉
        if (resolveRendererLocale(setting) === this.locale) return;
        void this.applyLocaleChange();
    };

    /** 以主进程解析结果为准重拉文案表；详情表单/弹窗打开时推迟重渲染，避免丢草稿 */
    private async applyLocaleChange(): Promise<void> {
        // 刷新串行化：快速连续切换时旧请求可能后返回，尾随再取一次保证收敛到主进程最新语言
        if (this.localeRefreshRunning) {
            this.localeRefreshPending = true;
            return;
        }
        this.localeRefreshRunning = true;
        try {
            do {
                this.localeRefreshPending = false;
                const [strings, locale] = await Promise.all([
                    this.call<Record<string, string>>('getLocalizedStrings'),
                    this.call<string>('getLocale')
                ]);
                if (!this.isConnected) return;
                if (locale !== this.locale) {
                    this.strings = strings;
                    this.locale = locale;
                    if (this.canRenderInBackground()) this.render();
                }
            } while (this.localeRefreshPending);
        } catch {
            // 主进程回读失败时保持现有文案，等待下一次设置变更
        } finally {
            this.localeRefreshRunning = false;
        }
    }

    private async preloadPortraits(): Promise<void> {
        const uncached = this.staffs.filter((staff) => staff.portrait_url && !this.portraitCache.has(staff.id));
        await Promise.all(uncached.map((staff) => this.preloadPortrait(staff)));
    }

    private async preloadPortrait(staff: StaffListItem): Promise<void> {
        if (!staff.portrait_url) return;
        try {
            const response = await fetch(staff.portrait_url);
            const blob = await response.blob();
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            this.portraitCache.set(staff.id, dataUrl);
        } catch {
            this.portraitCache.set(staff.id, staff.portrait_url);
        }
    }

    private async reloadStaffs(): Promise<void> {
        this.staffs = await this.call('listStaffs');
        if (this.selectedStaffId && !this.staffs.some((staff) => staff.id === this.selectedStaffId)) {
            this.selectedStaffId = null;
            this.detail = null;
            this.messages = [];
        }
        if (!this.selectedStaffId && this.staffs.length > 0) this.selectedStaffId = this.staffs[0].id;
        this.loading = false;
        // 员工列表就绪即渲染；头像与聊天记录在后台补齐后再次渲染
        this.render();
        const portraitsDone = this.preloadPortraits().then(() => {
            if (this.canRenderInBackground()) this.render();
        });
        const detailsDone = (async () => {
            if (this.activeTab === 'office' && this.selectedStaffId) await this.loadMessages();
            if (this.activeTab === 'management' && this.detail) await this.openDetail(this.detail.id);
        })();
        await Promise.all([portraitsDone, detailsDone]);
    }

    /**
     * 后台数据补齐（头像/历史消息）完成时是否允许整体重渲染：
     * 详情表单与弹窗（如头像裁剪画布）持有 DOM 中的草稿状态，
     * 被后台渲染重建会导致未保存内容丢失，此时跳过重渲染，
     * 等用户下一次显式操作时自然会带上新数据渲染。
     */
    private canRenderInBackground(): boolean {
        return !this.detail && !this.modal && !(this.activeTab === 'flows' && this.selectedFlow);
    }

    private async refreshStaffSummaries(): Promise<void> {
        try {
            const previousStaffId = this.selectedStaffId;
            this.staffs = await this.call('listStaffs');
            if (this.selectedStaffId && !this.staffs.some((staff) => staff.id === this.selectedStaffId)) {
                this.selectedStaffId = null;
                this.detail = null;
                this.messages = [];
            }
            if (!this.selectedStaffId && this.staffs.length > 0) this.selectedStaffId = this.staffs[0].id;
            // 详情表单或弹窗打开时不整体重渲染，避免覆盖未保存的草稿
            if (this.canRenderInBackground()) this.render();
            const portraitsDone = this.preloadPortraits().then(() => {
                if (this.canRenderInBackground()) this.render();
            });
            const detailsDone = (async () => {
                if (this.activeTab === 'office' && this.selectedStaffId && this.selectedStaffId !== previousStaffId) {
                    await this.loadMessages();
                }
            })();
            await Promise.all([portraitsDone, detailsDone]);
        } catch (error) {
            this.status = `${this.tr('agentoffice.loadFailed')}: ${this.errorText(error)}`;
            if (this.canRenderInBackground()) this.render();
        }
    }

    private async reloadFlows(): Promise<void> {
        if (!this.flowFeatureEnabled) return;
        const selectedId = this.selectedFlow?.id;
        const previousStatus = this.selectedFlow?.status;
        this.flows = await this.call('listFlows', { status: this.flowStatusFilter });
        if (selectedId !== this.selectedFlow?.id) return;
        if (this.selectedFlow) {
            const selectedStillVisible = this.flows.some((flow) => flow.id === this.selectedFlow?.id);
            if (selectedStillVisible || this.flowStatusFilter === 'all') {
                const updated = await this.call<AgentFlowDetail>('getFlow', this.selectedFlow.id);
                if (selectedId !== this.selectedFlow?.id) return;
                this.selectedFlow = updated;
            } else {
                this.selectedFlow = null;
            }
        }
        if (!this.selectedFlow || this.selectedFlow.status !== previousStatus) this.render();
        else await this.loadFlowReading();
    }

    private rememberFlowDraft(): void {
        if (!this.selectedFlow) return;
        const input = this.shadowRoot?.querySelector<HTMLTextAreaElement>('#flow-message-input');
        this.flowDrafts.set(this.selectedFlow.id, {
            text: this.flowDraftText,
            attachments: [...this.flowAttachments],
            images: [...this.flowImageDataUris],
            reply: this.flowReplyToMessageId,
            caret: input ? [input.selectionStart, input.selectionEnd] : undefined,
            scroll: this.shadowRoot?.querySelector<HTMLElement>('.flow-message-list')?.scrollTop,
            oldestSequence: this.flowMessages[0]?.sequence
        });
    }

    private async openFlow(flowId: string): Promise<void> {
        this.status = '';
        this.rememberFlowDraft();
        const request = ++this.flowOpenRequest;
        try {
            const flow = await this.call<AgentFlowDetail>('getFlow', flowId);
            if (request !== this.flowOpenRequest) return;
            this.selectedFlow = flow;
            const draft = this.flowDrafts.get(flowId);
            this.flowDraftText = draft?.text ?? '';
            this.flowAttachments = draft?.attachments ?? [];
            this.flowImageDataUris = draft?.images ?? [];
            this.flowReadingView = undefined;
            this.flowHistoryFloor = draft?.oldestSequence;
            this.flowView = 'chat';
            this.flowMessages = [];
            this.flowReferencedMessages.clear();
            this.flowReplyToMessageId = draft?.reply;
            this.flowHistoryCursor = undefined;
            this.flowScrollToBottomOnNextRender = draft?.scroll === undefined;
            await this.loadFlowMessages();
            if (request !== this.flowOpenRequest) return;
            const list = this.shadowRoot?.querySelector<HTMLElement>('.flow-message-list');
            if (list && draft?.scroll !== undefined) list.scrollTop = draft.scroll;
            if (draft?.caret)
                this.shadowRoot
                    ?.querySelector<HTMLTextAreaElement>('#flow-message-input')
                    ?.setSelectionRange?.(...draft.caret);
        } catch (error) {
            this.status = `${this.tr('agentoffice.operationFailed')}: ${this.errorText(error)}`;
            this.render();
        }
    }

    private async loadFlowMessages(cursor?: string): Promise<void> {
        if (!this.selectedFlow) return;
        const flowId = this.selectedFlow.id;
        const request = ++this.flowMessagesRequest;
        const oldest = this.flowMessages[0]?.sequence ?? this.flowHistoryFloor;
        let next = cursor;
        let result: AgentFlowMessageHistoryResult;
        let messages: AgentFlowMessage[] = [];
        const references = new Map<string, AgentFlowMessage>();
        do {
            result = await this.call<AgentFlowMessageHistoryResult>('getFlowMessageHistory', flowId, {
                limit: 50,
                cursor: next
            });
            if (this.selectedFlow?.id !== flowId || request !== this.flowMessagesRequest) return;
            messages = [...result.messages, ...messages];
            for (const message of result.referencedMessages ?? []) references.set(message.id, message);
            next = result.nextCursor;
        } while (!cursor && result.hasMore && oldest !== undefined && (messages[0]?.sequence ?? Infinity) > oldest);
        this.flowMessages = [
            ...new Map(
                (cursor ? [...messages, ...this.flowMessages] : messages).map((message) => [message.id, message])
            ).values()
        ];
        if (!cursor) this.flowReferencedMessages.clear();
        for (const [id, message] of references) this.flowReferencedMessages.set(id, message);
        this.flowHistoryCursor = result.hasMore ? result.nextCursor : undefined;
        if (this.flowView === 'chat' && !this.modal) {
            const previousList = this.shadowRoot?.querySelector<HTMLElement>('.flow-message-list');
            const previousHeight = previousList?.scrollHeight ?? 0;
            const previousTop = previousList?.scrollTop ?? 0;
            this.render();
            const list = this.shadowRoot?.querySelector<HTMLElement>('.flow-message-list');
            if (cursor && list) list.scrollTop = previousTop + list.scrollHeight - previousHeight;
        }
        await this.loadFlowReading();
    }

    private async loadFlowReading(): Promise<void> {
        const flowId = this.selectedFlow?.id;
        if (!flowId || this.activeTab !== 'flows') return;
        const request = ++this.flowReadingRequest;
        try {
            const view = await this.call<FlowReadingView>('getFlowReadingView', flowId);
            if (this.selectedFlow?.id !== flowId || request !== this.flowReadingRequest) return;
            this.flowReadingView = view;
            // Patch only receipts and scheduler information; leave the composer and unsaved forms intact.
            this.shadowRoot?.querySelectorAll<HTMLElement>('[data-flow-receipt]').forEach((element) => {
                element.innerHTML = this.renderFlowReceipt(element.dataset.flowReceipt!);
            });
            const settings = this.shadowRoot?.querySelector<HTMLElement>('[data-reading-settings]');
            if (settings) this.updateFlowReadingSettings(settings);
        } catch (error) {
            if (this.selectedFlow?.id === flowId) this.showFlowOperationError(error);
        }
    }

    private showFlowOperationError(error: unknown): void {
        this.status = `${this.tr('agentoffice.operationFailed')}: ${this.errorText(error)}`;
        const notice = this.shadowRoot?.querySelector<HTMLElement>('.detail-notice');
        if (notice) {
            notice.textContent = this.status;
            notice.hidden = false;
        }
    }

    private renderFlowReceipt(messageId: string): string {
        const receipt = this.flowReadingView?.receipts[messageId];
        if (!receipt) return `<summary>${escapeHtml(this.tr('agentoffice.flow.reading.loading'))}</summary>`;
        return `<summary>${escapeHtml(this.formatText('agentoffice.flow.reading.count', { read: receipt.read, total: receipt.total }))}</summary><div class="flow-receipt-details"><p>${escapeHtml(this.tr('agentoffice.flow.reading.denominator'))}</p>${receipt.members
            .map((item) => {
                const member = this.flowReadingView!.members.find((entry) => entry.staffId === item.staffId)!;
                return `<div>${escapeHtml(member.name ?? this.tr('agentoffice.flow.memberMissing'))} · ${escapeHtml(this.tr(`agentoffice.flow.reading.${item.status}`))}${member.availability === 'active' ? '' : ` · ${escapeHtml(this.tr(`agentoffice.flow.reading.${member.availability}`))}`}</div>`;
            })
            .join('')}</div>`;
    }

    private renderFlowReadingSettings(): string {
        const view = this.flowReadingView;
        if (!view) return escapeHtml(this.tr('agentoffice.flow.reading.loading'));
        const editable = this.selectedFlow?.status === 'active' && !view.deleting;
        return `<h3>${escapeHtml(this.tr('agentoffice.flow.reading.settings'))}</h3><p>${escapeHtml(this.tr(`agentoffice.flow.reading.${view.mode}`))}</p>${view.members.map((member) => `<div class="flow-reading-member"><b>${escapeHtml(member.name ?? this.tr('agentoffice.flow.memberMissing'))}</b><span>${escapeHtml(this.tr(`agentoffice.flow.reading.${member.availability}`))}</span>${editable && member.availability !== 'left' ? `<label>${escapeHtml(this.tr('agentoffice.flow.reading.period'))}<select data-flow-interval="${escapeHtml(member.staffId)}">${[5, 10, 15, 20, 30, 60].map((minutes) => `<option value="${minutes}" ${minutes === member.intervalMinutes ? 'selected' : ''}>${escapeHtml(this.formatText('agentoffice.flow.reading.minutes', { minutes }))}</option>`).join('')}</select></label>` : `<span>${escapeHtml(this.formatText('agentoffice.flow.reading.minutes', { minutes: member.intervalMinutes }))}</span>`}<span data-reading-next="${escapeHtml(member.staffId)}">${this.renderNextReading(member)}</span>${editable && member.retryBatchId ? `<button class="secondary" data-reading-retry="${escapeHtml(member.staffId)}" data-batch-id="${escapeHtml(member.retryBatchId)}">${escapeHtml(this.tr('agentoffice.flow.reading.retry'))}</button>` : ''}</div>`).join('')}<p>${escapeHtml(this.tr('agentoffice.flow.reading.retryHint'))}</p>`;
    }

    private renderNextReading(member: FlowReadingView['members'][number]): string {
        return escapeHtml(
            member.nextTriggerAt
                ? this.formatText('agentoffice.flow.reading.next', {
                      time: new Date(member.nextTriggerAt).toLocaleString(this.locale)
                  })
                : this.tr('agentoffice.flow.reading.noTimer')
        );
    }

    private updateFlowReadingSettings(element: HTMLElement): void {
        // Preserve a focused period select while refreshing clock labels. Rebuild after it loses focus.
        if (element.contains(this.shadowRoot?.activeElement ?? null)) {
            for (const member of this.flowReadingView?.members ?? []) {
                const label = element.querySelector<HTMLElement>(`[data-reading-next="${member.staffId}"]`);
                if (label) label.innerHTML = this.renderNextReading(member);
            }
            return;
        }
        element.innerHTML = this.renderFlowReadingSettings();
        this.bindFlowReadingSettings();
    }

    private bindFlowReadingSettings(): void {
        this.shadowRoot?.querySelectorAll<HTMLSelectElement>('[data-flow-interval]').forEach((select) =>
            select.addEventListener('change', async () => {
                const flowId = this.selectedFlow?.id;
                if (!flowId) return;
                select.disabled = true;
                try {
                    await this.call(
                        'setFlowReadingInterval',
                        flowId,
                        select.dataset.flowInterval,
                        Number(select.value)
                    );
                    await this.loadFlowReading();
                } catch (error) {
                    this.showFlowOperationError(error);
                } finally {
                    select.disabled = false;
                }
            })
        );
        this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-reading-retry]').forEach((button) =>
            button.addEventListener('click', async () => {
                const flowId = this.selectedFlow?.id;
                if (!flowId) return;
                button.disabled = true;
                try {
                    const result = await this.call<{ status: string }>(
                        'retryFlowReading',
                        flowId,
                        button.dataset.readingRetry,
                        button.dataset.batchId
                    );
                    if (this.selectedFlow?.id !== flowId) return;
                    if (result.status === 'busy') this.showFlowOperationError(this.tr('agentoffice.flow.reading.busy'));
                    await this.loadFlowReading();
                } catch (error) {
                    this.showFlowOperationError(error);
                } finally {
                    button.disabled = false;
                }
            })
        );
    }

    private filterFlowCards(): void {
        const query = this.flowQuery.trim().toLocaleLowerCase();
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-flow-detail]').forEach((element) => {
            element.hidden = Boolean(query) && !(element.dataset.flowSearch ?? '').includes(query);
        });
    }

    private async loadMessages(cursor?: string): Promise<void> {
        if (!this.selectedStaffId) return;
        const result = await this.call<{ messages: StaffMessage[]; has_more: boolean; next_cursor?: string }>(
            'getHistoryMessagesForUI',
            this.selectedStaffId,
            { mode: 'recent', limit: 50, cursor }
        );
        this.messages = cursor ? [...result.messages, ...this.messages] : result.messages;
        this.historyCursor = result.next_cursor;
        // 渐进加载期间用户可能已打开详情表单/弹窗，此时跳过重渲染，状态已更新，
        // 关闭弹窗（closeModal）或下一次用户操作时会带上新消息渲染
        if (this.canRenderInBackground()) this.render();
        if (!cursor) requestAnimationFrame(() => this.scrollMessages());
    }

    private render(): void {
        if (!this.shadowRoot) return;
        const flowInput = this.shadowRoot.querySelector<HTMLTextAreaElement>('#flow-message-input');
        const flowCaret =
            flowInput && this.shadowRoot.activeElement === flowInput
                ? { start: flowInput.selectionStart, end: flowInput.selectionEnd }
                : undefined;
        const currentFlowMessageList = this.shadowRoot.querySelector<HTMLElement>('.flow-message-list');
        const flowScrollState = currentFlowMessageList
            ? {
                  top: currentFlowMessageList.scrollTop ?? 0,
                  atBottom:
                      (currentFlowMessageList.scrollHeight ?? 0) -
                          (currentFlowMessageList.clientHeight ?? 0) -
                          (currentFlowMessageList.scrollTop ?? 0) <=
                      2
              }
            : undefined;
        this.closeSendMenu();
        // 整树重建会带走 fixed 浮层，菜单状态一并复位
        this.closeSkillAddMenu();
        // 后台事件（staffsChanged 等）会触发整树重渲染，正在输入的消息草稿
        // 需要跨渲染保留：重建前暂存值/光标/焦点，重建后恢复。
        const draftInput = this.shadowRoot.querySelector<HTMLTextAreaElement>('#message-input');
        const draft =
            draftInput && draftInput.value
                ? {
                      value: draftInput.value,
                      start: draftInput.selectionStart ?? draftInput.value.length,
                      end: draftInput.selectionEnd ?? draftInput.value.length,
                      focused: this.shadowRoot.activeElement === draftInput
                  }
                : null;
        // 消息区滚动位置同理：后台重渲染若不恢复，会从贴底跳回最旧消息
        const prevMessagesBox = this.shadowRoot.querySelector<HTMLElement>('#messages');
        const messagesScrollTop = prevMessagesBox ? prevMessagesBox.scrollTop : 0;
        this.shadowRoot.innerHTML = `<style>${contextMenuCss}${css}${OVERLAY_CSS}</style><div class="root ${this.busy ? 'busy' : ''}">
            <div class="tabs">
                <div class="tab-group">
                    ${this.tabButton('office', this.tr('agentoffice.tab.office'))}
                    ${this.tabButton('management', this.tr('agentoffice.tab.management'))}
                    ${this.flowFeatureEnabled ? this.tabButton('flows', this.tr('agentoffice.flow.tab')) : ''}
                </div>
            </div>
            <div class="body">${this.renderActiveTab()}</div>
            ${this.renderModal()}
        </div>`;
        if (draft) {
            const input = this.shadowRoot.querySelector<HTMLTextAreaElement>('#message-input');
            if (input) {
                input.value = draft.value;
                try {
                    input.setSelectionRange(draft.start, draft.end);
                } catch {
                    // linkedom 等测试环境不支持 setSelectionRange 时忽略
                }
                if (draft.focused) input.focus();
            }
            this.updateSendButtonState();
        }
        const messagesBox = this.shadowRoot.querySelector<HTMLElement>('#messages');
        if (messagesBox) messagesBox.scrollTop = messagesScrollTop;
        this.bindEvents();
        this.bindFlowReadingSettings();
        if (flowCaret && !this.modal) {
            const input = this.shadowRoot.querySelector<HTMLTextAreaElement>('#flow-message-input');
            input?.focus();
            input?.setSelectionRange(flowCaret.start, flowCaret.end);
        }
        const nextFlowMessageList = this.shadowRoot.querySelector<HTMLElement>('.flow-message-list');
        if (nextFlowMessageList) {
            const scrollToBottom = this.flowScrollToBottomOnNextRender;
            nextFlowMessageList.scrollTop =
                scrollToBottom || flowScrollState?.atBottom
                    ? nextFlowMessageList.scrollHeight
                    : (flowScrollState?.top ?? nextFlowMessageList.scrollHeight);
            if (scrollToBottom) {
                const flowId = this.selectedFlow?.id;
                this.flowScrollToBottomOnNextRender = false;
                requestAnimationFrame(() => {
                    if (flowId !== this.selectedFlow?.id || this.flowView !== 'chat') return;
                    const current = this.shadowRoot?.querySelector<HTMLElement>('.flow-message-list');
                    if (current) current.scrollTop = current.scrollHeight;
                });
            }
        }
    }

    private renderActiveTab(): string {
        if (this.activeTab === 'office') return this.renderOffice();
        if (this.activeTab === 'management') return this.renderManagement();
        return this.renderFlows();
    }

    private tabButton(id: AgentOfficeTab, label: string): string {
        return `<button class="tab ${this.activeTab === id ? 'active' : ''}" data-tab="${id}" aria-pressed="${this.activeTab === id}">${escapeHtml(label)}</button>`;
    }

    private renderOffice(): string {
        if (this.staffs.length === 0) {
            if (this.loading) {
                return `<div class="empty"><div>${escapeHtml(this.tr('agentoffice.loading'))}</div></div>`;
            }
            return `<div class="empty"><div><h3>${escapeHtml(this.tr('agentoffice.noStaff'))}</h3><p>${escapeHtml(this.tr('agentoffice.noStaffHint'))}</p><button class="primary" data-tab="management">${escapeHtml(this.tr('agentoffice.tab.management'))}</button></div></div>`;
        }
        const staff = this.staffs.find((item) => item.id === this.selectedStaffId) ?? this.staffs[0];
        const normalizedQuery = this.query.trim().toLowerCase();
        const statusClass = staff.active_task_id ? 'run' : staff.enabled ? 'on' : '';
        const statusText = staff.active_task_id
            ? this.tr('agentoffice.running')
            : staff.enabled
              ? this.tr('agentoffice.enabled')
              : this.tr('agentoffice.disabled');
        const specialtyChip = staff.specialties[0]
            ? `<span class="pill accent">${escapeHtml(staff.specialties[0])}</span>`
            : '';
        const meta = [
            staff.title,
            this.formatText('agentoffice.metaSkills', { count: staff.skill_count }),
            this.formatText('agentoffice.onboardDays', { days: this.onboardDays(staff.hired_at) }),
            `${this.formatTokens(staff.usage_summary?.total_tokens ?? 0)} ${this.tr('agentoffice.tokensStat')}`
        ]
            .map((part) => escapeHtml(part))
            .join(' \u00b7 ');
        return `<div class="office">
            <section class="chat">
                <header class="chat-head"><div class="chat-head-main">${this.avatar(staff, 'lg')}<div class="chat-who"><h2 class="chat-title">${escapeHtml(staff.name)}${specialtyChip}</h2><div class="detail-subtitle"><span class="status-dot ${statusClass}"></span><span class="truncate">${escapeHtml(statusText)} · ${meta}</span></div></div></div><div class="chat-head-actions">${this.renderChatModelSelect(staff)}</div></header>
                <div class="messages" id="messages">${this.renderMessages(staff.id)}</div>
                <div class="composer-wrap">
                    ${this.status ? `<div class="notice">${escapeHtml(this.status)}</div>` : ''}
                    <div class="composer-outer" id="composer-outer">
                        <div class="composer-card">
                            ${this.imageDataUris.length ? `<div class="composer-image-previews">${this.imageDataUris.map((img, index) => `<div class="composer-image-thumb"><img src="${img.dataUrl}" alt="${escapeHtml(img.name)}" data-image-preview="${index}"><button class="composer-image-thumb-remove" data-remove-image="${index}"><i class="fa-solid fa-xmark"></i></button></div>`).join('')}</div>` : ''}
                            <div class="composer-textarea-wrap"><div class="composer-placeholder-wrap"><textarea id="message-input" class="composer-textarea" placeholder="${escapeHtml(this.getInputPlaceholder())}" ${staff.enabled ? '' : 'disabled'}></textarea><div id="composer-placeholder" class="composer-placeholder" aria-hidden="true">${this.getPlaceholderHTML()}</div></div></div>
                            <div class="composer-toolbar">
                                <div class="composer-toolbar-left">
                                    <button class="composer-toolbar-control" data-action="attach" title="${escapeHtml(this.tr('agentoffice.attach'))}"><i class="fa-solid fa-paperclip"></i></button>
                                    ${this.attachments.map((item, index) => `<div class="composer-file-tag"><i class="fa-solid fa-paperclip"></i><span>${escapeHtml(item.name)}</span><button data-remove-attachment="${index}"><i class="fa-solid fa-xmark"></i></button></div>`).join('')}
                                </div>
                                <div class="composer-toolbar-right">
                                    <div class="composer-send-group"><button class="composer-send-btn composer-send-inactive" data-action="send" ${staff.enabled ? '' : 'disabled'}><i class="fa-solid fa-arrow-up"></i><span>${escapeHtml(this.tr('agentoffice.send'))}</span></button><div class="composer-send-divider"></div><button class="composer-send-menu-btn composer-send-inactive" data-action="send-menu" title="${escapeHtml(this.tr('agentoffice.sendOptions'))}" ${staff.enabled ? '' : 'disabled'}><i class="fa-solid fa-ellipsis"></i></button></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>
            <aside class="staff-panel"><div class="panel-head"><h2 class="panel-title">${escapeHtml(this.tr('agentoffice.staffPanelTitle'))}</h2><button class="icon-btn" data-action="new" title="${escapeHtml(this.tr('agentoffice.newStaff'))}" aria-label="${escapeHtml(this.tr('agentoffice.newStaff'))}"><i class="fa-solid fa-plus"></i></button></div><label class="search-field"><i class="fa-solid fa-magnifying-glass"></i><input class="search" id="staff-search" value="${escapeHtml(this.query)}" placeholder="${escapeHtml(this.tr('agentoffice.searchStaff'))}"></label><div class="list-label"><i class="fa-solid fa-user-group"></i>${escapeHtml(this.tr('agentoffice.allStaff'))} · ${this.staffs.length}</div><div class="staff-list">${this.staffs
                .map((item) => {
                    const searchText = `${item.name} ${item.title}`.toLowerCase();
                    return `<button class="staff-row ${item.id === staff.id ? 'active' : ''}" data-staff="${item.id}" data-search-text="${escapeHtml(searchText)}" aria-current="${item.id === staff.id}" ${normalizedQuery && !searchText.includes(normalizedQuery) ? 'hidden' : ''}><span class="staff-avatar-trigger" data-staff-preview="${item.id}">${this.avatar(item)}</span><span class="staff-copy"><b class="ellipsis">${escapeHtml(item.name)}</b><span class="sub"><span class="status-dot ${item.active_task_id ? 'run' : item.enabled ? 'on' : ''}"></span><span class="ellipsis">${escapeHtml(item.title)}</span></span></span></button>`;
                })
                .join(
                    ''
                )}<div class="search-empty" data-search-empty ${normalizedQuery ? '' : 'hidden'}>${escapeHtml(this.tr('agentoffice.noStaffFound'))}</div></div><div class="panel-footer"><i class="fa-solid fa-shield"></i><span class="truncate">${escapeHtml(this.tr('agentoffice.staffPanelFooter'))}</span></div></aside><div class="card staff-preview" id="staff-preview" hidden></div>
        </div>`;
    }

    private avatar(staff: StaffListItem, size: '' | 'lg' = ''): string {
        const gradient = AVATAR_GRADIENTS[this.avatarGradientIndex(staff.name)];
        const portraitSrc = staff.portrait_url ? (this.portraitCache.get(staff.id) ?? staff.portrait_url) : null;
        const inner = portraitSrc
            ? `<img class="avatar-img" src="${escapeHtml(portraitSrc)}" alt="">`
            : escapeHtml(staff.name.slice(0, 1).toUpperCase());
        return `<span class="avatar ${gradient}${size ? ` ${size}` : ''}">${inner}</span>`;
    }

    private avatarGradientIndex(name: string): number {
        // 旧实现 (hash*31+cp)%997 再取模会让常见中文姓名扎堆同一色调，
        // 这里加 murmur 风格的雪崩混合让色调分布更均匀。
        let hash = 0;
        for (const char of name) hash = (hash * 131 + (char.codePointAt(0) ?? 0)) >>> 0;
        hash = (hash ^ (hash >>> 13)) * 0x5bd1e995;
        hash = (hash ^ (hash >>> 15)) >>> 0;
        return hash % AVATAR_GRADIENTS.length;
    }

    private onboardDays(hiredAt: string): number {
        const hired = new Date(hiredAt).getTime();
        if (Number.isNaN(hired)) return 0;
        return Math.max(0, Math.floor((Date.now() - hired) / 86_400_000));
    }

    private formatTokens(value: number): string {
        if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
        if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
        return String(value);
    }

    private renderChatModelSelect(staff: StaffListItem): string {
        const defaultLabel = this.modelCatalog.default_model
            ? `${this.tr('agentoffice.modelGlobalDefault')} (${this.modelCatalog.default_model})`
            : this.tr('agentoffice.modelGlobalDefault');
        const missing =
            staff.model && !this.modelCatalog.models.some((model) => model.alias === staff.model)
                ? `<option value="${escapeHtml(staff.model)}" selected>${escapeHtml(staff.model)}</option>`
                : '';
        const options = this.modelCatalog.models
            .map((model) => {
                const title = `${model.provider_name} / ${model.model_name}`;
                return `<option value="${escapeHtml(model.alias)}" title="${escapeHtml(title)}" ${staff.model === model.alias ? 'selected' : ''}>${escapeHtml(model.alias)}</option>`;
            })
            .join('');
        return `<label class="chat-model" title="${escapeHtml(this.tr('agentoffice.modelHint'))}"><span class="chat-model-label">${escapeHtml(this.tr('agentoffice.modelShort'))}</span><span class="chat-model-dot"></span><select id="chat-model-select"><option value="">${escapeHtml(defaultLabel)}</option>${missing}${options}</select></label>`;
    }

    private renderMessages(staffId: string): string {
        if (this.messages.length === 0)
            return `<div class="empty">${escapeHtml(this.tr('agentoffice.noMessages'))}</div>`;
        return `${this.historyCursor ? `<button class="load-older" data-action="older">${escapeHtml(this.tr('agentoffice.loadOlder'))}</button>` : ''}${this.messages
            .map((message) => {
                const parts = message.content
                    .map((part) => {
                        if (part.type === 'text')
                            return `<div class="message-markdown markdown-body">${renderSafeMarkdown(part.text)}</div>`;
                        const url = `agentoffice://resource/${staffId}/${part.path}`;
                        if (part.media_type === 'image')
                            return `<div class="resource"><img src="${escapeHtml(url)}" alt="${escapeHtml(part.name)}"></div>`;
                        if (part.media_type === 'video')
                            return `<div class="resource"><video controls src="${escapeHtml(url)}"></video></div>`;
                        if (part.media_type === 'audio')
                            return `<div class="resource"><audio controls src="${escapeHtml(url)}"></audio></div>`;
                        return `<div class="resource"><a href="${escapeHtml(url)}" target="_blank">📎 ${escapeHtml(part.name)}</a></div>`;
                    })
                    .join('');
                return `<div class="message ${message.role} ${message.kind === 'error' ? 'error' : ''}" data-message-id="${escapeHtml(message.id)}" data-message-task="${escapeHtml(message.task_id)}">${parts}<div class="message-meta"><span>${escapeHtml(new Date(message.created_at).toLocaleString(this.locale))}</span></div></div>`;
            })
            .join('')}`;
    }

    private renderManagement(): string {
        if (this.detail) return `<div class="management management-detail">${this.renderDetail()}</div>`;
        return `<div class="management"><section class="management-panel"><div class="toolbar"><div class="toolbar-heading"><span class="toolbar-title">${escapeHtml(this.tr('agentoffice.tab.management'))}</span>${this.status ? `<span class="notice">${escapeHtml(this.status)}</span>` : ''}</div><div class="toolbar-actions"><button class="secondary" data-action="import">${escapeHtml(this.tr('agentoffice.importZip'))}</button><button class="primary" data-action="new">${escapeHtml(this.tr('agentoffice.newStaff'))}</button></div></div>${
            this.staffs.length === 0
                ? `<div class="empty">${escapeHtml(this.loading ? this.tr('agentoffice.loading') : this.tr('agentoffice.noStaffHint'))}</div>`
                : `<div class="grid">${this.staffs.map((staff) => `<button class="card" data-detail="${staff.id}">${this.staffCardContent(staff)}</button>`).join('')}</div>`
        }</section></div>`;
    }

    private renderFlows(): string {
        if (this.selectedFlow) return `<div class="management management-detail">${this.renderFlowDetail()}</div>`;
        const cards = this.flows
            .map((flow) => {
                const searchText = `${flow.name} ${flow.goal}`.toLocaleLowerCase();
                const hidden = this.flowQuery.trim() && !searchText.includes(this.flowQuery.trim().toLocaleLowerCase());
                return `<button class="card flow-card" data-flow-detail="${escapeHtml(flow.id)}" data-flow-search="${escapeHtml(searchText)}" ${hidden ? 'hidden' : ''}>
                    <div class="flow-card-head"><div><h3>${escapeHtml(flow.name)}</h3><span class="sub">${escapeHtml(this.tr(`agentoffice.flow.status.${flow.status}`))}</span></div><span class="flow-member-count">${escapeHtml(this.formatText('agentoffice.flow.memberCount', { count: flow.memberCount }))}</span></div>
                    <p>${escapeHtml(flow.goal)}</p>
                    ${flow.missingMemberCount > 0 ? `<span class="flow-warning">${escapeHtml(this.formatText('agentoffice.flow.missingMemberCount', { count: flow.missingMemberCount }))}</span>` : ''}
                </button>`;
            })
            .join('');
        return `<div class="management"><section class="management-panel"><div class="toolbar flow-toolbar"><div><span class="toolbar-title">${escapeHtml(this.tr('agentoffice.flow.tab'))}</span>${this.status ? `<span class="notice">${escapeHtml(this.status)}</span>` : ''}</div><div class="toolbar-actions"><button class="primary" data-action="new-flow"><i class="fa-solid fa-plus"></i>${escapeHtml(this.tr('agentoffice.flow.new'))}</button></div></div><div class="flow-filters"><input class="search" id="flow-search" value="${escapeHtml(this.flowQuery)}" placeholder="${escapeHtml(this.tr('agentoffice.flow.search'))}"><select id="flow-status-filter" aria-label="${escapeHtml(this.tr('agentoffice.flow.filterStatus'))}">${(['active', 'paused', 'archived', 'all'] as FlowListStatus[]).map((status) => `<option value="${status}" ${this.flowStatusFilter === status ? 'selected' : ''}>${escapeHtml(this.tr(`agentoffice.flow.filter.${status}`))}</option>`).join('')}</select></div>${this.flows.length === 0 ? `<div class="empty">${escapeHtml(this.tr('agentoffice.flow.empty'))}</div>` : `<div class="grid flow-grid">${cards}</div>`}</section></div>`;
    }

    private renderFlowDetail(): string {
        const flow = this.selectedFlow!;
        const archived = flow.status === 'archived';
        const viewAction =
            this.flowView === 'chat'
                ? `<button class="secondary flow-view-button" data-action="flow-settings" title="${escapeHtml(this.tr('agentoffice.flow.settings'))}">${renderIcon('fa-gear')}<span>${escapeHtml(this.tr('agentoffice.flow.settings'))}</span></button>`
                : `<button class="secondary flow-view-button" data-action="flow-chat" title="${escapeHtml(this.tr('agentoffice.flow.chat'))}">${renderIcon('fa-users')}<span>${escapeHtml(this.tr('agentoffice.flow.chat'))}</span></button>`;
        const settingsActions =
            this.flowView === 'settings' && !archived
                ? `<button class="danger" data-action="archive-flow">${escapeHtml(this.tr('agentoffice.flow.archive'))}</button><button class="primary" data-action="save-flow">${escapeHtml(this.tr('agentoffice.save'))}</button>`
                : '';
        return `<section class="detail flow-detail"><div class="detail-head"><div class="flow-detail-title"><button class="secondary icon-button" data-action="back-flow" title="${escapeHtml(this.tr('agentoffice.back'))}" aria-label="${escapeHtml(this.tr('agentoffice.back'))}"><i class="fa-solid fa-arrow-left"></i></button><div><b>${escapeHtml(flow.name)}</b><div class="sub">${escapeHtml(flow.goal)}</div></div></div><div class="toolbar-actions">${viewAction}${archived ? `<button class="danger" data-action="delete-flow">${escapeHtml(this.tr('agentoffice.flow.delete'))}</button>` : ''}${settingsActions}</div></div><p class="detail-notice" role="alert" ${this.status ? '' : 'hidden'}>${escapeHtml(this.status)}</p>${this.flowView === 'chat' ? this.renderFlowChat(flow, archived) : this.renderFlowSettings(flow, archived)}</section>`;
    }

    private renderFlowSettings(flow: AgentFlowDetail, archived: boolean): string {
        const currentMemberIds = new Set(flow.memberIds);
        const existingRows = this.staffs
            .map(
                (staff) =>
                    `<label class="flow-member-row"><input type="checkbox" data-flow-member="${escapeHtml(staff.id)}" ${currentMemberIds.has(staff.id) ? 'checked' : ''} ${archived ? 'disabled' : ''}><span><b>${escapeHtml(staff.name)}</b><span>${escapeHtml(staff.title)}</span></span></label>`
            )
            .join('');
        const missingRows = flow.members
            .filter((member) => member.missing)
            .map(
                (member) =>
                    `<label class="flow-member-row missing"><input type="checkbox" data-flow-member="${escapeHtml(member.staffId)}" checked ${archived ? 'disabled' : ''}><span><b>${escapeHtml(this.tr('agentoffice.flow.memberMissing'))}</b><span>${escapeHtml(member.staffId)}</span></span></label>`
            )
            .join('');
        return `<div class="detail-content flow-detail-content"><section class="settings-section"><div class="form-grid settings-form"><div class="field"><label for="flow-name">${escapeHtml(this.tr('agentoffice.flow.name'))}</label><input id="flow-name" maxlength="100" value="${escapeHtml(flow.name)}" ${archived ? 'disabled' : ''}></div><div class="field full"><label for="flow-goal">${escapeHtml(this.tr('agentoffice.flow.goal'))}</label><textarea id="flow-goal" maxlength="4000" ${archived ? 'disabled' : ''}>${escapeHtml(flow.goal)}</textarea></div></div></section><section class="settings-section"><div class="settings-section-head"><h3 class="settings-section-title">${escapeHtml(this.tr('agentoffice.flow.members'))}</h3><span class="sub">${escapeHtml(this.formatText('agentoffice.flow.revision', { revision: flow.revision }))}</span></div><div class="flow-member-list">${missingRows}${existingRows}</div></section><section class="settings-section" data-reading-settings>${this.renderFlowReadingSettings()}</section></div>`;
    }

    private renderFlowChat(flow: AgentFlowDetail, archived: boolean): string {
        const messages = this.flowMessages.length
            ? this.flowMessages.map((message) => this.renderFlowMessage(flow, message)).join('')
            : `<div class="empty flow-chat-empty">${escapeHtml(this.tr('agentoffice.flow.chatEmpty'))}</div>`;
        const mentions = flow.members
            .filter((member) => !member.missing)
            .map(
                (member) =>
                    `<button class="flow-mention" data-flow-mention="${escapeHtml(member.staffId)}" ${member.enabled ? '' : 'disabled'}>@${escapeHtml(member.name ?? member.staffId)}</button>`
            )
            .join('');
        const attachments = this.flowAttachments
            .map(
                (item, index) =>
                    `<div class="composer-file-tag"><i class="fa-solid fa-paperclip"></i><span>${escapeHtml(item.name)}</span><button data-remove-flow-attachment="${index}" title="${escapeHtml(this.tr('agentoffice.close'))}"><i class="fa-solid fa-xmark"></i></button></div>`
            )
            .join('');
        const images = this.flowImageDataUris.length
            ? `<div class="composer-image-previews">${this.flowImageDataUris.map((image, index) => `<div class="composer-image-thumb"><img src="${image.dataUrl}" alt="${escapeHtml(image.name)}"><button class="composer-image-thumb-remove" data-remove-flow-image="${index}" title="${escapeHtml(this.tr('agentoffice.close'))}"><i class="fa-solid fa-xmark"></i></button></div>`).join('')}</div>`
            : '';
        const sendDisabled = this.busy;
        const replyMessage = this.flowReplyToMessageId ? this.findFlowMessage(this.flowReplyToMessageId) : undefined;
        const replyPreview = this.flowReplyToMessageId
            ? `<div class="flow-composer-reply"><div class="flow-reply-copy">${replyMessage ? `<b>${escapeHtml(this.flowMessageSender(flow, replyMessage))}</b><span>${escapeHtml(this.flowMessageExcerpt(replyMessage))}</span>` : `<span>${escapeHtml(this.tr('agentoffice.flow.message.deletedReference'))}</span>`}</div><button class="flow-reply-close" data-action="cancel-flow-reply" title="${escapeHtml(this.tr('agentoffice.close'))}" aria-label="${escapeHtml(this.tr('agentoffice.close'))}"><i class="fa-solid fa-xmark"></i></button></div>`
            : '';
        const composer = archived
            ? ''
            : `<div class="flow-composer" id="flow-composer"><div class="composer-outer"><div class="composer-card"><div class="flow-mention-bar">${mentions}</div>${images}${replyPreview}<div class="composer-textarea-wrap"><textarea id="flow-message-input" class="composer-textarea" maxlength="100000" placeholder="${escapeHtml(this.tr('agentoffice.flow.messagePlaceholder'))}">${escapeHtml(this.flowDraftText)}</textarea></div><div class="composer-toolbar"><div class="composer-toolbar-left"><button class="composer-toolbar-control" data-action="flow-attach" title="${escapeHtml(this.tr('agentoffice.attach'))}" aria-label="${escapeHtml(this.tr('agentoffice.attach'))}"><i class="fa-solid fa-paperclip"></i></button>${attachments}</div><div class="composer-toolbar-right"><div class="composer-send-group"><button class="composer-send-btn ${sendDisabled ? 'composer-send-inactive' : 'composer-send-active'}" data-action="flow-send" title="${escapeHtml(this.tr('agentoffice.send'))}" ${sendDisabled ? 'disabled' : ''}><i class="fa-solid fa-arrow-up"></i><span>${escapeHtml(this.tr('agentoffice.send'))}</span></button><div class="composer-send-divider"></div><button class="composer-send-menu-btn ${sendDisabled ? 'composer-send-inactive' : 'composer-send-active'}" data-action="send-menu" title="${escapeHtml(this.tr('agentoffice.sendOptions'))}" aria-label="${escapeHtml(this.tr('agentoffice.sendOptions'))}" ${sendDisabled ? 'disabled' : ''}><i class="fa-solid fa-ellipsis"></i></button></div></div></div></div></div></div>`;
        return `<div class="flow-chat"><div class="flow-message-list">${this.flowHistoryCursor ? `<button class="load-older" data-action="flow-older">${escapeHtml(this.tr('agentoffice.loadOlder'))}</button>` : ''}${messages}</div>${composer}</div>`;
    }

    private renderFlowMessage(flow: AgentFlowDetail, message: AgentFlowMessage): string {
        const member =
            message.sender.type === 'staff'
                ? flow.members.find((member) => member.staffId === message.sender.id)
                : undefined;
        const staff =
            message.sender.type === 'staff'
                ? this.staffs.find((candidate) => candidate.id === message.sender.id)
                : undefined;
        const sender =
            message.sender.type === 'user'
                ? this.tr('agentoffice.flow.sender.user')
                : message.sender.type === 'system'
                  ? this.tr('agentoffice.flow.sender.system')
                  : member?.name || this.tr('agentoffice.flow.memberMissing');
        const content = message.content
            .map((part) => {
                if (part.type === 'text')
                    return `<div class="message-markdown markdown-body">${renderSafeMarkdown(part.text)}</div>`;
                const url = `agentoffice://flow-resource/${flow.id}/${part.path}`;
                if (part.mediaType === 'image') {
                    return `<div class="resource"><img src="${escapeHtml(url)}" alt="${escapeHtml(part.name)}"></div>`;
                }
                if (part.mediaType === 'video')
                    return `<div class="resource"><video controls src="${escapeHtml(url)}"></video></div>`;
                if (part.mediaType === 'audio')
                    return `<div class="resource"><audio controls src="${escapeHtml(url)}"></audio></div>`;
                return `<div class="resource"><a href="${escapeHtml(url)}" target="_blank"><i class="fa-solid fa-paperclip"></i> ${escapeHtml(part.name)}</a></div>`;
            })
            .join('');
        const referenced = message.replyToMessageId ? this.findFlowMessage(message.replyToMessageId) : undefined;
        const reply = message.replyToMessageId
            ? `<div class="flow-message-reply">${referenced ? `<b>${escapeHtml(this.flowMessageSender(flow, referenced))}</b><span>${escapeHtml(this.flowMessageExcerpt(referenced))}</span>` : `<span>${escapeHtml(this.tr('agentoffice.flow.message.deletedReference'))}</span>`}</div>`
            : '';
        const role = message.sender.type === 'user' ? 'user' : 'assistant';
        const senderLabel = message.sender.type === 'system' ? `<b>${escapeHtml(sender)}</b>` : '';
        const avatar =
            message.sender.type === 'staff'
                ? `<span class="flow-message-avatar" title="${escapeHtml(sender)}" aria-label="${escapeHtml(sender)}">${staff ? this.avatar(staff) : `<span class="avatar ${AVATAR_GRADIENTS[this.avatarGradientIndex(sender)]}">${escapeHtml(member?.name?.slice(0, 1).toUpperCase() || '?')}</span>`}</span>`
                : '';
        const messageHtml = `<article class="message flow-message ${role} ${message.sender.type} ${message.kind === 'error' ? 'error' : ''}" data-flow-message="${escapeHtml(message.id)}">${avatar}<div class="flow-message-body">${reply}${content}</div>${message.retryable ? `<span class="flow-retryable">${escapeHtml(this.tr('agentoffice.flow.retryable'))}</span>` : ''}<div class="message-meta flow-message-meta">${senderLabel}${message.sequence ? `<span>m${message.sequence}</span>` : ''}<time>${escapeHtml(new Date(message.createdAt).toLocaleString(this.locale))}</time></div><details class="flow-reading-receipt" data-flow-receipt="${escapeHtml(message.id)}">${this.renderFlowReceipt(message.id)}</details></article>`;
        const clientRequestId = message.clientRequestId;
        const isSending =
            message.sender.type === 'user' &&
            clientRequestId !== undefined &&
            this.flowPendingRequests.get(clientRequestId) === flow.id;
        if (!isSending) return messageHtml;
        const status = `<div class="flow-send-progress attached" data-flow-send-pending role="status" aria-live="polite"><span class="flow-send-spinner" aria-hidden="true"></span><span>${escapeHtml(this.tr('agentoffice.flow.sending'))}</span></div>`;
        return `<div class="flow-message-row user" data-flow-message-row="${escapeHtml(message.id)}">${status}${messageHtml}</div>`;
    }

    private findFlowMessage(messageId: string): AgentFlowMessage | undefined {
        return (
            this.flowMessages.find((message) => message.id === messageId) ?? this.flowReferencedMessages.get(messageId)
        );
    }

    private flowMessageSender(flow: AgentFlowDetail, message: AgentFlowMessage): string {
        if (message.sender.type === 'user') return this.tr('agentoffice.flow.sender.user');
        if (message.sender.type === 'system') return this.tr('agentoffice.flow.sender.system');
        return (
            flow.members.find((member) => member.staffId === message.sender.id)?.name ??
            this.tr('agentoffice.flow.memberMissing')
        );
    }

    private flowMessageExcerpt(message: AgentFlowMessage): string {
        const excerpt = message.content
            .map((part) => (part.type === 'text' ? part.text : part.name))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        const characters = Array.from(excerpt);
        if (characters.length <= FLOW_MESSAGE_EXCERPT_MAX_CHARACTERS) return excerpt;
        return `${characters.slice(0, FLOW_MESSAGE_EXCERPT_MAX_CHARACTERS).join('')}…`;
    }

    private staffCardContent(staff: StaffListItem): string {
        return `<div class="card-profile">${this.avatar(staff)}<div class="card-identity"><h3 class="ellipsis">${escapeHtml(staff.name)}</h3><div class="sub ellipsis">${escapeHtml(staff.title)} · ${escapeHtml(staff.vendor_name)}</div></div><span class="card-status ${staff.active_task_id ? 'run' : staff.enabled ? 'on' : ''}">${escapeHtml(staff.active_task_id ? this.tr('agentoffice.running') : staff.enabled ? this.tr('agentoffice.enabled') : this.tr('agentoffice.disabled'))}</span></div><div class="tags">${staff.specialties.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div><div class="card-divider"></div><div class="card-metrics"><div class="card-metric"><b>${staff.message_count.toLocaleString(this.locale)}</b><span>${escapeHtml(this.tr('agentoffice.messagesStat'))}</span></div><div class="card-metric"><b>${staff.task_count.toLocaleString(this.locale)}</b><span>${escapeHtml(this.tr('agentoffice.tasksStat'))}</span></div><div class="card-metric"><b>${this.formatTokens(staff.usage_summary?.total_tokens ?? 0)}</b><span>${escapeHtml(this.tr('agentoffice.tokensStat'))}</span></div></div>`;
    }

    private renderDetail(): string {
        const detail = this.detail!;
        const portraitLabel = escapeHtml(this.tr('agentoffice.changePortrait'));
        const statusClass = detail.active_task_id ? 'run' : detail.enabled ? 'on' : '';
        const statusText = detail.active_task_id
            ? this.tr('agentoffice.running')
            : detail.enabled
              ? this.tr('agentoffice.enabled')
              : this.tr('agentoffice.disabled');
        return `<section class="detail"><header class="detail-head"><div class="detail-head-main"><button class="icon-btn" data-action="back" title="${escapeHtml(this.tr('agentoffice.back'))}" aria-label="${escapeHtml(this.tr('agentoffice.back'))}"><i class="fa-solid fa-arrow-left"></i></button><button class="detail-avatar-button" data-action="portrait" title="${portraitLabel}" aria-label="${portraitLabel}">${this.avatar(detail)}</button><div class="detail-who"><h2 data-detail-name>${escapeHtml(detail.name)}</h2><div class="detail-subtitle"><span class="status-dot ${statusClass}"></span><span class="truncate"><span data-detail-title>${escapeHtml(detail.title)}</span> · ${escapeHtml(detail.vendor_name)} · ${escapeHtml(statusText)}</span></div></div><span class="auto-save-indicator" data-state="${this.autoSaveState}" aria-live="polite">${escapeHtml(this.autoSaveDetail)}</span></div><div class="toolbar-actions"><button class="ghost-btn" data-action="open-directory" title="${escapeHtml(this.tr('agentoffice.openStaffDirectory'))}"><i class="fa-solid fa-folder"></i>${escapeHtml(this.tr('agentoffice.openStaffDirectory'))}</button><button class="ghost-btn" data-action="export" title="${escapeHtml(this.tr('agentoffice.exportZip'))}"><i class="fa-solid fa-download"></i>${escapeHtml(this.tr('agentoffice.exportZip'))}</button><button class="ghost-btn danger" data-action="delete" title="${escapeHtml(this.tr('agentoffice.delete'))}"><i class="fa-solid fa-trash"></i>${escapeHtml(this.tr('agentoffice.delete'))}</button></div></header><p class="detail-notice" role="alert" ${this.status ? '' : 'hidden'}>${escapeHtml(this.status)}</p><nav class="detail-nav">${(['basic', 'skills', 'mcp', 'security', 'tasks'] as DetailSection[]).map((section) => `<button class="nav-btn ${this.detailSection === section ? 'active' : ''}" data-section="${section}" aria-pressed="${this.detailSection === section}">${escapeHtml(this.tr(`agentoffice.${section}`))}</button>`).join('')}</nav><div class="detail-content">${this.renderDetailSection(detail)}</div></section>`;
    }

    private renderDetailSection(detail: StaffDetail): string {
        if (this.detailSection === 'basic') {
            const usage = detail.usage_summary?.total_tokens ?? 0;
            const required = `<span class="required-mark" aria-hidden="true">*</span>`;
            const requiredError = escapeHtml(this.tr('agentoffice.fieldRequired'));
            const defaultModelLabel = this.modelCatalog.default_model
                ? `${this.tr('agentoffice.modelGlobalDefault')} (${this.modelCatalog.default_model})`
                : this.tr('agentoffice.modelGlobalDefault');
            const missingSelectedModel =
                detail.model && !this.modelCatalog.models.some((model) => model.alias === detail.model)
                    ? `<option value="${escapeHtml(detail.model)}" selected>${escapeHtml(detail.model)}</option>`
                    : '';
            const triggerInterval = detail.trigger_interval ?? 'never';
            const serviceConfig = normalizeStaffLocalService(detail.local_service);
            const serviceOn = serviceConfig.enabled;
            const hostOptions = this.localServiceHostOptions(serviceConfig.host);
            const triggerOptions = ['5m', '10m', '15m', '30m', '1h', 'never']
                .map(
                    (value) =>
                        `<option value="${value}" ${triggerInterval === value ? 'selected' : ''}>${escapeHtml(this.tr(`agentoffice.triggerInterval.${value}`))}</option>`
                )
                .join('');
            return `<div class="settings-page">
                <section class="settings-section"><h3 class="section-label">${escapeHtml(this.tr('agentoffice.statsSection'))}</h3><div class="stats"><div class="stat"><b>${detail.message_count.toLocaleString(this.locale)}</b><span>${escapeHtml(this.tr('agentoffice.messagesStat'))}</span></div><div class="stat"><b>${detail.task_count.toLocaleString(this.locale)}</b><span>${escapeHtml(this.tr('agentoffice.tasksStat'))}</span></div><div class="stat"><b>${this.formatTokens(usage)}</b><span>${escapeHtml(this.tr('agentoffice.tokensStat'))}</span></div><div class="stat"><b>${escapeHtml(new Date(detail.hired_at).toLocaleDateString(this.locale))}</b><span>${escapeHtml(this.tr('agentoffice.hiredAt'))}</span></div></div></section>
                <section class="settings-section"><h3 class="section-label">${escapeHtml(this.tr('agentoffice.profileSection'))}</h3><div class="form-grid settings-form"><div class="field" data-basic-field="name"><label for="f-name">${escapeHtml(this.tr('agentoffice.nameLabel'))}${required}</label><input id="f-name" value="${escapeHtml(detail.name)}" required aria-required="true"><div class="field-error">${requiredError}</div></div><div class="field" data-basic-field="vendor"><label for="f-vendor">${escapeHtml(this.tr('agentoffice.vendorLabel'))}${required}</label><input id="f-vendor" value="${escapeHtml(detail.vendor_name)}" required aria-required="true"><div class="field-error">${requiredError}</div></div><div class="field" data-basic-field="title"><label for="f-title">${escapeHtml(this.tr('agentoffice.titleLabel'))}${required}</label><input id="f-title" value="${escapeHtml(detail.title)}" required aria-required="true"><div class="field-error">${requiredError}</div></div><div class="field"><label for="f-specialties">${escapeHtml(this.tr('agentoffice.specialtiesLabel'))}</label><input id="f-specialties" value="${escapeHtml(detail.specialties.join(', '))}"></div><div class="field"><label for="f-trigger-interval">${escapeHtml(this.tr('agentoffice.triggerIntervalLabel'))}</label><select id="f-trigger-interval">${triggerOptions}</select><div class="sub">${escapeHtml(this.tr('agentoffice.triggerIntervalHint'))}</div></div><div class="field"><label for="f-model">${escapeHtml(this.tr('agentoffice.modelLabel'))}</label><select id="f-model"><option value="">${escapeHtml(defaultModelLabel)}</option>${missingSelectedModel}${this.modelCatalog.models.map((model) => `<option value="${escapeHtml(model.alias)}" ${detail.model === model.alias ? 'selected' : ''}>${escapeHtml(model.alias)} · ${escapeHtml(model.provider_name)} / ${escapeHtml(model.model_name)}</option>`).join('')}</select><div class="sub">${escapeHtml(this.tr('agentoffice.modelHint'))}</div></div><div class="field full"><div class="setting-check-row"><span class="setting-check-copy"><b>${escapeHtml(this.tr('agentoffice.enableStaff'))}</b><small>${escapeHtml(this.tr('agentoffice.enableStaffHint'))}</small></span><label class="setting-toggle"><input type="checkbox" id="f-enabled" ${detail.enabled ? 'checked' : ''}><span class="setting-toggle-track"></span></label></div><div class="setting-check-row"><span class="setting-check-copy"><b>${escapeHtml(this.tr('agentoffice.localService'))}</b><small>${escapeHtml(this.tr('agentoffice.localServiceHint'))}</small></span><label class="setting-toggle"><input type="checkbox" id="f-local-service" ${serviceOn ? 'checked' : ''}><span class="setting-toggle-track"></span></label></div><div class="local-service-config" id="local-service-config" ${serviceOn ? '' : 'hidden'}><div class="local-service-fields"><div class="field"><label for="f-local-service-host">${escapeHtml(this.tr('agentoffice.localServiceAddress'))}</label><select id="f-local-service-host">${hostOptions}</select></div><div class="field"><label for="f-local-service-port">${escapeHtml(this.tr('agentoffice.localServicePort'))}</label><input id="f-local-service-port" type="number" min="1" max="65535" step="1" value="${serviceConfig.port}"></div></div><div class="local-service-fields local-service-token-fields"><div class="field"><label for="f-local-service-user-token">${escapeHtml(this.tr('agentoffice.localServiceUserToken'))}</label><div class="local-service-token-row"><input id="f-local-service-user-token" value="${escapeHtml(serviceConfig.user_token)}" autocomplete="off" spellcheck="false" placeholder=""><button class="secondary small-btn" data-action="generate-user-token" title="${escapeHtml(this.tr('agentoffice.localServiceTokenGenerate'))}">${escapeHtml(this.tr('agentoffice.localServiceTokenGenerate'))}</button></div><div class="sub">${escapeHtml(this.tr('agentoffice.localServiceUserTokenHint'))}</div></div><div class="field"><label for="f-local-service-manage-token">${escapeHtml(this.tr('agentoffice.localServiceManageToken'))}</label><div class="local-service-token-row"><input id="f-local-service-manage-token" value="${escapeHtml(serviceConfig.manage_token)}" autocomplete="off" spellcheck="false"><button class="secondary small-btn" data-action="generate-manage-token" title="${escapeHtml(this.tr('agentoffice.localServiceTokenGenerate'))}">${escapeHtml(this.tr('agentoffice.localServiceTokenGenerate'))}</button></div><div class="field-error" id="f-local-service-manage-token-error" role="alert"></div></div></div><div class="setting-check-row"><span class="setting-check-copy"><b>${escapeHtml(this.tr('agentoffice.localServiceHttps'))}</b><small>${escapeHtml(this.tr('agentoffice.localServiceHttpsHint'))}</small></span><label class="setting-toggle"><input type="checkbox" id="f-local-service-https" ${serviceConfig.https ? 'checked' : ''}><span class="setting-toggle-track"></span></label></div><div class="setting-check-row"><span class="setting-check-copy"><b>${escapeHtml(this.tr('agentoffice.localServiceAllowIframe'))}</b><small>${escapeHtml(this.tr('agentoffice.localServiceAllowIframeHint'))}</small></span><label class="setting-toggle"><input type="checkbox" id="f-local-service-allow-iframe" ${serviceConfig.allow_iframe_embedding ? 'checked' : ''}><span class="setting-toggle-track"></span></label></div><div class="setting-check-row"><span class="setting-check-copy"><b>${escapeHtml(this.tr('agentoffice.localServiceHideStaffInfo'))}</b><small>${escapeHtml(this.tr('agentoffice.localServiceHideStaffInfoHint'))}</small></span><label class="setting-toggle"><input type="checkbox" id="f-local-service-hide-info" ${serviceConfig.hide_staff_info ? 'checked' : ''}><span class="setting-toggle-track"></span></label></div><div class="local-service-status" id="local-service-status" data-state="${this.localServicePending ? 'pending' : this.localServiceRuntime?.error ? 'error' : this.localServiceRuntime?.listening ? 'running' : 'stopped'}">${this.localServiceStatusHtml()}</div></div></div></div></section>
                <section class="settings-section"><h3 class="section-label">${escapeHtml(this.tr('agentoffice.instructionsLabel'))}</h3><div class="field"><textarea id="f-agents">${escapeHtml(detail.agents_md)}</textarea></div></section>
            </div>`;
        }
        if (this.detailSection === 'skills') {
            return `<div class="skills-page"><div class="skills-toolbar"><h3 class="section-label inline">${escapeHtml(this.tr('agentoffice.skills'))} · ${this.skills.length}</h3><div class="skills-add-anchor"><button class="secondary small-btn" data-action="toggle-skill-menu" title="${escapeHtml(this.tr('agentoffice.addSkill'))}"><i class="fa-solid fa-plus"></i>${escapeHtml(this.tr('agentoffice.addSkill'))}</button></div></div>${
                this.skills.length === 0
                    ? `<div class="empty">${escapeHtml(this.tr('agentoffice.noSkills'))}</div>`
                    : `<div class="skill-grid">${this.skills
                          .map((skill) => {
                              const color = getSkillPastel(skill.name || skill.directory_name);
                              return `<button class="skill-card" data-skill-detail="${escapeHtml(skill.directory_name)}"><span class="skill-card-head"><span class="skill-card-icon" style="background:${color.bg};color:${color.text}">${escapeHtml(getSkillInitial(skill.name || skill.directory_name))}</span><span style="min-width:0"><h4>${escapeHtml(skill.name)}</h4><span class="skill-card-id">${escapeHtml(skill.directory_name)}</span></span></span><span class="skill-card-desc">${escapeHtml(skill.description)}</span></button>`;
                          })
                          .join('')}</div>`
            }</div>`;
        }
        if (this.detailSection === 'mcp') {
            return `<div class="settings-page"><section class="settings-section"><h3 class="section-label">${escapeHtml(this.tr('agentoffice.mcp'))}</h3><div class="callout amber"><i class="fa-solid fa-lock"></i><span>${escapeHtml(this.tr('agentoffice.mcpExportWarning'))}</span></div><div class="field" data-mcp-field><label for="f-mcp">${escapeHtml(this.tr('agentoffice.mcpJsonHint'))}</label><textarea id="f-mcp" class="code-textarea">${escapeHtml(JSON.stringify(detail.mcp, null, 4))}</textarea><div class="field-error" id="mcp-field-error"></div></div></section></div>`;
        }
        if (this.detailSection === 'security') {
            const directories = detail.permission.directories.length
                ? detail.permission.directories
                      .map(
                          (directory, index) =>
                              `<div class="directory-grid directory-row"><span class="directory-path" title="${escapeHtml(directory.path)}">${escapeHtml(directory.path)}</span><select data-dir-access="${index}" aria-label="${escapeHtml(this.tr('agentoffice.directoryAccess'))}"><option value="read" ${directory.access === 'read' ? 'selected' : ''}>${escapeHtml(this.tr('agentoffice.readOnly'))}</option><option value="readwrite" ${directory.access === 'readwrite' ? 'selected' : ''}>${escapeHtml(this.tr('agentoffice.readWrite'))}</option></select><button class="danger directory-remove" data-remove-dir="${index}" title="${escapeHtml(this.tr('agentoffice.removeDirectory'))}" aria-label="${escapeHtml(this.tr('agentoffice.removeDirectory'))}"><i class="fa-solid fa-xmark"></i></button></div>`
                      )
                      .join('')
                : `<div class="directory-empty">${escapeHtml(this.tr('agentoffice.noDirectories'))}</div>`;
            return `<div class="settings-page"><section class="settings-section"><h3 class="section-label">${escapeHtml(this.tr('agentoffice.security'))}</h3><div class="setting-check-row network-setting-row"><span class="setting-check-copy"><b>${escapeHtml(this.tr('agentoffice.networkAccess'))}</b><small>${escapeHtml(this.tr('agentoffice.networkAccessHint'))}</small></span><label class="setting-toggle"><input id="f-network" type="checkbox" ${detail.permission.network_access ? 'checked' : ''}><span class="setting-toggle-track"></span></label></div></section><section class="settings-section"><div class="row between"><h3 class="section-label inline">${escapeHtml(this.tr('agentoffice.directories'))}</h3><button class="secondary small-btn" data-action="add-directory"><i class="fa-solid fa-plus"></i>${escapeHtml(this.tr('agentoffice.addDirectory'))}</button></div><div class="directory-table"><div class="directory-grid directory-header"><span>${escapeHtml(this.tr('agentoffice.directoryPath'))}</span><span>${escapeHtml(this.tr('agentoffice.directoryAccess'))}</span><span></span></div><div id="directory-list">${directories}</div></div></section></div>`;
        }
        const tasks =
            detail.tasks.length === 0
                ? `<div class="empty">${escapeHtml(this.tr('agentoffice.noTasks'))}</div>`
                : detail.tasks
                      .slice()
                      .reverse()
                      .map((task) => {
                          const statusClass = ['waiting', 'running', 'stopped', 'failed'].includes(task.status)
                              ? task.status
                              : '';
                          return `<div class="task-row"><div class="task-copy"><div class="task-title" title="${escapeHtml(task.task_id)}">${escapeHtml(task.task_id)}</div><div class="task-meta"><span>${escapeHtml(this.tr(`agentoffice.taskSource.${task.source ?? 'user'}`))}</span><span>·</span><span class="task-status ${statusClass}">${escapeHtml(this.taskStatus(task.status))}</span><span>·</span><time>${escapeHtml(new Date(task.updated_at).toLocaleString(this.locale))}</time><span>·</span><span>${this.formatTokens(task.usage_summary?.total_tokens ?? 0)} ${escapeHtml(this.tr('agentoffice.tokensStat'))}</span></div></div><button class="secondary small-btn" data-task="${escapeHtml(task.task_id)}">${escapeHtml(this.tr('agentoffice.openTask'))}</button></div>`;
                      })
                      .join('');
        return `<div class="settings-page"><section class="settings-section"><h3 class="section-label">${escapeHtml(this.tr('agentoffice.tasks'))}</h3>${tasks}</section></div>`;
    }

    /** 监听地址下拉：以本机当前网卡地址为基础，已保存但当前不存在的地址保留为选项，避免静默改动配置 */
    private localServiceHostOptions(selectedHost: string): string {
        const addresses = [...this.localAddresses];
        if (selectedHost && !addresses.some((item) => item.address === selectedHost)) {
            addresses.push({ address: selectedHost, name: selectedHost });
        }
        return addresses
            .map(
                (item) =>
                    `<option value="${escapeHtml(item.address)}" ${item.address === selectedHost ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.address)}</option>`
            )
            .join('');
    }

    /** 运行中服务对外的两个入口地址；令牌按当前草稿配置自动拼进链接 */
    private localServiceUrls(): { chat: string; manage: string } | null {
        const runtime = this.localServiceRuntime;
        if (!runtime?.listening || !runtime.url) return null;
        const config = normalizeStaffLocalService(this.detail?.local_service);
        const suffix = (token: string) => (token ? `?token=${encodeURIComponent(token)}` : '');
        return {
            chat: `${runtime.url}/chat${suffix(config.user_token)}`,
            manage: `${runtime.url}/manage${suffix(config.manage_token)}`
        };
    }

    private localServiceLinkRowHtml(labelKey: string, url: string, target: 'chat' | 'manage'): string {
        return `<div class="local-service-link-row"><span class="local-service-link-label">${escapeHtml(this.tr(labelKey))}</span><span class="local-service-url" title="${escapeHtml(url)}">${escapeHtml(url)}</span><button class="secondary small-btn" data-service-link="${target}" data-link-action="open" title="${escapeHtml(this.tr('agentoffice.openInBrowser'))}"><i class="fa-solid fa-arrow-up-right-from-square"></i>${escapeHtml(this.tr('agentoffice.openInBrowser'))}</button><button class="secondary small-btn" data-service-link="${target}" data-link-action="copy" title="${escapeHtml(this.tr('agentoffice.localServiceCopy'))}">${escapeHtml(this.tr('agentoffice.localServiceCopy'))}</button></div>`;
    }

    private localServiceStatusHtml(): string {
        // 过渡态：服务运行中的链接行原样保留（CSS 置灰禁点），"正在应用"徽标绝对定位叠加，
        // 容器高度不变，避免切换 HTTPS/端口等触发重启的配置时链接区域塌陷又弹回
        if (this.localServicePending) {
            const links = this.localServiceLinksHtml();
            if (links) {
                return `${links}<span class="local-service-applying" role="status">${escapeHtml(
                    this.tr('agentoffice.localServiceApplying')
                )}</span>`;
            }
            return `<span class="status-dot"></span><span>${escapeHtml(this.tr('agentoffice.localServiceApplying'))}</span>`;
        }
        const links = this.localServiceLinksHtml();
        if (links) return links;
        const runtime = this.localServiceRuntime;
        if (runtime?.error) {
            return `<span class="status-dot"></span><span class="local-service-error">${escapeHtml(runtime.error)}</span>`;
        }
        return `<span class="status-dot"></span><span>${escapeHtml(this.tr('agentoffice.localServiceStopped'))}</span>`;
    }

    /** 运行中服务的两条入口链接；仅在服务确在监听时返回内容，令牌按当前草稿实时拼接 */
    private localServiceLinksHtml(): string {
        const runtime = this.localServiceRuntime;
        if (!runtime?.listening || !runtime.url) return '';
        const urls = this.localServiceUrls();
        if (!urls) return '';
        return `<div class="local-service-links">${this.localServiceLinkRowHtml(
            'agentoffice.localServiceChatUrl',
            urls.chat,
            'chat'
        )}${this.localServiceLinkRowHtml('agentoffice.localServiceManageUrl', urls.manage, 'manage')}</div>`;
    }

    /** 局部刷新服务状态行（localServiceChanged 事件到达时），避免整树重渲染干扰表单草稿 */
    private updateLocalServiceStatusUI(): void {
        const status = this.shadowRoot?.querySelector<HTMLElement>('#local-service-status');
        if (!status) return;
        status.dataset.state = this.localServicePending
            ? 'pending'
            : this.localServiceRuntime?.error
              ? 'error'
              : this.localServiceRuntime?.listening
                ? 'running'
                : 'stopped';
        status.innerHTML = this.localServiceStatusHtml();
        this.bindServiceLinkButtons(status);
    }

    private bindServiceLinkButtons(status: HTMLElement): void {
        status.querySelectorAll<HTMLButtonElement>('[data-service-link]').forEach((button) => {
            const target = (button.dataset.serviceLink ?? 'chat') as 'chat' | 'manage';
            if (button.dataset.linkAction === 'copy') {
                button.addEventListener('click', () => void this.copyServiceUrl(target, button));
            } else {
                button.addEventListener('click', () => {
                    void this.openServiceInBrowser(target);
                });
            }
        });
    }

    private async openServiceInBrowser(target: 'chat' | 'manage' = 'chat'): Promise<void> {
        if (!this.detail) return;
        try {
            await this.call('openServiceInBrowser', this.detail.id, target);
        } catch (error) {
            this.status = `${this.tr('agentoffice.operationFailed')}: ${this.errorText(error)}`;
            this.updateLocalServiceStatusUI();
        }
    }

    private async copyServiceUrl(target: 'chat' | 'manage', button: HTMLButtonElement): Promise<void> {
        const url = this.localServiceUrls()?.[target];
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
        } catch {
            return;
        }
        const previous = button.textContent;
        button.textContent = this.tr('agentoffice.localServiceCopied');
        setTimeout(() => {
            if (button.isConnected) button.textContent = previous;
        }, 1500);
    }

    /** 首次开启时补齐默认值：地址优先取局域网网卡，端口默认 9050，并自动生成 16 位管理令牌 */
    private handleLocalServiceToggle(enabled: boolean): void {
        if (!this.detail) return;
        const saved = this.detail.local_service ? normalizeStaffLocalService(this.detail.local_service) : null;
        // 未保存过配置时优先选局域网地址，方便其他设备直接访问
        const firstLan = this.localAddresses.find((item) => item.address !== '127.0.0.1');
        const host = this.detail.local_service?.host || firstLan?.address || '127.0.0.1';
        // 首次启用时两个令牌都自动生成，免去手工填写；用户令牌事后清空仍表示聊天页免令牌
        const manageToken = saved?.manage_token || (enabled ? generateStaffServiceToken() : '');
        const userToken = enabled && !saved?.user_token ? generateStaffServiceToken() : (saved?.user_token ?? '');
        this.detail.local_service = {
            enabled,
            host,
            port: saved?.port ?? 9050,
            https: saved?.https ?? false,
            allow_iframe_embedding: saved?.allow_iframe_embedding ?? false,
            user_token: userToken,
            manage_token: manageToken,
            hide_staff_info: saved?.hide_staff_info ?? false
        };
        this.localServicePending = enabled;
        const configBlock = this.shadowRoot?.querySelector<HTMLElement>('#local-service-config');
        if (configBlock) {
            configBlock.hidden = !enabled;
            const hostSelect = configBlock.querySelector<HTMLSelectElement>('#f-local-service-host');
            if (hostSelect) hostSelect.innerHTML = this.localServiceHostOptions(host);
            const httpsToggle = configBlock.querySelector<HTMLInputElement>('#f-local-service-https');
            if (httpsToggle) httpsToggle.checked = this.detail.local_service.https;
            const allowIframeToggle = configBlock.querySelector<HTMLInputElement>('#f-local-service-allow-iframe');
            if (allowIframeToggle) allowIframeToggle.checked = this.detail.local_service.allow_iframe_embedding;
            const userInput = configBlock.querySelector<HTMLInputElement>('#f-local-service-user-token');
            if (userInput) userInput.value = this.detail.local_service.user_token;
            const manageInput = configBlock.querySelector<HTMLInputElement>('#f-local-service-manage-token');
            if (manageInput) manageInput.value = manageToken;
            const manageError = configBlock.querySelector<HTMLElement>('#f-local-service-manage-token-error');
            if (manageError) manageError.textContent = '';
            const hideInfo = configBlock.querySelector<HTMLInputElement>('#f-local-service-hide-info');
            if (hideInfo) hideInfo.checked = this.detail.local_service.hide_staff_info;
        }
        this.updateLocalServiceStatusUI();
        this.queueStaffUpdate({ local_service: this.detail.local_service }, true);
    }

    private handleLocalServiceConfigChange(update: Partial<StaffLocalService>): void {
        if (!this.detail) return;
        const config = normalizeStaffLocalService(this.detail.local_service);
        this.detail.local_service = { ...config, ...update };
        // 仅在 apply() 会重启服务的变更（host/port/https）进入过渡态；
        // 令牌/显示选项等原地生效，链接行实时读草稿刷新即可，避免状态区域无谓闪动
        this.localServicePending = this.localServiceWillRestart();
        this.updateLocalServiceStatusUI();
        this.queueStaffUpdate({ local_service: this.detail.local_service }, true);
    }

    /** 草稿的 host/port/https 与运行中服务不一致时，apply() 会重启服务（收敛规则见 local-service.ts） */
    private localServiceWillRestart(): boolean {
        const runtime = this.localServiceRuntime;
        if (!runtime?.listening || !runtime.url) return true;
        // IPv6 等无法解析的地址保守视为会重启
        const match = /^(https?):\/\/([^:/]+):(\d+)$/.exec(runtime.url);
        if (!match) return true;
        const config = normalizeStaffLocalService(this.detail?.local_service);
        return (match[1] === 'https') !== config.https || match[2] !== config.host || Number(match[3]) !== config.port;
    }

    private handleLocalServicePortChange(raw: string): void {
        if (!this.detail) return;
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            this.localServiceRuntime = { listening: false, error: this.tr('agentoffice.localServicePortInvalid') };
            this.updateLocalServiceStatusUI();
            return;
        }
        this.localServiceRuntime = null;
        this.handleLocalServiceConfigChange({ port });
    }

    /** 令牌输入统一走这里：管理令牌在服务启用时不允许清空 */
    private handleLocalServiceTokenChange(target: 'user_token' | 'manage_token', raw: string): void {
        if (!this.detail) return;
        const value = raw.trim();
        const config = normalizeStaffLocalService(this.detail.local_service);
        const manageError = this.shadowRoot?.querySelector<HTMLElement>('#f-local-service-manage-token-error');
        if (target === 'manage_token' && config.enabled && !value) {
            this.localServiceRuntime = {
                listening: false,
                error: this.tr('agentoffice.localServiceManageTokenRequired')
            };
            if (manageError) manageError.textContent = this.tr('agentoffice.localServiceManageTokenRequired');
            this.updateLocalServiceStatusUI();
            return;
        }
        if (manageError) manageError.textContent = '';
        this.handleLocalServiceConfigChange({ [target]: value });
    }

    /** 随机生成令牌并立即保存；服务启用中清空管理令牌的错误提示一并清除 */
    private generateServiceTokenField(target: 'user_token' | 'manage_token'): void {
        if (!this.detail) return;
        const token = generateStaffServiceToken();
        const input = this.shadowRoot?.querySelector<HTMLInputElement>(
            target === 'user_token' ? '#f-local-service-user-token' : '#f-local-service-manage-token'
        );
        if (input) input.value = token;
        this.handleLocalServiceTokenChange(target, token);
    }

    private renderSkillAddMenu(): string {
        return `<div class="skills-add-menu" role="menu">
            <button data-action="add-skill-directory" role="menuitem"><span class="skill-menu-icon folder"><i class="fa-solid fa-folder-open"></i></span><span class="skill-menu-copy"><b>${escapeHtml(this.tr('agentoffice.addSkillFromDirectory'))}</b><span>${escapeHtml(this.tr('agentoffice.addSkillFromDirectoryHint'))}</span></span></button>
            <button data-action="add-skill-zip" role="menuitem"><span class="skill-menu-icon zip"><i class="fa-solid fa-file-zipper"></i></span><span class="skill-menu-copy"><b>${escapeHtml(this.tr('agentoffice.addSkillFromZip'))}</b><span>${escapeHtml(this.tr('agentoffice.addSkillFromZipHint'))}</span></span></button>
            <button data-action="batch-import-skills" role="menuitem"><span class="skill-menu-icon batch"><i class="fa-solid fa-inbox"></i></span><span class="skill-menu-copy"><b>${escapeHtml(this.tr('agentoffice.batchImportSkills'))}</b><span>${escapeHtml(this.tr('agentoffice.batchImportSkillsHint'))}</span></span></button>
            <div class="skills-add-menu-divider"></div>
            <button data-action="add-skill-url" role="menuitem"><span class="skill-menu-icon url"><i class="fa-solid fa-link"></i></span><span class="skill-menu-copy"><b>${escapeHtml(this.tr('agentoffice.addSkillFromUrl'))}</b><span>${escapeHtml(this.tr('agentoffice.addSkillFromUrlHint'))}</span></span></button>
            <button data-action="add-installed-skills" role="menuitem"><span class="skill-menu-icon installed"><i class="fa-solid fa-download"></i></span><span class="skill-menu-copy"><b>${escapeHtml(this.tr('agentoffice.addInstalledSkills'))}</b><span>${escapeHtml(this.tr('agentoffice.addInstalledSkillsHint'))}</span></span></button>
        </div>`;
    }

    private renderModal(): string {
        if (this.modal === 'new-flow') {
            const memberRows = this.staffs
                .map(
                    (staff) =>
                        `<label class="flow-member-row"><input type="checkbox" data-new-flow-member="${escapeHtml(staff.id)}"><span><b>${escapeHtml(staff.name)}</b><span>${escapeHtml(staff.title)}</span></span></label>`
                )
                .join('');
            return `<div class="modal-backdrop od-overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="new-flow-title"><div class="modal-head info"><div class="modal-icon">${renderIcon('fa-layer-group')}</div><div class="modal-head-text"><h3 id="new-flow-title">${escapeHtml(this.tr('agentoffice.flow.new'))}</h3><p class="sub">${escapeHtml(this.tr('agentoffice.flow.newHint'))}</p></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}"><i class="fa-solid fa-xmark"></i></button></div><div class="modal-body"><div class="modal-error" id="new-flow-error" role="alert"></div><div class="modal-form"><div class="field" data-new-flow-field="name"><label for="new-flow-name">${escapeHtml(this.tr('agentoffice.flow.name'))}</label><input id="new-flow-name" maxlength="100" autocomplete="off"></div><div class="field" data-new-flow-field="goal"><label for="new-flow-goal">${escapeHtml(this.tr('agentoffice.flow.goal'))}</label><textarea id="new-flow-goal" maxlength="4000"></textarea></div><div class="field" data-new-flow-field="members"><label>${escapeHtml(this.tr('agentoffice.flow.members'))}</label><div class="flow-member-list">${memberRows}</div></div></div></div><div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="primary" data-action="create-flow">${escapeHtml(this.tr('agentoffice.save'))}</button></div></div></div>`;
        }
        if (this.modal === 'archive-flow' && this.selectedFlow) {
            return `<div class="modal-backdrop od-overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="archive-flow-title"><div class="modal-head danger"><div class="modal-icon">${renderIcon('fa-inbox')}</div><div class="modal-head-text"><h3 id="archive-flow-title">${escapeHtml(this.tr('agentoffice.flow.archive'))}</h3></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}"><i class="fa-solid fa-xmark"></i></button></div><div class="modal-body"><p>${escapeHtml(this.tr('agentoffice.flow.archiveWarning'))}</p></div><div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="danger" data-action="confirm-archive-flow">${escapeHtml(this.tr('agentoffice.flow.archive'))}</button></div></div></div>`;
        }
        if (this.modal === 'delete-flow' && this.selectedFlow) {
            return `<div class="modal-backdrop od-overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="delete-flow-title"><div class="modal-head danger"><div class="modal-icon">${renderIcon('fa-trash-can')}</div><div class="modal-head-text"><h3 id="delete-flow-title">${escapeHtml(this.tr('agentoffice.flow.delete'))}</h3></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}"><i class="fa-solid fa-xmark"></i></button></div><div class="modal-body"><p>${escapeHtml(this.tr('agentoffice.flow.deleteWarning'))}</p></div><div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="danger" data-action="confirm-delete-flow">${escapeHtml(this.tr('agentoffice.flow.delete'))}</button></div></div></div>`;
        }
        if (this.modal === 'delete-flow-message' && this.flowDeleteMessageId) {
            return `<div class="modal-backdrop od-overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="delete-flow-message-title"><div class="modal-head danger"><div class="modal-icon">${renderIcon('fa-trash-can')}</div><div class="modal-head-text"><h3 id="delete-flow-message-title">${escapeHtml(this.tr('agentoffice.flow.message.delete'))}</h3></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}"><i class="fa-solid fa-xmark"></i></button></div><div class="modal-body"><p>${escapeHtml(this.tr('agentoffice.flow.message.deleteWarning'))}</p></div><div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="danger" data-action="confirm-delete-flow-message">${escapeHtml(this.tr('agentoffice.flow.message.delete'))}</button></div></div></div>`;
        }
        if (this.modal === 'new') {
            const required = `<span class="required-mark" aria-hidden="true">*</span>`;
            const error = escapeHtml(this.tr('agentoffice.fieldRequired'));
            return `<div class="modal-backdrop od-overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="new-staff-title">
                <div class="modal-head info"><div class="modal-icon">${renderIcon('fa-user-plus')}</div><div class="modal-head-text"><h3 id="new-staff-title">${escapeHtml(this.tr('agentoffice.newStaff'))}</h3><p class="sub">${escapeHtml(this.tr('agentoffice.newStaffHint'))}</p></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
                <div class="modal-body"><div class="modal-error" id="new-modal-error" role="alert"></div><div class="modal-form">
                    <div class="field" data-new-field="name"><label for="new-name">${escapeHtml(this.tr('agentoffice.nameLabel'))}${required}</label><input id="new-name" autocomplete="off" required aria-required="true"><div class="field-error">${error}</div></div>
                    <div class="field" data-new-field="vendor"><label for="new-vendor">${escapeHtml(this.tr('agentoffice.vendorLabel'))}${required}</label><input id="new-vendor" autocomplete="organization" required aria-required="true"><div class="field-error">${error}</div></div>
                    <div class="field" data-new-field="title"><label for="new-title">${escapeHtml(this.tr('agentoffice.titleLabel'))}${required}</label><input id="new-title" autocomplete="organization-title" required aria-required="true"><div class="field-error">${error}</div></div>
                    <div class="field"><label for="new-specialties">${escapeHtml(this.tr('agentoffice.specialtiesLabel'))}<span class="optional-mark">${escapeHtml(this.tr('agentoffice.optional'))}</span></label><input id="new-specialties" autocomplete="off"></div>
                    <div class="field"><label for="new-trigger-interval">${escapeHtml(this.tr('agentoffice.triggerIntervalLabel'))}</label><select id="new-trigger-interval"><option value="5m">${escapeHtml(this.tr('agentoffice.triggerInterval.5m'))}</option><option value="10m">${escapeHtml(this.tr('agentoffice.triggerInterval.10m'))}</option><option value="15m">${escapeHtml(this.tr('agentoffice.triggerInterval.15m'))}</option><option value="30m">${escapeHtml(this.tr('agentoffice.triggerInterval.30m'))}</option><option value="1h">${escapeHtml(this.tr('agentoffice.triggerInterval.1h'))}</option><option value="never" selected>${escapeHtml(this.tr('agentoffice.triggerInterval.never'))}</option></select><div class="sub">${escapeHtml(this.tr('agentoffice.triggerIntervalHint'))}</div></div>
                </div></div>
                <div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="primary" data-action="create">${escapeHtml(this.tr('agentoffice.save'))}</button></div>
            </div></div>`;
        }
        if (this.modal === 'batch-skills') {
            if (this.skillBatchResult) {
                const rows = [
                    ...this.skillBatchResult.added.map(
                        (item) =>
                            `<div class="installed-skill-row"><i class="fa-solid fa-check skill-import-result-icon"></i><span><b>${escapeHtml(item.name)}</b><span>${escapeHtml(item.path)}</span></span></div>`
                    ),
                    ...this.skillBatchResult.errors.map(
                        (item) =>
                            `<div class="installed-skill-row"><i class="fa-solid fa-xmark skill-import-result-icon error"></i><span><b>${escapeHtml(item.path.split(/[\\/]/).pop() || item.path)}</b><span>${escapeHtml(item.message)}</span></span></div>`
                    )
                ].join('');
                return `<div class="modal-backdrop od-overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="batch-skills-title"><div class="modal-head info"><div class="modal-icon">${renderIcon('fa-layer-group')}</div><div class="modal-head-text"><h3 id="batch-skills-title">${escapeHtml(this.tr('agentoffice.batchImportComplete'))}</h3><p class="sub">${escapeHtml(this.formatText('agentoffice.batchImportSummary', { added: this.skillBatchResult.added.length, failed: this.skillBatchResult.errors.length }))}</p></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.close'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div><div class="modal-body"><div class="installed-skill-list">${rows}</div></div><div class="modal-footer"><button class="primary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.close'))}</button></div></div></div>`;
            }
            const list = this.batchSkillCandidates.length
                ? this.batchSkillCandidates
                      .map(
                          (skill) =>
                              `<label class="installed-skill-row"><input type="checkbox" data-batch-skill="${escapeHtml(skill.path)}" ${this.selectedBatchSkillPaths.has(skill.path) ? 'checked' : ''}><span><b>${escapeHtml(skill.name)}</b><span>${escapeHtml(skill.type === 'directory' ? this.tr('agentoffice.skillSourceDirectory') : this.tr('agentoffice.skillSourceZip'))} · ${escapeHtml(skill.path)}</span></span></label>`
                      )
                      .join('')
                : `<div class="empty">${escapeHtml(this.tr('agentoffice.noBatchSkillsFound'))}</div>`;
            return `<div class="modal-backdrop od-overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="batch-skills-title"><div class="modal-head info"><div class="modal-icon">${renderIcon('fa-layer-group')}</div><div class="modal-head-text"><h3 id="batch-skills-title">${escapeHtml(this.tr('agentoffice.batchImportSkills'))}</h3><p class="sub">${escapeHtml(this.tr('agentoffice.batchImportSelectHint'))}</p></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div><div class="modal-body"><div class="installed-skill-list">${list}</div></div><div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="primary" data-action="confirm-batch-skills" ${this.selectedBatchSkillPaths.size === 0 ? 'disabled' : ''}>${escapeHtml(this.tr('agentoffice.addSelectedSkills'))}</button></div></div></div>`;
        }
        if (this.modal === 'skill-url') {
            return `<div class="modal-backdrop od-overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="skill-url-title"><div class="modal-head info"><div class="modal-icon">${renderIcon('fa-link')}</div><div class="modal-head-text"><h3 id="skill-url-title">${escapeHtml(this.tr('agentoffice.addSkillFromUrl'))}</h3><p class="sub">${escapeHtml(this.tr('agentoffice.addSkillFromUrlHint'))}</p></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div><div class="modal-body"><div class="modal-error" id="skill-modal-error" role="alert">${escapeHtml(this.skillModalError)}</div><div class="field"><label for="skill-url-input">${escapeHtml(this.tr('agentoffice.skillUrlLabel'))}</label><input id="skill-url-input" type="url" value="${escapeHtml(this.skillUrl)}" placeholder="https://example.com/skill.zip" autocomplete="url"></div></div><div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="primary" data-action="confirm-skill-url">${escapeHtml(this.tr('agentoffice.addSkill'))}</button></div></div></div>`;
        }
        if (this.modal === 'installed-skills') {
            const available = this.installedSkills.filter((skill) => !skill.already_added);
            const list = this.installedSkills.length
                ? this.installedSkills
                      .map(
                          (skill) =>
                              `<label class="installed-skill-row ${skill.already_added ? 'disabled' : ''}"><input type="checkbox" data-installed-skill="${escapeHtml(skill.id)}" ${skill.already_added ? 'checked disabled' : this.selectedInstalledSkillIds.has(skill.id) ? 'checked' : ''}><span><b>${escapeHtml(skill.name)}</b><span>${escapeHtml(skill.description || skill.directory_name)}${skill.already_added ? ` · ${escapeHtml(this.tr('agentoffice.skillAlreadyAdded'))}` : ''}</span></span></label>`
                      )
                      .join('')
                : `<div class="empty">${escapeHtml(this.tr('agentoffice.noInstalledSkills'))}</div>`;
            return `<div class="modal-backdrop od-overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="installed-skills-title"><div class="modal-head info"><div class="modal-icon">${renderIcon('fa-list-check')}</div><div class="modal-head-text"><h3 id="installed-skills-title">${escapeHtml(this.tr('agentoffice.addInstalledSkills'))}</h3><p class="sub">${escapeHtml(this.tr('agentoffice.addInstalledSkillsHint'))}</p></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div><div class="modal-body"><div class="installed-skill-list">${list}</div></div><div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="primary" data-action="confirm-installed-skills" ${available.length === 0 ? 'disabled' : ''}>${escapeHtml(this.tr('agentoffice.addSelectedSkills'))}</button></div></div></div>`;
        }
        if (this.modal === 'skill-detail' && this.selectedSkill) {
            return '<skill-detail-card id="staff-skill-detail-card"></skill-detail-card>';
        }
        if (this.modal === 'portrait') {
            return `<div class="modal-backdrop od-overlay"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="portrait-editor-title">
                <div class="modal-head info"><div class="modal-icon">${renderIcon('fa-image')}</div><div class="modal-head-text"><h3 id="portrait-editor-title">${escapeHtml(this.tr('agentoffice.portraitEditorTitle'))}</h3><p class="sub">${escapeHtml(this.tr('agentoffice.portraitEditorHint'))}</p></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
                <div class="modal-body"><div class="modal-error" id="portrait-modal-error" role="alert">${escapeHtml(this.portraitError)}</div><div class="portrait-editor">
                    <div class="portrait-crop" id="portrait-crop"><canvas id="portrait-canvas" width="${PORTRAIT_CANVAS_SIZE}" height="${PORTRAIT_CANVAS_SIZE}" aria-label="${escapeHtml(this.tr('agentoffice.portraitCropArea'))}"></canvas><div class="portrait-crop-guide"></div><div class="portrait-crop-empty" id="portrait-crop-empty">${escapeHtml(this.tr('agentoffice.portraitChooseHint'))}</div></div>
                    <div class="portrait-controls"><input class="portrait-file-input" id="portrait-file" type="file" accept="image/png,image/jpeg,image/webp"><button class="secondary" data-action="portrait-pick">${escapeHtml(this.tr('agentoffice.choosePortrait'))}</button><label class="portrait-zoom">${escapeHtml(this.tr('agentoffice.portraitZoom'))}<input id="portrait-zoom" type="range" min="1" max="3" step="0.01" value="1" disabled></label><p class="portrait-format-hint">${escapeHtml(this.tr('agentoffice.portraitFormatHint'))}</p></div>
                </div></div>
                <div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="primary" data-action="save-portrait" disabled>${escapeHtml(this.tr('agentoffice.savePortrait'))}</button></div>
            </div></div>`;
        }
        if (this.modal === 'delete') {
            return `<div class="modal-backdrop od-overlay"><div class="modal" role="dialog" aria-modal="true"><div class="modal-head danger"><div class="modal-icon">${renderIcon('fa-trash-can')}</div><div class="modal-head-text"><h3>${escapeHtml(this.tr('agentoffice.delete'))}</h3></div><button class="modal-close" data-action="close-modal" aria-label="${escapeHtml(this.tr('agentoffice.cancel'))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div><div class="modal-body"><p>${escapeHtml(this.tr('agentoffice.deleteWarning'))}</p></div><div class="modal-footer"><button class="secondary" data-action="close-modal">${escapeHtml(this.tr('agentoffice.cancel'))}</button><button class="secondary" data-action="delete-trash">${escapeHtml(this.tr('agentoffice.moveToTrash'))}</button><button class="danger" data-action="delete-permanent">${escapeHtml(this.tr('agentoffice.deletePermanently'))}</button></div></div></div>`;
        }
        return '';
    }

    private bindSkillDetailCard(): void {
        if (this.modal !== 'skill-detail' || !this.selectedSkill) return;
        const card = this.shadowRoot?.querySelector<SkillDetailCard>('#staff-skill-detail-card');
        if (!card) return;
        const skill = this.selectedSkill;
        const metadata = [
            { label: this.tr('agentoffice.skillDirectory'), value: skill.directory_name },
            { label: this.tr('agentoffice.skillLicense'), value: skill.license },
            { label: this.tr('agentoffice.skillCompatibility'), value: skill.compatibility },
            { label: this.tr('agentoffice.skillAllowedTools'), value: skill.allowed_tools?.join(', ') }
        ].filter((item): item is { label: string; value: string } => Boolean(item.value));
        const model: SkillDetailCardModel = {
            id: skill.directory_name,
            name: skill.name,
            closeLabel: this.tr('agentoffice.close'),
            description: skill.description,
            descriptionLabel: this.tr('agentoffice.skillIntroduction'),
            bodyHtml: skill.body ? renderSafeMarkdown(skill.body) : undefined,
            bodyLabel: this.tr('agentoffice.skillContent'),
            metadata,
            metadataLabel: this.tr('agentoffice.skillMetadata'),
            actions: [
                {
                    id: 'delete',
                    data: skill.directory_name,
                    label: this.tr('agentoffice.delete'),
                    variant: 'danger'
                },
                { id: 'close', label: this.tr('agentoffice.close') }
            ]
        };
        card.dataset.theme = this.dataset.theme || 'light';
        card.model = model;
        card.addEventListener('skill-detail-action', (event) => {
            const detail = (event as CustomEvent<{ id: string; data?: string }>).detail;
            if (detail.id === 'delete' && detail.data) {
                this.runOperation(() => this.deleteSkill(detail.data!));
            } else if (detail.id === 'close') {
                this.closeModal();
            }
        });
    }

    private bindEvents(): void {
        this.bindSkillDetailCard();
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-tab]').forEach((element) =>
            element.addEventListener('click', () => {
                void this.flushAutoSave();
                this.rememberFlowDraft();
                ++this.flowOpenRequest;
                this.activeTab = element.dataset.tab as AgentOfficeTab;
                this.detail = null;
                this.selectedFlow = null;
                this.status = '';
                this.closeSkillAddMenu();
                if (this.activeTab === 'flows') void this.reloadFlows();
                else this.render();
            })
        );
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-flow-detail]').forEach((element) =>
            element.addEventListener('click', () => {
                void this.openFlow(element.dataset.flowDetail!);
            })
        );
        this.shadowRoot?.querySelector<HTMLInputElement>('#flow-search')?.addEventListener('input', (event) => {
            this.flowQuery = (event.target as HTMLInputElement).value;
            this.filterFlowCards();
        });
        this.shadowRoot
            ?.querySelector<HTMLSelectElement>('#flow-status-filter')
            ?.addEventListener('change', (event) => {
                this.flowStatusFilter = (event.target as HTMLSelectElement).value as FlowListStatus;
                this.selectedFlow = null;
                void this.reloadFlows();
            });
        this.shadowRoot?.querySelector('[data-action="new-flow"]')?.addEventListener('click', () => {
            this.modal = 'new-flow';
            this.render();
        });
        this.shadowRoot?.querySelector('[data-action="back-flow"]')?.addEventListener('click', () => {
            this.rememberFlowDraft();
            ++this.flowOpenRequest;
            this.selectedFlow = null;
            this.flowMessages = [];
            this.flowReferencedMessages.clear();
            this.flowHistoryCursor = undefined;
            this.flowDraftText = '';
            this.flowReplyToMessageId = undefined;
            this.flowAttachments = [];
            this.flowImageDataUris = [];
            this.flowPendingRequestId = undefined;
            this.flowPendingPayloadKey = undefined;
            this.flowPendingRequestFlowId = undefined;
            this.status = '';
            this.render();
        });
        this.shadowRoot?.querySelector('[data-action="flow-settings"]')?.addEventListener('click', () => {
            this.flowView = 'settings';
            this.status = '';
            this.render();
        });
        this.shadowRoot?.querySelector('[data-action="flow-chat"]')?.addEventListener('click', () => {
            this.flowView = 'chat';
            this.status = '';
            this.flowScrollToBottomOnNextRender = true;
            this.render();
        });
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-flow-mention]').forEach((element) =>
            element.addEventListener('click', () => {
                const member = this.selectedFlow?.members.find(
                    (candidate) => candidate.staffId === element.dataset.flowMention
                );
                const input = this.shadowRoot?.querySelector<HTMLTextAreaElement>('#flow-message-input');
                if (!member?.name || !input) return;
                const mention = `@${member.name} `;
                input.value = `${input.value}${input.value && !input.value.endsWith(' ') ? ' ' : ''}${mention}`;
                this.flowDraftText = input.value;
                input.focus();
            })
        );
        this.shadowRoot
            ?.querySelector<HTMLTextAreaElement>('#flow-message-input')
            ?.addEventListener('input', (event) => {
                this.flowDraftText = (event.target as HTMLTextAreaElement).value;
            });
        this.shadowRoot
            ?.querySelector<HTMLTextAreaElement>('#flow-message-input')
            ?.addEventListener('keydown', (event) => {
                if (event.isComposing || event.key !== 'Enter' || event.shiftKey) return;
                if (this.ctrlEnterSend && !event.ctrlKey) return;
                event.preventDefault();
                void this.sendCurrentFlowMessage();
            });
        this.shadowRoot?.querySelector('[data-action="flow-send"]')?.addEventListener('click', () => {
            void this.sendCurrentFlowMessage();
        });
        this.shadowRoot?.querySelector('[data-action="flow-attach"]')?.addEventListener('click', () => {
            void this.pickFlowAttachments();
        });
        this.shadowRoot?.querySelector('[data-action="flow-older"]')?.addEventListener('click', () => {
            void this.loadFlowMessages(this.flowHistoryCursor);
        });
        this.shadowRoot?.querySelectorAll<HTMLElement>('.flow-message[data-flow-message]').forEach((element) =>
            element.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.showFlowMessageContextMenu(event.clientX, event.clientY, element.dataset.flowMessage!);
            })
        );
        this.shadowRoot?.querySelector('[data-action="cancel-flow-reply"]')?.addEventListener('click', () => {
            this.flowReplyToMessageId = undefined;
            this.render();
            this.shadowRoot?.querySelector<HTMLTextAreaElement>('#flow-message-input')?.focus();
        });
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-remove-flow-attachment]').forEach((element) =>
            element.addEventListener('click', () => {
                this.flowAttachments.splice(Number(element.dataset.removeFlowAttachment), 1);
                this.render();
            })
        );
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-remove-flow-image]').forEach((element) =>
            element.addEventListener('click', () => {
                this.flowImageDataUris.splice(Number(element.dataset.removeFlowImage), 1);
                this.render();
            })
        );
        const flowComposer = this.shadowRoot?.querySelector<HTMLElement>('#flow-composer');
        flowComposer?.addEventListener('dragover', (event) => {
            event.preventDefault();
            flowComposer.classList.add('drag-over');
        });
        flowComposer?.addEventListener('dragleave', () => flowComposer.classList.remove('drag-over'));
        flowComposer?.addEventListener('drop', (event) => void this.handleFlowComposerDrop(event));
        this.shadowRoot
            ?.querySelector<HTMLTextAreaElement>('#flow-message-input')
            ?.addEventListener('paste', (event) => {
                this.handleFlowComposerPaste(event);
            });
        this.shadowRoot
            ?.querySelector('[data-action="create-flow"]')
            ?.addEventListener('click', () => void this.createFlow());
        this.shadowRoot
            ?.querySelector('[data-action="save-flow"]')
            ?.addEventListener('click', () => this.runOperation(() => this.saveFlow()));
        this.shadowRoot?.querySelector('[data-action="delete-flow"]')?.addEventListener('click', () => {
            this.modal = 'delete-flow';
            this.render();
        });
        this.shadowRoot?.querySelector('[data-action="confirm-delete-flow"]')?.addEventListener('click', () => {
            this.runOperation(() => this.deleteFlow());
        });
        this.shadowRoot?.querySelector('[data-action="archive-flow"]')?.addEventListener('click', () => {
            this.modal = 'archive-flow';
            this.render();
        });
        this.shadowRoot
            ?.querySelector('[data-action="confirm-archive-flow"]')
            ?.addEventListener('click', () => this.runOperation(() => this.archiveFlow()));
        this.shadowRoot
            ?.querySelector('[data-action="confirm-delete-flow-message"]')
            ?.addEventListener('click', () => void this.deleteSelectedFlowMessage());
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-staff]').forEach((element) =>
            element.addEventListener('click', () => {
                this.selectedStaffId = element.dataset.staff!;
                void this.loadMessages();
            })
        );
        this.bindStaffPreviews();
        this.shadowRoot?.querySelector<HTMLInputElement>('#staff-search')?.addEventListener('input', (event) => {
            this.query = (event.target as HTMLInputElement).value;
            this.filterStaffRows();
        });
        this.shadowRoot
            ?.querySelector('[data-action="attach"]')
            ?.addEventListener('click', () => void this.pickAttachments());
        this.shadowRoot?.querySelector<HTMLSelectElement>('#chat-model-select')?.addEventListener('change', (event) => {
            const value = (event.target as HTMLSelectElement).value;
            const staffId = this.selectedStaffId;
            if (!staffId) return;
            const staff = this.staffs.find((item) => item.id === staffId);
            if (staff) staff.model = value || undefined;
            this.call('updateStaff', staffId, { model: value || null }).catch((error: unknown) => {
                this.status = `${this.tr('agentoffice.operationFailed')}: ${this.errorText(error)}`;
                this.render();
            });
        });
        this.shadowRoot
            ?.querySelector('[data-action="send"]')
            ?.addEventListener('click', () => void this.sendMessage());
        this.shadowRoot?.querySelector('[data-action="send-menu"]')?.addEventListener('click', (event) => {
            event.stopPropagation();
            if (this.sendMenuOpen) {
                this.closeSendMenu();
            } else {
                this.showSendMenu();
            }
        });
        this.shadowRoot?.querySelector<HTMLTextAreaElement>('#message-input')?.addEventListener('keydown', (event) => {
            if (event.isComposing) return;
            if (this.ctrlEnterSend) {
                if (event.key === 'Enter' && event.ctrlKey) {
                    event.preventDefault();
                    void this.sendMessage();
                }
            } else if (event.key === 'Enter' && !event.ctrlKey && !event.shiftKey) {
                event.preventDefault();
                void this.sendMessage();
            } else if (event.key === 'Enter' && event.ctrlKey) {
                // Ctrl+Enter（含 Ctrl+Shift+Enter）换行：textarea 默认仅 Enter/Shift+Enter 换行
                event.preventDefault();
                this.insertNewline(event.target as HTMLTextAreaElement);
            }
        });
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-remove-attachment]').forEach((element) =>
            element.addEventListener('click', () => {
                this.attachments.splice(Number(element.dataset.removeAttachment), 1);
                this.render();
            })
        );
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-remove-image]').forEach((element) =>
            element.addEventListener('click', () => {
                this.imageDataUris.splice(Number(element.dataset.removeImage), 1);
                this.render();
            })
        );
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-image-preview]').forEach((element) =>
            element.addEventListener('click', () => {
                const idx = Number(element.dataset.imagePreview);
                const img = this.imageDataUris[idx];
                if (img) window.open(img.dataUrl, '_blank');
            })
        );
        const composerOuter = this.shadowRoot?.querySelector<HTMLElement>('#composer-outer');
        composerOuter?.addEventListener('dragover', (event) => {
            event.preventDefault();
            event.stopPropagation();
            composerOuter.classList.add('drag-over');
        });
        composerOuter?.addEventListener('dragleave', (event) => {
            if (!composerOuter.contains(event.relatedTarget as Node)) {
                composerOuter.classList.remove('drag-over');
            }
        });
        composerOuter?.addEventListener('drop', (event) => void this.handleComposerDrop(event));
        const messageInput = this.shadowRoot?.querySelector<HTMLTextAreaElement>('#message-input');
        messageInput?.addEventListener('paste', (event) => {
            this.handleComposerPaste(event);
        });
        messageInput?.addEventListener('input', () => this.updateSendButtonState());
        this.shadowRoot
            ?.querySelector('[data-action="older"]')
            ?.addEventListener('click', () => void this.loadMessages(this.historyCursor));
        this.shadowRoot?.querySelectorAll<HTMLElement>('.message[data-message-id]').forEach((element) =>
            element.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.showMessageContextMenu(event.clientX, event.clientY, element);
            })
        );
        this.shadowRoot
            ?.querySelectorAll<HTMLElement>('[data-task]')
            .forEach((element) =>
                element.addEventListener('click', () =>
                    window.parent.postMessage({ type: 'openTask', taskId: element.dataset.task }, '*')
                )
            );
        this.shadowRoot?.querySelector('[data-action="new"]')?.addEventListener('click', () => {
            this.status = '';
            this.modal = 'new';
            this.render();
            this.shadowRoot?.querySelector<HTMLInputElement>('#new-name')?.focus();
        });
        this.shadowRoot
            ?.querySelector('[data-action="import"]')
            ?.addEventListener('click', () => void this.importStaff());
        this.shadowRoot
            ?.querySelectorAll<HTMLElement>('[data-detail]')
            .forEach((element) =>
                element.addEventListener('click', () => this.openDetailFromList(element.dataset.detail!))
            );
        this.shadowRoot?.querySelector('[data-action="back"]')?.addEventListener('click', () => {
            void this.flushAutoSave();
            this.detail = null;
            this.status = '';
            this.closeSkillAddMenu();
            this.render();
        });
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-section]').forEach((element) =>
            element.addEventListener('click', () => {
                void this.flushAutoSave();
                this.detailSection = element.dataset.section as DetailSection;
                this.status = '';
                this.closeSkillAddMenu();
                this.render();
            })
        );
        this.shadowRoot
            ?.querySelectorAll('[data-action="portrait"]')
            .forEach((element) => element.addEventListener('click', () => this.openPortraitEditor()));
        this.shadowRoot
            ?.querySelector('[data-action="add-directory"]')
            ?.addEventListener('click', () => this.runOperation(() => this.addDirectory()));
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-remove-dir]').forEach((element) =>
            element.addEventListener('click', () => {
                this.syncSecurityDraft();
                this.detail!.permission.directories.splice(Number(element.dataset.removeDir), 1);
                this.render();
                this.queueStaffUpdate({ permission: this.copyPermission() }, true);
            })
        );
        this.shadowRoot?.querySelectorAll<HTMLSelectElement>('[data-dir-access]').forEach((select) =>
            select.addEventListener('change', () => {
                this.syncSecurityDraft();
                this.queueStaffUpdate({ permission: this.copyPermission() }, true);
            })
        );
        this.shadowRoot?.querySelector<HTMLInputElement>('#f-network')?.addEventListener('change', () => {
            this.syncSecurityDraft();
            this.queueStaffUpdate({ permission: this.copyPermission() }, true);
        });
        this.shadowRoot?.querySelector('[data-action="toggle-skill-menu"]')?.addEventListener('click', () => {
            if (this.skillAddMenuOpen) {
                this.closeSkillAddMenu();
            } else {
                this.openSkillAddMenu();
            }
        });
        this.shadowRoot
            ?.querySelector('[data-action="add-skill-directory"]')
            ?.addEventListener('click', () => this.runOperation(() => this.addSkillFromDirectory()));
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-skill-detail]').forEach((element) =>
            element.addEventListener('click', () => {
                this.selectedSkill =
                    this.skills.find((skill) => skill.directory_name === element.dataset.skillDetail) ?? null;
                this.modal = this.selectedSkill ? 'skill-detail' : null;
                this.render();
            })
        );
        this.shadowRoot?.querySelectorAll<HTMLInputElement>('[data-installed-skill]').forEach((input) =>
            input.addEventListener('change', () => {
                if (input.checked) this.selectedInstalledSkillIds.add(input.dataset.installedSkill!);
                else this.selectedInstalledSkillIds.delete(input.dataset.installedSkill!);
            })
        );
        this.shadowRoot
            ?.querySelector('[data-action="confirm-installed-skills"]')
            ?.addEventListener('click', () => this.runOperation(() => this.addSelectedInstalledSkills()));
        this.shadowRoot?.querySelectorAll<HTMLInputElement>('[data-batch-skill]').forEach((input) =>
            input.addEventListener('change', () => {
                if (input.checked) this.selectedBatchSkillPaths.add(input.dataset.batchSkill!);
                else this.selectedBatchSkillPaths.delete(input.dataset.batchSkill!);
                const confirm = this.shadowRoot?.querySelector<HTMLButtonElement>(
                    '[data-action="confirm-batch-skills"]'
                );
                if (confirm) confirm.disabled = this.selectedBatchSkillPaths.size === 0;
            })
        );
        this.shadowRoot
            ?.querySelector('[data-action="confirm-batch-skills"]')
            ?.addEventListener('click', () => this.runOperation(() => this.addSelectedBatchSkills()));
        this.shadowRoot?.querySelector<HTMLInputElement>('#skill-url-input')?.addEventListener('input', (event) => {
            this.skillUrl = (event.target as HTMLInputElement).value;
            this.skillModalError = '';
            const error = this.shadowRoot?.querySelector<HTMLElement>('#skill-modal-error');
            if (error) error.textContent = '';
        });
        this.shadowRoot?.querySelector<HTMLInputElement>('#skill-url-input')?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault();
                this.runOperation(() => this.addSkillFromUrl());
            }
        });
        this.shadowRoot
            ?.querySelector('[data-action="confirm-skill-url"]')
            ?.addEventListener('click', () => this.runOperation(() => this.addSkillFromUrl()));
        this.shadowRoot
            ?.querySelectorAll<HTMLElement>('[data-delete-skill]')
            .forEach((element) =>
                element.addEventListener('click', () =>
                    this.runOperation(() => this.deleteSkill(element.dataset.deleteSkill!))
                )
            );
        this.shadowRoot
            ?.querySelector('[data-action="export"]')
            ?.addEventListener('click', () => this.runOperation(() => this.exportStaff()));
        this.shadowRoot
            ?.querySelector('[data-action="open-directory"]')
            ?.addEventListener('click', () => this.runOperation(() => this.openStaffDirectory()));
        this.shadowRoot?.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
            this.modal = 'delete';
            this.render();
        });
        this.shadowRoot
            ?.querySelectorAll('[data-action="close-modal"]')
            .forEach((element) => element.addEventListener('click', () => this.closeModal()));
        this.shadowRoot
            ?.querySelector('[data-action="create"]')
            ?.addEventListener('click', () => void this.createStaff());
        this.shadowRoot?.querySelector('[data-action="portrait-pick"]')?.addEventListener('click', () => {
            const input = this.shadowRoot?.querySelector<HTMLInputElement>('#portrait-file');
            if (!input) return;
            input.value = '';
            input.click();
        });
        this.shadowRoot?.querySelector<HTMLInputElement>('#portrait-file')?.addEventListener('change', (event) => {
            const file = (event.target as HTMLInputElement).files?.[0];
            if (file) void this.loadPortraitFile(file);
        });
        this.shadowRoot?.querySelector<HTMLInputElement>('#portrait-zoom')?.addEventListener('input', (event) => {
            this.portraitZoom = Number((event.target as HTMLInputElement).value);
            this.clampPortraitOffset();
            this.drawPortrait();
        });
        this.shadowRoot
            ?.querySelector('[data-action="save-portrait"]')
            ?.addEventListener('click', () => void this.savePortrait());
        this.bindPortraitDrag();
        this.shadowRoot?.querySelectorAll<HTMLInputElement>('[data-new-field] input').forEach((input) =>
            input.addEventListener('input', () => {
                input.closest('.field')?.classList.remove('invalid');
                input.removeAttribute('aria-invalid');
                const modalError = this.shadowRoot?.querySelector<HTMLElement>('#new-modal-error');
                if (modalError) modalError.textContent = '';
            })
        );
        this.shadowRoot
            ?.querySelectorAll<HTMLInputElement>('[data-basic-field] input')
            .forEach((input) => input.addEventListener('input', () => this.handleBasicFieldInput(input)));
        this.shadowRoot
            ?.querySelector<HTMLInputElement>('#f-specialties')
            ?.addEventListener('input', (event) => this.handleSpecialtiesInput(event.target as HTMLInputElement));
        this.shadowRoot
            ?.querySelector<HTMLTextAreaElement>('#f-agents')
            ?.addEventListener('input', (event) => this.handleInstructionsInput(event.target as HTMLTextAreaElement));
        this.shadowRoot?.querySelector<HTMLSelectElement>('#f-model')?.addEventListener('change', (event) => {
            if (!this.detail) return;
            const model = (event.target as HTMLSelectElement).value || undefined;
            this.detail.model = model;
            this.queueStaffUpdate({ model: model ?? null }, true);
        });
        this.shadowRoot
            ?.querySelector<HTMLSelectElement>('#f-trigger-interval')
            ?.addEventListener('change', (event) => {
                if (!this.detail) return;
                this.detail.trigger_interval = (event.target as HTMLSelectElement)
                    .value as StaffDetail['trigger_interval'];
                this.queueDefinitionUpdate(true);
            });
        this.shadowRoot?.querySelector<HTMLInputElement>('#f-enabled')?.addEventListener('change', (event) => {
            if (!this.detail) return;
            const enabled = (event.target as HTMLInputElement).checked;
            this.detail.enabled = enabled;
            this.queueStaffUpdate({ enabled }, true);
        });
        this.shadowRoot?.querySelector<HTMLInputElement>('#f-local-service')?.addEventListener('change', (event) => {
            this.handleLocalServiceToggle((event.target as HTMLInputElement).checked);
        });
        this.shadowRoot
            ?.querySelector<HTMLSelectElement>('#f-local-service-host')
            ?.addEventListener('change', (event) => {
                this.handleLocalServiceConfigChange({ host: (event.target as HTMLSelectElement).value });
            });
        this.shadowRoot
            ?.querySelector<HTMLInputElement>('#f-local-service-port')
            ?.addEventListener('change', (event) => {
                this.handleLocalServicePortChange((event.target as HTMLInputElement).value);
            });
        this.shadowRoot
            ?.querySelector<HTMLInputElement>('#f-local-service-user-token')
            ?.addEventListener('change', (event) => {
                this.handleLocalServiceTokenChange('user_token', (event.target as HTMLInputElement).value);
            });
        this.shadowRoot
            ?.querySelector<HTMLInputElement>('#f-local-service-manage-token')
            ?.addEventListener('change', (event) => {
                this.handleLocalServiceTokenChange('manage_token', (event.target as HTMLInputElement).value);
            });
        this.shadowRoot
            ?.querySelector('[data-action="generate-user-token"]')
            ?.addEventListener('click', () => this.generateServiceTokenField('user_token'));
        this.shadowRoot
            ?.querySelector('[data-action="generate-manage-token"]')
            ?.addEventListener('click', () => this.generateServiceTokenField('manage_token'));
        this.shadowRoot
            ?.querySelector<HTMLInputElement>('#f-local-service-https')
            ?.addEventListener('change', (event) => {
                this.handleLocalServiceConfigChange({ https: (event.target as HTMLInputElement).checked });
            });
        this.shadowRoot
            ?.querySelector<HTMLInputElement>('#f-local-service-allow-iframe')
            ?.addEventListener('change', (event) => {
                this.handleLocalServiceConfigChange({
                    allow_iframe_embedding: (event.target as HTMLInputElement).checked
                });
            });
        this.shadowRoot
            ?.querySelector<HTMLInputElement>('#f-local-service-hide-info')
            ?.addEventListener('change', (event) => {
                this.handleLocalServiceConfigChange({
                    hide_staff_info: (event.target as HTMLInputElement).checked
                });
            });
        const serviceStatus = this.shadowRoot?.querySelector<HTMLElement>('#local-service-status');
        if (serviceStatus) this.bindServiceLinkButtons(serviceStatus);
        this.shadowRoot
            ?.querySelector<HTMLTextAreaElement>('#f-mcp')
            ?.addEventListener('input', (event) => this.handleMcpInput(event.target as HTMLTextAreaElement));
        this.shadowRoot
            ?.querySelector('[data-action="delete-trash"]')
            ?.addEventListener('click', () => this.runOperation(() => this.performDelete('trash')));
        this.shadowRoot
            ?.querySelector('[data-action="delete-permanent"]')
            ?.addEventListener('click', () => this.runOperation(() => this.performDelete('permanent')));
    }

    private async openDetail(staffId: string): Promise<void> {
        if (this.detail?.id !== staffId) {
            this.autoSaveState = 'idle';
            this.autoSaveDetail = '';
            this.status = '';
            this.localServiceRuntime = null;
        }
        // 服务运行状态与详情数据同批获取：若分开请求，先返回的结果会因 detail 尚未赋值被丢弃
        const [detail, skills, modelCatalog, serviceInfo] = await Promise.all([
            this.call<StaffDetail>('getStaffDetail', staffId),
            this.call<StaffSkillSummary[]>('listSkills', staffId),
            this.call<ModelCatalog>('listChatModels'),
            this.call<{ config: StaffLocalService; runtime: LocalServiceRuntime }>(
                'getLocalServiceInfo',
                staffId
            ).catch(() => null)
        ]);
        this.detail = detail;
        this.skills = skills;
        this.modelCatalog = modelCatalog;
        this.localServiceRuntime = serviceInfo?.runtime ?? null;
        this.render();
    }

    private openDetailFromList(staffId: string): void {
        this.status = '';
        this.runOperation(() => this.openDetail(staffId));
    }

    private showFlowMessageContextMenu(x: number, y: number, messageId: string): void {
        this.dismissMessageContextMenu();
        const message = this.findFlowMessage(messageId);
        if (!message || !this.shadowRoot) return;
        const menu = document.createElement('div');
        menu.className = 'ctx-menu' + (this.dataset.theme === 'dark' ? ' ctx-menu-dark' : '');
        menu.innerHTML = `<button class="ctx-item" data-flow-message-menu="quote"><span class="ctx-icon-sm"><i class="fa-solid fa-reply"></i></span><span class="ctx-label">${escapeHtml(this.tr('agentoffice.flow.message.quote'))}</span></button><div class="ctx-divider"></div><button class="ctx-item danger" data-flow-message-menu="delete"><span class="ctx-icon-sm"><i class="fa-solid fa-trash-can"></i></span><span class="ctx-label">${escapeHtml(this.tr('agentoffice.flow.message.delete'))}</span></button>`;
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        this.shadowRoot.querySelector('.root')?.appendChild(menu);
        requestAnimationFrame(() => {
            const margin = 12;
            const rect = menu.getBoundingClientRect();
            menu.style.left = `${Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - rect.width - margin))}px`;
            menu.style.top = `${Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - rect.height - margin))}px`;
        });
        menu.querySelector('[data-flow-message-menu="quote"]')?.addEventListener('click', () => {
            this.flowReplyToMessageId = message.id;
            this.dismissMessageContextMenu();
            this.render();
            this.shadowRoot?.querySelector<HTMLTextAreaElement>('#flow-message-input')?.focus();
        });
        menu.querySelector('[data-flow-message-menu="delete"]')?.addEventListener('click', () => {
            this.flowDeleteMessageId = message.id;
            this.modal = 'delete-flow-message';
            this.dismissMessageContextMenu();
            this.render();
        });
        setTimeout(() => window.addEventListener('mousedown', this.dismissMessageContextMenu), 0);
    }

    private showMessageContextMenu(x: number, y: number, element: HTMLElement): void {
        this.dismissMessageContextMenu();
        const message = this.messages.find((item) => item.id === element.dataset.messageId);
        if (!message || !this.shadowRoot) return;
        // 分块删除：多分块消息的每个部分（文本/图片/视频/音频/文件）都可单独删除
        const partLabels: Record<string, string> = {
            text: this.tr('agentoffice.deleteMessagePart.text'),
            image: this.tr('agentoffice.deleteMessagePart.image'),
            video: this.tr('agentoffice.deleteMessagePart.video'),
            audio: this.tr('agentoffice.deleteMessagePart.audio'),
            file: this.tr('agentoffice.deleteMessagePart.file')
        };
        const partIcons: Record<string, string> = {
            text: 'fa-file-lines',
            image: 'fa-image',
            video: 'fa-film',
            audio: 'fa-music',
            file: 'fa-file-lines'
        };
        const menu = document.createElement('div');
        menu.className = 'ctx-menu' + (this.dataset.theme === 'dark' ? ' ctx-menu-dark' : '');
        const partItems = message.content
            .map((part, index) => ({ part, index }))
            .filter(({ part }) => part.type === 'resource' || message.content.length > 1)
            .map(({ part, index }) => {
                const mediaType = part.type === 'resource' ? part.media_type : 'text';
                const name = part.type === 'resource' ? `: ${part.name}` : '';
                return `<button class="ctx-item" data-message-menu="delete-part" data-part-index="${index}" title="${escapeHtml(`${partLabels[mediaType]}${name}`)}"><span class="ctx-icon-sm"><i class="fa-solid ${partIcons[mediaType]}"></i></span><span class="ctx-label">${escapeHtml(partLabels[mediaType])}${escapeHtml(name)}</span></button>`;
            })
            .join('');
        menu.innerHTML = `<button class="ctx-item" data-message-menu="copy"><span class="ctx-icon-sm"><i class="fa-solid fa-copy"></i></span><span class="ctx-label">${escapeHtml(this.tr('agentoffice.copy'))}</span></button><button class="ctx-item" data-message-menu="copy-plain"><span class="ctx-icon-sm"><i class="fa-solid fa-font"></i></span><span class="ctx-label">${escapeHtml(this.tr('agentoffice.copyPlain'))}</span></button><div class="ctx-divider"></div>${partItems}${partItems ? '<div class="ctx-divider"></div>' : ''}<button class="ctx-item danger" data-message-menu="delete-message"><span class="ctx-icon-sm"><i class="fa-solid fa-trash"></i></span><span class="ctx-label">${escapeHtml(this.tr('agentoffice.deleteMessage'))}</span></button><div class="ctx-divider"></div><button class="ctx-item" data-message-menu="open-task"><span class="ctx-icon-sm"><i class="fa-solid fa-arrow-up-right-from-square"></i></span><span class="ctx-label">${escapeHtml(this.tr('agentoffice.openTask'))}</span></button>`;
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        this.shadowRoot.querySelector('.root')?.appendChild(menu);
        requestAnimationFrame(() => {
            const margin = 12;
            const rect = menu.getBoundingClientRect();
            menu.style.left = `${Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - rect.width - margin))}px`;
            menu.style.top = `${Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - rect.height - margin))}px`;
        });
        menu.querySelector('[data-message-menu="copy"]')?.addEventListener('click', () => {
            void this.copyMessage(message, element, true).catch(() => {});
            this.dismissMessageContextMenu();
        });
        menu.querySelector('[data-message-menu="copy-plain"]')?.addEventListener('click', () => {
            void this.copyMessage(message, element, false).catch(() => {});
            this.dismissMessageContextMenu();
        });
        menu.querySelector('[data-message-menu="open-task"]')?.addEventListener('click', () => {
            window.parent.postMessage({ type: 'openTask', taskId: message.task_id }, '*');
            this.dismissMessageContextMenu();
        });
        // 删除分块（文本/图片/视频/音频/文件单独删除）与删除整条消息
        menu.querySelectorAll<HTMLElement>('[data-message-menu="delete-part"]').forEach((item) =>
            item.addEventListener('click', () => {
                this.dismissMessageContextMenu();
                this.deleteMessageContent('deleteStaffMessagePart', message.id, Number(item.dataset.partIndex));
            })
        );
        menu.querySelector('[data-message-menu="delete-message"]')?.addEventListener('click', () => {
            this.dismissMessageContextMenu();
            this.deleteMessageContent('deleteStaffMessage', message.id);
        });
        setTimeout(() => {
            window.addEventListener('mousedown', this.dismissMessageContextMenu);
            window.addEventListener('keydown', this.dismissContextMenuOnKeydown);
        }, 0);
    }

    /** 删除历史消息或其中的内容分块；删除后刷新会话（worker 会广播 messagesChanged，这里冗余刷新保证即时反馈）。 */
    private deleteMessageContent(
        method: 'deleteStaffMessage' | 'deleteStaffMessagePart',
        messageId: string,
        partIndex?: number
    ): void {
        if (!this.selectedStaffId) return;
        const call =
            partIndex === undefined
                ? this.call('deleteStaffMessage', this.selectedStaffId, messageId)
                : this.call('deleteStaffMessagePart', this.selectedStaffId, messageId, partIndex);
        void call
            .then(async () => {
                this.status = '';
                await this.loadMessages();
            })
            .catch((error) => {
                this.status = `${this.tr('agentoffice.operationFailed')}: ${this.errorText(error)}`;
                this.render();
            });
    }

    private async copyMessage(message: StaffMessage, element: HTMLElement, rich: boolean): Promise<void> {
        const body = element.cloneNode(true) as HTMLElement;
        body.querySelector('.message-meta')?.remove();
        const plainText = [
            body.textContent?.trim(),
            ...message.content
                .filter((part) => part.type === 'resource' && part.media_type !== 'file')
                .map((part) => (part as { name?: string }).name)
        ]
            .filter((part): part is string => Boolean(part))
            .join('\n');
        if (rich && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
            try {
                await navigator.clipboard.write([
                    new ClipboardItem({
                        'text/plain': new Blob([plainText], { type: 'text/plain' }),
                        'text/html': new Blob([body.innerHTML], { type: 'text/html' })
                    })
                ]);
                return;
            } catch {
                // Fall back to plain text where rich clipboard writes are unavailable.
            }
        }
        await navigator.clipboard.writeText(plainText);
    }

    private async sendMessage(): Promise<void> {
        if (!this.selectedStaffId || this.busy) return;
        const input = this.shadowRoot?.querySelector<HTMLTextAreaElement>('#message-input');
        const rawValue = input?.value ?? '';
        const text = rawValue.trim();
        if (!text && this.attachments.length === 0 && this.imageDataUris.length === 0) return;
        this.busy = true;
        // 先清空输入框再渲染：成功路径保持输入区为空，失败路径由下方草稿恢复
        if (input) input.value = '';
        this.render();
        let failed = false;
        try {
            await this.call('sendMessage', this.selectedStaffId, {
                text,
                attachments: this.attachments,
                image_data_uris: this.imageDataUris.map((img) => img.dataUrl)
            });
            this.attachments = [];
            this.imageDataUris = [];
            this.status = '';
            await this.reloadStaffs();
        } catch (error) {
            failed = true;
            this.status = this.errorText(error);
        } finally {
            this.busy = false;
            this.render();
            // 发送失败时恢复草稿，让用户直接重试
            if (failed && rawValue) {
                const draft = this.shadowRoot?.querySelector<HTMLTextAreaElement>('#message-input');
                if (draft) {
                    draft.value = rawValue;
                    this.updateSendButtonState();
                }
            }
        }
    }

    private async pickAttachments(): Promise<void> {
        const paths = (await (window as any).fsAPI.selectFile()) as string[];
        this.attachments.push(
            ...paths.map((filePath) => ({ path: filePath, name: filePath.split(/[\\/]/).pop() || filePath }))
        );
        this.render();
    }

    private async handleComposerDrop(event: DragEvent): Promise<void> {
        event.preventDefault();
        event.stopPropagation();
        const composerOuter = this.shadowRoot?.querySelector<HTMLElement>('#composer-outer');
        composerOuter?.classList.remove('drag-over');
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return;
        const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
        const fsAPI = (window as any).fsAPI;
        for (const file of files) {
            if (file.type.startsWith('image/') || imageExts.includes(file.name.split('.').pop()?.toLowerCase() ?? '')) {
                const reader = new FileReader();
                reader.onload = () => {
                    this.imageDataUris.push({ dataUrl: reader.result as string, name: file.name || 'image' });
                    this.render();
                };
                reader.readAsDataURL(file);
                continue;
            }
            const filePath = fsAPI?.getFilePath?.(file);
            if (!filePath) continue;
            const pathType = await fsAPI?.getPathType?.(filePath);
            if (pathType === 'directory') {
                const textarea = this.shadowRoot?.querySelector<HTMLTextAreaElement>('#message-input');
                if (textarea) {
                    const cursorPos = textarea.selectionStart;
                    const before = textarea.value.substring(0, cursorPos);
                    const after = textarea.value.substring(cursorPos);
                    textarea.value = before + filePath + after;
                    const newCursor = cursorPos + filePath.length;
                    textarea.setSelectionRange(newCursor, newCursor);
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }
            } else if (pathType === 'file') {
                this.attachments.push({ path: filePath, name: filePath.split(/[\\/]/).pop() || filePath });
            }
        }
        this.render();
    }

    private handleComposerPaste(event: ClipboardEvent): void {
        const items = event.clipboardData?.items;
        if (!items) return;
        if (hasPowerPointClipboardText(event.clipboardData)) return;
        let hasImage = false;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                hasImage = true;
                break;
            }
        }
        if (!hasImage) return;
        event.preventDefault();
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (!file) continue;
                const reader = new FileReader();
                reader.onload = () => {
                    this.imageDataUris.push({ dataUrl: reader.result as string, name: file.name || 'pasted-image' });
                    this.render();
                };
                reader.readAsDataURL(file);
            }
        }
    }

    private updateSendButtonState(): void {
        const textarea = this.shadowRoot?.querySelector<HTMLTextAreaElement>('#message-input');
        const sendBtn = this.shadowRoot?.querySelector<HTMLElement>('.composer-send-btn');
        const menuBtn = this.shadowRoot?.querySelector<HTMLElement>('.composer-send-menu-btn');
        if (!sendBtn) return;
        const hasContent =
            Boolean(textarea?.value.trim()) || this.attachments.length > 0 || this.imageDataUris.length > 0;
        sendBtn.classList.toggle('composer-send-active', hasContent);
        sendBtn.classList.toggle('composer-send-inactive', !hasContent);
        if (menuBtn) {
            menuBtn.classList.toggle('composer-send-active', hasContent);
            menuBtn.classList.toggle('composer-send-inactive', !hasContent);
        }
    }

    /** 在光标处插入换行（用于 Enter 发送模式下 Ctrl+Enter / Ctrl+Shift+Enter 换行） */
    private insertNewline(textarea: HTMLTextAreaElement): void {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.setRangeText('\n', start, end, 'end');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
    }

    /** 同步输入框原生 placeholder 与富文本覆盖层（发送快捷键模式切换后调用） */
    private updateComposerPlaceholder(): void {
        const textarea = this.shadowRoot?.querySelector<HTMLTextAreaElement>('#message-input');
        const overlay = this.shadowRoot?.querySelector<HTMLElement>('#composer-placeholder');
        if (textarea) textarea.placeholder = this.getInputPlaceholder();
        if (overlay) overlay.innerHTML = this.getPlaceholderHTML();
    }

    private showSendMenu(): void {
        this.closeSendMenu();
        const groupEl = this.shadowRoot?.querySelector<HTMLElement>('.composer-send-group');
        if (!groupEl || !this.shadowRoot) return;
        const menu = document.createElement('div');
        menu.className = 'composer-send-options-panel';
        menu.id = 'composer-send-menu';
        Object.assign(menu.style, { position: 'fixed', zIndex: '10002' });
        menu.innerHTML = `<div class="composer-send-menu-item" data-action="toggle-ctrl-enter"><span class="composer-send-menu-item-label">${escapeHtml(this.tr('agentoffice.ctrlEnterSend'))}</span><label class="composer-send-toggle"><input type="checkbox" ${this.ctrlEnterSend ? 'checked' : ''}><span class="composer-send-toggle-slider"></span></label></div>`;
        const rect = groupEl.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.right = `${window.innerWidth - rect.right}px`;
        this.shadowRoot.appendChild(menu);
        this.sendMenuOpen = true;
        // 输入区贴近窗口底部时改为向上展开，避免菜单被视口截断
        const menuHeight = menu.getBoundingClientRect().height;
        if (rect.bottom + menuHeight + 8 > window.innerHeight) {
            menu.style.top = `${Math.max(8, rect.top - menuHeight - 4)}px`;
        }
        menu.querySelector('[data-action="toggle-ctrl-enter"]')?.addEventListener('click', () => {
            this.ctrlEnterSend = !this.ctrlEnterSend;
            const input = menu.querySelector<HTMLInputElement>('input[type="checkbox"]');
            if (input) input.checked = this.ctrlEnterSend;
            this.updateComposerPlaceholder();
        });
        setTimeout(() => {
            window.addEventListener('mousedown', this.closeSendMenuHandler);
            window.addEventListener('keydown', this.closeSendMenuOnKeydown);
        }, 0);
    }

    private closeSendMenu(): void {
        this.shadowRoot?.querySelector('#composer-send-menu')?.remove();
        this.sendMenuOpen = false;
        window.removeEventListener('mousedown', this.closeSendMenuHandler);
        window.removeEventListener('keydown', this.closeSendMenuOnKeydown);
    }

    private async createFlow(): Promise<void> {
        const nameInput = this.shadowRoot?.querySelector<HTMLInputElement>('#new-flow-name');
        const goalInput = this.shadowRoot?.querySelector<HTMLTextAreaElement>('#new-flow-goal');
        const memberIds = [...(this.shadowRoot?.querySelectorAll<HTMLInputElement>('[data-new-flow-member]') ?? [])]
            .filter((input) => input.checked)
            .map((input) => input.dataset.newFlowMember!);
        const error = this.shadowRoot?.querySelector<HTMLElement>('#new-flow-error');
        if (!nameInput?.value.trim() || !goalInput?.value.trim() || memberIds.length === 0) {
            if (error) error.textContent = this.tr('agentoffice.flow.required');
            return;
        }
        try {
            await this.call('createFlow', {
                name: nameInput.value.trim(),
                goal: goalInput.value.trim(),
                memberIds
            });
            this.modal = null;
            this.status = '';
            await this.reloadFlows();
        } catch (caught) {
            if (error) error.textContent = `${this.tr('agentoffice.operationFailed')}: ${this.errorText(caught)}`;
        }
    }

    private async sendCurrentFlowMessage(): Promise<void> {
        if (!this.selectedFlow || this.busy || this.selectedFlow.status === 'archived') return;
        const input = this.shadowRoot?.querySelector<HTMLTextAreaElement>('#flow-message-input');
        const text = input?.value.trim();
        if (!text && this.flowAttachments.length === 0 && this.flowImageDataUris.length === 0) return;
        const submittedText = text ?? '';
        const submittedAttachments = this.flowAttachments.map((attachment) => ({ ...attachment }));
        const submittedImages = this.flowImageDataUris.map((image) => ({ ...image }));
        const submittedReplyToMessageId = this.flowReplyToMessageId;
        const payloadKey = JSON.stringify({
            text: submittedText,
            attachments: submittedAttachments,
            imageDataUris: submittedImages.map((image) => image.dataUrl),
            replyToMessageId: submittedReplyToMessageId
        });
        const flowId = this.selectedFlow.id;
        const retryRequestId = this.flowPendingRequestId;
        const requestId =
            retryRequestId &&
            this.flowPendingRequestFlowId === flowId &&
            this.flowPendingPayloadKey === payloadKey &&
            !this.flowPendingRequests.has(retryRequestId)
                ? retryRequestId
                : crypto.randomUUID();
        this.flowPendingRequests.set(requestId, flowId);
        this.flowDraftText = '';
        this.flowAttachments = [];
        this.flowImageDataUris = [];
        this.status = '';
        this.flowScrollToBottomOnNextRender = true;
        this.render();
        try {
            await this.call('sendFlowMessage', flowId, {
                clientRequestId: requestId,
                text: submittedText || undefined,
                attachments: submittedAttachments,
                imageDataUris: submittedImages.map((image) => image.dataUrl),
                replyToMessageId: submittedReplyToMessageId
            });
            if (this.flowReplyToMessageId === submittedReplyToMessageId) this.flowReplyToMessageId = undefined;
            if (this.flowPendingRequestId === requestId) {
                this.flowPendingRequestId = undefined;
                this.flowPendingPayloadKey = undefined;
                this.flowPendingRequestFlowId = undefined;
            }
            if (this.selectedFlow?.id === flowId) await this.loadFlowMessages();
        } catch (error) {
            this.status = this.errorText(error);
            this.flowPendingRequestId = requestId;
            this.flowPendingPayloadKey = payloadKey;
            this.flowPendingRequestFlowId = flowId;
            if (
                this.selectedFlow?.id === flowId &&
                !this.flowDraftText &&
                this.flowAttachments.length === 0 &&
                this.flowImageDataUris.length === 0
            ) {
                this.flowDraftText = submittedText;
                this.flowAttachments = submittedAttachments;
                this.flowImageDataUris = submittedImages;
            }
        } finally {
            this.flowPendingRequests.delete(requestId);
            this.render();
        }
    }

    private async deleteSelectedFlowMessage(): Promise<void> {
        const flowId = this.selectedFlow?.id;
        const messageId = this.flowDeleteMessageId;
        if (!flowId || !messageId) return;
        try {
            await this.call('deleteFlowMessage', flowId, messageId);
            if (this.flowReplyToMessageId === messageId) this.flowReplyToMessageId = undefined;
            this.modal = null;
            this.flowDeleteMessageId = undefined;
            this.status = '';
            if (this.selectedFlow?.id === flowId) await this.loadFlowMessages();
        } catch (error) {
            this.status = this.errorText(error);
            this.modal = null;
            this.flowDeleteMessageId = undefined;
            this.render();
        }
    }

    private async pickFlowAttachments(): Promise<void> {
        const paths = (await (window as any).fsAPI.selectFile()) as string[];
        this.flowAttachments.push(
            ...paths.map((filePath) => ({ path: filePath, name: filePath.split(/[\\/]/).pop() || filePath }))
        );
        this.render();
    }

    private async handleFlowComposerDrop(event: DragEvent): Promise<void> {
        event.preventDefault();
        const composer = this.shadowRoot?.querySelector<HTMLElement>('#flow-composer');
        composer?.classList.remove('drag-over');
        const files = event.dataTransfer?.files;
        if (!files) return;
        const fsAPI = (window as any).fsAPI;
        for (const file of files) {
            if (file.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = () => {
                    this.flowImageDataUris.push({ dataUrl: String(reader.result), name: file.name || 'image' });
                    this.render();
                };
                reader.readAsDataURL(file);
                continue;
            }
            const filePath = fsAPI?.getFilePath?.(file);
            if (filePath) {
                this.flowAttachments.push({
                    path: filePath,
                    name: file.name || filePath.split(/[\\/]/).pop() || filePath
                });
            }
        }
        this.render();
    }

    private handleFlowComposerPaste(event: ClipboardEvent): void {
        for (const item of event.clipboardData?.items ?? []) {
            if (!item.type.startsWith('image/')) continue;
            const file = item.getAsFile();
            if (!file) continue;
            event.preventDefault();
            const reader = new FileReader();
            reader.onload = () => {
                this.flowImageDataUris.push({ dataUrl: String(reader.result), name: file.name || 'pasted-image' });
                this.render();
            };
            reader.readAsDataURL(file);
        }
    }

    private async saveFlow(): Promise<void> {
        if (!this.selectedFlow || this.selectedFlow.status === 'archived') return;
        const name = this.shadowRoot?.querySelector<HTMLInputElement>('#flow-name')?.value.trim() ?? '';
        const goal = this.shadowRoot?.querySelector<HTMLTextAreaElement>('#flow-goal')?.value.trim() ?? '';
        const memberIds = [...(this.shadowRoot?.querySelectorAll<HTMLInputElement>('[data-flow-member]') ?? [])]
            .filter((input) => input.checked)
            .map((input) => input.dataset.flowMember!);
        if (!name || !goal || memberIds.length === 0) throw new Error(this.tr('agentoffice.flow.required'));

        let current = this.selectedFlow;
        if (name !== current.name || goal !== current.goal) {
            current = await this.call('updateFlow', current.id, current.revision, { name, goal });
        }
        if (
            memberIds.length !== current.memberIds.length ||
            memberIds.some((memberId, index) => memberId !== current.memberIds[index])
        ) {
            current = await this.call('setFlowMembers', current.id, current.revision, memberIds);
        }
        this.selectedFlow = await this.call('getFlow', current.id);
        this.flows = await this.call('listFlows', { status: this.flowStatusFilter });
        this.status = this.tr('agentoffice.flow.saved');
        this.render();
    }

    private async deleteFlow(): Promise<void> {
        if (!this.selectedFlow || this.selectedFlow.status !== 'archived') return;
        const flow = this.selectedFlow;
        this.modal = null;
        this.render();
        await this.call('deleteFlow', flow.id, flow.revision);
        this.flowDrafts.delete(flow.id);
        this.selectedFlow = null;
        this.flowMessages = [];
        this.flowReferencedMessages.clear();
        this.flowReplyToMessageId = undefined;
        this.flowDraftText = '';
        this.flowAttachments = [];
        this.flowImageDataUris = [];
        this.status = '';
        await this.reloadFlows();
    }

    private async archiveFlow(): Promise<void> {
        if (!this.selectedFlow) return;
        await this.call('archiveFlow', this.selectedFlow.id, this.selectedFlow.revision);
        this.modal = null;
        this.selectedFlow = null;
        this.status = '';
        await this.reloadFlows();
    }

    private async createStaff(): Promise<void> {
        const fields = [
            { input: '#new-name', container: '[data-new-field="name"]' },
            { input: '#new-vendor', container: '[data-new-field="vendor"]' },
            { input: '#new-title', container: '[data-new-field="title"]' }
        ];
        let firstInvalid: HTMLInputElement | undefined;
        for (const field of fields) {
            const input = this.shadowRoot?.querySelector<HTMLInputElement>(field.input);
            const invalid = !input?.value.trim();
            this.shadowRoot?.querySelector(field.container)?.classList.toggle('invalid', invalid);
            if (invalid) {
                input?.setAttribute('aria-invalid', 'true');
                firstInvalid ??= input;
            } else {
                input?.removeAttribute('aria-invalid');
            }
        }
        if (firstInvalid) {
            firstInvalid.focus();
            return;
        }

        const value = (id: string) => this.shadowRoot?.querySelector<HTMLInputElement>(id)?.value.trim() ?? '';
        const modal = this.shadowRoot?.querySelector<HTMLElement>('.modal');
        const modalError = this.shadowRoot?.querySelector<HTMLElement>('#new-modal-error');
        modal?.classList.add('submitting');
        if (modalError) modalError.textContent = '';
        try {
            await this.call('createStaff', {
                name: value('#new-name'),
                vendor_name: value('#new-vendor'),
                title: value('#new-title'),
                specialties: value('#new-specialties')
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
                trigger_interval:
                    (this.shadowRoot?.querySelector<HTMLSelectElement>('#new-trigger-interval')?.value as
                        StaffDetail['trigger_interval'] | undefined) ?? 'never'
            });
            this.modal = null;
            this.status = '';
            await this.reloadStaffs();
        } catch (error) {
            modal?.classList.remove('submitting');
            if (modalError) {
                modalError.textContent = `${this.tr('agentoffice.operationFailed')}: ${this.errorText(error)}`;
            }
        }
    }

    private async importStaff(): Promise<void> {
        const paths = (await (window as any).fsAPI.selectFile()) as string[];
        const zipPath = paths.find((item) => item.toLowerCase().endsWith('.zip'));
        if (!zipPath) return;
        try {
            await this.call('importStaff', zipPath);
            await this.reloadStaffs();
        } catch (error) {
            this.status = this.errorText(error);
            this.render();
        }
    }

    private handleBasicFieldInput(input: HTMLInputElement): void {
        if (!this.detail) return;
        const value = input.value.trim();
        const field = input.closest<HTMLElement>('[data-basic-field]');
        const invalid = value.length === 0;
        field?.classList.toggle('invalid', invalid);
        input.toggleAttribute('aria-invalid', invalid);
        if (invalid) {
            this.discardPendingField(this.detail.id, 'definition');
            this.showAutoSaveState('invalid', this.tr('agentoffice.autoSaveInvalid'), this.detail.id);
            return;
        }

        if (input.id === 'f-name') {
            this.detail.name = value;
            const heading = this.shadowRoot?.querySelector<HTMLElement>('[data-detail-name]');
            if (heading) heading.textContent = value;
        } else if (input.id === 'f-vendor') {
            this.detail.vendor_name = value;
        } else if (input.id === 'f-title') {
            this.detail.title = value;
            const heading = this.shadowRoot?.querySelector<HTMLElement>('[data-detail-title]');
            if (heading) heading.textContent = value;
        }
        this.queueDefinitionUpdate();
    }

    private handleSpecialtiesInput(input: HTMLInputElement): void {
        if (!this.detail) return;
        this.detail.specialties = input.value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
        this.queueDefinitionUpdate();
    }

    private handleInstructionsInput(input: HTMLTextAreaElement): void {
        if (!this.detail) return;
        this.detail.agents_md = input.value;
        this.queueStaffUpdate({ agents_md: input.value });
    }

    private handleMcpInput(input: HTMLTextAreaElement): void {
        if (!this.detail) return;
        const field = input.closest<HTMLElement>('[data-mcp-field]');
        const error = this.shadowRoot?.querySelector<HTMLElement>('#mcp-field-error');
        let parsed: { servers: unknown[] };
        try {
            parsed = JSON.parse(input.value) as { servers: unknown[] };
        } catch {
            const message = this.tr('agentoffice.mcpInvalidJson');
            this.discardPendingField(this.detail.id, 'mcp');
            field?.classList.add('invalid');
            input.setAttribute('aria-invalid', 'true');
            if (error) error.textContent = message;
            this.showAutoSaveState('invalid', this.tr('agentoffice.autoSaveInvalid'), this.detail.id);
            return;
        }
        if (!Array.isArray(parsed?.servers)) {
            const message = this.tr('agentoffice.mcpServersArray');
            this.discardPendingField(this.detail.id, 'mcp');
            field?.classList.add('invalid');
            input.setAttribute('aria-invalid', 'true');
            if (error) error.textContent = message;
            this.showAutoSaveState('invalid', this.tr('agentoffice.autoSaveInvalid'), this.detail.id);
            return;
        }
        field?.classList.remove('invalid');
        input.removeAttribute('aria-invalid');
        if (error) error.textContent = '';
        this.detail.mcp = parsed;
        this.queueStaffUpdate({ mcp: parsed });
    }

    private queueDefinitionUpdate(immediate = false): void {
        if (!this.detail) return;
        this.queueStaffUpdate(
            {
                definition: {
                    name: this.detail.name,
                    vendor_name: this.detail.vendor_name,
                    title: this.detail.title,
                    specialties: [...this.detail.specialties],
                    trigger_interval: this.detail.trigger_interval ?? 'never'
                }
            },
            immediate
        );
    }

    private openPortraitEditor(): void {
        this.portraitImage = undefined;
        this.portraitZoom = 1;
        this.portraitOffsetX = 0;
        this.portraitOffsetY = 0;
        this.portraitError = '';
        this.modal = 'portrait';
        this.render();
    }

    private closeModal(): void {
        this.modal = null;
        this.flowDeleteMessageId = undefined;
        this.selectedSkill = null;
        this.selectedInstalledSkillIds.clear();
        this.batchSkillCandidates = [];
        this.selectedBatchSkillPaths.clear();
        this.skillBatchResult = null;
        this.skillUrl = '';
        this.skillModalError = '';
        this.portraitImage = undefined;
        this.portraitError = '';
        this.render();
    }

    private async loadPortraitFile(file: File): Promise<void> {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
            this.setPortraitError(this.tr('agentoffice.portraitFileInvalid'));
            return;
        }
        if (file.size > PORTRAIT_MAX_FILE_BYTES) {
            this.setPortraitError(this.tr('agentoffice.portraitFileTooLarge'));
            return;
        }
        try {
            const source = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(file);
            });
            const image = await new Promise<HTMLImageElement>((resolve, reject) => {
                const candidate = new Image();
                candidate.onload = () => resolve(candidate);
                candidate.onerror = reject;
                candidate.src = source;
            });
            this.portraitImage = image;
            this.portraitZoom = 1;
            this.portraitOffsetX = 0;
            this.portraitOffsetY = 0;
            this.setPortraitError('');
            const zoom = this.shadowRoot?.querySelector<HTMLInputElement>('#portrait-zoom');
            if (zoom) {
                zoom.disabled = false;
                zoom.value = '1';
            }
            const save = this.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="save-portrait"]');
            if (save) save.disabled = false;
            const empty = this.shadowRoot?.querySelector<HTMLElement>('#portrait-crop-empty');
            if (empty) empty.hidden = true;
            this.drawPortrait();
        } catch {
            this.setPortraitError(this.tr('agentoffice.portraitLoadFailed'));
        }
    }

    private portraitGeometry(): { scale: number; width: number; height: number; maxX: number; maxY: number } | null {
        if (!this.portraitImage) return null;
        const coverScale = Math.max(
            PORTRAIT_CANVAS_SIZE / this.portraitImage.naturalWidth,
            PORTRAIT_CANVAS_SIZE / this.portraitImage.naturalHeight
        );
        const scale = coverScale * this.portraitZoom;
        const width = this.portraitImage.naturalWidth * scale;
        const height = this.portraitImage.naturalHeight * scale;
        return {
            scale,
            width,
            height,
            maxX: Math.max(0, (width - PORTRAIT_CANVAS_SIZE) / 2),
            maxY: Math.max(0, (height - PORTRAIT_CANVAS_SIZE) / 2)
        };
    }

    private clampPortraitOffset(): void {
        const geometry = this.portraitGeometry();
        if (!geometry) return;
        this.portraitOffsetX = Math.max(-geometry.maxX, Math.min(geometry.maxX, this.portraitOffsetX));
        this.portraitOffsetY = Math.max(-geometry.maxY, Math.min(geometry.maxY, this.portraitOffsetY));
    }

    private drawPortrait(): void {
        const canvas = this.shadowRoot?.querySelector<HTMLCanvasElement>('#portrait-canvas');
        const geometry = this.portraitGeometry();
        if (!canvas || !geometry || !this.portraitImage) return;
        const context = canvas.getContext('2d');
        if (!context) return;
        context.clearRect(0, 0, PORTRAIT_CANVAS_SIZE, PORTRAIT_CANVAS_SIZE);
        context.drawImage(
            this.portraitImage,
            (PORTRAIT_CANVAS_SIZE - geometry.width) / 2 + this.portraitOffsetX,
            (PORTRAIT_CANVAS_SIZE - geometry.height) / 2 + this.portraitOffsetY,
            geometry.width,
            geometry.height
        );
    }

    private bindPortraitDrag(): void {
        const crop = this.shadowRoot?.querySelector<HTMLElement>('#portrait-crop');
        if (!crop) return;
        let pointerId: number | undefined;
        let previousX = 0;
        let previousY = 0;
        crop.addEventListener('pointerdown', (event) => {
            if (!this.portraitImage) return;
            pointerId = event.pointerId;
            previousX = event.clientX;
            previousY = event.clientY;
            crop.setPointerCapture(pointerId);
            crop.classList.add('dragging');
        });
        crop.addEventListener('pointermove', (event) => {
            if (pointerId !== event.pointerId) return;
            const rect = crop.getBoundingClientRect();
            const ratio = PORTRAIT_CANVAS_SIZE / rect.width;
            this.portraitOffsetX += (event.clientX - previousX) * ratio;
            this.portraitOffsetY += (event.clientY - previousY) * ratio;
            previousX = event.clientX;
            previousY = event.clientY;
            this.clampPortraitOffset();
            this.drawPortrait();
        });
        const finish = (event: PointerEvent) => {
            if (pointerId !== event.pointerId) return;
            crop.releasePointerCapture(pointerId);
            pointerId = undefined;
            crop.classList.remove('dragging');
        };
        crop.addEventListener('pointerup', finish);
        crop.addEventListener('pointercancel', finish);
    }

    private setPortraitError(message: string): void {
        this.portraitError = message;
        const error = this.shadowRoot?.querySelector<HTMLElement>('#portrait-modal-error');
        if (error) error.textContent = message;
    }

    private async savePortrait(): Promise<void> {
        if (!this.detail || !this.portraitImage) return;
        const canvas = this.shadowRoot?.querySelector<HTMLCanvasElement>('#portrait-canvas');
        const modal = this.shadowRoot?.querySelector<HTMLElement>('.modal');
        const save = this.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="save-portrait"]');
        if (!canvas || !save) return;
        modal?.classList.add('submitting');
        save.disabled = true;
        try {
            await this.call('updateStaff', this.detail.id, { portrait_data_uri: canvas.toDataURL('image/png') });
            const staffId = this.detail.id;
            this.portraitCache.delete(staffId);
            this.modal = null;
            this.portraitImage = undefined;
            await this.openDetail(staffId);
            await this.reloadStaffs();
        } catch (error) {
            modal?.classList.remove('submitting');
            save.disabled = false;
            this.setPortraitError(this.errorText(error));
        }
    }

    private async addDirectory(): Promise<void> {
        if (!this.detail) return;
        this.syncSecurityDraft();
        const directory = (await (window as any).fsAPI.selectDirectory()) as string | null;
        if (!directory || this.detail.permission.directories.some((item) => item.path === directory)) return;
        this.detail.permission.directories.push({ path: directory, access: 'read' });
        this.render();
        this.queueStaffUpdate({ permission: this.copyPermission() }, true);
    }

    private syncSecurityDraft(): void {
        if (!this.detail) return;
        const network = this.shadowRoot?.querySelector<HTMLInputElement>('#f-network');
        if (network) this.detail.permission.network_access = network.checked;
        this.shadowRoot?.querySelectorAll<HTMLSelectElement>('[data-dir-access]').forEach((select) => {
            const directory = this.detail!.permission.directories[Number(select.dataset.dirAccess)];
            if (directory) directory.access = select.value as 'read' | 'readwrite';
        });
    }

    private copyPermission(): StaffDetail['permission'] {
        return {
            network_access: this.detail?.permission.network_access ?? true,
            directories: (this.detail?.permission.directories ?? []).map((directory) => ({ ...directory }))
        };
    }

    private queueStaffUpdate(update: StaffUpdateInput, immediate = false): void {
        if (!this.detail) return;
        const staffId = this.detail.id;
        this.failedAutoSaveStaffIds.delete(staffId);
        this.pendingAutoSaves.set(staffId, {
            ...this.pendingAutoSaves.get(staffId),
            ...update
        });
        this.showAutoSaveState('saving', this.tr('agentoffice.autoSaveSaving'), staffId);
        if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = undefined;
        if (immediate) {
            void this.flushAutoSave();
        } else {
            this.autoSaveTimer = setTimeout(() => void this.flushAutoSave(), 500);
        }
    }

    private discardPendingField(staffId: string, field: keyof StaffUpdateInput): void {
        const pending = this.pendingAutoSaves.get(staffId);
        if (!pending || !(field in pending)) return;
        const next = { ...pending };
        delete next[field];
        if (Object.keys(next).length > 0) this.pendingAutoSaves.set(staffId, next);
        else this.pendingAutoSaves.delete(staffId);
    }

    private async flushAutoSave(): Promise<void> {
        if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
        this.autoSaveTimer = undefined;
        if (this.autoSaveRunning) return;
        const pending = [...this.pendingAutoSaves.entries()].find(
            ([staffId]) => !this.failedAutoSaveStaffIds.has(staffId)
        );
        if (!pending) return;
        const [staffId, update] = pending;
        this.pendingAutoSaves.delete(staffId);
        this.autoSaveRunning = true;
        try {
            const saved = await this.call<StaffDetail>('updateStaff', staffId, update);
            const listIndex = this.staffs.findIndex((staff) => staff.id === staffId);
            if (listIndex >= 0) this.staffs[listIndex] = saved;
            this.showAutoSaveState('saved', this.tr('agentoffice.autoSaveSaved'), staffId);
            this.setDetailNotice('', staffId);
        } catch (error) {
            const newer = this.pendingAutoSaves.get(staffId);
            this.pendingAutoSaves.set(staffId, { ...update, ...newer });
            this.failedAutoSaveStaffIds.add(staffId);
            const message = `${this.tr('agentoffice.autoSaveFailed')}: ${this.errorText(error)}`;
            this.showAutoSaveState('error', this.tr('agentoffice.autoSaveFailed'), staffId);
            this.setDetailNotice(message, staffId);
        } finally {
            this.autoSaveRunning = false;
            if ([...this.pendingAutoSaves.keys()].some((id) => !this.failedAutoSaveStaffIds.has(id))) {
                void this.flushAutoSave();
            }
        }
    }

    private showAutoSaveState(state: AutoSaveState, detail: string, staffId: string): void {
        if (this.detail?.id !== staffId) return;
        if (this.autoSaveIndicatorTimer) clearTimeout(this.autoSaveIndicatorTimer);
        this.autoSaveIndicatorTimer = undefined;
        this.autoSaveState = state;
        this.autoSaveDetail = detail;
        const indicator = this.shadowRoot?.querySelector<HTMLElement>('.auto-save-indicator');
        if (indicator) {
            indicator.dataset.state = state;
            indicator.textContent = detail;
        }
        if (state === 'saved') {
            this.autoSaveIndicatorTimer = setTimeout(() => {
                if (this.detail?.id !== staffId || this.autoSaveState !== 'saved') return;
                this.autoSaveState = 'idle';
                this.autoSaveDetail = '';
                const current = this.shadowRoot?.querySelector<HTMLElement>('.auto-save-indicator');
                if (current) {
                    current.dataset.state = 'idle';
                    current.textContent = '';
                }
            }, 1800);
        }
    }

    private setDetailNotice(message: string, staffId: string): void {
        if (this.detail?.id !== staffId) return;
        this.status = message;
        const notice = this.shadowRoot?.querySelector<HTMLElement>('.detail-notice');
        if (!notice) return;
        notice.textContent = message;
        notice.hidden = message.length === 0;
    }

    private async addSkillFromDirectory(): Promise<void> {
        if (!this.detail) return;
        this.closeSkillAddMenu();
        const source = (await (window as any).fsAPI.selectDirectory()) as string | null;
        if (!source) return;
        await this.call('addSkill', this.detail.id, source);
        await this.openDetail(this.detail.id);
    }

    private async addSkillFromZip(): Promise<void> {
        if (!this.detail) return;
        this.closeSkillAddMenu();
        const files = (await (window as any).fsAPI.selectFile()) as string[];
        const source = files.find((item) => item.toLowerCase().endsWith('.zip'));
        if (!source) return;
        await this.call('addSkill', this.detail.id, source);
        await this.openDetail(this.detail.id);
    }

    private async openBatchSkillPicker(): Promise<void> {
        if (!this.detail) return;
        this.closeSkillAddMenu();
        const directory = (await (window as any).fsAPI.selectDirectory()) as string | null;
        if (!directory) return;
        this.batchSkillCandidates = await this.call('scanSkillSources', directory);
        this.selectedBatchSkillPaths = new Set(this.batchSkillCandidates.map((skill) => skill.path));
        this.skillBatchResult = null;
        this.modal = 'batch-skills';
        this.render();
    }

    private async addSelectedBatchSkills(): Promise<void> {
        if (!this.detail || this.selectedBatchSkillPaths.size === 0) return;
        const staffId = this.detail.id;
        this.skillBatchResult = await this.call('addSkillSources', staffId, [...this.selectedBatchSkillPaths]);
        this.selectedBatchSkillPaths.clear();
        await this.openDetail(staffId);
    }

    private async addSkillFromUrl(): Promise<void> {
        if (!this.detail) return;
        const sourceUrl = this.shadowRoot?.querySelector<HTMLInputElement>('#skill-url-input')?.value.trim() ?? '';
        if (!/^https?:\/\//i.test(sourceUrl)) {
            this.setSkillModalError(this.tr('agentoffice.skillUrlInvalid'));
            return;
        }
        try {
            const staffId = this.detail.id;
            await this.call('addSkillFromUrl', staffId, sourceUrl);
            this.modal = null;
            this.skillUrl = '';
            this.skillModalError = '';
            await this.openDetail(staffId);
        } catch (error) {
            this.setSkillModalError(this.errorText(error));
        }
    }

    private setSkillModalError(message: string): void {
        this.skillModalError = message;
        const error = this.shadowRoot?.querySelector<HTMLElement>('#skill-modal-error');
        if (error) error.textContent = message;
    }

    private async openInstalledSkillPicker(): Promise<void> {
        if (!this.detail) return;
        this.closeSkillAddMenu();
        this.selectedInstalledSkillIds.clear();
        this.installedSkills = await this.call('listInstalledSkills', this.detail.id);
        this.modal = 'installed-skills';
        this.render();
    }

    private async addSelectedInstalledSkills(): Promise<void> {
        if (!this.detail || this.selectedInstalledSkillIds.size === 0) return;
        const staffId = this.detail.id;
        const result = await this.call<StaffSkillBatchImportResult>('addInstalledSkills', staffId, [
            ...this.selectedInstalledSkillIds
        ]);
        this.selectedInstalledSkillIds.clear();
        this.modal = result.errors.length > 0 ? 'batch-skills' : null;
        this.skillBatchResult = result.errors.length > 0 ? result : null;
        await this.openDetail(staffId);
    }

    private async deleteSkill(name: string): Promise<void> {
        if (!this.detail) return;
        const staffId = this.detail.id;
        await this.call('deleteSkill', staffId, name);
        this.modal = null;
        this.selectedSkill = null;
        await this.openDetail(staffId);
    }

    private async exportStaff(): Promise<void> {
        if (!this.detail) return;
        const result = await (window as any).fsAPI.saveFile({
            title: this.tr('agentoffice.exportZip'),
            defaultPath: `${this.detail.name}.zip`,
            filters: [{ name: 'ZIP', extensions: ['zip'] }]
        });
        if (result?.canceled || !result?.filePath) return;
        await this.call('exportStaff', this.detail.id, result.filePath);
    }

    private async openStaffDirectory(): Promise<void> {
        if (!this.detail) return;
        await this.call('openStaffDirectory', this.detail.id);
    }

    private async performDelete(mode: 'trash' | 'permanent'): Promise<void> {
        if (!this.detail) return;
        const staffId = this.detail.id;
        this.pendingAutoSaves.delete(staffId);
        this.failedAutoSaveStaffIds.delete(staffId);
        this.portraitCache.delete(staffId);
        await this.call('deleteStaff', staffId, mode);
        this.detail = null;
        this.modal = null;
        await this.reloadStaffs();
    }

    private scrollMessages(): void {
        const element = this.shadowRoot?.querySelector<HTMLElement>('#messages');
        if (element) element.scrollTop = element.scrollHeight;
    }

    private filterStaffRows(): void {
        const query = this.query.trim().toLowerCase();
        let visible = 0;
        this.shadowRoot?.querySelectorAll<HTMLElement>('.staff-row[data-search-text]').forEach((row) => {
            row.hidden = Boolean(query) && !(row.dataset.searchText ?? '').includes(query);
            if (!row.hidden) visible++;
        });
        const empty = this.shadowRoot?.querySelector<HTMLElement>('[data-search-empty]');
        if (empty) empty.hidden = visible > 0;
    }

    private bindStaffPreviews(): void {
        const preview = this.shadowRoot?.querySelector<HTMLElement>('#staff-preview');
        if (!preview) return;
        const cancelHide = () => {
            if (!this.previewHideTimer) return;
            clearTimeout(this.previewHideTimer);
            this.previewHideTimer = undefined;
        };
        const hide = () => {
            cancelHide();
            this.previewHideTimer = setTimeout(() => {
                preview.hidden = true;
                this.previewHideTimer = undefined;
            }, 140);
        };
        preview.addEventListener('pointerenter', cancelHide);
        preview.addEventListener('pointerleave', hide);
        this.shadowRoot?.querySelectorAll<HTMLElement>('[data-staff-preview]').forEach((trigger) => {
            trigger.addEventListener('pointerenter', () => {
                cancelHide();
                const staff = this.staffs.find((item) => item.id === trigger.dataset.staffPreview);
                if (!staff) return;
                preview.innerHTML = this.staffCardContent(staff);
                preview.style.visibility = 'hidden';
                preview.hidden = false;
                const triggerRect = trigger.getBoundingClientRect();
                const previewRect = preview.getBoundingClientRect();
                const left = Math.max(12, triggerRect.left - previewRect.width - 12);
                const top = Math.min(
                    Math.max(12, triggerRect.top + triggerRect.height / 2 - previewRect.height / 2),
                    window.innerHeight - previewRect.height - 12
                );
                preview.style.left = `${left}px`;
                preview.style.top = `${Math.max(12, top)}px`;
                preview.style.visibility = 'visible';
            });
            trigger.addEventListener('pointerleave', hide);
        });
    }

    private runOperation(operation: () => Promise<void>): void {
        if (this.busy) return;
        this.busy = true;
        this.status = '';
        this.setOperationBusy(true);
        const detailNotice = this.shadowRoot?.querySelector<HTMLElement>('.detail-notice');
        if (detailNotice) {
            detailNotice.textContent = '';
            detailNotice.hidden = true;
        }
        void operation()
            .catch((error) => {
                this.status = `${this.tr('agentoffice.operationFailed')}: ${this.errorText(error)}`;
                const notice = this.shadowRoot?.querySelector<HTMLElement>('.detail-notice');
                if (notice) {
                    notice.textContent = this.status;
                    notice.hidden = false;
                } else {
                    this.render();
                }
            })
            .finally(() => {
                this.busy = false;
                this.setOperationBusy(false);
            });
    }

    private setOperationBusy(busy: boolean): void {
        this.shadowRoot?.querySelector<HTMLElement>('.root')?.classList.toggle('busy', busy);
    }

    private errorText(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private taskStatus(status: string): string {
        const key = `agentoffice.taskStatus.${status}`;
        const translated = this.tr(key);
        return translated === key ? status : translated;
    }
}

customElements.define('agentoffice-entry-widget', AgentOfficeEntryWidget);
