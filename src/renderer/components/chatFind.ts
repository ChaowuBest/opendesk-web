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

// 搜索控制器：从消息构建文本 → 匹配关键词 → 映射到页面节点 → 高亮并滚动定位。
// 文本/DOM 转换在 chatFindContent.ts，高亮绘制在 chatFindHighlight.ts。
import { getGoalSupplementDisplayText, shouldRenderGoalUserMessage } from '../../common/goal/user-message-display.js';
import type { GoalUserMessageDisplayLike } from '../../common/goal/user-message-display.js';
import {
    chatFindParent,
    chatFindRanges,
    isChatFindDecoration,
    readChatFindText,
    revealChatFindContent
} from './chatFindContent.js';
import { ChatFindHighlighter, chatFindRangeRect } from './chatFindHighlight.js';
import { prepareSearchPreviews } from './previewer.js';
import { PREVIEW_CONTENT_CHANGED, renderSafeMarkdown } from '../utils/markdown.js';
import type { GUIShortcutEntry } from './shortcutManager.js';
import './chatFind.css';

interface Message extends GoalUserMessageDisplayLike {
    role: string;
    message_id?: string;
    content?: { type?: string; text?: string; rendered?: string }[];
}
/** 一个消息文本部分对应一个搜索条目；同时保留后续定位页面所需的消息和 part 信息。 */
export interface ChatFindDocument {
    /** 消息 ID + part 下标，用于跨刷新复用缓存。 */
    key: string;
    messageId: string;
    role: string;
    partIndex: number;
    textIndex: number;
    /** 去掉预览模块的源码、控件等非搜索内容后，得到的显示文字。 */
    text: string;
    /** 带类型前缀的源内容，只用于检测变化，不参与关键词匹配。 */
    source: string;
}
/** 命中在完整文本中的 UTF-16 偏移：[start, end)，与 JS 字符串和 DOM Range 的计数一致。 */
interface TextMatch {
    start: number;
    end: number;
}
/** 全会话的一次命中；ordinal 是它在所属文本条目内的序号，用于关联实时 DOM 中的匹配。 */
interface Hit extends TextMatch {
    document: ChatFindDocument;
    ordinal: number;
}

export { readChatFindText } from './chatFindContent.js';

/** 转义正则特殊字符，让 a+b 等输入按字面文字搜索。 */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 返回所有不重叠的命中位置；忽略大小写，并允许关键词中的空白匹配排版换行。 */
export function findChatTextMatches(text: string, query: string): TextMatch[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    // 输入按字面匹配；一个或多个输入空白可以匹配页面中的换行、缩进等空白。
    const escapedWords = trimmed.split(/\s+/u).map(escapeRegExp);
    const pattern = escapedWords.join('\\s+');
    // 直接使用原字符串上的匹配偏移，避免先转换大小写后字符长度改变、导致定位错位。
    return Array.from(text.matchAll(new RegExp(pattern, 'giu')), (match) => ({
        start: match.index!,
        end: match.index! + match[0].length
    }));
}

/**
 * 把完整消息列表整理成搜索文本条目；这里只准备文字，关键词匹配在后续进行。
 * cache 由调用方跨刷新保留，避免内容未变时重复解析 HTML、生成预览。
 * Mermaid 异步完成后更新缓存，并通过 previews.ready() 通知调用方重新搜索。
 */
