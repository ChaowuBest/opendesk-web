import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

const filterSlashCommands = jest.fn();

describe('AgentInput autocomplete slash preview card', () => {
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
                { name: 'explore', description: 'Read-only exploration', bundleName: 'builtin' },
                { name: 'long-skill', description: 'A'.repeat(200), bundleName: 'my-plugin' }
            ])
        };
        window.modeAPI = {
            getSupportedModes: jest.fn(async () => ({ modes: [] })),
            onTaskModeChanged: jest.fn()
        };
        window.globalControlAPI = { openApplication: jest.fn() };
        window.nodeAPI = { getDefaultExecutionNode: jest.fn() };

        filterSlashCommands.mockReturnValue([
            {
                name: 'goal',
                description: 'Set or clear the current goal',
                icon: 'fa-bullseye',
                iconBg: '#FFF7ED',
                iconColor: '#EA580C',
                acceptsArgs: true
            },
            {
                name: 'help',
                description: 'Open the help documentation',
                icon: 'fa-circle-question',
                iconBg: '#F0F0F5',
                iconColor: '#636366'
            }
        ]);

        await jest.unstable_mockModule('../../../renderer/components/slash-command.ts', () => ({
            getSlashCommands: jest.fn(() => []),
            filterSlashCommands,
            executeSlashCommand: jest.fn(),
            refreshPluginSlashCommands: jest.fn(async () => {})
        }));
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
        filterSlashCommands.mockClear();
        filterSlashCommands.mockReturnValue([
            {
                name: 'goal',
                description: 'Set or clear the current goal',
                icon: 'fa-bullseye',
                iconBg: '#FFF7ED',
                iconColor: '#EA580C',
                acceptsArgs: true
            },
            {
                name: 'help',
                description: 'Open the help documentation',
                icon: 'fa-circle-question',
                iconBg: '#F0F0F5',
                iconColor: '#636366'
            }
        ]);
    });

    function setupInputWithSkills(): any {
        const input = new AgentInput() as HTMLElement & {
            loadSkills: () => Promise<void>;
            handleAutocompleteInput: (ta: HTMLTextAreaElement) => void;
            autocompleteOpen: boolean;
            autocompleteItems: any[];
        };
        // linkedom 需补齐 textarea/Element 方法
        if (
            typeof window.HTMLTextAreaElement !== 'undefined' &&
            !window.HTMLTextAreaElement.prototype.setSelectionRange
        ) {
            window.HTMLTextAreaElement.prototype.setSelectionRange = function (start: number, end: number) {
                (this as any).selectionStart = start;
                (this as any).selectionEnd = end;
            };
        }
        if (typeof window.HTMLElement !== 'undefined' && !window.HTMLElement.prototype.scrollIntoView) {
            window.HTMLElement.prototype.scrollIntoView = function () {};
        }
        document.body.appendChild(input);
        return input.loadSkills().then(() => input);
    }

    /** 设置 textarea 的 value 并 mock caret 位置，触发 handleAutocompleteInput */
    function triggerSlashAutocomplete(input: any, text = '/') {
        const textarea = input.querySelector('#agent-input-textarea') as HTMLTextAreaElement;
        textarea.value = text;
        (textarea as any).selectionStart = text.length;

        // Mock getComputedStyle for mirror measurement
        window.getComputedStyle = () => ({
            fontFamily: 'monospace',
            fontSize: '14px',
            lineHeight: '20px',
            padding: '0px',
            border: 'none',
            boxSizing: 'border-box'
        });
        textarea.getBoundingClientRect = () => ({
            left: 100,
            top: 400,
            right: 500,
            bottom: 430,
            width: 400,
            height: 30,
            x: 100,
            y: 400,
            toJSON: () => {}
        });
        window.innerWidth = 1200;

        input.handleAutocompleteInput(textarea);
    }

    test('hover skill 项显示预览卡：展示技能名、完整描述与 bundleName', async () => {
        const input = await setupInputWithSkills();
        triggerSlashAutocomplete(input);
        expect(input.autocompleteOpen).toBe(true);

        const items = input.querySelectorAll('#agent-input-autocomplete-list .ctx-item-rich');
        const skillItem = [...items].find((el: HTMLElement) => el.dataset.label === 'long-skill');
        expect(skillItem).toBeDefined();
        expect(skillItem.dataset.fullDesc).toBe('A'.repeat(200));
        expect(skillItem.dataset.bundle).toBe('my-plugin');
        expect(skillItem.dataset.isCommand).toBeUndefined();

        (skillItem as HTMLElement).getBoundingClientRect = () => ({
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
        skillItem.dispatchEvent(new window.Event('mouseenter', { bubbles: true }));

        const card = document.querySelector('#agent-input-autocomplete-preview');
        expect(card).not.toBeNull();
        expect(card.textContent).toContain('long-skill');
        expect(card.textContent).toContain('A'.repeat(200));
        expect(card.textContent).toContain('my-plugin');
        expect(card.getAttribute('role')).toBe('tooltip');
    });

    test('hover command 项显示预览卡：展示命令名、完整描述与命令类型标签', async () => {
        const input = await setupInputWithSkills();
        triggerSlashAutocomplete(input);

        const items = input.querySelectorAll('#agent-input-autocomplete-list .ctx-item-rich');
        const cmdItem = [...items].find((el: HTMLElement) => el.dataset.label === 'goal');
        expect(cmdItem).toBeDefined();
        expect(cmdItem.dataset.isCommand).toBe('1');
        expect(cmdItem.dataset.fullDesc).toBe('Set or clear the current goal');

        (cmdItem as HTMLElement).getBoundingClientRect = () => ({
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
        cmdItem.dispatchEvent(new window.Event('mouseenter', { bubbles: true }));

        const card = document.querySelector('#agent-input-autocomplete-preview');
        expect(card).not.toBeNull();
        expect(card.textContent).toContain('goal');
        expect(card.textContent).toContain('Set or clear the current goal');
        expect(card.textContent).toContain('命令');
    });

    test('mouseleave 移除预览卡', async () => {
        const input = await setupInputWithSkills();
        triggerSlashAutocomplete(input);

        const items = input.querySelectorAll('#agent-input-autocomplete-list .ctx-item-rich');
        const item = [...items].find((el: HTMLElement) => el.dataset.label === 'long-skill');
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
        item.dispatchEvent(new window.Event('mouseenter', { bubbles: true }));
        expect(document.querySelector('#agent-input-autocomplete-preview')).not.toBeNull();

        item.dispatchEvent(new window.Event('mouseleave', { bubbles: true }));
        expect(document.querySelector('#agent-input-autocomplete-preview')).toBeNull();
    });

    test('关闭补全面板时自动清除预览卡', async () => {
        const input = await setupInputWithSkills();
        triggerSlashAutocomplete(input);

        const items = input.querySelectorAll('#agent-input-autocomplete-list .ctx-item-rich');
        const item = [...items].find((el: HTMLElement) => el.dataset.label === 'long-skill');
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
        item.dispatchEvent(new window.Event('mouseenter', { bubbles: true }));
        expect(document.querySelector('#agent-input-autocomplete-preview')).not.toBeNull();

        (input as any).closeAutocompletePanel();
        expect(document.querySelector('#agent-input-autocomplete-preview')).toBeNull();
    });

    test('重复 hover 不会累积多个预览卡', async () => {
        const input = await setupInputWithSkills();
        triggerSlashAutocomplete(input);

        const items = input.querySelectorAll('#agent-input-autocomplete-list .ctx-item-rich');
        const item = [...items].find((el: HTMLElement) => el.dataset.label === 'explore');
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
        item.dispatchEvent(new window.Event('mouseenter', { bubbles: true }));
        item.dispatchEvent(new window.Event('mouseleave', { bubbles: true }));
        item.dispatchEvent(new window.Event('mouseenter', { bubbles: true }));
        const cards = document.querySelectorAll('#agent-input-autocomplete-preview');
        expect(cards.length).toBe(1);
    });

    test('键盘上下键选择时预览卡片跟随更新', async () => {
        const input = await setupInputWithSkills();
        triggerSlashAutocomplete(input);

        // 给所有列表项 mock 定位信息，避免卡片定位报错
        const items = input.querySelectorAll('#agent-input-autocomplete-list .ctx-item-rich');
        items.forEach((el: HTMLElement) => {
            el.getBoundingClientRect = () => ({
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
        });

        const trackSelectedLabel = () => {
            const card = document.querySelector('#agent-input-autocomplete-preview');
            return card ? card.textContent : null;
        };

        // 初始选中第 0 项（技能 explore），键盘向下选择第 1 项（技能 long-skill）应更新卡片
        (input as any).handleAutocompleteKeydown({ key: 'ArrowDown', preventDefault: () => {}, ctrlKey: false });
        expect((input as any).autocompleteSelectedIndex).toBe(1);
        expect(trackSelectedLabel()).toContain('long-skill');
        expect(trackSelectedLabel()).toContain('A'.repeat(200));

        // 再向下选择第 2 项（命令 goal），卡片应切换为命令信息
        (input as any).handleAutocompleteKeydown({ key: 'ArrowDown', preventDefault: () => {}, ctrlKey: false });
        expect((input as any).autocompleteSelectedIndex).toBe(2);
        expect(trackSelectedLabel()).toContain('goal');
        expect(trackSelectedLabel()).toContain('Set or clear the current goal');

        // 向上回到技能，卡片切回技能
        (input as any).handleAutocompleteKeydown({ key: 'ArrowUp', preventDefault: () => {}, ctrlKey: false });
        expect((input as any).autocompleteSelectedIndex).toBe(1);
        expect(trackSelectedLabel()).toContain('long-skill');
    });

    test('键盘导航选择无描述项时不显示预览卡', async () => {
        const input = await setupInputWithSkills();
        triggerSlashAutocomplete(input);

        const items = input.querySelectorAll('#agent-input-autocomplete-list .ctx-item-rich');
        items.forEach((el: HTMLElement) => {
            el.getBoundingClientRect = () => ({
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
        });

        // 移除所有项的 fullDesc（模拟无描述项）
        items.forEach((el: HTMLElement) => el.removeAttribute('data-full-desc'));
        (input as any).handleAutocompleteKeydown({ key: 'ArrowDown', preventDefault: () => {}, ctrlKey: false });

        expect(document.querySelector('#agent-input-autocomplete-preview')).toBeNull();
    });
});
