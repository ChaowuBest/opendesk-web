import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';
import type { InstalledBenchmarkSummary, ModelOption } from '../../../main/applications/benchmark/common.js';

const ORIGINAL: ModelOption = {
    alias: 'original-model',
    model_name: 'original',
    provider_name: 'fixture',
    isDefault: true,
    vision: false,
    defaultEffort: 'high',
    efforts: ['', 'low', 'high']
};
const ADDED: ModelOption = { ...ORIGINAL, alias: 'added-model', model_name: 'added', isDefault: false };
const DATASET: InstalledBenchmarkSummary = {
    id: 'ds-1',
    name: 'Fixture',
    description: '',
    homepage: '',
    version: '1.0.0',
    importedAt: 0,
    caseCount: 1,
    tracks: [{ id: 'track-1', name: 'Track', caseCount: 1 }]
};

describe('benchmark model configuration refresh', () => {
    let widget: any;
    let models: ModelOption[];
    let callMainWorld: jest.Mock<(method: string) => Promise<unknown>>;
    let notifySettingChanged: (setting: unknown) => void;
    let settingCallbacks: Array<(setting: unknown) => void>;

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            CSS: { escape: (value: string) => value },
            requestAnimationFrame: (callback: FrameRequestCallback) => {
                callback(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined
        });
        await jest.unstable_mockModule('../../../main/applications/widget_utils.js', () => ({
            AgentOperableHTMLElement: class extends HTMLElement {},
            RendererTool: class {},
            RendererToolset: class {}
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-iframe-bridge.ts', () => ({
            OPENDESK_THEME_CHANGED: 'opendesk-theme-changed'
        }));
        await jest.unstable_mockModule('../../../renderer/components/confirmModal', () => confirmModalMockShim());
        await import('../../../main/applications/benchmark/renderer/entry.js');
    });

    beforeEach(async () => {
        models = [ORIGINAL];
        callMainWorld = jest.fn(async (method: string) => {
            if (method === 'listModels') return [...models];
            if (method === 'listDatasets') return [DATASET];
            return [];
        });
        (window as any).applicationAPI = {
            callMainWorld,
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };
        settingCallbacks = [];
        // 与 preload 的 settingChangedDispatcher 一致：一个通道允许多个订阅者，
        // 后订阅者不会顶掉先订阅者（locale 翻译器也会自行订阅 setting:changed）
        (window as any).settingAPI = {
            loadSettingObject: async () => ({ locale: 'zh-CN' }),
            onSettingChanged: (callback: (setting: unknown) => void) => {
                settingCallbacks.push(callback);
                return () => {
                    const index = settingCallbacks.indexOf(callback);
                    if (index >= 0) settingCallbacks.splice(index, 1);
                };
            }
        };
        notifySettingChanged = (setting) => {
            for (const callback of [...settingCallbacks]) callback(setting);
        };
        widget = document.createElement('benchmark-entry-widget');
        // 手动等待完整挂载，避免 custom element 的异步生命周期在断言之后继续运行。
        Object.defineProperty(widget, 'isConnected', { configurable: true, value: true });
        await widget.connectedCallback();
        callMainWorld.mockClear();
    });

    afterEach(() => widget.disconnectedCallback());

    async function saveModels(next: ModelOption[]) {
        models = next;
        notifySettingChanged({ locale: 'zh-CN', models: next });
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    function showModelPanel(picker: 'run' | 'verify' = 'run') {
        const trigger = widget.shadowRoot.querySelector(`.model-trigger[data-picker="${picker}"]`);
        trigger.getBoundingClientRect = () => ({ left: 8, bottom: 30 });
        widget.openModelPanel(picker, trigger);
        return widget.shadowRoot.querySelector('.model-panel') as HTMLElement;
    }

    test('新增模型保存后，无需重启即可在测试和验证模型面板选择', async () => {
        await saveModels([ORIGINAL, ADDED]);
        widget.openRunModal(DATASET.id);

        for (const picker of ['run', 'verify'] as const) {
            const panel = showModelPanel(picker);
            const option = panel.querySelector('[data-alias="added-model"]');
            expect(option).not.toBeNull();
            await widget.handleClick({ target: option });
            expect(widget.runModal[picker === 'run' ? 'runModel' : 'verifyModel']).toBe(ADDED.alias);
        }
    });

    test('已打开的列表立即更新，并保留搜索框和测评参数的 DOM 与输入', async () => {
        widget.openRunModal(DATASET.id);
        const input = widget.shadowRoot.querySelector('#benchmark-concurrency') as HTMLInputElement;
        input.value = '7';
        const timeout = widget.shadowRoot.querySelector('#benchmark-run-timeout') as HTMLInputElement;
        timeout.value = '180';
        const modal = widget.shadowRoot.querySelector('.modal-overlay');
        showModelPanel();
        const search = widget.shadowRoot.querySelector('.model-search') as HTMLInputElement;
        search.value = 'added';
        widget.handleInput({ target: search });

        await saveModels([ORIGINAL, ADDED]);

        expect(widget.shadowRoot.querySelector('.modal-overlay')).toBe(modal);
        expect(widget.shadowRoot.querySelector('#benchmark-concurrency')).toBe(input);
        expect(input.value).toBe('7');
        expect(timeout.value).toBe('180');
        expect(widget.shadowRoot.querySelector('.model-search')).toBe(search);
        expect(search.value).toBe('added');
        const added = widget.shadowRoot.querySelector('.model-panel-item[data-alias="added-model"]');
        expect(added).not.toBeNull();
        expect(added.style.display).not.toBe('none');
        expect(widget.shadowRoot.querySelector('.model-panel-item[data-alias="original-model"]').style.display).toBe(
            'none'
        );
        expect(widget.runModal.runModel).toBe(ORIGINAL.alias);
        expect(widget.runModal.runModelEffort).toBe('high');
    });

    test('首次新增模型时，已打开的无模型表单恢复可运行状态', async () => {
        await saveModels([]);
        widget.openRunModal(DATASET.id);
        expect(widget.shadowRoot.querySelector('[data-action="run-start"]').disabled).toBe(true);

        await saveModels([ADDED]);

        expect(widget.runModal.runModel).toBe(ADDED.alias);
        expect(widget.runModal.verifyModel).toBe(ADDED.alias);
        expect(widget.shadowRoot.querySelector('[data-action="run-start"]').disabled).toBe(false);
        expect(widget.shadowRoot.querySelector('.modal-error')).toBeNull();
    });

    test('手动刷新也读取最新模型列表', async () => {
        models = [ORIGINAL, ADDED];
        await widget.switchTab('history');
        const refresh = widget.shadowRoot.querySelector('[data-action="refresh"]');
        await widget.handleClick({ target: refresh });
        widget.openRunModal(DATASET.id);

        expect(showModelPanel().querySelector('[data-alias="added-model"]')).not.toBeNull();
    });

    test('模型请求乱序返回时，旧结果不会覆盖新列表', async () => {
        let resolveOlder!: (result: ModelOption[]) => void;
        callMainWorld.mockImplementationOnce(() => new Promise((resolve) => (resolveOlder = resolve)));
        notifySettingChanged({ locale: 'zh-CN', models: [ORIGINAL] });
        await saveModels([ORIGINAL, ADDED]);
        resolveOlder([ORIGINAL]);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(widget.models).toEqual([ORIGINAL, ADDED]);
    });
});
