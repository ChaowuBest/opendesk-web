import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// OPENDESK_BROWSER_TESTS=1 PLAYWRIGHT_CHANNEL=chrome node --test src/tests/ut/node/renderer/overlay.test.js
test(
    'shared backdrops cover the viewport or panel shell, including Shadow DOM and native dialogs',
    {
        skip: process.env.OPENDESK_BROWSER_TESTS !== '1'
    },
    async () => {
        const bundle = await build({
            stdin: {
                contents:
                    "export * from './src/renderer/components/overlay.js'; export { showConfirmModal } from './src/renderer/components/confirmModal.js';",
                resolveDir: process.cwd()
            },
            bundle: true,
            format: 'iife',
            globalName: 'Overlay',
            write: false
        });
        const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
        try {
            const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
            await page.setContent(`<style>
            body { margin: 0; }
            section { margin: 40px; width: 300px; height: 180px; border-radius: 12px; }
            .content { height: 100%; overflow: auto; }
            .content > div { height: 1000px; }
        </style><section><div class="content"><div>Scrollable content</div></div></section>`);
            await page.addScriptTag({ content: bundle.outputFiles[0].text });
            const result = await page.evaluate(async () => {
                const rect = (el) => {
                    const { x, y, width, height } = el.getBoundingClientRect();
                    return { x, y, width, height };
                };
                const full = window.Overlay.createOverlay();
                const viewport = rect(full.element);
                full.dispose();
                const target = document.querySelector('section');
                const local = window.Overlay.createOverlay({ target });
                const before = rect(local.element);
                target.querySelector('.content').scrollTop = 200;
                const after = rect(local.element);
                const radius = getComputedStyle(local.element).borderRadius;
                local.dispose();

                const confirm = window.Overlay.showConfirmModal({
                    target,
                    title: 'Local dialog',
                    message: 'Body',
                    animate: false
                });
                const card = rect(target.querySelector('.od-confirm-modal-card'));
                target.querySelector('[data-action="close"]').click();
                await confirm;
                const restored = getComputedStyle(target).position;

                const host = document.createElement('div');
                host.dataset.theme = 'dark';
                document.body.appendChild(host);
                const shadow = host.attachShadow({ mode: 'open' });
                const panel = document.createElement('section');
                shadow.appendChild(panel);
                const dark = window.Overlay.createOverlay({ target: panel });
                const darkColor = getComputedStyle(dark.element).backgroundColor;
                dark.dispose();
                host.remove();

                const dialog = document.createElement('dialog');
                dialog.className = 'od-overlay';
                dialog.textContent = 'Native dialog';
                document.body.appendChild(dialog);
                dialog.showModal();
                // ::backdrop 保持透明，暗色与模糊由伴生遮罩（.od-overlay-root）承担
                const backdropColor = getComputedStyle(dialog, '::backdrop').backgroundColor;
                const backdropFilter = getComputedStyle(dialog, '::backdrop').backdropFilter;
                dialog.close();
                dialog.remove();
                return {
                    viewport,
                    before,
                    after,
                    radius,
                    card,
                    restored,
                    darkColor,
                    lightColor,
                    backdropColor,
                    backdropFilter
                };
            });
            assert.deepEqual(result.viewport, { x: 0, y: 0, width: 900, height: 700 });
            assert.deepEqual(result.before, { x: 40, y: 40, width: 300, height: 180 });
            assert.deepEqual(result.after, result.before);
            assert.equal(result.radius, '12px');
            assert.ok(result.card.width <= result.before.width && result.card.height <= result.before.height);
            assert.equal(result.restored, 'static');
            assert.equal(result.lightColor, 'rgba(0, 0, 0, 0.3)');
            assert.equal(result.darkColor, 'rgba(0, 0, 0, 0.45)');
            assert.equal(result.backdropColor, 'rgba(0, 0, 0, 0)');
            assert.ok(result.backdropFilter === 'none' || result.backdropFilter === undefined);
        } finally {
            await browser.close();
        }
    }
);

test(
    'window-level overlays stay inside the rounded content rect on Linux window-rounded shells',
    {
        skip: process.env.OPENDESK_BROWSER_TESTS !== '1'
    },
    async () => {
        const bundle = await build({
            stdin: {
                contents: "export * from './src/renderer/components/overlay.js';",
                resolveDir: process.cwd()
            },
            bundle: true,
            format: 'iife',
            globalName: 'Overlay',
            write: false
        });
        const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
        try {
            const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
            // 复刻 titlebar.css 的 window-rounded 结构：body 铺满窗口矩形，
            // #app-root 内缩阴影边距并自绘圆角
            await page.setContent(`<style>
            body { margin: 0; }
            html.window-rounded {
                --od-window-margin: 20px;
                --od-window-radius: 14px;
                --od-overlay-inset: var(--od-window-margin);
                --od-overlay-radius: var(--od-window-radius);
            }
            html.window-rounded, html.window-rounded body { background: transparent; overflow: hidden; }
            html.window-rounded body { position: fixed; inset: 0; transform: translateZ(0); }
            html.window-rounded #app-root {
                position: fixed;
                inset: var(--od-window-margin);
                border-radius: var(--od-window-radius);
                overflow: hidden;
                transform: translateZ(0);
            }
        </style><div id="app-root"></div>`);
            await page.addScriptTag({ content: bundle.outputFiles[0].text });
            const result = await page.evaluate(() => {
                document.documentElement.classList.add('window-rounded');
                const rect = (el) => {
                    const { x, y, width, height } = el.getBoundingClientRect();
                    return { x, y, width, height };
                };
                const full = window.Overlay.createOverlay();
                const windowRect = rect(full.element);
                const radius = getComputedStyle(full.element).borderTopLeftRadius;
                full.dispose();
                document.documentElement.classList.remove('window-rounded');
                const plain = window.Overlay.createOverlay();
                const plainRect = rect(plain.element);
                plain.dispose();
                return { windowRect, radius, plainRect };
            });
            // 遮罩必须落在内容矩形（四周内缩 20px）并跟随内容圆角，而不是铺满窗口矩形
            assert.deepEqual(result.windowRect, { x: 20, y: 20, width: 860, height: 660 });
            assert.equal(result.radius, '14px');
            // 其他平台（无 window-rounded）行为不变：铺满视口、无圆角
            assert.deepEqual(result.plainRect, { x: 0, y: 0, width: 900, height: 700 });
        } finally {
            await browser.close();
        }
    }
);
