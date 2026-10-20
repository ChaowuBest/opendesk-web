/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { parse as parseYaml } from 'yaml';
import recommendationYaml from '../../../resources/main/applications/recommendation.yaml?raw';
import recommendationCss from '../styles/recommendation.css?raw';
import { CHEVRON_RIGHT_SVG } from '../../common/ui-icons.js';
import { resolveRendererLocale, createRendererTranslator } from '../locale.js';

let t = createRendererTranslator();

// ============================================================================
// Data Interfaces
// ============================================================================

export interface RecommendationItem {
    /** 唯一标识 */
    id: string;
    /** 显示标题 */
    title: string;
    /** 简短描述 */
    description: string;
    /** 点击后填入输入框的 prompt */
    prompt: string;
    /** FontAwesome 图标类名或内联 SVG 字符串 */
    icon?: string;
}

export interface RecommendationCategory {
    /** 唯一标识 */
    id: string;
    /** Tab 显示名称 */
    label: string;
    /** FontAwesome 图标类名或内联 SVG 字符串 */
    icon: string;
    /** 该分类下的推荐项 */
    items: RecommendationItem[];
}

export interface RecommendationData {
    categories: RecommendationCategory[];
}

type SearchMatchType = 'keyword' | 'name_semantic' | 'content_semantic';

type IndexedFileSearchItem = {
    path: string;
    filename: string;
    modified: number;
    size: number;
    snippet: string | null;
    matchTypes: SearchMatchType[];
    score: number;
};

type SearchTabState = {
    query: string;
    results: IndexedFileSearchItem[];
    loading: boolean;
    loadingText?: string | null;
    warning?: string | null;
    error?: string | null;
};

// ============================================================================
// Data Loading
// ============================================================================

type LocalizedRecommendationItem = RecommendationItem & {
    title_en?: string;
    description_en?: string;
    prompt_en?: string;
};

type LocalizedRecommendationCategory = Omit<RecommendationCategory, 'items'> & {
    label_en?: string;
    items: LocalizedRecommendationItem[];
};

function loadRecommendationData(raw: string, locale = resolveRendererLocale()): RecommendationData {
    const parsed = parseYaml(raw);
    const categories: RecommendationCategory[] = [];
    if (Array.isArray(parsed)) {
        for (const cat of parsed) {
            if (cat && cat.id && cat.label && Array.isArray(cat.items)) {
                const localizedCategory = cat as LocalizedRecommendationCategory;
                const useEnglish = locale === 'en-US';
                categories.push({
                    id: localizedCategory.id,
                    label: useEnglish ? localizedCategory.label_en || localizedCategory.label : localizedCategory.label,
                    icon: localizedCategory.icon,
                    items: localizedCategory.items.map((item) => ({
                        id: item.id,
                        title: useEnglish ? item.title_en || item.title : item.title,
                        description: useEnglish ? item.description_en || item.description : item.description,
                        prompt: useEnglish ? item.prompt_en || item.prompt : item.prompt,
                        icon: item.icon
                    }))
                });
            }
        }
    }
    return { categories };
}

const DEFAULT_RECOMMENDATION_DATA = loadRecommendationData(recommendationYaml);

// ============================================================================
// RecommendationPanel Component
// ============================================================================

class RecommendationPanel extends HTMLElement {
    private _data: RecommendationData = DEFAULT_RECOMMENDATION_DATA;
    private _usingDefaultData = true;
    private _activeCategoryId: string = '';
    private _temporarySearch: SearchTabState | null = null;
    private _previousActiveCategoryId: string | null = null;
    private _userLeftSearchTabExplicitly = false;
    private _settingUnsubscribe?: () => void;

    constructor() {
        super();
    }

    connectedCallback(): void {
        if (this._data.categories.length > 0) {
            this._activeCategoryId = this._data.categories[0].id;
        }
        this.render();
        void window.settingAPI
            ?.loadSettingObject?.()
            .then((setting) => this._applyDefaultLocale(resolveRendererLocale(setting)))
            .catch(() => undefined);
        this._settingUnsubscribe = window.settingAPI?.onSettingChanged?.((setting) => {
            this._applyDefaultLocale(resolveRendererLocale(setting));
        });
    }

