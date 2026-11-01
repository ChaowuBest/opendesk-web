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
                    },
                    {
                        id: 'builtin-plugin',
                        source: 'builtin',
                        path: '/dist/plugins/builtin',
                        removable: false,
                        enabled: true,
                        runtime: {
                            id: 'builtin-plugin',
                            displayName: 'Builtin Helper',
                            version: '1.0.0',
                            status: 'active',
                            origin: '/dist/plugins/builtin',
                            apiVersion: 1,
                            capabilities: ['skill'],
                            diagnostics: []
                        },
                        skills: [
                            {
                                name: 'builtin-skill',
                                description: 'A builtin skill.'
                            }
                        ],
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
        expect(widget.shadowRoot.querySelector('[data-plugin-id="builtin-plugin"]')).not.toBeNull();
        expect(
            widget.shadowRoot.querySelector('[data-plugin-id="builtin-plugin"] [data-action="uninstall"]')
        ).toBeNull();
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

    test('切换某个插件时只让该卡片的开关转圈，其它插件的开关保持可用', async () => {
        const widget = await createWidget();
        let finishFirstToggle: (() => void) | undefined;
        callMainWorld.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishFirstToggle = resolve;
                })
        );
        const pendingToggleIds = () =>
            Array.from(widget.shadowRoot.querySelectorAll('.plugin-toggle.is-pending [data-action="toggle"]'))
                .map((toggle: any) => toggle.dataset.id)
                .sort();
        const disabledToggleIds = () =>
            Array.from(widget.shadowRoot.querySelectorAll('[data-action="toggle"]'))
                .filter((toggle: any) => toggle.disabled)
                .map((toggle: any) => toggle.dataset.id)
                .sort();
        const toggle = widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"] [data-action="toggle"]');

        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));

        // 转圈只出现在被点的这张卡片上，其它开关不动（整表禁用会让所有 switch 一起变灰再恢复）
        expect(pendingToggleIds()).toEqual(['installed-plugin']);
        expect(disabledToggleIds()).toEqual(['installed-plugin']);
        expect(
            widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"] .plugin-toggle-spinner')
        ).not.toBeNull();

        // 前一个请求还没回来时另一个插件也能切换：后端串行执行，前端不需要互相等待
        const otherToggle = widget.shadowRoot.querySelector('[data-plugin-id="<local-plugin>"] [data-action="toggle"]');
        otherToggle.checked = false;
        otherToggle.dispatchEvent(new Event('change'));
        expect(callMainWorld).toHaveBeenCalledWith('setEnabled', '<local-plugin>', false);

        finishFirstToggle?.();
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(pendingToggleIds()).toEqual([]);
    });

    test('切换插件只重绘那张卡片：列表不重建，滚动位置也不丢', async () => {
        const widget = await createWidget();
        const panel = widget.shadowRoot.querySelector('[data-panel="installed"]') as HTMLElement;
        panel.scrollTop = 180;
        const localCard = widget.shadowRoot.querySelector('[data-plugin-id="<local-plugin>"]');
        const toggle = widget.shadowRoot.querySelector(
            '[data-plugin-id="installed-plugin"] [data-action="toggle"]'
        ) as HTMLInputElement;

        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 10));

        // 没有整表刷新：面板与其它卡片都还是原来那批节点，滚动位置原样保留
        expect(widget.shadowRoot.querySelector('[data-panel="installed"]')).toBe(panel);
        expect(widget.shadowRoot.querySelector('[data-plugin-id="<local-plugin>"]')).toBe(localCard);
        expect(panel.scrollTop).toBe(180);
        // 被切换的那张卡片换成新节点，且转圈已摘掉
        const card = widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"]') as HTMLElement;
        expect(card.querySelector('.plugin-toggle.is-pending')).toBeNull();
    });

    test('启停后拉列表失败时卡片不会卡在转圈上', async () => {
        const widget = await createWidget();
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') throw new Error('list boom');
            return undefined;
        });
        const toggle = widget.shadowRoot.querySelector(
            '[data-plugin-id="installed-plugin"] [data-action="toggle"]'
        ) as HTMLInputElement;

        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(widget.shadowRoot.querySelector('.plugin-toggle.is-pending')).toBeNull();
        expect(widget.shadowRoot.querySelector('.notice')?.textContent).toContain('list boom');
        // 卡片控件必须复位：转圈摘掉了却把开关留在禁用态，用户会觉得点不动
        const refreshedToggle = widget.shadowRoot.querySelector(
            '[data-plugin-id="installed-plugin"] [data-action="toggle"]'
        ) as HTMLInputElement;
        expect(refreshedToggle.disabled).toBe(false);
        // 按现有数据重绘：该插件仍是未启用状态
        expect(refreshedToggle.hasAttribute('checked')).toBe(false);
    });

    test('启停插件用系统通知反馈，不占用页面顶部的通知条', async () => {
        const widget = await createWidget();
        const toggle = widget.shadowRoot.querySelector(
            '[data-plugin-id="installed-plugin"] [data-action="toggle"]'
        ) as HTMLInputElement;

        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 10));

        // 与技能中心的技能启停一致：结果走 sendNotification，页面顶部不再出现通知条
        expect(callMainWorld).toHaveBeenCalledWith(
            'sendNotification',
            'info',
            '插件中心',
            '启用成功',
            '插件已启用：installed-plugin'
        );
        expect(widget.shadowRoot.querySelector('.notice')).toBeNull();
    });

    test('启停失败同样走系统通知（error 类型）', async () => {
        const widget = await createWidget();
        callMainWorld.mockImplementationOnce(async () => {
            throw new Error('boom enable');
        });
        const toggle = widget.shadowRoot.querySelector(
            '[data-plugin-id="installed-plugin"] [data-action="toggle"]'
        ) as HTMLInputElement;

        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(callMainWorld).toHaveBeenCalledWith('sendNotification', 'error', '插件中心', '启用失败', 'boom enable');
        expect(widget.shadowRoot.querySelector('.notice')).toBeNull();
        // 卡片按后端数据回退，不会静默停在启用态
        expect(widget.shadowRoot.querySelector('.plugin-toggle.is-pending')).toBeNull();
    });

    test('安装进行中再次触发安装会被忽略，进度浮层不会被提前清掉', async () => {
        const widget = await createWidget();
        let finishInstall: (() => void) | undefined;
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'install') {
                return await new Promise<void>((resolve) => {
                    finishInstall = resolve;
                });
            }
            return undefined;
        });
        widget.shadowRoot.querySelector('[data-action="add"]').dispatchEvent(new Event('click'));
        const input = widget.shadowRoot.querySelector('[data-install-file]') as HTMLInputElement;
        Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'one.tgz' }] });

        input.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        // 用户在安装还没结束前又选了一个包
        input.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect((callMainWorld as jest.Mock).mock.calls.filter(([method]) => method === 'install')).toHaveLength(1);
        // 在跑那一次的进度浮层仍在
        expect(widget.shadowRoot.querySelector('[data-install-progress]')).not.toBeNull();

        finishInstall?.();
        await new Promise((resolve) => setTimeout(resolve, 500));
    });

    test('启停插件会先收走上一轮遗留的顶部通知条', async () => {
        const widget = await createWidget();
        // 造一条页面通知：包安装取不到文件路径
        window.fsAPI.getFilePath = jest.fn(async () => null);
        widget.shadowRoot.querySelector('[data-action="add"]').dispatchEvent(new Event('click'));
        const input = widget.shadowRoot.querySelector('[data-install-file]') as HTMLInputElement;
        Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'broken.tgz' }] });
        input.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(widget.shadowRoot.querySelector('.notice')).not.toBeNull();

        const toggle = widget.shadowRoot.querySelector(
            '[data-plugin-id="installed-plugin"] [data-action="toggle"]'
        ) as HTMLInputElement;
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 10));

        // 上次的失败提示不该被误读成本次启停的结果
        expect(widget.shadowRoot.querySelector('.notice')).toBeNull();
    });

    test('列表组成变化时整树重绘，但面板滚动位置被还原', async () => {
        const widget = await createWidget();
        const panel = widget.shadowRoot.querySelector('[data-panel="installed"]') as HTMLElement;
        panel.scrollTop = 240;
        const entries = (await callMainWorld('list')) as any[];
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return entries.filter((entry) => entry.id !== 'installed-plugin');
            return undefined;
        });

        widget.shadowRoot
            .querySelector('[data-plugin-id="installed-plugin"] [data-action="uninstall"]')!
            .dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        widget.shadowRoot
            .querySelector('.od-confirm-modal-overlay [data-action="confirm"]')!
            .dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 220));

        const nextPanel = widget.shadowRoot.querySelector('[data-panel="installed"]') as HTMLElement;
        expect(widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"]')).toBeNull();
        // 面板是重建出来的新节点，但滚动位置不能被重置到顶部
        expect(nextPanel).not.toBe(panel);
        expect(nextPanel.scrollTop).toBe(240);
    });

    test('详情面板打开时收到增量刷新：动作按最新数据执行', async () => {
        let onPluginsChanged: undefined | (() => void);
        (window.applicationAPI.subscribe as jest.Mock).mockImplementation(
            async (name: string, callback: () => void) => {
                if (name === 'pluginsChanged') onPluginsChanged = callback;
                return () => undefined;
            }
        );
        const widget = await createWidget();
        // 打开 installed-plugin 的详情（初始为未启用）
        widget.shadowRoot.querySelector('[data-plugin-id="installed-plugin"]').dispatchEvent(new Event('click'));
        const detail = widget.shadowRoot.querySelector('skill-detail-card') as HTMLElement;
        expect(detail).not.toBeNull();

        // 宿主侧把该插件改成已启用并广播 pluginsChanged
        const fresh = ((await callMainWorld('list')) as any[]).map((entry) =>
            entry.id === 'installed-plugin' ? { ...entry, enabled: true } : entry
        );
        callMainWorld.mockImplementation(async (method: string) => (method === 'list' ? fresh : undefined));
        onPluginsChanged?.();
        await new Promise((resolve) => setTimeout(resolve, 10));

        // 增量刷新复用同一个详情元素（不重建），动作要按刷新后的数据执行：已启用 → 请求禁用
        expect(widget.shadowRoot.querySelector('skill-detail-card')).toBe(detail);
        detail.dispatchEvent(new CustomEvent('skill-detail-action', { detail: { id: 'toggle' } }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(callMainWorld).toHaveBeenCalledWith('setEnabled', 'installed-plugin', false);
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
        // 删除数据目录的复选框默认不勾选
        const checkbox = modal.querySelector('[data-action="checkbox"]');
        expect(checkbox).not.toBeNull();
        expect(checkbox?.hasAttribute('checked')).toBe(false);
        expect(callMainWorld).not.toHaveBeenCalledWith('uninstall', 'installed-plugin', expect.anything());

        modal.querySelector('[data-action="confirm"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 220));

        expect(callMainWorld).toHaveBeenCalledWith('uninstall', 'installed-plugin', false);
    });

    test('passes removeData=true when the uninstall modal checkbox is checked', async () => {
        const widget = await createWidget();
        const uninstall = widget.shadowRoot.querySelector(
            '[data-plugin-id="installed-plugin"] [data-action="uninstall"]'
        );

        uninstall.dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const modal = widget.shadowRoot.querySelector('.od-confirm-modal-overlay');
        const checkbox = modal.querySelector('[data-action="checkbox"]') as HTMLInputElement;
        checkbox.checked = true;
        modal.querySelector('[data-action="confirm"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 220));

        expect(callMainWorld).toHaveBeenCalledWith('uninstall', 'installed-plugin', true);
    });

    test('renders built-in and installed tabs with separated plugin groups', async () => {
        const widget = await createWidget();

        // 两个 tab 同时存在，内置计数 badge 为 1
        expect(widget.shadowRoot.querySelector('[data-tab="builtin"]')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('[data-tab="installed"]')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('[data-tab="builtin"] .seg-badge')?.textContent).toBe('1');

        // 默认展示已安装面板：仅 local 插件，不含内置插件
        expect(widget.shadowRoot.querySelector('[data-panel="builtin"]')?.hasAttribute('hidden')).toBe(true);
        const installedPanel = widget.shadowRoot.querySelector('[data-panel="installed"]');
        expect(installedPanel?.hasAttribute('hidden')).toBe(false);
        expect(installedPanel?.querySelector('[data-plugin-id="<local-plugin>"]')).not.toBeNull();
        expect(installedPanel?.querySelector('[data-plugin-id="builtin-plugin"]')).toBeNull();

        // 切换到内置面板：仅内置插件，卡片带"内置"标签且无卸载按钮
        widget.shadowRoot.querySelector('[data-tab="builtin"]')?.dispatchEvent(new Event('click'));
        expect(widget.shadowRoot.querySelector('[data-tab="builtin"]')?.classList.contains('active')).toBe(true);
        const builtinPanel = widget.shadowRoot.querySelector('[data-panel="builtin"]');
        expect(builtinPanel?.hasAttribute('hidden')).toBe(false);
        expect(widget.shadowRoot.querySelector('[data-panel="installed"]')?.hasAttribute('hidden')).toBe(true);
        expect(builtinPanel?.querySelector('[data-plugin-id="builtin-plugin"]')).not.toBeNull();
        expect(builtinPanel?.querySelector('[data-plugin-id="<local-plugin>"]')).toBeNull();
        const builtinCard = builtinPanel?.querySelector('[data-plugin-id="builtin-plugin"]');
        expect(builtinCard?.innerHTML).toContain('内置');
        expect(builtinCard?.querySelector('[data-action="uninstall"]')).toBeNull();

        // 内置插件可以禁用
        const toggle = builtinCard?.querySelector('[data-action="toggle"]');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(callMainWorld).toHaveBeenCalledWith('setEnabled', 'builtin-plugin', false);
    });

    test('renders tab icons as inline svg and keeps inactive tabs clean in dark theme', async () => {
        const widget = await createWidget();

        // tab 图标使用线性 svg（对齐侧边栏导航按钮风格），不再使用 emoji 字符
        for (const tab of ['installed', 'builtin']) {
            const button = widget.shadowRoot.querySelector(`[data-tab="${tab}"]`);
            expect(button?.querySelector('svg')).not.toBeNull();
            expect(button?.textContent).not.toContain('📦');
            expect(button?.textContent).not.toContain('🧩');
        }

        // 深色主题下全局 button 背景规则不得污染 seg-item，否则未激活 tab 会出现第二块高亮
        const styles = widget.shadowRoot.querySelector('style')?.textContent ?? '';
        const darkRule = styles.match(/:host\(\[data-theme="dark"\]\) \.seg-item\s*\{([^}]*)\}/)?.[1] ?? '';
        expect(darkRule).toMatch(/background:\s*transparent/);
        expect(darkRule).toMatch(/border:\s*0/);

        // svg 必须块级显示：inline svg 坐在文字基线上会带 descender 空隙，导致图标相对文字偏上
        const segIconRule = styles.match(/\.seg-icon svg\s*\{([^}]*)\}/)?.[1] ?? '';
        expect(segIconRule).toMatch(/display:\s*block/);
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
