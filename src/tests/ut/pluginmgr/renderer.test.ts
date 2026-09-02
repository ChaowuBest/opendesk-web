import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

describe('plugin manager application renderer', () => {
    let callMainWorld: jest.Mock;

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
        // 固定渲染语言为中文，避免 locale 检测依赖运行环境的 navigator.language 而漂移
        Object.defineProperty(globalThis, 'navigator', {
            configurable: true,
            writable: true,
            value: { language: 'zh-CN', languages: ['zh-CN'] }
        });
        window.confirm = jest.fn(() => true);
        await jest.unstable_mockModule('../../../renderer/theme/theme-iframe-bridge.ts', () => ({
            OPENDESK_THEME_CHANGED: 'opendesk-theme-changed'
        }));
        await jest.unstable_mockModule('../../../renderer/theme/theme-shadow-overrides.ts', () => ({
            syncShadowHostTheme: jest.fn()
        }));
        await import('../../../main/applications/pluginmgr/renderer/entry.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        callMainWorld = jest.fn(async (method: string) => {
            if (method === 'list') {
                return [
                    {
                        id: '<local-plugin>',
                        source: 'local',
                        path: '/plugins/local',
                        removable: true,
                        enabled: true,
                        runtime: {
                            id: '<local-plugin>',
                            displayName: 'Local Review',
                            version: '1.2.0',
                            status: 'active',
                            origin: '/plugins/local',
                            apiVersion: 1,
                            capabilities: ['skill', 'mcp'],
                            diagnostics: []
                        },
                        skills: [
                            {
                                name: 'review-notes',
                                description: 'Review notes and extract actions.'
                            },
                            {
                                name: 'build-checklist',
                                description: 'Build a verifiable checklist.'
                            }
                        ],
                        mcpServers: [
                            {
                                name: 'local-echo',
                                transport: 'stdio'
                            },
                            {
                                name: 'local-text-stats',
                                transport: 'stdio'
                            }
                        ],
                        tools: [
                            {
                                name: 'review-code',
                                description: 'Review a piece of code.'
                            }
                        ],
                        hooks: [{ name: 'tool.execute.before' }, { name: 'shell.env' }]
                    },
                    {
                        id: 'installed-plugin',
                        source: 'local',
                        path: '/plugins/installed',
                        removable: true,
                        enabled: false,
                        manifest: {
                            displayName: 'Installed Plugin',
                            version: '2.0.0',
                            apiVersion: 1,
                            capabilities: ['command', 'skill']
                        },
                        skills: [
                            {
                                name: 'release-review',
                                description: 'Review a release.'
                            }
                        ],
                        mcpServers: [],
                        agents: [
                            {
                                name: 'code-reviewer',
                                whenToUse: 'Reviewing code changes and pull requests.',
                                dispatchable: true,
                                body: '# Code Reviewer\n\nYou review code changes.'
                            },
                            {
                                name: 'ghost',
                                whenToUse: 'A hidden agent.',
                                dispatchable: false,
                                body: '# Ghost\n\nNot dispatchable.'
                            }
                        ]
                    },
                    {
                        id: 'localized-plugin',
                        source: 'local',
                        path: '/plugins/localized',
                        removable: true,
                        enabled: true,
                        runtime: {
                            id: 'localized-plugin',
                            displayName: { en: 'Localized En Name', zh: '本地化中文名' },
                            description: { en: 'Localized En Description', zh: '本地化插件描述' },
                            version: '1.0.0',
                            status: 'active',
                            origin: '/plugins/localized',
                            apiVersion: 1,
                            capabilities: [],
                            diagnostics: []
                        },
                        skills: [],
                        mcpServers: []
                    }
                ];
            }
            return undefined;
        });
        window.applicationAPI = {
            callMainWorld,
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };
        Object.assign(window, {
            fsAPI: {
                getFilePath: jest.fn(() => '/plugins/example.tgz'),
                selectDirectory: jest.fn(async () => '/plugins/example')
            }
        });
    });

    async function createWidget(): Promise<any> {
        const widget = document.createElement('pluginmgr-entry-widget') as any;
        document.body.append(widget);
        await new Promise((resolve) => setTimeout(resolve, 0));
        return widget;
    }

    test('renders discovered plugins safely and only offers uninstall for removable entries', async () => {
        const widget = await createWidget();

        expect(widget.shadowRoot.innerHTML).toContain('&lt;local-plugin&gt;');
        expect(widget.shadowRoot.querySelector('local-plugin')).toBeNull();
        expect(widget.shadowRoot.querySelectorAll('[data-action="uninstall"]')).toHaveLength(3);
        expect(widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"]')).not.toBeNull();
    });

    test('renders tool and hook contributions on plugin cards and detail sections', async () => {
        const widget = await createWidget();
        const card = widget.shadowRoot.querySelector('[data-plugin-id="<local-plugin>"]');

        expect(card.innerHTML).toContain('1 个工具');
        expect(card.innerHTML).toContain('2 个钩子');

        card.dispatchEvent(new Event('click'));

        const detail = widget.shadowRoot.querySelector('skill-detail-card');
        expect(detail.shadowRoot.innerHTML).toContain('工具');
        expect(detail.shadowRoot.innerHTML).toContain('review-code');
        expect(detail.shadowRoot.innerHTML).toContain('Review a piece of code.');
        expect(detail.shadowRoot.innerHTML).toContain('钩子');
        expect(detail.shadowRoot.innerHTML).toContain('tool.execute.before');
        expect(detail.shadowRoot.innerHTML).toContain('shell.env');
    });

    test('renders plugin enable controls as skill-style switches', async () => {
        const widget = await createWidget();
        const activeToggle = widget.shadowRoot.querySelector(
            '[data-plugin-id="\\<local-plugin\\>"] [data-action="toggle"]'
        );
        const disabledToggle = widget.shadowRoot.querySelector(
            '[data-plugin-id="installed-plugin"] [data-action="toggle"]'
        );

        expect(activeToggle.tagName).toBe('INPUT');
        expect(activeToggle.type).toBe('checkbox');
        expect(activeToggle.hasAttribute('checked')).toBe(true);
        expect(activeToggle.closest('.plugin-toggle')?.querySelector('.plugin-toggle-slider')).not.toBeNull();
        expect(disabledToggle.tagName).toBe('INPUT');
        expect(disabledToggle.hasAttribute('checked')).toBe(false);
    });

    test('keeps the install source menu stacking context above plugin card controls', async () => {
        const widget = await createWidget();
        const styles = widget.shadowRoot.querySelector('style')?.textContent ?? '';
        const headerRule = styles.match(/\.header-area\s*\{([^}]*)\}/)?.[1] ?? '';

        expect(headerRule).toMatch(/position:\s*relative/);
        expect(headerRule).toMatch(/z-index:\s*[1-9]\d*/);

        widget.shadowRoot.querySelector('[data-action="add"]').dispatchEvent(new Event('click'));
        expect(widget.shadowRoot.querySelector('.add-dropdown.visible')).not.toBeNull();
    });

    test('routes enable and npm install actions through the application API', async () => {
        const widget = await createWidget();
        const enable = widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"] [data-action="toggle"]');
        enable.checked = true;
        enable.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(callMainWorld).toHaveBeenCalledWith('setEnabled', 'installed-plugin', true);

        widget.shadowRoot.querySelector('[data-action="add"]').dispatchEvent(new Event('click'));
        widget.shadowRoot.querySelector('[data-install-source="npm"]').dispatchEvent(new Event('click'));
        const input = widget.shadowRoot.querySelector('input[name="spec"]');
        input.value = '@example/plugin';
        input.dispatchEvent(new Event('input'));
        widget.shadowRoot.querySelector('[data-install-form]').dispatchEvent(new Event('submit', { cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(callMainWorld).toHaveBeenCalledWith('install', '@example/plugin');
    });

    test('keeps the plugin switch mounted while the runtime reload is pending', async () => {
        const widget = await createWidget();
        let finishToggle: (() => void) | undefined;
        callMainWorld.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishToggle = resolve;
                })
        );
        const toggle = widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"] [data-action="toggle"]');

        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        expect(widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"] [data-action="toggle"]')).toBe(
            toggle
        );
        expect(toggle.disabled).toBe(true);

        finishToggle?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    test('installs a selected directory as a local plugin', async () => {
        const widget = await createWidget();

        widget.shadowRoot.querySelector('[data-action="add"]').dispatchEvent(new Event('click'));
        widget.shadowRoot.querySelector('[data-install-source="directory"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(callMainWorld).toHaveBeenCalledWith('install', '/plugins/example');
        expect(widget.shadowRoot.querySelector('[data-install-progress]')?.dataset.installSource).toBe('directory');
    });

    test('waits for an asynchronous file path before installing a plugin package', async () => {
        const widget = await createWidget();
        window.fsAPI.getFilePath = jest.fn(async () => '/plugins/example.tgz');

        widget.shadowRoot.querySelector('[data-action="add"]').dispatchEvent(new Event('click'));
        const input = widget.shadowRoot.querySelector('[data-install-file]');
        Object.defineProperty(input, 'files', {
            configurable: true,
            value: [{ name: 'example.tgz' }]
        });
        input.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(callMainWorld).toHaveBeenCalledWith('install', '/plugins/example.tgz');
        expect(widget.shadowRoot.querySelector('[data-install-progress]')?.dataset.installSource).toBe('package');
    });

    test.each([
        ['npm', '@example/plugin'],
        ['url', 'https://example.com/plugin.tgz']
    ])('shows installation progress after submitting a %s source', async (source, spec) => {
        const widget = await createWidget();

        widget.shadowRoot.querySelector('[data-action="add"]').dispatchEvent(new Event('click'));
        widget.shadowRoot.querySelector(`[data-install-source="${source}"]`).dispatchEvent(new Event('click'));
        const input = widget.shadowRoot.querySelector('input[name="spec"]');
        input.value = spec;
        input.dispatchEvent(new Event('input'));
        widget.shadowRoot.querySelector('[data-install-form]').dispatchEvent(new Event('submit', { cancelable: true }));

        expect(widget.shadowRoot.querySelector('[data-install-progress]')?.dataset.installSource).toBe(source);
        expect(widget.shadowRoot.querySelector('.install-progress-bar')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('.modal-overlay.visible')).toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    test('uses the OpenDesk confirmation modal before uninstalling a plugin', async () => {
        const widget = await createWidget();
        const uninstall = widget.shadowRoot.querySelector(
            '[data-plugin-id="installed-plugin"] [data-action="uninstall"]'
        );

        uninstall.dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(window.confirm).not.toHaveBeenCalled();
        const modal = widget.shadowRoot.querySelector('.od-confirm-modal-overlay');
        expect(modal).not.toBeNull();
        expect(callMainWorld).not.toHaveBeenCalledWith('uninstall', 'installed-plugin');

        modal.querySelector('[data-action="confirm"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 220));

        expect(callMainWorld).toHaveBeenCalledWith('uninstall', 'installed-plugin');
    });

    test('renders only the installed page with skill-style add actions', async () => {
        const widget = await createWidget();

        expect(widget.shadowRoot.querySelector('[data-tab="installed"]')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('[data-tab="marketplace"]')).toBeNull();
        expect(widget.shadowRoot.querySelector('[data-tab="settings"]')).toBeNull();
        expect(widget.shadowRoot.querySelector('[data-action="add"]')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('[data-panel="marketplace"]')).toBeNull();
    });

    test('opens a skill-style plugin detail with basic information, Skills, and MCP servers', async () => {
        const widget = await createWidget();
        const card = widget.shadowRoot.querySelector('[data-plugin-id="<local-plugin>"]');

        card.dispatchEvent(new Event('click'));

        const detail = widget.shadowRoot.querySelector('skill-detail-card');
        expect(detail).not.toBeNull();
        expect(detail.shadowRoot.innerHTML).toContain('Local Review');
        expect(detail.shadowRoot.innerHTML).toContain('1.2.0');
        expect(detail.shadowRoot.innerHTML).toContain('review-notes');
        expect(detail.shadowRoot.innerHTML).toContain('build-checklist');
        expect(detail.shadowRoot.innerHTML).toContain('local-echo');
        expect(detail.shadowRoot.innerHTML).toContain('local-text-stats');
    });

    test('uses manifest metadata in the detail when a plugin is disabled', async () => {
        const widget = await createWidget();
        const card = widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"]');

        card.dispatchEvent(new Event('click'));

        const detail = widget.shadowRoot.querySelector('skill-detail-card');
        expect(detail.shadowRoot.innerHTML).toContain('Installed Plugin');
        expect(detail.shadowRoot.innerHTML).toContain('2.0.0');
        expect(detail.shadowRoot.innerHTML).toContain('command, skill');
        expect(detail.shadowRoot.innerHTML).toContain('release-review');
    });

    test('lists mounted sub-agents on the plugin card and first detail screen', async () => {
        const widget = await createWidget();
        const card = widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"]');

        // 卡片上显示 agent 数量
        expect(card.innerHTML).toContain('2 个子 Agent');

        card.dispatchEvent(new Event('click'));

        const detail = widget.shadowRoot.querySelector('skill-detail-card');
        const html = detail.shadowRoot.innerHTML;
        // 首屏列出 agent 名字与使用场景
        expect(html).toContain('子 Agent');
        expect(html).toContain('code-reviewer');
        expect(html).toContain('Reviewing code changes and pull requests.');
        expect(html).toContain('ghost');
        // 不可调度的 agent 带标记，但仍是点击项
        expect(html).toContain('不可调度');
        // agent 行可点击
        expect(detail.shadowRoot.querySelectorAll('[data-agent-name]')).toHaveLength(2);
        // 首屏无返回按钮、无 markdown 正文渲染
        expect(html).not.toContain('You review code changes.');
    });

    test('opens an agent detail page with animated forward transition and back button', async () => {
        const widget = await createWidget();
        const card = widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"]');
        card.dispatchEvent(new Event('click'));

        const detail = widget.shadowRoot.querySelector('skill-detail-card');
        const reviewerRow = detail.shadowRoot.querySelector('[data-agent-name="code-reviewer"]');
        reviewerRow.dispatchEvent(new Event('click'));

        // 同一个模态窗口内切换：detail 元素不被重建
        expect(widget.shadowRoot.querySelector('skill-detail-card')).toBe(detail);

        const html = detail.shadowRoot.innerHTML;
        // agent 详情展示完整 id、使用场景、可调度性与 agents.md 正文
        expect(html).toContain('installed-plugin:code-reviewer');
        expect(html).toContain('Reviewing code changes and pull requests.');
        expect(html).toContain('是');
        expect(html).toContain('code-reviewer');
        expect(html).toContain('You review code changes.');
        // 内容区前进动画，遮罩与窗口框架不重建
        expect(detail.shadowRoot.querySelector('.detail-body').className).toContain('body-switch-forward');
        expect(detail.shadowRoot.querySelector('.detail-overlay').className).not.toMatch(/overlay-enter/);
        // 左上角返回按钮
        expect(detail.shadowRoot.querySelector('.detail-back')?.hasAttribute('hidden')).toBe(false);
        // agent 详情无操作按钮
        expect(detail.shadowRoot.querySelector('.detail-footer')?.hasAttribute('hidden')).toBe(true);
    });

    test('back button returns from agent detail to plugin overview with back animation', async () => {
        const widget = await createWidget();
        const card = widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"]');
        card.dispatchEvent(new Event('click'));

        let detail = widget.shadowRoot.querySelector('skill-detail-card');
        detail.shadowRoot.querySelector('[data-agent-name="ghost"]').dispatchEvent(new Event('click'));

        detail = widget.shadowRoot.querySelector('skill-detail-card');
        // ghost 不可调度，agent 详情显示"否"
        expect(detail.shadowRoot.innerHTML).toContain('否');

        detail.shadowRoot.querySelector('.detail-back').dispatchEvent(new Event('click'));

        detail = widget.shadowRoot.querySelector('skill-detail-card');
        const html = detail.shadowRoot.innerHTML;
        // 返回插件首屏，内容区带返回动画，返回按钮重新隐藏
        expect(detail.shadowRoot.querySelector('.detail-body').className).toContain('body-switch-back');
        expect(detail.shadowRoot.querySelector('.detail-back')?.hasAttribute('hidden')).toBe(true);
        // 首屏仍列出两个 agent
        expect(detail.shadowRoot.querySelectorAll('[data-agent-name]')).toHaveLength(2);
    });

    test('displays the localized displayName for the current language on cards and details', async () => {
        const widget = await createWidget();
        // 测试环境 navigator 固定为 zh-CN，应显示中文翻译
        expect(widget.shadowRoot.innerHTML).toContain('本地化中文名');
        expect(widget.shadowRoot.innerHTML).not.toContain('Localized En Name');

        const card = widget.shadowRoot.querySelector('[data-plugin-id="localized-plugin"]');
        card.dispatchEvent(new Event('click'));
        const detail = widget.shadowRoot.querySelector('skill-detail-card');
        expect(detail.shadowRoot.innerHTML).toContain('本地化中文名');
    });

    test('displays the localized plugin description on the detail panel', async () => {
        const widget = await createWidget();
        const card = widget.shadowRoot.querySelector('[data-plugin-id="localized-plugin"]');
        card.dispatchEvent(new Event('click'));
        const detail = widget.shadowRoot.querySelector('skill-detail-card');
        // 测试环境 navigator 固定为 zh-CN，应显示中文描述
        expect(detail.shadowRoot.innerHTML).toContain('本地化插件描述');
        expect(detail.shadowRoot.innerHTML).not.toContain('Localized En Description');
    });

    test('switches localized display names when the main window notifies a locale change', async () => {
        const widget = await createWidget();
        expect(widget.shadowRoot.innerHTML).toContain('本地化中文名');

        const event = new Event('message');
        Object.defineProperty(event, 'data', {
            value: { type: 'LOCALE_CHANGED', locale: 'en-US' }
        });
        window.dispatchEvent(event);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(widget.shadowRoot.innerHTML).toContain('Localized En Name');
        expect(widget.shadowRoot.innerHTML).not.toContain('本地化中文名');

        const back = new Event('message');
        Object.defineProperty(back, 'data', {
            value: { type: 'LOCALE_CHANGED', locale: 'zh-CN' }
        });
        window.dispatchEvent(back);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(widget.shadowRoot.innerHTML).toContain('本地化中文名');
    });

    test('ignores locale messages without the LOCALE_CHANGED type', async () => {
        const widget = await createWidget();
        expect(widget.shadowRoot.innerHTML).toContain('本地化中文名');

        const event = new Event('message');
        Object.defineProperty(event, 'data', {
            value: { locale: 'en-US' }
        });
        window.dispatchEvent(event);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(widget.shadowRoot.innerHTML).toContain('本地化中文名');
        expect(widget.shadowRoot.innerHTML).not.toContain('Localized En Name');
    });
});
