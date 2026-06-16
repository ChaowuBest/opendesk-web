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

import { Marked, Renderer } from 'marked';
import markdownCSS from '../styles/github-markdown-light.min.css?inline';
import { escapeHtml } from '../../common/utils/escape.js';
import { createRendererTranslator } from '../locale.ts';

type MemoryTab = 'portrait' | 'facts';

interface UserPortraitPayload {
    raw: string;
}

interface FactMemoryPayload {
    scope: 'workspace' | 'global';
    uid: string;
    title: string;
    content: string;
    heat: number;
}

const renderer = new Renderer();
renderer.html = (token) => {
    const raw = typeof token === 'string' ? token : (token?.raw ?? token?.text ?? '');
    return escapeHtml(raw);
};

const marked = new Marked({ renderer });

class MemoryPanel extends HTMLElement {
    private readonly root: ShadowRoot;
    private activeTab: MemoryTab = 'portrait';
    private portrait = '';
    private memories: FactMemoryPayload[] = [];
    private loading = false;
    private error: string | null = null;
    private settingUnsubscribe: (() => void) | null = null;
    private t = createRendererTranslator();

    constructor() {
        super();
        this.root = this.attachShadow({ mode: 'open' });
    }

    connectedCallback(): void {
        this.render();
        void this.initializeLocale();
        void this.loadMemoryData();
    }

    disconnectedCallback(): void {
        this.settingUnsubscribe?.();
        this.settingUnsubscribe = null;
    }

    private async initializeLocale(): Promise<void> {
        try {
            const api = (window as any).settingAPI;
            if (api?.loadSettingObject) {
                const setting = await api.loadSettingObject();
                this.t = createRendererTranslator(setting?.locale);
                this.render();
            }
            if (api?.onSettingChanged && !this.settingUnsubscribe) {
                this.settingUnsubscribe = api.onSettingChanged((setting: any) => {
                    this.t = createRendererTranslator(setting?.locale);
                    this.render();
                });
            }
        } catch {
            this.t = createRendererTranslator();
        }
    }

    private async loadMemoryData(): Promise<void> {
        this.loading = true;
        this.error = null;
        this.render();
        try {
            const api = (window as any).memoryAPI;
            if (!api?.getUserPortrait || !api?.listMemories) {
                throw new Error('memoryAPI is unavailable');
            }
            const [portraitPayload, memoriesPayload] = (await Promise.all([
                api.getUserPortrait(),
                api.listMemories()
            ])) as [UserPortraitPayload, FactMemoryPayload[]];
            this.portrait = portraitPayload.raw || '';
            this.memories = Array.isArray(memoriesPayload) ? memoriesPayload : [];
        } catch (err) {
            this.error = err instanceof Error ? err.message : String(err);
        } finally {
            this.loading = false;
            this.render();
        }
    }

    private switchTab(tab: MemoryTab): void {
        if (this.activeTab === tab) {
            return;
        }
        this.activeTab = tab;
        this.render();
    }

    private renderTabButton(tab: MemoryTab, label: string): string {
        const active = this.activeTab === tab;
        return `
            <button class="memory-tab ${active ? 'active' : ''}" data-tab="${tab}" type="button">
                ${escapeHtml(label)}
            </button>
        `;
    }

    private async renderPortraitBody(): Promise<string> {
        if (this.loading) {
            return `
                <div class="state">
                    <div class="spinner"></div>
                    <div>${escapeHtml(this.t('renderer.memory.loadingPortrait'))}</div>
                </div>
            `;
        }

        if (this.error) {
            return `
                <div class="state error">
                    <div class="state-title">${escapeHtml(this.t('renderer.memory.readFailed'))}</div>
                    <div class="state-detail">${escapeHtml(this.error)}</div>
                </div>
            `;
        }

        if (!this.portrait.trim()) {
            return `
                <div class="state">
                    <div class="state-title">${escapeHtml(this.t('renderer.memory.emptyPortrait'))}</div>
                    <div class="state-detail">${escapeHtml(this.t('renderer.memory.emptyPortraitDetail'))}</div>
                </div>
            `;
        }

        const html = await marked.parse(this.portrait);
        return `<article class="markdown-body">${html}</article>`;
    }

    private renderScopeLabel(scope: FactMemoryPayload['scope']): string {
        return scope === 'global' ? this.t('renderer.memory.globalScope') : this.t('renderer.memory.workspaceScope');
    }

