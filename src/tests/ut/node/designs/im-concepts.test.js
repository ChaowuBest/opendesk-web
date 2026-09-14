import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const prototypeUrl = new URL('../../../../../docs/designs/im-concepts.html', import.meta.url).href;
let browser;

before(async () => {
    browser = await chromium.launch({ headless: true });
});

after(async () => {
    await browser?.close();
});

test('every IM concept supports isolated direct/group messages and safe text rendering', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(prototypeUrl);
    for (let variant = 1; variant <= 5; variant += 1) {
        await page.locator(`[data-variant="${variant}"]`).click();
        assert.equal(await page.locator('#app-window').getAttribute('data-layout'), String(variant));
        await page.locator('[data-conversation="lin"]').click();
        await page.locator('#message-input').fill(`direct ${variant} <img src=x onerror=alert(1)>`);
        await page.locator('#message-input').press('Enter');
        assert.match(await page.locator('#message-list').innerText(), new RegExp(`direct ${variant}`));
        assert.equal(await page.locator('#message-list img').count(), 0);
        await page.locator('[data-conversation="design"]').click();
        assert.doesNotMatch(await page.locator('#message-list').innerText(), /direct [1-5]/);
        await page.locator('#message-input').fill(`group ${variant}`);
        await page.locator('#send-message').click();
        assert.match(await page.locator('#message-list').innerText(), new RegExp(`group ${variant}`));
    }
    assert.deepEqual(errors, []);
    await page.close();
});

test('search, drafts, group creation, theme and locale work together', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(prototypeUrl);
    await page.locator('#message-input').fill('Unsent group draft');
    await page.locator('[data-conversation="lin"]').click();
    await page.locator('#message-input').fill('Unsent direct draft');
    await page.locator('[data-conversation="design"]').click();
    assert.equal(await page.locator('#message-input').inputValue(), 'Unsent group draft');
    await page.locator('#conversation-search').fill('林知夏');
    assert.equal(await page.locator('[data-conversation]').count(), 1);
    await page.locator('#conversation-search').fill('no-such-person');
    assert.equal(await page.locator('[data-conversation]').count(), 0);
    await page.locator('#conversation-search').fill('');
    await page.locator('#new-conversation').click();
    await page.locator('#group-name').fill('Prototype review');
    await page.locator('input[name="member"][value="lin"]').check();
    await page.locator('input[name="member"][value="chen"]').check();
    await page.locator('#confirm-group').click();
    assert.match(await page.locator('#chat-title').innerText(), /Prototype review/);
    await page.locator('#message-input').fill('Welcome, team');
    await page.locator('#send-message').click();
    assert.match(await page.locator('#message-list').innerText(), /Welcome, team/);
    await page.locator('#theme-toggle').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.locator('#locale-toggle').click();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.locator('#send-message').innerText(), 'Send');
    assert.match(await page.locator('#message-list').innerText(), /Welcome, team/);
    await page.close();
});

test('all layouts fit desktop and mobile viewports and expose a conversation return path', async () => {
    const page = await browser.newPage();
    await page.goto(prototypeUrl);
    for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 960 });
        for (let variant = 1; variant <= 5; variant += 1) {
            await page.locator(`[data-variant="${variant}"]`).click();
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            assert.ok(await page.locator('#message-input').isVisible());
            if (width === 390) {
                await page.locator('#mobile-back').click();
                await page.locator('[data-conversation="lin"]').click();
                assert.ok(await page.locator('#message-input').isVisible());
            }
        }
    }
    await page.close();
});

test('details release space, attachments stay local, and comparison selects a concept', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(prototypeUrl);
    await page.locator('[data-variant="3"]').click();
    const before = await page.locator('.chat-panel').boundingBox();
    await page.locator('#close-details').click();
    assert.ok((await page.locator('.chat-panel').boundingBox()).width > before.width + 200);
    await page.locator('#toggle-details').click();
    assert.ok(await page.locator('.context-panel').isVisible());
    await page.locator('[data-action="thread"]').click();
    assert.match(await page.locator('.context-panel').innerText(), /话题回复/);
    await page.locator('[data-action="reply"]').click();
    assert.match(await page.locator('#message-input').inputValue(), /关于/);
    await page.locator('#message-input').fill('');
    await page.locator('#attach-file').click();
    await page.locator('#send-message').click();
    await page.locator('#message-list .file-card').last().click();
    assert.ok(await page.locator('#file-dialog').isVisible());
    await page.keyboard.press('Escape');
    await page.locator('#compare-button').click();
    assert.equal(await page.locator('.comparison-card').count(), 5);
    await page.locator('[data-select-variant="5"]').click();
    assert.equal(await page.locator('#app-window').getAttribute('data-layout'), '5');
    await page.close();
});
