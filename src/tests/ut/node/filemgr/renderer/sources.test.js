import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { createBanner } from '../../../../../main/applications/filemgr/renderer/banner.js';
import {
    createSources,
    formatDisplayPath,
    formatLastScan
} from '../../../../../main/applications/filemgr/renderer/sources.js';
import {
    __resetForTesting,
    setEntries,
    setDefaultWorkspace,
    setSnapshot as setBackendSnapshot
} from '../../../../../main/applications/filemgr/renderer/state.js';
import { createRendererTranslator } from '../../../../../renderer/locale.ts';

test.beforeEach(__resetForTesting);
test.afterEach(__resetForTesting);
// Arrange the settings selection independently from the backend status fixture.
function setSnapshot(snapshot) {
    setEntries((snapshot.sources ?? []).map((source) => source.entry ?? { root: source.root }));
    setDefaultWorkspace(
        snapshot.default_workspace ??
            snapshot.sources?.find((source) => source.is_workspace || source.workspace)?.root ??
            ''
    );
    setBackendSnapshot(snapshot);
}

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
    assert.equal(card.querySelector('.status-text')?.textContent, '索引完成 · 42 文件');
    assert.equal(card.textContent.match(/42 文件/g)?.length, 1);

    sources.destroy();
});

test('C109 metadata failure occupies only the existing status row and never changes normal-source presentation', () => {
    for (const mode of ['base-only', 'full'])
        for (const total of [0, 3]) {
            const { document } = parseHTML('<html><head></head><body></body></html>');
            setSnapshot({
                status: 'running',
                mode,
                sources: [
                    { root: '/failed', state: 'completed', total_files: total, metadata_write_pending: true },
                    { root: '/healthy', state: 'completed', total_files: 3 }
                ]
            });
            const sources = createSources({ document, t: createRendererTranslator('zh-CN') });
            document.body.append(sources.element);
            const failed = document.querySelector('[data-source-id="/failed"]');
            const healthy = document.querySelector('[data-source-id="/healthy"]');
            assert.equal(
                failed.querySelector('.status-text').textContent,
                '此前部分文件的扫描结果保存失败，等待后续扫描确认恢复。'
            );
            assert.equal(failed.querySelector('.info').children.length, 2);
            assert.equal(failed.querySelector('.fs-mini-ring'), null);
            assert.doesNotMatch(failed.textContent, /已完成|未发现可扫描文件|100%|仍有.*未写入/);
            assert.equal(healthy.querySelector('.status-text').textContent, '索引完成 · 3 文件');
            assert.ok(healthy.querySelector('.fs-mini-ring'));
            assert.equal(healthy.querySelector('.info').children.length, 2);
            const oldHtml = healthy.outerHTML;
            setSnapshot({
                status: 'running',
                mode,
                sources: [{ root: '/healthy', state: 'completed', total_files: 3, metadata_write_pending: false }]
            });
            assert.equal(document.querySelector('[data-source-id="/healthy"]').outerHTML, oldHtml);
            sources.destroy();
        }
});

