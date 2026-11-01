import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { createRendererTranslator } from '../../../renderer/locale.ts';

// 回归背景：section 定位修复之外，review 发现 setting-panel 的事件订阅存在
// 三类相邻缺陷：
// 1. refreshGeneralSection 会重新绑定 #software-update-action（该按钮属于 tab-models，
//    重建 tab-general 不应触碰），导致修改缩放系数/网关配置后"检查更新"被触发多次；
// 2. setUpEventListeners 每次调用都新建 onScaleFactorChanged 订阅且不退订旧订阅；
// 3. connectedCallback 的异步初始化期间元素被移除时，仍会完成 render 并订阅
//    onStateChanged，订阅永不退订；disconnectedCallback 也未退订缩放订阅与 ESC 监听。

describe('setting-panel listener lifecycle', () => {
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

        // linkedom 的 HTMLSelectElement.value 只有 getter，补一个可写实现
        const selectProto = (window.HTMLSelectElement as any).prototype;
        if (selectProto && !Object.getOwnPropertyDescriptor(selectProto, 'value')?.set) {
            Object.defineProperty(selectProto, 'value', {
                get() {
                    return this._value ?? '';
                },
                set(v) {
                    this._value = v;
                },
                configurable: true
            });
        }

        await import('../../../renderer/components/settingpanel.js');
    });

    beforeEach(() => {
        document = window.document;
        document.body.innerHTML = '';
        window.displayAPI = undefined;
        window.updateAPI = undefined;
        window.settingAPI = undefined;
        // tab-channels 内嵌 <channel-settings-panel>，初始化时会订阅应用事件
        window.applicationRegistryAPI = {
            subscribeEvent: jest.fn(() => jest.fn()),
            callMainWorld: jest.fn(async () => [])
        };
    });

    function createPanel() {
        const panel = document.createElement('setting-panel') as any;
        panel.currentData = {
            locale: 'zh-CN',
            resolved_locale: 'zh-CN',
            gui_config: {},
            debug: {},
            environ: {},
            applications: {},
            network_config: {},
            providers: [
                {
                    name: 'openai',
                    provider_type: 'openai',
                    base_url: 'https://api.openai.com/v1',
                    api_key: 'sk-test'
                }
            ],
            models: [
                {
                    alias: 'gpt',
                    provider_name: 'openai',
                    model_name: 'gpt-4',
                    model_type: 'chat'
                }
            ]
        };
        panel.gatewayHostOptions = [];
        panel.supportedShells = [];
        panel.providerTemplates = [];
        panel.appVersion = '0.3.7';
        panel.updateState = { status: 'idle' };
        panel._t = createRendererTranslator(panel.currentData);
        return panel;
    }

    function renderTabModels(panel: any) {
        return `
            <div id="tab-models">
                ${panel.renderUpdateSection()}
                ${panel.renderProvidersSection()}
                ${panel.renderModelsSection()}
                ${panel.renderDefaultModelsSection()}
            </div>`;
    }

    test('refreshGeneralSection does not re-bind the software-update action listener', () => {
        const panel = createPanel();
        panel.innerHTML = `${renderTabModels(panel)}<div id="tab-general">${panel.renderGeneralSection()}</div>`;
        panel.setUpEventListeners();

        const action = panel.querySelector('#software-update-action');
        const original = action.addEventListener.bind(action);
        let bindCount = 0;
        action.addEventListener = (...args: any[]) => {
            bindCount += 1;
            return original(...args);
        };

        panel.refreshGeneralSection();

        // #software-update-action 属于 tab-models，重建 tab-general 不应再次绑定
        expect(bindCount).toBe(0);
    });

    test('setUpEventListeners replaces the previous scale-factor subscription', () => {
        const firstUnsub = jest.fn();
        const secondUnsub = jest.fn();
        let callCount = 0;
        window.displayAPI = {
            onScaleFactorChanged: jest.fn(() => {
                callCount += 1;
                return callCount === 1 ? firstUnsub : secondUnsub;
            })
        };

        const panel = createPanel();
        panel.innerHTML = `<div id="tab-general">${panel.renderGeneralSection()}</div>`;
        panel.setUpEventListeners();
        panel.setUpEventListeners();

        expect(window.displayAPI.onScaleFactorChanged).toHaveBeenCalledTimes(2);
        // 第二次订阅前应先退订第一次的订阅，避免回调累积
        expect(firstUnsub).toHaveBeenCalledTimes(1);
    });

    test('缩放应用失败时提示错误且不写入本地配置', async () => {
        const failure = new Error('setting write failed');
        window.displayAPI = {
            setScaleFactor: jest.fn(async () => {
                throw failure;
            })
        };
        window.notificationAPI = { sendNotification: jest.fn() };

        const panel = createPanel();
        panel.innerHTML = `<div id="tab-general">${panel.renderGeneralSection()}</div>`;
        panel.setUpEventListeners();

        const input = panel.querySelector('#scale-factor-input');
        input.value = '150';
        input.dispatchEvent(new window.Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(window.displayAPI.setScaleFactor).toHaveBeenCalledWith(1.5);
        // 修复前：setScaleFactor 的拒绝无人接管，且本地值已被改写
        expect(panel.currentData.gui_config.scale_factor).toBeUndefined();
        expect(window.notificationAPI.sendNotification).toHaveBeenCalled();
    });

    test('disconnectedCallback unsubscribes scale-factor and update subscriptions', async () => {
        const scaleUnsub = jest.fn();
        const updateUnsub = jest.fn();
        window.displayAPI = { onScaleFactorChanged: jest.fn(() => scaleUnsub) };
        window.updateAPI = {
            getState: jest.fn(async () => ({ status: 'idle' })),
            onStateChanged: jest.fn(() => updateUnsub)
        };
        window.settingAPI = {
            loadSettingObject: jest.fn(async () => ({ locale: 'zh-CN' })),
            listShells: jest.fn(async () => []),
            getProviderTemplates: jest.fn(async () => []),
            getGatewayHostOptions: jest.fn(async () => []),
            getVersion: jest.fn(async () => '0.0.0'),
            getBuildTime: jest.fn(async () => null),
            checkVisionSupport: jest.fn(async () => ({}))
        };

        const panel = document.createElement('setting-panel');
        document.body.appendChild(panel);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        panel.remove();

        expect(updateUnsub).toHaveBeenCalledTimes(1);
        // 修复前：缩放订阅不会被退订
        expect(scaleUnsub).toHaveBeenCalledTimes(1);
    });

    test('connectedCallback skips rendering and subscribing when removed before data loads', async () => {
        const updateUnsub = jest.fn();
        window.updateAPI = {
            getState: jest.fn(async () => ({ status: 'idle' })),
            onStateChanged: jest.fn(() => updateUnsub)
        };
        window.settingAPI = {
            loadSettingObject: jest.fn(async () => ({ locale: 'zh-CN' })),
            listShells: jest.fn(async () => []),
            getProviderTemplates: jest.fn(async () => []),
            getGatewayHostOptions: jest.fn(async () => []),
            getVersion: jest.fn(async () => '0.0.0'),
            getBuildTime: jest.fn(async () => null),
            checkVisionSupport: jest.fn(async () => ({}))
        };

        const panel = document.createElement('setting-panel');
        document.body.appendChild(panel);
        panel.remove();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // 异步初始化期间元素已被移除：不应再渲染 DOM，也不应订阅 onStateChanged
        expect(window.updateAPI.onStateChanged).not.toHaveBeenCalled();
        expect(panel.innerHTML).toBe('');
    });
});
