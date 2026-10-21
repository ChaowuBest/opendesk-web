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

import { ensureOverlayStyles } from './overlay.js';
import './taskSearchDialog.css';
import {
    normalizeSearchText,
    TASK_SEARCH_MAX_QUERY,
    TASK_SEARCH_PAGE_SIZE,
    TASK_SEARCH_MAX_RESULTS,
    type TaskSearchHit,
    type TaskSearchResponse
} from '../../common/task-search.js';
import { getTaskActivityTimestamp, type SidebarTask } from '../sidebarTaskGroups.js';

/**
 * 打开后忽略遮罩点击的保护期，需覆盖系统双击间隔：
 * 双击搜索框时第二次点击会被 modal 拦截落在刚打开浮层的遮罩上，
 * 不加保护会让浮层闪开即关。
 */
const BACKDROP_GUARD_MS = 400;

interface Options {
    getTasks(): SidebarTask[];
    search(query: string, limit: number): Promise<TaskSearchResponse>;
    subscribe(onChange: (unavailable?: boolean) => void): () => void;
    open(hit: TaskSearchHit): Promise<void>;
    translate(key: string): string;
}
export class TaskSearchDialog {
    private readonly dialog = document.createElement('dialog');
    private readonly input: HTMLInputElement;
    private readonly list: HTMLElement;
    private readonly status: HTMLElement;
    private readonly spinner: HTMLElement;
    private readonly more: HTMLButtonElement;
    private readonly cache = new Map<string, TaskSearchHit[]>();
    private items: TaskSearchHit[] = [];
    private query = '';
    private limit = TASK_SEARCH_PAGE_SIZE;
    private generation = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private unsubscribe?: () => void;
    private running?: number;
    private refreshRequested = false;
    private composing = false;
    private opening = false;
    private origin?: HTMLElement;
    private visible = false;
    private openGuard?: ReturnType<typeof setTimeout>;