export function buildChatFindDocuments(
    messages: Message[],
    cache = new Map<string, ChatFindDocument>(),
    previews?: { signal: AbortSignal; ready(): void }
): ChatFindDocument[] {
    const documents: ChatFindDocument[] = [];
    const retainedKeys = new Set<string>();

    for (const message of messages) {
        const messageId = message.message_id;
        if (!messageId || (message.role !== 'user' && message.role !== 'assistant')) continue;
        if (message.role === 'user' && !shouldRenderGoalUserMessage(message)) continue;
        if (message.role === 'assistant' && message.internal === true) continue;

        // 目标补充消息只搜索用户看到的文字，不搜索其内部协议内容。
        let supplement: string | undefined;
        if (message.role === 'user') {
            supplement = getGoalSupplementDisplayText(message);
        }
        let parts = message.content || [];
        if (supplement !== undefined) {
            parts = [{ type: 'text', text: supplement }];
        }
        let textPartCount = 0;
        for (const [partIndex, part] of parts.entries()) {
            if (part?.type !== 'text') continue;
            // partIndex 包含所有内容类型；textIndex 只计算文本部分，用于定位页面节点。
            const textIndex = textPartCount++;
            const key = `${messageId}:${partIndex}`;
            retainedKeys.add(key);

            // 保存带类型前缀的原始内容，比较其是否变化；这里没有计算哈希。
            let source: string;
            if (supplement !== undefined) {
                source = `plain:${supplement}`;
            } else if (part.rendered) {
                source = `html:${part.rendered}`;
            } else {
                source = `markdown:${part.text || ''}`;
            }

            const cachedDocument = cache.get(key);
            if (cachedDocument && cachedDocument.source === source && cachedDocument.textIndex === textIndex) {
                documents.push(cachedDocument);
                continue;
            }

            // 临时容器不挂到聊天页面上，因此尚未显示的旧消息也能准备搜索文本。
            const root = document.createElement('div');
            if (supplement !== undefined) {
                root.append(document.createTextNode(supplement));
            } else {
                root.innerHTML = part.rendered || renderSafeMarkdown(part.text || '');
            }
            // HTML/SVG 预览同步准备；Mermaid 需要异步渲染，先返回目前可读取的文字。
            const previewPreparation = prepareSearchPreviews(root, previews?.signal);
            const searchDocument: ChatFindDocument = {
                key,
                messageId,
                role: message.role,
                partIndex,
                textIndex,
                source,
                text: readChatFindText(root).text
            };
            cache.set(key, searchDocument);
            documents.push(searchDocument);

            // 普通消息不保留临时 DOM；只有异步图形预览会在完成前继续引用它。
            if (!previewPreparation) continue;
            void previewPreparation
                .then(() => {
                    // 搜索已关闭，或消息条目已被替换/删除时，旧任务不能再回写缓存。
                    if (previews?.signal.aborted || cache.get(key) !== searchDocument) return;
                    const updatedText = readChatFindText(root).text;
                    if (updatedText === searchDocument.text) return;
                    cache.set(key, { ...searchDocument, text: updatedText });
                    previews?.ready();
                })
                .catch((error) => {
                    // 预览失败时不把源码补进结果，保持“只搜索显示效果”的规则。
                    console.warn('Unable to prepare a chat search preview', error);
                });
        }
    }

    // 清理已经不在当前消息列表中的条目。
    for (const key of cache.keys()) {
        if (!retainedKeys.has(key)) cache.delete(key);
    }
    return documents;
}

/** TaskView 提供数据与历史补载能力，搜索控制器自身不负责请求或保存会话。 */
interface Options {
    /** 每次读取当前完整消息列表，包括尚未挂到 DOM 的旧消息。 */
    getMessages(): Message[];
    /** 跳转前补载目标消息，使对应 DOM 节点可供定位。 */
    ensureMessage(id: string): void;
    /** 搜索期间暂停自动跟随，防止流式输出把视口拉回底部。 */
    pauseFollow(): void;
    translate(key: string, params?: Record<string, string | number>): string;
}

/** 每个聊天视图拥有一个搜索实例；同一时刻只允许一个实例打开。 */
export class ChatFind {
    private static active?: ChatFind;
    readonly root = document.createElement('div');
    private input: HTMLInputElement;
    private status: HTMLSpanElement;
    private previous: HTMLButtonElement;
    private following: HTMLButtonElement;
    private observer: MutationObserver;
    private highlighter = new ChatFindHighlighter();
    private scope: HTMLElement;
    // cache 缓存“源内容 → 显示文本”，matches 缓存“显示文本 + 关键词 → 命中位置”。
    private cache = new Map<string, ChatFindDocument>();
    private matches = new Map<ChatFindDocument, { query: string; text: string; matches: TextMatch[] }>();
    private previewAbort?: AbortController;
    // hits 按消息和文字顺序排列；current 是当前命中的下标，-1 表示没有结果。
    private hits: Hit[] = [];
    private current = -1;
    private query = '';
    private composing = false;
    private timer?: ReturnType<typeof setTimeout>;
    // 目标消息尚未能定位时，在后续刷新中继续尝试完成滚动跳转。
    private pendingNavigation = false;
    // 新关键词可能先没有结果，等待 Mermaid 等异步预览完成后自动跳转首次命中。
    private awaitingFirstHit = false;
    visible = false;

