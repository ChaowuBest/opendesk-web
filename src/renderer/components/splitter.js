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

class SplitterWidget extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._isResizing = false;
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
    }

    connectedCallback() {
        this.render();
    }

    disconnectedCallback() {
        this._stopResize();
    }

    render() {
        const initialWidth = this.getAttribute('initial-width') || '350';

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
                background: transparent;
                width: 6px;
                min-width: 6px;
                cursor: col-resize;
                flex-shrink: 0;
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
    }

    _startResize() {
        if (this._isResizing) return;
        this._isResizing = true;
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
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
        const rightWrapper = this.shadowRoot.getElementById('rightPanelWrapper');
        if (rightWrapper) {
            rightWrapper.style.pointerEvents = '';
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
