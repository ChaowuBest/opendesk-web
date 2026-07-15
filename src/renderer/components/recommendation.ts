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
    /** FontAwesome 图标类名（不含 fas/far 前缀） */
    icon?: string;
}

export interface RecommendationCategory {
    /** 唯一标识 */
    id: string;
    /** Tab 显示名称 */
    label: string;
    /** FontAwesome 图标类名 */
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
// Default Data
// ============================================================================

const DEFAULT_RECOMMENDATION_DATA: RecommendationData = {
    categories: [
        {
            id: 'recommend',
            label: '为你推荐',
            icon: 'fa-wand-magic-sparkles',
            items: [
                {
                    id: 'technical-survey',
                    title: '技术调研',
                    description: '根据你指定的技术主题，进行详细的搜索，生成一份调研报告',
                    prompt: '请帮我做一份技术调研报告。我会告诉你技术主题和目标，请帮我搜索相关资料，整理成一份结构化的调研报告，包含背景、现状、趋势和参考资料。',
                    icon: 'fa-file-lines'
                },
                {
                    id: 'weekly-summary',
                    title: '周报总结',
                    description: '汇总本周工作成果，整理为周报格式',
                    prompt: '请帮我汇总本周的工作成果，整理成一份周报。需要包含本周完成事项、下周计划和需要协调的问题。',
                    icon: 'fa-calendar-week'
                },
                {
                    id: 'meeting-notes',
                    title: '会议纪要',
                    description: '将会议内容整理为结构化的纪要文档',
                    prompt: '请帮我整理一份会议纪要。我会告诉你会议的主要讨论内容，请整理成包含会议议题、讨论要点、决议事项和待办事项的结构化文档。',
                    icon: 'fa-users'
                },
                {
                    id: 'email-draft',
                    title: '邮件撰写',
                    description: '根据要点快速生成一封得体的邮件',
                    prompt: '请帮我撰写一封邮件。我会告诉你邮件的对象、目的和要点，请帮我生成一封语言得体、格式规范的邮件。',
                    icon: 'fa-envelope'
                }
            ]
        },
        {
            id: 'writing',
            label: '文案构思',
            icon: 'fa-pen-fancy',
            items: [
                {
                    id: 'article-outline',
                    title: '文章大纲',
                    description: '为指定主题生成结构化的文章大纲',
                    prompt: '请帮我为一篇文章生成结构化大纲。我会告诉你主题和目标读者，请给出一级、二级标题和每节的要点。',
                    icon: 'fa-list-ol'
                },
                {
                    id: 'social-media',
                    title: '社交媒体文案',
                    description: '为各平台撰写吸引眼球的推广文案',
                    prompt: '请帮我写一段社交媒体推广文案。我会告诉你产品/活动信息和目标平台，请生成吸引人的文案。',
                    icon: 'fa-share-nodes'
                },
                {
                    id: 'product-desc',
                    title: '产品描述',
                    description: '为产品撰写专业且有吸引力的描述文案',
                    prompt: '请帮我撰写一段产品描述文案。我会提供产品信息和卖点，请生成专业且有吸引力的描述。',
                    icon: 'fa-tag'
                },
                {
                    id: 'slogan',
                    title: '品牌标语',
                    description: '创作朗朗上口的品牌口号和标语',
                    prompt: '请帮我创作几个品牌标语/口号。我会告诉你品牌定位和核心价值观，请生成朗朗上口、有记忆点的标语。',
                    icon: 'fa-bullhorn'
                }
            ]
        },
        {
            id: 'analysis',
            label: '分析研究',
            icon: 'fa-chart-line',
            items: [
                {
                    id: 'data-analysis',
                    title: '数据分析',
                    description: '对数据进行分析并给出可视化建议',
                    prompt: '请帮我分析一组数据。我会提供数据内容，请帮我找出其中的趋势、异常和关键结论，并给出可视化建议。',
                    icon: 'fa-chart-bar'
                },
                {
                    id: 'competitor',
                    title: '竞品分析',
                    description: '对竞品进行多维度对比分析',
                    prompt: '请帮我做一份竞品分析。我会列出我们的产品和竞品，请从功能、定价、用户体验等维度进行对比分析。',
                    icon: 'fa-scale-balanced'
                },
                {
                    id: 'market-research',
                    title: '行业调研',
                    description: '收集整理某个行业的发展现状和趋势',
                    prompt: '请帮我做一份行业调研报告。我会告诉你关注的行业，请整理出行业现状、主要玩家、市场规模和发展趋势。',
                    icon: 'fa-magnifying-glass-chart'
                },
                {
                    id: 'key-points',
                    title: '提取要点',
                    description: '帮我提取文件里的关键数据和核心结论',
                    prompt: '请帮我提取这份文件里的关键数据和核心结论，以结构化的方式呈现。',
                    icon: 'fa-highlighter'
                }
            ]
        },
        {
            id: 'project',
            label: '项目管理',
            icon: 'fa-diagram-project',
            items: [
                {
                    id: 'project-plan',
                    title: '项目排期',
                    description: '做一份项目排期甘特图表格，按阶段标注负责人和截止日',
                    prompt: '请帮我做一份项目排期计划。我会描述项目的阶段和人员情况，请按阶段标注负责人和截止日期，输出甘特图式的排期表。',
                    icon: 'fa-calendar-days'
                },
                {
                    id: 'requirement-doc',
                    title: '需求文档',
                    description: '写一份产品需求文档模板，含功能描述和验收标准',
                    prompt: '请帮我写一份产品需求文档(PRD)。我会描述功能需求，请生成包含功能描述、用户故事、验收标准和优先级的完整文档模板。',
                    icon: 'fa-file-contract'
                },
                {
                    id: 'risk-assessment',
                    title: '风险评估',
                    description: '识别项目潜在风险并制定应对策略',
                    prompt: '请帮我做一份项目风险评估。我会描述项目概况，请识别潜在风险并给出风险等级、影响范围和应对策略。',
                    icon: 'fa-triangle-exclamation'
                },
                {
                    id: 'retrospective',
                    title: '复盘模板',
                    description: '生成项目/迭代复盘的结构化模板',
                    prompt: '请帮我做一次项目复盘。我会描述项目情况，请从做得好的、需要改进的、行动项三个维度进行分析。',
                    icon: 'fa-rotate-left'
                }
            ]
        },
        {
            id: 'efficiency',
            label: '效率工具',
            icon: 'fa-bolt',
            items: [
                {
                    id: 'translate',
                    title: '翻译润色',
                    description: '多语言翻译并进行本地化润色',
                    prompt: '请帮我翻译并润色以下内容。我会提供原文和目标语言，请给出既准确又地道的翻译。',
                    icon: 'fa-language'
                },
                {
                    id: 'formula',
                    title: '公式助手',
                    description: '帮你编写 Excel / WPS 公式和函数',
                    prompt: '请帮我编写一个 Excel 公式。我会描述我的需求和数据位置，请给出对应的公式并解释其工作原理。',
                    icon: 'fa-square-root-variable'
                },
                {
                    id: 'regex',
                    title: '正则表达式',
                    description: '根据需求编写和解释正则表达式',
                    prompt: '请帮我编写一个正则表达式。我会描述我想匹配的文本模式，请给出正则表达式并附上示例和解释。',
                    icon: 'fa-code'
                },
                {
                    id: 'brainstorm',
                    title: '头脑风暴',
                    description: '针对某个主题进行发散性思维和创意碰撞',
                    prompt: '请帮我进行一场头脑风暴。我会告诉你主题和背景，请从多个角度给出创意和想法。',
                    icon: 'fa-lightbulb'
                }
            ]
        }
    ]
};

// ============================================================================
// RecommendationPanel Component
// ============================================================================

class RecommendationPanel extends HTMLElement {
    private _data: RecommendationData = DEFAULT_RECOMMENDATION_DATA;
    private _activeCategoryId: string = '';
    private _temporarySearch: SearchTabState | null = null;
    private _previousActiveCategoryId: string | null = null;
    private _userLeftSearchTabExplicitly = false;