    disconnectedCallback(): void {
        this._settingUnsubscribe?.();
        this._settingUnsubscribe = undefined;
    }

    setData(data: RecommendationData): void {
        this._usingDefaultData = false;
        this._data = data;
        if (this._temporarySearch && this._activeCategoryId === 'search-results') {
            this.render();
            return;
        }
        if (data.categories.length > 0 && !data.categories.find((c) => c.id === this._activeCategoryId)) {
            this._activeCategoryId = data.categories[0].id;
        }
        this.render();
    }

    private _applyDefaultLocale(locale: string): void {
        if (!this._usingDefaultData) return;
        t = createRendererTranslator(locale);
        this._data = loadRecommendationData(recommendationYaml, locale);
        if (
            this._activeCategoryId !== 'search-results' &&
            !this._data.categories.some((category) => category.id === this._activeCategoryId)
        ) {
            this._activeCategoryId = this._data.categories[0]?.id || '';
        }
        this.render();
    }

    showSearchTab(initialState: Partial<SearchTabState> = {}): void {
        if (!this._temporarySearch) {
            this._previousActiveCategoryId = this._activeCategoryId || this._data.categories[0]?.id || null;
            this._userLeftSearchTabExplicitly = false;
        }
        this._temporarySearch = {
            query: '',
            results: [],
            loading: false,
            warning: null,
            error: null,
            ...initialState
        };
        if (!this._userLeftSearchTabExplicitly) {
            this._activeCategoryId = 'search-results';
        }
        this.render();
    }

    updateSearchTab(state: SearchTabState): void {
        if (!this._temporarySearch) return;
        this._temporarySearch = state;
        if (!this._userLeftSearchTabExplicitly && this._activeCategoryId !== 'search-results') {
            this._activeCategoryId = 'search-results';
            this.render();
            return;
        }
        if (this._activeCategoryId === 'search-results') {
            this._renderItems();
        }
    }

    hideSearchTab(): void {
        if (!this._temporarySearch) return;
        const restoreId = this._previousActiveCategoryId ?? this._data.categories[0]?.id ?? '';
        this._temporarySearch = null;
        this._previousActiveCategoryId = null;
        this._userLeftSearchTabExplicitly = false;
        this._activeCategoryId = restoreId;
        this.render();
    }

    private _switchCategory(categoryId: string, { userInitiated = false } = {}): void {
        if (this._activeCategoryId === categoryId) return;
        if (userInitiated && this._activeCategoryId === 'search-results' && categoryId !== 'search-results') {
            this._userLeftSearchTabExplicitly = true;
        }
        this._activeCategoryId = categoryId;

        this.querySelectorAll<HTMLElement>('.rec-nav-btn').forEach((btn) => {
            btn.classList.toggle('rec-nav-btn-active', btn.dataset.categoryId === categoryId);
        });

        this._renderItems();
    }

    private _renderItems(): void {
        const contentContainer = this.querySelector<HTMLElement>('.rec-scroll');
        if (!contentContainer) return;

        if (this._activeCategoryId === 'search-results' && this._temporarySearch) {
            this._renderSearchItems(contentContainer, this._temporarySearch);
            return;
        }

        const category = this._data.categories.find((c) => c.id === this._activeCategoryId);
        if (!category) {
            contentContainer.innerHTML = '';
            return;
        }

        let html = '';

        // Hero card - only for 为你推荐
        if (category.id === 'recommend' && category.items.length > 0) {
            const hero = category.items[0];
            html += `
                <div class="rec-hero" data-item-id="${this._escapeAttr(hero.id)}">
                    <div class="rec-hero-head">
                        <span class="rec-hero-tag">${t('renderer.recommendation.heroTag')}</span>
                        <span class="rec-hero-title">${this._escapeHtml(hero.title)}</span>
                    </div>
                    <div class="rec-hero-desc">${this._escapeHtml(hero.description)}</div>
                    <div class="rec-hero-prompt"><span class="rec-hero-prompt-prefix">${t('renderer.recommendation.example')} · </span>${this._escapeHtml(hero.prompt)}</div>
                </div>
            `;
        }

        // Prompt list
        const listItems = category.id === 'recommend' ? category.items.slice(1) : category.items;
        if (listItems.length > 0) {
            html += '<div class="rec-list">';
            html += listItems
                .map(
                    (item) => `
                <button type="button" class="rec-row" data-item-id="${this._escapeAttr(item.id)}" title="${this._escapeAttr(item.prompt)}">
                    <span class="rec-row-arrow">${CHEVRON_RIGHT_SVG}</span>
                    <span class="rec-row-text">${this._escapeHtml(item.prompt)}</span>
                    <span class="rec-row-hint">${t('renderer.recommendation.fillInput')}</span>
                </button>
            `
                )
                .join('');
            html += '</div>';
        }

        contentContainer.innerHTML = html;
        this._bindItemEvents();
    }

