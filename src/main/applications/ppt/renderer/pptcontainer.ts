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

/// <reference path="./global.d.ts" />
import type { Slides } from '../common';

export class PPTContainer extends HTMLElement {
    private pptId?: string;
    private slides: Slides | null = null;
    private totalPages: number = 0;
    private currentPage: number = 0;
    private slideIframe: HTMLIFrameElement | null = null;
    private slideWrapper: HTMLElement | null = null;
    private pageLabel: HTMLElement | null = null;
    private prevBtn: HTMLElement | null = null;
    private nextBtn: HTMLElement | null = null;
    private thumbnailsContainer: HTMLElement | null = null;
    private titleEl: HTMLElement | null = null;
    private fullscreenBtn: HTMLElement | null = null;
    private fullscreenRoot: HTMLElement | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private boundKeyHandler = (e: KeyboardEvent) => this.handleKeyDown(e);
    private boundFullscreenChange = () => this.onFullscreenChange();

    static get observedAttributes() {
        return ['data-id', 'title', 'total-pages'];
    }

    constructor() {
        super();
        this.pptId = this.dataset.id;
    }

    connectedCallback() {
        this.render();
        this.bindElements();
        this.attachEventListeners();
        this.loadPPT();
    }

    private async loadPPT() {
        let slides: Slides | null = null;
        console.info(this.pptId);
        if (this.pptId) {
            try {
                const res = await fetch(`ppt://metadata/${this.pptId}`);
                const respObject = await res.json();
                slides = (respObject.data) as Slides;
            } catch (e) {
                console.error('Failed to fetch slides metadata:', e);
            }
        }
        if (!slides) return;

        this.slides = slides;
        if (this.slides?.pages?.length) {
            this.totalPages = this.slides.pages.length;
            if (this.titleEl && this.slides.name) this.titleEl.textContent = this.slides.name;
        }
        this.updatePageLabel();
        this.showPage(this.currentPage);
        this.renderThumbnails();
    }

    disconnectedCallback() {
        this.resizeObserver?.disconnect();
        document.removeEventListener('keydown', this.boundKeyHandler);
        document.removeEventListener('fullscreenchange', this.boundFullscreenChange);
        document.removeEventListener('webkitfullscreenchange', this.boundFullscreenChange);
    }

