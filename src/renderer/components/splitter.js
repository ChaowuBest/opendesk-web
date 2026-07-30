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

const DEFAULT_SIDEBAR_WIDTH = 316;

class SplitterWidget extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._isResizing = false;
        this._defaultWidth = DEFAULT_SIDEBAR_WIDTH;
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
    }

    static get observedAttributes() {
        return ['initial-width', 'collapsed'];
    }

    connectedCallback() {
        this.render();
    }

    disconnectedCallback() {
        this._stopResize();
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'initial-width' && oldValue !== newValue) {
            const width = parseInt(newValue, 10);
            if (!isNaN(width)) {
                this._defaultWidth = width;
                const leftPanel = this.shadowRoot.getElementById('leftPanel');
                if (leftPanel) {
                    leftPanel.style.width = width + 'px';
                }
            }
        }
        if (name === 'collapsed' && oldValue !== newValue && this.shadowRoot) {
            this._syncCollapsedState();
        }
    }

    isCollapsed() {
        return this.hasAttribute('collapsed');
    }

    setCollapsed(collapsed) {
        this.toggleAttribute('collapsed', !!collapsed);
        this._syncCollapsedState();
    }

    render() {
        this._defaultWidth = parseInt(this.getAttribute('initial-width'), 10) || DEFAULT_SIDEBAR_WIDTH;
        const initialWidth = this._defaultWidth;

        this.shadowRoot.innerHTML = `
        <style>
            :host {
                display: flex;
                width: 100%;
                height: 100%;
                min-height: 0;
            }
            .resizer {
                position: relative;
                background: var(--od-bg, #f5f5f5);
                width: 6px;
                min-width: 6px;
                cursor: col-resize;
                flex-shrink: 0;
                transition:
                    width 0.22s ease,
                    min-width 0.22s ease,
                    opacity 0.16s ease;
            }
            .resizer-center {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                pointer-events: none;
            }
            .resizer-indicator {
                width: 3px;
                height: 40px;
                border-radius: 9999px;
                background: rgba(0, 0, 0, 0.12);
                opacity: 0;
                transition: opacity 0.2s ease;
            }
            .resizer:hover .resizer-indicator {
                opacity: 1;
            }
            #leftPanel {
                opacity: 1;
                transition:
                    width 0.22s cubic-bezier(0.4, 0, 0.2, 1),
                    opacity 0.14s ease;
            }
            :host([collapsed]) #leftPanel {
                width: 50px !important;
                overflow: hidden !important;
            }
            :host([collapsed]) .resizer {
                width: 0;
                min-width: 0;
                opacity: 0;
                pointer-events: none;
            }
            :host([resizing]) #leftPanel,
            :host([resizing]) .resizer {
                transition: none;
            }
            @media (prefers-reduced-motion: reduce) {
                #leftPanel,
                .resizer {
                    transition: none;
                }
            }
        </style>
        <slot id="leftPanel" name="left" style="display: flex; flex-direction: column; width: ${initialWidth}px; height: 100%; flex-shrink: 0; min-height: 0; overflow: visible;"></slot>

        <div id="resizer" class="resizer">
            <div class="resizer-center">
                <div class="resizer-indicator"></div>
            </div>
        </div>

        <div id="rightPanelWrapper" style="display: flex; flex-direction: column; flex: 1 1 0; min-width: 0; min-height: 0; height: 100%; overflow: hidden;">
            <slot id="rightPanel" name="right" style="display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0;"></slot>
        </div>
        `;

        const resizer = this.shadowRoot.getElementById('resizer');
        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._startResize();
        });

        // 双击分割线恢复默认宽度
        resizer.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._resetToDefault();
        });

        this._syncCollapsedState();
    }

    _syncCollapsedState() {
        this.setAttribute('aria-expanded', String(!this.isCollapsed()));
    }

    _resetToDefault() {
        const leftPanel = this.shadowRoot.getElementById('leftPanel');
        if (!leftPanel) return;

        const currentWidth = parseInt(leftPanel.style.width, 10);
        if (currentWidth === this._defaultWidth) return;

        leftPanel.style.width = this._defaultWidth + 'px';
        this.dispatchEvent(
            new CustomEvent('splitter-resize', {
                detail: { width: this._defaultWidth },
                bubbles: true,
                composed: true
            })
        );
    }

    _startResize() {
        if (this._isResizing || this.isCollapsed()) return;
        this._isResizing = true;
        this.setAttribute('resizing', '');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);
        // 防止鼠标进入 iframe 区域后事件被 iframe 拦截
        const rightWrapper = this.shadowRoot.getElementById('rightPanelWrapper');
        if (rightWrapper) {
            rightWrapper.style.pointerEvents = 'none';
        }
    }

    _stopResize() {
        if (!this._isResizing) return;
        this._isResizing = false;
        this.removeAttribute('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
        const rightWrapper = this.shadowRoot.getElementById('rightPanelWrapper');
        if (rightWrapper) {
            rightWrapper.style.pointerEvents = '';
        }

        // 拖拽结束时通知宽度变更
        const leftPanel = this.shadowRoot.getElementById('leftPanel');
        if (leftPanel) {
            const width = parseInt(leftPanel.style.width, 10);
            if (!isNaN(width)) {
                this.dispatchEvent(
                    new CustomEvent('splitter-resize', {
                        detail: { width },
                        bubbles: true,
                        composed: true
                    })
                );
            }
        }
    }

    _onMouseMove(e) {
        if (!this._isResizing) return;
        e.preventDefault();

        const leftPanel = this.shadowRoot.getElementById('leftPanel');
        if (!leftPanel) return;

        const containerRect = this.getBoundingClientRect();
        const containerWidth = containerRect.width;
        const mouseX = e.clientX - containerRect.left;
        const leftWidth = mouseX;

        const minWidth = 200;
        const maxWidth = containerWidth * 0.85;

        if (leftWidth < minWidth || leftWidth > maxWidth) return;

        leftPanel.style.width = leftWidth + 'px';
    }

    _onMouseUp(e) {
        this._stopResize();
    }
}

customElements.define('splitter-widget', SplitterWidget);