test('C109 metadata display respects pause/unavailability, locale, missing counts and the current selection', () => {
    const { document } = parseHTML('<html><head></head><body></body></html>');
    setSnapshot({
        status: 'running',
        mode: 'full',
        sources: [
            { root: '/paused', state: 'completed', paused: true, total_files: 3, metadata_write_pending: true },
            { root: '/unavailable', state: 'unavailable', total_files: 3, metadata_write_pending: true },
            { root: '/missing-count', state: 'completed', metadata_write_pending: true }
        ]
    });
    const sources = createSources({ document, t: createRendererTranslator('en-US') });
    document.body.append(sources.element);
    assert.match(document.querySelector('[data-source-id="/paused"] .status-text').textContent, /^Paused/);
    assert.match(
        document.querySelector('[data-source-id="/unavailable"] .status-text').textContent,
        /^Path unavailable/
    );
    const missing = document.querySelector('[data-source-id="/missing-count"]');
    assert.match(missing.textContent, /Some file scan results previously failed to save/);
    assert.doesNotMatch(missing.textContent, /0 files|100|Completed/);
    setEntries([{ root: '/placeholder' }]);
    setBackendSnapshot({ status: 'running', sources: [{ root: '/missing-count', metadata_write_pending: true }] });
    assert.equal(document.querySelector('[data-source-id="/missing-count"]'), null);
    assert.match(document.querySelector('[data-source-id="/placeholder"]').textContent, /Waiting to scan/);
    assert.equal(document.querySelector('.source-control-btn'), null);
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
        ['C:\\Users\\Stella\\Projects\\OpenDesk', '…\\OpenDesk']
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
    const fullTitle = '语义索引 · 123456789/987654321';
    assert.equal(row3?.getAttribute('title'), null);
    assert.equal(status?.textContent, '语义索引 · 123456789/987654321');
    assert.equal(status?.getAttribute('aria-label'), fullTitle);

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
    assert.equal(document.querySelector('.status-text')?.textContent, '等待扫描');

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

test('WF2 source rings and text follow full-text visibility through consecutive updates in both locales', async () => {
    for (const [locale, ft, vec] of [
        ['zh-CN', '关键词索引', '语义索引'],
        ['en-US', 'Keyword index', 'Semantic index']
    ]) {
        const { document, window } = parseHTML('<html><head></head><body></body></html>');
        const source = {
            root: '/wf2',
            state: 'scanning',
            total_files: 10,
            embedded_count: 10,
            pending_count: 0,
            last_scan_at: 1,
            full_text: { total: 10, done: 2, excluded: 1, pending: 6, failed: 1 }
        };
        const snapshot = { status: 'running', mode: 'full', full_text: { available: true }, sources: [source] };
        setSnapshot(snapshot);
        const sources = createSources({ document, t: createRendererTranslator(locale) });
        document.body.append(sources.element);
        const card = document.querySelector('.fs-source-card');
        const check = (count, text, last, title) => {
            assert.equal(document.querySelector('.fs-source-card'), card);
            const ring = card.querySelector('.mini-ring');
            assert.equal(ring.querySelectorAll('.fill').length, count);
            assert.ok(ring.querySelector(`.fill.${last}`));
            assert.equal(card.querySelector('.status-text').getAttribute('aria-label'), title);
            assert.ok(card.querySelector('.status-text').textContent.startsWith(text));
        };
        const bodyTitle = (done) => `${ft} · ${done + 1}/10`;
        const vectorTitle = (done) => `${vec} · ${done}/10`;
        const dualTitle = (body, vector) => `${bodyTitle(body)}\n${vectorTitle(vector)}`;
        check(2, `${ft} · 3/10`, 'full-text', dualTitle(2, 10));
        assert.equal(card.querySelector('.mini-ring title'), null);
        assert.equal(card.querySelector('.status-text').getAttribute('title'), null);
        const mutations = [];
        const observer = new window.MutationObserver((changes) => mutations.push(...changes));
        observer.observe(card, { childList: true, subtree: true, attributes: true });
        setSnapshot(snapshot);
        await Promise.resolve();
        assert.equal(mutations.length, 0, 'unchanged dual-ring snapshot does not mutate DOM');
        observer.disconnect();
        source.full_text = { ...source.full_text, done: 8, pending: 0 };
        source.embedded_count = 4;
        source.pending_count = 6;
        setSnapshot(snapshot);
        check(2, `${vec} · 4/10`, 'vector', dualTitle(8, 4));
        source.full_text = { ...source.full_text, done: 0, pending: 9 };
        snapshot.full_text = { available: false, reason: 'resetting' };
        setSnapshot(snapshot);
        check(2, `${ft} · 1/10`, 'full-text', dualTitle(0, 4));
        for (const state of [
            { available: false, reason: 'open_failed' },
            { available: false, reason: 'unsupported' },
            { available: false, reason: 'tokenizer_unavailable', availability: 'terminal' },
            { available: false, reason: 'tokenizer_unavailable', availability: 'unsupported' },
            undefined
        ]) {
            snapshot.full_text = state;
            setSnapshot(snapshot);
            check(1, `${vec} · 4/10`, 'vector', vectorTitle(4));
        }
        snapshot.full_text = { available: true };
        snapshot.mode = 'base-only';
        setSnapshot(snapshot);
        check(1, `${ft} · 1/10`, 'full-text', bodyTitle(0));
        source.full_text.pending = 0;
        source.state = 'completed';
        setSnapshot(snapshot);
        check(1, locale === 'zh-CN' ? '索引完成 · 10' : 'Index complete · 10', 'full-text', bodyTitle(0));
        assert.equal(card.dataset.progress, '100');
        sources.destroy();
        __resetForTesting();
    }
});

test('WF2 pending and paused sources keep zero progress in both modes', () => {
    for (const mode of ['full', 'base-only']) {
        const { document } = parseHTML('<html><head></head><body></body></html>');
        const source = {
            root: '/wf2',
            state: 'pending',
            total_files: 0,
            embedded_count: 0,
            full_text: { total: 0, done: 0, excluded: 0, pending: 0, failed: 0 }
        };
        const snapshot = { status: 'running', mode, full_text: { available: true }, sources: [source] };
        setSnapshot(snapshot);
        const sources = createSources({ document, t: createRendererTranslator('en-US') });
        document.body.append(sources.element);
        const card = document.querySelector('.fs-source-card');
        assert.equal(card.dataset.progress, '0', `${mode}: initial pending source`);
        assert.equal(Number(card.querySelector('.fill.full-text').style.strokeDashoffset), 37.7);
        Object.assign(source, {
            state: 'scanning',
            paused: true,
            total_files: 10,
            embedded_count: 8,
            full_text: { total: 10, done: 2, excluded: 1, pending: 7, failed: 0 }
        });
        setSnapshot(snapshot);
        assert.equal(card.dataset.progress, '0', `${mode}: paused source`);
        assert.equal(Number(card.querySelector('.fill.full-text').style.strokeDashoffset), 37.7);
        assert.ok(card.querySelector('.status-text').textContent.startsWith('Paused'));
        source.paused = false;
        setSnapshot(snapshot);
        assert.equal(card.dataset.progress, '30', `${mode}: resumed source`);
        sources.destroy();
        __resetForTesting();
    }
});

test('full indexing labels retain both tasks and separate equal-progress rings', () => {
    const { document } = parseHTML('<html><head></head><body></body></html>');
    const source = {
        root: '/large',
        state: 'scanning',
        total_files: 20000,
        embedded_count: 12345,
        last_scan_at: Date.now(),
        full_text: { done: 12340, excluded: 5, pending: 7655 }
    };
    const snapshot = { status: 'running', mode: 'full', full_text: { available: true }, sources: [source] };
    setSnapshot(snapshot);
    const sources = createSources({ document });
    document.body.append(sources.element);
    const card = document.querySelector('.fs-source-card');
    assert.equal(card.querySelector('.status-text').textContent, '关键词索引 · 12345/20000');
    assert.notEqual(
        card.querySelector('.fill.full-text').getAttribute('r'),
        card.querySelector('.fill.vector').getAttribute('r')
    );
    assert.equal(card.querySelectorAll('.track').length, 2);
    assert.ok(card.querySelector('.time-tag'));
    source.embedded_count = 0;
    setSnapshot(snapshot);
    assert.equal(card.querySelectorAll('.track').length, 2, 'zero progress retains its own track');
    assert.equal(card.querySelector('.fill.vector').style.visibility, 'hidden');
    snapshot.mode = 'base-only';
    setSnapshot(snapshot);
    assert.equal(card.querySelector('.status-text').textContent, '关键词索引 · 12345/20000');
    assert.equal(card.querySelectorAll('.track').length, 1);
    source.state = 'completed';
    source.full_text.pending = 0;
    setSnapshot(snapshot);
    assert.equal(card.querySelector('.status-text').textContent, '索引完成 · 20000 文件');
    sources.destroy();
});

test('progress tooltip opens immediately, updates live and cleans up outside the scrolling grid', () => {
    const { document, window } = parseHTML('<html><head></head><body></body></html>');
    const source = {
        root: '/hover',
        state: 'scanning',
        total_files: 100,
        embedded_count: 40,
        full_text: { done: 75, excluded: 5, pending: 20 }
    };
    const snapshot = { status: 'running', mode: 'full', full_text: { available: true }, sources: [source] };
    setSnapshot(snapshot);
    const sources = createSources({ document });
    document.body.append(sources.element);
    const status = document.querySelector('.status-text');
    status.dispatchEvent(new window.Event('pointerover', { bubbles: true }));
    const tip = document.querySelector('[role="tooltip"]');
    assert.ok(tip);
    assert.equal(tip.parentElement, document.body);
    assert.deepEqual(
        [...tip.querySelectorAll('.fs-progress-tooltip-label')].map((n) => n.textContent),
        ['关键词索引 · 80/100', '语义索引 · 40/100']
    );
    assert.equal(status.getAttribute('aria-describedby'), tip.id);
    source.embedded_count = 50;
    setSnapshot(snapshot);
    assert.match(tip.textContent, /语义索引 · 50\/100/);
    status.dispatchEvent(new window.Event('pointerout', { bubbles: true }));
    assert.equal(document.querySelector('[role="tooltip"]'), null);
    status.dispatchEvent(new window.Event('focus', { bubbles: false }));
    assert.ok(document.querySelector('[role="tooltip"]'));
    snapshot.mode = 'base-only';
    setSnapshot(snapshot);
    assert.equal(document.querySelectorAll('.fs-progress-tooltip-label').length, 1);
    sources.destroy();
    assert.equal(document.querySelector('[role="tooltip"]'), null);
});