    private _renderSearchItems(container: HTMLElement, state: SearchTabState): void {
        const query = state.query.trim();
        const rows = state.results ?? [];
        const statusRows = [
            state.warning ? `<div class="search-note">${this._escapeHtml(state.warning)}</div>` : '',
            state.error ? `<div class="search-error">${this._escapeHtml(state.error)}</div>` : '',
            state.loading
                ? `<div class="search-loading">${this._escapeHtml(state.loadingText ?? t('renderer.recommendation.searching'))}</div>`
                : ''
        ].join('');

        let body = '';
        if (!query && rows.length === 0) {
            body = `<div class="search-empty">${t('renderer.recommendation.searchPlaceholder')}</div>`;
        } else if (!state.loading && rows.length === 0) {
            body = `<div class="search-empty">${t('renderer.recommendation.noResults')}</div>`;
        } else {
            body = rows.map((item) => this._renderSearchResult(item)).join('');
        }

        container.innerHTML = `<div class="search-results-list">${statusRows}${body}</div>`;
        container.querySelectorAll<HTMLButtonElement>('.search-attach-btn').forEach((button) => {
            button.addEventListener('click', () => {
                this.dispatchEvent(
                    new CustomEvent('homepage-search-attach', {
                        detail: { path: button.dataset.path },
                        bubbles: true
                    })
                );
            });
        });
        container.querySelectorAll<HTMLButtonElement>('.search-open-btn').forEach((button) => {
            button.addEventListener('click', () => {
                this.dispatchEvent(
                    new CustomEvent('homepage-search-open', {
                        detail: { path: button.dataset.path },
                        bubbles: true
                    })
                );
            });
        });
        container.querySelectorAll<HTMLButtonElement>('.search-reveal-btn').forEach((button) => {
            button.addEventListener('click', () => {
                this.dispatchEvent(
                    new CustomEvent('homepage-search-reveal', {
                        detail: { path: button.dataset.path },
                        bubbles: true
                    })
                );
            });
        });
    }

    private _renderSearchResult(item: IndexedFileSearchItem): string {
        const badgeLabels = new Set<string>();
        for (const type of item.matchTypes ?? []) {
            if (type === 'keyword' || type === 'name_semantic')
                badgeLabels.add(t('renderer.recommendation.badge.filename'));
            if (type === 'content_semantic') badgeLabels.add(t('renderer.recommendation.badge.content'));
        }
        const badges = [...badgeLabels].map((label) => `<span class="search-badge">${label}</span>`).join('');
        const attachAction = `
                    <button type="button" class="search-attach-btn" data-path="${this._escapeAttr(item.path)}" title="${t('renderer.recommendation.attachToChat')}" aria-label="${t('renderer.recommendation.attachToChat')}">
                        <i class="fas fa-paperclip"></i>
                    </button>
        `;
        const localPathActions = `
                    <button type="button" class="search-open-btn" data-path="${this._escapeAttr(item.path)}" title="${t('renderer.recommendation.openFile')}" aria-label="${t('renderer.recommendation.openFile')}">
                        <i class="fas fa-arrow-up-right-from-square"></i>
                    </button>
                    <button type="button" class="search-reveal-btn" data-path="${this._escapeAttr(item.path)}" title="${t('renderer.recommendation.revealInFolder')}" aria-label="${t('renderer.recommendation.revealInFolder')}">
                        <i class="fas fa-folder-open"></i>
                    </button>
            `;
        return `
            <div class="search-result">
                <span class="search-file-icon"><i class="fas fa-file-lines"></i></span>
                <span class="search-file-content">
                    <span class="search-file-title">${this._escapeHtml(item.filename)}</span>
                    <span class="search-file-path" title="${this._escapeAttr(item.path)}">${this._escapeHtml(item.path)}</span>
                    ${item.snippet ? `<span class="search-snippet">${this._escapeHtml(item.snippet)}</span>` : ''}
                    <span class="search-meta">${this._formatFileSize(item.size)} · ${this._formatDate(item.modified)} ${badges}</span>
                </span>
                <span class="search-actions">
                    ${attachAction}${localPathActions}
                </span>
            </div>
        `;
    }

