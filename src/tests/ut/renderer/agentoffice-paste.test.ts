import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { chatPageHtml } from '../../../main/applications/agentoffice/webui/chat-page.js';

describe('agentoffice PowerPoint clipboard handling', () => {
    let WidgetClass: new () => HTMLElement;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            HTMLTextAreaElement: window.HTMLTextAreaElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        (window as any).applicationAPI = {
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };

        const module = await import('../../../main/applications/agentoffice/renderer/entry.js');
        WidgetClass = module.AgentOfficeEntryWidget;
    });

    beforeEach(() => {
        document.body.innerHTML = '';
    });

    function createPowerPointPasteEvent(): Event {
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', {
            value: {
                items: [
                    { type: 'text/plain' },
                    { type: 'text/html' },
                    { type: 'image/png', getAsFile: jest.fn(() => null) }
                ],
                getData: jest.fn((type: string) => {
                    if (type === 'text/plain') return 'Quarterly review';
                    if (type === 'text/html') {
                        return '<html><head><meta name="ProgId" content="PowerPoint.Slide"></head><body>Quarterly review</body></html>';
                    }
                    return '';
                })
            }
        });
        return event;
    }

    test('desktop composer leaves PowerPoint text to the textarea', () => {
        const widget = new WidgetClass() as any;
        widget.attachShadow({ mode: 'open' });
        widget.shadowRoot.innerHTML = '<textarea id="message-input"></textarea>';
        widget.bindEvents();
        const textarea = widget.shadowRoot.querySelector('#message-input') as HTMLTextAreaElement;
        const pasteEvent = createPowerPointPasteEvent();

        textarea.dispatchEvent(pasteEvent);

        expect(pasteEvent.defaultPrevented).toBe(false);
    });

    test('local web composer includes the PowerPoint text preference in its standalone script', () => {
        const html = chatPageHtml();

        expect(html).toContain('function hasPowerPointClipboardText(clipboardData)');
        expect(html).toContain('PowerPoint\\.Slide');
        expect(html).toContain('if (hasPowerPointClipboardText(event.clipboardData)) return;');
    });
});
