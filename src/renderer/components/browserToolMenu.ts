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

import { BROWSER_TOOL_MENU_CSS } from './browserToolMenuStyles.js';

type Item = { label: string; icon: string; shortcut?: string; danger?: boolean };
const items = {
    newTab: { label: 'newTab', icon: 'plus', shortcut: '⌘T' },
    bookmarks: { label: 'favorites', icon: 'star', shortcut: '⌥⌘B' },
    history: { label: 'history', icon: 'clock-rotate-left', shortcut: '⌘Y' },
    downloads: { label: 'downloads', icon: 'download', shortcut: '⌥⌘L' },
    print: { label: 'print', icon: 'print', shortcut: '⌘P' },
    screenshot: { label: 'screenshot', icon: 'camera' },
    findInPage: { label: 'find', icon: 'magnifying-glass', shortcut: '⌘F' },
    consoleDebug: { label: 'devtools', icon: 'terminal' },
    snapshotDebug: { label: 'exportSnapshot', icon: 'sitemap' },
    clearHistoryData: { label: 'history', icon: 'clock-rotate-left' },
    clearCookies: { label: 'sub.cookies', icon: 'cookie-bite' },
    clearStorage: { label: 'sub.storage', icon: 'database' },
    clearCache: { label: 'sub.httpCache', icon: 'box-archive' },
    clearAutofill: { label: 'sub.passwords', icon: 'key' },
    clearAllData: { label: 'sub.allData', icon: 'trash-can', danger: true },
    openBrowserSettings: { label: 'settings', icon: 'gear' }
} satisfies Record<string, Item>;
export type BrowserMenuAction = keyof typeof items;
interface Options {
    button: HTMLButtonElement;
    menu: HTMLElement;
    t: (key: string) => string;
    getZoom: () => number;
    setZoom: (factor: number) => void;
    onAction: (action: BrowserMenuAction) => void | Promise<void>;
    onOpen?: () => void;
}
export interface BrowserToolMenuHandle {
    open(): void;
    close(): void;
    refresh(): void;
    updateZoom(): void;
    destroy(): void;
}

