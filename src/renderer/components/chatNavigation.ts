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

import './chatNavigation.css';

export interface ConversationStop {
    id: string;
    title: string;
    preview: string;
}

interface HistoryMessage {
    role: string;
    message_id?: string;
    content?: { type: string; text?: string; rendered?: string }[];
}

function compactText(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 600);
}

function partText(part: { text?: string; rendered?: string }): string {
    if (part.rendered) {
        const template = document.createElement('template');
        template.innerHTML = part.rendered;
        template.content.querySelectorAll('script,style').forEach((node) => node.remove());
        return Array.from(template.content.childNodes)
            .map((node) => node.textContent || '')
            .join(' ');
    }
    return part.text || '';
}

export function buildConversationStops(
    messages: HistoryMessage[],
    isVisible: (message: HistoryMessage) => boolean,
    attachmentLabel = '',
    userText?: (message: HistoryMessage) => string | undefined
): ConversationStop[] {
    const stops: ConversationStop[] = [];
    let current: ConversationStop | undefined;
    for (const message of messages) {
        if (message.role === 'user') {
            if (!message.message_id || !isVisible(message)) continue;
            current = {
                id: message.message_id,
                title:
                    compactText(
                        userText?.(message) ??
                            (message.content || [])
                                .filter((part) => part.type === 'text')
                                .map(partText)
                                .join(' ')
                    ) || attachmentLabel,
                preview: ''
            };
            stops.push(current);
        } else if (message.role === 'assistant' && current && current.preview.length < 600) {
            current.preview = compactText(
                [current.preview, ...(message.content || []).filter((part) => part.type === 'text').map(partText)].join(
                    ' '
                )
            );
        }
    }
    return stops;
}

function readRenderedStop(user: HTMLElement, attachmentLabel: string): ConversationStop {
    const title =
        compactText(
            Array.from(user.querySelectorAll('.od-user-msg'))
                .map((el) => el.textContent || '')
                .join(' ')
        ) || attachmentLabel;
    let preview = '';
    for (let sibling = user.nextElementSibling; sibling && preview.length < 600; sibling = sibling.nextElementSibling) {
        if (sibling.matches('.od-user-msg-container')) break;
        if (!sibling.matches('.od-assistant-msg-container')) continue;
        const content = sibling.querySelector('[id^="message-content-"]');
        if (!content) continue;
        const text = Array.from(content.children)
            .filter((el) => el.matches('.markdown-body'))
            .map((el) => el.textContent || '')
            .join(' ');
        preview = compactText(`${preview} ${text}`);
    }
    return { id: user.dataset.messageId!, title, preview };
}

/** Merge live DOM text without indexing tool output, reasoning, or pending input cards. */
export function mergeRenderedConversationStops(
    stops: ConversationStop[],
    history: HTMLElement,
    attachmentLabel: string
): ConversationStop[] {
    const result = stops.map((stop) => ({ ...stop }));
    const byId = new Map(result.map((stop, index) => [stop.id, index]));
    for (const child of Array.from(history.children)) {
        if (!child.matches('.od-user-msg-container[data-message-id]')) continue;
        const stop = readRenderedStop(child as HTMLElement, attachmentLabel);
        const index = byId.get(stop.id);
        if (index === undefined) {
            byId.set(stop.id, result.length);
            result.push(stop);
        } else {
            result[index] = stop;
        }
    }
    return result;
}

interface NavigationOptions {
    navigate: (id: string) => void;
    translate: (key: string, params?: Record<string, string | number>) => string;
    refresh?: () => ConversationStop[];
}

export class ChatNavigation {
    private root = document.createElement('nav');
    private rail = document.createElement('div');
    private preview = document.createElement('div');
    private title = document.createElement('div');
    private answer = document.createElement('div');
    private stops: ConversationStop[] = [];
    private buttons: HTMLButtonElement[] = [];
    private hovered = -1;
    private active = -1;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private contentDirty = false;
    private positionDirty = false;
    private anchorsDirty = true;
    private anchors: { index: number; element: HTMLElement }[] = [];
    private destroyed = false;
    private observer: MutationObserver;
    private resizeObserver?: ResizeObserver;

    constructor(
        private history: HTMLElement,
        private options: NavigationOptions
    ) {
        this.root.className = 'od-chat-nav';
        this.root.setAttribute('aria-label', options.translate('renderer.taskview.navigation.label'));
        this.rail.className = 'od-chat-nav-rail';
        this.preview.className = 'od-chat-nav-preview';
        this.preview.hidden = true;
        this.preview.setAttribute('aria-hidden', 'true');
        this.title.className = 'od-chat-nav-title';
        this.answer.className = 'od-chat-nav-answer';
        this.preview.append(this.title, this.answer);
        this.root.append(this.rail, this.preview);
        history.parentElement?.append(this.root);
        this.rail.addEventListener('pointerleave', this.hidePreview);
        this.rail.addEventListener('scroll', this.onRailScroll, { passive: true });
        history.addEventListener('scroll', this.onScroll, { passive: true });
        this.observer = new MutationObserver(this.onHistoryMutation);
        this.observer.observe(history, { subtree: true, childList: true, characterData: true });
        if (typeof window.ResizeObserver === 'function') {
            this.resizeObserver = new window.ResizeObserver(this.onScroll);
            this.resizeObserver.observe(history);
            this.resizeObserver.observe(this.preview);
        }
    }

