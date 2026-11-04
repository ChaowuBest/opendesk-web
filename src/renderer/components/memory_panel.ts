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
import markdownCSS from '../styles/print-markdown.css?inline';
import { escapeHtml } from '../../common/utils/escape.js';
import { cjkAutolinkFix } from '../../common/markdown/cjk-autolink-fix.js';
import { createRendererTranslator, resolveRendererLocale } from '../locale.ts';
import { groupMemoriesByUpdatedAt, type MemoryListItem, type MemoryTimeGroupId } from './memory_view_model.js';

type MemoryTab = 'portrait' | 'facts';

interface UserPortraitPayload {
    raw: string;
}

interface MemoryCleanupResult {
    removed: number;
}

interface MemoryAPI {
    getUserPortrait(): Promise<UserPortraitPayload>;
    listMemories(): Promise<MemoryListItem[]>;
    updateUserPortrait(content: string): Promise<UserPortraitPayload>;
    updateMemory(uid: string, title: string, content: string): Promise<{ updated: boolean }>;
    removeMemory(uid: string): Promise<{ removed: boolean }>;
    cleanupMemories(): Promise<MemoryCleanupResult>;
}

const renderer = new Renderer();
renderer.html = (token) => {
    const raw = typeof token === 'string' ? token : (token?.raw ?? token?.text ?? '');
    return escapeHtml(raw);
};
const marked = new Marked({ renderer });
marked.use(cjkAutolinkFix);