/** Shared menu presentation/interaction; browser-specific operations stay with the owning browser. */
export function createBrowserToolMenu(options: Options): BrowserToolMenuHandle {
    const { button, menu } = options;
    const doc = menu.ownerDocument;
    const win = doc.defaultView!;
    const allowed = new Set<BrowserMenuAction>(Object.keys(items) as BrowserMenuAction[]);
    let activeFlyout: { trigger: HTMLButtonElement; panel: HTMLElement } | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let destroyed = false;
    const style = doc.createElement('style');
    style.textContent = BROWSER_TOOL_MENU_CSS;
    menu.append(style);
    menu.classList.add('od-browser-menu');
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const t = (label: string) => options.t('renderer.browser.menu.' + label);
    const icon = (name: string) => {
        const el = doc.createElement('i');
        el.className = 'fas fa-' + name;
        el.setAttribute('aria-hidden', 'true');
        return el;
    };
    const divider = () => {
        const el = doc.createElement('div');
        el.className = 'bm-divider';
        el.setAttribute('role', 'separator');
        return el;
    };
    function item(data: Item, action?: string): HTMLButtonElement {
        const el = doc.createElement('button');
        el.type = 'button';
        el.className = 'bm-item';
        el.setAttribute('role', 'menuitem');
        if (action) el.dataset.action = action;
        const label = doc.createElement('span');
        label.className = 'bm-label';
        label.textContent = t(data.label);
        if (data.danger) label.classList.add('bm-danger');
        el.append(icon(data.icon), label);
        if (data.shortcut) {
            const shortcut = doc.createElement('span');
            shortcut.className = 'bm-shortcut';
            shortcut.textContent = data.shortcut;
            el.append(shortcut);
        }
        return el;
    }
    function cancelFlyoutClose() {
        if (closeTimer !== undefined) clearTimeout(closeTimer);
        closeTimer = undefined;
    }
    function closeFlyout() {
        cancelFlyoutClose();
        if (activeFlyout) {
            activeFlyout.panel.hidden = true;
            activeFlyout.trigger.setAttribute('aria-expanded', 'false');
        }
        activeFlyout = undefined;
    }
    function openFlyout(trigger: HTMLButtonElement, panel: HTMLElement) {
        closeFlyout();
        activeFlyout = { trigger, panel };
        panel.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        const anchor = trigger.getBoundingClientRect();
        const bounds = panel.getBoundingClientRect();
        const right = anchor.right + 6;
        const left = right + bounds.width <= win.innerWidth - 8 ? right : anchor.left - bounds.width - 6;
        panel.style.left = `${Math.max(8, Math.min(left, win.innerWidth - bounds.width - 8))}px`;
        panel.style.top = `${Math.max(8, Math.min(anchor.top - 4, win.innerHeight - bounds.height - 8))}px`;
    }
    function addGroup(actions: BrowserMenuAction[], submenu?: { label: string; icon: string }) {
        const available = actions;
        if (!submenu) {
            menu.append(...available.map((action) => item(items[action], action)));
            return;
        }
        const trigger = item(submenu);
        trigger.setAttribute('aria-haspopup', 'menu');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.dataset.submenu = submenu.label;
        trigger.append(icon('chevron-right'));
        const panel = doc.createElement('div');
        panel.className = 'bm-flyout';
        panel.hidden = true;
        panel.setAttribute('role', 'menu');
        panel.append(...available.map((action) => item(items[action], action)));
        menu.append(trigger, panel);
        trigger.addEventListener('click', () => openFlyout(trigger, panel));
        trigger.addEventListener('mouseenter', () => openFlyout(trigger, panel));
        panel.addEventListener('mouseenter', cancelFlyoutClose);
        for (const el of [trigger, panel])
            el.addEventListener('mouseleave', () => {
                cancelFlyoutClose();
                closeTimer = setTimeout(closeFlyout, 300);
            });
    }
    function updateZoom() {
        const value = menu.querySelector('[data-zoom-value]');
        if (value) value.textContent = `${Math.round(options.getZoom() * 100)}%`;
        const minus = menu.querySelector<HTMLButtonElement>('[data-action="zoomOut"]');
        const plus = menu.querySelector<HTMLButtonElement>('[data-action="zoomIn"]');
        if (minus) minus.disabled = options.getZoom() <= 0.25;
        if (plus) plus.disabled = options.getZoom() >= 3;
    }
    function render() {
        closeFlyout();
        menu.replaceChildren(style);
        addGroup(['newTab']);
        menu.append(divider());
        const zoom = doc.createElement('div');
        zoom.className = 'bm-zoom';
        const label = doc.createElement('span');
        label.className = 'bm-label';
        label.textContent = t('zoom');
        const controls = doc.createElement('div');
        controls.className = 'bm-zoom-controls';
        const value = doc.createElement('span');
        value.setAttribute('data-zoom-value', '');
        for (const [action, name, label] of [
            ['zoomOut', 'minus', 'zoomOut'],
            ['zoomIn', 'plus', 'zoomIn']
        ]) {
            const control = doc.createElement('button');
            control.type = 'button';
            control.dataset.action = action;
            control.setAttribute('aria-label', t(label));
            control.append(icon(name));
            controls.append(control);
            if (action === 'zoomOut') controls.append(value);
        }
        zoom.append(icon('magnifying-glass-plus'), label, controls);
        menu.append(zoom);
        const groups: Array<() => void> = [
            () => addGroup(['bookmarks', 'history', 'downloads']),
            () => {
                addGroup(['print', 'screenshot', 'findInPage']);
                addGroup(['consoleDebug', 'snapshotDebug'], { label: 'debug', icon: 'terminal' });
            },
            () =>
                addGroup(
                    ['clearHistoryData', 'clearCookies', 'clearStorage', 'clearCache', 'clearAutofill', 'clearAllData'],
                    { label: 'clearData', icon: 'trash-can' }
                ),
            () => addGroup(['openBrowserSettings'])
        ];
        for (const group of groups) {
            const separator = divider();
            menu.append(separator);
            group();
            if (separator === menu.lastElementChild) separator.remove();
        }
        updateZoom();
    }
    function close() {
        closeFlyout();
        menu.hidden = true;
        button.setAttribute('aria-expanded', 'false');
    }
    function open() {
        if (destroyed) return;
        options.onOpen?.();
        render();
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
    }
    function toggle(event: Event) {
        event.stopPropagation();
        if (menu.hidden) open();
        else close();
    }
    function onMenuClick(event: Event) {
        event.stopPropagation();
        const target = event.composedPath().find((node) => node instanceof Element) as Element | undefined;
        const action = target?.closest<HTMLElement>('[data-action]')?.dataset.action;
        if (action === 'zoomIn' || action === 'zoomOut') {
            options.setZoom(
                Math.max(
                    0.25,
                    Math.min(3, Math.round((options.getZoom() + (action === 'zoomIn' ? 0.1 : -0.1)) * 100) / 100)
                )
            );
            updateZoom();
            return;
        }
        if (!action || !allowed.has(action as BrowserMenuAction)) return;
        close();
        void Promise.resolve(options.onAction(action as BrowserMenuAction)).catch((error) =>
            console.error('Browser menu action failed', error)
        );
    }
    function outside(event: Event) {
        const path = event.composedPath();
        if (!path.includes(menu) && !path.includes(button)) close();
    }
    function keydown(event: KeyboardEvent) {
        if (event.key === 'Escape' && !menu.hidden) {
            event.preventDefault();
            event.stopPropagation();
            close();
            button.focus();
        }
    }
    button.addEventListener('click', toggle);
    button.addEventListener('keydown', keydown);
    menu.addEventListener('click', onMenuClick);
    menu.addEventListener('keydown', keydown);
    doc.addEventListener('pointerdown', outside, true);
    win.addEventListener('resize', close);
    win.addEventListener('blur', close);
    return {
        open,
        close,
        updateZoom,
        refresh: () => {
            if (!menu.hidden) render();
        },
        destroy: () => {
            if (destroyed) return;
            destroyed = true;
            close();
            button.removeEventListener('click', toggle);
            button.removeEventListener('keydown', keydown);
            menu.removeEventListener('click', onMenuClick);
            menu.removeEventListener('keydown', keydown);
            doc.removeEventListener('pointerdown', outside, true);
            win.removeEventListener('resize', close);
            win.removeEventListener('blur', close);
            menu.replaceChildren();
        }
    };
}
