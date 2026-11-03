import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { parseHTML } from 'linkedom';
import { confirmModalMockShim } from '../../confirmModalMock.js';
import type {
    BenchmarkSummary,
    InstalledBenchmarkSummary,
    DownloadState
} from '../../../main/applications/benchmark/common.js';
import { downloadStateKey } from '../../../main/applications/benchmark/catalog-common.js';

/**
 * 测评集下载中心（渲染层）回归：
 * - 每个 registry 一个 Tab，Tab 之间清单/下载状态互不影响；
 * - 卡片状态标签按「下载中 > 失败 > 安装状态」优先显示；
 * - 进度推送只定点更新进度条/标签，不重建卡片（重建会打断 hover）；
 * - 本地 meta 没写版本号时不能渲染出「本地版本 v」这种空版本。
 */

const ENTRY: BenchmarkSummary = {
    id: 'workbuddy-bench',
    name: 'WorkBuddy Bench',
    description: 'fixture',
    homepage: 'https://example.com',
    version: '0.1',
    downloadUrl: 'https://example.com/workbuddy-bench.zip',
    tracks: [{ id: 'office', name: 'Office' }]
};

function makeDataset(patch: Partial<InstalledBenchmarkSummary> = {}): InstalledBenchmarkSummary {
    return {
        id: 'ds-1',
        name: 'WorkBuddy Bench',
        description: '',
        homepage: '',
        version: '0.1',
        importedAt: 0,
        caseCount: 2,
        tracks: [],
        ...patch
    };
}

function makeDownload(patch: Partial<DownloadState> = {}): DownloadState {
    return {
        registryName: 'official',
        catalogId: 'workbuddy-bench',
        status: 'downloading',
        receivedBytes: 0,
        totalBytes: null,
        error: '',
        ...patch
    };
}

