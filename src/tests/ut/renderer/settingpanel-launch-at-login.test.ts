import { afterEach, beforeAll, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

beforeAll(async () => {
    const { window } = parseHTML('<html><body></body></html>');
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
const panels: any[] = [];
afterEach(() => {
    panels.splice(0).forEach((p) => p.disconnectedCallback());
    delete (window as any).native;
    visibility('visible');
});
function nativeStartup(handlers: {
    getLaunchAtLogin: () => any;
    setLaunchAtLogin?: (enabled: boolean) => any;
    openStartupSettings?: () => any;
}) {
    (window as any).native = {
        call: jest.fn(async (method: string, ...args: any[]) => {
            if (method === 'startupKit:getState') {
                const state = await handlers.getLaunchAtLogin();
                return { mode: 'toggle', ...state };
            }
            if (method === 'startupKit:delegateSetting') {
                return args[0] === undefined ? handlers.openStartupSettings?.() : handlers.setLaunchAtLogin?.(args[0]);
            }
            throw new Error('Unexpected native method: ' + method);
        })
    };
}
function visibility(value: string) {
    Object.defineProperty(document, 'visibilityState', { value, configurable: true });
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function panel(state = { supported: true, enabled: false }, tab = 'general') {
    const p = document.createElement('setting-panel') as any;
    p.currentData = {};
    p._activeTab = tab;
    Object.defineProperty(p, 'isConnected', { get: () => true });
    p.launchAtLoginState = { mode: 'toggle', ...state };
    panels.push(p);
    p.innerHTML = p.renderGeneralSection();
    p._bindLaunchAtLoginEvents();
    return p;
}
test('general settings renders a localized system startup switch', () => {
    const p = panel({ supported: true, enabled: true });
    expect(p.querySelector('#launch-at-login').hasAttribute('checked')).toBe(true);
    expect(p.textContent).toContain('Start OpenDesk at login');
    expect(p.textContent).not.toContain('sp.general.launchAtLogin');
    expect(panel({ supported: false, enabled: false }).querySelector('#launch-at-login').disabled).toBe(true);
});
test('loads actual state when first entering general settings', async () => {
    nativeStartup({ getLaunchAtLogin: jest.fn(async () => ({ supported: true, enabled: true })) });
    const p = panel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.querySelector('#launch-at-login').checked).toBe(true);
});
test('saves through system API, blocks concurrent changes, and rolls back on failure', async () => {
    let reject: (error: Error) => void;
    const setLaunchAtLogin = jest.fn(
        () =>
            new Promise((_, r) => {
                reject = r;
            })
    );
    nativeStartup({
        getLaunchAtLogin: async () => ({ supported: true, enabled: false }),
        setLaunchAtLogin
    });
    const p = panel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const input = p.querySelector('#launch-at-login');
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    expect(input.disabled).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(setLaunchAtLogin).toHaveBeenCalledWith(true);
    reject!(new Error('denied'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(input.checked).toBe(false);
    expect(input.disabled).toBe(false);
    expect(p.querySelector('#launch-at-login-status').textContent).toContain('Unable');
});
test('shows system refusal instead of claiming a successful enable', async () => {
    nativeStartup({
        getLaunchAtLogin: async () => ({ supported: true, enabled: false }),
        setLaunchAtLogin: async () => ({ supported: true, enabled: false })
    });
    const p = panel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const input = p.querySelector('#launch-at-login');
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(input.checked).toBe(false);
    expect(p.querySelector('#launch-at-login-status').textContent).toContain('system');
});

test('successful changes read the actual system state without saving the shared config', async () => {
    let systemEnabled = false;
    const setLaunchAtLogin = jest.fn(async (enabled: boolean) => {
        systemEnabled = enabled;
    });
    nativeStartup({
        getLaunchAtLogin: async () => ({ supported: true, enabled: systemEnabled }),
        setLaunchAtLogin
    });
    const p = panel();
    p.saveImmediately = jest.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const input = p.querySelector('#launch-at-login');
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(input.checked).toBe(true);
    expect(input.disabled).toBe(false);
    expect(p.launchAtLoginState.enabled).toBe(true);
    expect(p.saveImmediately).not.toHaveBeenCalled();
});

test('read failure keeps the switch disabled and reports a localized error', async () => {
    nativeStartup({
        getLaunchAtLogin: async () => {
            throw new Error('denied');
        }
    });
    const p = panel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.querySelector('#launch-at-login').disabled).toBe(true);
    expect(p.querySelector('#launch-at-login-status').textContent).toContain('Unable');
});

test('development instances keep the normal description without the installation notice', async () => {
    nativeStartup({
        getLaunchAtLogin: async () => ({ supported: false, enabled: false, reason: 'development' })
    });
    const p = panel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.querySelector('#launch-at-login').disabled).toBe(true);
    expect(p.querySelector('#launch-at-login-status').textContent).toBe(
        'Automatically open OpenDesk when you sign in to your computer.'
    );
    expect(p.textContent).not.toContain('Available in the installed app');
});

test('Harmony renders system management, opens settings, and refreshes status on return', async () => {
    let enabled = false;
    const openStartupSettings = jest.fn(async () => undefined);
    const setLaunchAtLogin = jest.fn();
    nativeStartup({
        getLaunchAtLogin: async () => ({ supported: true, enabled, mode: 'system-settings' }),
        openStartupSettings,
        setLaunchAtLogin
    });
    const p = panel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.querySelector('#launch-at-login-toggle').style.display).toBe('none');
    expect(p.querySelector('#launch-at-login-state').textContent).toBe('Off');
    p.querySelector('#launch-at-login-manage').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openStartupSettings).toHaveBeenCalledTimes(1);
    expect(setLaunchAtLogin).not.toHaveBeenCalled();
    enabled = true;
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.querySelector('#launch-at-login-state').textContent).toBe('On');
    p.disconnectedCallback();
});

