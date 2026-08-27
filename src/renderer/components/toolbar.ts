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

import './toolbar.css';

type ToolbarLayout = 'capsule' | 'spread';

interface Button {
    id: string;
    icon: string;
    iconSvg?: string;
    label: string;
    labelStayVisible?: boolean;
    /** 追加到按钮元素上的额外 class，用于单个按钮的样式变体 */
    className?: string;
    /** spread 布局下，悬停时在图标右侧展开文本 label */
    expandLabel?: boolean;
    active?: boolean;
    action: (event?: MouseEvent) => void;
}

export class ElasticToolbarWidget extends HTMLElement {
    uid: string;
    buttons: Button[];
    toolbarTitle?: string;
    toolbarSubtitle?: string;
    subtitleLabel?: string;
    layout: ToolbarLayout;
    _subtitleClickHandler?: () => void;

    /**
     * 创建一个弹性工具栏组件
     * @param buttons 工具栏按钮列表
     * @param toolbarTitle 工具栏标题（可选）
     * @param layout 布局模式：'capsule' 居中胶囊（默认），'spread' 左标题右按钮
     */
    constructor(buttons: Button[] = [], toolbarTitle?: string, layout: ToolbarLayout = 'capsule') {
        super();
        this.uid = crypto.randomUUID();
        this.buttons = buttons;
        this.toolbarTitle = toolbarTitle;
        this.layout = layout;
    }

    connectedCallback() {
        this.render();
    }

    setButtons(buttons: Button[]) {
        this.buttons = buttons;
        this.render();
    }

    /**
     * 更新指定按钮的激活状态（不触发完整重渲染）
     * @param activeId 需要激活的按钮 id，传 null 清除所有激活态
     */
    setActiveButton(activeId: string | null) {
        this.buttons.forEach((button) => {
            button.active = button.id === activeId;
            const btnEl = this.querySelector(`#${button.id}-${this.uid}`);
            if (btnEl) {
                btnEl.classList.toggle('navbar-active', button.active);
            }
        });
    }

    /**
     * 为指定按钮设置状态角标（不触发完整重渲染）。
     * @param badgeId 按钮 id
     * @param status 'ok' | 'warn' | 'err' | null（null 清除角标）
     * @param title 可选的状态说明；提供时同步更新按钮悬停提示，清除角标时恢复原始 label
     */
    setButtonBadge(badgeId: string, status: 'ok' | 'warn' | 'err' | null, title?: string) {
        const btnEl = this.querySelector(`#${badgeId}-${this.uid}`);
        if (!btnEl) return;
        // 记录按钮原始悬停提示（渲染时的 label），清除角标时恢复
        if (!btnEl.dataset.baseTitle) {
            btnEl.dataset.baseTitle = btnEl.getAttribute('title') || '';
        }
        btnEl.setAttribute('title', title || btnEl.dataset.baseTitle || '');
        // 查找图标包裹元素，挂载角标
        let badge = btnEl.querySelector('.elastic-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'elastic-badge';
            const iconWrap = btnEl.querySelector('.elastic-icon-wrap');
            if (iconWrap) {
                iconWrap.appendChild(badge);
            } else {
                btnEl.appendChild(badge);
            }
        }
        if (!status) {
            badge.remove();
            return;
        }
        badge.className = `elastic-badge elastic-badge--${status}`;
        badge.innerHTML =
            status === 'err'
                ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="10.5" y="3" width="3" height="11" rx="1.5"/><circle cx="12" cy="18.5" r="2"/></svg>'
                : status === 'warn'
                  ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="12" height="14" rx="2"/><path d="M10 9h4M10 13h4" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>'
                  : `<span class="elastic-badge-dot"></span>`;
    }

    setToolbarTitle(toolbarTitle: string) {
        this.toolbarTitle = toolbarTitle;
        const titleEl = this.querySelector(`#toolbar-title-${this.uid}`);
        if (titleEl) {
            titleEl.textContent = toolbarTitle;
            titleEl.setAttribute('title', toolbarTitle);
        } else {
            this.render();
        }
    }

    setToolbarSubtitle(subtitle: string, onClick?: () => void, label?: string) {
        this.toolbarSubtitle = subtitle;
        this.subtitleLabel = label;
        this._subtitleClickHandler = onClick;
        const subtitleEl = this.querySelector(`#toolbar-subtitle-${this.uid}`) as HTMLElement | null;
        if (subtitleEl) {
            const textSpan = subtitleEl.querySelector('span.ws-path');
            if (textSpan) textSpan.textContent = subtitle;
            const labelSpan = subtitleEl.querySelector('span.ws-label');
            if (labelSpan) {
                if (label) {
                    labelSpan.textContent = label;
                    labelSpan.style.display = '';
                } else {
                    labelSpan.style.display = 'none';
                }
            }
            subtitleEl.setAttribute('title', subtitle);
            subtitleEl.style.display = subtitle ? '' : 'none';
            if (onClick) {
                const clone = subtitleEl.cloneNode(true) as HTMLElement;
                subtitleEl.replaceWith(clone);
                clone.addEventListener('click', onClick);
            }
        } else {
            this.render();
        }
    }