    private renderFactsBody(): string {
        if (this.loading) {
            return `
                <div class="state">
                    <div class="spinner"></div>
                    <div>${escapeHtml(this.t('renderer.memory.loadingFacts'))}</div>
                </div>
            `;
        }

        if (this.error) {
            return `
                <div class="state error">
                    <div class="state-title">${escapeHtml(this.t('renderer.memory.readFailed'))}</div>
                    <div class="state-detail">${escapeHtml(this.error)}</div>
                </div>
            `;
        }

        if (this.memories.length === 0) {
            return `
                <div class="state">
                    <div class="state-title">${escapeHtml(this.t('renderer.memory.emptyFacts'))}</div>
                    <div class="state-detail">${escapeHtml(this.t('renderer.memory.emptyFactsDetail'))}</div>
                </div>
            `;
        }

        const sorted = [...this.memories].sort((left, right) => {
            const scopeOrder = left.scope.localeCompare(right.scope);
            if (scopeOrder !== 0) {
                return scopeOrder;
            }
            return right.heat - left.heat || left.title.localeCompare(right.title);
        });

        return `
            <div class="facts-list">
                ${sorted
                    .map(
                        (memory) => `
                            <section class="memory-row">
                                <div class="memory-row-header">
                                    <h3>${escapeHtml(memory.title)}</h3>
                                    <div class="memory-meta">
                                        <span class="scope-pill ${memory.scope}">${escapeHtml(this.renderScopeLabel(memory.scope))}</span>
                                        <span>${escapeHtml(this.t('renderer.memory.heat'))}: ${escapeHtml(String(memory.heat))}</span>
                                    </div>
                                </div>
                                <div class="memory-content">${escapeHtml(memory.content)}</div>
                                <div class="memory-uid">${escapeHtml(memory.uid)}</div>
                            </section>
                        `
                    )
                    .join('')}
            </div>
        `;
    }

    private async renderBody(): Promise<string> {
        if (this.activeTab === 'portrait') {
            return await this.renderPortraitBody();
        }
        return this.renderFactsBody();
    }

    private bindEvents(): void {
        this.root.querySelectorAll<HTMLButtonElement>('.memory-tab[data-tab]').forEach((button) => {
            button.addEventListener('click', () => {
                const tab = button.dataset.tab;
                if (tab === 'portrait' || tab === 'facts') {
                    this.switchTab(tab);
                }
            });
        });
        this.root.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.addEventListener('click', () => {
            void this.loadMemoryData();
        });
    }

