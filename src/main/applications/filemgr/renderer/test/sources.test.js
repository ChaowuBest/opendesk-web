/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { createSources, formatDisplayPath, formatLastScan } from '../sources.js';
import { setSnapshot } from '../state.js';

test('formatLastScan only shows just now for scans within one minute', (t) => {
    const now = 1_700_000_000_000;
    t.mock.method(Date, 'now', () => now);

    assert.equal(formatLastScan(now - 59 * 1000), '刚刚');
    assert.equal(formatLastScan(now - 90 * 1000), '1 分钟前');
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

    document.querySelector('.close-btn')?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));

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

    document.querySelector('.close-btn')?.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));

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