    setStops(stops: ConversationStop[]): void {
        const structureChanged =
            stops.length !== this.stops.length || stops.some((stop, i) => stop.id !== this.stops[i].id);
        this.stops = stops;
        this.anchorsDirty = true;
        this.root.hidden = stops.length < 2;
        this.history.classList.toggle('od-chat-has-nav', stops.length >= 2);
        if (structureChanged) {
            const hoveredId = this.buttons[this.hovered]?.dataset.messageId;
            const focusedButton = this.rail.contains(document.activeElement) ? document.activeElement : null;
            const existing = new Map(this.buttons.map((button) => [button.dataset.messageId, button]));
            this.buttons = stops.map((stop) => existing.get(stop.id) || this.createButton(stop.id));
            const retained = new Set(this.buttons);
            existing.forEach((button) => {
                if (!retained.has(button)) button.remove();
            });
            // Append-only updates must not detach the focused or hovered button.
            this.buttons.forEach((button, index) => {
                if (this.rail.children[index] !== button) {
                    this.rail.insertBefore(button, this.rail.children[index] || null);
                }
            });
            if (
                focusedButton instanceof HTMLElement &&
                retained.has(focusedButton as HTMLButtonElement) &&
                document.activeElement !== focusedButton
            ) {
                focusedButton.focus({ preventScroll: true });
            }
            this.hovered = hoveredId ? stops.findIndex((stop) => stop.id === hoveredId) : -1;
            if (this.hovered < 0) this.hidePreview();
        }
        this.buttons.forEach((button, i) =>
            button.setAttribute(
                'aria-label',
                this.options.translate('renderer.taskview.navigation.jump', { number: i + 1, text: stops[i].title })
            )
        );
        this.updateActive();
        if (this.hovered >= 0) this.showPreview(this.hovered);
    }