    private render(): void {
        void this.renderBody().then((body) => {
            this.root.innerHTML = `
                <style>
                    ${markdownCSS}

                    :host {
                        display: block;
                        min-height: 420px;
                        color: var(--od-text, #1f2937);
                    }

                    .memory-panel {
                        display: flex;
                        flex-direction: column;
                        min-height: 420px;
                        height: 100%;
                        background: var(--mp-bg, rgba(255, 255, 255, 0.7));
                        border: 1px solid var(--mp-border, rgba(226, 232, 240, 0.85));
                        border-radius: 12px;
                        overflow: hidden;
                    }

                    .memory-header {
                        display: flex;
                        align-items: center;
                        gap: 12px;
                        padding: 12px 14px;
                        border-bottom: 1px solid var(--mp-border, rgba(226, 232, 240, 0.85));
                        background: var(--mp-header-bg, rgba(248, 250, 252, 0.82));
                    }

                    .memory-tabs {
                        display: inline-flex;
                        min-width: 0;
                        padding: 3px;
                        gap: 2px;
                        border-radius: 10px;
                        background: var(--mp-tab-bg, rgba(15, 23, 42, 0.05));
                    }

                    .memory-tab {
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        min-height: 30px;
                        padding: 0 13px;
                        border: 0;
                        border-radius: 8px;
                        background: transparent;
                        color: var(--mp-tab-color, rgba(15, 23, 42, 0.56));
                        font: inherit;
                        font-size: 12px;
                        font-weight: 500;
                        line-height: 1;
                        cursor: pointer;
                        white-space: nowrap;
                        transition:
                            color 0.18s ease,
                            background 0.18s ease,
                            box-shadow 0.18s ease;
                    }

                    .memory-tab:hover {
                        color: var(--mp-tab-hover-color, rgba(15, 23, 42, 0.78));
                    }

                    .memory-tab:focus-visible,
                    .icon-button:focus-visible {
                        outline: 2px solid var(--od-accent, #3b82f6);
                        outline-offset: 2px;
                    }

                    .memory-tab.active {
                        color: var(--mp-tab-active-color, #111827);
                        background: var(--mp-tab-active-bg, #ffffff);
                        box-shadow: var(--mp-tab-active-shadow, 0 1px 3px rgba(15, 23, 42, 0.09));
                    }

                    .header-actions {
                        margin-left: auto;
                        display: flex;
                        align-items: center;
                    }

                    .icon-button {
                        width: 30px;
                        height: 30px;
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        border: 1px solid var(--mp-button-border, rgba(148, 163, 184, 0.35));
                        border-radius: 8px;
                        background: var(--mp-button-bg, rgba(255, 255, 255, 0.72));
                        color: var(--mp-muted, #64748b);
                        cursor: pointer;
                        font: inherit;
                        font-size: 15px;
                        line-height: 1;
                    }

                    .icon-button:hover {
                        background: var(--mp-button-hover-bg, #ffffff);
                        color: var(--mp-text, #0f172a);
                    }

                    .memory-body {
                        flex: 1;
                        min-height: 0;
                        overflow: auto;
                        padding: 18px;
                    }

                    .memory-body::-webkit-scrollbar {
                        width: 6px;
                    }

                    .memory-body::-webkit-scrollbar-track {
                        background: transparent;
                    }

                    .memory-body::-webkit-scrollbar-thumb {
                        background: var(--mp-scrollbar, rgba(100, 116, 139, 0.28));
                        border-radius: 3px;
                    }

                    .state {
                        min-height: 260px;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        gap: 8px;
                        text-align: center;
                        color: var(--mp-muted, #64748b);
                    }

                    .state-title {
                        color: var(--mp-text, #0f172a);
                        font-size: 14px;
                        font-weight: 600;
                    }

                    .state-detail {
                        max-width: 460px;
                        color: var(--mp-muted, #64748b);
                        font-size: 12px;
                        line-height: 1.6;
                    }

                    .state.error .state-title {
                        color: var(--mp-error, #dc2626);
                    }

                    .facts-list {
                        max-width: 980px;
                        margin: 0 auto;
                        border: 1px solid var(--mp-border, rgba(226, 232, 240, 0.85));
                        border-radius: 8px;
                        overflow: hidden;
                        background: var(--mp-list-bg, rgba(255, 255, 255, 0.42));
                    }

                    .memory-row {
                        display: grid;
                        gap: 8px;
                        padding: 14px 16px;
                        border-bottom: 1px solid var(--mp-border, rgba(226, 232, 240, 0.85));
                    }

                    .memory-row:last-child {
                        border-bottom: 0;
                    }

                    .memory-row-header {
                        display: flex;
                        align-items: flex-start;
                        justify-content: space-between;
                        gap: 12px;
                        min-width: 0;
                    }

                    .memory-row h3 {
                        margin: 0;
                        min-width: 0;
                        color: var(--mp-text, #0f172a);
                        font-size: 14px;
                        line-height: 1.35;
                        font-weight: 600;
                        overflow-wrap: anywhere;
                    }

                    .memory-meta {
                        flex: none;
                        display: inline-flex;
                        align-items: center;
                        gap: 8px;
                        color: var(--mp-muted, #64748b);
                        font-size: 11px;
                        line-height: 1;
                        white-space: nowrap;
                    }

                    .scope-pill {
                        display: inline-flex;
                        align-items: center;
                        min-height: 20px;
                        padding: 0 8px;
                        border-radius: 999px;
                        font-weight: 600;
                    }

                    .scope-pill.workspace {
                        color: var(--mp-workspace-pill-text, #0369a1);
                        background: var(--mp-workspace-pill-bg, rgba(14, 165, 233, 0.12));
                    }

                    .scope-pill.global {
                        color: var(--mp-global-pill-text, #047857);
                        background: var(--mp-global-pill-bg, rgba(16, 185, 129, 0.12));
                    }

                    .memory-content {
                        color: var(--mp-text, #0f172a);
                        font-size: 13px;
                        line-height: 1.6;
                        white-space: pre-wrap;
                        overflow-wrap: anywhere;
                    }

                    .memory-uid {
                        color: var(--mp-muted, #64748b);
                        font-family:
                            ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New",
                            monospace;
                        font-size: 11px;
                    }

                    .spinner {
                        width: 20px;
                        height: 20px;
                        border: 2px solid var(--mp-spinner-track, rgba(148, 163, 184, 0.25));
                        border-top-color: var(--od-accent, #3b82f6);
                        border-radius: 999px;
                        animation: spin 0.85s linear infinite;
                    }

                    @keyframes spin {
                        to {
                            transform: rotate(360deg);
                        }
                    }

                    .markdown-body {
                        box-sizing: border-box;
                        max-width: 860px;
                        margin: 0 auto;
                        padding: 0;
                        background: transparent;
                        color: var(--mp-text, #0f172a);
                        font-size: 14px;
                        line-height: 1.68;
                    }

                    .markdown-body :first-child {
                        margin-top: 0;
                    }

                    .markdown-body :last-child {
                        margin-bottom: 0;
                    }

                    .markdown-body pre,
                    .markdown-body table {
                        max-width: 100%;
                        overflow: auto;
                    }

                    :host-context(html[data-theme='dark']) {
                        --mp-bg: rgba(20, 20, 23, 0.72);
                        --mp-header-bg: rgba(31, 31, 35, 0.82);
                        --mp-border: rgba(255, 255, 255, 0.1);
                        --mp-text: var(--od-text, #f5f5f7);
                        --mp-muted: var(--od-text-muted, #a1a1aa);
                        --mp-tab-bg: rgba(255, 255, 255, 0.08);
                        --mp-tab-color: var(--od-text-muted, #a1a1aa);
                        --mp-tab-hover-color: var(--od-text, #f5f5f7);
                        --mp-tab-active-color: var(--od-text, #f5f5f7);
                        --mp-tab-active-bg: rgba(255, 255, 255, 0.14);
                        --mp-tab-active-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08), 0 1px 4px rgba(0, 0, 0, 0.35);
                        --mp-button-bg: rgba(255, 255, 255, 0.08);
                        --mp-button-hover-bg: rgba(255, 255, 255, 0.14);
                        --mp-button-border: rgba(255, 255, 255, 0.12);
                        --mp-scrollbar: rgba(255, 255, 255, 0.22);
                        --mp-spinner-track: rgba(255, 255, 255, 0.16);
                        --mp-error: #f87171;
                        --mp-list-bg: rgba(255, 255, 255, 0.04);
                        --mp-workspace-pill-text: #7dd3fc;
                        --mp-workspace-pill-bg: rgba(14, 165, 233, 0.16);
                        --mp-global-pill-text: #86efac;
                        --mp-global-pill-bg: rgba(34, 197, 94, 0.14);
                    }

                    :host-context(html[data-theme='dark']) .markdown-body {
                        color: var(--mp-text);
                    }

                    :host-context(html[data-theme='dark']) .markdown-body a {
                        color: #7db7ff;
                    }

                    :host-context(html[data-theme='dark']) .markdown-body blockquote {
                        color: var(--mp-muted);
                        border-left-color: rgba(255, 255, 255, 0.18);
                    }

                    :host-context(html[data-theme='dark']) .markdown-body hr {
                        background: rgba(255, 255, 255, 0.14);
                    }

                    :host-context(html[data-theme='dark']) .markdown-body code,
                    :host-context(html[data-theme='dark']) .markdown-body tt {
                        background: rgba(255, 255, 255, 0.1);
                    }

                    :host-context(html[data-theme='dark']) .markdown-body pre {
                        background: rgba(255, 255, 255, 0.08);
                    }

                    :host-context(html[data-theme='dark']) .markdown-body table tr {
                        background: transparent;
                        border-top-color: rgba(255, 255, 255, 0.14);
                    }

                    :host-context(html[data-theme='dark']) .markdown-body table tr:nth-child(2n) {
                        background: rgba(255, 255, 255, 0.05);
                    }

                    :host-context(html[data-theme='dark']) .markdown-body table th,
                    :host-context(html[data-theme='dark']) .markdown-body table td {
                        border-color: rgba(255, 255, 255, 0.14);
                    }

                    @media (max-width: 640px) {
                        .memory-header {
                            align-items: stretch;
                            flex-direction: column;
                        }

                        .header-actions {
                            margin-left: 0;
                        }

                        .memory-tabs {
                            width: 100%;
                        }

                        .memory-tab {
                            flex: 1;
                        }

                        .memory-row-header {
                            flex-direction: column;
                        }

                        .memory-meta {
                            flex-wrap: wrap;
                            white-space: normal;
                        }
                    }
                </style>
                <div class="memory-panel">
                    <div class="memory-header">
                        <div class="memory-tabs" role="tablist" aria-label="${escapeHtml(this.t('renderer.memory.system'))}">
                            ${this.renderTabButton('portrait', this.t('renderer.memory.userPortrait'))}
                            ${this.renderTabButton('facts', this.t('renderer.memory.facts'))}
                        </div>
                        <div class="header-actions">
                            <button class="icon-button" data-action="refresh" type="button" title="${escapeHtml(this.t('renderer.memory.refresh'))}" aria-label="${escapeHtml(this.t('renderer.memory.refresh'))}">↻</button>
                        </div>
                    </div>
                    <div class="memory-body">
                        ${body}
                    </div>
                </div>
            `;
            this.bindEvents();
        });
    }
}

customElements.define('memory-panel', MemoryPanel);
