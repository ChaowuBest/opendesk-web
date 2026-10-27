import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { TimeSchedulePicker } from '../../../main/applications/todomgr/renderer/time-schedule-picker.js';

describe('automation frequency menus in an inset fixed containing block', () => {
    let picker: TimeSchedulePicker;
    let container: HTMLElement;
    let appRoot: HTMLElement;

    function rectangle(left: number, top: number, width: number, height: number): DOMRect {
        return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top } as DOMRect;
    }

    beforeEach(() => {
        const { window } = parseHTML(
            '<!doctype html><html><body><div id="app-root"><div id="picker"></div></div></body></html>'
        );
        Object.assign(window, { innerWidth: 1280, innerHeight: 800 });
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            Element: window.Element,
            HTMLInputElement: window.HTMLInputElement,
            Event: window.Event
        });
        window.HTMLElement.prototype.focus = () => undefined;
        appRoot = document.getElementById('app-root')!;
        appRoot.style.transform = 'translateZ(0)';
        appRoot.getBoundingClientRect = () => rectangle(20, 20, 1240, 760);
        Object.assign(window, {
            getComputedStyle: (element: HTMLElement) => element.style
        });
        container = document.getElementById('picker')!;
        picker = new TimeSchedulePicker(
            container,
            (key) => key,
            () => 'UTC',
            () => undefined,
            undefined,
            'daily'
        );
        for (const menu of container.querySelectorAll<HTMLElement>('.tm-frequency-menu')) {
            Object.defineProperty(menu, 'scrollHeight', { value: 240 });
            menu.getBoundingClientRect = () => {
                const origin = appRoot.getBoundingClientRect();
                return rectangle(
                    origin.left + (parseFloat(menu.style.left) || 0),
                    origin.top + (parseFloat(menu.style.top) || 0),
                    parseFloat(menu.style.width) || 200,
                    Math.min(240, parseFloat(menu.style.maxHeight) || 320)
                );
            };
        }
    });

    afterEach(() => {
        picker.destroy();
    });

    function element<T extends HTMLElement = HTMLElement>(selector: string): T {
        return container.querySelector<T>(selector)!;
    }

    function anchor(left: number, top = 100, width = 200): void {
        element('#tm-frequency-period-trigger').getBoundingClientRect = () => rectangle(left, top, width, 40);
    }

    test('aligns the frequency menu with its trigger after subtracting the transformed root origin', () => {
        anchor(140, 160, 300);
        element('#tm-frequency-period-trigger').click();
        const menu = element('#tm-frequency-period-options').getBoundingClientRect();

        expect(menu.left).toBe(140);
        expect(menu.top).toBe(206);
    });
});
