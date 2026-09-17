import { afterEach, beforeAll, expect, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { Setting, isDebugLogEnabled, isLogRawLlmRequestEnabled } from '../../../main/utils/setting.js';
import { isAccountFeatureEnabled } from '../../../renderer/utils/account-feature-visibility.js';
import { isApplicationVisibleInMenu } from '../../../renderer/utils/application-visibility.js';

beforeAll(async () => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        HTMLElement: window.HTMLElement,
        CustomEvent: window.CustomEvent,
        Event: window.Event,
        customElements: window.customElements
    });
    Object.defineProperty(globalThis, 'navigator', {
        value: { languages: ['zh-CN'], language: 'zh-CN' },
        configurable: true
    });
    await import('../../../renderer/components/settingpanel.js');
});

afterEach(() => {
    Setting.clearCache();
});

test('turning off development and debugging disables its previously enabled child features', () => {
    const panel = document.createElement('setting-panel') as any;
    panel.currentData = Setting.getSettingSchema().parse({
        debug: {
            developer_mode: true,
            debug_log: true,
            log_raw_llm_request: true,
            experimental_features: {
                applications: { appmgr: true, agentoffice: true },
                account: true,
                magic_pointer: true
            }
        }
    });
    panel.innerHTML = panel.renderDebugModeSection();
    panel.saveImmediately = () => Setting.updateInstanceData(panel.currentData);
    panel._bindDebugModeEvents();

    const toggle = panel.querySelector('#debug-mode-toggle-hidden') as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));

    const saved = Setting.getInstance().getData();
    expect(saved.debug.developer_mode).toBe(false);
    expect(panel.querySelector('#debug-mode-settings').style.display).toBe('none');
    expect(saved.debug.experimental_features.magic_pointer).toBe(false);
    const effectiveFeatures = {
        debugLog: isDebugLogEnabled(),
        rawLlmLog: isLogRawLlmRequestEnabled(),
        account: isAccountFeatureEnabled(saved),
        appmgr: isApplicationVisibleInMenu(
            { bundleName: 'appmgr', isExperimental: true },
            saved.debug.experimental_features
        ),
        agentoffice: isApplicationVisibleInMenu(
            { bundleName: 'agentoffice', isExperimental: true },
            saved.debug.experimental_features
        )
    };
    expect(effectiveFeatures).toEqual({
        debugLog: false,
        rawLlmLog: false,
        account: false,
        appmgr: false,
        agentoffice: false
    });

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(panel.querySelector('#debug-mode-settings').style.display).toBe('');
    const childToggles = Array.from(
        panel.querySelectorAll('#debug-mode-settings input[type="checkbox"]')
    ) as HTMLInputElement[];
    expect(childToggles).toHaveLength(7);
    expect(childToggles.every((input) => !input.checked)).toBe(true);
    expect(Setting.getInstance().getData().debug).toEqual({ ...saved.debug, developer_mode: true });
});
