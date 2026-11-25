import { beforeAll, expect, jest, test } from '@jest/globals';
import { createRendererTranslator } from '../../../renderer/locale.ts';
import { parseHTML } from 'linkedom';

beforeAll(async () => {
    const { window } = parseHTML('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, {
        window,
        document: window.document,
        HTMLElement: window.HTMLElement,
        CustomEvent: window.CustomEvent,
        customElements: window.customElements
    });
    Object.defineProperty(globalThis, 'navigator', {
        value: { languages: ['zh-CN'], language: 'zh-CN' },
        configurable: true
    });
    jest.unstable_mockModule('../../../../resources/main/applications/recommendation.yaml', () => ({
        default: 'categories: []'
    }));
    await import('../../../renderer/components/recommendation.ts');
    jest.unstable_mockModule('../../../renderer/components/workspacePicker.ts', () => ({
        showWorkspacePicker: jest.fn()
    }));
    await import('../../../renderer/components/homepage.js');
});

test('BM25 renders the existing localized content badge without duplicating semantic content', () => {
    for (const [locale, label] of [
        ['zh-CN', '内容'],
        ['en-US', 'Content']
    ]) {
        for (const matchTypes of [['bm25'], ['bm25', 'content_semantic']]) {
            const panel = document.createElement('recommendation-panel') as any;
            panel._applyDefaultLocale(locale);
            panel.showSearchTab({ query: 'q', results: [{ path: '/docs/a.txt', filename: 'a.txt', matchTypes }] });
            const badges = [...panel.querySelectorAll('.search-badge')].map((node: any) => node.textContent);
            expect(badges.map((x) => x.toLowerCase())).toEqual([label.toLowerCase()]);
        }
    }
});

test('keyword plus BM25 renders one localized filename badge and one content badge', () => {
    for (const [locale, labels] of [
        ['zh-CN', ['文件名', '内容']],
        ['en-US', ['Filename', 'Content']]
    ]) {
        const panel = document.createElement('recommendation-panel') as any;
        panel._applyDefaultLocale(locale);
        panel.showSearchTab({
            query: '文件系统 内存',
            results: [
                {
                    path: '/docs/文件系统设计.txt',
                    filename: '文件系统设计.txt',
                    matchTypes: ['keyword', 'bm25']
                }
            ]
        });
        const badges = [...panel.querySelectorAll('.search-badge')].map((node: any) => node.textContent.toLowerCase());
        expect(badges).toEqual((labels as string[]).map((label) => label.toLowerCase()));
    }
});

test('homepage stages preserve fast order, merge BM25 metadata and obey the limit', async () => {
    const { mergeHomepageSearchStages } = await import('../../../renderer/components/homepage.js');
    const fast = [
        { path: '/a', matchTypes: ['bm25', 'keyword'] },
        { path: '/b', matchTypes: ['bm25'] }
    ];
    const slow = [
        { path: '/c', matchTypes: ['name_semantic'] },
        { path: '/a', matchTypes: ['content_semantic', 'name_semantic', 'unknown'] }
    ];
    const result = mergeHomepageSearchStages(fast, slow, 3);
    expect(result.map((x) => x.path)).toEqual(['/a', '/b', '/c']);
    expect(result[0].matchTypes).toEqual(['keyword', 'bm25', 'name_semantic', 'content_semantic']);
    expect(mergeHomepageSearchStages(fast, slow, 1)).toHaveLength(1);
});

test('homepage warnings use current full-text availability in both locales', () => {
    const page = document.createElement('home-page') as any;
    for (const [locale, oldText, newText] of [
        ['zh-CN', '智能内容搜索未开启，当前只搜索文件名', '智能内容搜索未开启，当前按文件名和文件内容关键词搜索'],
        [
            'en-US',
            'Smart content search is off. Only file names are searched.',
            'Smart content search is off. Searching file names and content keywords.'
        ]
    ]) {
        page._t = createRendererTranslator(locale);
        expect(page._mapSearchWarning({ code: 'EMBED_UNAVAILABLE', fullTextAvailable: true })).toBe(newText);
        expect(page._mapSearchWarning({ code: 'EMBED_UNAVAILABLE', fullTextAvailable: false })).toBe(oldText);
        expect(page._mapSearchWarning({ code: 'EMBED_UNAVAILABLE' })).toBe(oldText);
    }
});

test('homepage requests keyword plus BM25 first and discards stale responses in either stage', async () => {
    const page = document.createElement('home-page') as any;
    const panel = document.createElement('recommendation-panel') as any;
    panel.id = 'home-recommendation';
    page.append(panel);
    const updates: any[] = [];
    panel.updateSearchTab = (state: any) => updates.push(state);
    page.__searchMode = true;
    page.__searchRequestId = 1;
    const calls: any[] = [];
    (window as any).fsAPI = {
        searchIndexedFiles: async (q: any, o: any) => {
            calls.push(o);
            return { results: [{ path: calls.length === 1 ? '/fast' : '/slow', matchTypes: ['bm25'] }] };
        }
    };
    await page._runHomepageSearch('q', 1);
    expect(calls.map((x) => x.routes)).toEqual([
        ['keyword', 'bm25'],
        ['name_semantic', 'content_semantic']
    ]);
    expect(updates.at(-1).results.map((x: any) => x.path)).toEqual(['/fast', '/slow']);
    for (const staleStage of [1, 2]) {
        updates.length = 0;
        page.__searchRequestId = 1;
        let count = 0;
        let release: any;
        (window as any).fsAPI.searchIndexedFiles = async () => {
            count++;
            if (count === staleStage)
                return new Promise((resolve) => {
                    release = resolve;
                });
            return { results: [] };
        };
        const pending = page._runHomepageSearch('old', 1);
        for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
        expect(release).toBeDefined();
        const before = updates.length;
        page.__searchRequestId = 2;
        release({ results: [{ path: '/stale' }] });
        await pending;
        expect(updates).toHaveLength(before);
    }
});