describe('benchmark 测评集下载中心', () => {
    let callMainWorld: jest.Mock;

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
        await jest.unstable_mockModule('../../../renderer/components/confirmModal', () =>
            confirmModalMockShim({
                showConfirmModal: jest.fn(),
                bindOverlayDismiss: jest.fn()
            })
        );

        await import('../../../main/applications/benchmark/renderer/entry.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        callMainWorld = jest.fn(async () => undefined);
        (globalThis as any).window.applicationAPI = {
            call: jest.fn(),
            callMainWorld,
            subscribe: jest.fn(),
            unsubscribe: jest.fn()
        };
    });

    interface WidgetOptions {
        datasets?: InstalledBenchmarkSummary[];
        downloads?: DownloadState[];
        catalogs?: Map<string, BenchmarkSummary[]>;
        registries?: Array<{ name: string; displayName: string }>;
        activeTab?: string;
    }

    function createWidget(options: WidgetOptions = {}) {
        const widget = document.createElement('benchmark-entry-widget') as any;
        // 界面文案跟随设置语言：用例断言中文标签，这里固定 zh-CN，
        // 否则会随运行环境（CI 上的 en-US）渲染出英文文案
        widget._applyLocaleSetting({ locale: 'zh-CN' });
        widget.loading = false;
        widget.registries = options.registries ?? [{ name: 'official', displayName: '官方测评集' }];
        widget.catalogs = options.catalogs ?? new Map<string, BenchmarkSummary[]>([['official', [{ ...ENTRY }]]]);
        widget.activeTab = options.activeTab ?? 'registry:official';
        widget.datasets = options.datasets ?? [];
        widget.downloads = new Map(
            (options.downloads ?? []).map((state) => [downloadStateKey(state.registryName, state.catalogId), state])
        );
        widget.render();
        widget.shadowRoot.addEventListener('click', widget.handleClick);
        return widget;
    }

    function statusPill(widget: any, registryName = 'official'): HTMLElement {
        return widget.shadowRoot.querySelector(
            `[data-catalog-status="workbuddy-bench"][data-registry-name="${registryName}"]`
        ) as HTMLElement;
    }

    function tabButton(widget: any, tab: string): HTMLButtonElement | null {
        return widget.shadowRoot.querySelector(`[data-action="tab"][data-tab="${tab}"]`) as HTMLButtonElement | null;
    }

    test('未安装的清单项显示待下载状态', () => {
        const widget = createWidget();
        expect(statusPill(widget).className).toContain('pending');
        expect(widget.shadowRoot.querySelector('[data-action="open-catalog"]')).not.toBeNull();
    });

    test('清单还没回来时先转圈，不闪空态', () => {
        const widget = createWidget();
        widget.catalogs = new Map();
        widget.loading = true;
        widget.render();
        expect(widget.shadowRoot.querySelector('.loading-state')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('.empty-state')).toBeNull();

        // 加载完成后清单为空才是真的空态
        widget.loading = false;
        widget.render();
        expect(widget.shadowRoot.querySelector('.empty-state')).not.toBeNull();
    });

    test('切到某个 registry 的 Tab 时清单还在路上也不闪空态', () => {
        // 清单要联网，本地测评集已经回来了（loading=false），此时不能显示空态
        const widget = createWidget();
        widget.catalogs = new Map();
        widget.activeTab = 'datasets';
        widget.render();
        callMainWorld = jest.fn(() => new Promise(() => undefined));
        (globalThis as any).window.applicationAPI.callMainWorld = callMainWorld;

        // 弱网：清单一直没回来，同步渲染出来的这一帧就必须是加载态
        void widget.switchTab('registry:official');

        expect(widget.shadowRoot.querySelector('.loading-state')).not.toBeNull();
        expect(widget.shadowRoot.querySelector('.empty-state')).toBeNull();
    });

    test('点刷新会等清单回来后补一次渲染', async () => {
        const widget = createWidget();
        widget.catalogs = new Map();
        // 清单比测评集/历史慢一拍回来：先回来的那路渲染完时清单还是旧的
        callMainWorld = jest.fn(async (method: string) => {
            if (method === 'listCatalogDatasets') {
                await new Promise((resolve) => setTimeout(resolve, 5));
                return [{ ...ENTRY }];
            }
            if (method === 'listDownloads') return [];
            return [];
        });
        (globalThis as any).window.applicationAPI.callMainWorld = callMainWorld;

        const refresh = widget.shadowRoot.querySelector('[data-action="refresh"]') as HTMLElement;
        refresh.dispatchEvent(new window.Event('click', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(statusPill(widget)).not.toBeNull();
        // 手动刷新要绕开主进程的清单缓存，并且只刷当前 registry
        expect(callMainWorld).toHaveBeenCalledWith('listCatalogDatasets', 'official', true);
    });

    test('本地版本更低时提示可更新', () => {
        const widget = createWidget({ datasets: [makeDataset({ version: '0.0.9' })] });
        expect(statusPill(widget).className).toContain('running');
        expect(statusPill(widget).textContent).toBe('可更新');
    });

    test('本地版本不低于清单时显示已是最新', () => {
        const widget = createWidget({ datasets: [makeDataset({ version: '0.1' })] });
        expect(statusPill(widget).className).toContain('completed');
        expect(statusPill(widget).textContent).toBe('已是最新');
    });

    test('下载进度推送只定点更新标签与进度条，不重建卡片', async () => {
        const widget = createWidget({
            downloads: [makeDownload({ receivedBytes: 50, totalBytes: 200 })]
        });
        const card = widget.shadowRoot.querySelector('[data-action="open-catalog"]') as HTMLElement;
        expect(statusPill(widget).textContent).toBe('下载中 25%');

        // 主进程推进进度后渲染层重新拉一次状态
        callMainWorld = jest.fn(async () => [makeDownload({ receivedBytes: 150, totalBytes: 200 })]);
        (globalThis as any).window.applicationAPI.callMainWorld = callMainWorld;
        await widget.refreshDownloads();

        expect(statusPill(widget).textContent).toBe('下载中 75%');
        // 同一个 DOM 节点还在：整窗重建会把 hover/滚动状态打散
        expect(widget.shadowRoot.querySelector('[data-action="open-catalog"]')).toBe(card);
    });

    test('弹窗里的进度条按已接收字节推进，拿到总量后不再漂移', async () => {
        const widget = createWidget({ downloads: [makeDownload({ receivedBytes: 0, totalBytes: null })] });
        widget.catalogModal = { registryName: 'official', catalogId: 'workbuddy-bench' };
        widget.render();

        const track = widget.shadowRoot.querySelector('.dl-progress-bar') as HTMLElement;
        expect(track.classList.contains('indeterminate')).toBe(true);

        callMainWorld = jest.fn(async () => [makeDownload({ receivedBytes: 512, totalBytes: 1024 })]);
        (globalThis as any).window.applicationAPI.callMainWorld = callMainWorld;
        await widget.refreshDownloads();

        const bar = widget.shadowRoot.querySelector('[data-dl-bar]') as HTMLElement;
        expect(bar.style.width).toBe('50%');
        expect(
            (widget.shadowRoot.querySelector('.dl-progress-bar') as HTMLElement).classList.contains('indeterminate')
        ).toBe(false);
    });

    test('下载状态落地时弹窗不重播入场动画', async () => {
        const widget = createWidget({ downloads: [makeDownload({ receivedBytes: 1, totalBytes: 2 })] });
        widget.catalogModal = { registryName: 'official', catalogId: 'workbuddy-bench' };
        widget.render();
        // 刚打开的那一帧允许播入场动画
        const opened = widget.shadowRoot.querySelector('.modal-overlay') as HTMLElement;
        expect(opened.classList.contains('no-anim')).toBe(false);

        callMainWorld = jest.fn(async () => [makeDownload({ status: 'installing' })]);
        (globalThis as any).window.applicationAPI.callMainWorld = callMainWorld;
        await widget.refreshDownloads();

        // 同一个弹窗只是换了状态，重播动画会看着闪一下
        const overlay = widget.shadowRoot.querySelector('.modal-overlay') as HTMLElement;
        expect(overlay.classList.contains('no-anim')).toBe(true);
    });

    test('下载失败时弹窗展示错误信息', () => {
        const widget = createWidget({ downloads: [makeDownload({ status: 'failed', error: 'HTTP 404' })] });
        widget.catalogModal = { registryName: 'official', catalogId: 'workbuddy-bench' };
        widget.render();

        const error = widget.shadowRoot.querySelector('.modal-error') as HTMLElement;
        expect(error).not.toBeNull();
        expect(error.textContent).toContain('HTTP 404');
        // 失败后还能重试：按钮不能是禁用态
        const button = widget.shadowRoot.querySelector('[data-action="download-dataset"]') as HTMLButtonElement;
        expect(button).not.toBeNull();
        expect(button.hasAttribute('disabled')).toBe(false);
    });

    test('点击卡片打开弹窗，点下载触发主进程下载（带上 registry）', async () => {
        const widget = createWidget();
        const card = widget.shadowRoot.querySelector('[data-action="open-catalog"]') as HTMLElement;
        card.dispatchEvent(new window.Event('click', { bubbles: true }));
        await Promise.resolve();

        expect(widget.catalogModal).toEqual({ registryName: 'official', catalogId: 'workbuddy-bench' });
        const button = widget.shadowRoot.querySelector('[data-action="download-dataset"]') as HTMLElement;
        expect(button).not.toBeNull();
        button.dispatchEvent(new window.Event('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
        expect(callMainWorld).toHaveBeenCalledWith('downloadDataset', 'official', 'workbuddy-bench');
    });

    test('本地测评集没有版本号时弹窗不显示空版本', () => {
        const widget = createWidget({ datasets: [makeDataset({ version: '' })] });
        widget.catalogModal = { registryName: 'official', catalogId: 'workbuddy-bench' };
        widget.render();

        const subtitle = widget.shadowRoot.querySelector('.modal-banner-sub') as HTMLElement;
        expect(subtitle.textContent).not.toContain('本地版本');
    });

    // ── 多 registry ────────────────────────────────────────────────────────

    function createMultiRegistryWidget(options: WidgetOptions = {}) {
        return createWidget({
            registries: [
                { name: 'official', displayName: '官方测评集' },
                { name: 'community', displayName: '社区测评集' }
            ],
            catalogs: new Map<string, BenchmarkSummary[]>([
                ['official', [{ ...ENTRY }]],
                ['community', [{ ...ENTRY, name: 'Community WorkBuddy' }]]
            ]),
            ...options
        });
    }

    test('每个 registry 占一个独立 Tab，文案只显示 registry 显示名（不带测评集数量）', () => {
        const widget = createMultiRegistryWidget();

        const officialTab = tabButton(widget, 'registry:official');
        const communityTab = tabButton(widget, 'registry:community');
        expect(officialTab?.textContent).toContain('官方测评集');
        expect(communityTab?.textContent).toContain('社区测评集');
        // 渠道 Tab 后面不再跟测评集数量角标
        expect(communityTab?.querySelector('.seg-badge')).toBeNull();
        expect(officialTab?.querySelector('.seg-badge')).toBeNull();
        // 内置 Tab 仍在
        expect(tabButton(widget, 'datasets')).not.toBeNull();
        expect(tabButton(widget, 'history')).not.toBeNull();
        expect(officialTab?.classList.contains('active')).toBe(true);
    });

    test('切 Tab 后展示对应 registry 的清单', () => {
        const widget = createMultiRegistryWidget();

        expect(widget.shadowRoot.querySelector('.card-title')?.textContent).toBe('WorkBuddy Bench');

        widget.activeTab = 'registry:community';
        widget.render();

        expect(widget.shadowRoot.querySelector('.card-title')?.textContent).toBe('Community WorkBuddy');
        expect(tabButton(widget, 'registry:community')?.classList.contains('active')).toBe(true);
        expect(tabButton(widget, 'registry:official')?.classList.contains('active')).toBe(false);
    });

    test('同一清单项 id 在不同 registry 下的下载状态互不干扰', () => {
        // community 在下同一个 id 的测评集，官方列表里的同名项不能被带成「下载中」
        const widget = createMultiRegistryWidget({
            downloads: [makeDownload({ registryName: 'community', receivedBytes: 50, totalBytes: 200 })]
        });

        expect(statusPill(widget, 'official').className).toContain('pending');
        expect(statusPill(widget, 'official').textContent).toBe('未下载');

        widget.activeTab = 'registry:community';
        widget.render();
        expect(statusPill(widget, 'community').textContent).toBe('下载中 25%');
    });

    test('点另一个 registry 的卡片时按该 registry 定位弹窗', async () => {
        const widget = createMultiRegistryWidget();
        widget.activeTab = 'registry:community';
        widget.render();

        const card = widget.shadowRoot.querySelector('[data-action="open-catalog"]') as HTMLElement;
        card.dispatchEvent(new window.Event('click', { bubbles: true }));
        await Promise.resolve();

        expect(widget.catalogModal).toEqual({ registryName: 'community', catalogId: 'workbuddy-bench' });
    });

    test('清单刷新后弹窗对应条目已下架时关掉弹窗，后台刷新不被挡住', async () => {
        const widget = createWidget();
        widget.catalogModal = { registryName: 'official', catalogId: 'workbuddy-bench' };
        widget.render();
        expect(widget.shadowRoot.querySelector('.modal-overlay')).not.toBeNull();

        // 远端清单更新后这个条目被下架：弹窗没有内容可画，必须自己让位，否则后台刷新全被挡在门外
        callMainWorld = jest.fn(async (method: string) => {
            if (method === 'listCatalogDatasets') return [];
            if (method === 'listDownloads') return [];
            return [];
        });
        (globalThis as any).window.applicationAPI.callMainWorld = callMainWorld;
        await widget.loadCatalog('official', true);

        expect(widget.catalogModal).toBeNull();
        widget.renderUnlessModalOpen();
        expect(widget.shadowRoot.querySelector('.modal-overlay')).toBeNull();
        expect(widget.shadowRoot.querySelector('.empty-state')).not.toBeNull();
    });

    test('registry 列表还没回来时不画半截 Tab 条', () => {
        const widget = createWidget();
        widget.registries = [];
        widget.activeTab = '';
        // 首帧还没拿到任何数据，内容区是加载态
        widget.loading = true;
        widget.render();

        // 此时还不知道有哪些 registry：宁可不画，也别闪一帧「没有一个 Tab 被选中」
        expect(widget.shadowRoot.querySelector('[data-action="tab"]')).toBeNull();
        expect(widget.shadowRoot.querySelector('.loading-state')).not.toBeNull();
    });
});
