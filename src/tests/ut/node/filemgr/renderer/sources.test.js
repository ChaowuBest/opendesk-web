import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { createBanner } from '../../../../../main/applications/filemgr/renderer/banner.js';
import {
    createSources,
    formatDisplayPath,
    formatLastScan
} from '../../../../../main/applications/filemgr/renderer/sources.js';
import { setSnapshot } from '../../../../../main/applications/filemgr/renderer/state.js';
import { createRendererTranslator } from '../../../../../renderer/locale.ts';

test('formatLastScan only shows just now for scans within one minute', (t) => {
    const now = 1_700_000_000_000;
    t.mock.method(Date, 'now', () => now);

    assert.equal(formatLastScan(now - 59 * 1000), '刚刚');
    assert.equal(formatLastScan(now - 90 * 1000), '1 分钟前');
});

test('filemgr foreground status surfaces avoid persistent paint animations', () => {
    const { document } = parseHTML('<!doctype html><html><head></head><body></body></html>');

    const banner = createBanner({ document });
    const sources = createSources({ document });

    const bannerStyles = document.querySelector('#filemgr-banner-styles')?.textContent ?? '';
    const sourceStyles = document.querySelector('#filemgr-sources-styles')?.textContent ?? '';

    assert.doesNotMatch(bannerStyles, /filemgr-od-pulse[\s\S]*infinite/);
    assert.doesNotMatch(bannerStyles, /filemgr-od-alert-pulse[\s\S]*infinite/);
    assert.doesNotMatch(sourceStyles, /filemgr-source-shimmer[\s\S]*infinite/);
    assert.match(
        sourceStyles,
        /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.fs-upper \.source-control-spinner\s*\{\s*animation: none;/
    );

    banner.destroy();
    sources.destroy();
});

test('source card renders compact base-only status without badges or duplicate file count', () => {
    const { document } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    setSnapshot({
        status: 'running',
        mode: 'base-only',
        sources: [
            {
                root: '/Users/example/work',
                state: 'completed',
                total_files: 42,
                embedded_count: 0,
                pending_count: 42,
                last_scan_at: Date.now()
            }
        ]
    });

    const sources = createSources({ document });
    document.body.appendChild(sources.element);

    const card = document.querySelector('.fs-source-card');
    assert.ok(card);
    assert.equal(card.querySelector('.tag'), null);
    assert.equal(card.textContent.includes('SOURCE'), false);
    assert.equal(card.textContent.includes('WORKSPACE'), false);
    assert.equal(card.textContent.includes('普通目录'), false);
    assert.equal(card.textContent.includes('工作区目录'), false);
    assert.equal(card.querySelector('.status-text')?.textContent, '基础索引 · 42 文件');
    assert.equal(card.textContent.match(/42 文件/g)?.length, 1);

    sources.destroy();
});

test('source card shows file-level understanding failure alert', () => {
    const { document } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    setSnapshot({
        status: 'running',
        mode: 'full',
        sources: [
            {
                root: '/Users/example/work',
                state: 'completed',
                total_files: 42,
                embedded_count: 40,
                pending_count: 0,
                failed_count: 2,
                last_scan_at: Date.now()
            }
        ]
    });

    const sources = createSources({ document });
    document.body.appendChild(sources.element);

    const alert = document.querySelector('.fs-file-alert');
    assert.ok(alert);
    assert.equal(alert.textContent, '2');
    assert.equal(alert.getAttribute('aria-label'), '2 个文件无法理解');
    assert.equal(alert.getAttribute('title'), '2 个文件太大或格式不适合智能理解，仍可通过文件名找到。');

    sources.destroy();
});

test('formatDisplayPath keeps stable user-facing path text', () => {
    const cases = [
        ['', '未命名数据源'],
        ['/Users/liumingxing/test', '/Users/liumingxing/test'],
        ['/Users/liumingxing/claude-code-main', '…/claude-code-main'],
        ['/Users/liumingxing/刘明星-毕设', '…/刘明星-毕设'],
        ['/Users/liumingxing/Papers/学长学姐论文/孟菲毕业设计', '…/孟菲毕业设计'],
        ['C:\\Users\\Stella\\Projects\\FillipDesk', '…\\FillipDesk']
    ];

    for (const [input, expected] of cases) {
        assert.equal(formatDisplayPath(input), expected);
    }

    const display = formatDisplayPath('/Users/liumingxing/刘明星-毕设-非常非常长的目录名-最终版');

    assert.equal(display.startsWith('…/刘明星-毕设'), true);
    assert.equal(display.endsWith('最终版'), true);
    assert.equal(display.includes('…最终版'), true);
    assert.equal(display.includes('非常非常长的目录名-最终版'), false);
});

test('source card protects long path and status text while exposing full titles', () => {
    const longPath = '/Users/liumingxing/Papers/学长学姐论文/孟菲毕业设计';
    const { document } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    setSnapshot({
        status: 'running',
        mode: 'full',
        sources: [
            {
                root: longPath,
                state: 'scanning',
                total_files: 987654321,
                embedded_count: 123456789,
                pending_count: 864197532,
                last_scan_at: Date.now()
            }
        ]
    });

    const sources = createSources({ document });
    document.body.appendChild(sources.element);
    const path = document.querySelector('.path');
    const row3 = document.querySelector('.row3');
    const status = document.querySelector('.status-text');

    assert.equal(path?.textContent, '…/孟菲毕业设计');
    assert.equal(path?.getAttribute('title'), longPath);
    assert.equal(row3?.getAttribute('title'), '扫描中 · 123456789 / 987654321 文件');
    assert.equal(status?.textContent, '扫描中 · 123456789 / 987654321 文件');
    assert.equal(status?.getAttribute('title'), '扫描中 · 123456789 / 987654321 文件');

    sources.destroy();
});

test('source card shows empty result when completed scan finds no scannable files', () => {
    const root = '/Users/example/empty-source';
    const { document } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    setSnapshot({
        status: 'running',
        mode: 'full',
        sources: [
            {
                root,
                state: 'completed',
                total_files: 0,
                embedded_count: 0,
                pending_count: 0,
                last_scan_at: Date.now()
            }
        ]
    });

    const sources = createSources({ document });
    document.body.appendChild(sources.element);

    assert.equal(document.querySelector('.status-text')?.textContent, '未发现可扫描文件');

    sources.destroy();
});

test('source card remains deletable while filemgr is in error state', () => {
    const root = '/Users/example/broken-source';
    const { document, window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    setSnapshot({
        status: 'error',
        mode: 'base-only',
        sources: [
            {
                root,
                state: 'pending',
                total_files: 0,
                last_scan_at: null
            }
        ]
    });
    const deleteRequests = [];

    const sources = createSources({
        document,
        onRequestDeleteRoot: (_source, normalizedSource) => deleteRequests.push(normalizedSource.path)
    });
    document.body.appendChild(sources.element);

    const grid = document.querySelector('.fs-sources');
    const sourceStyles = document.querySelector('#filemgr-sources-styles')?.textContent ?? '';
    assert.equal(grid?.classList.contains('fs-error-layer'), true);
    assert.equal(/fs-error-layer[\s\S]*pointer-events\s*:\s*none/.test(sourceStyles), false);

    document
        .querySelector('.source-menu-remove')
        ?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));

    assert.deepEqual(deleteRequests, [root]);

    sources.destroy();
});

