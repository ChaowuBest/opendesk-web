import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 插件中心的「插件市场」页面。
 *
 * 关键约定：
 * - 市场列表来自主进程的插件仓库（registry），点开一个市场才去拉清单；
 * - 市场声明了 categories 时显示「全部插件 / 分类A / 分类B」切换，没声明就不显示；
 * - 搜索与技能中心一致：输入框 + 清除 + 搜索按钮，回车或点按钮才发起搜索；
 * - 每个插件卡片都有安装按钮，点击调用主进程的 installFromPluginRegistry。
 */

describe('plugin marketplace renderer', () => {
    let callMainWorld: jest.Mock;

    const REGISTRIES = [
        { name: 'official', displayName: '官方插件市场' },
        { name: 'community', displayName: '社区市场' }
    ];

    function catalog(overrides: Record<string, unknown> = {}) {
        return {
            categories: ['开发工具', '效率'],
            entries: [
                {
                    id: 'dev-plugin',
                    displayName: '开发插件',
                    description: 'A developer plugin',
                    version: '1.0.0',
                    category: ['开发工具'],
                    downloadUrl: 'https://example.com/dev-plugin-1.0.0.zip'
                },
                {
                    id: 'office-plugin',
                    displayName: '办公插件',
                    description: 'An office plugin',
                    version: '2.0.0',
                    apiVersion: 1,
                    category: ['效率'],
                    downloadUrl: 'https://example.com/office-plugin-2.0.0.zip',
                    author: {
                        name: { 'zh-CN': '张三', 'en-US': 'Zhang San' },
                        institution: { 'zh-CN': '开放原子开源基金会' },
                        homepage: 'https://example.com/team'
                    }
                }
            ],
            ...overrides
        };
    }

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
                        id: 'dev-plugin',
                        source: 'local',
                        path: '/plugins/dev-plugin',
                        removable: true,
                        enabled: true,
                        system: false,
                        manifest: {
                            displayName: '开发插件',
                            version: '1.0.0',
                            apiVersion: 1,
                            capabilities: [],
                            author: {
                                name: { 'zh-CN': '李四' },
                                institution: { 'zh-CN': '开放原子开源基金会' },
                                homepage: 'https://example.com/team'
                            }
                        },
                        skills: [],
                        mcpServers: []
                    }
                ];
            }
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') return catalog();
            if (method === 'installFromPluginRegistry') return { success: true, id: 'office-plugin' };
            return undefined;
        });
        window.applicationAPI = {
            callMainWorld,
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };
    });

    async function createWidget(): Promise<any> {
        const widget = document.createElement('pluginmgr-entry-widget') as any;
        document.body.append(widget);
        // 初始化要等两轮 IPC：插件列表 + 市场列表（每个市场在顶部占一个 Tab）
        for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
        return widget;
    }

    /** 顶部 Tab 的市场项（tab id 形如 `market:<registry>`） */
    function marketTabIds(widget: any): string[] {
        return Array.from(widget.shadowRoot.querySelectorAll('[data-tab^="market:"]')).map(
            (tab: any) => tab.dataset.tab as string
        );
    }

    /** 切到某个市场的 Tab */
    async function openMarket(widget: any, registry = 'official'): Promise<void> {
        widget.shadowRoot.querySelector(`[data-tab="market:${registry}"]`).dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    /** 市场面板里当前展示的插件 id（按卡片顺序） */
    function marketPluginIds(widget: any): string[] {
        return Array.from(widget.shadowRoot.querySelectorAll('[data-market-install]')).map(
            (button: any) => button.dataset.marketInstall as string
        );
    }

    test('every configured marketplace gets its own top-level tab', async () => {
        const widget = await createWidget();

        expect(callMainWorld).toHaveBeenCalledWith('listPluginRegistries');
        // 每个市场按自己的名字（displayName）占一个 Tab，没有中间的「插件市场」列表层
        expect(marketTabIds(widget)).toEqual(['market:official', 'market:community']);
        const labels = Array.from(widget.shadowRoot.querySelectorAll('[data-tab^="market:"]')).map((tab: any) =>
            tab.textContent.trim()
        );
        expect(labels).toEqual(['官方插件市场', '社区市场']);
        expect(widget.shadowRoot.querySelector('[data-market-name]')).toBeNull();
        // 市场 Tab 排在「已安装」「内置插件」前面
        expect(Array.from(widget.shadowRoot.querySelectorAll('[data-tab]')).map((tab: any) => tab.dataset.tab)).toEqual(
            ['market:official', 'market:community', 'installed', 'builtin']
        );
    });

    test('opening a marketplace shows its plugins and category tabs', async () => {
        const widget = await createWidget();

        await openMarket(widget);

        expect(callMainWorld).toHaveBeenCalledWith('getPluginCatalog', 'official', undefined, '', false);
        const categories = Array.from(widget.shadowRoot.querySelectorAll('[data-market-category]')).map(
            (button: any) => button.dataset.marketCategory
        );
        // 空串代表「全部插件」
        expect(categories).toEqual(['', '开发工具', '效率']);
        const plugins = Array.from(widget.shadowRoot.querySelectorAll('[data-market-install]')).map(
            (button: any) => button.dataset.marketInstall
        );
        expect(plugins).toEqual(['dev-plugin', 'office-plugin']);
    });

    test('the header refresh button refreshes data without reloading the runtime', async () => {
        const widget = await createWidget();
        await openMarket(widget);
        callMainWorld.mockClear();

        widget.shadowRoot.querySelector('[data-action="refresh"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // 顶栏刷新只重新拉列表与市场清单（带 forceRefresh），绝不重载插件运行时——
        // 那是秒级起步的全量重建，不该挂在一个看起来像「刷新」的按钮上
        expect(callMainWorld).toHaveBeenCalledWith('list');
        expect(callMainWorld).toHaveBeenCalledWith('getPluginCatalog', 'official', undefined, '', true);
        expect(callMainWorld).not.toHaveBeenCalledWith('reload');
    });

    test('refresh completing while another operation is busy keeps the button disabled', async () => {
        let listCalls = 0;
        let initialList: unknown;
        let releaseList: (() => void) | undefined;
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') {
                listCalls += 1;
                if (listCalls === 1) {
                    initialList = [
                        {
                            id: 'dev-plugin',
                            source: 'local',
                            path: '/plugins/dev-plugin',
                            removable: true,
                            enabled: true,
                            system: false,
                            manifest: {
                                displayName: '开发插件',
                                version: '1.0.0',
                                apiVersion: 1,
                                capabilities: [],
                                author: {
                                    name: { 'zh-CN': '李四' },
                                    institution: { 'zh-CN': '开放原子开源基金会' },
                                    homepage: 'https://example.com/team'
                                }
                            },
                            skills: [],
                            mcpServers: []
                        }
                    ];
                    return initialList;
                }
                // 刷新触发的那次挂起：列表内容不变（返回同一份数据），保证走增量路径、按钮节点不重建
                return await new Promise((resolve) => {
                    releaseList = () => resolve(initialList);
                });
            }
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') return catalog();
            return undefined;
        });
        const widget = await createWidget();
        await openMarket(widget);

        widget.shadowRoot.querySelector('[data-action="refresh"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const button = widget.shadowRoot.querySelector('[data-action="refresh"]') as HTMLButtonElement;
        expect(button.disabled).toBe(true);

        // 刷新在途时并行跑了一个全局操作（如菜单里的「重新加载运行时」）把 busy 置位：
        // 刷新结束不能抢着把按钮恢复成可用，否则会出现「其它控件都禁用、刷新却能点」的矛盾态
        (widget as any).setBusy(true);
        releaseList?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(button.disabled).toBe(true);

        (widget as any).setBusy(false);
        expect(button.disabled).toBe(false);
    });

    test('reloading the runtime lives in the add menu and calls reload', async () => {
        const widget = await createWidget();

        widget.shadowRoot.querySelector('[data-action="reload-runtime"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(callMainWorld).toHaveBeenCalledWith('reload');
    });

    test('market without declared categories hides the category switch', async () => {
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') return catalog({ categories: undefined });
            return undefined;
        });
        const widget = await createWidget();

        await openMarket(widget);

        expect(widget.shadowRoot.querySelectorAll('[data-market-category]')).toHaveLength(0);
        expect(widget.shadowRoot.querySelectorAll('[data-market-install]')).toHaveLength(2);
    });

    test('switching category asks the main process for that category only', async () => {
        const widget = await createWidget();
        await openMarket(widget);
        callMainWorld.mockClear();

        widget.shadowRoot.querySelector('[data-market-category="效率"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(callMainWorld).toHaveBeenCalledWith('getPluginCatalog', 'official', ['效率'], '', false);
    });

    test('search runs on Enter and on the search button, and clear resets it', async () => {
        const widget = await createWidget();
        await openMarket(widget);
        callMainWorld.mockClear();

        const input = widget.shadowRoot.querySelector('[data-market-search]') as HTMLInputElement;
        input.value = '办公';
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter', isComposing: false }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(callMainWorld).toHaveBeenCalledWith('getPluginCatalog', 'official', undefined, '办公', false);

        // 输入框里的关键词在重绘后仍然保留
        const nextInput = widget.shadowRoot.querySelector('[data-market-search]') as HTMLInputElement;
        expect(nextInput.value).toBe('办公');

        callMainWorld.mockClear();
        widget.shadowRoot.querySelector('[data-market-search-btn]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(callMainWorld).toHaveBeenCalledWith('getPluginCatalog', 'official', undefined, '办公', false);

        callMainWorld.mockClear();
        widget.shadowRoot.querySelector('[data-market-clear]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(callMainWorld).toHaveBeenCalledWith('getPluginCatalog', 'official', undefined, '', false);
    });

    test('clicking install downloads the plugin from the marketplace', async () => {
        const widget = await createWidget();
        await openMarket(widget);
        callMainWorld.mockClear();

        widget.shadowRoot.querySelector('[data-market-install="office-plugin"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(callMainWorld).toHaveBeenCalledWith('installFromPluginRegistry', 'official', 'office-plugin');
    });

    test('an entry that conflicts with a builtin plugin is shown as not installable', async () => {
        // 内置插件优先：同 id 的包装不上。界面必须直接说清楚，而不是让人点下去才报错
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') {
                return [
                    {
                        id: 'dev-plugin',
                        source: 'builtin',
                        path: '/plugins/dev-plugin',
                        removable: false,
                        enabled: true,
                        system: false,
                        manifest: { displayName: '开发插件', version: '1.0.0', apiVersion: 1, capabilities: [] },
                        skills: [],
                        mcpServers: []
                    }
                ];
            }
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') return catalog();
            return undefined;
        });
        const widget = await createWidget();
        await openMarket(widget);
        callMainWorld.mockClear();

        const button = widget.shadowRoot.querySelector('[data-market-install="dev-plugin"]') as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.textContent).toContain('无法安装');
        const card = widget.shadowRoot.querySelector('.market-card') as HTMLElement;
        expect(card.querySelector('.tag-blocked')?.textContent).toContain('与内置插件冲突');

        // 详情里同样给出原因，且动作按钮不可点
        card.dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const detail = widget.shadowRoot.querySelector('skill-detail-card#market-detail-card') as any;
        const rows = detail.model.metadata as Array<{ label: string; value: string }>;
        expect(rows).toContainEqual({ label: '无法安装的原因', value: '与内置插件冲突' });
        expect(detail.model.actions.find((action: { id: string }) => action.id === 'install')).toMatchObject({
            label: '无法安装',
            disabled: true
        });

        // 就算绕过按钮直接触发，也不会去打安装接口
        await widget.installFromMarket('dev-plugin');
        expect(callMainWorld).not.toHaveBeenCalledWith('installFromPluginRegistry', expect.anything(), 'dev-plugin');
    });

    test('clicking update installs the newer version', async () => {
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') {
                return [
                    {
                        id: 'dev-plugin',
                        source: 'local',
                        path: '/plugins/dev-plugin',
                        removable: true,
                        enabled: true,
                        system: false,
                        manifest: { displayName: '开发插件', version: '0.9.0', apiVersion: 1, capabilities: [] },
                        skills: [],
                        mcpServers: []
                    }
                ];
            }
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') return catalog();
            if (method === 'installFromPluginRegistry') return { success: true, id: 'dev-plugin' };
            return undefined;
        });
        const widget = await createWidget();
        await openMarket(widget);
        callMainWorld.mockClear();

        widget.shadowRoot.querySelector('[data-market-install="dev-plugin"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(callMainWorld).toHaveBeenCalledWith('installFromPluginRegistry', 'official', 'dev-plugin');
    });

    test('the card state follows plugin changes that arrive while the market is open', async () => {
        // 版本更新可能来自别处（头部「+」装本地包、另一个窗口、CLI）：宿主广播 pluginsChanged 后
        // 市场卡片上的「可更新 / 已安装」必须跟着重算，否则会一直提示一个已经装上的旧版本
        let onPluginsChanged: undefined | (() => void);
        (window.applicationAPI.subscribe as jest.Mock).mockImplementation(
            async (name: string, callback: () => void) => {
                if (name === 'pluginsChanged') onPluginsChanged = callback;
                return () => undefined;
            }
        );
        const installedEntry = (version: string) => ({
            id: 'dev-plugin',
            source: 'local',
            path: '/plugins/dev-plugin',
            removable: true,
            enabled: true,
            system: false,
            manifest: { displayName: '开发插件', version, apiVersion: 1, capabilities: [] },
            skills: [],
            mcpServers: []
        });
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [installedEntry('0.9.0')];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') return catalog();
            return undefined;
        });
        const widget = await createWidget();
        await openMarket(widget);
        expect(widget.shadowRoot.querySelector('.tag-update')).not.toBeNull();

        // 别处把插件更新到了清单版本
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [installedEntry('1.0.0')];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') return catalog();
            return undefined;
        });
        onPluginsChanged?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(widget.shadowRoot.querySelector('.tag-update')).toBeNull();
        expect(widget.shadowRoot.querySelector('.tag-installed')).not.toBeNull();
    });

    test('a package that contradicts the marketplace entry pops a modal and is not counted as installed', async () => {
        // 「上架信息与包内清单不一致」不是网络问题：主进程在落盘前中止安装并返回结构化失败，
        // 界面要用模态弹窗让用户看清；同样的长文案不再重复写进页面顶部的提示条
        const mismatchMessage =
            '插件 dev-plugin 的包内清单与市场条目不一致，安装已中止：version（市场 2.0.0 / 插件 1.0.0）';
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') return catalog();
            if (method === 'installFromPluginRegistry') {
                return { success: false, code: 'manifest_mismatch', message: mismatchMessage };
            }
            return undefined;
        });
        const widget = await createWidget();
        await openMarket(widget);
        widget.shadowRoot.querySelector('[data-market-install="dev-plugin"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const overlay = document.querySelector('.od-confirm-modal-overlay') as HTMLElement;
        expect(overlay).not.toBeNull();
        expect(overlay.textContent).toContain('插件信息与实际数据不匹配');
        expect(overlay.textContent).toContain('version（市场 2.0.0 / 插件 1.0.0）');
        // 弹窗之外不再留重复的提示条（提示条只负责其它需要就地反馈的操作）
        const notice = widget.shadowRoot.querySelector('[data-region="notice"]');
        expect(notice?.textContent ?? '').not.toContain('不一致');
        // 更不能当成装成功
        expect(notice?.textContent ?? '').not.toContain('安装成功');

        overlay.querySelector('[data-action="confirm"]')?.dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    test('a package whose manifest needs a newer host pops the upgrade modal instead of a notice', async () => {
        // 市场条目没声明宿主版本、包内清单却声明了的场景：主进程返回结构化 host_version outcome，
        // 界面要弹「无法安装插件」并给出升级引导，而不是把内部错误串写进提示条
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') return catalog();
            if (method === 'installFromPluginRegistry') {
                return {
                    success: false,
                    code: 'host_version',
                    direction: 'too_old',
                    range: '≥ 99.0.0',
                    current: '0.4.1',
                    message: '插件需要 OpenDesk ≥ 99.0.0'
                };
            }
            return undefined;
        });
        const widget = await createWidget();
        await openMarket(widget);
        widget.shadowRoot.querySelector('[data-market-install="office-plugin"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const overlay = widget.shadowRoot.querySelector('.od-confirm-modal-overlay') as HTMLElement;
        expect(overlay).not.toBeNull();
        expect(overlay.textContent).toContain('无法安装插件');
        // 文案带方向引导，并给出插件要求的范围与当前宿主版本
        expect(overlay.textContent).toContain('该插件需要 OpenDesk ≥ 99.0.0');
        expect(overlay.textContent).toContain('当前版本 0.4.1');
        const notice = widget.shadowRoot.querySelector('[data-region="notice"]');
        expect(notice?.textContent ?? '').not.toContain('安装成功');
        expect(notice?.textContent ?? '').not.toContain('plugin.install_host_version');
    });

    test('a local package rejected by the host version gate opens the same modal without a failure notice', async () => {
        // 本地目录 / zip / npm 源安装失败时主进程抛结构化串，界面解析后同样弹升级引导模态
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') return catalog();
            if (method === 'install') throw new Error('plugin.install_host_version:too_old:≥ 99.0.0:0.4.1');
            return undefined;
        });
        const widget = await createWidget();
        widget.install('some-plugin.zip');
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const overlay = widget.shadowRoot.querySelector('.od-confirm-modal-overlay') as HTMLElement;
        expect(overlay).not.toBeNull();
        expect(overlay.textContent).toContain('请将 OpenDesk 升级到最新版本');
        // 弹窗已经说明了原因，不再额外发系统通知
        const notifications = (callMainWorld.mock.calls as unknown[][]).filter(
            ([method]) => method === 'sendNotification'
        );
        expect(notifications).toHaveLength(0);
    });

    test('an entry that needs a newer host is shown as not installable with the required range', async () => {
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') {
                return catalog({
                    entries: [
                        {
                            id: 'future-plugin',
                            displayName: '未来插件',
                            version: '1.0.0',
                            minOpenDeskVersion: '99.0.0',
                            downloadUrl: 'https://example.com/future-plugin-1.0.0.zip'
                        }
                    ]
                });
            }
            return undefined;
        });
        const widget = await createWidget();
        await openMarket(widget);

        const button = widget.shadowRoot.querySelector('[data-market-install="future-plugin"]') as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.textContent).toContain('无法安装');
        expect(widget.shadowRoot.querySelector('.tag-blocked')?.textContent).toContain('需要 OpenDesk ≥ 99.0.0');
    });

    test('an installed plugin with a newer version in the marketplace offers an update', async () => {
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') {
                return [
                    {
                        id: 'dev-plugin',
                        source: 'local',
                        path: '/plugins/dev-plugin',
                        removable: true,
                        enabled: true,
                        system: false,
                        manifest: { displayName: '开发插件', version: '0.9.0', apiVersion: 1, capabilities: [] },
                        skills: [],
                        mcpServers: []
                    }
                ];
            }
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') return catalog();
            return undefined;
        });
        const widget = await createWidget();
        await openMarket(widget);

        const card = widget.shadowRoot.querySelector('.market-card') as HTMLElement;
        expect(card.querySelector('.tag-update')?.textContent).toContain('可更新');
        const button = card.querySelector('[data-market-install="dev-plugin"]') as HTMLButtonElement;
        expect(button.disabled).toBe(false);
        expect(button.textContent).toContain('升级');

        // 详情里同时给出清单版本与本地版本，用户才知道「可更新」是从哪一版算起的
        card.dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const detail = widget.shadowRoot.querySelector('skill-detail-card#market-detail-card') as any;
        const rows = detail.model.metadata as Array<{ label: string; value: string }>;
        expect(rows).toContainEqual({ label: '状态', value: '可更新' });
        expect(rows).toContainEqual({ label: '本地版本', value: 'v0.9.0' });
        expect(detail.model.actions.find((action: { id: string }) => action.id === 'install')).toMatchObject({
            label: '升级',
            disabled: false
        });
    });

    test('download progress from the main process updates the card in place', async () => {
        let onProgress: undefined | ((payload: unknown) => void);
        (window.applicationAPI.subscribe as jest.Mock).mockImplementation(
            async (name: string, callback: (payload: unknown) => void) => {
                if (name === 'marketInstallProgress') onProgress = callback;
                return () => undefined;
            }
        );
        const widget = await createWidget();

        // 卡住安装的 Promise，让进度条留在界面上
        let finish: (value: unknown) => void = () => undefined;
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'getPluginCatalog') return catalog();
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'installFromPluginRegistry') {
                return await new Promise((resolve) => {
                    finish = resolve;
                });
            }
            return undefined;
        });
        await openMarket(widget);

        widget.shadowRoot.querySelector('[data-market-install="office-plugin"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const progressHolder = widget.shadowRoot.querySelector('[data-market-progress="office-plugin"]');
        expect(progressHolder).not.toBeNull();

        onProgress?.({ registry: 'official', pluginId: 'office-plugin', receivedBytes: 512, totalBytes: 2048 });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const label = progressHolder?.querySelector('.market-progress-label') as HTMLElement;
        expect(label.textContent).toContain('25%');

        finish({ success: true, id: 'office-plugin' });
        await new Promise((resolve) => setTimeout(resolve, 10));
    });

    test('market card follows the skill card layout', async () => {
        const widget = await createWidget();

        await openMarket(widget);

        const card = widget.shadowRoot.querySelector('[data-market-install="office-plugin"]')?.closest('.market-card');
        expect(card).not.toBeNull();
        // 名字右侧的小胶囊是版本号
        expect(card?.querySelector('.card-title')?.textContent).toBe('办公插件');
        expect(card?.querySelector('.tag-version')?.textContent).toBe('2.0.0');
        // 作者行是 `@名字 (单位)`
        expect(card?.querySelector('.card-author')?.textContent).toBe('@张三 (开放原子开源基金会)');
        // 底部左侧是分类胶囊，右侧是安装按钮
        expect(Array.from(card?.querySelectorAll('.tag-category') ?? []).map((item) => item.textContent)).toEqual([
            '效率'
        ]);
        expect(card?.querySelector('.install-btn')?.textContent).toBe('安装');
        // 正文与技能卡片一样限制两行（-webkit-line-clamp: 2）
        expect(card?.querySelector('.card-desc')?.textContent).toContain('An office plugin');

        // 没有作者信息的插件不显示作者行
        const devCard = widget.shadowRoot.querySelector('[data-market-install="dev-plugin"]')?.closest('.market-card');
        expect(devCard?.querySelector('.card-author')).toBeNull();
    });

    test('author homepage makes the author name a link (opened by the system browser)', async () => {
        const widget = await createWidget();

        await openMarket(widget);

        const link = widget.shadowRoot
            .querySelector('[data-market-install="office-plugin"]')
            ?.closest('.market-card')
            ?.querySelector('a.card-author-link') as HTMLAnchorElement | null;
        // target=_blank 的链接由主窗口的 window-open 策略交给系统浏览器打开
        expect(link?.getAttribute('href')).toBe('https://example.com/team');
        expect(link?.getAttribute('target')).toBe('_blank');
        expect(link?.textContent).toBe('@张三');
    });

    test('detail marks the author homepage row as a link', async () => {
        const widget = await createWidget();
        widget.shadowRoot.querySelector('[data-plugin-id="dev-plugin"]').dispatchEvent(new Event('click'));
        const detail = widget.shadowRoot.querySelector('skill-detail-card') as any;

        const rows = detail.model.metadata as Array<{ label: string; value: string; href?: string }>;
        expect(rows.find((row) => row.label === '作者主页')).toMatchObject({
            value: 'https://example.com/team',
            href: 'https://example.com/team'
        });
        // 非链接行不带 href
        expect(rows.find((row) => row.label === '作者')?.href).toBeUndefined();
    });

    test('a failed install pushes the reason through a system notification', async () => {
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') return catalog();
            if (method === 'installFromPluginRegistry') {
                throw new Error('安装失败：无法获取插件包（HTTP 404）');
            }
            return undefined;
        });
        const widget = await createWidget();
        await openMarket(widget);

        widget.shadowRoot.querySelector('[data-market-install="office-plugin"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const notification = (callMainWorld.mock.calls as unknown[][]).find(
            ([method]) => method === 'sendNotification'
        );
        expect(notification?.[1]).toBe('error');
        expect(notification?.[3]).toBe('插件安装失败');
        expect(notification?.[4]).toBe('安装失败：无法获取插件包（HTTP 404）');
        // 消息只走通知：页面提示条在详情弹窗打开时会被盖住，不再重复写一遍
        expect(widget.shadowRoot.querySelector('[data-region="notice"]')?.textContent ?? '').not.toContain('HTTP 404');
    });

    test('a successful marketplace install reports through a system notification, not the notice bar', async () => {
        const widget = await createWidget();
        await openMarket(widget);

        widget.shadowRoot.querySelector('[data-market-install="office-plugin"]').dispatchEvent(new Event('click'));
        for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));

        const notification = (callMainWorld.mock.calls as unknown[][]).find(
            ([method]) => method === 'sendNotification'
        );
        expect(notification?.[1]).toBe('info');
        expect(notification?.[3]).toBe('插件安装成功');
        expect(notification?.[4]).toBe('插件安装成功：办公插件');
        expect(widget.shadowRoot.querySelector('[data-region="notice"]')?.textContent ?? '').toBe('');
    });

    test('installed plugin detail lists author, institution and homepage', async () => {
        const widget = await createWidget();
        widget.shadowRoot.querySelector('[data-plugin-id="dev-plugin"]').dispatchEvent(new Event('click'));
        const detail = widget.shadowRoot.querySelector('skill-detail-card') as any;

        const metadata = (detail.model.metadata as Array<{ label: string; value: string }>).map((row) => [
            row.label,
            row.value
        ]);
        expect(metadata).toContainEqual(['作者', '李四']);
        expect(metadata).toContainEqual(['机构', '开放原子开源基金会']);
        expect(metadata).toContainEqual(['作者主页', 'https://example.com/team']);
    });

    test('a slow earlier request cannot overwrite the latest category', async () => {
        const widget = await createWidget();
        await openMarket(widget);

        // 让清单请求挂起，手动控制返回顺序
        const resolvers: Array<(value: unknown) => void> = [];
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') {
                return await new Promise((resolve) => {
                    resolvers.push(resolve);
                });
            }
            return undefined;
        });

        widget.shadowRoot.querySelector('[data-market-category="开发工具"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        widget.shadowRoot.querySelector('[data-market-category="效率"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(resolvers).toHaveLength(2);

        // 后发的「效率」先回来，先发的「开发工具」迟到：界面必须是最后一次请求的结果
        resolvers[1]({ categories: ['开发工具', '效率'], entries: [catalog().entries[1]] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        resolvers[0]({ categories: ['开发工具', '效率'], entries: [catalog().entries[0]] });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(marketPluginIds(widget)).toEqual(['office-plugin']);
    });

    test('channel changes refresh the marketplace list', async () => {
        let onRegistriesChanged: undefined | (() => void);
        (window.applicationAPI.subscribe as jest.Mock).mockImplementation(
            async (name: string, callback: () => void) => {
                if (name === 'registriesChanged') onRegistriesChanged = callback;
                return () => undefined;
            }
        );
        const widget = await createWidget();
        expect(marketTabIds(widget)).toEqual(['market:official', 'market:community']);

        // 用户去设置里加了一个仓库，主进程广播 registriesChanged
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') {
                return [...REGISTRIES, { name: 'team', displayName: '团队市场' }];
            }
            return undefined;
        });
        onRegistriesChanged?.();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // 新增的仓库立刻多出一个 Tab，不需要切走再切回
        expect(marketTabIds(widget)).toEqual(['market:official', 'market:community', 'market:team']);
    });

    test('editing the channel of the open marketplace reloads its catalog', async () => {
        let onRegistriesChanged: undefined | (() => void);
        (window.applicationAPI.subscribe as jest.Mock).mockImplementation(
            async (name: string, callback: () => void) => {
                if (name === 'registriesChanged') onRegistriesChanged = callback;
                return () => undefined;
            }
        );
        const widget = await createWidget();
        await openMarket(widget);
        expect(marketPluginIds(widget)).toEqual(['dev-plugin', 'office-plugin']);

        // 用户在设置里把官方仓库的地址改了：主进程重建了 registry 并广播
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') {
                return catalog({
                    entries: [
                        {
                            id: 'team-plugin',
                            displayName: '团队插件',
                            version: '3.0.0',
                            downloadUrl: 'https://team.example.com/team-plugin-3.0.0.zip'
                        }
                    ]
                });
            }
            return undefined;
        });
        onRegistriesChanged?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // 市场 Tab 还叫原来的名字，但卡片必须换成新仓库的清单：
        // 留着旧清单会让用户以为自己装的是新仓库里的插件
        expect(marketPluginIds(widget)).toEqual(['team-plugin']);
    });

    test('a market detail whose plugin disappears from the catalog is closed', async () => {
        const widget = await createWidget();
        await openMarket(widget);

        const cards = Array.from(widget.shadowRoot.querySelectorAll('.market-card'));
        cards[1].dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(widget.shadowRoot.querySelector('#market-detail-card')).not.toBeNull();

        // 刷新后市场换了一版，这条没了：弹窗不能继续挂着一个已经装不到的插件
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') return catalog({ entries: [catalog().entries[0]] });
            return undefined;
        });
        widget.shadowRoot.querySelector('[data-market-refresh]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(widget.shadowRoot.querySelector('#market-detail-card')).toBeNull();
        expect(widget.selectedMarketPluginId).toBeUndefined();
    });

    test('clearing the search while a search is in flight still refreshes', async () => {
        const widget = await createWidget();
        await openMarket(widget);

        let resolveSearch: (value: unknown) => void = () => undefined;
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') {
                return await new Promise((resolve) => {
                    resolveSearch = resolve;
                });
            }
            return undefined;
        });

        const input = widget.shadowRoot.querySelector('[data-market-search]') as HTMLInputElement;
        input.value = '办公';
        input.dispatchEvent(new Event('input'));
        widget.shadowRoot.querySelector('[data-market-search-btn]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // 搜索还没回来就点清除：不能因为「正在搜索」而吞掉这次清除
        callMainWorld.mockClear();
        widget.shadowRoot.querySelector('[data-market-clear]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(callMainWorld).toHaveBeenCalledWith('getPluginCatalog', 'official', undefined, '', false);
        const retryInput = widget.shadowRoot.querySelector('[data-market-search]') as HTMLInputElement;
        expect(retryInput.value).toBe('');
        resolveSearch(catalog());
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    test('loading and empty states reuse the skills center look', async () => {
        // 清单还没回来：居中的圆环 + 文案，而不是一整块灰色方块
        let resolveCatalog: (value: unknown) => void = () => undefined;
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') {
                return await new Promise((resolve) => {
                    resolveCatalog = resolve;
                });
            }
            return undefined;
        });
        const widget = await createWidget();
        widget.shadowRoot.querySelector('[data-tab="market:official"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const loading = widget.shadowRoot.querySelector('[data-region="market"] .loading-state');
        expect(loading).not.toBeNull();
        expect(loading?.querySelector('.loading-spinner')).not.toBeNull();
        expect(loading?.textContent).toContain('正在获取插件清单');

        // 搜索无结果：同样是技能中心那套 empty-state
        resolveCatalog({ categories: undefined, entries: [] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const input = widget.shadowRoot.querySelector('[data-market-search]') as HTMLInputElement;
        input.value = '不存在';
        input.dispatchEvent(new Event('input'));
        widget.shadowRoot.querySelector('[data-market-search-btn]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const empty = widget.shadowRoot.querySelector('[data-region="market"] .empty-state');
        expect(empty).not.toBeNull();
        expect(empty?.querySelector('.empty-title')?.textContent).toBe('没有找到匹配的插件');
        expect(empty?.querySelector('.empty-hint')?.textContent).toContain('换个关键词');
    });

    test('switching the UI language reloads marketplace names', async () => {
        let english = false;
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') {
                // 主进程按「当时的界面语言」解析市场显示名
                return english
                    ? [
                          { name: 'official', displayName: 'Official Marketplace' },
                          { name: 'community', displayName: 'Community' }
                      ]
                    : REGISTRIES;
            }
            if (method === 'getPluginCatalog') return catalog();
            return undefined;
        });
        const widget = await createWidget();
        const officialLabel = () =>
            widget.shadowRoot.querySelector('[data-tab="market:official"]')?.textContent?.trim();
        expect(officialLabel()).toBe('官方插件市场');

        english = true;
        // 主窗口在切换界面语言时向 iframe 广播 LOCALE_CHANGED（linkedom 不支持 MessageEvent，直接挂 data）
        const languageEvent = new Event('message');
        Object.assign(languageEvent, { data: { type: 'LOCALE_CHANGED', locale: 'en-US' } });
        window.dispatchEvent(languageEvent);
        for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));

        // Tab 名跟着切换语言重新解析，不会停在旧语言上
        expect(officialLabel()).toBe('Official Marketplace');
    });

    test('clicking a market card opens the plugin detail modal', async () => {
        const widget = await createWidget();
        await openMarket(widget);

        // 第二张卡片是未安装的 office-plugin
        const cards = Array.from(widget.shadowRoot.querySelectorAll('.market-card'));
        cards[1].dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const detail = widget.shadowRoot.querySelector('skill-detail-card#market-detail-card') as any;
        expect(detail).not.toBeNull();
        expect(detail.model.name).toBe('办公插件');
        const rows = detail.model.metadata as Array<{ label: string; value: string; href?: string }>;
        expect(rows).toContainEqual({ label: '状态', value: '未安装' });
        expect(rows).toContainEqual({ label: '版本', value: '2.0.0' });
        expect(rows).toContainEqual({ label: '插件 ID', value: 'office-plugin' });
        expect(rows).toContainEqual({ label: '分类', value: '效率' });
        // 清单声明了 apiVersion 时详情里展示它
        expect(rows).toContainEqual({ label: 'API 版本', value: '1' });
        expect(detail.model.actions.map((action: any) => action.id)).toEqual(['install']);

        // 已安装且无更新版本的插件在详情里显示「已是最新」，主按钮禁用（与测评集下载中心同语义）
        cards[0].dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const installedDetail = widget.shadowRoot.querySelector('skill-detail-card#market-detail-card') as any;
        const installedRows = installedDetail.model.metadata as Array<{ label: string; value: string }>;
        expect(installedRows).toContainEqual({ label: '状态', value: '已是最新' });
        expect(installedDetail.model.actions.find((action: { id: string }) => action.id === 'install')).toMatchObject({
            label: '已是最新',
            disabled: true
        });
        // 禁用态渲染出来之前的一次点击（或脚本派发）也不能绕过去覆盖安装：
        // installFromMarket 内部与按钮同口径再挡一次
        callMainWorld.mockClear();
        installedDetail.dispatchEvent(new CustomEvent('skill-detail-action', { detail: { id: 'install' } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(callMainWorld).not.toHaveBeenCalledWith('installFromPluginRegistry', 'official', 'dev-plugin');
    });

    test('card actions do not open the detail modal', async () => {
        const widget = await createWidget();
        await openMarket(widget);

        // 点安装按钮只会触发安装，不会顺带打开详情
        widget.shadowRoot.querySelector('[data-market-install="office-plugin"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(widget.shadowRoot.querySelector('#market-detail-card')).toBeNull();
        expect(callMainWorld).toHaveBeenCalledWith('installFromPluginRegistry', 'official', 'office-plugin');
    });

    test('the detail modal can install the plugin and be closed', async () => {
        const widget = await createWidget();
        await openMarket(widget);
        // 安装路径用未安装的 office-plugin 验证；已安装且同版本的 dev-plugin 会被「已是最新」拦下
        widget.shadowRoot.querySelector('[data-market-plugin="office-plugin"]').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        callMainWorld.mockClear();

        const detail = widget.shadowRoot.querySelector('#market-detail-card') as HTMLElement;
        detail.dispatchEvent(new CustomEvent('skill-detail-action', { detail: { id: 'install' } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(callMainWorld).toHaveBeenCalledWith('installFromPluginRegistry', 'official', 'office-plugin');

        detail.dispatchEvent(new CustomEvent('skill-detail-action', { detail: { id: 'close' } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(widget.shadowRoot.querySelector('#market-detail-card')).toBeNull();
    });

    test('an installed plugin can be uninstalled right from the marketplace detail', async () => {
        // 已装的插件在市场上点开详情时要能直接卸载：否则用户得回到「已安装」再找一遍
        const widget = await createWidget();
        await openMarket(widget);
        // dev-plugin 已在已安装列表里，点卡片打开它的市场详情
        widget.shadowRoot.querySelector('[data-market-plugin="dev-plugin"]').dispatchEvent(new Event('click'));
        const detail = widget.shadowRoot.querySelector('#market-detail-card') as any;
        expect(detail.model.actions.map((action: { id: string }) => action.id)).toEqual(['uninstall', 'install']);
        callMainWorld.mockClear();

        detail.dispatchEvent(new CustomEvent('skill-detail-action', { detail: { id: 'uninstall' } }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        // 卸载先走确认弹窗（与已安装列表里的卸载同一套确认）
        const overlay = widget.shadowRoot.querySelector('.od-confirm-modal-overlay') as HTMLElement;
        expect(overlay).not.toBeNull();
        overlay.querySelector('[data-action="confirm"]')?.dispatchEvent(new Event('click'));
        // 确认弹窗有收起动画，等 uninstall 真正发出去（最多 ~1s）
        for (let tick = 0; tick < 40; tick += 1) {
            if ((callMainWorld.mock.calls as unknown[][]).some(([method]) => method === 'uninstall')) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        expect(callMainWorld).toHaveBeenCalledWith('uninstall', 'dev-plugin', false);
        // 结果同样只走通知
        const notification = (callMainWorld.mock.calls as unknown[][]).find(
            ([method]) => method === 'sendNotification'
        );
        expect(notification?.[1]).toBe('info');
        expect(notification?.[3]).toBe('卸载成功');
        // 详情弹窗保持打开，供用户继续操作
        expect(widget.shadowRoot.querySelector('#market-detail-card')).not.toBeNull();
    });

    test('a plugin that is not installed has no uninstall action in its market detail', async () => {
        const widget = await createWidget();
        await openMarket(widget);
        widget.shadowRoot.querySelector('[data-market-plugin="office-plugin"]').dispatchEvent(new Event('click'));
        const detail = widget.shadowRoot.querySelector('#market-detail-card') as any;

        expect(detail.model.actions.map((action: { id: string }) => action.id)).toEqual(['install']);
    });

    test('the detail dialog switches to the installing state as soon as the download starts', async () => {
        // 从详情弹窗点安装时，弹窗里的按钮要立刻变成「安装中…」并禁用：
        // 只重画卡片的话，弹窗还写着「安装」，用户会以为没点上
        let finish: (value: unknown) => void = () => undefined;
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') return catalog();
            if (method === 'installFromPluginRegistry') {
                return await new Promise((resolve) => {
                    finish = resolve;
                });
            }
            return undefined;
        });
        const widget = await createWidget();
        await openMarket(widget);
        widget.shadowRoot.querySelector('.market-card').dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const detail = widget.shadowRoot.querySelector('skill-detail-card#market-detail-card') as any;
        detail.dispatchEvent(new CustomEvent('skill-detail-action', { detail: { id: 'install' } }));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(detail.model.actions.find((action: { id: string }) => action.id === 'install')).toMatchObject({
            label: '安装中…',
            disabled: true
        });
        // 卡片上的按钮同步进入安装中
        const button = widget.shadowRoot.querySelector('[data-market-install="dev-plugin"]') as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.textContent).toContain('安装中');

        finish({ success: true, id: 'dev-plugin' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    test('the market detail lists author and homepage links', async () => {
        const widget = await createWidget();
        await openMarket(widget);

        // 打开带作者的 office-plugin（第二张卡片）
        const cards = Array.from(widget.shadowRoot.querySelectorAll('.market-card'));
        cards[1].dispatchEvent(new Event('click'));
        await new Promise((resolve) => setTimeout(resolve, 0));

        const detail = widget.shadowRoot.querySelector('#market-detail-card') as any;
        const rows = detail.model.metadata as Array<{ label: string; value: string; href?: string }>;
        expect(rows).toContainEqual({ label: '作者', value: '张三' });
        expect(rows).toContainEqual({ label: '机构', value: '开放原子开源基金会' });
        expect(rows.find((row) => row.label === '作者主页')).toMatchObject({
            value: 'https://example.com/team',
            href: 'https://example.com/team'
        });
    });

    test('market cards use the catalog icon when the entry declares one', async () => {
        const iconUrl = 'data:image/png;base64,AAEC';
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') {
                return catalog({
                    entries: [
                        {
                            id: 'dev-plugin',
                            displayName: '开发插件',
                            description: 'A developer plugin',
                            version: '1.0.0',
                            downloadUrl: 'https://example.com/dev-plugin-1.0.0.zip',
                            iconUrl
                        },
                        {
                            id: 'office-plugin',
                            displayName: '办公插件',
                            description: 'An office plugin',
                            version: '2.0.0',
                            downloadUrl: 'https://example.com/office-plugin-2.0.0.zip'
                        }
                    ]
                });
            }
            return undefined;
        });
        const widget = await createWidget();
        await openMarket(widget);

        // 声明了 iconUrl 的卡片用图片做图标
        const card = widget.shadowRoot.querySelector('[data-market-plugin="dev-plugin"]') as HTMLElement;
        const img = card.querySelector('.card-icon img.card-icon-img') as HTMLImageElement | null;
        expect(img).not.toBeNull();
        expect(img?.getAttribute('src')).toBe(iconUrl);
        // 首字母仍渲染在图片下面：图片加载失败被移除后自然回退到首字母图标
        expect(card.querySelector('.card-icon .card-icon-initial')?.textContent).toBe('开');

        // 未声明 iconUrl 的卡片保持首字母图标，不渲染图片
        const plainCard = widget.shadowRoot.querySelector('[data-market-plugin="office-plugin"]') as HTMLElement;
        expect(plainCard.querySelector('.card-icon img')).toBeNull();
        expect(plainCard.querySelector('.card-icon')?.textContent).toContain('办');
    });

    test('a failed catalog load shows the marketplace error instead of a blank page', async () => {
        callMainWorld.mockImplementation(async (method: string) => {
            if (method === 'list') return [];
            if (method === 'listPluginRegistries') return REGISTRIES;
            if (method === 'getPluginCatalog') throw new Error('无法拉取插件清单 http://127.0.0.1/plugins.json');
            return undefined;
        });
        const widget = await createWidget();

        await openMarket(widget);

        const market = widget.shadowRoot.querySelector('[data-region="market"]') as HTMLElement;
        expect(market.textContent).toContain('插件市场加载失败');
        expect(market.textContent).toContain('无法拉取插件清单');
        // 错误详情里带 URL：必须走「允许折行的详情样式」，否则长地址会把整段顶出容器、居中失效
        expect(market.querySelector('.empty-hint.error-detail')).not.toBeNull();
    });
});