test('Harmony settings failure is visible and does not turn startup on', async () => {
    nativeStartup({
        getLaunchAtLogin: async () => ({ supported: true, enabled: false, mode: 'system-settings' }),
        openStartupSettings: async () => {
            throw new Error('cannot open');
        }
    });
    const p = panel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    p.querySelector('#launch-at-login-manage').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.querySelector('#launch-at-login-state').textContent).toBe('Off');
    expect(p.querySelector('#launch-at-login-status').textContent).toContain('Unable to open');
    expect(p.querySelector('#launch-at-login-manage').disabled).toBe(false);
    p.disconnectedCallback();
});

test('leaving general settings invalidates an old query, and re-entry requests one fresh state', async () => {
    let resolveOld: (value: unknown) => void;
    const getLaunchAtLogin = jest
        .fn<any>()
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveOld = resolve;
                })
        )
        .mockResolvedValue({ supported: true, enabled: true, mode: 'system-settings' });
    nativeStartup({ getLaunchAtLogin });
    const p = panel();
    await settle();
    p._switchTab('models');
    p._switchTab('general');
    p._switchTab('general');
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(1);
    resolveOld!({ supported: true, enabled: false, mode: 'system-settings' });
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(2);
    expect(p.querySelector('#launch-at-login-state').textContent).toBe('On');
    p.disconnectedCallback();
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(2);
});

test('Harmony read failure stays unknown but still allows opening system settings', async () => {
    const openStartupSettings = jest.fn(async () => undefined);
    nativeStartup({
        getLaunchAtLogin: async () => ({
            supported: true,
            enabled: null,
            mode: 'system-settings',
            reason: 'unavailable'
        }),
        openStartupSettings
    });
    const p = panel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.querySelector('#launch-at-login-state').textContent).toBe('Status unknown');
    expect(p.querySelector('#launch-at-login-manage').disabled).toBe(false);
    expect(p.querySelector('#launch-at-login-status').textContent).toContain('Unable');
    p.querySelector('#launch-at-login-manage').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openStartupSettings).toHaveBeenCalledTimes(1);
    p.disconnectedCallback();
});