    private _formatFileSize(size: number): string {
        if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
        if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${size ?? 0} B`;
    }

    private _formatDate(value: number): string {
        if (!value) return '';
        return new Date(value).toLocaleDateString();
    }

    private _bindItemEvents(): void {
        // Hero card click
        const hero = this.querySelector<HTMLElement>('.rec-hero');
        hero?.addEventListener('click', () => {
            const itemId = hero.dataset.itemId;
            if (!itemId) return;
            const category = this._data.categories.find((c) => c.id === this._activeCategoryId);
            const item = category?.items.find((i) => i.id === itemId);
            if (!item) return;
            this.dispatchEvent(
                new CustomEvent('select', {
                    detail: { item },
                    bubbles: true
                })
            );
        });

        // Prompt row click
        this.querySelectorAll<HTMLElement>('.rec-row').forEach((el) => {
            el.addEventListener('click', () => {
                const itemId = el.dataset.itemId;
                if (!itemId) return;
                const category = this._data.categories.find((c) => c.id === this._activeCategoryId);
                const item = category?.items.find((i) => i.id === itemId);
                if (!item) return;
                this.dispatchEvent(
                    new CustomEvent('select', {
                        detail: { item },
                        bubbles: true
                    })
                );
            });
        });
    }

    private _escapeHtml(str: string): string {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    private _escapeAttr(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    private render(): void {
        const categories = this._temporarySearch
            ? [
                  ...this._data.categories,
                  {
                      id: 'search-results',
                      label: t('renderer.recommendation.searchResults'),
                      icon: '<svg viewBox="0 0 40 40" fill="none"><circle cx="17" cy="17" r="11" stroke="currentColor" stroke-width="2.5"/><line x1="25" y1="25" x2="34" y2="34" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
                      items: []
                  }
              ]
            : this._data.categories;

        const navHTML = categories
            .map((cat) => {
                const isActive = cat.id === this._activeCategoryId;
                const iconHtml = cat.icon.startsWith('<svg') ? cat.icon : `<i class="fas ${cat.icon}"></i>`;
                return `<button type="button" role="tab" aria-selected="${isActive ? 'true' : 'false'}" class="rec-nav-btn ${isActive ? 'rec-nav-btn-active' : ''}" data-category-id="${cat.id}">
                    ${iconHtml}
                    <span>${this._escapeHtml(cat.label)}</span>
                </button>`;
            })
            .join('');

        this.innerHTML = `
        <style>${recommendationCss}</style>

        <div class="rec-panel ${this._temporarySearch ? 'rec-panel-search' : ''}">
            <nav class="rec-nav">${navHTML}</nav>
            <div class="rec-content"><div class="rec-scroll"></div></div>
        </div>
        `;

        this._renderItems();

        this.querySelectorAll<HTMLElement>('.rec-nav-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.categoryId;
                if (id) this._switchCategory(id, { userInitiated: true });
            });
        });
    }
}

if (!customElements.get('recommendation-panel')) {
    customElements.define('recommendation-panel', RecommendationPanel);
}

export type { RecommendationPanel };
