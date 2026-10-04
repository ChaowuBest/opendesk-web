/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the software at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * 文件回收站模态弹窗：承载 OpenDesk 统一回收站（<opendeskDir>/trash/）的搜索与找回。
 *
 * 两种打开状态：
 *  - 任务级：open({ taskId })，显示任务信息（名称 + 最后一条用户消息），
 *    默认只搜该任务的回收站，可取消勾选切换为全局搜索；
 *  - 系统级：open()，直接搜索全局回收站（最近一个星期的任务）。
 *
 * 视觉与交互对齐设置面板的"编辑模型/编辑供应商"模态弹窗
 * （od-confirm-modal-* 体系：遮罩 + 卡片 + banner/body/footer，进出场动画，
 * Esc 关闭；含输入框因此遮罩点击不关闭，防误触丢输入）。
 * 列表按删除时间从近到远排序，滚动触底分页加载；每条可"找回"（复制回原路径，
 * 不删除回收站内容），原路径已存在文件时弹模态确认覆盖。
 */

import {
    showConfirmModal,
    MODAL_CSS,
    MODAL_ANIM_DURATION_OUT,
    detectDarkMode,
    bindOverlayDismiss,
    CLOSE_SVG
} from './confirmModal.ts';
import { createRendererTranslator } from '../locale.ts';
import { escapeHtml } from '../../common/utils/escape.js';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

type Translator = (key: string, params?: Record<string, string>) => string;

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
    return `${text} ${units[unit]}`;
}

function formatDeletedTime(iso: string, t: Translator): string {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return '';
    const diffMs = Date.now() - time;
    const oneMinute = 60 * 1000;
    const oneHour = 60 * oneMinute;
    if (diffMs < oneMinute) return t('trash.window.justNow');
    if (diffMs < oneHour) return t('trash.window.minutesAgo', { count: String(Math.floor(diffMs / oneMinute)) });
    if (diffMs < 24 * oneHour) return t('trash.window.hoursAgo', { count: String(Math.floor(diffMs / oneHour)) });
    return new Date(time).toLocaleString();
}

interface TrashEntryView {
    uuid: string;
    original_path: string;
    size: number;
    deleted_at: string;
    task_id: string;
}

/**
 * 模态内自定义样式：复用 MODAL_CSS 注入的 --mc-* 主题变量（深浅色自动适配），
 * 卡片宽度对齐设置面板的宽弹窗（od-sp-wider 同款 560px）。
 */
const TRASH_MODAL_CSS = `
.trash-modal-card { width: 560px; max-width: 92vw; }

/* 对齐设置面板 od-sp-scroll：body 超高时滚动（footer 固定在卡片底部） */
.trash-modal-body { padding-top: 14px; max-height: 62vh; overflow-y: auto; }

.trash-search {
    position: relative;
    margin-bottom: 12px;
}
.trash-search-input {
    width: 100%; box-sizing: border-box;
    padding: 8px 32px 8px 32px;
    border: 1.5px solid var(--mc-line);
    border-radius: 8px;
    background: var(--mc-card-bg);
    color: var(--mc-ink);
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
}
.trash-search-input:focus { border-color: var(--mc-accent); }
.trash-search-input::placeholder { color: var(--mc-ink4); }
.trash-search-icon {
    position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    color: var(--mc-ink4); font-size: 12px; pointer-events: none;
}
.trash-search-clear {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    width: 22px; height: 22px;
    display: none; align-items: center; justify-content: center;
    border: none; border-radius: 6px;
    background: transparent; color: var(--mc-ink4);
    cursor: pointer; font-size: 12px;
}
.trash-search-clear:hover { background: var(--mc-hover); color: var(--mc-ink2); }
.trash-search.has-value .trash-search-clear { display: flex; }

.trash-task-info {
    margin-bottom: 12px;
    padding: 10px 12px;
    border: 1px solid var(--mc-line-soft);
    border-radius: 8px;
    background: var(--mc-hover);
}
.trash-task-name {
    font-weight: 600; font-size: 13px; color: var(--mc-ink);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.trash-task-message {
    margin-top: 2px;
    font-size: 12px; color: var(--mc-ink3);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.trash-scope-row {
    display: flex; align-items: center; gap: 6px;
    margin-top: 8px;
    font-size: 12px; color: var(--mc-ink2);
    cursor: pointer; user-select: none;
}
.trash-scope-row input { accent-color: var(--mc-accent); cursor: pointer; }

.trash-list { min-height: 160px; }

.trash-state {
    padding: 36px 12px;
    text-align: center;
    color: var(--mc-ink4);
    font-size: 12.5px;
}
.trash-state-error { color: #ef4444; }

.trash-item {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 8px;
    border-radius: 8px;
}
.trash-item:hover { background: var(--mc-hover); }
.trash-item-main { flex: 1; min-width: 0; }
.trash-item-name {
    font-size: 13px; font-weight: 500; color: var(--mc-ink);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.trash-item-meta {
    margin-top: 1px;
    font-size: 11.5px; color: var(--mc-ink3);
    display: flex; align-items: center; gap: 4px;
    white-space: nowrap; overflow: hidden;
}
.trash-open-btn {
    flex: none;
    border: 1px solid var(--mc-line);
    border-radius: 7px;
    background: var(--mc-card-bg);
    color: var(--mc-ink2);
    font-size: 12px;
    padding: 4px 12px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
}
.trash-open-btn:hover { background: var(--mc-hover); border-color: var(--mc-ink3); }
.trash-open-btn:disabled { opacity: 0.55; cursor: default; }
.trash-restore-btn {
    flex: none;
    border: 1px solid var(--mc-line);
    border-radius: 7px;
    background: var(--mc-card-bg);
    color: var(--mc-accent);
    font-size: 12px;
    padding: 4px 12px;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
}
.trash-restore-btn:hover { background: var(--mc-hover); border-color: var(--mc-accent); }
.trash-restore-btn:disabled { opacity: 0.55; cursor: default; }

.trash-list-footer {
    padding: 8px 0;
    text-align: center;
    color: var(--mc-ink4);
    font-size: 12px;
}
`;

