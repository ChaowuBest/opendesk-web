import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

// OPENDESK_BROWSER_TESTS=1 PLAYWRIGHT_CHANNEL=chrome node --test src/tests/ut/node/renderer/task-search-snippet.test.js
// A real browser is needed for clipping, wheel input and scroll position assertions.
test(
    'search highlights stay visible and the scrolling footer expands to 200 results',
    {
        skip: process.env.OPENDESK_BROWSER_TESTS !== '1'
    },
    async () => {
        const root = new URL('../../../../../', import.meta.url);
        const bundled = await build({
            entryPoints: [fileURLToPath(new URL('src/renderer/components/taskSearchDialog.ts', root))],
            bundle: true,
            format: 'iife',
            globalName: 'SearchUI',
            outfile: 'search.js',
            write: false
        });
        const common = await readFile(new URL('src/renderer/styles/common.css', root), 'utf8');
        const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
        try {
            const page = await browser.newPage({ viewport: { width: 1266, height: 768 } });
            await page.setContent('<!doctype html><html><body></body></html>');
            await page.addStyleTag({
                content:
                    '* { box-sizing: border-box; }' +
                    common.match(/:root\s*\{[^}]+\}/)[0] +
                    bundled.outputFiles.find((file) => file.path.endsWith('.css')).text
            });
            await page.addScriptTag({ content: bundled.outputFiles.find((file) => file.path.endsWith('.js')).text });
            await page.evaluate(() => {
                const hits = Array.from({ length: 205 }, (_, i) => ({
                    taskId: String(i),
                    title: '历史任务 ' + i,
                    workspace: 'work',
                    messageId: 'm1',
                    snippet: '… ' + '中文前文'.repeat(12) + '随时告诉我 <script>literal</script>',
                    priority: 0
                }));
                new window.SearchUI.TaskSearchDialog({
                    getTasks: () => hits.map((hit) => ({ task_id: hit.taskId, task_name: hit.title })),
                    search: async (_query, limit) => ({
                        items: hits.slice(0, limit),
                        hasMore: hits.length > limit,
                        indexing: false,
                        failedTasks: 0
                    }),
                    subscribe: () => () => {},
                    open: async () => {},
                    translate: (key) => key
                }).show();
            });
            await page.locator('dialog input').fill('告诉');
            const rows = page.locator('[data-task-id]');
            await expect(rows).toHaveCount(20);
            const snippet = rows.first().locator('.od-task-search-snippet');
            for (const width of [390, 1266]) {
                await page.setViewportSize({ width, height: 768 });
                const bounds = await snippet.evaluate((el) => {
                    const hit = el.querySelector('mark').getBoundingClientRect();
                    const row = el.getBoundingClientRect();
                    return {
                        visible: hit.width > 0 && hit.left >= row.left && hit.right <= row.right,
                        text: el.textContent
                    };
                });
                assert.equal(bounds.visible, true);
                assert.ok(bounds.text.includes('告诉我 <script>literal</script>'));
                assert.equal(await snippet.locator('script').count(), 0);
            }
            const scroller = page.locator('.od-task-search-scroll');
            const more = page.locator('.od-task-search-more');
            await expect(more).not.toBeInViewport();
            await scroller.hover();
            await page.mouse.wheel(0, 300);
            await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
            await page.evaluate(() => document.dispatchEvent(new Event('task-list-updated')));
            await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
            await page.mouse.wheel(0, 2000);
            await expect(more).toBeInViewport();
            const scrollTop = await scroller.evaluate((el) => el.scrollTop);
            const top = await page.locator('dialog').evaluate((el) => el.getBoundingClientRect().top);
            await more.click();
            await expect(rows).toHaveCount(200);
            await expect(more).toBeHidden();
            assert.equal(await scroller.evaluate((el) => el.scrollTop), scrollTop);
            assert.equal(await page.locator('dialog').evaluate((el) => el.getBoundingClientRect().top), top);
            const status = page.locator('.od-task-search-status');
            await expect(status).toHaveText('renderer.taskSearch.refine');
            await expect(status).not.toBeInViewport();
            await scroller.hover();
            await page.mouse.wheel(0, 20000);
            await expect(status).toBeInViewport();
            await page.locator('dialog input').fill('正文');
            await expect(rows).toHaveCount(20);
            await expect(status).toBeEmpty();
        } finally {
            await browser.close();
        }
    }
);
