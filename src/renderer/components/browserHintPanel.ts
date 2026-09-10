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

/**
 * 地址栏「页面提示」面板 — 展示当前页面命中的插件 Browser Hints。
 *
 * 任务浏览器标签（EmbeddedBrowser）与浏览器应用（BrowserEntryWidget）共用：
 * 组件只负责「闪电按钮 + 下拉列表 + 二级详情浮层」的渲染与开关，由宿主把按钮
 * 挂到地址栏右侧并在导航时通过 setHints 喂入数据。
 *
 * 交互：主列表只展示签名与两行截断的简介；鼠标悬停 action 项时向左展开
 * 二级浮层，显示完整描述与参数说明。浮层挂在根节点上（而非滚动列表内），
 * 用 position: fixed + JS 定位，避免被菜单的 overflow 裁剪，与浏览器应用
 * 工具菜单的 wb-tm-flyout 手法一致。
 *
 * 主题：颜色全部走 --bhp-* 变量，默认浅色；深色只在根节点上覆盖一次变量。
 * 任务浏览器在 shadow DOM 内（宿主带 data-theme），用 :host(...) 匹配；
 * 浏览器应用是 light DOM（html 带 data-theme），用 html[data-theme='dark'] 匹配。
 */

import { escapeHtml } from '../../common/utils/escape.js';

export interface HintPanelTextItem {
    kind: 'text';
    content: string;
}

export interface HintPanelActionItem {
    kind: 'action';
    name: string;
    /** 如 `SearchItem(keyword, category)` */
    signature: string;
    description: string;
    args: Record<string, string>;
}

export type HintPanelItem = HintPanelTextItem | HintPanelActionItem;

export interface BrowserHintPanelLabels {
    /** 按钮 tooltip 与面板标题，如「页面提示」 */
    title: string;
    /** 面板打开但没有命中 hint 时的文案 */
    emptyText: string;
    /** 文本提示分组标题 */
    textSection: string;
    /** 页面动作分组标题 */
    actionSection: string;
    /** 二级浮层中参数分组标题 */
    argsSection: string;
}

export interface BrowserHintPanelHandle {
    /** 挂到工具栏上的根元素（含按钮与下拉菜单） */
    root: HTMLElement;
    /** 用最新 hint 列表刷新面板；空列表会隐藏按钮 */
    setHints(hints: readonly HintPanelItem[]): void;
    /** 释放全局事件监听 */
    destroy(): void;
}

/** 从主进程拉取当前页面命中的 hint 摘要；不支持的环境与失败都降级为空列表 */
export async function fetchBrowserHintsForPage(payload: {
    url: string;
    title?: string;
    webContentsId?: number;
}): Promise<HintPanelItem[]> {
    const registryAPI = (window as any).applicationRegistryAPI;
    if (!registryAPI?.callMainWorld) return [];
    const hints = await registryAPI.callMainWorld('browser', 'listBrowserHintsForPage', payload);
    return Array.isArray(hints) ? hints : [];
}

/** 二级浮层从 hover 项移开后的保留时长，给指针挪入浮层留时间 */
const FLYOUT_CLOSE_DELAY_MS = 250;
const VIEWPORT_PADDING = 8;

