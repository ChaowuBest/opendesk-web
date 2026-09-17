import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

// Opt in because the standard Node suite does not require a browser installation.
// OPENDESK_BROWSER_TESTS=1 PLAYWRIGHT_CHANNEL=chrome node --test src/tests/ut/node/renderer/task-search-snippet.test.js
const browserTests = process.env.OPENDESK_BROWSER_TESTS === '1';
test(
    'search snippets keep the first match visible as context and viewport width change',
    { skip: !browserTests },
    async () => {
        await withSearchPage(async (page) => {
            const fixtures = [
                { query: '告诉', text: '… ' + '中文前文'.repeat(12) + '随时告诉我，我会继续调整。' },
                { query: '告诉', text: '告诉我需要修改的地方。' },
                {
                    query: 'foo_bar',
                    text: '… ' + '英文与代码 foo.qux() '.repeat(8) + 'foo_bar <script>literal</script> foo_bar'
                },
                { query: '长搜索词'.repeat(30), text: '… 前文 ' + '长搜索词'.repeat(30) + ' 后文' }
            ];
            for (const fixture of fixtures) {
                await page.evaluate(({ query, text }) => {
                    const globals = window;
                    globals.searchDialog?.destroy();
                    globals.searchDialog = new globals.SearchUI.TaskSearchDialog({
                        getTasks: () => [{ task_id: 'one', task_name: '制作A股PPT' }],
                        search: async () => ({
                            items: [
                                {
                                    taskId: 'one',
                                    title: '制作A股PPT',
                                    workspace: '',
                                    messageId: 'm1',
                                    snippet: text,
                                    priority: 0
                                }
                            ],
                            hasMore: false,
                            indexing: false,
                            revision: 1,
                            failedTasks: 0
                        }),
                        subscribe: () => () => {},
                        open: async () => {},
                        translate: (key) => key
                    });
                    globals.searchDialog.show();
                    const input = document.querySelector('dialog input');
                    input.value = query;
                    input.dispatchEvent(new Event('input'));
                }, fixture);
                const snippet = page.locator('.od-task-search-snippet');
                await snippet.locator('mark').first().waitFor();
                assert.equal(await snippet.textContent(), fixture.text);
                assert.equal(await snippet.locator('script').count(), 0);
                for (const width of [1266, 390, 240, 1266]) {
                    await page.setViewportSize({ width, height: 768 });
                    if (process.env.OPENDESK_SEARCH_SCREENSHOT && fixture === fixtures[0] && width === 390) {
                        await page.screenshot({ path: process.env.OPENDESK_SEARCH_SCREENSHOT });
                    }
                    const bounds = await snippet.evaluate((element) => {
                        const mark = element.querySelector('mark');
                        const box = element.getBoundingClientRect();
                        const hit = mark.getBoundingClientRect();
                        const range = document.createRange();
                        range.selectNodeContents(mark);
                        const prefix = element.querySelector('.od-task-search-snippet-before');
                        const prefixText = prefix?.querySelector('bdi')?.firstChild;
                        let prefixTailVisible = true;
                        let prefixDebug;
                        if (prefixText?.textContent && prefix.getBoundingClientRect().width > 20) {
                            const tail = document.createRange();
                            tail.setStart(prefixText, prefixText.textContent.length - 1);
                            tail.setEnd(prefixText, prefixText.textContent.length);
                            const tailBox = tail.getBoundingClientRect();
                            const prefixBox = prefix.getBoundingClientRect();
                            prefixDebug = { tail: tailBox.toJSON(), box: prefixBox.toJSON() };
                            prefixTailVisible =
                                tailBox.left >= prefixBox.left - 1 && tailBox.right <= prefixBox.right + 1;
                        }
                        return {
                            left: box.left,
                            right: box.right,
                            hitLeft: hit.left,
                            hitRight: hit.right,
                            prefixTailVisible,
                            prefixDebug,
                            hitWidth: hit.width,
                            textWidth: range.getBoundingClientRect().width
                        };
                    });
                    assert.ok(bounds.hitWidth > 0, 'the match must have visible space');
                    assert.ok(
                        bounds.prefixTailVisible,
                        `keep prefix near ${fixture.query} at ${width}: ${JSON.stringify(bounds)}`
                    );
                    assert.ok(
                        bounds.hitLeft >= bounds.left - 1 && bounds.hitRight <= bounds.right + 1,
                        `match clipped at viewport ${width}: ${JSON.stringify(bounds)}`
                    );
                    if (fixture.query.length < 20) {
                        assert.ok(bounds.textWidth <= bounds.hitWidth + 1, 'short matches must be fully visible');
                    }
                }
            }
        });
    }
);