    constructor(
        private history: HTMLElement,
        private options: Options
    ) {
        this.scope = history.closest<HTMLElement>('[data-chat-find-scope]') || history.parentElement!;
        this.scope.addEventListener('pointerdown', this.focusScope);
        history.tabIndex = -1;
        this.root.className = 'od-chat-find';
        this.root.hidden = true;
        this.root.setAttribute('role', 'search');
        // 固定布局只生成一次，后续只更新文本和属性；本地化文案通过 DOM 属性赋值。
        this.root.innerHTML = `
            <div class="od-chat-find-header">
                <i class="fa-solid fa-magnifying-glass od-chat-find-icon" aria-hidden="true"></i>
                <input type="text" autocomplete="off" spellcheck="false">
                <div class="od-chat-find-close">
                    <span class="od-chat-find-close-separator" aria-hidden="true"></span>
                    <button type="button" data-find-action="close">
                        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                    </button>
                </div>
            </div>
            <div class="od-chat-find-footer">
                <div class="od-chat-find-navigation">
                    <button type="button" data-find-action="previous">
                        <i class="fa-solid fa-arrow-up" aria-hidden="true"></i>
                    </button>
                    <button type="button" data-find-action="next">
                        <i class="fa-solid fa-arrow-down" aria-hidden="true"></i>
                    </button>
                </div>
                <span class="od-chat-find-status" role="status" aria-live="polite"></span>
            </div>
        `;
        this.input = this.root.querySelector<HTMLInputElement>('input')!;
        this.status = this.root.querySelector<HTMLSpanElement>('.od-chat-find-status')!;
        this.previous = this.root.querySelector<HTMLButtonElement>('[data-find-action="previous"]')!;
        this.following = this.root.querySelector<HTMLButtonElement>('[data-find-action="next"]')!;
        this.previous.addEventListener('click', () => this.next(-1));
        this.following.addEventListener('click', () => this.next());
        this.root
            .querySelector<HTMLButtonElement>('[data-find-action="close"]')!
            .addEventListener('click', () => this.hide());
        this.updateLabels();
        history.parentElement?.append(this.root);
        this.input.addEventListener('input', this.changed);
        // 输入法选字期间暂停搜索，避免把尚未确认的拼音等内容当成最终关键词。
        this.input.addEventListener('compositionstart', () => {
            this.composing = true;
            clearTimeout(this.timer);
            this.timer = undefined;
        });
        this.input.addEventListener('compositionend', () => {
            this.composing = false;
            this.changed();
        });
        this.observer = new MutationObserver((records) => {
            // 忽略高亮自身插入/删除的装饰节点，避免“绘制 → 监听到变化 → 再绘制”的循环。
            for (const record of records) {
                if (isChatFindDecoration(record.target)) continue;
                if (record.type === 'childList') {
                    const changedNodes = [...record.addedNodes, ...record.removedNodes];
                    const hasContentChanges = changedNodes.some((node) => !isChatFindDecoration(node));
                    if (!hasContentChanges) continue;
                }
                this.refresh();
                break;
            }
        });
    }

    /** 点击聊天空白处时，让焦点回到聊天范围，使 Ctrl/⌘+F 能识别当前聊天。 */
    private focusScope = (event: PointerEvent) => {
        const interactive = (event.target as Element).closest(
            'input,textarea,button,a,select,[contenteditable="true"],[tabindex]'
        );
        if (!interactive || interactive === this.scope) this.scope.focus({ preventScroll: true });
    };