    constructor(private readonly options: Options) {
        const t = (key: string) => options.translate('renderer.taskSearch.' + key);
        ensureOverlayStyles();
        this.dialog.className = 'od-task-search od-overlay';
        this.dialog.setAttribute('aria-label', t('title'));
        this.dialog.innerHTML = `
            <div class="od-task-search-top">
                <input type="text" autocomplete="off" spellcheck="false">
                <button type="button" class="od-task-search-close">×</button>
            </div>
            <div class="od-task-search-heading"><span></span><span class="od-task-search-spinner" hidden></span></div>
            <div class="od-task-search-scroll">
                <div class="od-task-search-results"></div>
                <button type="button" class="od-task-search-more" hidden></button>
                <div class="od-task-search-status" role="status"></div>
            </div>`;
        this.input = this.dialog.querySelector('input')!;
        this.list = this.dialog.querySelector('.od-task-search-results')!;
        this.status = this.dialog.querySelector('.od-task-search-status')!;
        this.spinner = this.dialog.querySelector('.od-task-search-spinner')!;
        this.more = this.dialog.querySelector('.od-task-search-more')!;
        this.input.maxLength = TASK_SEARCH_MAX_QUERY;
        this.input.placeholder = t('placeholder');
        this.input.setAttribute('aria-label', t('placeholder'));
        this.dialog.querySelector('.od-task-search-heading > span')!.textContent = t('chats');
        this.spinner.setAttribute('aria-label', t('searching'));
        const close = this.dialog.querySelector<HTMLButtonElement>('.od-task-search-close')!;
        close.setAttribute('aria-label', t('close'));
        close.title = t('close');
        close.addEventListener('click', () => this.hide());
        this.more.textContent = t('more');
        this.more.addEventListener('click', () => {
            this.limit = TASK_SEARCH_MAX_RESULTS;
            void this.run(++this.generation);
        });
        this.input.addEventListener('compositionstart', () => {
            this.composing = true;
            this.generation++;
            clearTimeout(this.timer);
            this.timer = undefined;
        });
        this.input.addEventListener('compositionend', () => {
            this.composing = false;
            this.changed();
        });
        this.input.addEventListener('input', () => {
            if (!this.composing) this.changed();
        });
        // No new search keyboard shortcuts in this iteration.
        // Esc 关闭浮层：cancel 是原生关闭的前置事件，这里 preventDefault 后走 hide()，
        // 保证退订、清计时器和 DOM 移除都同步完成。
        this.dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            this.hide();
        });
        // 兜底同步状态：原生关闭路径（如 Chromium 对连续 Esc 的强制关闭）不经过 hide()，
        // 若不同步 visible，show() 会一直走 early-return 分支导致浮层再也打不开。
        this.dialog.addEventListener('close', () => {
            if (this.visible) this.hide();
        });
        this.dialog.addEventListener('click', (event) => {
            if (event.target !== this.dialog) return;
            const rect = this.dialog.getBoundingClientRect();
            if (
                event.clientX < rect.left ||
                event.clientX > rect.right ||
                event.clientY < rect.top ||
                event.clientY > rect.bottom
            ) {
                if (this.openGuard) return;
                this.hide();
            }
        });
        this.list.addEventListener('click', (event) => {
            const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-task-id]');
            const hit = this.items.find((item) => item.taskId === button?.dataset.taskId);
            if (hit) void this.select(hit);
        });
        document.addEventListener('task-list-updated', this.invalidate);
    }
    show(): void {
        if (this.visible) {
            this.input.focus();
            return;
        }
        this.origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        document.body.append(this.dialog);
        this.visible = true;
        this.unsubscribe = this.options.subscribe(this.indexChanged);
        this.dialog.showModal();
        clearTimeout(this.openGuard);
        this.openGuard = setTimeout(() => {
            this.openGuard = undefined;
        }, BACKDROP_GUARD_MS);
        this.input.focus();
        this.changed();
    }
    hide(): void {
        this.visible = false;
        this.generation++;
        clearTimeout(this.timer);
        this.timer = undefined;
        clearTimeout(this.openGuard);
        this.openGuard = undefined;
        this.refreshRequested = false;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.dialog.close();
        this.dialog.remove();
        this.origin?.focus();
    }
    destroy(): void {
        this.hide();
        this.cache.clear();
        document.removeEventListener('task-list-updated', this.invalidate);
    }
    private invalidate = () => {
        this.cache.clear();
        if (!this.visible || this.composing || this.opening) return;
        this.items = this.results(this.items);
        this.render();
        // Metadata updates do not cancel an input query or invalidate its response.
        // Persisted body changes arrive through the index notification below.
    };
    private indexChanged = (unavailable = false) => {
        this.cache.clear();
        if (!this.visible || !this.query) return;
        if (unavailable) {
            ++this.generation;
            clearTimeout(this.timer);
            this.timer = undefined;
            this.refreshRequested = false;
            this.showSearchError();
            return;
        }
        this.refreshRequested = true;
        if (this.composing || this.opening || this.timer !== undefined || this.running === this.generation) return;
        void this.run(this.generation, true);
    };
    private results(indexed: TaskSearchHit[] = []): TaskSearchHit[] {
        const bodyHits = new Map(indexed.filter((hit) => hit.messageId).map((hit) => [hit.taskId, hit]));
        const matches: { hit: TaskSearchHit; activity: number }[] = [];
        for (const task of this.options.getTasks()) {
            if (task.internal || !(task.task_name?.trim() || task.name_pending)) continue;
            const title = normalizeSearchText(task.task_name || '');
            const workspace = normalizeSearchText(task.workspace || '');
            const priority = !this.query
                ? 0
                : title === this.query
                  ? 3
                  : title.includes(this.query)
                    ? 2
                    : workspace.includes(this.query)
                      ? 1
                      : 0;
            const body = bodyHits.get(task.task_id);
            if (this.query && !priority && !body) continue;
            // Read metadata once from the live list; only body matches come from the index/cache.
            matches.push({
                hit: {
                    taskId: task.task_id,
                    title: task.task_name || '',
                    workspace: task.workspace || '',
                    messageId: body?.messageId,
                    snippet: body?.snippet || '',
                    priority
                },
                activity: getTaskActivityTimestamp(task)
            });
        }
        return matches
            .sort((a, b) => b.hit.priority - a.hit.priority || b.activity - a.activity)
            .slice(0, this.limit)
            .map(({ hit }) => hit);
    }
    private changed(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.refreshRequested = false;
        const generation = ++this.generation;
        this.query = normalizeSearchText(this.input.value).slice(0, TASK_SEARCH_MAX_QUERY);
        this.limit = TASK_SEARCH_PAGE_SIZE;
        const cached = this.cache.get(this.query);
        this.items = this.results(cached);
        this.more.hidden = true;
        this.status.textContent = '';
        this.setLoading(Boolean(this.query));
        this.render();
        if (this.query)
            this.timer = setTimeout(() => {
                this.timer = undefined;
                void this.run(generation);
            }, 150);
        else if (!this.items.length) this.status.textContent = this.t('recentEmpty');
    }
    private async run(generation: number, quiet = false): Promise<void> {
        if (!this.visible || this.composing || generation !== this.generation || !this.query) return;
        if (this.running === generation) {
            this.refreshRequested = true;
            return;
        }
        this.running = generation;
        this.refreshRequested = false;
        if (!quiet) this.setLoading(true);
        try {
            const result = await this.options.search(this.query, this.limit);
            if (!this.visible || generation !== this.generation) return;
            const incoming = this.results(result.items);
            // Keep row order stable until indexing completes, while dropping obsolete hits.
            const remaining = new Map(incoming.map((hit) => [hit.taskId, hit]));
            this.items = result.indexing
                ? this.items
                      .flatMap((hit) => {
                          const current = remaining.get(hit.taskId);
                          remaining.delete(hit.taskId);
                          return current ? [current] : [];
                      })
                      .concat([...remaining.values()])
                : incoming;
            this.cache.delete(this.query);
            this.cache.set(this.query, this.items);
            if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value!);
            this.render();
            this.more.hidden = !result.hasMore || this.limit >= TASK_SEARCH_MAX_RESULTS;
            this.setLoading(result.indexing);
            this.status.textContent = result.failedTasks
                ? this.t('incomplete')
                : result.indexing
                  ? this.t('indexing')
                  : !this.items.length
                    ? this.t('empty')
                    : result.hasMore && this.limit >= TASK_SEARCH_MAX_RESULTS
                      ? this.t('refine')
                      : '';
        } catch {
            if (!this.visible || generation !== this.generation) return;
            this.refreshRequested = false;
            this.showSearchError();
        } finally {
            if (this.running === generation) this.running = undefined;
            if (this.visible && generation === this.generation && this.refreshRequested) {
                void this.run(generation, true);
            }
        }
    }
    private showSearchError(): void {
        this.setLoading(false);
        this.status.textContent = this.t('error');
        this.more.hidden = true;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = this.t('retry');
        retry.addEventListener('click', () => void this.run(++this.generation), { once: true });
        this.status.append(' ', retry);
    }
    private render(): void {
        const existing = new Map(
            Array.from(this.list.children).map((node) => [
                (node as HTMLElement).dataset.taskId,
                node as HTMLButtonElement
            ])
        );
        for (const hit of this.items) {
            const button = existing.get(hit.taskId) || document.createElement('button');
            existing.delete(hit.taskId);
            button.type = 'button';
            button.className = 'od-task-search-result';
            button.dataset.taskId = hit.taskId;
            button.disabled = this.opening;
            const title = document.createElement('span');
            title.className = 'od-task-search-result-title';
            this.highlight(title, hit.title || this.t('untitled'));
            const workspace = document.createElement('span');
            workspace.className = 'od-task-search-workspace';
            workspace.textContent = hit.workspace.split(/[\\/]/).filter(Boolean).at(-1) || '';
            workspace.title = hit.workspace;
            const line = document.createElement('span');
            line.className = 'od-task-search-result-line';
            line.append(title, workspace);
            const snippet = document.createElement('span');
            snippet.className = 'od-task-search-snippet';
            snippet.hidden = !hit.snippet;
            this.renderSnippet(snippet, hit.snippet);
            button.replaceChildren(line, snippet);
            this.list.append(button);
        }
        for (const node of existing.values()) node.remove();
    }
    private renderSnippet(element: HTMLElement, value: string): void {
        this.highlight(element, value);
        const match = element.querySelector('mark');
        if (!match) return;
        // Reserve space for the first match; context yields to it as the row narrows.
        // Keep all text in the DOM so resizing can reveal it without another search.
        const before = document.createElement('span');
        before.className = 'od-task-search-snippet-before';
        const context = document.createElement('bdi');
        while (element.firstChild && element.firstChild !== match) {
            context.append(element.firstChild);
        }
        before.append(context);
        const after = document.createElement('span');
        after.className = 'od-task-search-snippet-after';
        while (match.nextSibling) after.append(match.nextSibling);
        element.classList.add('od-task-search-snippet-matched');
        element.replaceChildren(before, match, after);
    }
    private highlight(element: HTMLElement, value: string): void {
        value = value.replace(/\s+/gu, ' ').trim();
        if (!this.query) {
            element.textContent = value;
            return;
        }
        const lower = normalizeSearchText(value);
        let position = 0;
        let hit = lower.indexOf(this.query);
        while (hit >= 0) {
            element.append(document.createTextNode(value.slice(position, hit)));
            const mark = document.createElement('mark');
            mark.textContent = value.slice(hit, hit + this.query.length);
            element.append(mark);
            position = hit + this.query.length;
            hit = lower.indexOf(this.query, position);
        }
        element.append(document.createTextNode(value.slice(position)));
    }
    private async select(hit: TaskSearchHit): Promise<void> {
        if (this.opening) return;
        this.opening = true;
        clearTimeout(this.timer);
        this.timer = undefined;
        this.refreshRequested = false;
        const generation = ++this.generation;
        this.setLoading(true);
        this.status.textContent = this.t('opening');
        this.render();
        try {
            await this.options.open(hit);
            if (this.visible && generation === this.generation) this.hide();
        } catch {
            if (this.visible && generation === this.generation) {
                this.status.textContent = this.t('openError');
                this.setLoading(false);
            }
        } finally {
            this.opening = false;
            this.render();
        }
    }
    private t(key: string): string {
        return this.options.translate('renderer.taskSearch.' + key);
    }
    private setLoading(loading: boolean): void {
        this.spinner.hidden = !loading;
        this.more.disabled = loading;
    }
}
