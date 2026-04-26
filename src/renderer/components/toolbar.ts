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
    label: string;
    labelStayVisible?: boolean;
    action: () => void;
}

export class ElasticToolbarWidget extends HTMLElement {
    uid: string;
    buttons: Button[];
    toolbarTitle?: string;
    layout: ToolbarLayout;

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
                return `
            <button id='${button.id}-${this.uid}'
                class="toolbar-spread-btn flex items-center justify-center w-8 h-8 rounded-lg
                       bg-transparent hover:bg-gray-100 active:bg-gray-200
                       transition-colors duration-150
                       text-gray-500 hover:text-gray-800"
                title="${button.label}">
                <i class="fa-solid ${button.icon} text-[15px]"></i>
            </button>
            `;
            })
            .join('');

        const titleHTML = this.toolbarTitle
            ? `<span id="toolbar-title-${this.uid}" class="text-[18px] font-bold text-gray-900 truncate" title="${this.toolbarTitle}">${this.toolbarTitle}</span>`
            : '';

        this.innerHTML = `
        <header class="toolbar-spread-header" style="height: 72px; padding: 0 5px 0 16px; display: flex; flex-direction: column; justify-content: flex-end;">
            <div style="display: flex; align-items: center; justify-content: space-between; padding-bottom: 8px;">
                <div class="flex items-center gap-2 min-w-0 flex-1">
                    ${titleHTML}
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
                return `
            <button id='${button.id}-${this.uid}' class="elastic-capsule-btn flex items-center px-2 py-2 rounded-full
                        bg-transparent
                        text-gray-700">
                <i class="fa-solid ${button.icon}"></i>
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
                buttonElement.addEventListener('click', () => {
                    button.action();
                });
            }
        });
    }
}

customElements.define('elastic-toolbar-widget', ElasticToolbarWidget);
