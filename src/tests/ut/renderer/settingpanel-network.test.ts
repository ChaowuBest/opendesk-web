import { beforeAll, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

beforeAll(async () => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        HTMLElement: window.HTMLElement,
        Event: window.Event,
        customElements: window.customElements
    });
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true });
    await import('../../../renderer/components/settingpanel.js');
});

function createPanel(useProxy = 'system') {
    const panel = document.createElement('setting-panel') as any;
    panel.currentData = { network_config: { use_proxy: useProxy, no_proxy: 'imap.corp.example.com' } };
    panel.saveImmediately = jest.fn();
    panel.innerHTML = panel.renderGeneralSection();
    panel._bindNetworkEvents();
    return panel;
}

test.each(['system', 'custom'])('%s proxy mode exposes and saves intranet bypass addresses', (mode) => {
    const panel = createPanel(mode);
    expect(panel.querySelector('#network-no-proxy-group').style.display).toBe('grid');
    expect(panel.querySelector('#network-custom-proxy-group').style.display).toBe(mode === 'custom' ? 'grid' : 'none');
    const input = panel.querySelector('#network-no-proxy-input');
    input.value = 'imap.corp.example.com,smtp.corp.example.com';
    input.dispatchEvent(new Event('change'));
    expect(panel.currentData.network_config.no_proxy).toBe(input.value);
    expect(panel.saveImmediately).toHaveBeenCalledTimes(1);
});

test('switching proxy modes preserves bypass addresses and only hides them in none mode', () => {
    const panel = createPanel('none');
    const select = panel.querySelector('#network-use-proxy-select');
    expect(panel.querySelector('#network-no-proxy-group').style.display).toBe('none');
    for (const mode of ['system', 'custom', 'none', 'system']) {
        Object.defineProperty(select, 'value', { value: mode, configurable: true });
        select.dispatchEvent(new Event('change'));
        expect(panel.querySelector('#network-no-proxy-group').style.display).toBe(mode === 'none' ? 'none' : 'grid');
        expect(panel.querySelector('#network-custom-proxy-group').style.display).toBe(
            mode === 'custom' ? 'grid' : 'none'
        );
        expect(panel.currentData.network_config.use_proxy).toBe(mode);
        expect(panel.currentData.network_config.no_proxy).toBe('imap.corp.example.com');
    }
    expect(panel.saveImmediately).toHaveBeenCalledTimes(4);
});
