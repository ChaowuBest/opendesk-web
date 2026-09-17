import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('homepage recommendation fit', () => {
    let HomePage: new () => HTMLElement & { _checkRecFit: () => void };

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            getComputedStyle: () => ({ marginTop: '0px', marginBottom: '0px' })
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        await jest.unstable_mockModule('../../../renderer/components/workspacePicker.ts', () => ({
            showWorkspacePicker: jest.fn()
        }));
        await jest.unstable_mockModule('../../../renderer/locale.ts', () => ({
            createRendererTranslator: () => (key: string) => key
        }));

        window.settingAPI = {
            loadSettingObject: () => new Promise(() => undefined)
        };
        await import('../../../renderer/components/homepage.js');
        HomePage = window.customElements.get('home-page') as typeof HomePage;
    });

    test('shows recommendations again after the viewport grows while the collapse animation reports zero height', () => {
        const host = document.createElement('div');
        const page = new HomePage();
        page.innerHTML = `
            <div id="hp-container">
                <button id="hp-immersive-entry"></button>
                <div data-fixed="greeting"></div>
                <div data-fixed="input"></div>
                <div class="hp-rec-wrapper"></div>
                <div data-fixed="footer"></div>
            </div>`;

        let availableHeight = 450;
        Object.defineProperty(host, 'clientHeight', {
            configurable: true,
            get: () => availableHeight
        });

        const fixedHeights: Record<string, number> = { greeting: 40, input: 80, footer: 20 };
        page.querySelectorAll<HTMLElement>('[data-fixed]').forEach((element) => {
            const height = fixedHeights[element.dataset.fixed ?? ''] ?? 0;
            element.getBoundingClientRect = () => ({ height }) as DOMRect;
        });

        const entry = page.querySelector<HTMLElement>('#hp-immersive-entry')!;
        entry.getBoundingClientRect = () => ({ top: 40, bottom: 70, height: 30 }) as DOMRect;
        const footer = page.querySelector<HTMLElement>('[data-fixed="footer"]')!;
        footer.getBoundingClientRect = () => ({ top: 570, bottom: 590, height: 20 }) as DOMRect;

        const recommendations = page.querySelector<HTMLElement>('.hp-rec-wrapper')!;
        Object.defineProperty(recommendations, 'scrollHeight', { configurable: true, value: 265 });
        Object.defineProperty(recommendations, 'offsetHeight', { configurable: true, value: 0 });

        host.appendChild(page);
        page._checkRecFit();
        expect(recommendations.classList.contains('hp-rec-hidden')).toBe(true);

        availableHeight = 600;
        page._checkRecFit();
        expect(recommendations.classList.contains('hp-rec-hidden')).toBe(false);
    });
});
