import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createRendererTranslator } from '../../../renderer/locale.ts';
import { enUs } from '../../../locale/en-us.ts';
import { zhCn } from '../../../locale/zh-cn.ts';

describe('setting-panel tabs', () => {
    let window: any;
    let document: any;

    beforeAll(async () => {
        const parsed = parseHTML('<!doctype html><html><body></body></html>');
        window = parsed.window;
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });
        // linkedom 不提供 getComputedStyle：安全中心页要用它换算内嵌页高度，这里给个只回 padding 的替身
        (globalThis as any).getComputedStyle = () => ({ paddingTop: '0px', paddingBottom: '0px' });
        await import('../../../renderer/components/settingpanel.js');
    });

    beforeEach(() => {
        document = window.document;
        document.body.innerHTML = '';
        window.notificationAPI = { sendNotification: jest.fn(async () => undefined) };
    });

    function createPanel(locale = 'zh-CN') {
        const panel = document.createElement('setting-panel') as any;
        panel.currentData = {
            locale,
            resolved_locale: locale,
            gui_config: {},
            debug: {},
            environ: {},
            applications: {},
            providers: [],
            models: []
        };
        panel.gatewayHostOptions = [{ value: 'none', label: '无' }];
        panel._t = createRendererTranslator(panel.currentData);
        panel.updateDefaultModelSelects = jest.fn();
        return panel;
    }

    function tabOrder(panel: any): string[] {
        return Array.from(panel.querySelectorAll('.sp-nav-item[data-tab]')).map(
            (btn: Element) => (btn as any).dataset.tab
        );
    }

    test('general settings come first and channel settings follow search settings', () => {
        const panel = createPanel();
        panel.render();

        const order = tabOrder(panel);
        expect(order[0]).toBe('general');
        expect(order[order.indexOf('search') + 1]).toBe('registries');
        // 插件仓库不单独占页签，和测评集仓库一起放在「仓库设置」里
        expect(order).not.toContain('pluginRegistries');
        expect(order).toEqual([
            'general',
            'models',
            'tasks',
            'memory',
            'channels',
            'security',
            'agents',
            'search',
            'registries',
            'wizard'
        ]);
    });

    test('channel settings tab hosts both benchmark and plugin channel components', () => {
        const panel = createPanel();
        panel.render();

        const tab = panel.querySelector('#tab-registries');
        expect(tab).toBeTruthy();
        expect(tab.querySelector('benchmark-channel-settings')).toBeTruthy();
        // 插件仓库与测评集仓库同属「仓库设置」页签
        expect(tab.querySelector('plugin-channel-settings')).toBeTruthy();
    });

    test('general tab is the default visible tab', () => {
        const panel = createPanel();
        panel.render();

        expect(panel.querySelector('#tab-general')?.classList.contains('hidden')).toBe(false);
        expect(panel.querySelector('#tab-models')?.classList.contains('hidden')).toBe(true);
    });

    test('update section lives in the general tab, not the models tab', () => {
        const panel = createPanel();
        panel.updateState = { status: 'idle' };
        panel.render();

        expect(panel.querySelector('#tab-general #software-update-section')).toBeTruthy();
        expect(panel.querySelector('#tab-models #software-update-section')).toBeNull();
        // 通用设置区块独立于软件更新区块存在
        expect(panel.querySelector('#tab-general #general-sections section')).toBeTruthy();
    });

    test('switching to the channel settings tab unhides it only', () => {
        const panel = createPanel();
        panel.render();

        panel._switchTab('registries');

        expect(panel.querySelector('#tab-registries')?.classList.contains('hidden')).toBe(false);
        expect(panel.querySelector('#tab-general')?.classList.contains('hidden')).toBe(true);
        expect(panel.querySelector('#tab-search')?.classList.contains('hidden')).toBe(true);
    });

    test('memory tab is reachable through _switchTab', () => {
        const panel = createPanel();
        panel.render();

        panel._switchTab('memory');

        expect(panel.querySelector('#tab-memory')?.classList.contains('hidden')).toBe(false);
        expect(panel.querySelector('#tab-general')?.classList.contains('hidden')).toBe(true);
        // 页签内容里的记忆开关存在，说明 tab-memory 容器不是空壳
        expect(panel.querySelector('#tab-memory #memory-enabled-toggle')).toBeTruthy();
    });

    test('security tab mounts the AgentGate app page on first switch', () => {
        const panel = createPanel();
        panel.render();

        // 懒加载：没切进去之前不该创建 iframe，否则每次打开设置都会拉起 AgentGate
        expect(panel.querySelector('#security-app-frame')).toBeNull();

        panel._switchTab('security');

        const frame = panel.querySelector('#security-app-frame') as HTMLIFrameElement;
        expect(frame).toBeTruthy();
        // 走与侧边栏「应用」同一个壳页，靠 applicationBundleName 决定加载哪个 entry
        expect(frame.getAttribute('src')).toContain('applicationBundleName=agentgate');
    });

    test('security tab drops the content padding so the embedded page fills the column', () => {
        const panel = createPanel();
        panel.render();

        // 内嵌应用页自带整页内边距，内容区再叠一层会多出「卡片套卡片」的一层留白
        expect(panel.querySelector('.sp-scroll-content')?.classList.contains('sp-scroll-flush')).toBe(false);

        panel._switchTab('security');
        expect(panel.querySelector('.sp-scroll-content')?.classList.contains('sp-scroll-flush')).toBe(true);

        panel._switchTab('general');
        expect(panel.querySelector('.sp-scroll-content')?.classList.contains('sp-scroll-flush')).toBe(false);
    });

    test('theme change is forwarded into the embedded security frame', () => {
        const panel = createPanel();
        panel.render();
        // 事件绑定不在 render() 里，由 connectedCallback / refreshAll 调 setUpEventListeners
        panel.setUpEventListeners();
        panel._switchTab('security');

        // 主窗口的 broadcastThemeSettings 只遍历 appFrameCache，内嵌页不在那张表里；
        // 这里校验设置面板确实把 opendesk-theme-changed 转成了 THEME_SETTINGS 消息
        const forward = jest.fn();
        panel._forwardChromeToSecurityFrame = forward;

        document.dispatchEvent(
            new (window.CustomEvent as any)('opendesk-theme-changed', { detail: { effective: 'dark' } })
        );

        expect(forward).toHaveBeenCalledWith({ type: 'THEME_SETTINGS', theme: 'dark' });
    });

    test('channel settings nav label is localized', () => {
        const zhPanel = createPanel('zh-CN');
        zhPanel.render();
        expect(zhPanel.querySelector('[data-tab="registries"]')?.textContent?.trim()).toBe('仓库设置');

        const enPanel = createPanel('en-US');
        enPanel.currentData.locale = 'en-US';
        enPanel.currentData.resolved_locale = 'en-US';
        enPanel._t = createRendererTranslator(enPanel.currentData);
        enPanel.render();
        // 该页签同时管测评集仓库与插件仓库；英文不能再叫 Channels，否则和消息渠道页签重名
        expect(enPanel.querySelector('[data-tab="registries"]')?.textContent?.trim()).toBe('Registries');
    });

    test('设置页签标签在每种语言下都互不重名', () => {
        // 页签顺序见 settingpanel.js：少写或写错一项，侧边栏就会出现两个同名入口
        const tabKeys = [
            'general',
            'models',
            'tasks',
            'memory',
            'channels',
            'security',
            'agents',
            'search',
            'registryChannels',
            'wizard'
        ].map((id) => `sp.tab.${id}`);
        const localeDir = new URL('../../../../resources/plugins/language-packs/locales/', import.meta.url);
        const dicts: Array<[string, Record<string, string>]> = [
            ['zh-CN', zhCn],
            ['en-US', enUs]
        ];
        for (const file of readdirSync(localeDir).filter((name) => name.endsWith('.json'))) {
            dicts.push([file.replace(/\.json$/, ''), JSON.parse(readFileSync(new URL(file, localeDir), 'utf8'))]);
        }

        for (const [tag, dict] of dicts) {
            const labels = tabKeys.map((key) => dict[key]);
            // 用数量比较而不是 deepEqual 空数组：jest 的 toEqual 会忽略 undefined 元素，
            // 写成 [undefined] 与 [] 相等会让「语言包缺 key」静默通过
            expect([tag, labels.filter((label) => typeof label !== 'string').length]).toEqual([tag, 0]);
            expect([tag, labels.length, new Set(labels).size]).toEqual([tag, tabKeys.length, tabKeys.length]);
        }
    });

    test('saving aligns benchmark channels with the main process first', async () => {
        // 仓库由「仓库设置」组件直接写进主进程配置，面板手里的副本会变旧；
        // 保存整份配置前必须先对齐，否则刚加/删的仓库会被写回旧值。
        const panel = createPanel();
        const order: string[] = [];
        panel.currentData.applications = { benchmark: { channels: [{ id: 'stale', isEnabled: true }] } };
        panel.showSaveIndicator = jest.fn();
        window.settingAPI = {
            loadSettingObject: jest.fn(async () => {
                order.push('load');
                return {
                    applications: {
                        benchmark: { enabled: true, channels: [{ id: 'official', isEnabled: false }] }
                    }
                };
            }),
            saveSettingObjectDetailed: jest.fn(async (data: any) => {
                order.push('save');
                return { data, sideEffectFailures: [] };
            })
        };

        await panel.saveCurrentData();

        expect(order).toEqual(['load', 'save']);
        expect(panel.currentData.applications.benchmark).toEqual({
            enabled: true,
            channels: [{ id: 'official', isEnabled: false }]
        });
    });

    test('saving also aligns plugin channels with the main process', async () => {
        const panel = createPanel();
        panel.currentData.applications = {
            benchmark: { channels: [] },
            pluginmgr: { externalPaths: [], channels: [{ id: 'stale', isEnabled: true }] }
        };
        panel.showSaveIndicator = jest.fn();
        window.settingAPI = {
            loadSettingObject: jest.fn(async () => ({
                applications: {
                    benchmark: { channels: [] },
                    pluginmgr: { externalPaths: ['/plugins'], channels: [{ id: 'official', isEnabled: false }] }
                }
            })),
            saveSettingObjectDetailed: jest.fn(async (data: any) => ({ data, sideEffectFailures: [] }))
        };

        await panel.saveCurrentData();

        expect(panel.currentData.applications.pluginmgr).toEqual({
            externalPaths: ['/plugins'],
            channels: [{ id: 'official', isEnabled: false }]
        });
    });

    test('a failing channel sync still lets the save proceed', async () => {
        const panel = createPanel();
        panel.showSaveIndicator = jest.fn();
        window.settingAPI = {
            loadSettingObject: jest.fn(async () => {
                throw new Error('ipc down');
            }),
            saveSettingObjectDetailed: jest.fn(async (data: any) => ({
                data,
                sideEffectFailures: []
            }))
        };

        await panel.saveCurrentData();

        expect(window.settingAPI.saveSettingObjectDetailed).toHaveBeenCalledTimes(1);
    });
});