export function createBrowserHintPanel(options: {
    labels: BrowserHintPanelLabels;
    /** 追加到闪电按钮上的宿主样式类（如 bw-btn / wb-btn），使其与相邻按钮观感一致 */
    buttonClass?: string;
}): BrowserHintPanelHandle {
    const { labels, buttonClass } = options;

    const root = document.createElement('div');
    root.className = 'bhp-root';
    root.innerHTML = `
        <style>
            .bhp-root {
                /* 浅色主题变量；深色由根级覆盖，两个挂载上下文各用一条选择器 */
                --bhp-card-bg: #ffffff;
                --bhp-card-border: #e5e7eb;
                --bhp-card-shadow: 0 12px 32px rgba(0, 0, 0, 0.14);
                --bhp-header-fg: #374151;
                --bhp-header-border: #f0f0f0;
                --bhp-section-fg: #9ca3af;
                --bhp-item-hover-bg: #f6f7f9;
                --bhp-icon-action-fg: #f59e0b;
                --bhp-icon-text-fg: #6b7280;
                --bhp-sig-fg: #1f2937;
                --bhp-text-fg: #374151;
                --bhp-desc-fg: #6b7280;
                --bhp-more-fg: #c0c4cc;
                --bhp-flyout-desc-fg: #374151;
                --bhp-args-title-fg: #9ca3af;
                --bhp-arg-name-bg: #f3f4f6;
                --bhp-arg-name-fg: #374151;
                --bhp-arg-desc-fg: #6b7280;
                --bhp-empty-fg: #9ca3af;
                --bhp-btn-open-bg: rgba(0, 0, 0, 0.06);
                /* 滚动条：按 docs/specifications/scrollbar_specification.md 二级（Compact）取值 */
                --bhp-scrollbar-thumb: #d1d5db;
                --bhp-scrollbar-thumb-hover: #cbd5e1;

                position: relative;
                display: inline-flex;
                align-items: center;
            }
            :host([data-theme="dark"]) .bhp-root,
            html[data-theme='dark'] .bhp-root {
                --bhp-card-bg: #252526;
                --bhp-card-border: rgba(255, 255, 255, 0.12);
                --bhp-card-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
                --bhp-header-fg: #e5e7eb;
                --bhp-header-border: rgba(255, 255, 255, 0.08);
                --bhp-section-fg: #8a8a8a;
                --bhp-item-hover-bg: #2f2f31;
                --bhp-icon-text-fg: #ababab;
                --bhp-sig-fg: #e5e7eb;
                --bhp-text-fg: #cccccc;
                --bhp-desc-fg: #9ca3af;
                --bhp-more-fg: #6b6b6b;
                --bhp-flyout-desc-fg: #cccccc;
                --bhp-args-title-fg: #8a8a8a;
                --bhp-arg-name-bg: #3a3a3c;
                --bhp-arg-name-fg: #cccccc;
                --bhp-arg-desc-fg: #9ca3af;
                --bhp-empty-fg: #8a8a8a;
                --bhp-btn-open-bg: rgba(255, 255, 255, 0.1);
                --bhp-scrollbar-thumb: rgba(255, 255, 255, 0.18);
                --bhp-scrollbar-thumb-hover: rgba(255, 255, 255, 0.28);
            }
            .bhp-btn i {
                color: #f59e0b;
                font-size: 13px;
            }
            .bhp-btn.bhp-open {
                background: var(--bhp-btn-open-bg);
            }
            .bhp-menu {
                position: absolute;
                top: calc(100% + 8px);
                right: 0;
                width: 380px;
                max-height: 420px;
                overflow-y: auto;
                background: var(--bhp-card-bg);
                border: 1px solid var(--bhp-card-border);
                border-radius: 10px;
                box-shadow: var(--bhp-card-shadow);
                z-index: 1200;
                display: none;
            }
            .bhp-menu.bhp-visible {
                display: block;
            }
            .bhp-header {
                padding: 10px 14px;
                font-size: 13px;
                font-weight: 600;
                color: var(--bhp-header-fg);
                border-bottom: 1px solid var(--bhp-header-border);
                position: sticky;
                top: 0;
                background: var(--bhp-card-bg);
            }
            .bhp-section {
                padding: 10px 14px 2px;
                font-size: 11px;
                color: var(--bhp-section-fg);
            }
            .bhp-item {
                position: relative;
                padding: 8px 14px;
            }
            .bhp-item:hover {
                background: var(--bhp-item-hover-bg);
            }
            .bhp-item-action {
                cursor: default;
                padding-right: 26px;
            }
            .bhp-item-title {
                display: flex;
                align-items: baseline;
                gap: 8px;
            }
            .bhp-item-icon {
                font-size: 12px;
                flex-shrink: 0;
            }
            .bhp-icon-action {
                color: var(--bhp-icon-action-fg);
            }
            .bhp-icon-text {
                color: var(--bhp-icon-text-fg);
            }
            .bhp-sig {
                font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                font-size: 12px;
                font-weight: 600;
                color: var(--bhp-sig-fg);
                word-break: break-all;
            }
            .bhp-text-content {
                font-size: 12px;
                color: var(--bhp-text-fg);
                line-height: 1.55;
                white-space: pre-wrap;
                word-break: break-word;
            }
            .bhp-desc {
                margin: 4px 0 0 20px;
                font-size: 12px;
                color: var(--bhp-desc-fg);
                line-height: 1.55;
                word-break: break-word;
            }
            /* 主列表中 action 简介最多两行，完整内容在二级浮层查看 */
            .bhp-desc.bhp-clamp {
                display: -webkit-box;
                -webkit-box-orient: vertical;
                -webkit-line-clamp: 2;
                overflow: hidden;
            }
            .bhp-more {
                position: absolute;
                right: 10px;
                top: 50%;
                transform: translateY(-50%);
                font-size: 10px;
                color: var(--bhp-more-fg);
            }
            .bhp-flyout {
                display: none;
                position: fixed;
                width: 380px;
                max-height: 420px;
                overflow-y: auto;
                background: var(--bhp-card-bg);
                border: 1px solid var(--bhp-card-border);
                border-radius: 10px;
                box-shadow: var(--bhp-card-shadow);
                z-index: 1300;
                padding: 6px 0;
            }
            .bhp-flyout.bhp-visible {
                display: block;
            }
            .bhp-flyout-body {
                padding: 8px 14px 10px;
            }
            .bhp-flyout-head {
                display: flex;
                align-items: baseline;
                gap: 8px;
            }
            .bhp-flyout-desc {
                margin: 8px 0 0;
                font-size: 12px;
                color: var(--bhp-flyout-desc-fg);
                line-height: 1.6;
                word-break: break-word;
                white-space: pre-wrap;
            }
            .bhp-flyout-args-title {
                margin: 10px 0 0;
                padding-top: 8px;
                border-top: 1px solid var(--bhp-header-border);
                font-size: 11px;
                color: var(--bhp-args-title-fg);
            }
            .bhp-args {
                margin: 6px 0 0;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .bhp-arg {
                display: flex;
                align-items: baseline;
                gap: 6px;
                font-size: 11px;
            }
            .bhp-arg-name {
                font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                background: var(--bhp-arg-name-bg);
                border-radius: 4px;
                padding: 1px 6px;
                color: var(--bhp-arg-name-fg);
                flex-shrink: 0;
            }
            .bhp-arg-desc {
                color: var(--bhp-arg-desc-fg);
                line-height: 1.5;
            }
            .bhp-empty {
                padding: 18px 14px;
                font-size: 12px;
                color: var(--bhp-empty-fg);
                text-align: center;
            }
            /* 主菜单与二级浮层的滚动条：二级（Compact）规格，结构属性两种主题共用 */
            .bhp-menu::-webkit-scrollbar,
            .bhp-flyout::-webkit-scrollbar {
                width: 4px;
            }
            .bhp-menu::-webkit-scrollbar-track,
            .bhp-flyout::-webkit-scrollbar-track {
                background: transparent;
            }
            .bhp-menu::-webkit-scrollbar-thumb,
            .bhp-flyout::-webkit-scrollbar-thumb {
                background: var(--bhp-scrollbar-thumb);
                border-radius: 2px;
            }
            .bhp-menu::-webkit-scrollbar-thumb:hover,
            .bhp-flyout::-webkit-scrollbar-thumb:hover {
                background: var(--bhp-scrollbar-thumb-hover);
            }
        </style>
        <button class="bhp-btn${buttonClass ? ` ${buttonClass}` : ''}" title="${escapeHtml(labels.title)}" style="display:none;">
            <i class="fas fa-bolt"></i>
        </button>
        <div class="bhp-menu">
            <div class="bhp-header">${escapeHtml(labels.title)}</div>
            <div class="bhp-body"></div>
        </div>
        <div class="bhp-flyout"></div>`;

    const button = root.querySelector('.bhp-btn') as HTMLButtonElement;
    const menu = root.querySelector('.bhp-menu') as HTMLElement;
    const body = root.querySelector('.bhp-body') as HTMLElement;
    const flyout = root.querySelector('.bhp-flyout') as HTMLElement;

    let hints: readonly HintPanelItem[] = [];
    let flyoutCloseTimer: ReturnType<typeof setTimeout> | null = null;

    const onDocumentClick = (event: Event) => {
        if (!root.contains(event.target as Node)) {
            close();
        }
    };
    document.addEventListener('click', onDocumentClick);

    function cancelFlyoutClose(): void {
        if (flyoutCloseTimer !== null) {
            clearTimeout(flyoutCloseTimer);
            flyoutCloseTimer = null;
        }
    }

    function hideFlyout(): void {
        cancelFlyoutClose();
        flyout.classList.remove('bhp-visible');
    }

    function scheduleFlyoutClose(): void {
        if (flyoutCloseTimer !== null) return;
        flyoutCloseTimer = setTimeout(() => {
            flyoutCloseTimer = null;
            hideFlyout();
        }, FLYOUT_CLOSE_DELAY_MS);
    }

    /** 把浮层定位到锚定项左侧，越界时回退到右侧或收进视口内 */
    function positionFlyout(anchor: HTMLElement): void {
        flyout.style.visibility = 'hidden';
        flyout.classList.add('bhp-visible');
        const anchorRect = anchor.getBoundingClientRect();
        const flyRect = flyout.getBoundingClientRect();
        let left = anchorRect.left - flyRect.width - 8;
        let top = anchorRect.top - 4;
        if (left < VIEWPORT_PADDING) {
            left = anchorRect.right + 8;
        }
        if (left + flyRect.width > window.innerWidth - VIEWPORT_PADDING) {
            left = window.innerWidth - flyRect.width - VIEWPORT_PADDING;
        }
        if (top + flyRect.height > window.innerHeight - VIEWPORT_PADDING) {
            top = window.innerHeight - flyRect.height - VIEWPORT_PADDING;
        }
        if (top < VIEWPORT_PADDING) {
            top = VIEWPORT_PADDING;
        }
        flyout.style.left = `${Math.round(left)}px`;
        flyout.style.top = `${Math.round(top)}px`;
        flyout.style.visibility = '';
    }

    function showActionFlyout(action: HintPanelActionItem, anchor: HTMLElement): void {
        const argRows = Object.entries(action.args ?? {})
            .map(
                ([name, description]) =>
                    `<div class="bhp-arg"><span class="bhp-arg-name">${escapeHtml(name)}</span>` +
                    `<span class="bhp-arg-desc">${escapeHtml(description)}</span></div>`
            )
            .join('');
        flyout.innerHTML =
            `<div class="bhp-flyout-body">` +
            `<div class="bhp-flyout-head"><i class="fas fa-bolt bhp-item-icon bhp-icon-action"></i>` +
            `<span class="bhp-sig">${escapeHtml(action.signature || action.name)}</span></div>` +
            (action.description ? `<div class="bhp-flyout-desc">${escapeHtml(action.description)}</div>` : '') +
            (argRows
                ? `<div class="bhp-flyout-args-title">${escapeHtml(labels.argsSection)}</div>` +
                  `<div class="bhp-args">${argRows}</div>`
                : '') +
            `</div>`;
        positionFlyout(anchor);
    }

    function close(): void {
        menu.classList.remove('bhp-visible');
        button.classList.remove('bhp-open');
        hideFlyout();
    }

    /** 分组标题节点。replaceChildren 会把字符串当纯文本插入，因此必须用元素构建 */
    function sectionLabel(text: string): HTMLElement {
        const el = document.createElement('div');
        el.className = 'bhp-section';
        el.textContent = text;
        return el;
    }

    function toggle(): void {
        if (menu.classList.contains('bhp-visible')) {
            close();
            return;
        }
        renderBody();
        menu.classList.add('bhp-visible');
        button.classList.add('bhp-open');
    }

    function renderBody(): void {
        hideFlyout();
        if (hints.length === 0) {
            body.innerHTML = `<div class="bhp-empty">${escapeHtml(labels.emptyText)}</div>`;
            return;
        }
        const actions = hints.filter((hint): hint is HintPanelActionItem => hint.kind === 'action');
        const texts = hints.filter((hint): hint is HintPanelTextItem => hint.kind === 'text');
        const parts: (string | Node)[] = [];
        if (actions.length > 0) {
            parts.push(sectionLabel(labels.actionSection));
            for (const action of actions) {
                const item = document.createElement('div');
                item.className = 'bhp-item bhp-item-action';
                item.innerHTML =
                    `<div class="bhp-item-title"><i class="fas fa-bolt bhp-item-icon bhp-icon-action"></i>` +
                    `<span class="bhp-sig">${escapeHtml(action.signature || action.name)}</span></div>` +
                    (action.description
                        ? `<div class="bhp-desc bhp-clamp">${escapeHtml(action.description)}</div>`
                        : '') +
                    `<i class="fas fa-chevron-left bhp-more"></i>`;
                // 悬停向左展开二级浮层；离开时延迟关闭，指针挪入浮层则保持
                item.addEventListener('mouseenter', () => {
                    cancelFlyoutClose();
                    showActionFlyout(action, item);
                });
                item.addEventListener('mouseleave', (event) => {
                    if (event.relatedTarget instanceof Node && flyout.contains(event.relatedTarget)) return;
                    scheduleFlyoutClose();
                });
                parts.push(item);
            }
        }
        if (texts.length > 0) {
            parts.push(sectionLabel(labels.textSection));
            for (const text of texts) {
                const item = document.createElement('div');
                item.className = 'bhp-item';
                item.innerHTML =
                    `<div class="bhp-item-title"><i class="fas fa-circle-info bhp-item-icon bhp-icon-text"></i>` +
                    `<span class="bhp-text-content">${escapeHtml(text.content)}</span></div>`;
                parts.push(item);
            }
        }
        body.replaceChildren(...parts);
    }

    button.addEventListener('click', (event) => {
        event.stopPropagation();
        toggle();
    });
    // 点击菜单/浮层内部不关闭，方便滚动与选中内容；
    // 任务浏览器在 shadow DOM 内，事件冒泡到 document 时 target 会被重定向为
    // 宿主元素，若不拦截会被 onDocumentClick 误判为外部点击而关掉面板
    menu.addEventListener('click', (event) => event.stopPropagation());
    flyout.addEventListener('click', (event) => event.stopPropagation());
    flyout.addEventListener('mouseenter', cancelFlyoutClose);
    flyout.addEventListener('mouseleave', (event) => {
        if (event.relatedTarget instanceof Node && flyout.contains(event.relatedTarget)) return;
        scheduleFlyoutClose();
    });

    return {
        root,
        setHints(next) {
            hints = next;
            button.style.display = hints.length > 0 ? '' : 'none';
            if (hints.length === 0) {
                close();
            } else if (menu.classList.contains('bhp-visible')) {
                renderBody();
            }
        },
        destroy() {
            document.removeEventListener('click', onDocumentClick);
            hideFlyout();
            root.remove();
        }
    };
}
