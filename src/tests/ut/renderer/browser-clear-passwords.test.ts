import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { parseHTML } from 'linkedom';

const confirm = jest.fn<any>();
const info = jest.fn<any>();
const callMainWorld = jest.fn<any>();
jest.unstable_mockModule('../../../renderer/components/confirmModal.js', () => ({
    showConfirmModal: confirm,
    showInfoModal: info
}));
let EmbeddedBrowser: any;
beforeAll(async () => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        HTMLElement: window.HTMLElement,
        customElements: window.customElements,
        localStorage: { getItem: () => null }
    });
    (window as any).__odT = (key: string) => key;
    (window as any).applicationRegistryAPI = { callMainWorld };
    ({ EmbeddedBrowser } = await import('../../../renderer/browser.js'));
});
beforeEach(() => {
    confirm.mockReset().mockResolvedValue(true);
    info.mockReset().mockResolvedValue(undefined);
    callMainWorld.mockReset().mockResolvedValue({ success: true });
});
describe('task browser clear passwords', () => {
    it('exposes the action in the task menu and closes the menu before confirmation', async () => {
        const browser = Object.create(EmbeddedBrowser.prototype);
        browser._currentZoomFactor = 1;
        const menu = document.createElement('div');
        browser.toggleToolMenu(menu);
        const action = menu.querySelector('[data-action="clearPasswords"]');
        expect(action?.textContent).toContain('credentials.clear');
        action!.dispatchEvent(new window.Event('click'));
        expect(menu.classList.contains('bw-visible')).toBe(false);
        await Promise.resolve();
        expect(callMainWorld).toHaveBeenCalledWith('browser', 'clearAutofillData');
    });
    it('does not clear anything when confirmation is cancelled', async () => {
        confirm.mockResolvedValue(false);
        await Object.create(EmbeddedBrowser.prototype).handleToolMenuAction('clearPasswords');
        expect(callMainWorld).not.toHaveBeenCalled();
    });
    it.each([false, 'rejected'])('reports clearing failure (%s) instead of success', async (result) => {
        if (result === false) callMainWorld.mockResolvedValue({ success: false });
        else callMainWorld.mockRejectedValue(new Error('backend unavailable'));
        await Object.create(EmbeddedBrowser.prototype).handleToolMenuAction('clearPasswords');
        expect(info).toHaveBeenCalledWith(expect.objectContaining({ message: 'credentials.clearFailed' }));
    });
});