class TrashFloatingWindow extends HTMLElement {
    private _t: Translator;

    private _overlay: HTMLElement | null = null;
    private _taskId: string | null = null;
    private _taskScopeOnly = true;
    private _taskContext: { task_name?: string; last_user_message?: string } | null = null;
    private _keyword = '';
    private _entries: TrashEntryView[] = [];
    private _total = 0;
    private _loading = false;
    private _loadingMore = false;
    private _loadFailed = false;
    private _searchTimer: ReturnType<typeof setTimeout> | null = null;
    private _searchSeq = 0;
    private _restoring = new Set<string>();
    private _opening = new Set<string>();
    private _escHandler: ((event: KeyboardEvent) => void) | null = null;

    constructor() {
        super();
        this._t = createRendererTranslator();
    }

    /** 打开模态。传 taskId 时为任务级回收站；不传为系统级（全局）。 */
    open(options: { taskId?: string | null } = {}): void {
        if (this._overlay) this.close();
        this._t = createRendererTranslator();
        this._taskId = options.taskId ?? null;
        this._taskScopeOnly = true;
        this._taskContext = null;
        this._keyword = '';
        this._buildOverlay();
        if (this._taskId) {
            void this._loadTaskContext();
        }
        void this._loadFirstPage();
    }

    close(): void {
        if (!this._overlay) return;
        const overlay = this._overlay;
        this._overlay = null;
        if (this._searchTimer) {
            clearTimeout(this._searchTimer);
            this._searchTimer = null;
        }
        // 使在途请求的结果失效
        this._searchSeq++;
        overlay.classList.add('od-modal-leaving');
        setTimeout(() => overlay.remove(), MODAL_ANIM_DURATION_OUT);
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler, true);
            this._escHandler = null;
        }
    }

    // ── 数据 ────────────────────────────────────────────────────────────────

    private get _isTaskScope(): boolean {
        return !!this._taskId && this._taskScopeOnly;
    }

    private async _loadTaskContext(): Promise<void> {
        if (!this._taskId) return;
        const taskId = this._taskId;
        try {
            const context = await window.trashAPI.getTaskContext(taskId);
            if (this._taskId === taskId) this._taskContext = context;
        } catch (error) {
            console.error('loading trash task context failed', error);
        }
        this._renderTaskInfo();
    }

    private _buildSearchOptions(offset: number): Record<string, unknown> {
        const keyword = this._keyword.trim();
        const options: Record<string, unknown> = { offset, limit: PAGE_SIZE };
        // 范围由勾选项决定（任务级/全局），关键字在所选范围内过滤：
        // 勾选"仅该任务"时即在任务回收站内按关键字搜索，取消勾选才是全局搜索
        if (this._isTaskScope) {
            options.scope = 'task';
            options.taskId = this._taskId;
        } else {
            options.scope = 'global';
        }
        if (keyword) {
            options.keyword = keyword;
        }
        return options;
    }

    private async _loadFirstPage(): Promise<void> {
        if (!this._overlay) return;
        this._searchSeq++;
        const seq = this._searchSeq;
        this._loading = true;
        this._loadFailed = false;
        this._entries = [];
        this._total = 0;
        this._renderList();
        try {
            const result = await window.trashAPI.search(this._buildSearchOptions(0));
            if (seq !== this._searchSeq) return;
            this._entries = result.entries;
            this._total = result.total;
        } catch (error) {
            console.error('searching trash failed', error);
            if (seq !== this._searchSeq) return;
            this._loadFailed = true;
        } finally {
            if (seq === this._searchSeq) this._loading = false;
        }
        this._renderList();
    }

    private async _loadMore(): Promise<void> {
        if (!this._overlay || this._loading || this._loadingMore) return;
        if (this._entries.length >= this._total) return;
        this._loadingMore = true;
        this._renderListFooter();
        const seq = this._searchSeq;
        try {
            const result = await window.trashAPI.search(this._buildSearchOptions(this._entries.length));
            if (seq !== this._searchSeq) return;
            this._entries = this._entries.concat(result.entries);
            this._total = result.total;
        } catch (error) {
            console.error('loading more trash entries failed', error);
        } finally {
            if (seq === this._searchSeq) this._loadingMore = false;
        }
        this._renderList();
    }

    /** "打开"：以原始文件名的临时副本用系统默认应用打开回收站内容（预览语义）。 */
    private async _openEntry(uuid: string): Promise<void> {
        const entry = this._entries.find((item) => item.uuid === uuid);
        if (!entry || this._opening.has(uuid)) return;
        this._opening.add(uuid);
        this._renderList();
        try {
            await window.trashAPI.openEntry(entry.task_id, uuid);
        } catch (error) {
            await showConfirmModal({
                variant: 'danger',
                title: this._t('trash.window.openFailedTitle'),
                message: this._modalText(
                    this._t('trash.window.openFailedMessage', {
                        message: error instanceof Error ? error.message : String(error)
                    })
                ),
                confirmText: this._t('common.confirm'),
                cancelText: ''
            });
        } finally {
            this._opening.delete(uuid);
            // 重绘必须放在 finally：按钮状态恢复不依赖提前 return 的路径
            this._renderList();
        }
    }

    private async _restoreEntry(uuid: string): Promise<void> {
        const entry = this._entries.find((item) => item.uuid === uuid);
        if (!entry || this._restoring.has(uuid)) return;
        this._restoring.add(uuid);
        this._renderList();
        try {
            const first = await window.trashAPI.restore(entry.task_id, uuid, false);
            if (first.restored) {
                await showConfirmModal({
                    variant: 'success',
                    title: this._t('trash.window.restoreSuccessTitle'),
                    message: this._modalText(
                        this._t('trash.window.restoreSuccessMessage', { path: first.target ?? '' })
                    ),
                    confirmText: this._t('common.confirm'),
                    cancelText: ''
                });
                return;
            }
            if (first.identical) {
                await showConfirmModal({
                    variant: 'info',
                    title: this._t('trash.window.identicalTitle'),
                    message: this._modalText(this._t('trash.window.identicalMessage', { path: first.target ?? '' })),
                    confirmText: this._t('common.confirm'),
                    cancelText: ''
                });
                return;
            }
            if (first.exists && first.target) {
                // 目标已存在且内容不同：展示现有文件的最近修改时间，确认后覆盖
                const mtimeText =
                    typeof first.target_mtime === 'number' && Number.isFinite(first.target_mtime)
                        ? new Date(first.target_mtime).toLocaleString()
                        : '';
                const message = mtimeText
                    ? this._t('trash.window.overwriteMessage', { mtime: mtimeText, path: first.target })
                    : this._t('trash.window.overwriteMessageNoTime', { path: first.target });
                const confirmed = await showConfirmModal({
                    variant: 'warn',
                    title: this._t('trash.window.overwriteTitle'),
                    message: this._modalText(message),
                    confirmText: this._t('trash.window.overwriteConfirm'),
                    cancelText: this._t('common.cancel')
                });
                if (!confirmed) return;
                const second = await window.trashAPI.restore(entry.task_id, uuid, true);
                if (second.restored) {
                    await showConfirmModal({
                        variant: 'success',
                        title: this._t('trash.window.restoreSuccessTitle'),
                        message: this._modalText(
                            this._t('trash.window.restoreSuccessMessage', { path: second.target ?? first.target })
                        ),
                        confirmText: this._t('common.confirm'),
                        cancelText: ''
                    });
                } else {
                    await this._showRestoreFailure(second.message);
                }
                return;
            }
            await this._showRestoreFailure(first.message);
        } catch (error) {
            await this._showRestoreFailure(error instanceof Error ? error.message : String(error));
        } finally {
            this._restoring.delete(uuid);
            // 重绘必须放在 finally：成功/一致分支会提前 return，按钮需恢复可点
            this._renderList();
        }
    }

    /** 结果类单按钮模态：找回成功/失败共用（variant danger，展示原因）。 */
    private async _showRestoreFailure(message?: string): Promise<void> {
        await showConfirmModal({
            variant: 'danger',
            title: this._t('trash.window.restoreFailedTitle'),
            message: this._modalText(this._t('trash.window.restoreFailedMessage', { message: message || '' })),
            confirmText: this._t('common.confirm'),
            cancelText: ''
        });
    }

    /** 模态消息文本：HTML 转义 + 换行转 <br>（showConfirmModal 的 message 按 HTML 渲染）。 */
    private _modalText(text: string): string {
        return escapeHtml(text).replace(/\n/g, '<br>');
    }

    // ── 渲染 ────────────────────────────────────────────────────────────────

    private _buildOverlay(): void {
        const t = this._t;
        const overlay = document.createElement('div');
        overlay.className = 'od-confirm-modal-overlay';
        if (detectDarkMode(this)) {
            overlay.classList.add('od-modal-dark');
        }

        const isTaskMode = !!this._taskId;
        overlay.innerHTML = `
            <style>${MODAL_CSS}${TRASH_MODAL_CSS}</style>
            <div class="od-confirm-modal-card trash-modal-card">
                <div class="od-confirm-modal-banner info">
                    <div class="od-confirm-modal-icon"><i class="fas fa-trash-can"></i></div>
                    <div class="od-confirm-modal-banner-text">
                        <div class="od-confirm-modal-title">${escapeHtml(t('trash.window.title'))}</div>
                    </div>
                    <button class="od-confirm-modal-close trash-close" title="${escapeHtml(t('common.close'))}" aria-label="${escapeHtml(t('common.close'))}">${CLOSE_SVG}</button>
                </div>
                <div class="od-confirm-modal-body od-sp-scroll trash-modal-body">
                    <div class="trash-search">
                        <i class="fa-solid fa-magnifying-glass trash-search-icon"></i>
                        <input type="text" class="trash-search-input" placeholder="${escapeHtml(t('trash.window.searchPlaceholder'))}">
                        <button type="button" class="trash-search-clear" title="${escapeHtml(t('renderer.sidebar.clearSearch'))}" aria-label="${escapeHtml(t('renderer.sidebar.clearSearch'))}"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    ${isTaskMode ? this._taskInfoHtml() : ''}
                    <div class="trash-list"></div>
                </div>
                <div class="od-confirm-modal-footer">
                    <button class="od-confirm-btn od-confirm-btn-cancel trash-close">${escapeHtml(t('common.close'))}</button>
                </div>
            </div>
        `;

        // 含搜索输入框：遮罩点击不关闭（对齐设置面板表单弹窗的行为，防误触丢输入）
        bindOverlayDismiss(overlay, () => this.close(), undefined, false);

        overlay.querySelectorAll('.trash-close').forEach((button) => {
            button.addEventListener('click', () => this.close());
        });

        const searchInput = overlay.querySelector('.trash-search-input') as HTMLInputElement | null;
        const searchBox = overlay.querySelector('.trash-search') as HTMLElement | null;
        searchInput?.addEventListener('input', () => {
            this._keyword = searchInput.value;
            searchBox?.classList.toggle('has-value', !!this._keyword.trim());
            if (this._searchTimer) clearTimeout(this._searchTimer);
            this._searchTimer = setTimeout(() => {
                this._searchTimer = null;
                void this._loadFirstPage();
            }, SEARCH_DEBOUNCE_MS);
        });
        overlay.querySelector('.trash-search-clear')?.addEventListener('click', () => {
            if (searchInput) searchInput.value = '';
            this._keyword = '';
            searchBox?.classList.remove('has-value');
            if (this._searchTimer) {
                clearTimeout(this._searchTimer);
                this._searchTimer = null;
            }
            void this._loadFirstPage();
            searchInput?.focus();
        });

        overlay.querySelector('.trash-scope-only')?.addEventListener('change', (event) => {
            this._taskScopeOnly = (event.target as HTMLInputElement).checked;
            void this._loadFirstPage();
        });

        const body = overlay.querySelector('.trash-modal-body') as HTMLElement | null;
        body?.addEventListener('scroll', () => {
            if (body.scrollTop + body.clientHeight >= body.scrollHeight - 48) {
                void this._loadMore();
            }
        });

        this._escHandler = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                this.close();
            }
        };
        document.addEventListener('keydown', this._escHandler, true);

        this.appendChild(overlay);
        this._overlay = overlay;
        this._renderList();
        searchInput?.focus();
    }

    private _taskInfoHtml(): string {
        return `
            <div class="trash-task-info">
                <div class="trash-task-name" title=""></div>
                <div class="trash-task-message"></div>
                <label class="trash-scope-row">
                    <input type="checkbox" class="trash-scope-only" ${this._taskScopeOnly ? 'checked' : ''}>
                    <span>${escapeHtml(this._t('trash.window.taskScopeOnly'))}</span>
                </label>
            </div>`;
    }

    /** 任务上下文加载完成后回填任务信息区（不重建输入框/列表）。 */
    private _renderTaskInfo(): void {
        const overlay = this._overlay;
        if (!overlay) return;
        const nameEl = overlay.querySelector('.trash-task-name') as HTMLElement | null;
        const messageEl = overlay.querySelector('.trash-task-message') as HTMLElement | null;
        if (!nameEl || !messageEl) return;
        nameEl.textContent = this._taskContext?.task_name || this._t('trash.window.unnamedTask');
        nameEl.title = this._taskContext?.task_name || '';
        messageEl.textContent = this._taskContext?.last_user_message || '';
    }

    private _renderList(): void {
        const overlay = this._overlay;
        const list = overlay?.querySelector('.trash-list') as HTMLElement | null;
        if (!overlay || !list) return;
        const t = this._t;

        if (this._loading) {
            list.innerHTML = `<div class="trash-state">${escapeHtml(t('trash.window.loading'))}</div>`;
            return;
        }
        if (this._loadFailed) {
            list.innerHTML = `<div class="trash-state trash-state-error">${escapeHtml(t('trash.window.loadFailed'))}</div>`;
            return;
        }
        if (this._entries.length === 0) {
            const emptyText = this._keyword.trim() ? t('trash.window.noMatch') : t('trash.window.empty');
            list.innerHTML = `<div class="trash-state">${escapeHtml(emptyText)}</div>`;
            return;
        }

        list.innerHTML = this._entries
            .map((entry) => {
                const name =
                    entry.original_path
                        .replace(/[\\/]+$/, '')
                        .split(/[\\/]/)
                        .pop() || entry.original_path;
                const restoring = this._restoring.has(entry.uuid);
                const opening = this._opening.has(entry.uuid);
                return `
                <div class="trash-item">
                    <div class="trash-item-main">
                        <div class="trash-item-name" title="${escapeHtml(entry.original_path)}">${escapeHtml(name)}</div>
                        <div class="trash-item-meta">
                            <span>${escapeHtml(formatBytes(entry.size))}</span>
                            <span>·</span>
                            <span>${escapeHtml(formatDeletedTime(entry.deleted_at, this._t))}</span>
                        </div>
                    </div>
                    <button class="trash-open-btn" data-uuid="${escapeHtml(entry.uuid)}" title="${escapeHtml(t('trash.window.openTitle'))}" ${opening ? 'disabled' : ''}>
                        ${opening ? escapeHtml(t('trash.window.opening')) : escapeHtml(t('trash.window.open'))}
                    </button>
                    <button class="trash-restore-btn" data-uuid="${escapeHtml(entry.uuid)}" ${restoring ? 'disabled' : ''}>
                        ${restoring ? escapeHtml(t('trash.window.restoring')) : escapeHtml(t('trash.window.restore'))}
                    </button>
                </div>`;
            })
            .join('');

        // 列表整体重写后逐条绑定按钮
        list.querySelectorAll<HTMLButtonElement>('.trash-open-btn').forEach((button) => {
            button.addEventListener('click', () => {
                void this._openEntry(button.dataset.uuid || '');
            });
        });
        list.querySelectorAll<HTMLButtonElement>('.trash-restore-btn').forEach((button) => {
            button.addEventListener('click', () => {
                void this._restoreEntry(button.dataset.uuid || '');
            });
        });
        this._renderListFooter();
    }

    private _renderListFooter(): void {
        const list = this._overlay?.querySelector('.trash-list') as HTMLElement | null;
        if (!list || this._loading || this._loadFailed || this._entries.length === 0) return;
        let footer = list.querySelector('.trash-list-footer') as HTMLElement | null;
        if (this._loadingMore) {
            if (!footer) {
                footer = document.createElement('div');
                footer.className = 'trash-list-footer';
                list.appendChild(footer);
            }
            footer.textContent = this._t('trash.window.loading');
        } else {
            footer?.remove();
        }
    }
}

if (!customElements.get('trash-floating-window')) {
    customElements.define('trash-floating-window', TrashFloatingWindow as unknown as CustomElementConstructor);
}

export {};