    render() {
        if (this.layout === 'spread') {
            this._renderSpread();
        } else {
            this._renderCapsule();
        }
        this._bindButtons();
    }

    private _renderSpread() {
        const buttonsHTML = this.buttons
            .map((button) => {
                const iconHTML = button.iconSvg
                    ? `<span class="elastic-icon-wrap">${button.iconSvg}</span>`
                    : `<i class="fa-solid ${button.icon} text-[15px]"></i>`;
                const labelHTML = button.expandLabel ? `<span class="elastic-label">${button.label}</span>` : '';
                return `
            <button id='${button.id}-${this.uid}'
                class="toolbar-spread-btn flex items-center justify-center rounded-lg
                       transition-colors duration-150${button.expandLabel ? ' expand-label' : ''}"
                title="${button.label}">
                ${iconHTML}
                ${labelHTML}
            </button>
            `;
            })
            .join('');

        const titleHTML = this.toolbarTitle
            ? `<span id="toolbar-title-${this.uid}" class="text-[18px] font-bold truncate" style="color: var(--od-text);" title="${this.toolbarTitle}">${this.toolbarTitle}</span>`
            : '';

        const subtitleHTML = this.toolbarSubtitle
            ? `<button id="toolbar-subtitle-${this.uid}" class="toolbar-spread-subtitle" title="${this.toolbarSubtitle}">
                <i class="fa-solid fa-briefcase"></i>
                <span class="ws-label" style="font-size: var(--fs-sm);color:var(--od-text-muted, #6b7280);white-space:nowrap;flex-shrink:0;${this.subtitleLabel ? '' : 'display:none;'}">${this.subtitleLabel || ''}</span>
                <span class="ws-path">${this.toolbarSubtitle}</span>
                <i class="fa-solid fa-chevron-down" style="font-size: var(--icon-xs); opacity: 0.5;"></i>
               </button>`
            : `<button id="toolbar-subtitle-${this.uid}" class="toolbar-spread-subtitle" style="display:none;" title="">
                <i class="fa-solid fa-briefcase"></i>
                <span class="ws-label" style="display:none;"></span>
                <span class="ws-path"></span>
                <i class="fa-solid fa-chevron-down" style="font-size: var(--icon-xs); opacity: 0.5;"></i>
               </button>`;

        this.innerHTML = `
        <header class="toolbar-spread-header" style="height: 72px; padding: 0 5px 0 16px; display: flex; flex-direction: column; justify-content: flex-end;">
            <div style="display: flex; align-items: end; justify-content: space-between; padding-bottom: 4px;">
                <div class="flex flex-col min-w-0 flex-1 gap-0.5">
                    ${titleHTML}
                    ${subtitleHTML}
                </div>
                <div class="flex items-center gap-1 flex-shrink-0">
                    ${buttonsHTML}
                </div>
            </div>
        </header>
        `;
    }

    private _renderCapsule() {
        const topButtonsHTML = this.buttons
            .map((button) => {
                const labelStayVisible = !!button.labelStayVisible;
                const labelCls = labelStayVisible ? 'elastic-label elastic-label--visible' : 'elastic-label';
                const activeCls = button.active ? ' navbar-active' : '';
                const extraCls = button.className ? ` ${button.className}` : '';
                const iconHTML = button.iconSvg
                    ? `<span class="elastic-icon-wrap">${button.iconSvg}</span>`
                    : `<i class="fa-solid ${button.icon}"></i>`;
                return `
            <button id='${button.id}-${this.uid}' class="elastic-capsule-btn flex items-center px-2 py-2 rounded-full
                        bg-transparent
                        text-gray-700${activeCls}${extraCls}"
                title="${button.label}">
                ${iconHTML}
                <span class="${labelCls}">
                    ${button.label}
                </span>
            </button>
            `;
            })
            .join('');

        const titleHTML = this.toolbarTitle
            ? `<div class="inline-block pl-4 py-2 font-semibold text-gray-800 text-sm">${this.toolbarTitle}</div>`
            : '';

        this.innerHTML = `
        <header class="h-16 px-4 flex items-center justify-center">
            <div class="flex items-center gap-3 p-1 rounded-full bg-white shadow">
                ${titleHTML}
                ${topButtonsHTML}
            </div>
        </header>
        `;
    }

    private _bindButtons() {
        this.buttons.forEach((button) => {
            const buttonElement = this.querySelector(`#${button.id}-${this.uid}`);
            if (buttonElement) {
                buttonElement.addEventListener('click', (event) => {
                    button.action(event);
                });
            }
        });
        if (this._subtitleClickHandler) {
            const subtitleEl = this.querySelector(`#toolbar-subtitle-${this.uid}`);
            if (subtitleEl) {
                subtitleEl.addEventListener('click', this._subtitleClickHandler);
            }
        }
    }
}

customElements.define('elastic-toolbar-widget', ElasticToolbarWidget);