    constructor() {
        super();
    }

    connectedCallback(): void {
        if (this._data.categories.length > 0) {
            this._activeCategoryId = this._data.categories[0].id;
        }
        this.render();
    }

    disconnectedCallback(): void {}

    /**
     * 允许外部传入自定义数据
     */
    setData(data: RecommendationData): void {
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
        const previousCategoryId = this._activeCategoryId;
        if (userInitiated && this._activeCategoryId === 'search-results' && categoryId !== 'search-results') {
            this._userLeftSearchTabExplicitly = true;
        }
        this._activeCategoryId = categoryId;

        this.querySelectorAll<HTMLElement>('.rec-tab').forEach((tab) => {
            tab.classList.toggle('rec-tab-active', tab.dataset.categoryId === categoryId);
        });

        const listContainer = this.querySelector<HTMLElement>('.rec-items-container');
        if (listContainer) {
            const searchTabInvolved = categoryId === 'search-results' || previousCategoryId === 'search-results';
            if (searchTabInvolved) {
                this._renderItems();
                listContainer.classList.add('rec-items-enter');
                setTimeout(() => listContainer.classList.remove('rec-items-enter'), 300);
                return;
            }

            listContainer.classList.add('rec-items-exit');
            setTimeout(() => {
                this._renderItems();
                listContainer.classList.remove('rec-items-exit');
                listContainer.classList.add('rec-items-enter');
                setTimeout(() => listContainer.classList.remove('rec-items-enter'), 300);
            }, 150);
        }
    }