test('opening settings again invalidates a pending return query without swallowing the click', async () => {
    let resolveRefresh: (value: unknown) => void;
    const getLaunchAtLogin = jest
        .fn<any>()
        .mockResolvedValueOnce({ supported: true, enabled: false, mode: 'system-settings' })
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveRefresh = resolve;
                })
        );
    const openStartupSettings = jest.fn(async () => undefined);
    nativeStartup({ getLaunchAtLogin, openStartupSettings });
    const p = panel();
    await settle();
    p.querySelector('#launch-at-login-manage').click();
    await settle();
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(p.querySelector('#launch-at-login-manage').disabled).toBe(false);
    p.querySelector('#launch-at-login-manage').click();
    await settle();
    expect(openStartupSettings).toHaveBeenCalledTimes(2);
    resolveRefresh!({ supported: true, enabled: true, mode: 'system-settings' });
    await settle();
    expect(p.querySelector('#launch-at-login-state').textContent).toBe('Off');
});

test('transport failure after delegation becomes unknown instead of restoring a stale system state', async () => {
    const getLaunchAtLogin = jest
        .fn<any>()
        .mockResolvedValueOnce({ supported: true, enabled: false })
        .mockRejectedValueOnce(new Error('disconnected'));
    nativeStartup({ getLaunchAtLogin, setLaunchAtLogin: async () => undefined });
    const p = panel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const input = p.querySelector('#launch-at-login');
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.launchAtLoginState.enabled).toBeNull();
    expect(input.disabled).toBe(true);
    expect(p.querySelector('#launch-at-login-status').textContent).toContain('Unable');
});

test('unsupported native status queries do not block independent system settings delegation', async () => {
    const openStartupSettings = jest.fn(async () => undefined);
    nativeStartup({
        getLaunchAtLogin: async () => ({
            supported: false,
            enabled: null,
            mode: 'system-settings',
            reason: 'unsupported'
        }),
        openStartupSettings
    });
    const p = panel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(p.querySelector('#launch-at-login-state').textContent).toBe('Status unknown');
    expect(p.querySelector('#launch-at-login-manage').disabled).toBe(false);
    p.querySelector('#launch-at-login-manage').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openStartupSettings).toHaveBeenCalledTimes(1);
});

test('opening other settings tabs does not query; entering general queries exactly once', async () => {
    const getLaunchAtLogin = jest.fn(async () => ({ supported: true, enabled: false }));
    nativeStartup({ getLaunchAtLogin });
    const p = panel(undefined, 'models');
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(getLaunchAtLogin).not.toHaveBeenCalled();
    p._switchTab('general');
    p._switchTab('general');
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(1);
    p._switchTab('models');
    p._switchTab('general');
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(2);
});

test('re-rendering settings does not create a new query or duplicate focus subscriptions', async () => {
    const getLaunchAtLogin = jest.fn(async () => ({ supported: true, enabled: false }));
    nativeStartup({ getLaunchAtLogin });
    const p = panel();
    await settle();
    p.innerHTML = p.renderGeneralSection();
    p._bindLaunchAtLoginEvents();
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(1);
    expect(p.querySelector('#launch-at-login').disabled).toBe(false);
});

test('only a delegated system settings round trip refreshes, coalescing focus and visibility events', async () => {
    const getLaunchAtLogin = jest.fn(async () => ({ supported: true, enabled: false, mode: 'system-settings' }));
    nativeStartup({ getLaunchAtLogin, openStartupSettings: async () => undefined });
    const p = panel();
    await settle();
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(1);
    p.querySelector('#launch-at-login-manage').click();
    await settle();
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('blur'));
    visibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await settle();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(2);
});