    /** 搜索打开时处理 Esc、Enter 和 Shift+Enter；不打断输入法选字，按钮 Enter 保留原生行为。 */
    private onKeydown = (event: KeyboardEvent) => {
        if (!this.visible || event.isComposing || this.composing || event.keyCode === 229) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.hide();
        } else if (
            event.key === 'Enter' &&
            event.target === this.input &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
        ) {
            event.preventDefault();
            event.stopPropagation();
            const changed = this.flush();
            if (!changed) this.next(event.shiftKey ? -1 : 1);
        }
    };

    /** 统一补上聊天搜索的本地化键前缀。 */
    private t(key: string, params?: Record<string, string | number>): string {
        return this.options.translate('renderer.chatFind.' + key, params);
    }

    /** 初始化及每次打开时更新文案，兼容设置中途切换语言。 */
    private updateLabels(): void {
        this.root.setAttribute('aria-label', this.t('label'));
        this.input.placeholder = this.t('placeholder');
        this.input.setAttribute('aria-label', this.t('placeholder'));
        for (const button of this.root.querySelectorAll<HTMLButtonElement>('button')) {
            button.title = this.t(button.dataset.findAction!);
            button.setAttribute('aria-label', button.title);
        }
    }

    /** 打开搜索、暂停底部跟随，并开始观察消息变化；再次打开只聚焦并选中关键词。 */
    show(): void {
        this.updateLabels();
        if (!this.visible) {
            ChatFind.active?.hide();
            ChatFind.active = this;
            this.visible = true;
            this.previewAbort = new AbortController();
            this.history.addEventListener(PREVIEW_CONTENT_CHANGED, this.previewChanged);
            this.root.hidden = false;
            this.scope.addEventListener('keydown', this.onKeydown);
            this.options.pauseFollow();
            this.observer.observe(this.history, { childList: true, characterData: true, subtree: true });
            this.update(false);
        }
        this.input.focus({ preventScroll: true });
        this.input.select?.();
    }

    /** 关闭后取消待处理的预览任务、停止刷新和观察，清除高亮及缓存，但保留阅读位置。 */
    hide(): void {
        this.visible = false;
        this.previewAbort?.abort();
        this.history.removeEventListener(PREVIEW_CONTENT_CHANGED, this.previewChanged);
        this.pendingNavigation = false;
        this.awaitingFirstHit = false;
        clearTimeout(this.timer);
        this.timer = undefined;
        this.observer.disconnect();
        this.scope.removeEventListener('keydown', this.onKeydown);
        this.highlighter.clear();
        if (ChatFind.active === this) ChatFind.active = undefined;
        // 焦点仅在原本处于搜索框内时交还聊天区，preventScroll 保留关闭时的阅读位置。
        if (this.root.contains(this.history.ownerDocument.activeElement)) this.history.focus({ preventScroll: true });
        this.root.hidden = true;
        this.cache.clear();
        this.matches.clear();
        this.hits = [];
        this.current = -1;
    }

    /** 视图销毁/重建时，额外移除长期绑定的范围监听和搜索条 DOM。 */
    destroy(): void {
        this.hide();
        this.scope.removeEventListener('pointerdown', this.focusScope);
        this.root.remove();
    }

    // 预览完成或显示模式变化，与流式消息更新共用同一个刷新入口。
    private previewChanged = () => this.refresh();

    /** 内容变化触发的刷新：通常保留当前命中；尚未完成的首次结果/历史跳转由 update 继续处理。 */
    refresh(): void {
        if (!this.visible || this.composing || !this.query || this.timer !== undefined) return;
        // 首次变化后 120ms 内的更新合并处理，不反复重置计时器，避免连续流式输出使刷新一直推迟。
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.update(false);
        }, 120);
    }

    /** 用户输入采用防抖：连续输入时重置计时器，停顿 120ms 后搜索并定位首个结果。 */
    private changed = () => {
        if (this.composing) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.update(true);
        }, 120);
    };

    /** 按 Enter/导航前立即处理尚未执行的输入；返回关键词是否改变，避免首次搜索后又跳过一个结果。 */
    private flush(): boolean {
        clearTimeout(this.timer);
        this.timer = undefined;
        const changed = this.input.value.trim() !== this.query;
        if (changed) this.update(true);
        return changed;
    }

    /** 更新全会话命中列表；navigate 表示这次关键词输入需要自动定位首个结果。 */
    private update(navigate: boolean): void {
        if (!this.visible || this.composing) return;
        const previousHit = this.hits[this.current];
        const query = this.input.value.trim();
        const queryChanged = query !== this.query;
        if (queryChanged) {
            this.pendingNavigation = false;
            if (navigate) this.awaitingFirstHit = Boolean(query);
        }
        this.query = query;

        let searchDocuments: ChatFindDocument[] = [];
        if (query) {
            searchDocuments = buildChatFindDocuments(this.options.getMessages(), this.cache, {
                signal: this.previewAbort!.signal,
                ready: this.previewChanged
            });
        }
        const hits: Hit[] = [];
        const updatedMatches = new Map<ChatFindDocument, { query: string; text: string; matches: TextMatch[] }>();
        for (const searchDocument of searchDocuments) {
            // 已显示的消息以实时 DOM 为准；尚未挂载的旧消息使用准备好的缓存文本。
            let text = searchDocument.text;
            const liveRoot = this.findRoot(searchDocument);
            if (liveRoot) text = readChatFindText(liveRoot).text;

            let matchResult = this.matches.get(searchDocument);
            if (!matchResult || matchResult.query !== query || matchResult.text !== text) {
                matchResult = { query, text, matches: findChatTextMatches(text, query) };
            }
            updatedMatches.set(searchDocument, matchResult);
            for (const [ordinal, match] of matchResult.matches.entries()) {
                hits.push({ ...match, document: searchDocument, ordinal });
            }
        }
        this.matches = updatedMatches;
        this.hits = hits;

        // 流式末尾追加时，以消息条目和文字偏移保留原命中；前文改写后不保证仍能找到同一处。
        let previousHitIndex = -1;
        if (!queryChanged && previousHit) {
            previousHitIndex = hits.findIndex((hit) => {
                const sameDocument = hit.document.key === previousHit.document.key;
                const samePosition = hit.start === previousHit.start && hit.end === previousHit.end;
                return sameDocument && samePosition;
            });
        }
        if (hits.length === 0) {
            this.current = -1;
        } else if (queryChanged) {
            this.current = 0;
        } else if (previousHitIndex >= 0) {
            this.current = previousHitIndex;
        } else {
            // 原命中找不到时，尽量保留原序号，但不能超出新的结果范围。
            if (this.current < 0) this.current = 0;
            if (this.current >= hits.length) this.current = hits.length - 1;
        }

        // 包括异步预览稍后才带来首个结果的情况，无需用户再次按 Enter。
        if (this.awaitingFirstHit && hits.length) {
            this.awaitingFirstHit = false;
            this.navigate();
        } else {
            this.paint(this.pendingNavigation);
        }
        this.renderStatus();
    }

    /** direction 为 1/−1，分别前进/后退；取模实现首尾循环。 */
    next(direction = 1): void {
        if (!this.visible || this.composing) return;
        this.flush();
        if (!this.hits.length) return;
        this.current = (this.current + direction + this.hits.length) % this.hits.length;
        this.navigate();
        this.renderStatus();
    }

    /** 显示当前序号和总数，无结果时禁用上下导航按钮。 */
    private renderStatus(): void {
        if (!this.query) {
            this.status.textContent = '';
        } else if (this.hits.length === 0) {
            this.status.textContent = this.t('empty');
        } else {
            this.status.textContent = this.t('count', { current: this.current + 1, total: this.hits.length });
        }
        const hasResults = this.hits.length > 0;
        this.previous.disabled = !hasResults;
        this.following.disabled = !hasResults;
    }

    /** 先补载旧消息，再把命中映射到实际节点并滚动到对应文字。 */
    private navigate(): void {
        const hit = this.hits[this.current];
        if (!hit) return;
        this.options.pauseFollow();
        this.options.ensureMessage(hit.document.messageId);
        this.pendingNavigation = true;
        this.paint(true);
    }

    /** 根据消息 ID 和 part 定位正文容器；用户正文按文本序号定位，助手正文有原始 part 下标。 */
    private findRoot(searchDocument: ChatFindDocument): HTMLElement | undefined {
        const escapedMessageId = CSS.escape(searchDocument.messageId);
        if (searchDocument.role === 'user') {
            const messageRoot = this.history.querySelector(`#user-msg-${escapedMessageId}`);
            if (!messageRoot) return;
            const textParts = messageRoot.querySelectorAll<HTMLElement>('.od-user-msg .markdown-body');
            return textParts[searchDocument.textIndex];
        }
        const textPart = this.history.querySelector<HTMLElement>(
            `#message-content-${escapedMessageId} .markdown-body[data-output-part-index="${searchDocument.partIndex}"]`
        );
        return textPart ?? undefined;
    }

    /** 只为已挂载的消息绘制高亮；navigate 为 true 时，额外展开预览并滚动到当前命中。 */
    private paint(navigate: boolean): void {
        this.highlighter.clear();
        // MutationObserver 不会穿过 Shadow DOM/iframe 边界，需要单独观察提取文字时发现的每个根。
        this.observer.disconnect();
        this.observer.observe(this.history, { childList: true, characterData: true, subtree: true });
        const activeHit = this.hits[this.current];
        let activeRange: Range | undefined;
        let activeRoot: HTMLElement | undefined;
        for (const searchDocument of this.matches.keys()) {
            const root = this.findRoot(searchDocument);
            if (!root) continue;
            const snapshot = readChatFindText(root);
            for (const nestedRoot of snapshot.roots.slice(1)) {
                this.observer.observe(nestedRoot, { childList: true, characterData: true, subtree: true });
            }
            const textMatches = findChatTextMatches(snapshot.text, this.query);
            for (const [ordinal, match] of textMatches.entries()) {
                if (!this.history.ownerDocument.defaultView?.Highlight) continue;
                const isActiveMatch = activeHit?.document.key === searchDocument.key && activeHit.ordinal === ordinal;
                // 一次文字命中可能跨多个 DOM 根或 SVG 文本元素，因此可能需要多个 Range。
                const ranges = chatFindRanges(snapshot, match.start, match.end);
                if (isActiveMatch && ranges.length) {
                    activeRange = ranges[0];
                    activeRoot = root;
                    if (navigate) revealChatFindContent(activeRange.startContainer.parentElement!, this.history);
                }
                for (const range of ranges) this.highlighter.add(range, isActiveMatch);
            }
        }
        if (navigate && activeRange && activeRoot) {
            this.scrollToMatch(activeRange, activeRoot);
            this.pendingNavigation = false;
        }
    }

    /** 先定位整条消息，再逐层调整代码块等内部滚动区，最后调整聊天视口，露出具体命中文字。 */
    private scrollToMatch(range: Range, messageRoot: HTMLElement): void {
        messageRoot.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        let scrollContainer: Element | null = range.startContainer.parentElement;
        while (scrollContainer) {
            const matchRect = chatFindRangeRect(range);
            const viewport = scrollContainer.getBoundingClientRect();
            const canScrollVertically = scrollContainer.scrollHeight > scrollContainer.clientHeight;
            const outsideVerticalViewport = matchRect.top < viewport.top || matchRect.bottom > viewport.bottom;
            if (canScrollVertically && (scrollContainer === this.history || outsideVerticalViewport)) {
                const verticalMargin = (scrollContainer.clientHeight - matchRect.height) / 2;
                scrollContainer.scrollTop += matchRect.top - viewport.top - verticalMargin;
            }
            const canScrollHorizontally = scrollContainer.scrollWidth > scrollContainer.clientWidth;
            const outsideHorizontalViewport = matchRect.left < viewport.left || matchRect.right > viewport.right;
            if (canScrollHorizontally && outsideHorizontalViewport) {
                const horizontalMargin = (scrollContainer.clientWidth - matchRect.width) / 2;
                scrollContainer.scrollLeft += matchRect.left - viewport.left - horizontalMargin;
            }
            if (scrollContainer === this.history) break;
            scrollContainer = chatFindParent(scrollContainer);
        }
    }
}

