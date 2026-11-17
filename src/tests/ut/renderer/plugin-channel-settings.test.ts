import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

// 插件仓库面板与测评集仓库面板共用 `RegistryChannelSettings`，差异全靠各自声明的配置
// （应用包名、接口方法名、文案前缀、DOM id）。这些用例就是「配置没写歪」的守门人：
// 少写/写错一项，按钮会指向不存在的方法，或文案串到测评集仓库上。

const OFFICIAL = {
    id: 'official',
    name: '官方插件市场',
    url: 'https://opendesk.matrix.openharmony.cn/static/categories/plugins.json',
    isEnabled: true,
    isDefault: true
};

const CUSTOM = {
    id: 'channel-1',
    name: '内网插件市场',
    url: 'https://internal.example.com/plugins.json',
    isEnabled: true,
    isDefault: false
};

describe('plugin-channel-settings', () => {
    let window: any;
    let document: any;
    let callMainWorld: any;
    let subscribeEvent: any;

    beforeAll(async () => {
        const parsed = parseHTML('<!doctype html><html><body></body></html>');
        window = parsed.window;
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            HTMLInputElement: window.HTMLInputElement,
            customElements: window.customElements
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });
        await import('../../../renderer/components/pluginChannelSettings.js');
    });

    beforeEach(() => {
        document = window.document;
        document.body.innerHTML = '';
        callMainWorld = jest.fn(async () => [OFFICIAL, CUSTOM]);
        subscribeEvent = jest.fn(async () => () => undefined);
        window.applicationRegistryAPI = { callMainWorld, subscribeEvent };
        window.notificationAPI = { sendNotification: jest.fn(async () => undefined) };
    });

    function createPanel(channels = [OFFICIAL, CUSTOM]) {
        // 不挂进 document：避免 connectedCallback 里的自动加载与用例里的手工状态互相覆盖
        const panel = document.createElement('plugin-channel-settings') as any;
        panel._channels = channels.map((channel: any) => ({ ...channel }));
        panel._loading = false;
        panel._error = '';
        panel.render();
        return panel;
    }

    function callsOf(fn: any, method: string): unknown[][] {
        return fn.mock.calls.filter((call: unknown[]) => call[1] === method);
    }

    test('renders the official marketplace without edit/delete actions', () => {
        const panel = createPanel();

        const officialRow = panel.querySelector('[data-channel-row="official"]');
        expect(officialRow).toBeTruthy();
        expect(officialRow.querySelector('[data-action="edit"]')).toBeNull();
        expect(officialRow.querySelector('[data-action="delete"]')).toBeNull();
        expect(officialRow.querySelector('[data-channel-toggle="official"]')).toBeTruthy();
        expect(officialRow.textContent).toContain('系统默认');
        // 标题与提示文案来自插件仓库自己的前缀，不能串到测评集仓库上
        expect(panel.textContent).toContain('插件仓库');

        const customRow = panel.querySelector('[data-channel-row="channel-1"]');
        expect(customRow.querySelector('[data-action="edit"]')).toBeTruthy();
        expect(customRow.querySelector('[data-action="delete"]')).toBeTruthy();
    });

    test('toggling a channel updates only that row and calls the plugin API', async () => {
        const panel = createPanel();
        const renderListSpy = jest.spyOn(panel, 'renderList');
        const status = panel.querySelector('[data-channel-status="channel-1"]');
        const otherStatus = panel.querySelector('[data-channel-status="official"]');
        const before = otherStatus.textContent;

        await panel.toggleChannel('channel-1', false);

        expect(callsOf(callMainWorld, 'setPluginChannelEnabled')).toEqual([
            ['pluginmgr', 'setPluginChannelEnabled', 'channel-1', false]
        ]);
        expect(status.textContent).toContain('已禁用');
        expect(otherStatus.textContent).toBe(before);
        expect(renderListSpy).not.toHaveBeenCalled();
    });

    test('a background refresh lists channels through the plugin API', async () => {
        const panel = createPanel();
        const renderListSpy = jest.spyOn(panel, 'renderList');

        await panel.reload({ silent: true });

        expect(callsOf(callMainWorld, 'listPluginChannels')).toHaveLength(1);
        // 数据没变就不重画：否则用户正在点的开关会被整片换掉
        expect(renderListSpy).not.toHaveBeenCalled();
    });

    test('adding a channel uses the plugin modal fields and keeps the panel shell', async () => {
        const panel = createPanel();
        callMainWorld = jest.fn(async (_bundle: string, method: string) =>
            method === 'addPluginChannel'
                ? [
                      OFFICIAL,
                      CUSTOM,
                      {
                          id: 'channel-2',
                          name: '新市场',
                          url: 'https://new.example.com/p.json',
                          isEnabled: true,
                          isDefault: false
                      }
                  ]
                : [OFFICIAL, CUSTOM]
        );
        window.applicationRegistryAPI = { callMainWorld, subscribeEvent };
        const addButton = panel.querySelector('#plugin-channel-add-btn');
        const renderSpy = jest.spyOn(panel, 'render');

        panel.openEditModal(null);
        const overlay = document.querySelector('.od-confirm-modal-overlay');
        overlay.querySelector('#od-pc-channel-name').value = '新市场';
        overlay.querySelector('#od-pc-channel-url').value = 'https://new.example.com/p.json';
        await panel.submitModal();

        expect(callsOf(callMainWorld, 'addPluginChannel')).toEqual([
            ['pluginmgr', 'addPluginChannel', { name: '新市场', url: 'https://new.example.com/p.json' }]
        ]);
        expect(renderSpy).not.toHaveBeenCalled();
        expect(panel.querySelector('[data-channel-row="channel-2"]')).toBeTruthy();
        expect(panel.querySelector('#plugin-channel-add-btn')).toBe(addButton);
    });

    test('a failed add keeps the modal open with the error text', async () => {
        const panel = createPanel();
        callMainWorld = jest.fn(async () => {
            throw new Error('插件清单验证失败');
        });
        window.applicationRegistryAPI = { callMainWorld, subscribeEvent };

        panel.openEditModal(null);
        const overlay = document.querySelector('.od-confirm-modal-overlay');
        overlay.querySelector('#od-pc-channel-name').value = 'X';
        overlay.querySelector('#od-pc-channel-url').value = 'https://x.example.com/p.json';
        await panel.submitModal();

        const errorBox = overlay.querySelector('[data-modal-error]');
        expect(errorBox.hidden).toBe(false);
        expect(errorBox.textContent).toContain('插件清单验证失败');
        expect(overlay.querySelector('[data-modal-confirm]').disabled).toBe(false);
    });
});