    private createButton(id: string): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'od-chat-nav-stop';
        button.dataset.messageId = id;
        button.append(document.createElement('span'));
        const index = () => this.stops.findIndex((stop) => stop.id === id);
        button.addEventListener('pointerenter', () => this.showPreview(index()));
        button.addEventListener('focus', () => this.showPreview(index()));
        button.addEventListener('blur', this.hidePreview);
        button.addEventListener('click', () => this.options.navigate(id));
        button.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this.hidePreview();
                return;
            }
            const current = index();
            const target =
                event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? this.buttons.length - 1
                      : event.key === 'ArrowUp'
                        ? Math.max(0, current - 1)
                        : event.key === 'ArrowDown'
                          ? Math.min(this.buttons.length - 1, current + 1)
                          : -1;
            if (target < 0) return;
            event.preventDefault();
            this.buttons.forEach((item, i) => {
                item.tabIndex = i === target ? 0 : -1;
            });
            this.buttons[target].focus({ preventScroll: true });
            const next = this.buttons[target];
            if (next.offsetTop < this.rail.scrollTop) this.rail.scrollTop = next.offsetTop;
            else if (next.offsetTop + next.offsetHeight > this.rail.scrollTop + this.rail.clientHeight) {
                this.rail.scrollTop = next.offsetTop + next.offsetHeight - this.rail.clientHeight;
            }
            this.showPreview(target);
        });
        return button;
    }

    private onHistoryMutation = (mutations: MutationRecord[]): void => {
        const indexChanged = mutations.some((mutation) => {
            if (mutation.target === this.history) return true;
            const target =
                mutation.target.nodeType === 1 ? (mutation.target as Element) : mutation.target.parentElement;
            return Boolean(target?.closest('.od-user-msg-container'));
        });
        if (indexChanged) {
            this.anchorsDirty = true;
            this.refresh();
        } else if (this.hovered >= 0) {
            // Replies only affect the visible preview; idle navigation has no token work.
            this.scheduleUpdate();
        }
    };

    refresh = (): void => {
        this.contentDirty = true;
        this.scheduleUpdate();
    };

    private scheduleUpdate = (): void => {
        if (this.destroyed || this.timer !== undefined) return;
        // Coalesce streamed tokens without extracting summaries on ordinary scrolling.
        this.timer = setTimeout(() => {
            this.timer = undefined;
            const contentDirty = this.contentDirty;
            const positionDirty = this.positionDirty;
            this.contentDirty = false;
            this.positionDirty = false;
            if (contentDirty && this.options.refresh) this.setStops(this.options.refresh());
            else {
                if (positionDirty) this.updateActive();
                if (this.hovered >= 0) this.showPreview(this.hovered, positionDirty);
            }
        }, 80);
    };

    private onScroll = (): void => {
        // A navigation jump changes the reading position, not the hovered stop.
        // Keeping the hover also prevents updateActive from recentering the rail.
        this.positionDirty = true;
        this.scheduleUpdate();
    };

    private onRailScroll = (): void => {
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && this.rail.contains(focused) && focused.matches(':focus-visible')) {
            this.showPreview(this.buttons.indexOf(focused as HTMLButtonElement));
        } else {
            this.hidePreview();
        }
    };

    private updateActive(): void {
        if (this.anchorsDirty) {
            const indices = new Map(this.stops.map((stop, index) => [stop.id, index]));
            this.anchors = Array.from(this.history.children).flatMap((child) => {
                if (!child.matches('.od-user-msg-container[data-message-id]')) return [];
                const index = indices.get((child as HTMLElement).dataset.messageId!);
                return index === undefined ? [] : [{ index, element: child as HTMLElement }];
            });
            this.anchorsDirty = false;
        }
        const top = this.history.getBoundingClientRect().top + 40;
        // Message anchors remain in document order. Search current layout rather than
        // reading every message rectangle on each scroll or streamed token.
        let low = 0;
        let high = this.anchors.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (this.anchors[middle].element.getBoundingClientRect().top <= top) low = middle + 1;
            else high = middle;
        }
        const active = this.anchors[Math.max(0, low - 1)]?.index ?? -1;
        const activeChanged = this.active !== active;
        this.active = active;
        const hasFocus = this.rail.contains(document.activeElement);
        this.buttons.forEach((button, i) => {
            const current = i === active ? 'location' : 'false';
            if (button.getAttribute('aria-current') !== current) button.setAttribute('aria-current', current);
            const tabIndex = i === Math.max(0, active) ? 0 : -1;
            if (!hasFocus && button.tabIndex !== tabIndex) button.tabIndex = tabIndex;
        });
        if (activeChanged && this.hovered < 0 && !hasFocus && this.buttons[active]) {
            const button = this.buttons[active];
            this.rail.scrollTop = Math.max(0, button.offsetTop - this.rail.clientHeight / 2);
        }
        this.paintTicks();
    }

    private paintTicks(): void {
        this.buttons.forEach((button, i) => {
            const distance = Math.abs(i - this.hovered);
            const width = this.hovered >= 0 ? Math.max(6, 26 - distance * 6) : i === this.active ? 16 : 6;
            const scale = String(width / 26);
            if (button.style.getPropertyValue('--tick-scale') !== scale) {
                button.style.setProperty('--tick-scale', scale);
            }
            if (button.classList.contains('is-previewed') !== (i === this.hovered)) {
                button.classList.toggle('is-previewed', i === this.hovered);
            }
        });
    }

    private showPreview(index: number, reposition = true): void {
        let stop = this.stops[index];
        if (!stop) return;
        const user = this.anchors.find((anchor) => anchor.index === index)?.element;
        if (user?.querySelector('.od-user-msg')) {
            stop = readRenderedStop(user, this.options.translate('renderer.taskview.navigation.attachment'));
        }
        const hoverChanged = this.hovered !== index;
        this.hovered = index;
        if (this.title.textContent !== stop.title) this.title.textContent = stop.title;
        const answer = stop.preview || this.options.translate('renderer.taskview.navigation.noReply');
        if (this.answer.textContent !== answer) this.answer.textContent = answer;
        if (this.preview.hidden) this.preview.hidden = false;
        if (hoverChanged) this.paintTicks();
        // A streamed token changes text only. ResizeObserver handles the occasional
        // height change without forcing layout of the chat for every preview update.
        if (!reposition) return;
        const rootRect = this.root.getBoundingClientRect();
        const rect = this.buttons[index].getBoundingClientRect();
        const maxTop = Math.max(8, rootRect.height - this.preview.offsetHeight - 8);
        this.preview.style.top = `${Math.max(8, Math.min(maxTop, rect.top - rootRect.top + rect.height / 2 - this.preview.offsetHeight / 2))}px`;
    }

    private hidePreview = (): void => {
        this.hovered = -1;
        this.preview.hidden = true;
        this.paintTicks();
    };

    destroy(): void {
        this.destroyed = true;
        clearTimeout(this.timer);
        this.observer.disconnect();
        this.resizeObserver?.disconnect();
        this.history.removeEventListener('scroll', this.onScroll);
        this.history.classList.remove('od-chat-has-nav');
        this.root.remove();
    }
}
