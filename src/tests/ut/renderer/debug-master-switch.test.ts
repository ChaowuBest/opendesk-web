import { afterEach, beforeAll, beforeEach, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';
import { enUs } from '../../../locale/en-us.js';
import { zhCn } from '../../../locale/zh-cn.js';

const showConfirmModal = jest.fn(async (_options: Record<string, unknown>) => false);
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
    jest.unstable_mockModule('../../../renderer/components/confirmModal.ts', () =>
        confirmModalMockShim({ showConfirmModal })
    );
    await import('../../../renderer/components/settingpanel.js');
});

beforeEach(() => {
    showConfirmModal.mockReset().mockResolvedValue(false);
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
                immersive_desktop: true,
                builtin_terminal: true
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
    expect(saved.debug.experimental_features).toEqual({
        applications: { appmgr: false, agentoffice: false },
        account: false,
        immersive_desktop: false,
        builtin_terminal: false
    });
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

function rawLoggingPanel() {
    const panel = document.createElement('setting-panel') as any;
    panel.currentData = Setting.getSettingSchema().parse({ locale: 'en-US', debug: { developer_mode: true } });
    panel._t = (key: string) => enUs[key] ?? key;
    panel.innerHTML = panel.renderDebugModeSection();
    const save = jest.fn(async (data: unknown) => ({ data: structuredClone(data), sideEffectFailures: [] }));
    window.settingAPI = { saveSettingObjectDetailed: save } as any;
    const notify = jest.fn(async (..._args: unknown[]) => undefined);
    window.notificationAPI = { sendNotification: notify } as any;
    panel._bindDebugModeEvents();
    return { panel, save, notify, toggle: panel.querySelector('#log-raw-llm-toggle-hidden') as HTMLInputElement };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('raw logging label is short and risks are explained before any logging is enabled', async () => {
    const { panel, save, notify, toggle } = rawLoggingPanel();
    let confirm!: (enabled: boolean) => void;
    showConfirmModal.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                confirm = resolve;
            })
    );

    expect(toggle.closest('.sp-toggle-row')?.textContent?.trim()).toBe('Log Raw LLM Responses');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(panel.currentData.debug.log_raw_llm_request).toBe(false);
    expect(toggle.checked).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(showConfirmModal).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warn' }));
    const message = String(showConfirmModal.mock.calls[0][0].message);
    expect(message).toContain('large amount');
    expect(message).toContain('private');
    expect(message).toContain('one week');
    expect(message).toContain('next startup');
    expect(message).toContain('turns off');

    // 重复触发不会重复弹窗，普通配置保存也不能提前启用日志。
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(showConfirmModal).toHaveBeenCalledTimes(1);
    await panel.saveImmediately();
    expect(save.mock.calls[0][0].debug.log_raw_llm_request).toBe(false);

    confirm(true);
    await settle();
    expect(panel.currentData.debug.log_raw_llm_request).toBe(true);
    expect(toggle.checked).toBe(true);
    expect(save.mock.calls.at(-1)?.[0].debug.log_raw_llm_request).toBe(true);
    expect(notify).not.toHaveBeenCalled();

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await settle();
    expect(panel.currentData.debug.log_raw_llm_request).toBe(false);
    expect(showConfirmModal).toHaveBeenCalledTimes(1);
});

test('canceling the risk dialog leaves raw logging disabled without saving', async () => {
    const { panel, save, toggle } = rawLoggingPanel();
    panel._t = (key: string) => zhCn[key] ?? key;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await settle();

    expect(toggle.checked).toBe(false);
    expect(panel.currentData.debug.log_raw_llm_request).toBe(false);
    expect(save).not.toHaveBeenCalled();
    const message = String(showConfirmModal.mock.calls[0][0].message);
    expect(message).toContain('大量');
    expect(message).toContain('隐私');
    expect(message).toContain('一周');
    expect(message).toContain('下次启动');
    expect(message).toContain('下次重启');
});

test('turning off developer mode while confirmation is pending does not re-enable raw logging', async () => {
    const { panel, toggle } = rawLoggingPanel();
    let confirm!: (enabled: boolean) => void;
    showConfirmModal.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                confirm = resolve;
            })
    );
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    const developerMode = panel.querySelector('#debug-mode-toggle-hidden') as HTMLInputElement;
    developerMode.checked = false;
    developerMode.dispatchEvent(new Event('change'));
    confirm(true);
    await settle();
    expect(panel.currentData.debug.log_raw_llm_request).toBe(false);
    expect(toggle.checked).toBe(false);
});

test('a failed settings save does not announce that raw response logging is enabled', async () => {
    const { notify, toggle } = rawLoggingPanel();
    showConfirmModal.mockResolvedValueOnce(true);
    window.settingAPI.saveSettingObjectDetailed = jest.fn(async () => {
        throw new Error('write failed');
    }) as any;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('error');
});