test('initializing source list renders real sources when snapshot already contains them', () => {
    const root = '/Users/example/waiting-source';
    const { document } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    setSnapshot({
        status: 'initializing',
        mode: 'base-only',
        sources: [
            {
                root,
                state: 'pending',
                total_files: 0,
                last_scan_at: null
            }
        ]
    });

    const sources = createSources({ document });
    document.body.appendChild(sources.element);

    assert.equal(document.querySelectorAll('.fs-source-card.skeleton').length, 0);
    assert.equal(document.querySelector('.path')?.getAttribute('title'), root);
    assert.equal(document.querySelector('.status-text')?.textContent, '基础索引 · 0 文件');

    sources.destroy();
});

test('workspace source delete button shows protected message instead of requesting deletion', () => {
    const workspaceRoot = '/Users/example/work';
    const { document, window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    const originalCustomEvent = globalThis.CustomEvent;
    globalThis.CustomEvent = window.CustomEvent;
    setSnapshot({
        status: 'running',
        mode: 'base-only',
        default_workspace: workspaceRoot,
        sources: [
            {
                root: workspaceRoot,
                state: 'completed',
                total_files: 42,
                last_scan_at: Date.now(),
                is_workspace: true
            }
        ]
    });
    const protectedRequests = [];
    const deleteRequests = [];

    const sources = createSources({
        document,
        onProtectedWorkspaceDelete: (payload) => protectedRequests.push(payload),
        onRequestDeleteRoot: (_source, normalizedSource) => deleteRequests.push(normalizedSource)
    });
    document.body.appendChild(sources.element);

    document
        .querySelector('.source-menu-remove')
        ?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));

    assert.deepEqual(deleteRequests, []);
    assert.deepEqual(protectedRequests, [
        {
            root: workspaceRoot,
            message: '当前工作空间不能在这里移除。请回到主页面切换工作空间。'
        }
    ]);

    sources.destroy();
    globalThis.CustomEvent = originalCustomEvent;
});