test('returning from system settings while general is hidden waits for the next general entry', async () => {
    const getLaunchAtLogin = jest.fn(async () => ({ supported: true, enabled: false, mode: 'system-settings' }));
    nativeStartup({ getLaunchAtLogin, openStartupSettings: async () => undefined });
    const p = panel();
    await settle();
    p.querySelector('#launch-at-login-manage').click();
    await settle();
    p._switchTab('models');
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(1);
    p._switchTab('general');
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(2);
});

test('a return arriving before settings delegation resolves is consumed once after it succeeds', async () => {
    let finish: () => void;
    const getLaunchAtLogin = jest.fn(async () => ({ supported: true, enabled: false, mode: 'system-settings' }));
    nativeStartup({
        getLaunchAtLogin,
        openStartupSettings: () =>
            new Promise<void>((resolve) => {
                finish = resolve;
            })
    });
    const p = panel();
    await settle();
    p.querySelector('#launch-at-login-manage').click();
    await settle();
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(1);
    finish!();
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(2);
});

test('failed system settings delegation does not arm a later unrelated focus refresh', async () => {
    const getLaunchAtLogin = jest.fn(async () => ({ supported: true, enabled: false, mode: 'system-settings' }));
    nativeStartup({
        getLaunchAtLogin,
        openStartupSettings: async () => {
            throw new Error('denied');
        }
    });
    const p = panel();
    await settle();
    p.querySelector('#launch-at-login-manage').click();
    await settle();
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(1);
});

test('a pending entry query updates re-rendered controls without starting another query', async () => {
    let finish: (state: unknown) => void;
    const getLaunchAtLogin = jest.fn(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            })
    );
    nativeStartup({ getLaunchAtLogin });
    const p = panel();
    await settle();
    p.innerHTML = p.renderGeneralSection();
    p._bindLaunchAtLoginEvents();
    expect(p.querySelector('#launch-at-login').disabled).toBe(true);
    finish!({ supported: true, enabled: true });
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(1);
    expect(p.querySelector('#launch-at-login').checked).toBe(true);
    expect(p.querySelector('#launch-at-login').disabled).toBe(false);
});

test('system settings return queries only when the general panel is actually visible', async () => {
    const getLaunchAtLogin = jest.fn(async () => ({ supported: true, enabled: false, mode: 'system-settings' }));
    nativeStartup({ getLaunchAtLogin, openStartupSettings: async () => undefined });
    const p = panel();
    await settle();
    p.querySelector('#launch-at-login-manage').click();
    await settle();
    p.checkVisibility = () => false;
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(1);
    p.checkVisibility = () => true;
    visibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(1);
    visibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(2);
});

test('post-toggle read also satisfies a general entry queued while delegation is pending', async () => {
    let finish: () => void;
    let enabled = false;
    const getLaunchAtLogin = jest.fn(async () => ({ supported: true, enabled }));
    nativeStartup({
        getLaunchAtLogin,
        setLaunchAtLogin: () =>
            new Promise<void>((resolve) => {
                finish = () => {
                    enabled = true;
                    resolve();
                };
            })
    });
    const p = panel();
    await settle();
    const input = p.querySelector('#launch-at-login');
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    await settle();
    p._switchTab('models');
    p._switchTab('general');
    finish!();
    await settle();
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(2);
    expect(input.checked).toBe(true);
});

test('disconnecting during a query discards its result and removes all return listeners', async () => {
    let finish: (state: unknown) => void;
    const getLaunchAtLogin = jest.fn(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            })
    );
    nativeStartup({ getLaunchAtLogin });
    const p = panel();
    await settle();
    p.disconnectedCallback();
    finish!({ supported: true, enabled: true });
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(p.launchAtLoginState.enabled).toBe(false);
    expect(getLaunchAtLogin).toHaveBeenCalledTimes(1);
});