    private _renderItems(): void {
        const listContainer = this.querySelector<HTMLElement>('.rec-items-container');
        if (!listContainer) return;

        const category = this._data.categories.find((c) => c.id === this._activeCategoryId);
        if (this._activeCategoryId === 'search-results' && this._temporarySearch) {
            this._renderSearchItems(listContainer, this._temporarySearch);
            return;
        }
        if (!category) {
            listContainer.innerHTML = '';
            return;
        }

        listContainer.innerHTML = category.items
            .map(
                (item) => `
            <button type="button" class="rec-item" data-item-id="${item.id}" title="${this._escapeAttr(item.prompt)}">
                <span class="rec-item-icon">
                    <i class="fas ${item.icon || 'fa-sparkles'}"></i>
                </span>
                <span class="rec-item-content">
                    <span class="rec-item-title">${this._escapeHtml(item.title)}</span>
                    <span class="rec-item-desc">${this._escapeHtml(item.description)}</span>
                </span>
                <span class="rec-item-arrow">
                    <i class="fas fa-chevron-right"></i>
                </span>
            </button>
        `
            )
            .join('');

        this._bindItemEvents();
    }

    private _renderSearchItems(listContainer: HTMLElement, state: SearchTabState): void {
        const query = state.query.trim();
        const rows = state.results ?? [];
        const statusRows = [
            state.warning ? `<div class="search-note">${this._escapeHtml(state.warning)}</div>` : '',
            state.error ? `<div class="search-error">${this._escapeHtml(state.error)}</div>` : '',
            state.loading
                ? `<div class="search-loading">${this._escapeHtml(state.loadingText ?? '正在搜索...')}</div>`
                : ''
        ].join('');

        let body = '';
        if (!query && rows.length === 0) {
            body = '<div class="search-empty">输入关键词搜索你的文件</div>';
        } else if (!state.loading && rows.length === 0) {
            body = '<div class="search-empty">没有找到匹配文件</div>';
        } else {
            body = rows.map((item) => this._renderSearchResult(item)).join('');
        }

        listContainer.innerHTML = `<div class="search-results-list">${statusRows}${body}</div>`;
        listContainer.querySelectorAll<HTMLButtonElement>('.search-attach-btn').forEach((button) => {
            button.addEventListener('click', () => {
                this.dispatchEvent(
                    new CustomEvent('homepage-search-attach', {
                        detail: { path: button.dataset.path },
                        bubbles: true
                    })
                );
            });
        });
        listContainer.querySelectorAll<HTMLButtonElement>('.search-open-btn').forEach((button) => {
            button.addEventListener('click', () => {
                this.dispatchEvent(
                    new CustomEvent('homepage-search-open', {
                        detail: { path: button.dataset.path },
                        bubbles: true
                    })
                );
            });
        });
        listContainer.querySelectorAll<HTMLButtonElement>('.search-reveal-btn').forEach((button) => {
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
            if (type === 'keyword' || type === 'name_semantic') badgeLabels.add('文件名');
            if (type === 'content_semantic') badgeLabels.add('内容');
        }
        const badges = [...badgeLabels].map((label) => `<span class="search-badge">${label}</span>`).join('');
        const attachAction = `
                    <button type="button" class="search-attach-btn" data-path="${this._escapeAttr(item.path)}" title="添加到对话栏" aria-label="添加到对话栏">
                        <i class="fas fa-paperclip"></i>
                    </button>
        `;
        const localPathActions = `
                    <button type="button" class="search-open-btn" data-path="${this._escapeAttr(item.path)}" title="打开文件" aria-label="打开文件">
                        <i class="fas fa-arrow-up-right-from-square"></i>
                    </button>
                    <button type="button" class="search-reveal-btn" data-path="${this._escapeAttr(item.path)}" title="在文件夹中显示" aria-label="在文件夹中显示">
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
        this.querySelectorAll<HTMLElement>('.rec-item').forEach((el) => {
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
                  { id: 'search-results', label: '搜索结果', icon: 'fa-magnifying-glass', items: [] }
              ]
            : this._data.categories;
        const tabsHTML = categories
            .map((cat) => {
                const isActive = cat.id === this._activeCategoryId;
                return `<button type="button" role="tab" aria-selected="${isActive ? 'true' : 'false'}" class="rec-tab ${isActive ? 'rec-tab-active' : ''}" data-category-id="${cat.id}">
                <i class="fas ${cat.icon}"></i>
                <span>${this._escapeHtml(cat.label)}</span>
            </button>`;
            })
            .join('');

        this.innerHTML = `
        <style>
            /* ── macOS Liquid Glass Panel ── */
            .rec-panel {
                --rec-item-row-height: 54.6px;
                --rec-items-container-height: 236.4px;
                width: 100%;
                border-radius: 24px;
                background: rgba(255, 255, 255, 0.55);
                backdrop-filter: blur(40px) saturate(1.8);
                -webkit-backdrop-filter: blur(40px) saturate(1.8);
                border: 1px solid rgba(255, 255, 255, 0.45);
                box-shadow:
                    0 0 0 0.5px rgba(0, 0, 0, 0.04),
                    0 8px 40px -8px rgba(0, 0, 0, 0.08),
                    inset 0 0.5px 0 rgba(255, 255, 255, 0.6);
                overflow: hidden;
            }

            /* ── Tab Bar ── */
            .rec-tab-bar {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 10px 12px 2px;
                overflow-x: auto;
                scrollbar-width: none;
            }
            .rec-tab-bar::-webkit-scrollbar {
                display: none;
            }

            .rec-tab {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 6px 14px;
                border: none;
                border-radius: 9999px;
                background: transparent;
                font-size: 12px;
                color: #9ca3af;
                cursor: pointer;
                transition: color 0.2s ease, background 0.2s ease;
                white-space: nowrap;
                flex-shrink: 0;
            }
            .rec-tab i {
                font-size: 11px;
                transition: color 0.2s ease;
            }
            .rec-tab:hover {
                color: #6b7280;
                background: rgba(0, 0, 0, 0.04);
            }
            .rec-tab-active {
                color: #374151;
                font-weight: 500;
                background: #f1f3f6;
            }
            .rec-tab-active i {
                color: #3b82f6;
            }
            .rec-tab-active:hover {
                background: #ebedf0;
            }

            /* ── Items Container ── */
            .rec-items-container {
                display: flex;
                flex-direction: column;
                padding: 6px;
                gap: 2px;
                transition: opacity 0.15s ease, transform 0.15s ease;
            }
            .rec-panel-with-search .rec-items-container {
                box-sizing: border-box;
                height: var(--rec-items-container-height);
                overflow: hidden;
            }
            .rec-items-exit {
                opacity: 0;
                transform: translateY(4px);
            }
            .rec-items-enter {
                animation: rec-items-slide-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            }
            @keyframes rec-items-slide-in {
                from {
                    opacity: 0;
                    transform: translateY(6px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }

            /* ── Single Item ── */
            .rec-item {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 10px 12px;
                border: none;
                border-radius: 10px;
                background: transparent;
                box-sizing: border-box;
                height: var(--rec-item-row-height);
                cursor: pointer;
                text-align: left;
                transition: background 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
            }
            .rec-item:hover {
                background: rgba(255, 255, 255, 0.85);
                box-shadow:
                    0 2px 8px rgba(0, 0, 0, 0.06),
                    0 0 0 0.5px rgba(0, 0, 0, 0.03);
            }
            .rec-item:hover .rec-item-icon {
                background: linear-gradient(135deg, rgba(59, 130, 246, 0.15), rgba(139, 92, 246, 0.15));
                box-shadow: 0 2px 6px rgba(59, 130, 246, 0.12);
            }
            .rec-item:hover .rec-item-title {
                color: #1f2937;
            }
            .rec-item:hover .rec-item-desc {
                color: rgba(0, 0, 0, 0.52);
            }
            .rec-item:active {
                background: rgba(0, 0, 0, 0.03);
                transform: scale(0.995);
                transition: transform 0.1s ease;
            }

            .rec-item-icon {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 32px;
                height: 32px;
                border-radius: 8px;
                background: linear-gradient(135deg, rgba(59, 130, 246, 0.08), rgba(139, 92, 246, 0.08));
                flex-shrink: 0;
                transition: background 0.2s ease, box-shadow 0.2s ease;
            }
            .rec-item-icon i {
                font-size: 13px;
                color: #3b82f6;
            }

            .rec-item-content {
                flex: 1;
                min-width: 0;
                display: flex;
                flex-direction: column;
                gap: 1px;
            }
            .rec-item-title {
                font-size: 13px;
                font-weight: 500;
                color: rgba(0, 0, 0, 0.72);
                line-height: 1.4;
                transition: color 0.2s ease;
            }
            .rec-item-desc {
                font-size: 11px;
                color: rgba(0, 0, 0, 0.35);
                line-height: 1.4;
                display: -webkit-box;
                -webkit-line-clamp: 1;
                -webkit-box-orient: vertical;
                overflow: hidden;
                transition: color 0.2s ease;
            }

            .rec-item-arrow {
                flex-shrink: 0;
                color: rgba(0, 0, 0, 0.12);
                font-size: 10px;
                transition: color 0.2s ease, transform 0.2s ease;
            }
            .rec-item:hover .rec-item-arrow {
                color: rgba(0, 0, 0, 0.35);
                transform: translateX(2px);
            }
            .search-results-list {
                display: flex;
                flex-direction: column;
                gap: 6px;
                flex: 1 1 auto;
                min-height: 0;
                max-height: none;
                overflow-y: auto;
                overscroll-behavior: contain;
                scrollbar-gutter: stable;
                padding-right: 2px;
            }
            .search-results-list::-webkit-scrollbar {
                width: 6px;
            }
            .search-results-list::-webkit-scrollbar-track {
                background: transparent;
            }
            .search-results-list::-webkit-scrollbar-thumb {
                background: color-mix(in srgb, var(--od-text-muted) 34%, transparent);
                border-radius: 999px;
            }
            .search-results-list::-webkit-scrollbar-thumb:hover {
                background: color-mix(in srgb, var(--od-text-muted) 52%, transparent);
            }
            .search-empty,
            .search-loading,
            .search-note,
            .search-error {
                padding: 10px 12px;
                border-radius: 16px;
                font-size: 12px;
                color: var(--od-text-muted);
                background: color-mix(in srgb, var(--od-bg-muted) 76%, transparent);
                border: 1px solid color-mix(in srgb, var(--od-border) 72%, transparent);
            }
            .search-loading {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                width: 100%;
                min-height: 34px;
            }
            .search-loading::before {
                content: '';
                width: 10px;
                height: 10px;
                border-radius: 999px;
                border: 2px solid color-mix(in srgb, var(--od-accent) 24%, transparent);
                border-top-color: var(--od-accent);
                animation: search-loading-spin 0.8s linear infinite;
            }
            .search-note {
                color: var(--od-text);
            }
            .search-error {
                color: #ef4444;
                background: color-mix(in srgb, #ef4444 10%, var(--od-bg-elevated));
                border-color: color-mix(in srgb, #ef4444 26%, var(--od-border));
            }
            .search-result {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 11px 12px;
                border-radius: 16px;
                background: color-mix(in srgb, var(--od-bg-elevated) 88%, transparent);
                border: 1px solid color-mix(in srgb, var(--od-border) 76%, transparent);
                box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
                transition:
                    background 0.16s ease,
                    border-color 0.16s ease,
                    transform 0.16s ease;
            }
            .search-result:hover {
                background: color-mix(in srgb, var(--od-bg-muted) 70%, var(--od-bg-elevated));
                border-color: color-mix(in srgb, var(--od-accent) 24%, var(--od-border));
                transform: translateY(-1px);
            }
            .search-file-icon {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 28px;
                height: 28px;
                flex: 0 0 28px;
                border-radius: 8px;
                color: var(--od-accent);
                background: color-mix(in srgb, var(--od-accent) 13%, var(--od-bg-elevated));
            }
            .search-file-content {
                flex: 1;
                min-width: 0;
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            .search-file-title {
                font-size: 13px;
                color: var(--od-text);
                font-weight: 600;
            }
            .search-file-path,
            .search-snippet,
            .search-meta {
                font-size: 11px;
                color: var(--od-text-muted);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .search-snippet {
                color: color-mix(in srgb, var(--od-text) 74%, var(--od-text-muted));
            }
            .search-badge {
                margin-left: 6px;
                padding: 1px 6px;
                border-radius: 999px;
                background: color-mix(in srgb, var(--od-accent) 15%, var(--od-bg-elevated));
                color: var(--od-accent);
                font-weight: 600;
            }
            .search-actions {
                display: flex;
                gap: 4px;
            }
            .search-actions button {
                width: 28px;
                height: 28px;
                border: none;
                border-radius: 7px;
                background: transparent;
                color: var(--od-text-muted);
                cursor: pointer;
                transition:
                    background 0.16s ease,
                    color 0.16s ease;
            }
            .search-actions button:hover {
                background: color-mix(in srgb, var(--od-accent) 12%, transparent);
                color: var(--od-accent);
            }
            @keyframes search-loading-spin {
                to {
                    transform: rotate(360deg);
                }
            }
        </style>

        <div class="rec-panel ${this._temporarySearch ? 'rec-panel-with-search' : ''}">
            <div class="rec-tab-bar">
                ${tabsHTML}
            </div>
            <div class="rec-items-container"></div>
        </div>
        `;

        this._renderItems();

        this.querySelectorAll<HTMLElement>('.rec-tab').forEach((tab) => {
            tab.addEventListener('click', () => {
                const id = tab.dataset.categoryId;
                if (id) this._switchCategory(id, { userInitiated: true });
            });
        });
    }
}

if (!customElements.get('recommendation-panel')) {
    customElements.define('recommendation-panel', RecommendationPanel);
}

export type { RecommendationPanel };
