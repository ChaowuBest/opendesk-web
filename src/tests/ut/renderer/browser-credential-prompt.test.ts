import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { renderCredentialPrompt } from '../../../main/applications/browser/credentials/prompt-view.js';

const options = {
    id: 'credential-prompt',
    guestId: 7,
    buttonCSS: '',
    question: 'Update',
    action: 'Update',
    cancel: 'Cancel',
    close: 'Close',
    oldLabel: 'Old',
    newLabel: 'New',
    reveal: 'Show',
    oldPassword: 'old-secret',
    newPassword: 'new-secret'
};
let tab: HTMLElement;
let resizeCallbacks: Array<{ targets: Set<Element>; notify: () => void }>;
let restored: Array<() => void>;
beforeEach(() => {
    const { window } = parseHTML('<html><body><div id="browser"></div></body></html>');
    resizeCallbacks = [];
    const globals = {
        window,
        document: window.document,
        Element: window.Element,
        Document: window.Document,
        ShadowRoot: window.ShadowRoot,
        Event: window.Event,
        MutationObserver: class {
            observe() {}
            disconnect() {}
        },
        innerWidth: 1000,
        innerHeight: 700,
        ResizeObserver: class {
            private targets = new Set<Element>();
            constructor(notify: () => void) {
                resizeCallbacks.push({ targets: this.targets, notify });
            }
            observe(target: Element) {
                this.targets.add(target);
            }
            disconnect() {
                this.targets.clear();
            }
        },
        requestAnimationFrame: (callback: FrameRequestCallback) => {
            callback(0);
            return 0;
        },
        cancelAnimationFrame: () => undefined
    };
    restored = Object.entries(globals).map(([key, value]) => {
        const original = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
        return () => {
            if (original) Object.defineProperty(globalThis, key, original);
            else Reflect.deleteProperty(globalThis, key);
        };
    });
    const root = document.getElementById('browser')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<div class="bw"><div class="bw-toolbar"></div><div class="tab"><webview></webview></div></div>';
    tab = root.querySelector('.tab')!;
    Object.assign(root.querySelector('webview')!, {
        getWebContentsId: () => 7,
        getClientRects: () => (tab.style.display === 'none' ? [] : [{}])
    });
    Object.assign(root.querySelector('.bw-toolbar')!, {
        getBoundingClientRect: () => ({ bottom: 150, right: 900, left: 400, width: 500, height: 40 })
    });
});
afterEach(() => {
    document.getElementById(options.id)?.dispatchEvent(new Event('opendesk-credential-dismiss'));
    restored.reverse().forEach((restore) => restore());
});

describe('credential prompt DOM lifecycle', () => {
    it('also anchors to the application browser toolbar', async () => {
        tab.parentElement!.className = 'wb';
        tab.parentElement!.querySelector('.bw-toolbar')!.className = 'wb-toolbar';
        const result = renderCredentialPrompt(options);
        const card = document.getElementById(options.id);
        expect(card).not.toBeNull();
        expect(card!.style.top).toBe('150px');
        card!.dispatchEvent(new Event('opendesk-credential-dismiss'));
        expect(await result).toBe(false);
    });
    it('anchors to the owning browser and keeps reveal with actions without accepting synthetic clicks', async () => {
        const result = renderCredentialPrompt(options);
        const card = document.getElementById(options.id)!;
        expect(card.style.top).toBe('150px');
        expect(card.style.right).toBe('100px');
        const root = card.shadowRoot!;
        expect(root.querySelector('nav label input')).not.toBeNull();
        expect(root.querySelector('#old')!.textContent).not.toContain('old-secret');
        root.querySelector('button.od-confirm-btn-primary')!.dispatchEvent(new Event('click', { bubbles: true }));
        expect(card.isConnected).toBe(true);
        card.dispatchEvent(new Event('opendesk-credential-dismiss'));
        expect(await result).toBe(false);
    });
    it('dismisses when its tab is hidden even though the shared toolbar has not moved', async () => {
        const result = renderCredentialPrompt(options);
        tab.style.display = 'none';
        // linkedom has no layout engine. A hidden webview emits a resize only to its registered observers.
        const guest = tab.querySelector('webview')!;
        for (const observer of resizeCallbacks) {
            if (observer.targets.has(guest)) observer.notify();
        }
        expect(document.getElementById(options.id)).toBeNull();
        expect(await result).toBe(false);
    });
});