test('source card keeps routine actions in a localized overflow menu and paused recovery in the status row', () => {
    const { document, window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    setSnapshot({
        status: 'running',
        mode: 'full',
        sources: [
            {
                root: '/Users/example/active',
                paused: false,
                state: 'completed',
                total_files: 4,
                last_scan_at: Date.now()
            },
            {
                root: '/Users/example/paused',
                paused: true,
                state: 'paused',
                total_files: 2,
                last_scan_at: Date.now()
            }
        ]
    });
    const sources = createSources({ document, t: createRendererTranslator('en-US') });
    document.body.appendChild(sources.element);

    const cards = document.querySelectorAll('.fs-source-card');
    const activeMenu = cards[0].querySelector('.filemgr-source-menu-portal');
    const activeTrigger = cards[0].querySelector('.source-menu-trigger');
    assert.equal(activeTrigger?.getAttribute('aria-label'), 'More actions: /Users/example/active');
    assert.equal(activeTrigger?.getAttribute('aria-expanded'), 'false');
    assert.equal(activeMenu?.hidden, true);
    assert.equal(activeMenu?.querySelector('.source-control-btn')?.textContent, 'Pause scanning');
    assert.equal(activeMenu?.querySelector('.source-menu-remove')?.textContent, 'Remove scan path');
    assert.equal(cards[0].querySelector('.row3 .source-control-btn'), null);

    activeTrigger?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    assert.equal(activeTrigger?.getAttribute('aria-expanded'), 'true');
    assert.equal(activeMenu?.hidden, false);
    assert.equal(activeMenu?.parentElement, document.body);
    assert.equal(activeMenu?.style.top, '8px');
    assert.equal(activeMenu?.style.left, '8px');

    assert.equal(cards[1].querySelector('.filemgr-source-menu-portal .source-control-btn'), null);
    assert.equal(cards[1].querySelector('.row3 .source-control-btn')?.textContent, 'Continue scanning');
    assert.equal(cards[1].querySelector('.source-menu-remove')?.textContent, 'Remove scan path');

    document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    assert.equal(activeTrigger?.getAttribute('aria-expanded'), 'false');
    assert.equal(activeMenu?.hidden, true);
    assert.equal(activeMenu?.parentElement, cards[0].querySelector('.source-actions'));

    sources.destroy();
});

test('source pause control stays card-local and waits for backend snapshot', async (t) => {
    const root = '/Users/example/docs';
    const otherRoot = '/Users/example/other';
    const { document, window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    setSnapshot({
        status: 'running',
        mode: 'full',
        sources: [
            { root, paused: false, state: 'completed', total_files: 4, last_scan_at: Date.now() },
            { root: otherRoot, paused: false, state: 'completed', total_files: 2, last_scan_at: Date.now() }
        ]
    });
    let resolveRequest;
    const calls = [];
    const sources = createSources({
        document,
        t: (key) =>
            ({
                'renderer.filemgr.source.pause': 'Pause',
                'renderer.filemgr.source.pausing': 'Pausing…'
            })[key] ?? key,
        onSetSourcePaused: async (request) => {
            calls.push(request);
            await new Promise((resolve) => {
                resolveRequest = resolve;
            });
            setSnapshot({
                status: 'running',
                mode: 'full',
                sources: [
                    { root, paused: true, state: 'paused', total_files: 4, last_scan_at: Date.now() },
                    { root: otherRoot, paused: false, state: 'completed', total_files: 2, last_scan_at: Date.now() }
                ]
            });
        }
    });
    t.after(async () => {
        resolveRequest?.();
        await Promise.resolve();
        await Promise.resolve();
        sources.destroy();
    });
    document.body.appendChild(sources.element);
    const cards = document.querySelectorAll('.fs-source-card');
    const firstControl = cards[0].querySelector('.source-control-btn');

    assert.equal(firstControl?.textContent, 'Pause');
    firstControl?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();

    assert.deepEqual(calls, [{ root, paused: true }]);
    const pendingCards = document.querySelectorAll('.fs-source-card');
    assert.equal(pendingCards[0].getAttribute('aria-busy'), 'true');
    assert.equal(pendingCards[1].getAttribute('aria-busy'), 'false');
    assert.equal(pendingCards[0].querySelector('.source-control-btn')?.disabled, true);
    assert.equal(pendingCards[0].querySelector('.source-control-btn')?.getAttribute('aria-busy'), 'true');
    assert.equal(pendingCards[0].querySelector('.source-menu-remove')?.disabled, true);
    assert.equal(document.querySelectorAll('.fs-source-card')[1].querySelector('.source-control-btn')?.disabled, false);
    assert.equal(document.querySelectorAll('.fs-source-card')[1].querySelector('.source-menu-remove')?.disabled, false);
    assert.equal(document.querySelector('.fs-source-card')?.dataset.state, 'completed');
    assert.match(document.querySelector('.fs-source-card')?.textContent ?? '', /Pausing/);
    pendingCards[0]
        .querySelector('.source-control-btn')
        ?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    assert.deepEqual(calls, [{ root, paused: true }]);

    resolveRequest();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(document.querySelector('.fs-source-card')?.dataset.state, 'paused');
    assert.equal(document.querySelector('.source-control-spinner'), null);
});

test('source resume pending stays confirmed and card-local', async (t) => {
    const root = '/Users/example/paused';
    const otherRoot = '/Users/example/runnable';
    const { document, window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    setSnapshot({
        status: 'running',
        mode: 'full',
        sources: [
            { root, paused: true, state: 'paused', total_files: 4, last_scan_at: Date.now() },
            { root: otherRoot, paused: false, state: 'completed', total_files: 2, last_scan_at: Date.now() }
        ]
    });
    let resolveRequest;
    const calls = [];
    const sources = createSources({
        document,
        t: createRendererTranslator('en-US'),
        onSetSourcePaused: (request) => {
            calls.push(request);
            return new Promise((resolve) => {
                resolveRequest = resolve;
            });
        }
    });
    t.after(async () => {
        resolveRequest?.();
        await Promise.resolve();
        await Promise.resolve();
        sources.destroy();
    });
    document.body.appendChild(sources.element);

    document
        .querySelector('.source-control-btn')
        ?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();

    assert.deepEqual(calls, [{ root, paused: false }]);
    assert.equal(document.querySelector('.fs-source-card')?.dataset.state, 'paused');
    assert.equal(document.querySelector('.fs-source-card')?.getAttribute('aria-busy'), 'true');
    assert.match(document.querySelector('.fs-source-card')?.textContent ?? '', /Resuming/);
    assert.equal(document.querySelector('.source-control-btn')?.getAttribute('aria-busy'), 'true');
    assert.equal(document.querySelector('.source-menu-remove')?.disabled, true);
    assert.equal(document.querySelectorAll('.fs-source-card')[1].querySelector('.source-control-btn')?.disabled, false);
    assert.equal(document.querySelectorAll('.fs-source-card')[1].querySelector('.source-menu-remove')?.disabled, false);

    resolveRequest();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(document.querySelector('.source-control-spinner'), null);
});

test('source pause failure settles spinner and keeps confirmed state retryable', async (t) => {
    const root = '/Users/example/failing';
    const { document, window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    setSnapshot({
        status: 'running',
        mode: 'full',
        sources: [{ root, paused: false, state: 'completed', total_files: 4, last_scan_at: Date.now() }]
    });
    let attempts = 0;
    let resolveRetry;
    const sources = createSources({
        document,
        onSetSourcePaused: async () => {
            attempts++;
            if (attempts === 2) {
                await new Promise((resolve) => {
                    resolveRetry = resolve;
                });
                return;
            }
            const error = new Error('failed');
            error.code = 'persistence_failed';
            throw error;
        }
    });
    t.after(async () => {
        resolveRetry?.();
        await Promise.resolve();
        await Promise.resolve();
        sources.destroy();
    });
    document.body.appendChild(sources.element);

    document
        .querySelector('.source-control-btn')
        ?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(attempts, 1);
    assert.equal(document.querySelector('.fs-source-card')?.dataset.state, 'completed');
    assert.equal(document.querySelector('.source-control-spinner'), null);
    assert.equal(document.querySelector('.source-control-btn')?.disabled, false);
    assert.match(document.querySelector('.fs-source-control-error')?.textContent ?? '', /saved|保存/);

    document
        .querySelector('.source-control-btn')
        ?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    assert.equal(attempts, 2);
    assert.equal(document.querySelector('.fs-source-control-error'), null);
    assert.ok(document.querySelector('.source-control-spinner'));
    resolveRetry();
    await Promise.resolve();
    await Promise.resolve();
});

test('source pause controls use real Chinese and English translations', (t) => {
    for (const [locale, expected] of [
        ['zh-CN', ['继续扫描', '已暂停 · 4 个文件']],
        ['en-US', ['Continue scanning', 'Paused · 4 files']]
    ]) {
        const { document } = parseHTML('<!doctype html><html><head></head><body></body></html>');
        setSnapshot({
            status: 'running',
            mode: 'full',
            sources: [
                {
                    root: `/Users/example/${locale}`,
                    paused: true,
                    state: 'paused',
                    total_files: 4,
                    last_scan_at: Date.now()
                }
            ]
        });
        const sources = createSources({ document, t: createRendererTranslator(locale) });
        t.after(() => sources.destroy());
        document.body.appendChild(sources.element);
        const control = document.querySelector('.source-control-btn');
        assert.equal(control?.textContent, expected[0]);
        assert.equal(control?.dataset.action, 'resume');
        assert.equal(control?.getAttribute('aria-label'), expected[0]);
        assert.equal(control?.getAttribute('title'), expected[0]);
        assert.ok(control?.querySelector('.source-control-icon'));
        assert.equal(document.querySelector('.status-text')?.textContent, expected[1]);
    }
});

test('real translator covers pause resume pending paused and retryable error text', async (t) => {
    const root = '/Users/example/localized-control';
    const { document, window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    setSnapshot({
        status: 'running',
        mode: 'full',
        sources: [{ root, paused: false, state: 'completed', total_files: 4, last_scan_at: Date.now() }]
    });
    let attempt = 0;
    let releasePause;
    let releaseResume;
    const sources = createSources({
        document,
        t: createRendererTranslator('en-US'),
        onSetSourcePaused: async ({ paused }) => {
            attempt++;
            if (paused) {
                await new Promise((resolve) => {
                    releasePause = resolve;
                });
                setSnapshot({
                    status: 'running',
                    mode: 'full',
                    sources: [{ root, paused: true, state: 'paused', total_files: 4, last_scan_at: Date.now() }]
                });
                return;
            }
            await new Promise((resolve) => {
                releaseResume = resolve;
            });
            const error = new Error('runtime');
            error.code = 'runtime_failed';
            throw error;
        }
    });
    t.after(async () => {
        releasePause?.();
        releaseResume?.();
        await Promise.resolve();
        await Promise.resolve();
        sources.destroy();
    });
    document.body.appendChild(sources.element);
    assert.equal(document.querySelector('.source-control-btn')?.textContent, 'Pause scanning');

    document
        .querySelector('.source-control-btn')
        ?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    assert.match(document.querySelector('.status-text')?.textContent ?? '', /Pausing/);
    releasePause();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(document.querySelector('.source-control-btn')?.textContent, 'Continue scanning');
    assert.equal(document.querySelector('.status-text')?.textContent, 'Paused · 4 files');

    document
        .querySelector('.source-control-btn')
        ?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    assert.match(document.querySelector('.status-text')?.textContent ?? '', /Resuming/);
    releaseResume();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(attempt, 2);
    assert.equal(
        document.querySelector('.fs-source-control-error')?.textContent,
        'The pause or resume operation failed. Retry.'
    );
});

test('different source cards can remain pending concurrently', async (t) => {
    const roots = ['/Users/example/one', '/Users/example/two'];
    const { document, window } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    setSnapshot({
        status: 'running',
        mode: 'full',
        sources: roots.map((root) => ({
            root,
            paused: false,
            state: 'completed',
            total_files: 1,
            last_scan_at: Date.now()
        }))
    });
    const resolvers = new Map();
    const calls = [];
    const sources = createSources({
        document,
        onSetSourcePaused: (request) => {
            calls.push(request);
            return new Promise((resolve) => resolvers.set(request.root, resolve));
        }
    });
    t.after(async () => {
        for (const resolve of resolvers.values()) resolve();
        await Promise.resolve();
        await Promise.resolve();
        sources.destroy();
    });
    document.body.appendChild(sources.element);
    const controls = document.querySelectorAll('.source-control-btn');
    controls[0].dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    document
        .querySelectorAll('.source-control-btn')[1]
        .dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();

    assert.deepEqual(
        calls,
        roots.map((root) => ({ root, paused: true }))
    );
    assert.equal(document.querySelectorAll('.source-control-spinner').length, 2);
    resolvers.get(roots[0])();
    resolvers.get(roots[1])();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(document.querySelectorAll('.source-control-spinner').length, 0);
});
