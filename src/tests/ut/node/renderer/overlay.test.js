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
                const lightColor = getComputedStyle(dialog, '::backdrop').backgroundColor;
                document.documentElement.dataset.theme = 'dark';
                const nativeDarkColor = getComputedStyle(dialog, '::backdrop').backgroundColor;
                const blur = getComputedStyle(dialog, '::backdrop').backdropFilter;
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
                    nativeDarkColor,
                    blur
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
            assert.equal(result.nativeDarkColor, result.darkColor);
            assert.equal(result.blur, 'blur(4px)');
        } finally {
            await browser.close();
        }
    }
);