async function withSearchPage(run) {
    const root = new URL('../../../../../', import.meta.url);
    const entry = new URL('src/renderer/components/taskSearchDialog.ts', root);
    const bundled = await build({
        entryPoints: [fileURLToPath(entry)],
        bundle: true,
        format: 'iife',
        globalName: 'SearchUI',
        outfile: 'task-search-browser.js',
        write: false
    });
    const script = bundled.outputFiles.find((file) => file.path.endsWith('.js')).text;
    const css = bundled.outputFiles.find((file) => file.path.endsWith('.css')).text;
    const common = await readFile(new URL('src/renderer/styles/common.css', root), 'utf8');
    const fontTokens = common.match(/:root\s*\{[^}]+\}/)?.[0] || '';
    const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
    try {
        const page = await browser.newPage({ viewport: { width: 1266, height: 768 } });
        await page.setContent('<!doctype html><html><body></body></html>');
        await page.addStyleTag({
            content: '* { box-sizing: border-box; } body { font-family: sans-serif; }' + fontTokens + css
        });
        await page.addScriptTag({ content: script });
        await run(page);
    } finally {
        await browser.close();
    }
}

test('show more scrolls after the last row and expands to the cap in one click', { skip: !browserTests }, async () => {
    await withSearchPage(async (page) => {
        await page.evaluate(() => {
            const hits = Array.from({ length: 205 }, (_, i) => ({
                taskId: String(i),
                title: '历史任务 ' + i,
                workspace: 'work',
                messageId: 'm1',
                snippet: 'open 正文匹配',
                priority: 0
            }));
            const dialog = new window.SearchUI.TaskSearchDialog({
                getTasks: () => hits.map((hit) => ({ task_id: hit.taskId, task_name: hit.title })),
                search: async (_query, limit) => ({
                    items: hits.slice(0, limit),
                    hasMore: hits.length > limit,
                    indexing: false,
                    revision: 1,
                    failedTasks: 0
                }),
                subscribe: () => () => {},
                open: async () => {},
                translate: (key) => key
            });
            dialog.show();
        });
        await page.locator('dialog input').fill('open');
        const more = page.locator('.od-task-search-more');
        await more.waitFor({ state: 'visible' });
        const before = await more.evaluate((button) => {
            const scroll = document.querySelector('.od-task-search-scroll');
            const last = document.querySelector('.od-task-search-results').lastElementChild;
            return {
                inScroller: scroll?.contains(button),
                afterLastRow: button.getBoundingClientRect().top >= last.getBoundingClientRect().bottom,
                belowViewport: button.getBoundingClientRect().top >= scroll?.getBoundingClientRect().bottom,
                top: document.querySelector('dialog').getBoundingClientRect().top
            };
        });
        assert.equal(before.inScroller, true);
        assert.equal(before.afterLastRow, true);
        assert.equal(before.belowViewport, true, 'button must not be a fixed footer');
        const scroller = page.locator('.od-task-search-scroll');
        await scroller.hover();
        await page.mouse.wheel(0, 300);
        await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        await page.evaluate(() => document.dispatchEvent(new Event('task-list-updated')));
        await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        await page.mouse.wheel(0, 2000);
        await expect(more).toBeInViewport();
        const scrollTop = await page.locator('.od-task-search-scroll').evaluate((el) => el.scrollTop);
        assert.ok(scrollTop > 0);
        await more.click();
        await more.waitFor({ state: 'hidden' });
        assert.equal(await page.locator('[data-task-id]').count(), 200);
        assert.equal(await page.locator('dialog').evaluate((el) => el.getBoundingClientRect().top), before.top);
        assert.equal(await page.locator('.od-task-search-scroll').evaluate((el) => el.scrollTop), scrollTop);
        const status = page.locator('.od-task-search-status');
        assert.equal(await status.textContent(), 'renderer.taskSearch.refine');
        const hintPosition = await status.evaluate((el) => ({
            insideScroll: document.querySelector('.od-task-search-scroll').contains(el),
            afterLast:
                el.getBoundingClientRect().top >=
                document.querySelector('[data-task-id="199"]').getBoundingClientRect().bottom
        }));
        assert.deepEqual(hintPosition, { insideScroll: true, afterLast: true });
        await scroller.hover();
        await page.mouse.wheel(0, 20000);
        await expect(status).toBeInViewport();
        assert.equal(await page.locator('.od-task-search-more:not([hidden])').count(), 0);
    });
});
