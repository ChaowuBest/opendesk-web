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

    /**
     * 创建一个弹性工具栏组件
     * @param buttons 工具栏按钮列表
     */
    constructor(buttons: Button[] = []) {
        super();
        this.uid = crypto.randomUUID();
        this.buttons = buttons;
    }

    connectedCallback() {
        this.render();
    }

    setButtons(buttons: Button[]) {
        this.buttons = buttons;
        this.render();
    }

    render() {
        const topButtonsHTML = this.buttons.map(button => {
            const labelStayVisible = !!button.labelStayVisible;
            const labelSpanClass = labelStayVisible
                ? 'max-w-[120px] opacity-100 ml-2 transition-all duration-500 ease-in-out whitespace-nowrap font-medium tracking-tight text-sm'
                : 'max-w-0 overflow-hidden opacity-0 group-hover:max-w-[120px] group-hover:opacity-100 group-hover:ml-2 transition-all duration-500 ease-in-out whitespace-nowrap font-medium tracking-tight text-sm';
            return `
            <button id='${button.id}-${this.uid}' class="group flex items-center px-2 py-2 rounded-full
                        bg-transparent hover:bg-white/60 hover:shadow-md
                        transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)]
                        text-gray-700 hover:text-blue-600">
                <i class="fa-solid ${button.icon}"></i>
                <span class="${labelSpanClass}">
                    ${button.label}
                </span>
            </button>
            `;
        }).join('');

        let toolbarHTML = `
        <header class="h-16 px-0 flex items-center justify-between">
            <div class="flex items-center gap-2 p-1">
                ${topButtonsHTML}
            </div>
        </header>
        `;

        this.innerHTML = toolbarHTML;
        this.buttons.forEach(button => {
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