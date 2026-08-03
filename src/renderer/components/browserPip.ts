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
 * 浏览器画中画浮窗组件（Browser Picture-in-Picture）。
 *
 * 当用户隐藏右侧 task artifacts 面板、且 agent 已使用过浏览器时，
 * 以浮窗形式在消息历史区域的右上角显示浏览器当前 tab 的截图。
 *
 * - 可自由拖动，四个角可等比缩放
 * - 右上角恢复按钮（重新打开 artifacts 面板的浏览器 tab）和关闭按钮
 * - 底部状态栏显示标签页总数
 * - 仅展示，不支持操作透传
 * - 截图通过顶部对齐 + 宽度适配方式展示，保证左右内容完整
 */

import { createRendererTranslator } from '../locale';

const t = createRendererTranslator();

const DEFAULT_WIDTH = 308;
const IMG_ASPECT_RATIO = 1280 / 800; // webview capture aspect ratio
const STATUS_BAR_HEIGHT = 24;
const MIN_WIDTH = 200;
const MAX_WIDTH = 560;
const CAPTURE_INTERVAL_MS = 1000;
const CAPTURE_TIMEOUT_MS = 8000;
const MARGIN = 8;
const RESIZE_HANDLE_SIZE = 12;

export interface BrowserPipCallbacks {
    /** 恢复按钮：重新打开 artifacts 面板的浏览器 tab */
    onRestore: () => void;
    /** 获取截图 data URL */
    capturePage: () => Promise<string | null>;
    /** 获取标签页总数 */
    getTabCount: () => number;
    /** 获取当前标签页标题 */
    getActiveTabTitle: () => string;
    /** 获取当前标签页 URL */
    getActiveTabUrl: () => string;
}

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

export class BrowserPip {
    private _container: HTMLElement;
    private _el: HTMLElement | null = null;
    private _imgEl: HTMLImageElement | null = null;
    private _statusEl: HTMLElement | null = null;
    private _captureTimer: number | null = null;
    private _callbacks: BrowserPipCallbacks;
    private _visible = false;
    private _closed = false;
    private _capturing = false;

    // 当前宽度（高度由比例算出）
    private _width = DEFAULT_WIDTH;

    // 拖动状态
    private _dragging = false;
    private _dragOffsetX = 0;
    private _dragOffsetY = 0;
    private _posX = 0;
    private _posY = 0;

    // 缩放状态
    private _resizing = false;
    private _resizeCorner: ResizeCorner = 'se';
    private _resizeStartX = 0;
    private _resizeStartY = 0;
    private _resizeStartWidth = 0;
    private _resizeStartPosX = 0;
    private _resizeStartPosY = 0;

    private _boundOnMouseMove: (e: MouseEvent) => void;
    private _boundOnMouseUp: (e: MouseEvent) => void;

    constructor(container: HTMLElement, callbacks: BrowserPipCallbacks) {
        this._container = container;
        this._callbacks = callbacks;
        this._boundOnMouseMove = this._onMouseMove.bind(this);
        this._boundOnMouseUp = this._onMouseUp.bind(this);
        this._build();
    }

    private _imgHeight(): number {
        return Math.round(this._width / IMG_ASPECT_RATIO);
    }

    private _totalHeight(): number {
        return this._imgHeight() + STATUS_BAR_HEIGHT;
    }

    private _totalAspectRatio(): number {
        return this._width / this._totalHeight();
    }

