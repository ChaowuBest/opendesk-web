import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('AgentInput skill hover preview card', () => {
    let AgentInput: any;
    let window: any;
    let document: any;

    beforeAll(async () => {
        ({ window } = parseHTML('<!doctype html><html><body></body></html>'));
        document = window.document;
        Object.assign(globalThis, {
            window,
            document,
            HTMLElement: window.HTMLElement,
            Event: window.Event,
            CustomEvent: window.CustomEvent,
            customElements: window.customElements,
            MutationObserver: window.MutationObserver,
            Node: window.Node,
            requestAnimationFrame: (cb: FrameRequestCallback) => {
                cb(0);
                return 0;
            },
            cancelAnimationFrame: () => undefined,
            ResizeObserver: class {
                observe() {}
                unobserve() {}
                disconnect() {}
            }
        });
        Object.defineProperty(globalThis, 'navigator', {
            value: { languages: ['zh-CN'], language: 'zh-CN' },
            configurable: true
        });

        window.settingAPI = {
            loadSettingObject: jest.fn(async () => ({
                models: [],
                default_model: '',
                gui_config: {}
            })),
            checkVisionSupport: jest.fn(async () => ({})),
            checkReasoningEfforts: jest.fn(async () => ({}))
        };
        window.applicationRegistryAPI = {
            callMainWorld: jest.fn(async () => [
                { name: 'explore', description: 'Read-only code exploration', bundleName: 'builtin' },
                { name: 'plan', description: 'Design implementation plan', bundleName: 'builtin' },
                { name: 'long-skill', description: 'A'.repeat(200), bundleName: 'my-plugin' }
            ])
        };
        window.modeAPI = {
            getSupportedModes: jest.fn(async () => ({ modes: [] })),
            onTaskModeChanged: jest.fn()
        };
        window.globalControlAPI = { openApplication: jest.fn() };
        window.nodeAPI = { getDefaultExecutionNode: jest.fn() };

        await jest.unstable_mockModule('../../../renderer/components/imageLightbox.js', () => ({
            showImageLightbox: jest.fn()
        }));
        await import('../../../renderer/components/agentinput.js');
        AgentInput = window.customElements.get('agent-input');
        expect(AgentInput).toBeDefined();
    });

    beforeEach(() => {
        // 先触发组件清理，避免 linkedom 清空 body 时遍历到已被销毁回调移除的兄弟节点。
        document.querySelectorAll('agent-input').forEach((input: HTMLElement) => input.remove());
        document.body.innerHTML = '';
        document.documentElement.removeAttribute('data-theme');
    });

    test.each(['skill', 'autocomplete-skill', 'autocomplete-command'])(
        '%s 预览的表面和文字使用可随深色模式变化的菜单主题变量',
        (kind) => {
            document.documentElement.setAttribute('data-theme', 'dark');
            const input = new AgentInput();
            const item = document.createElement('div');
            item.getBoundingClientRect = () => ({ left: 300, top: 200, right: 500 });
            if (kind === 'skill') {
                input._showSkillPreviewCard(item, {
                    name: 'explore',
                    description: 'Read-only exploration',
                    bundleName: 'builtin'
                });
            } else {
                Object.assign(item.dataset, {
                    label: 'explore',
                    fullDesc: 'Read-only exploration',
                    bundle: 'builtin',
                    isCommand: kind === 'autocomplete-command' ? '1' : '0',
                    icon: 'fa-search'
                });
                input._showAutocompletePreviewCard(item);
            }
            const card = document.querySelector('[role="tooltip"]');
            expect(card.style.background).toBe('var(--ctx-bg)');
            expect(card.style.border).toBe('1px solid var(--ctx-border)');
            expect(card.style.boxShadow).toBe('var(--ctx-shadow)');
            const textColors = [...card.querySelectorAll('div[style]')].map((el: any) => el.style.color);
            expect(textColors).toEqual(
                expect.arrayContaining(['var(--ctx-ink)', 'var(--ctx-ink2)', 'var(--ctx-ink3)'])
            );
            expect(textColors).not.toEqual(expect.arrayContaining(['#1d1d1f', '#555', '#999']));
            input.remove();
        }
    );

    async function openPanel(input: any, parent = document.body) {
        parent.appendChild(input);
        await input.loadSkills();
        input.toggleSkillPanel(); // 打开面板 -> renderSkillList
        await Promise.resolve();
    }

    test.each(['remove', 'replace-parent-content'])('%s 断开组件时清除挂在 body 的两种预览卡', async (removal) => {
        const parent = document.createElement('section');
        document.body.appendChild(parent);
        const input = new AgentInput();
        await openPanel(input, parent);
        const item = input.querySelector('#agent-input-skill-list .ctx-item-rich');
        item.getBoundingClientRect = () => ({ left: 300, top: 200, right: 500 });
        input._showSkillPreviewCard(item, {
            name: 'explore',
            description: 'Read-only exploration',
            bundleName: 'builtin'
        });
        Object.assign(item.dataset, { label: 'explore', fullDesc: 'Read-only exploration' });
        input._showAutocompletePreviewCard(item);
        expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(2);

        if (removal === 'remove') input.remove();
        else parent.innerHTML = '';

        expect(input.isConnected).toBe(false);
        expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(0);
        expect(input._skillPreviewCard).toBeNull();
        expect(input._autocompletePreviewCard).toBeNull();
    });

    test('组件断开时同时退订设置、执行节点和插件命令事件', async () => {
        const input = new AgentInput();
        await openPanel(input);
        const unsubscribeSettings = jest.fn();
        const unsubscribeNodes = jest.fn();
        const unsubscribePlugins = jest.fn();
        input._unsubSettingChanged = unsubscribeSettings;
        input._unsubExecutionNodesChanged = unsubscribeNodes;
        input._unsubPluginCommandsChanged = unsubscribePlugins;

        input.remove();

        expect(unsubscribeSettings).toHaveBeenCalledTimes(1);
        expect(unsubscribeNodes).toHaveBeenCalledTimes(1);
        expect(unsubscribePlugins).toHaveBeenCalledTimes(1);
    });

    test('hover 显示预览卡：展示技能名、描述和 bundleName', async () => {
        const input = new AgentInput();
        await openPanel(input);

        const items = input.querySelectorAll('#agent-input-skill-list .ctx-item-rich');
        const longItem = [...items].find((el: HTMLElement) => el.dataset.skillName === 'long-skill');
        expect(longItem).toBeDefined();

        // 模拟 getBoundingClientRect
        (longItem as HTMLElement).getBoundingClientRect = () => ({
            left: 300,
            top: 200,
            right: 500,
            bottom: 230,
            width: 200,
            height: 30,
            x: 300,
            y: 200,
            toJSON: () => {}
        });
        Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
        longItem.dispatchEvent(new window.Event('mouseenter', { bubbles: true }));

        const card = document.querySelector('#agent-input-skill-preview');
        expect(card).not.toBeNull();
        expect(card.textContent).toContain('long-skill');
        expect(card.textContent).toContain('A'.repeat(200));
        expect(card.textContent).toContain('my-plugin');
        expect(card.getAttribute('role')).toBe('tooltip');
    });

    test('mouseleave 移除预览卡', async () => {
        const input = new AgentInput();
        await openPanel(input);

        const items = input.querySelectorAll('#agent-input-skill-list .ctx-item-rich');
        const item = [...items].find((el: HTMLElement) => el.dataset.skillName === 'long-skill');

        (item as HTMLElement).getBoundingClientRect = () => ({
            left: 300,
            top: 200,
            right: 500,
            bottom: 230,
            width: 200,
            height: 30,
            x: 300,
            y: 200,
            toJSON: () => {}
        });
        Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
        item.dispatchEvent(new window.Event('mouseenter', { bubbles: true }));
        expect(document.querySelector('#agent-input-skill-preview')).not.toBeNull();

        item.dispatchEvent(new window.Event('mouseleave', { bubbles: true }));
        expect(document.querySelector('#agent-input-skill-preview')).toBeNull();
    });

    test('关闭技能面板时自动清除预览卡', async () => {
        const input = new AgentInput();
        await openPanel(input);

        const items = input.querySelectorAll('#agent-input-skill-list .ctx-item-rich');
        const item = [...items].find((el: HTMLElement) => el.dataset.skillName === 'long-skill');
        (item as HTMLElement).getBoundingClientRect = () => ({
            left: 300,
            top: 200,
            right: 500,
            bottom: 230,
            width: 200,
            height: 30,
            x: 300,
            y: 200,
            toJSON: () => {}
        });
        Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
        item.dispatchEvent(new window.Event('mouseenter', { bubbles: true }));
        expect(document.querySelector('#agent-input-skill-preview')).not.toBeNull();

        input.toggleSkillPanel(true); // 强制关闭
        expect(document.querySelector('#agent-input-skill-preview')).toBeNull();
    });

    test('重复 hover 不会累积多个预览卡', async () => {
        const input = new AgentInput();
        await openPanel(input);

        const items = input.querySelectorAll('#agent-input-skill-list .ctx-item-rich');
        const item = [...items].find((el: HTMLElement) => el.dataset.skillName === 'explore');
        (item as HTMLElement).getBoundingClientRect = () => ({
            left: 100,
            top: 100,
            right: 400,
            bottom: 130,
            width: 300,
            height: 30,
            x: 100,
            y: 100,
            toJSON: () => {}
        });
        Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });

        item.dispatchEvent(new window.Event('mouseenter', { bubbles: true }));
        item.dispatchEvent(new window.Event('mouseleave', { bubbles: true }));
        item.dispatchEvent(new window.Event('mouseenter', { bubbles: true }));

        const cards = document.querySelectorAll('#agent-input-skill-preview');
        expect(cards.length).toBe(1);
    });
});
