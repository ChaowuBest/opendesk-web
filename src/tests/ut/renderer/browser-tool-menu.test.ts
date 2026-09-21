import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { createBrowserToolMenu } from '../../../renderer/components/browserToolMenu.js';

let handles: Array<ReturnType<typeof createBrowserToolMenu>>;
beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        Element: window.Element,
        HTMLElement: window.HTMLElement
    });
    handles = [];
});
afterEach(() => handles.forEach((handle) => handle.destroy()));
function setup(shadow = false) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = shadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML = '<button id="more"></button><div id="menu"></div>';
    const button = root.querySelector<HTMLButtonElement>('#more')!;
    const menu = root.querySelector<HTMLElement>('#menu')!;
    let zoom = 1;
    const action = jest.fn();
    const handle = createBrowserToolMenu({
        button,
        menu,
        t: (key) => key,
        getZoom: () => zoom,
        setZoom: (value) => {
            zoom = value;
        },
        onAction: action
    });
    handles.push(handle);
    return { button, menu, handle, action, zoom: () => zoom };
}
describe('shared browser menu', () => {
    it('opens a submenu and dispatches its action through the owner once', () => {
        const { button, menu, action } = setup();
        button.click();
        const trigger = menu.querySelector<HTMLButtonElement>('[data-submenu="debug"]')!;
        const panel = menu.querySelector<HTMLElement>('.bm-flyout')!;
        expect(panel.hidden).toBe(true);
        trigger.click();
        expect(panel.hidden).toBe(false);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        panel.querySelector<HTMLButtonElement>('[data-action="snapshotDebug"]')!.click();
        expect(action).toHaveBeenCalledTimes(1);
        expect(action).toHaveBeenCalledWith('snapshotDebug');
        expect(panel.hidden).toBe(true);
        expect(menu.hidden).toBe(true);
    });
    it('renders the full menu, dispatches once, and keeps zoom controls open', () => {
        const { button, menu, action, zoom } = setup();
        button.click();
        expect(menu.hidden).toBe(false);
        expect(menu.querySelector('[data-action="openBrowserSettings"]')).not.toBeNull();
        menu.querySelector<HTMLButtonElement>('[data-action="zoomIn"]')!.click();
        expect(zoom()).toBe(1.1);
        expect(menu.querySelector('[data-zoom-value]')!.textContent).toBe('110%');
        expect(menu.hidden).toBe(false);
        menu.querySelector<HTMLButtonElement>('[data-action="print"]')!.click();
        expect(action).toHaveBeenCalledTimes(1);
        expect(action).toHaveBeenCalledWith('print');
        expect(menu.hidden).toBe(true);
    });
    it('uses composed event paths inside shadow DOM and removes listeners on destroy', () => {
        const { button, menu, handle } = setup(true);
        button.click();
        const inside = new window.Event('pointerdown');
        Object.defineProperty(inside, 'composedPath', { value: () => [menu, button.getRootNode(), document] });
        document.dispatchEvent(inside);
        expect(menu.hidden).toBe(false);
        document.dispatchEvent(new window.Event('pointerdown'));
        expect(menu.hidden).toBe(true);
        handle.destroy();
        button.click();
        expect(menu.hidden).toBe(true);
    });
    it('refreshes labels without opening a closed menu and closes on Escape', () => {
        const { button, menu, handle } = setup();
        handle.refresh();
        expect(menu.hidden).toBe(true);
        button.click();
        const event = new window.Event('keydown', { bubbles: true });
        Object.defineProperty(event, 'key', { value: 'Escape' });
        button.dispatchEvent(event);
        expect(menu.hidden).toBe(true);
    });
});
