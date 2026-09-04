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
        document.body.innerHTML = '';
    });

    async function openPanel(input: any) {
        document.body.appendChild(input);
        await input.loadSkills();
        input.toggleSkillPanel(); // 打开面板 -> renderSkillList
        await Promise.resolve();
    }

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