    private handleKeyDown(e: KeyboardEvent) {
        if (e.target !== document.body && !this.contains(e.target as Node)) return;
        if (e.key === 'Escape' && this.isFullscreen()) {
            this.exitFullscreen();
            return;
        }
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            this.prevPage();
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            this.nextPage();
        }
    }

    private bindElements() {
        this.slideIframe = this.querySelector('[data-ppt-iframe]') as HTMLIFrameElement | null;
        this.slideWrapper = this.querySelector('[data-ppt-iframe-wrapper]');
        this.pageLabel = this.querySelector('[data-ppt-page-label]');
        this.prevBtn = this.querySelector('[data-ppt-prev]');
        this.nextBtn = this.querySelector('[data-ppt-next]');
        this.thumbnailsContainer = this.querySelector('[data-ppt-thumbnails]');
        this.titleEl = this.querySelector('[data-ppt-title]');
        this.fullscreenBtn = this.querySelector('[data-ppt-fullscreen]');
        this.fullscreenRoot = this.querySelector('[data-ppt-root]');
    }

    private attachEventListeners() {
        this.prevBtn?.addEventListener('click', () => this.prevPage());
        this.nextBtn?.addEventListener('click', () => this.nextPage());
        this.fullscreenBtn?.addEventListener('click', () => this.toggleFullscreen());
        document.addEventListener('keydown', this.boundKeyHandler);
        document.addEventListener('fullscreenchange', this.boundFullscreenChange);
        document.addEventListener('webkitfullscreenchange', this.boundFullscreenChange);
        this.resizeObserver?.disconnect();
        if (this.slideWrapper) {
            this.updateScale();
            this.resizeObserver = new ResizeObserver(() => this.updateScale());
            this.resizeObserver.observe(this.slideWrapper);
        }
    }

    private isFullscreen(): boolean {
        return !!(
            document.fullscreenElement ||
            (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement
        );
    }

    private async toggleFullscreen() {
        if (!this.fullscreenRoot) return;
        if (this.isFullscreen()) {
            await this.exitFullscreen();
        } else {
            const el = this.fullscreenRoot as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
            try {
                if (el.requestFullscreen) await el.requestFullscreen();
                else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
            } catch {
                // ignore
            }
        }
    }

    private async exitFullscreen() {
        try {
            if (document.exitFullscreen) await document.exitFullscreen();
            else if ((document as Document & { webkitExitFullscreen?: () => Promise<void> }).webkitExitFullscreen) {
                await (document as Document & { webkitExitFullscreen: () => Promise<void> }).webkitExitFullscreen();
            }
        } catch {
            // ignore
        }
    }

    private onFullscreenChange() {
        if (!this.fullscreenBtn) return;
        const active = this.isFullscreen();
        this.fullscreenBtn.textContent = active ? '退出全屏' : '全屏预览';
    }

    private showPage(index: number) {
        if (!this.slideIframe) return;
        this.currentPage = index;
        this.updatePageLabel();
        this.updateThumbnailActive();

        const doc = this.slideIframe.contentDocument;
        if (!doc) return;

        if (!this.slides?.pages?.length || index < 0 || index >= this.slides.pages.length) {
            doc.open();
            doc.write(`
            <!DOCTYPE html><html><head><meta charset="utf-8"></head>
            <body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;color:#9ca3af;font-size:14px;font-family:system-ui,sans-serif;">
            暂无幻灯片内容，请点击下方页码切换
            </body></html>`);
            doc.close();
            return;
        }

        const pageHtml = this.slides.pages[index];
        const baseTag = `<base href="ppt://data/${this.pptId}/" target="_blank">`;
        doc.open();
        doc.write(baseTag + pageHtml);
        doc.close();
    }

    private updateScale() {
        if (!this.slideWrapper || !this.slideIframe) return;
        const w = this.slideWrapper.clientWidth;
        const h = this.slideWrapper.clientHeight;
        const slideW = 1280;
        const slideH = 720;
        const scale = Math.min(w / slideW, h / slideH, 1);
        const iframe = this.slideIframe;
        iframe.style.position = 'absolute';
        iframe.style.width = slideW + 'px';
        iframe.style.height = slideH + 'px';
        iframe.style.left = '50%';
        iframe.style.top = '50%';
        iframe.style.transformOrigin = '50% 50%';
        iframe.style.transform = `translate(-50%, -50%) scale(${scale})`;
    }

    private updatePageLabel() {
        if (!this.pageLabel) return;
        const total = Math.max(1, this.totalPages);
        const current = this.totalPages ? this.currentPage + 1 : 0;
        this.pageLabel.textContent = `${current} / ${total}`;
    }

    private updateThumbnailActive() {
        this.thumbnailsContainer?.querySelectorAll('[data-ppt-thumb]').forEach((el, i) => {
            el.classList.remove('ring-2', 'ring-blue-500');
            if (i === this.currentPage) el.classList.add('ring-2', 'ring-blue-500');
        });
    }

    private renderThumbnails() {
        if (!this.thumbnailsContainer) return;
        this.thumbnailsContainer.innerHTML = '';
        for (let i = 0; i < this.totalPages; i++) {
            const div = document.createElement('div');
            div.setAttribute('data-ppt-thumb', '');
            div.className =
                'rounded p-0.5 transition-colors cursor-pointer hover:bg-gray-200 flex items-center justify-center ' +
                (i === this.currentPage ? 'ring-2 ring-blue-500' : '');
            div.innerHTML = `<div class="aspect-[16/9] w-full bg-white border border-gray-300 rounded shadow-sm flex items-center justify-center text-[10px] text-gray-500">${i + 1}</div>`;
            div.title = `第 ${i + 1} 页，点击切换`;
            div.addEventListener('click', () => this.goToPage(i));
            this.thumbnailsContainer.appendChild(div);
        }
        this.updateThumbnailActive();
    }

    prevPage() {
        if (this.currentPage > 0) this.showPage(this.currentPage - 1);
    }

    nextPage() {
        if (this.currentPage < this.totalPages - 1) this.showPage(this.currentPage + 1);
    }

    goToPage(index: number) {
        if (index >= 0 && index < this.totalPages) this.showPage(index);
    }

    get currentPageIndex(): number {
        return this.currentPage;
    }

    get pageCount(): number {
        return this.totalPages;
    }

    private render() {
        const title = this.getAttribute('title') || 'PPT 演示';
        this.innerHTML = `
    <div class="max-w-3xl mx-auto my-4 overflow-hidden bg-[#f5f5f7] border border-gray-200 rounded-2xl shadow-xm font-sans text-gray-900" data-ppt-root>
      <div class="flex items-center justify-between px-4 py-2 bg-gray-100/50 backdrop-blur-md border-b border-gray-200">
        <div class="text-[12px] font-medium text-gray-500 tracking-tight flex items-center" data-ppt-title>
          <svg class="w-3 h-3 mr-1.5 opacity-60" fill="currentColor" viewBox="0 0 20 20"><path d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"></path></svg>
          ${title}
        </div>
        <div class="w-12"></div>
      </div>

      <div class="flex">
        <div class="hidden sm:flex flex-col w-20 bg-gray-50/50 border-r border-gray-200 p-2 space-y-2 overflow-y-auto max-h-[400px]" data-ppt-thumbnails>
        </div>

        <div class="flex-1 p-6 relative group">
          <div class="aspect-[16/9] bg-white rounded shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-gray-100 overflow-hidden relative" data-ppt-iframe-wrapper>
            <iframe data-ppt-iframe src="about:blank" class="border-0" title="PPT 幻灯片"></iframe>
          </div>

          <div class="absolute bottom-10 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur border border-gray-200/50 shadow-xl rounded-full px-4 py-2 flex items-center space-x-6 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
            <button type="button" data-ppt-prev class="hover:bg-gray-100 p-1.5 rounded-full transition-colors" aria-label="上一页">
              <svg class="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
            </button>
            <span class="text-xs font-semibold text-gray-600 tabular-nums min-w-[3rem] text-center" data-ppt-page-label>0 / 0</span>
            <button type="button" data-ppt-next class="hover:bg-gray-100 p-1.5 rounded-full transition-colors" aria-label="下一页">
              <svg class="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
            </button>
          </div>
        </div>
      </div>

      <div class="px-6 py-3 bg-white border-t border-gray-200 flex items-center justify-between">
        <div class="flex items-center text-xs text-gray-400">
          <span class="flex items-center mr-4"><span class="w-2 h-2 bg-green-500 rounded-full mr-1.5 animate-pulse"></span> 就绪</span>
        </div>
        <div class="flex space-x-3">
          <button type="button" data-ppt-fullscreen class="px-4 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-lg transition-colors border border-gray-200/60" aria-label="全屏预览">全屏预览</button>
        </div>
      </div>
    </div>
    `;
    }
}

if (typeof window !== 'undefined' && !customElements.get('ppt-container')) {
    customElements.define('ppt-container', PPTContainer);
}
