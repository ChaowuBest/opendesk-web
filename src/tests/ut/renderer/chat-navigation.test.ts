import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import {
    ChatNavigation,
    buildConversationStops,
    mergeRenderedConversationStops
} from '../../../renderer/components/chatNavigation.js';

const navigations: ChatNavigation[] = [];
let originalObserver: typeof MutationObserver;

beforeAll(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        HTMLElement: window.HTMLElement,
        MutationObserver: window.MutationObserver
    });
    originalObserver = window.MutationObserver;
});

afterEach(() => {
    navigations.splice(0).forEach((nav) => nav.destroy());
    globalThis.MutationObserver = originalObserver;
    jest.restoreAllMocks();
    jest.useRealTimers();
});

function createNavigation(html = '', options: Partial<ConstructorParameters<typeof ChatNavigation>[1]> = {}) {
    const host = document.createElement('div');
    const history = document.createElement('div');
    history.innerHTML = html;
    host.append(history);
    const nav = new ChatNavigation(history, { navigate: jest.fn(), translate: (key) => key, ...options });
    navigations.push(nav);
    return { host, history, nav };
}

const message = (role: string, id: string, text: string) => ({
    role,
    message_id: id,
    content: [{ type: 'text', text }]
});

describe('conversation quick navigation', () => {
    test('many turns share bounded listeners and nested events still follow a reordered turn', () => {
        const navigate = jest.fn();
        const listen = jest.spyOn(window.HTMLElement.prototype, 'addEventListener');
        const { host, nav } = createNavigation('', { navigate });
        const stops = Array.from({ length: 1000 }, (_, i) => ({
            id: `u${i}`,
            title: `Question ${i}`,
            preview: ''
        }));
        nav.setStops(stops);
        expect(listen.mock.calls.length).toBeLessThan(20);
        const button = host.querySelectorAll<HTMLButtonElement>('.od-chat-nav-stop')[999];
        const tick = button.firstElementChild!;
        tick.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
        expect(host.querySelector('.od-chat-nav-title')?.textContent).toBe('Question 999');
        nav.setStops([stops[999], ...stops.slice(0, 999)]);
        expect(host.querySelector('.od-chat-nav-stop')).toBe(button);
        tick.dispatchEvent(new window.Event('click', { bubbles: true }));
        expect(navigate).toHaveBeenCalledWith('u999');
        expect(host.querySelector('.od-chat-nav-title')?.textContent).toBe('Question 999');
    });

    test('streaming without a visible preview does not rebuild the index or summaries', async () => {
        jest.useFakeTimers();
        let deliver: MutationCallback;
        // linkedom reports the observed root as every mutation's target. Supply the
        // actual browser record shape here; Electron profiling exercises native delivery.
        globalThis.MutationObserver = class {
            constructor(callback: MutationCallback) {
                deliver = callback;
            }
            observe() {}
            disconnect() {}
            takeRecords() {
                return [];
            }
        } as unknown as typeof MutationObserver;
        const refresh = jest.fn(() => []);
        const { host, history, nav } = createNavigation(
            '<div class="od-user-msg-container" data-message-id="u1"><div class="od-user-msg">One</div></div><div class="od-assistant-msg-container"><div id="message-content-a1"><div class="markdown-body">Partial</div></div></div>',
            { refresh }
        );
        nav.setStops([
            { id: 'u1', title: 'One', preview: 'Partial' },
            { id: 'u2', title: 'Two', preview: '' }
        ]);
        history.querySelector('.markdown-body')!.textContent = 'Complete';
        deliver!([{ target: history.querySelector('.markdown-body') } as MutationRecord], {} as MutationObserver);
        await Promise.resolve();
        jest.advanceTimersByTime(100);
        expect(refresh).not.toHaveBeenCalled();
        const button = host.querySelector('.od-chat-nav-stop')!;
        button.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
        expect(host.querySelector('.od-chat-nav-answer')?.textContent).toBe('Complete');
        const readHistoryRect = jest.fn(() => ({ top: 0 }) as DOMRect);
        history.getBoundingClientRect = readHistoryRect;
        history.querySelector('.markdown-body')!.textContent = 'Updated while hovered';
        deliver!([{ target: history.querySelector('.markdown-body') } as MutationRecord], {} as MutationObserver);
        await Promise.resolve();
        jest.advanceTimersByTime(100);
        expect(host.querySelector('.od-chat-nav-answer')?.textContent).toBe('Updated while hovered');
        expect(refresh).not.toHaveBeenCalled();
        expect(readHistoryRect).not.toHaveBeenCalled();
    });

    test('locates the active turn in a thousand-message view with logarithmic layout reads', () => {
        jest.useFakeTimers();
        const { host, history, nav } = createNavigation();
        let scrollTop = 0;
        const readRect = jest.fn((index: number) => ({ top: index * 100 - scrollTop }) as DOMRect);
        const stops = Array.from({ length: 1000 }, (_, i) => {
            const user = document.createElement('div');
            user.className = 'od-user-msg-container';
            user.dataset.messageId = `u${i}`;
            user.getBoundingClientRect = () => readRect(i);
            history.append(user);
            return { id: `u${i}`, title: `Question ${i}`, preview: '' };
        });
        nav.setStops(stops);
        readRect.mockClear();
        scrollTop = 70000;
        history.dispatchEvent(new window.Event('scroll'));
        jest.advanceTimersByTime(80);
        expect(readRect.mock.calls.length).toBeLessThanOrEqual(11);
        expect(host.querySelectorAll('.od-chat-nav-stop')[700].getAttribute('aria-current')).toBe('location');
    });

    test('updates and appends preserve the hovered button; removal and empty history clear navigation', () => {
        const { host, history, nav } = createNavigation();
        const stops = [
            { id: 'u1', title: 'One', preview: 'Answer one' },
            { id: 'u2', title: 'Two', preview: 'Answer two' }
        ];
        nav.setStops(stops);
        const button = host.querySelector('.od-chat-nav-stop') as HTMLElement;
        button.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
        nav.setStops([{ ...stops[0], preview: 'Complete reply' }, stops[1]]);
        expect(host.querySelector('.od-chat-nav-stop')).toBe(button);
        expect(host.querySelector('.od-chat-nav-answer')?.textContent).toBe('Complete reply');
        nav.setStops([...stops, { id: 'u3', title: 'Three', preview: '' }]);
        expect(host.querySelector('.od-chat-nav-stop')).toBe(button);
        expect(button.classList.contains('is-previewed')).toBe(true);
        expect((host.querySelector('.od-chat-nav-preview') as HTMLElement).hidden).toBe(false);
        nav.setStops(stops.slice(1));
        expect(host.contains(button)).toBe(false);
        expect((host.querySelector('.od-chat-nav-preview') as HTMLElement).hidden).toBe(true);
        nav.setStops([]);
        expect((host.querySelector('.od-chat-nav') as HTMLElement).hidden).toBe(true);
        expect(history.classList.contains('od-chat-has-nav')).toBe(false);
    });

    test('ordinary scrolling only updates position, while content changes refresh summaries and teardown cancels pending work', () => {
        jest.useFakeTimers();
        const refresh = jest.fn(() => []);
        const { host, history, nav } = createNavigation('', { refresh });
        history.dispatchEvent(new window.Event('scroll'));
        history.dispatchEvent(new window.Event('scroll'));
        jest.advanceTimersByTime(80);
        expect(refresh).not.toHaveBeenCalled();
        nav.refresh();
        history.dispatchEvent(new window.Event('scroll'));
        jest.advanceTimersByTime(80);
        expect(refresh).toHaveBeenCalledTimes(1);
        nav.refresh();
        nav.destroy();
        expect(host.querySelector('.od-chat-nav')).toBeNull();
        jest.advanceTimersByTime(80);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    test('keeps the hovered preview, tick shape and rail position when clicking loads and jumps to history', async () => {
        jest.useFakeTimers();
        const stops = [
            { id: 'u1', title: 'Earlier question', preview: 'Earlier answer' },
            { id: 'u2', title: 'Latest question', preview: 'Latest answer' }
        ];
        const navigate = jest.fn(() => {
            const earlier = document.createElement('div');
            earlier.className = 'od-user-msg-container';
            earlier.dataset.messageId = 'u1';
            earlier.getBoundingClientRect = () => ({ top: 20 }) as DOMRect;
            history.prepend(earlier);
            latest.getBoundingClientRect = () => ({ top: 500 }) as DOMRect;
            history.dispatchEvent(new window.Event('scroll'));
        });
        const { host, history, nav } = createNavigation(
            '<div class="od-user-msg-container" data-message-id="u2"></div>',
            { navigate, refresh: () => stops }
        );
        history.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
        const latest = history.firstElementChild as HTMLElement;
        latest.getBoundingClientRect = () => ({ top: 20 }) as DOMRect;
        nav.setStops(stops);
        const buttons = host.querySelectorAll<HTMLButtonElement>('.od-chat-nav-stop');
        const rail = host.querySelector('.od-chat-nav-rail') as HTMLElement;
        const preview = host.querySelector('.od-chat-nav-preview') as HTMLElement;
        rail.scrollTop = 100;
        buttons[0].dispatchEvent(new window.Event('pointerover', { bubbles: true }));
        const tickWidths = Array.from(buttons, (button) => button.style.getPropertyValue('--tick-scale'));
        const previewTop = preview.style.top;
        buttons[0].click();
        expect(preview.hidden).toBe(false);
        await Promise.resolve();
        jest.advanceTimersByTime(80);
        expect(navigate).toHaveBeenCalledWith('u1');
        expect(buttons[0].getAttribute('aria-current')).toBe('location');
        expect(buttons[0].classList.contains('is-previewed')).toBe(true);
        expect(Array.from(buttons, (button) => button.style.getPropertyValue('--tick-scale'))).toEqual(tickWidths);
        expect(preview.hidden).toBe(false);
        expect(preview.style.top).toBe(previewTop);
        expect(preview.textContent).toBe('Earlier questionEarlier answer');
        expect(rail.scrollTop).toBe(100);
        rail.dispatchEvent(new window.Event('pointerleave'));
        expect(preview.hidden).toBe(true);
    });

    test('merges streamed replies and new questions without duplicate stops or tool text', () => {
        const history = document.createElement('div');
        history.innerHTML = `<div class="od-user-msg-container" data-message-id="u1"><div class="od-user-msg">Edited question</div></div>
            <div class="od-assistant-msg-container"><div id="message-content-a1"><div class="markdown-body">Live answer</div><div>Tool result</div></div></div>
            <div class="od-user-msg-container" data-message-id="u2"><div class="od-user-msg">New question</div></div>`;
        const stored = [
            { id: 'old', title: 'Unrendered', preview: 'Old answer' },
            { id: 'u1', title: 'Original', preview: 'Old reply' }
        ];
        const result = mergeRenderedConversationStops(stored, history, 'Attachment');
        expect(result).toEqual([
            stored[0],
            { id: 'u1', title: 'Edited question', preview: 'Live answer' },
            { id: 'u2', title: 'New question', preview: '' }
        ]);
        expect(stored[1].title).toBe('Original');
    });

    test('indexes the full history, grouping assistant text under each visible user turn', () => {
        const messages = [
            message('system', 's', 'internal'),
            message('user', 'u1', 'First question'),
            {
                role: 'assistant',
                message_id: 'a1',
                content: [
                    { type: 'reasoning', text: 'private reasoning' },
                    { type: 'text', text: 'First answer' }
                ]
            },
            message('user', 'hidden', 'internal instruction'),
            message('user', 'u2', 'Second question')
        ];
        expect(buildConversationStops(messages, (m) => m.message_id !== 'hidden')).toEqual([
            { id: 'u1', title: 'First question', preview: 'First answer' },
            { id: 'u2', title: 'Second question', preview: '' }
        ]);
    });

    test('uses rendered text and attachment fallback without rendering markup in previews', () => {
        expect(
            buildConversationStops(
                [
                    { role: 'user', message_id: 'u1', content: [{ type: 'image' }] },
                    {
                        role: 'assistant',
                        message_id: 'a1',
                        content: [{ type: 'text', rendered: '<p>Hello <b>world</b></p><script>bad()</script>' }]
                    }
                ],
                () => true,
                'Attachment'
            )
        ).toEqual([{ id: 'u1', title: 'Attachment', preview: 'Hello world' }]);
    });

    test('previews markup as text and lets Escape dismiss a keyboard preview', () => {
        const { host, nav } = createNavigation();
        nav.setStops([
            { id: 'old', title: '<img src=x onerror=bad()>', preview: 'Earlier answer' },
            { id: 'new', title: 'Latest question', preview: '' }
        ]);
        const buttons = host.querySelectorAll<HTMLButtonElement>('.od-chat-nav-stop');
        expect(buttons).toHaveLength(2);
        buttons[0].dispatchEvent(new window.Event('pointerover', { bubbles: true }));
        expect(host.querySelector('.od-chat-nav-preview')?.textContent).toContain('<img src=x onerror=bad()>');
        expect(host.querySelector('.od-chat-nav-preview img')).toBeNull();
        buttons[1].dispatchEvent(new window.Event('focusin', { bubbles: true }));
        expect(host.querySelector('.od-chat-nav-title')?.textContent).toBe('Latest question');
        expect((host.querySelector('.od-chat-nav-preview') as HTMLElement).hidden).toBe(false);
        const escape = new window.Event('keydown', { bubbles: true });
        Object.assign(escape, { key: 'Escape' });
        buttons[1].dispatchEvent(escape);
        expect((host.querySelector('.od-chat-nav-preview') as HTMLElement).hidden).toBe(true);
    });
});
