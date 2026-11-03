import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

// 渠道设置面板的刷新契约：
// - 启停某个渠道只改这一行，不重建整个面板（否则设置界面其它 Tab 的 DOM 与滚动位置都会丢）；
// - 增删改只重画列表容器；
// - 系统默认渠道不提供编辑/删除入口。

const OFFICIAL = {
    id: 'official',
    name: '官方测评集',
    url: 'https://opendesk.matrix.openharmony.cn/static/categories/benchmarks.json',
    isEnabled: true,
    isDefault: true
};

const CUSTOM = {
    id: 'channel-1',
    name: '内网测评集',
    url: 'https://internal.example.com/benchmarks.json',
    isEnabled: true,
    isDefault: false
};

describe('benchmark-channel-settings', () => {
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
            customElements: window.customElements
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });
        await import('../../../renderer/components/benchmarkChannelSettings.js');
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
        const panel = document.createElement('benchmark-channel-settings') as any;
        panel._channels = channels.map((channel) => ({ ...channel }));
        panel._loading = false;
        panel._error = '';
        panel.render();
        return panel;
    }

    /** 只取某个方法的调用（appCall 的第一个参数是 bundle 名） */
    function callsOf(fn: any, method: string): unknown[][] {
        return fn.mock.calls.filter((call: unknown[]) => call[1] === method);
    }

    test('renders the built-in channel without edit/delete actions', () => {
        const panel = createPanel();

        const officialRow = panel.querySelector('[data-channel-row="official"]');
        expect(officialRow).toBeTruthy();
        expect(officialRow.querySelector('[data-action="edit"]')).toBeNull();
        expect(officialRow.querySelector('[data-action="delete"]')).toBeNull();
        // 系统默认渠道仍然可以启停
        expect(officialRow.querySelector('[data-channel-toggle="official"]')).toBeTruthy();
        expect(officialRow.textContent).toContain('系统默认');

        const customRow = panel.querySelector('[data-channel-row="channel-1"]');
        expect(customRow.querySelector('[data-action="edit"]')).toBeTruthy();
        expect(customRow.querySelector('[data-action="delete"]')).toBeTruthy();
    });

    test('toggling a channel updates only that row', async () => {
        const panel = createPanel();
        const renderSpy = jest.spyOn(panel, 'render');
        const renderListSpy = jest.spyOn(panel, 'renderList');
        const status = panel.querySelector('[data-channel-status="channel-1"]');
        const otherStatus = panel.querySelector('[data-channel-status="official"]');
        const before = otherStatus.textContent;

        await panel.toggleChannel('channel-1', false);

        expect(callsOf(callMainWorld, 'setBenchmarkChannelEnabled')).toEqual([
            ['benchmark', 'setBenchmarkChannelEnabled', 'channel-1', false]
        ]);
        expect(status.textContent).toContain('已禁用');
        expect(otherStatus.textContent).toBe(before);
        // 关键：整面板重建与列表重画都不该发生
        expect(renderSpy).not.toHaveBeenCalled();
        expect(renderListSpy).not.toHaveBeenCalled();
        expect(panel._channels.find((channel: any) => channel.id === 'channel-1').isEnabled).toBe(false);
    });

    test('a failed toggle rolls the row back', async () => {
        callMainWorld = jest.fn(async () => {
            throw new Error('boom');
        });
        window.applicationRegistryAPI = { callMainWorld, subscribeEvent };
        const panel = createPanel();

        await panel.toggleChannel('channel-1', false);

        const status = panel.querySelector('[data-channel-status="channel-1"]');
        expect(status.textContent).toContain('已启用');
        expect(panel.querySelector('[data-channel-toggle="channel-1"]').checked).toBe(true);
        expect(panel._channels.find((channel: any) => channel.id === 'channel-1').isEnabled).toBe(true);
        expect(window.notificationAPI.sendNotification).toHaveBeenCalled();
    });

    test('a failed toggle rolls back the live row even if the list was repainted meanwhile', async () => {
        // 请求在途时可能被一次后台刷新（registriesChanged）重画过：回滚必须改到画在页面上的那一行，
        // 而不是请求发起时抓到的、已经脱离文档的旧节点
        const panel = createPanel();
        callMainWorld = jest.fn(async (_bundle: string, method: string) => {
            if (method === 'setBenchmarkChannelEnabled') {
                panel.renderList();
                throw new Error('boom');
            }
            return [OFFICIAL, CUSTOM];
        });
        window.applicationRegistryAPI = { callMainWorld, subscribeEvent };

        await panel.toggleChannel('channel-1', false);

        expect(panel.querySelector('[data-channel-toggle="channel-1"]').checked).toBe(true);
        expect(panel.querySelector('[data-channel-status="channel-1"]').textContent).toContain('已启用');
    });

    test('a background refresh with unchanged data does not rebuild the rows', async () => {
        const panel = createPanel();
        const renderListSpy = jest.spyOn(panel, 'renderList');

        await panel.reload({ silent: true });

        expect(callsOf(callMainWorld, 'listBenchmarkChannels')).toHaveLength(1);
        expect(renderListSpy).not.toHaveBeenCalled();
    });

    test('a background refresh with new data rebuilds the rows', async () => {
        const panel = createPanel();
        callMainWorld = jest.fn(async () => [OFFICIAL, { ...CUSTOM, isEnabled: false }]);
        window.applicationRegistryAPI = { callMainWorld, subscribeEvent };

        await panel.reload({ silent: true });

        expect(panel.querySelector('[data-channel-status="channel-1"]').textContent).toContain('已禁用');
        // 重画出来的开关不再带 checked 属性
        expect(panel.querySelector('[data-channel-toggle="channel-1"]').hasAttribute('checked')).toBe(false);
    });

    test('the built-in channel offers no edit modal', () => {
        const panel = createPanel();
        panel.openEditModal('official');

        expect(panel._modal).toBeNull();
        expect(document.querySelector('.od-confirm-modal-overlay')).toBeNull();
    });

    test('adding a channel re-renders the list only and keeps the panel shell', async () => {
        const panel = createPanel();
        callMainWorld = jest.fn(async (_bundle: string, method: string) =>
            method === 'addBenchmarkChannel'
                ? [
                      OFFICIAL,
                      CUSTOM,
                      {
                          id: 'channel-2',
                          name: '新渠道',
                          url: 'https://new.example.com/benchmarks.json',
                          isEnabled: true,
                          isDefault: false
                      }
                  ]
                : [OFFICIAL, CUSTOM]
        );
        window.applicationRegistryAPI = { callMainWorld, subscribeEvent };
        const addButton = panel.querySelector('#benchmark-channel-add-btn');
        const renderSpy = jest.spyOn(panel, 'render');

        panel.openEditModal(null);
        const overlay = document.querySelector('.od-confirm-modal-overlay');
        expect(overlay).toBeTruthy();
        overlay.querySelector('#od-bm-channel-name').value = '新渠道';
        overlay.querySelector('#od-bm-channel-url').value = 'https://new.example.com/benchmarks.json';
        await panel.submitModal();

        expect(callsOf(callMainWorld, 'addBenchmarkChannel')).toEqual([
            ['benchmark', 'addBenchmarkChannel', { name: '新渠道', url: 'https://new.example.com/benchmarks.json' }]
        ]);
        expect(renderSpy).not.toHaveBeenCalled();
        expect(panel.querySelector('[data-channel-row="channel-2"]')).toBeTruthy();
        // 添加按钮仍然在原来的位置上（面板骨架没有被替换）
        expect(panel.querySelector('#benchmark-channel-add-btn')).toBe(addButton);
    });

    test('a failed add keeps the modal open with the error text', async () => {
        const panel = createPanel();
        callMainWorld = jest.fn(async () => {
            throw new Error('渠道地址校验失败');
        });
        window.applicationRegistryAPI = { callMainWorld, subscribeEvent };

        panel.openEditModal(null);
        const overlay = document.querySelector('.od-confirm-modal-overlay');
        overlay.querySelector('#od-bm-channel-name').value = 'X';
        overlay.querySelector('#od-bm-channel-url').value = 'https://x.example.com/benchmarks.json';
        await panel.submitModal();

        expect(panel._modal).toBeTruthy();
        const errorBox = overlay.querySelector('[data-modal-error]');
        expect(errorBox.hidden).toBe(false);
        expect(errorBox.textContent).toContain('渠道地址校验失败');
        const confirmButton = overlay.querySelector('[data-modal-confirm]');
        expect(confirmButton.disabled).toBe(false);
        expect(confirmButton.textContent).toBe('确定');
    });

    test('client-side validation stops the request when fields are empty', async () => {
        const panel = createPanel();

        panel.openEditModal(null);
        const overlay = document.querySelector('.od-confirm-modal-overlay');
        await panel.submitModal();

        expect(callsOf(callMainWorld, 'addBenchmarkChannel')).toHaveLength(0);
        expect(overlay.querySelector('[data-modal-error]').textContent).toContain('请填写渠道名称');

        overlay.querySelector('#od-bm-channel-name').value = 'X';
        await panel.submitModal();

        expect(callsOf(callMainWorld, 'addBenchmarkChannel')).toHaveLength(0);
        expect(overlay.querySelector('[data-modal-error]').textContent).toContain('请填写渠道地址');
    });
});