function icon(name: 'edit' | 'refresh' | 'cleanup' | 'save' | 'close' | 'check' | 'trash'): string {
    const paths = {
        edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
        refresh: '<path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/>',
        cleanup:
            '<path d="m3 21 6-6"/><path d="m16 3 5 5-9.5 9.5a2.1 2.1 0 0 1-3 0l-2-2a2.1 2.1 0 0 1 0-3Z"/><path d="m15 9 3 3"/><path d="M5 19h4"/>',
        save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
        close: '<path d="m18 6-12 12M6 6l12 12"/>',
        check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
        trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

class MemoryPanel extends HTMLElement {
    private readonly root: ShadowRoot;
    private activeTab: MemoryTab = 'portrait';
    private portrait = '';
    private memories: MemoryListItem[] = [];
    private loading = false;
    private saving = false;
    private cleaning = false;
    private hasError = false;
    private editingPortrait = false;
    private expandedMemoryUid: string | null = null;
    private editingMemoryUid: string | null = null;
    private confirmingDeleteUid: string | null = null;
    private notice: { kind: 'success' | 'error'; text: string } | null = null;
    private noticeTimer: ReturnType<typeof setTimeout> | null = null;
    private settingUnsubscribe: (() => void) | null = null;
    private locale = resolveRendererLocale();
    private t = createRendererTranslator();
    private renderVersion = 0;

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
        if (this.noticeTimer) {
            clearTimeout(this.noticeTimer);
            this.noticeTimer = null;
        }
    }

    private get api(): MemoryAPI | undefined {
        return (window as any).memoryAPI as MemoryAPI | undefined;
    }

    private async initializeLocale(): Promise<void> {
        try {
            const api = (window as any).settingAPI;
            if (api?.loadSettingObject) {
                const setting = await api.loadSettingObject();
                this.locale = resolveRendererLocale(setting);
                this.t = createRendererTranslator(setting);
                this.render();
            }
            if (api?.onSettingChanged && !this.settingUnsubscribe) {
                this.settingUnsubscribe = api.onSettingChanged((setting: any) => {
                    this.locale = resolveRendererLocale(setting);
                    this.t = createRendererTranslator(setting);
                    this.render();
                });
            }
        } catch {
            this.locale = resolveRendererLocale();
            this.t = createRendererTranslator();
        }
    }

    private async loadMemoryData(): Promise<void> {
        this.loading = true;
        this.hasError = false;
        this.render();
        try {
            if (!this.api) {
                throw new Error('memoryAPI is unavailable');
            }
            const [portraitPayload, memoriesPayload] = await Promise.all([
                this.api.getUserPortrait(),
                this.api.listMemories()
            ]);
            this.portrait = portraitPayload.raw || '';
            this.memories = Array.isArray(memoriesPayload) ? memoriesPayload : [];
            if (this.expandedMemoryUid && !this.memories.find((m) => m.uid === this.expandedMemoryUid)) {
                this.expandedMemoryUid = null;
                this.editingMemoryUid = null;
            }
        } catch (error) {
            console.error('Failed to load memory panel data', error);
            this.hasError = true;
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
        this.editingPortrait = false;
        this.editingMemoryUid = null;
        this.expandedMemoryUid = null;
        this.confirmingDeleteUid = null;
        this.clearNotice();
        this.render();
    }

    private clearNotice(): void {
        this.notice = null;
        if (this.noticeTimer) {
            clearTimeout(this.noticeTimer);
            this.noticeTimer = null;
        }
    }

    private startNoticeTimer(): void {
        if (this.noticeTimer) {
            clearTimeout(this.noticeTimer);
        }
        this.noticeTimer = setTimeout(() => {
            const noticeEl = this.root.querySelector('.notice');
            if (noticeEl) {
                noticeEl.classList.add('leaving');
                this.noticeTimer = setTimeout(() => {
                    this.notice = null;
                    this.noticeTimer = null;
                    this.render();
                }, 150);
            } else {
                this.notice = null;
                this.noticeTimer = null;
                this.render();
            }
        }, 2850);
    }

    private showNotice(kind: 'success' | 'error', text: string): void {
        this.notice = { kind, text };
        if (this.noticeTimer) {
            clearTimeout(this.noticeTimer);
            this.noticeTimer = null;
        }
        this.render();
        this.startNoticeTimer();
    }

    private renderTabButton(tab: MemoryTab, label: string): string {
        const active = this.activeTab === tab;
        return `<button class="tab ${active ? 'active' : ''}" data-tab="${tab}" type="button" role="tab" aria-selected="${active}">${escapeHtml(label)}</button>`;
    }

    private renderState(title: string, detail: string, spinning = false): string {
        return `<div class="state">${spinning ? '<div class="spinner"></div>' : '<div class="state-icon">✦</div>'}<div class="state-title">${escapeHtml(title)}</div>${detail ? `<div class="state-detail">${escapeHtml(detail)}</div>` : ''}</div>`;
    }

    private renderPortraitMeta(): string {
        const editBtn = this.editingPortrait
            ? ''
            : `<button class="btn-s edit-btn" data-action="edit-portrait" type="button">${icon('edit')}<span>${escapeHtml(this.t('renderer.memory.edit'))}</span></button>`;
        return `<div class="pt-meta">
            <span class="eyebrow">${escapeHtml(this.t('renderer.memory.userPortrait'))}</span>
            <h2>${escapeHtml(this.t('renderer.memory.portraitTitle'))}</h2>
            <p>${escapeHtml(this.t('renderer.memory.portraitDescription'))}</p>
            ${editBtn}
        </div>`;
    }

    private renderPortraitEditor(): string {
        return `<p class="editor-hint">${escapeHtml(this.t('renderer.memory.editPortraitHint'))}</p>
            <textarea id="portrait-editor" class="ed-area ed-portrait" placeholder="${escapeHtml(this.t('renderer.memory.portraitPlaceholder'))}" ${this.saving ? 'disabled' : ''}>${escapeHtml(this.portrait)}</textarea>
            <div class="ed-actions">
                <button class="btn-s" data-action="cancel-portrait" type="button" ${this.saving ? 'disabled' : ''}>${icon('close')}<span>${escapeHtml(this.t('renderer.memory.cancel'))}</span></button>
                <button class="btn-p" data-action="save-portrait" type="button" ${this.saving ? 'disabled' : ''}>${icon('save')}<span>${escapeHtml(this.saving ? this.t('renderer.memory.saving') : this.t('renderer.memory.save'))}</span></button>
            </div>`;
    }

    private async renderPortraitBody(): Promise<string> {
        let content: string;
        if (this.loading) {
            content = this.renderState(this.t('renderer.memory.loadingPortrait'), '', true);
        } else if (this.hasError) {
            content = this.renderState(
                this.t('renderer.memory.readFailed'),
                this.t('renderer.memory.readFailedDetail')
            );
        } else if (this.editingPortrait) {
            content = this.renderPortraitEditor();
        } else if (this.portrait.trim()) {
            content = `<div class="markdown-body">${await marked.parse(this.portrait)}</div>`;
        } else {
            content = this.renderState(
                this.t('renderer.memory.emptyPortrait'),
                this.t('renderer.memory.emptyPortraitDetail')
            );
        }
        return `<div class="pt-body"><div class="pt-layout">${this.renderPortraitMeta()}<div class="pt-content">${content}</div></div></div>`;
    }

    private renderScopeLabel(scope: MemoryListItem['scope']): string {
        return scope === 'global' ? this.t('renderer.memory.globalScope') : this.t('renderer.memory.workspaceScope');
    }

    private formatShortDate(value: string): string {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) {
            return this.t('renderer.memory.unknownTime');
        }
        return new Intl.DateTimeFormat(this.locale, {
            month: 'short',
            day: 'numeric'
        }).format(date);
    }

    private formatDateTime(value: string): string {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) {
            return this.t('renderer.memory.unknownTime');
        }
        return new Intl.DateTimeFormat(this.locale, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }).format(date);
    }

    private renderTimelineCard(memory: MemoryListItem): string {
        const isSelected = this.expandedMemoryUid === memory.uid;
        const tagClass = memory.scope === 'global' ? 't-green' : 't-blue';
        const preview = memory.content.length > 100 ? memory.content.slice(0, 100) + '…' : memory.content;
        return `<div class="tl-card ${isSelected ? 'sel' : ''}" data-uid="${escapeHtml(memory.uid)}">
            <div class="tl-card-head"><span class="tag ${tagClass}">${escapeHtml(this.renderScopeLabel(memory.scope))}</span><h4>${escapeHtml(memory.title)}</h4></div>
            <div class="preview">${escapeHtml(preview)}</div>
            <div class="meta"><span>${escapeHtml(this.t('renderer.memory.heat'))} ${escapeHtml(String(memory.heat))}</span><span class="meta-dot"></span><span>${escapeHtml(this.formatShortDate(memory.updatedAt))}</span></div>
        </div>`;
    }

    private renderExpandCard(memory: MemoryListItem): string {
        const tagClass = memory.scope === 'global' ? 't-green' : 't-blue';
        return `<div class="expand-card">
            <div class="expand-head">
                <span class="tag ${tagClass}">${escapeHtml(this.renderScopeLabel(memory.scope))}</span>
                <span class="heat-tag">${escapeHtml(this.t('renderer.memory.heat'))} ${escapeHtml(String(memory.heat))}</span>
                <span class="spacer"></span>
                <button class="btn-s" data-action="edit-memory" data-uid="${escapeHtml(memory.uid)}" type="button">${icon('edit')}<span>${escapeHtml(this.t('renderer.memory.edit'))}</span></button>
                ${this.renderDeleteButton(memory)}
            </div>
            <div class="expand-title">${escapeHtml(memory.title)}</div>
            <div class="expand-body">${escapeHtml(memory.content)}</div>
            <div class="expand-foot">
                <span>${escapeHtml(this.t('renderer.memory.createdAt', { time: this.formatDateTime(memory.createdAt) }))}</span>
                <span class="meta-dot"></span>
                <span>${escapeHtml(this.t('renderer.memory.updatedAt', { time: this.formatDateTime(memory.updatedAt) }))}</span>
            </div>
        </div>`;
    }

    private renderMemoryEditor(memory: MemoryListItem): string {
        const tagClass = memory.scope === 'global' ? 't-green' : 't-blue';
        return `<div class="expand-card">
            <div class="expand-head">
                <span class="tag ${tagClass}">${escapeHtml(this.renderScopeLabel(memory.scope))}</span>
                <span class="edit-info">${escapeHtml(this.t('renderer.memory.editing'))} · ${escapeHtml(this.t('renderer.memory.heat'))} ${escapeHtml(String(memory.heat))} · ${escapeHtml(this.formatShortDate(memory.updatedAt))}</span>
                <span class="spacer"></span>
            </div>
            <div class="expand-edit">
                <label class="ed-label" for="memory-title-${escapeHtml(memory.uid)}">${escapeHtml(this.t('renderer.memory.titleLabel'))}</label>
                <input id="memory-title-${escapeHtml(memory.uid)}" class="ed-title" value="${escapeHtml(memory.title)}" maxlength="200" required ${this.saving ? 'disabled' : ''}>
                <label class="ed-label" for="memory-content-${escapeHtml(memory.uid)}">${escapeHtml(this.t('renderer.memory.contentLabel'))}</label>
                <textarea id="memory-content-${escapeHtml(memory.uid)}" class="ed-area ed-mem" required ${this.saving ? 'disabled' : ''}>${escapeHtml(memory.content)}</textarea>
                <div class="ed-actions">
                    <button class="btn-s" data-action="cancel-memory" type="button" ${this.saving ? 'disabled' : ''}>${icon('close')}<span>${escapeHtml(this.t('renderer.memory.cancel'))}</span></button>
                    <button class="btn-p" data-action="save-memory" data-uid="${escapeHtml(memory.uid)}" type="button" ${this.saving ? 'disabled' : ''}>${icon('save')}<span>${escapeHtml(this.saving ? this.t('renderer.memory.saving') : this.t('renderer.memory.save'))}</span></button>
                </div>
            </div>
        </div>`;
    }

    private renderExpandCardContent(memory: MemoryListItem): string {
        if (this.editingMemoryUid === memory.uid) {
            return this.renderMemoryEditor(memory);
        }
        return this.renderExpandCard(memory);
    }

    private groupLabel(id: MemoryTimeGroupId): string {
        return this.t(`renderer.memory.group.${id}`);
    }

    private renderTimeline(): string {
        return `<div class="facts-top">
            <div><h2>${escapeHtml(this.t('renderer.memory.factsTitle'))}</h2><p>${escapeHtml(this.t('renderer.memory.factsDescription'))}</p></div>
            <span class="count-pill">${escapeHtml(this.t('renderer.memory.count', { count: this.memories.length }))}</span>
        </div>
        <div class="timeline">
            ${groupMemoriesByUpdatedAt(this.memories)
                .map(
                    (group) =>
                        `<div class="tl-group"><div class="tl-group-label">${escapeHtml(this.groupLabel(group.id))}<span class="cnt">${group.memories.length}</span></div>${group.memories
                            .map(
                                (memory) =>
                                    `<div class="mem-row" data-scope="${memory.scope}">${this.renderTimelineCard(memory)}<div class="expand-col">${this.expandedMemoryUid === memory.uid ? this.renderExpandCardContent(memory) : ''}</div></div>`
                            )
                            .join('')}</div>`
                )
                .join('')}
        </div>`;
    }

    private renderFactsBody(): string {
        let content: string;
        if (this.loading) {
            content = this.renderState(this.t('renderer.memory.loadingFacts'), '', true);
        } else if (this.hasError) {
            content = this.renderState(
                this.t('renderer.memory.readFailed'),
                this.t('renderer.memory.readFailedDetail')
            );
        } else if (this.memories.length === 0) {
            content = this.renderState(
                this.t('renderer.memory.emptyFacts'),
                this.t('renderer.memory.emptyFactsDetail')
            );
        } else {
            content = this.renderTimeline();
        }
        return `<div class="facts-body">${content}</div>`;
    }

    private async renderBody(): Promise<string> {
        return this.activeTab === 'portrait' ? await this.renderPortraitBody() : this.renderFactsBody();
    }

    private renderHeaderActions(): string {
        const cleanup =
            this.activeTab === 'facts'
                ? `<button class="btn-s" data-action="cleanup" type="button" ${this.cleaning ? 'disabled' : ''}>${icon('cleanup')}<span>${escapeHtml(this.cleaning ? this.t('renderer.memory.cleaning') : this.t('renderer.memory.cleanup'))}</span></button>`
                : '';
        return `${cleanup}<button class="iconbtn" data-action="refresh" type="button" title="${escapeHtml(this.t('renderer.memory.refresh'))}" aria-label="${escapeHtml(this.t('renderer.memory.refresh'))}" ${this.loading ? 'disabled' : ''}>${icon('refresh')}</button>`;
    }

    private renderNotice(): string {
        if (!this.notice) {
            return '';
        }
        const iconSvg = this.notice.kind === 'success' ? icon('check') : icon('close');
        return `<div class="notice ${this.notice.kind}" role="status" aria-live="polite">${iconSvg}<span>${escapeHtml(this.notice.text)}</span></div>`;
    }

    private async savePortrait(): Promise<void> {
        const editor = this.root.querySelector<HTMLTextAreaElement>('#portrait-editor');
        if (!editor || !this.api) {
            return;
        }
        this.saving = true;
        this.render();
        try {
            const payload = await this.api.updateUserPortrait(editor.value);
            this.portrait = payload.raw || '';
            this.editingPortrait = false;
            this.saving = false;
            this.showNotice('success', this.t('renderer.memory.portraitSaved'));
        } catch (error) {
            console.error('Failed to save user portrait', error);
            this.saving = false;
            this.showNotice('error', this.t('renderer.memory.saveFailed'));
        }
    }

    private async saveMemory(uid: string): Promise<void> {
        const memory = this.memories.find((item) => item.uid === uid);
        const title = this.root.querySelector<HTMLInputElement>(`#memory-title-${CSS.escape(uid)}`);
        const content = this.root.querySelector<HTMLTextAreaElement>(`#memory-content-${CSS.escape(uid)}`);
        if (!memory || !title || !content || !this.api) {
            return;
        }
        if (!title.reportValidity() || !content.reportValidity()) {
            return;
        }
        this.saving = true;
        this.render();
        try {
            const result = await this.api.updateMemory(uid, title.value, content.value);
            if (!result.updated) {
                throw new Error('memory not found');
            }
            this.editingMemoryUid = null;
            this.saving = false;
            this.notice = { kind: 'success', text: this.t('renderer.memory.memorySaved') };
            await this.loadMemoryData();
            this.startNoticeTimer();
        } catch (error) {
            console.error('Failed to save memory', error);
            this.saving = false;
            this.showNotice('error', this.t('renderer.memory.saveFailed'));
        }
    }

    private async cleanupMemories(): Promise<void> {
        if (!this.api || this.cleaning) {
            return;
        }
        this.cleaning = true;
        this.render();
        try {
            const result = await this.api.cleanupMemories();
            this.cleaning = false;
            this.expandedMemoryUid = null;
            this.editingMemoryUid = null;
            this.confirmingDeleteUid = null;
            this.notice = {
                kind: 'success',
                text: result.removed
                    ? this.t('renderer.memory.cleanupDone', { count: result.removed })
                    : this.t('renderer.memory.cleanupNone')
            };
            await this.loadMemoryData();
            this.startNoticeTimer();
        } catch (error) {
            console.error('Failed to clean up memories', error);
            this.cleaning = false;
            this.showNotice('error', this.t('renderer.memory.cleanupFailed'));
        }
    }

    private async deleteMemory(uid: string): Promise<void> {
        if (!this.api) {
            return;
        }
        const scrollTop = this.root.querySelector('.facts-body')?.scrollTop ?? 0;
        this.saving = true;
        this.render();
        try {
            await this.api.removeMemory(uid);
            this.memories = this.memories.filter((m) => m.uid !== uid);
            this.expandedMemoryUid = null;
            this.editingMemoryUid = null;
            this.confirmingDeleteUid = null;
            this.saving = false;
            this.notice = { kind: 'success', text: this.t('renderer.memory.memoryDeleted') };
            this.render();
            const newFactsBody = this.root.querySelector('.facts-body');
            if (newFactsBody) {
                newFactsBody.scrollTop = scrollTop;
            }
            this.startNoticeTimer();
        } catch (error) {
            console.error('Failed to delete memory', error);
            this.saving = false;
            this.showNotice('error', this.t('renderer.memory.deleteFailed'));
        }
    }

    private toggleMemoryExpand(uid: string): void {
        const wasExpanded = this.expandedMemoryUid === uid;
        this.root.querySelectorAll('.tl-card').forEach((card) => card.classList.remove('sel'));
        this.root.querySelectorAll('.expand-col').forEach((col) => (col.innerHTML = ''));
        this.editingMemoryUid = null;
        if (wasExpanded) {
            this.expandedMemoryUid = null;
            this.confirmingDeleteUid = null;
            return;
        }
        this.expandedMemoryUid = uid;
        const memory = this.memories.find((m) => m.uid === uid);
        if (!memory) {
            return;
        }
        const card = this.root.querySelector<HTMLElement>(`.tl-card[data-uid="${CSS.escape(uid)}"]`);
        const expandCol = card?.closest('.mem-row')?.querySelector('.expand-col');
        if (card && expandCol) {
            card.classList.add('sel');
            expandCol.innerHTML = this.renderExpandCard(memory);
            this.bindExpandCardEvents(expandCol);
        }
    }

    private enterMemoryEdit(uid: string): void {
        this.editingMemoryUid = uid;
        const memory = this.memories.find((m) => m.uid === uid);
        if (!memory) {
            return;
        }
        const expandCol = this.root
            .querySelector(`.tl-card[data-uid="${CSS.escape(uid)}"]`)
            ?.closest('.mem-row')
            ?.querySelector('.expand-col');
        if (expandCol) {
            expandCol.innerHTML = this.renderMemoryEditor(memory);
            this.bindExpandCardEvents(expandCol);
        }
    }

    private cancelMemoryEdit(): void {
        const uid = this.editingMemoryUid;
        this.editingMemoryUid = null;
        if (!uid) {
            return;
        }
        this.rerenderExpandCardFull(uid);
    }

    private rerenderExpandCardFull(uid: string): void {
        const memory = this.memories.find((m) => m.uid === uid);
        if (!memory) {
            return;
        }
        const expandCol = this.root
            .querySelector(`.tl-card[data-uid="${CSS.escape(uid)}"]`)
            ?.closest('.mem-row')
            ?.querySelector('.expand-col');
        if (expandCol) {
            expandCol.innerHTML = this.renderExpandCard(memory);
            this.bindExpandCardEvents(expandCol);
        }
    }

    private renderDeleteButton(memory: MemoryListItem): string {
        const isConfirming = this.confirmingDeleteUid === memory.uid;
        return isConfirming
            ? `<button class="btn-p confirm-delete" data-action="confirm-delete" data-uid="${escapeHtml(memory.uid)}" type="button">${icon('trash')}<span>${escapeHtml(this.t('renderer.memory.confirmDelete'))}</span></button>`
            : `<button class="btn-s danger" data-action="delete-memory" data-uid="${escapeHtml(memory.uid)}" type="button">${icon('trash')}<span>${escapeHtml(this.t('renderer.memory.delete'))}</span></button>`;
    }

    private swapDeleteButton(uid: string): void {
        const memory = this.memories.find((m) => m.uid === uid);
        if (!memory) {
            return;
        }
        const expandCol = this.root
            .querySelector(`.tl-card[data-uid="${CSS.escape(uid)}"]`)
            ?.closest('.mem-row')
            ?.querySelector('.expand-col');
        if (!expandCol) {
            return;
        }
        const oldBtn = expandCol.querySelector('[data-action="delete-memory"], [data-action="confirm-delete"]');
        if (!oldBtn) {
            return;
        }
        const wrapper = document.createElement('div');
        wrapper.innerHTML = this.renderDeleteButton(memory);
        const newBtn = wrapper.firstElementChild as HTMLButtonElement;
        oldBtn.replaceWith(newBtn);
        this.bindDeleteButtonEvents(newBtn);
    }

    private handleConfirmOutside = (event: Event): void => {
        const target = event.target as HTMLElement;
        if (target.closest('[data-action="confirm-delete"]') || target.closest('[data-action="delete-memory"]')) {
            return;
        }
        if (this.confirmingDeleteUid) {
            const uid = this.confirmingDeleteUid;
            this.confirmingDeleteUid = null;
            this.swapDeleteButton(uid);
        }
    };

    private bindDeleteButtonEvents(btn: HTMLButtonElement): void {
        const action = btn.dataset.action;
        const uid = btn.dataset.uid;
        if (!uid) {
            return;
        }
        if (action === 'delete-memory') {
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                this.confirmingDeleteUid = uid;
                this.swapDeleteButton(uid);
                this.root.addEventListener('click', this.handleConfirmOutside, { capture: true, once: true });
            });
        } else if (action === 'confirm-delete') {
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                this.confirmingDeleteUid = null;
                void this.deleteMemory(uid);
            });
        }
    }

    private bindExpandCardEvents(container: ParentNode): void {
        container.querySelectorAll<HTMLButtonElement>('[data-action="edit-memory"]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const uid = btn.dataset.uid;
                if (uid) {
                    this.enterMemoryEdit(uid);
                }
            });
        });
        container.querySelectorAll<HTMLButtonElement>('[data-action="delete-memory"]').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                const uid = btn.dataset.uid;
                if (uid) {
                    this.confirmingDeleteUid = uid;
                    this.swapDeleteButton(uid);
                    this.root.addEventListener('click', this.handleConfirmOutside, { capture: true, once: true });
                }
            });
        });
        container.querySelectorAll<HTMLButtonElement>('[data-action="confirm-delete"]').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                const uid = btn.dataset.uid;
                if (uid) {
                    this.confirmingDeleteUid = null;
                    void this.deleteMemory(uid);
                }
            });
        });
        container.querySelector<HTMLButtonElement>('[data-action="cancel-memory"]')?.addEventListener('click', () => {
            this.cancelMemoryEdit();
        });
        container.querySelectorAll<HTMLButtonElement>('[data-action="save-memory"]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const uid = btn.dataset.uid;
                if (uid) {
                    void this.saveMemory(uid);
                }
            });
        });
    }

    private bindEvents(): void {
        this.root.querySelectorAll<HTMLButtonElement>('.tab[data-tab]').forEach((button) => {
            button.addEventListener('click', () => {
                const tab = button.dataset.tab;
                if (tab === 'portrait' || tab === 'facts') {
                    this.switchTab(tab);
                }
            });
        });
        this.root.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.addEventListener('click', () => {
            this.editingPortrait = false;
            this.editingMemoryUid = null;
            this.expandedMemoryUid = null;
            this.confirmingDeleteUid = null;
            void this.loadMemoryData();
        });
        this.root.querySelector<HTMLButtonElement>('[data-action="cleanup"]')?.addEventListener('click', () => {
            void this.cleanupMemories();
        });
        this.root.querySelector<HTMLButtonElement>('[data-action="edit-portrait"]')?.addEventListener('click', () => {
            this.editingPortrait = true;
            this.clearNotice();
            this.render();
        });
        this.root.querySelector<HTMLButtonElement>('[data-action="cancel-portrait"]')?.addEventListener('click', () => {
            this.editingPortrait = false;
            this.render();
        });
        this.root.querySelector<HTMLButtonElement>('[data-action="save-portrait"]')?.addEventListener('click', () => {
            void this.savePortrait();
        });
        this.root.querySelectorAll<HTMLElement>('.tl-card[data-uid]').forEach((card) => {
            card.addEventListener('click', () => {
                const uid = card.dataset.uid;
                if (uid) {
                    this.toggleMemoryExpand(uid);
                }
            });
        });
        this.bindExpandCardEvents(this.root);
    }

    private render(): void {
        const version = ++this.renderVersion;
        const factsBody = this.root.querySelector('.facts-body');
        const scrollTop = factsBody?.scrollTop ?? 0;
        void this.renderBody().then((body) => {
            if (version !== this.renderVersion) {
                return;
            }
            this.root.innerHTML = `<style>${markdownCSS}${this.styles()}</style>
                <div class="memory-panel">
                    <header class="tabs-bar">
                        <div class="tabs" role="tablist" aria-label="${escapeHtml(this.t('renderer.memory.system'))}">
                            ${this.renderTabButton('portrait', this.t('renderer.memory.userPortrait'))}
                            ${this.renderTabButton('facts', this.t('renderer.memory.facts'))}
                        </div>
                        <div class="tab-actions">${this.renderHeaderActions()}</div>
                    </header>
                    ${this.renderNotice()}
                    <main class="panel-body">${body}</main>
                </div>`;
            this.bindEvents();
            const newFactsBody = this.root.querySelector('.facts-body');
            if (newFactsBody && scrollTop > 0) {
                newFactsBody.scrollTop = scrollTop;
            }
        });
    }

    private styles(): string {
        return `
            :host { display: block; height: 100%; min-height: 420px; }
            * { box-sizing: border-box; }
            button, input, textarea { font: inherit; }
            button, input, select, option, optgroup, textarea { font-family: inherit; }
            button { cursor: pointer; }
            button:disabled { cursor: default; opacity: .56; }
            h2, h3, h4, p { margin: 0; }

            /* ===== Design Tokens (light) ===== */
            .memory-panel {
                --bg: #f5f4f2; --page: #fbfaf8; --card: #fff; --card-hover: #f5f4f2;
                --line: #e7e5e2; --line-soft: #efeeea;
                --ink: #1c1917; --ink2: #4a4642; --ink3: #8a8580; --ink4: #b4afa9;
                --accent: #df4436; --accent-soft: #fdeeec; --accent-bg: #fef9f8; --accent-hover: #e8563f;
                --green: #1f9d66; --green-soft: #e7f5ee;
                --blue: #4267b2; --blue-soft: #ebf1fb;
                --red: #dc2626; --red-soft: #fef2f2;
                --shadow-card: 0 12px 40px rgba(0,0,0,.1), 0 0 1px rgba(0,0,0,.06);
                --shadow-soft: 0 8px 32px rgba(0,0,0,.08), 0 1px 3px rgba(0,0,0,.04);
                --mono: 'SF Mono', ui-monospace, Menlo, Consolas, monospace;
                height: 100%; min-height: 420px; position: relative;
                display: flex; flex-direction: column; overflow: hidden;
                background: var(--bg); color: var(--ink); font-size: 13px;
                font-family: var(--font-sans);
            }

            /* ===== Design Tokens (dark) ===== */
            :host-context(html[data-theme='dark']) .memory-panel {
                --bg: #232120; --page: #1b1a18; --card: #2a2826; --card-hover: #33302d;
                --line: #3b3835; --line-soft: #33302d;
                --ink: #efedea; --ink2: #d5d1cb; --ink3: #9b968f; --ink4: #6f6a63;
                --accent: #e8563f; --accent-soft: rgba(232,86,63,.16); --accent-bg: rgba(232,86,63,.09); --accent-hover: #ed6b56;
                --green: #3dbf82; --green-soft: rgba(61,191,130,.15);
                --blue: #7aa2e8; --blue-soft: rgba(122,162,232,.16);
                --red: #e85a5a; --red-soft: rgba(232,90,90,.15);
                --shadow-card: 0 12px 40px rgba(0,0,0,.5), 0 0 1px rgba(0,0,0,.2);
                --shadow-soft: 0 8px 32px rgba(0,0,0,.3), 0 1px 3px rgba(0,0,0,.2);
            }

            /* ===== Tab Bar ===== */
            .tabs-bar {
                flex: none; height: 72px; padding: 24px 24px 0;
                display: flex; align-items: center;
                border-bottom: 1px solid var(--line);
            }
            .tabs { display: flex; gap: 24px; height: 48px; align-items: center; }
            .tab {
                font-size: 13px; font-weight: 500; color: var(--ink3);
                cursor: pointer; border: 0; background: none; font-family: inherit;
                padding: 0; position: relative; transition: color .15s;
                height: 100%; display: flex; align-items: center;
            }
            .tab:hover { color: var(--ink2); }
            .tab.active { color: var(--ink); font-weight: 650; }
            .tab.active::after {
                content: ''; position: absolute; left: 0; right: 0; bottom: -1px;
                height: 2px; background: var(--accent); border-radius: 1px;
            }
            .tab-actions { display: flex; gap: 8px; margin-left: 20px; }

            /* ===== Panel Body ===== */
            .panel-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }

            /* ===== Portrait Layout ===== */
            .pt-body { flex: 1; min-height: 0; overflow: hidden; }
            .facts-body::-webkit-scrollbar { width: 8px; }
            .facts-body::-webkit-scrollbar-track { background: transparent; }
            .facts-body::-webkit-scrollbar-thumb { border-radius: 8px; background: rgba(0,0,0,0.12); }
            .facts-body::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.22); }
            :host-context(html[data-theme='dark']) .facts-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); }
            :host-context(html[data-theme='dark']) .facts-body::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.28); }
            .ed-area::-webkit-scrollbar { width: 8px; }
            .ed-area::-webkit-scrollbar-track { background: transparent; }
            .ed-area::-webkit-scrollbar-thumb { border-radius: 4px; background: #d1d5db; }
            :host-context(html[data-theme='dark']) .ed-area::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); }
            :host-context(html[data-theme='dark']) .ed-area::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.28); }
            .pt-layout { display: flex; height: 100%; }
            .pt-meta {
                flex: none; width: 240px; padding: 28px 24px;
                border-right: 1px solid var(--line-soft);
                background: linear-gradient(180deg, var(--card), var(--bg));
            }
            .pt-meta .eyebrow {
                font-size: 10px; font-weight: 700; color: var(--accent);
                letter-spacing: .08em; text-transform: uppercase;
            }
            .pt-meta h2 { font-size: 17px; font-weight: 650; margin-top: 6px; }
            .pt-meta p { font-size: 12px; color: var(--ink3); margin-top: 8px; line-height: 1.6; }
            .pt-meta .edit-btn { margin-top: 16px; }
            .pt-content { flex: 1; padding: 28px 32px; min-width: 0; display: flex; flex-direction: column; overflow: auto; }
            .pt-content::-webkit-scrollbar { width: 8px; }
            .pt-content::-webkit-scrollbar-track { background: transparent; }
            .pt-content::-webkit-scrollbar-thumb { border-radius: 8px; background: rgba(0,0,0,0.12); }
            .pt-content::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.22); }
            :host-context(html[data-theme='dark']) .pt-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); }
            :host-context(html[data-theme='dark']) .pt-content::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.28); }
            .editor-hint { font-size: 12px; color: var(--ink3); margin-bottom: 14px; line-height: 1.6; flex: none; }

            /* ===== Markdown Body ===== */
            .markdown-body {
                color: var(--ink2); line-height: 1.75; font-size: 13px;
                --md-text: var(--ink2); --md-heading: var(--ink); --md-link: var(--accent);
                --md-code-bg: var(--card-hover); --md-code-text: var(--accent);
            }
            .markdown-body :first-child { margin-top: 0; }
            .markdown-body :last-child { margin-bottom: 0; }
            :host-context(html[data-theme='dark']) .markdown-body {
                --md-table-border: var(--line); --md-table-header-bg: var(--card-hover);
                --md-table-stripe-bg: var(--bg); --md-blockquote-text: var(--ink3);
                --md-inline-code-bg: var(--card-hover);
            }

            /* ===== Facts Layout ===== */
            .facts-body { flex: 1; min-height: 0; overflow: auto; padding: 20px 24px 32px; }
            .facts-top {
                display: flex; align-items: baseline; justify-content: space-between;
                gap: 16px; margin-bottom: 18px; padding: 0 2px;
            }
            .facts-top h2 { font-size: 16px; font-weight: 650; }
            .facts-top p { font-size: 12px; color: var(--ink3); margin-top: 3px; }

            /* ===== Timeline ===== */
            .timeline { position: relative; padding-left: 22px; }
            .timeline::before {
                content: ''; position: absolute; left: 5px; top: 6px; bottom: 6px;
                width: 1.5px; background: var(--line);
            }
            .tl-group { margin-bottom: 22px; }
            .tl-group-label {
                font-size: 11px; font-weight: 700; color: var(--ink3);
                text-transform: uppercase; letter-spacing: .06em; margin-bottom: 10px;
                position: relative; padding-left: 2px;
            }
            .tl-group-label .cnt { font-size: 10.5px; color: var(--ink4); font-weight: 600; margin-left: 6px; }
            .tl-group-label::before {
                content: ''; position: absolute; left: -21px; top: 4px;
                width: 9px; height: 9px; border-radius: 50%;
                background: var(--card); border: 2px solid var(--accent);
            }
            .mem-row { position: relative; margin-bottom: 10px; display: flex; gap: 16px; align-items: flex-start; }
            .mem-row:has(.expand-card) { z-index: 10; }
            .mem-row::before {
                content: ''; position: absolute; left: -21px; top: 20px;
                width: 7px; height: 7px; border-radius: 50%;
                background: var(--card); border: 2px solid var(--blue); z-index: 2;
            }
            .mem-row[data-scope='global']::before { border-color: var(--green); }

            /* ===== Timeline Card ===== */
            .tl-card {
                width: 44%; flex: none; padding: 13px 16px; border-radius: 10px;
                background: var(--card); border: 1px solid var(--line-soft);
                cursor: pointer; transition: all .18s;
            }
            .tl-card:hover { border-color: var(--line); box-shadow: 0 2px 10px rgba(0,0,0,.05); }
            .tl-card.sel { opacity: .5; }
            .tl-card-head { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
            .tl-card h4 {
                font-size: 12.5px; font-weight: 600; color: var(--ink);
                flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            .tl-card .preview {
                font-size: 11.5px; color: var(--ink4); line-height: 1.5;
                display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
            }
            .tl-card .meta {
                font-size: 10.5px; color: var(--ink4); margin-top: 6px;
                display: flex; align-items: center; gap: 6px;
            }

            /* ===== Expand Card ===== */
            .expand-col { position: absolute; left: calc(44% + 16px); right: 0; top: 0; z-index: 10; }
            .expand-card {
                background: var(--card); border: 1px solid var(--line); border-radius: 12px;
                box-shadow: var(--shadow-card); overflow: hidden;
                animation: expand-in .25s cubic-bezier(0.23,1,0.32,1);
            }
            @keyframes expand-in {
                from { opacity: 0; transform: translateY(-6px) scale(.98); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
            .expand-head {
                display: flex; align-items: center; gap: 8px; padding: 14px 18px;
                border-bottom: 1px solid var(--line-soft);
            }
            .expand-head .spacer { flex: 1; }
            .expand-title { font-size: 15px; font-weight: 650; color: var(--ink); padding: 16px 18px 4px; line-height: 1.4; }
            .expand-body {
                font-size: 13px; line-height: 1.72; color: var(--ink2);
                padding: 8px 18px 16px; white-space: pre-wrap; overflow-wrap: anywhere;
            }
            .expand-foot {
                display: flex; align-items: center; gap: 10px; padding: 12px 18px;
                border-top: 1px solid var(--line-soft); font-size: 11px; color: var(--ink4);
            }
            .heat-tag { font-size: 10px; font-weight: 700; color: var(--accent); background: var(--accent-soft); padding: 2px 8px; border-radius: 5px; }
            .edit-info { font-size: 11px; color: var(--ink4); }
            .expand-edit { padding: 18px; }

            /* ===== Edit Form ===== */
            .ed-label { display: block; font-size: 11px; font-weight: 600; color: var(--ink3); margin-bottom: 5px; }
            .ed-label:not(:first-child) { margin-top: 14px; }
            .ed-title {
                width: 100%; height: 36px; border: 1px solid var(--line); border-radius: 8px;
                padding: 0 11px; font-size: 13px; font-weight: 600; color: var(--ink);
                background: var(--bg); font-family: inherit;
            }
            .ed-title:focus { border-color: var(--accent); outline: none; }
            .ed-area {
                width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 12px;
                font-size: 12.5px; line-height: 1.65; color: var(--ink2);
                background: var(--card); resize: none; font-family: inherit;
            }
            .ed-area:focus { border-color: var(--accent); outline: none; }
            .ed-portrait { flex: 1; min-height: 280px; font-size: 13px; }
            .ed-mem { min-height: 160px; }
            .ed-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; flex: none; }

            /* ===== Common Components ===== */
            .tag { font-size: 10px; padding: 1px 7px; border-radius: 5px; font-weight: 500; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
            .t-blue { background: var(--blue-soft); color: var(--blue); }
            .t-green { background: var(--green-soft); color: var(--green); }
            .btn-p {
                background: var(--accent); color: #fff; border: 0; border-radius: 8px;
                padding: 7px 16px; font-family: inherit; font-size: 12.5px; font-weight: 600;
                cursor: pointer; transition: background .15s;
                display: inline-flex; align-items: center; gap: 6px;
            }
            .btn-p:hover:not(:disabled) { background: var(--accent-hover); }
            .btn-s {
                background: var(--card); color: var(--ink2); border: 1px solid var(--line); border-radius: 8px;
                padding: 6px 15px; font-family: inherit; font-size: 12.5px; font-weight: 500;
                cursor: pointer; transition: all .15s;
                display: inline-flex; align-items: center; gap: 6px;
            }
            .btn-s:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
            .btn-s.danger:hover:not(:disabled) { border-color: var(--red); color: var(--red); }
            .btn-p.confirm-delete { background: var(--red); }
            .btn-p.confirm-delete:hover:not(:disabled) { background: var(--red); filter: brightness(1.1); }
            .iconbtn {
                width: 30px; height: 30px; border: 1px solid var(--line); border-radius: 8px;
                background: var(--card); color: var(--ink3); cursor: pointer;
                display: flex; align-items: center; justify-content: center; transition: all .15s;
            }
            .iconbtn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
            svg { display: block; }
            .btn-s svg, .btn-p svg { width: 13px; height: 13px; flex: none; }
            .iconbtn svg { width: 14px; height: 14px; }
            button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
            .count-pill { padding: 4px 10px; border-radius: 999px; color: var(--ink3); background: var(--card-hover); font-size: 11px; font-weight: 600; flex: none; }
            .meta-dot { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .5; }

            /* ===== Notice ===== */
            .notice {
                position: absolute; top: 80px; left: 50%; transform: translateX(-50%);
                padding: 9px 16px; border-radius: 8px; font-size: 12px; z-index: 100;
                display: flex; align-items: center; gap: 8px;
                box-shadow: var(--shadow-soft);
                animation: notice-in .2s ease-out;
            }
            @keyframes notice-in { from { opacity: 0; transform: translateX(-50%) translateY(-8px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
            .notice.leaving { animation: notice-out .15s ease-in forwards; }
            @keyframes notice-out { from { opacity: 1; transform: translateX(-50%); } to { opacity: 0; transform: translateX(-50%); } }
            .notice.success { color: var(--green); background: var(--green-soft); }
            .notice.error { color: var(--red); background: var(--red-soft); }
            .notice svg { width: 14px; height: 14px; flex: none; }

            /* ===== State / Empty / Loading ===== */
            .state {
                flex: 1; min-height: 280px;
                display: flex; flex-direction: column; align-items: center; justify-content: center;
                gap: 8px; text-align: center; color: var(--ink3);
            }
            .state-icon, .spinner { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; margin-bottom: 4px; }
            .state-icon { color: var(--accent); background: var(--accent-soft); font-size: 18px; }
            .spinner { background: radial-gradient(circle, var(--accent), var(--accent-soft)); animation: breathe 1.5s ease-in-out infinite; }
            @keyframes breathe { 0%,100% { opacity: .4; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.1); } }
            .state-title { color: var(--ink); font-size: 15px; font-weight: 650; }
            .state-detail { max-width: 480px; font-size: 12px; line-height: 1.65; }

            /* ===== Responsive ===== */
            @media (max-width: 700px) {
                .tabs-bar { padding: 0 14px; }
                .pt-meta { width: 180px; padding: 20px 16px; }
                .pt-content { padding: 20px; }
                .facts-body { padding: 16px; }
                .mem-row { flex-direction: column; }
                .tl-card { width: 100%; }
                .expand-col { width: 100%; }
            }

            /* ===== Reduced Motion ===== */
            @media (prefers-reduced-motion: reduce) {
                .expand-card, .notice, .spinner { animation: none; }
                .tab, .tl-card, .btn-p, .btn-s, .iconbtn { transition: none; }
            }
        `;
    }
}

customElements.define('memory-panel', MemoryPanel);
