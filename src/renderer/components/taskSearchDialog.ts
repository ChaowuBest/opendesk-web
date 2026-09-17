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

interface Options {
    getTasks(): SidebarTask[];
    search(query: string, limit: number): Promise<TaskSearchResponse>;
    subscribe(onChange: (unavailable?: boolean) => void): () => void;
    open(hit: TaskSearchHit): Promise<void>;
    translate(key: string): string;
}
export class TaskSearchDialog {
    private readonly dialog = document.createElement('dialog');
    private readonly input = document.createElement('input');
    private readonly list = document.createElement('div');
    private readonly status = document.createElement('div');
    private readonly spinner = document.createElement('span');
    private readonly more = document.createElement('button');
    private readonly cache = new Map<string, TaskSearchResponse>();
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

    constructor(private readonly options: Options) {
        const t = (key: string) => options.translate('renderer.taskSearch.' + key);
        this.dialog.className = 'od-task-search';
        this.dialog.setAttribute('aria-label', t('title'));
        this.dialog.innerHTML = '<div class="od-task-search-top"></div><div class="od-task-search-heading"></div>';
        const top = this.dialog.firstElementChild!;
        this.input.type = 'text';
        this.input.maxLength = TASK_SEARCH_MAX_QUERY;
        this.input.placeholder = t('placeholder');
        this.input.setAttribute('aria-label', t('placeholder'));
        this.input.autocomplete = 'off';
        this.input.spellcheck = false;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'od-task-search-close';
        close.textContent = '×';
        close.setAttribute('aria-label', t('close'));
        close.title = t('close');
        close.addEventListener('click', () => this.hide());
        top.append(this.input, close);
        const heading = this.dialog.children[1];
        const label = document.createElement('span');
        label.textContent = t('chats');
        this.spinner.className = 'od-task-search-spinner';
        this.spinner.setAttribute('aria-label', t('searching'));
        this.spinner.hidden = true;
        heading.append(label, this.spinner);
        this.list.className = 'od-task-search-results';
        this.status.className = 'od-task-search-status';
        this.status.setAttribute('role', 'status');
        this.more.type = 'button';
        this.more.className = 'od-task-search-more';
        this.more.textContent = t('more');
        this.more.hidden = true;
        this.more.addEventListener('click', () => {
            this.limit = TASK_SEARCH_MAX_RESULTS;
            void this.run(++this.generation);
        });
        const scroll = document.createElement('div');
        scroll.className = 'od-task-search-scroll';
        scroll.append(this.list, this.more, this.status);
        this.dialog.append(scroll);
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
        this.dialog.addEventListener('cancel', (event) => event.preventDefault());
        this.dialog.addEventListener('click', (event) => {
            if (event.target !== this.dialog) return;
            const rect = this.dialog.getBoundingClientRect();
            if (
                event.clientX < rect.left ||
                event.clientX > rect.right ||
                event.clientY < rect.top ||
                event.clientY > rect.bottom
            )
                this.hide();
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
        this.input.focus();
        this.changed();
    }
    hide(): void {
        this.visible = false;
        this.generation++;
        clearTimeout(this.timer);
        this.timer = undefined;
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
        const quick = this.quickResults();
        const merged = new Map(quick.map((hit) => [hit.taskId, hit]));
        if (this.query) {
            for (const hit of this.currentItems(this.items)) {
                if (hit.messageId) merged.set(hit.taskId, hit);
            }
        }
        this.items = [...merged.values()].slice(0, this.limit);
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
    private currentItems(items: TaskSearchHit[]): TaskSearchHit[] {
        const tasks = new Map(
            this.options
                .getTasks()
                .filter((task) => task.internal !== true)
                .map((task) => [task.task_id, task])
        );
        return items
            .filter((item) => tasks.has(item.taskId))
            .map((item) => ({
                ...item,
                title: tasks.get(item.taskId)!.task_name ?? item.title,
                workspace: tasks.get(item.taskId)!.workspace ?? item.workspace
            }));
    }
    private quickResults(): TaskSearchHit[] {
        const query = this.query;
        return this.options
            .getTasks()
            .filter((task) => task.internal !== true && Boolean(task.task_name?.trim() || task.name_pending))
            .map((task) => {
                const title = normalizeSearchText(task.task_name || '');
                const priority = query && title === query ? 3 : query && title.includes(query) ? 2 : 1;
                return { task, priority };
            })
            .filter(
                ({ task }) =>
                    !query ||
                    normalizeSearchText(task.task_name || '').includes(query) ||
                    normalizeSearchText(task.workspace || '').includes(query)
            )
            .sort(
                (a, b) => b.priority - a.priority || getTaskActivityTimestamp(b.task) - getTaskActivityTimestamp(a.task)
            )
            .slice(0, this.limit)
            .map(({ task, priority }) => ({
                taskId: task.task_id,
                title: task.task_name || '',
                workspace: task.workspace || '',
                snippet: '',
                priority
            }));
    }
    private changed(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.refreshRequested = false;
        const generation = ++this.generation;
        this.query = normalizeSearchText(this.input.value).slice(0, TASK_SEARCH_MAX_QUERY);
        this.limit = TASK_SEARCH_PAGE_SIZE;
        const cached = this.cache.get(this.query);
        this.items = cached ? this.currentItems(cached.items).slice(0, this.limit) : this.quickResults();
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
            const quick = this.quickResults();
            const mergedHits = new Map(quick.map((item) => [item.taskId, item]));
            for (const item of this.currentItems(result.items)) {
                const metadataHit = mergedHits.get(item.taskId);
                if (!item.messageId && !metadataHit) continue;
                mergedHits.set(item.taskId, { ...item, priority: Math.max(item.priority, metadataHit?.priority ?? 0) });
            }
            const activity = new Map(
                this.options.getTasks().map((task) => [task.task_id, getTaskActivityTimestamp(task)])
            );
            // Live titles remain available before the task's first disk save. A stale
            // title-only index hit must still match current metadata to stay visible.
            const incoming = [...mergedHits.values()]
                .sort(
                    (a, b) => b.priority - a.priority || (activity.get(b.taskId) || 0) - (activity.get(a.taskId) || 0)
                )
                .slice(0, this.limit);
            // Keep existing rows in place while indexing. Newly discovered tasks are
            // appended; apply final ranking once coverage is complete.
            if (result.indexing) {
                const merged = new Map(this.items.map((item) => [item.taskId, item]));
                for (const item of incoming) merged.set(item.taskId, item);
                this.items = [...merged.values()].slice(0, this.limit);
            } else {
                this.items = incoming;
            }
            this.cache.delete(this.query);
            this.cache.set(this.query, { ...result, items: this.items });
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