    private _build(): void {
        const el = document.createElement('div');
        el.className = 'browser-pip';
        el.style.cssText = `
            position: absolute;
            width: ${this._width}px;
            z-index: 1000;
            border-radius: 8px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10);
            overflow: visible;
            display: none;
            flex-direction: column;
            background: #1f2937;
            border: 1px solid rgba(255,255,255,0.08);
            user-select: none;
            transition: box-shadow 0.2s;
        `;

        // 内部容器（clip 内容）
        const inner = document.createElement('div');
        inner.style.cssText = `
            width: 100%;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            border-radius: 8px;
        `;

        // 标题栏（可拖动区域，叠加在截图上方）
        const titleBar = document.createElement('div');
        titleBar.style.cssText = `
            position: absolute;
            top: 0; left: 0; right: 0;
            height: 28px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 5px 0 8px;
            background: linear-gradient(180deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0) 100%);
            z-index: 2;
            cursor: grab;
        `;

        const titleLabel = document.createElement('span');
        titleLabel.style.cssText = `
            font-size: var(--fs-xs);
            color: rgba(255,255,255,0.85);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex: 1;
            min-width: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            pointer-events: none;
        `;
        titleLabel.className = 'pip-title-label';
        titleBar.appendChild(titleLabel);

        const btnGroup = document.createElement('div');
        btnGroup.style.cssText = `display: flex; align-items: center; gap: 4px; flex-shrink: 0;`;

        const restoreBtn = this._createButton(
            'fa-up-right-and-down-left-from-center',
            t('renderer.browserPip.restore')
        );
        restoreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._callbacks.onRestore();
        });

        const closeBtn = this._createButton('fa-xmark', t('renderer.browserPip.close'));
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.close();
        });

        btnGroup.appendChild(restoreBtn);
        btnGroup.appendChild(closeBtn);
        titleBar.appendChild(btnGroup);

        // 拖动事件绑定到标题栏
        titleBar.addEventListener('mousedown', (e) => {
            if ((e.target as HTMLElement).closest('button')) return;
            this._onDragStart(e);
        });

        // 截图区域（高度由图片撑开，无固定高度避免黑边）
        const imgWrap = document.createElement('div');
        imgWrap.className = 'pip-img-wrap';
        imgWrap.style.cssText = `
            width: 100%;
            overflow: hidden;
            background: #111827;
            position: relative;
        `;

        const img = document.createElement('img');
        img.style.cssText = `
            width: 100%;
            height: auto;
            display: block;
            pointer-events: none;
        `;
        img.alt = 'Browser preview';
        this._imgEl = img;

        const placeholder = document.createElement('div');
        placeholder.style.cssText = `
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            color: rgba(255,255,255,0.3);
            font-size: 26px;
        `;
        placeholder.innerHTML = '<i class="fas fa-globe"></i>';
        placeholder.className = 'pip-placeholder';

        imgWrap.appendChild(placeholder);
        imgWrap.appendChild(img);

        // 底部状态栏
        const statusBar = document.createElement('div');
        statusBar.style.cssText = `
            height: ${STATUS_BAR_HEIGHT}px;
            display: flex;
            align-items: center;
            padding: 0 8px;
            background: #111827;
            border-top: 1px solid rgba(255,255,255,0.06);
            font-size: var(--fs-xs);
            color: rgba(255,255,255,0.55);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            gap: 5px;
            flex-shrink: 0;
        `;
        this._statusEl = statusBar;

        inner.appendChild(titleBar);
        inner.appendChild(imgWrap);
        inner.appendChild(statusBar);
        el.appendChild(inner);

        // 四角缩放手柄
        const corners: ResizeCorner[] = ['nw', 'ne', 'sw', 'se'];
        for (const corner of corners) {
            const handle = document.createElement('div');
            handle.dataset.corner = corner;
            const cursors: Record<ResizeCorner, string> = {
                nw: 'nwse-resize',
                ne: 'nesw-resize',
                sw: 'nesw-resize',
                se: 'nwse-resize'
            };
            const pos: Record<ResizeCorner, string> = {
                nw: `top: -${RESIZE_HANDLE_SIZE / 2}px; left: -${RESIZE_HANDLE_SIZE / 2}px;`,
                ne: `top: -${RESIZE_HANDLE_SIZE / 2}px; right: -${RESIZE_HANDLE_SIZE / 2}px;`,
                sw: `bottom: -${RESIZE_HANDLE_SIZE / 2}px; left: -${RESIZE_HANDLE_SIZE / 2}px;`,
                se: `bottom: -${RESIZE_HANDLE_SIZE / 2}px; right: -${RESIZE_HANDLE_SIZE / 2}px;`
            };
            handle.style.cssText = `
                position: absolute;
                width: ${RESIZE_HANDLE_SIZE}px;
                height: ${RESIZE_HANDLE_SIZE}px;
                ${pos[corner]}
                cursor: ${cursors[corner]};
                z-index: 3;
            `;
            handle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                this._onResizeStart(e, corner);
            });
            el.appendChild(handle);
        }

        this._el = el;
        this._container.appendChild(el);

        this._positionDefault();
    }

    private _createButton(iconClass: string, title: string): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.title = title;
        btn.style.cssText = `
            width: 20px;
            height: 20px;
            border: none;
            background: rgba(255,255,255,0.1);
            color: rgba(255,255,255,0.8);
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: var(--fs-2xs);
            transition: background 0.15s;
            padding: 0;
        `;
        btn.innerHTML = `<i class="fas ${iconClass}"></i>`;
        btn.addEventListener('mouseenter', () => {
            btn.style.background = 'rgba(255,255,255,0.25)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background = 'rgba(255,255,255,0.1)';
        });
        return btn;
    }

    private _applySize(): void {
        if (!this._el) return;
        this._el.style.width = `${this._width}px`;
    }

    // 默认位置：右上角
    private _positionDefault(): void {
        if (!this._el || !this._container) return;
        const rect = this._container.getBoundingClientRect();
        this._posX = rect.width - this._width - MARGIN;
        this._posY = MARGIN;
        this._applyPosition();
    }

    private _applyPosition(): void {
        if (!this._el) return;
        this._el.style.left = `${this._posX}px`;
        this._el.style.top = `${this._posY}px`;
    }

    private _clampPosition(): void {
        if (!this._container || !this._el) return;
        const rect = this._container.getBoundingClientRect();
        const elRect = this._el.getBoundingClientRect();
        this._posX = Math.max(0, Math.min(this._posX, rect.width - this._width));
        this._posY = Math.max(0, Math.min(this._posY, rect.height - elRect.height));
    }

    // ---- 拖动 ----

    private _onDragStart(e: MouseEvent): void {
        if (!this._el || !this._container) return;
        this._dragging = true;
        const containerRect = this._container.getBoundingClientRect();
        this._dragOffsetX = e.clientX - containerRect.left - this._posX;
        this._dragOffsetY = e.clientY - containerRect.top - this._posY;
        this._el.style.cursor = 'grabbing';

        document.addEventListener('mousemove', this._boundOnMouseMove);
        document.addEventListener('mouseup', this._boundOnMouseUp);
        e.preventDefault();
    }

    // ---- 缩放 ----

    private _onResizeStart(e: MouseEvent, corner: ResizeCorner): void {
        if (!this._el || !this._container) return;
        this._resizing = true;
        this._resizeCorner = corner;
        this._resizeStartX = e.clientX;
        this._resizeStartY = e.clientY;
        this._resizeStartWidth = this._width;
        this._resizeStartPosX = this._posX;
        this._resizeStartPosY = this._posY;

        document.addEventListener('mousemove', this._boundOnMouseMove);
        document.addEventListener('mouseup', this._boundOnMouseUp);
    }

    private _onMouseMove(e: MouseEvent): void {
        if (this._dragging) {
            this._onDragMove(e);
        } else if (this._resizing) {
            this._onResizeMove(e);
        }
    }

    private _onDragMove(e: MouseEvent): void {
        if (!this._container) return;
        const containerRect = this._container.getBoundingClientRect();
        this._posX = e.clientX - containerRect.left - this._dragOffsetX;
        this._posY = e.clientY - containerRect.top - this._dragOffsetY;
        this._clampPosition();
        this._applyPosition();
    }

    private _onResizeMove(e: MouseEvent): void {
        const dx = e.clientX - this._resizeStartX;
        const dy = e.clientY - this._resizeStartY;
        const corner = this._resizeCorner;
        const ratio = this._totalAspectRatio();

        // 根据拖动的角计算宽度变化量（取 dx/dy 中绝对值较大者，锁定比例）
        let delta: number;
        if (corner === 'se') {
            delta = Math.abs(dx) > Math.abs(dy) ? dx : dy * ratio;
        } else if (corner === 'sw') {
            delta = Math.abs(-dx) > Math.abs(dy) ? -dx : dy * ratio;
        } else if (corner === 'ne') {
            delta = Math.abs(dx) > Math.abs(-dy) ? dx : -dy * ratio;
        } else {
            // nw
            delta = Math.abs(-dx) > Math.abs(-dy) ? -dx : -dy * ratio;
        }

        const newWidth = Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, this._resizeStartWidth + delta)));
        const widthDiff = newWidth - this._resizeStartWidth;
        const heightDiff = Math.round(widthDiff / ratio);

        this._width = newWidth;

        // 左侧角拖动时需要移动位置以保持右侧/底部不动
        if (corner === 'nw') {
            this._posX = this._resizeStartPosX - widthDiff;
            this._posY = this._resizeStartPosY - heightDiff;
        } else if (corner === 'ne') {
            this._posY = this._resizeStartPosY - heightDiff;
        } else if (corner === 'sw') {
            this._posX = this._resizeStartPosX - widthDiff;
        }
        // se: position unchanged

        this._applySize();
        this._clampPosition();
        this._applyPosition();
    }

    private _onMouseUp(_e: MouseEvent): void {
        this._dragging = false;
        this._resizing = false;
        if (this._el) {
            this._el.style.cursor = '';
        }
        document.removeEventListener('mousemove', this._boundOnMouseMove);
        document.removeEventListener('mouseup', this._boundOnMouseUp);
    }

    // ---- 截图刷新 ----

    private _startCapture(): void {
        this._stopCapture();
        this._doCapture();
        this._captureTimer = window.setInterval(() => this._doCapture(), CAPTURE_INTERVAL_MS);
    }

    private _stopCapture(): void {
        if (this._captureTimer !== null) {
            window.clearInterval(this._captureTimer);
            this._captureTimer = null;
        }
    }

    private async _doCapture(): Promise<void> {
        if (!this._visible || !this._imgEl) return;
        if (this._capturing) return;
        this._capturing = true;
        try {
            const capturePromise = this._callbacks.capturePage();
            const timeoutPromise = new Promise<null>((resolve) => {
                setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
            });
            const dataUrl = await Promise.race([capturePromise, timeoutPromise]);
            if (dataUrl && this._imgEl && this._visible) {
                this._imgEl.src = dataUrl;
                const placeholder = this._el?.querySelector('.pip-placeholder') as HTMLElement;
                if (placeholder) placeholder.style.display = 'none';
            }
        } catch {
            // 截图失败则保持上次的截图
        } finally {
            this._capturing = false;
        }
        this._updateStatus();
    }

    private _updateStatus(): void {
        if (!this._statusEl) return;
        const tabCount = this._callbacks.getTabCount();
        const url = this._callbacks.getActiveTabUrl();
        let urlDisplay = '';
        if (url && url !== 'about:blank') {
            try {
                urlDisplay = new URL(url).hostname;
            } catch {
                urlDisplay = url.slice(0, 30);
            }
        }
        this._statusEl.innerHTML = `
            <i class="fas fa-layer-group" style="font-size: var(--fs-xs);"></i>
            <span>${t('renderer.browserPip.tabCount', { count: tabCount })}</span>
            ${urlDisplay ? `<span style="margin-left: auto; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${urlDisplay}</span>` : ''}
        `;

        const titleLabel = this._el?.querySelector('.pip-title-label') as HTMLElement;
        if (titleLabel) {
            const title = this._callbacks.getActiveTabTitle();
            titleLabel.textContent = title || t('renderer.browserPip.title');
        }
    }

    // ---- Public API ----

    public show(): void {
        if (this._closed || !this._el) return;
        if (this._visible) return;
        this._visible = true;
        this._el.style.display = 'flex';
        this._positionDefault();
        this._startCapture();
    }

    public hide(): void {
        if (!this._el) return;
        this._visible = false;
        this._el.style.display = 'none';
        this._stopCapture();
    }

    /** 用户手动关闭浮窗；当前会话内同一"折叠周期"不再自动弹出 */
    public close(): void {
        this._closed = true;
        this.hide();
    }

    /** 重置关闭状态（侧边栏重新折叠时调用，新的折叠周期应重新弹出） */
    public resetClosed(): void {
        this._closed = false;
    }

    /** 触发一组截图刷新（浏览器操作后调用，多次捕获以显示页面加载进度） */
    public triggerCapture(): void {
        if (!this._visible) return;
        this._doCapture();
        // 页面操作后多次刷新以捕获加载过程和最终状态
        setTimeout(() => this._doCapture(), 800);
        setTimeout(() => this._doCapture(), 2000);
    }

    public isClosed(): boolean {
        return this._closed;
    }

    public isVisible(): boolean {
        return this._visible;
    }

    public destroy(): void {
        this._stopCapture();
        document.removeEventListener('mousemove', this._boundOnMouseMove);
        document.removeEventListener('mouseup', this._boundOnMouseUp);
        this._el?.remove();
        this._el = null;
        this._imgEl = null;
        this._statusEl = null;
    }
}
