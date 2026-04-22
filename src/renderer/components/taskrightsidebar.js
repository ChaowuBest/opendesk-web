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

class TaskRightSidebar extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });

        this._activeTab = 'artifacts';

        this._tabs = [
            { id: 'artifacts', label: '产物', icon: 'fa-cube' },
            { id: 'files', label: '全部文件', icon: 'fa-folder-open' },
            { id: 'changes', label: '变更', icon: 'fa-code-compare' },
            { id: 'browser', label: '浏览器', icon: 'fa-globe' }
        ];
    }

    connectedCallback() {
        this.render();
    }

    _switchTab(tabId) {
        this._activeTab = tabId;
        const tabBtns = this.shadowRoot.querySelectorAll('.tab-btn');
        tabBtns.forEach((btn) => {
            if (btn.dataset.tab === tabId) {
                btn.classList.add('tab-active');
            } else {
                btn.classList.remove('tab-active');
            }
        });
        const contentPanels = this.shadowRoot.querySelectorAll('.tab-content');
        contentPanels.forEach((panel) => {
            if (panel.dataset.tab === tabId) {
                panel.style.display = '';
            } else {
                panel.style.display = 'none';
            }
        });
    }

    render() {
        const tabsHTML = this._tabs
            .map((tab) => {
                const isActive = tab.id === this._activeTab;
                return `<button class="tab-btn ${isActive ? 'tab-active' : ''}" data-tab="${tab.id}">
                <i class="fas ${tab.icon} text-xs"></i>
                <span>${tab.label}</span>
            </button>`;
            })
            .join('');

        const contentHTML = this._tabs
            .map((tab) => {
                const isActive = tab.id === this._activeTab;
                return `<div class="tab-content" data-tab="${tab.id}" style="display: ${isActive ? '' : 'none'}">
                <div class="placeholder-content">
                    <i class="fas ${tab.icon} placeholder-icon"></i>
                    <p>${tab.label}内容占位符</p>
                </div>
            </div>`;
            })
            .join('');

        this.shadowRoot.innerHTML = `
        <style>
            :host {
                display: flex;
                flex-direction: column;
                height: 100%;
                width: 100%;
                background: #fafafa;
            }

            .tab-bar {
                display: flex;
                border-bottom: 1px solid #e5e7eb;
                padding: 0 4px;
                background: white;
                flex-shrink: 0;
                min-height: 40px;
                align-items: flex-end;
            }

            .tab-btn {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 10px 12px;
                font-size: 12px;
                color: #6b7280;
                background: transparent;
                border: none;
                border-bottom: 2px solid transparent;
                cursor: pointer;
                transition: all 0.2s;
                white-space: nowrap;
            }
            .tab-btn:hover {
                color: #374151;
                background: #f3f4f6;
            }
            .tab-btn.tab-active {
                color: #2563eb;
                border-bottom-color: #2563eb;
                font-weight: 500;
            }

            .tab-content-wrapper {
                flex: 1;
                overflow: hidden;
                display: flex;
                flex-direction: column;
            }

            .tab-content {
                flex: 1;
                overflow-y: auto;
            }

            .placeholder-content {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100%;
                color: #9ca3af;
                gap: 8px;
            }
            .placeholder-icon {
                font-size: 32px;
                opacity: 0.4;
            }
            .placeholder-content p {
                font-size: 13px;
            }
        </style>

        <div class="tab-bar">
            ${tabsHTML}
        </div>
        <div class="tab-content-wrapper">
            ${contentHTML}
        </div>
        `;

        // Tab switching events
        const tabBtns = this.shadowRoot.querySelectorAll('.tab-btn');
        tabBtns.forEach((btn) => {
            btn.addEventListener('click', () => {
                this._switchTab(btn.dataset.tab);
            });
        });
    }
}

customElements.define('task-right-sidebar', TaskRightSidebar);