interface ShortcutManager {
    register(entry: GUIShortcutEntry): void;
}

/** 注册平台查找快捷键；只有焦点属于可见聊天区域时，才打开对应 TaskView 的搜索。 */
export function registerChatFindShortcut(
    manager: ShortcutManager,
    options: {
        document: Document;
        isMac: boolean;
        translate(key: string): string;
    }
): void {
    const findChatView = (event: KeyboardEvent) => {
        // 原生对话框打开时不抢快捷键，聊天范围之外的编辑器/侧栏也不接管。
        if (options.document.querySelector('dialog[open]')) return;
        const target = event.target as Element | null;
        const scope = target?.closest?.('[data-chat-find-scope]');
        const view = scope?.closest('task-view') as (HTMLElement & { openChatFind?(): void }) | null;
        if (!view || view.getClientRects().length === 0 || !view.openChatFind) return;
        return view;
    };
    manager.register({
        id: 'chat:find',
        label: options.translate('renderer.chatFind.label'),
        category: options.translate('renderer.chatFind.category'),
        keys: [options.isMac ? '⌘F' : 'Ctrl+F'],
        match: (event) => {
            if (event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey) return false;
            let correctModifier: boolean;
            if (options.isMac) {
                correctModifier = event.metaKey && !event.ctrlKey;
            } else {
                correctModifier = event.ctrlKey && !event.metaKey;
            }
            if (!correctModifier) return false;
            const isFindKey = event.code === 'KeyF' || event.key.toLowerCase() === 'f';
            if (!isFindKey) return false;
            return Boolean(findChatView(event));
        },
        handler: (event) => findChatView(event)?.openChatFind?.()
    });
}
