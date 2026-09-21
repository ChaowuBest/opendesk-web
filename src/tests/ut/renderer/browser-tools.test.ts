import { beforeEach, afterEach, expect, it, jest } from '@jest/globals';
import { parseHTML } from 'linkedom';
import type { WebviewTag } from 'electron';
import { BrowserTools } from '../../../renderer/browser/browserTools.js';
import { saveHistory } from '../../../renderer/browser/browserData.js';
let tools: BrowserTools[] = [];
let restore: Array<() => void> = [];
beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    const data = new Map<string, string>();
    const values = {
        window,
        document: window.document,
        Element: window.Element,
        HTMLElement: window.HTMLElement,
        CustomEvent: window.CustomEvent,
        localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) }
    };
    restore = Object.entries(values).map(([k, value]) => {
        const original = Object.getOwnPropertyDescriptor(globalThis, k);
        Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
        return () => {
            if (original) Object.defineProperty(globalThis, k, original);
            else Reflect.deleteProperty(globalThis, k);
        };
    });
});
afterEach(() => {
    tools.forEach((t) => t.destroy());
    tools = [];
    restore.reverse().forEach((f) => f());
});
function setup(shadow: boolean, guest: WebviewTag | null = null) {
    const host = document.createElement('div');
    document.body.append(host);
    const mount = document.createElement('div');
    (shadow ? host.attachShadow({ mode: 'open' }) : host).append(mount);
    const navigate = jest.fn();
    const instance = new BrowserTools({
        container: mount,
        t: (k: string) => k,
        navigateTo: navigate,
        addTab: navigate,
        getWebview: () => guest,
        closeMenu: () => {},
        getUserAgent: () => '',
        setUserAgent: () => {}
    });
    tools.push(instance);
    return { instance, mount, navigate };
}
it('opens the same history panel in both browsers and follows links in the owning browser', async () => {
    const application = setup(false),
        task = setup(true);
    saveHistory([{ url: 'https://example.com/', title: 'Example', timestamp: 1 }]);
    for (const view of [application, task]) {
        await view.instance.handleAction('history');
        const link = view.mount.querySelector<HTMLElement>('.wb-history-item')!;
        expect(link.textContent).toContain('Example');
        link.click();
        expect(view.navigate).toHaveBeenCalledWith('https://example.com/');
    }
});
it('routes print, screenshot and find to the owning active guest', async () => {
    const guest = {
        print: jest.fn(),
        getWebContentsId: () => 42,
        getTitle: () => 'Page',
        findInPage: jest.fn(),
        stopFindInPage: jest.fn()
    };
    const capture = jest.fn<() => Promise<string>>().mockResolvedValue('data:image/png;base64,fixture');
    const save = jest.fn<() => Promise<void>>().mockResolvedValue();
    Object.assign(window, { browserAPI: { captureScreenshot: capture }, magicPointerAPI: { saveScreenshot: save } });
    const { instance, mount } = setup(true, guest as unknown as WebviewTag);
    await instance.handleAction('print');
    expect(guest.print).toHaveBeenCalledTimes(1);
    await instance.handleAction('screenshot');
    expect(capture).toHaveBeenCalledWith(42);
    expect(save).toHaveBeenCalledWith('data:image/png;base64,fixture', 'Page');
    await instance.handleAction('findInPage');
    const input = mount.querySelector<HTMLInputElement>('.wb-find input')!;
    input.value = 'needle';
    input.dispatchEvent(new window.Event('input'));
    expect(guest.findInPage).toHaveBeenCalledWith('needle');
    instance.destroy();
    expect(guest.stopFindInPage).toHaveBeenCalledWith('keepSelection');
});
it('mounts and cleans up the shared settings and downloads panels', async () => {
    const { instance, mount } = setup(true);
    await instance.handleAction('openBrowserSettings');
    expect(mount.querySelector('[data-action="bs-clear-autofill"]')).not.toBeNull();
    await instance.handleAction('downloads');
    expect(mount.querySelector('.wb-downloads-panel.wb-visible')).not.toBeNull();
    instance.destroy();
    expect(mount.querySelector('.od-browser-tools')).toBeNull();
});
it('shares download updates and removals between the two menu hosts', async () => {
    const app = setup(false),
        task = setup(true);
    const remove = jest.fn<() => Promise<void>>().mockResolvedValue();
    Object.assign(window, { downloadAPI: { clearDownload: remove } });
    window.dispatchEvent(
        new CustomEvent('browser-download-update', {
            detail: {
                id: 'download-1',
                filename: 'example.txt',
                state: 'completed',
                receivedBytes: 12,
                totalBytes: 12,
                startTime: 1
            }
        })
    );
    for (const host of [app, task]) await host.instance.handleAction('downloads');
    app.mount.querySelector<HTMLElement>('.wb-dl-clear')!.click();
    await Promise.resolve();
    expect(remove).toHaveBeenCalledWith('download-1');
    expect(task.mount.querySelector('.wb-dl-item')).toBeNull();
});
