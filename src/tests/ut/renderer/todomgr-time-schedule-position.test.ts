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

    function choosePeriod(mode: string): void {
        element('#tm-frequency-period-trigger').click();
        element(`[data-period-mode="${mode}"]`).click();
    }

    function expectInside(menu: HTMLElement): void {
        const bounds = appRoot.getBoundingClientRect();
        const rect = menu.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(bounds.left + 12);
        expect(rect.right).toBeLessThanOrEqual(bounds.right - 12);
        expect(rect.top).toBeGreaterThanOrEqual(bounds.top + 12);
        expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom - 12);
    }

    test('aligns the frequency menu with its trigger after subtracting the transformed root origin', () => {
        anchor(140, 160, 300);
        element('#tm-frequency-period-trigger').click();
        const menu = element('#tm-frequency-period-options').getBoundingClientRect();

        expect(menu.left).toBe(140);
        expect(menu.top).toBe(206);
    });

    test.each([
        [380, 280],
        [180, 120]
    ])('keeps the main menu inside a %s by %s visible content area', (width, height) => {
        appRoot.getBoundingClientRect = () => rectangle(20, 20, width, height);
        anchor(width - 20, height - 40, 30);
        element('#tm-frequency-period-trigger').click();

        expectInside(element('#tm-frequency-period-options'));
    });

    test.each([
        ['right', 1240, 40],
        ['left', 780, 550],
        ['compact', 380, 180]
    ])('places a period submenu to the %s using the visible content bounds', (placement, width, triggerLeft) => {
        appRoot.getBoundingClientRect = () => rectangle(20, 20, Number(width), 760);
        anchor(Number(triggerLeft));
        const option = element('[data-period-mode="weekly"]');
        option.getBoundingClientRect = () => {
            const parent = element('#tm-frequency-period-options').getBoundingClientRect();
            return rectangle(parent.left, parent.top + 40, parent.width, 40);
        };
        choosePeriod('weekly');
        const parent = element('#tm-frequency-period-options').getBoundingClientRect();
        const submenu = element('#tm-frequency-period-day-options');
        const rect = submenu.getBoundingClientRect();

        expectInside(submenu);
        if (placement === 'right') expect(rect.left).toBe(parent.right + 6);
        if (placement === 'left') expect(rect.right).toBe(parent.left - 6);
        expect(rect.top).toBe(placement === 'compact' ? parent.top : option.getBoundingClientRect().top);
        expect(element('#tm-frequency-days-back').hidden).toBe(placement !== 'compact');
    });

    test.each([
        ['right', 1240, 40],
        ['left', 880, 650],
        ['compact', 380, 180]
    ])('places yearly dates to the %s without leaving the content area', (placement, width, triggerLeft) => {
        appRoot.getBoundingClientRect = () => rectangle(20, 20, Number(width), 760);
        anchor(Number(triggerLeft));
        const yearly = element('[data-period-mode="yearly"]');
        yearly.getBoundingClientRect = () => {
            const parent = element('#tm-frequency-period-options').getBoundingClientRect();
            return rectangle(parent.left, parent.top + 40, parent.width, 40);
        };
        choosePeriod('yearly');
        const month = element<HTMLInputElement>('[data-calendar-kind="months"][data-calendar-value="2"]');
        month.checked = true;
        month.dispatchEvent(new Event('change', { bubbles: true }));
        const months = element('#tm-frequency-months-options').getBoundingClientRect();
        const dates = element('#tm-frequency-dates-options');
        const rect = dates.getBoundingClientRect();

        expectInside(dates);
        if (placement === 'right') expect(rect.left).toBe(months.right + 6);
        if (placement === 'left') expect(rect.right).toBe(months.left - 6);
        expect(rect.top).toBe(months.top);
        expect(element('#tm-frequency-dates-back').hidden).toBe(placement !== 'compact');
    });

    test('caps both nested yearly menus to the visible content height', () => {
        appRoot.getBoundingClientRect = () => rectangle(20, 20, 1240, 160);
        anchor(40, 120);
        element('[data-period-mode="yearly"]').getBoundingClientRect = () => rectangle(40, 150, 200, 40);
        choosePeriod('yearly');
        const month = element<HTMLInputElement>('[data-calendar-kind="months"][data-calendar-value="2"]');
        month.checked = true;
        month.dispatchEvent(new Event('change', { bubbles: true }));

        expectInside(element('#tm-frequency-months-options'));
        expectInside(element('#tm-frequency-dates-options'));
    });
});
