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

/**
 * 生成式 UI 端到端测试：对一个运行中的 web 模式实例（本机或容器）逐个场景验证
 * showUI/askUI 组件的渲染、交互回传、多标签页同步与刷新后的回执。
 *
 *   node scripts/e2e/genui-web.mjs --url http://127.0.0.1:8790 --token <令牌> \
 *       [--mock-port 18790] [--mock-url http://host.docker.internal:18790/v1] [--out /tmp/genui-e2e]
 *
 * 脚本自己启动模型桩（genui-mock-llm.mjs），并通过 settingAPI 把它配置成默认模型；
 * --mock-url 是被测实例访问模型桩的地址（容器内通常是 host.docker.internal）。
 * 设置 PW_CHROME=1 时使用本机 Chrome。
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startMockLlm } from './genui-mock-llm.mjs';

function option(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 ? process.argv[index + 1] : fallback;
}

const baseUrl = option('url', 'http://127.0.0.1:8790').replace(/\/$/, '');
const token = option('token', process.env.OPENDESK_WEB_TOKEN ?? '');
const mockPort = Number(option('mock-port', '18790'));
const mockUrl = option('mock-url', `http://127.0.0.1:${mockPort}/v1`);
const outDir = option('out', '/tmp/genui-e2e');
const TURN_TIMEOUT = 60_000;

fs.mkdirSync(outDir, { recursive: true });

const results = [];
async function step(name, fn) {
    const started = Date.now();
    try {
        await fn();
        results.push({ name, ok: true, ms: Date.now() - started });
        console.log(`✔ ${name} (${Date.now() - started}ms)`);
    } catch (error) {
        results.push({ name, ok: false, error: String(error?.message ?? error) });
        console.log(
            `✘ ${name}\n  ${String(error?.stack ?? error)
                .split('\n')
                .slice(0, 4)
                .join('\n  ')}`
        );
        await page.screenshot({ path: path.join(outDir, 'failure.png') }).catch(() => undefined);
        throw error;
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const mock = await startMockLlm({ port: mockPort, log: (line) => process.env.GENUI_E2E_VERBOSE && console.log(line) });
const browser = await chromium.launch({ channel: process.env.PW_CHROME ? 'chrome' : undefined });
const context = await browser.newContext({ viewport: { width: 1400, height: 960 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

const widget = (target, component) => target.locator(`.od-genui-widget[data-component="${component}"]`).last();
const input = (target) => target.locator('#agent-input-textarea:visible').last();

async function send(target, text) {
    const box = input(target);
    await box.waitFor({ state: 'visible', timeout: 30_000 });
    await box.fill(text);
    await box.press('Enter');
}

/** 等模型桩的收尾回复出现并流式输出完毕（文字稳定且没有运行状态行）。 */
async function waitForFinal(target, scenario) {
    const final = target.getByText(`MOCK_FINAL ${scenario}:`, { exact: false }).last();
    await final.waitFor({ state: 'visible', timeout: TURN_TIMEOUT });
    const deadline = Date.now() + TURN_TIMEOUT;
    let previous = '';
    let stable = 0;
    while (Date.now() < deadline) {
        const text = (await final.textContent()) ?? '';
        const running = await target.locator('.od-running-status:visible').count();
        stable = text === previous && running === 0 ? stable + 1 : 0;
        if (stable >= 3) return text;
        previous = text;
        await target.waitForTimeout(250);
    }
    throw new Error(`turn "${scenario}" did not settle: ${previous}`);
}

async function shot(target, name, locator) {
    await (locator ?? target).screenshot({ path: path.join(outDir, `${name}.png`) });
}

async function openTask(target) {
    const row = target.locator('.task-item.sb-task-row').first();
    await row.waitFor({ state: 'visible', timeout: 30_000 });
    await row.click();
    await input(target).waitFor({ state: 'visible', timeout: 30_000 });
}

try {
    await step('open the web UI with the access token', async () => {
        await page.goto(`${baseUrl}/${token ? `?token=${encodeURIComponent(token)}` : ''}`, {
            waitUntil: 'domcontentloaded'
        });
        await page.waitForFunction(() => Boolean(window.settingAPI), null, { timeout: 60_000 });
    });

    await step('configure the mock model and Chinese UI', async () => {
        await page.evaluate(async (url) => {
            const data = await window.settingAPI.loadSettingObject();
            data.providers = (data.providers ?? []).filter((provider) => provider.name !== 'genui-mock');
            data.providers.push({
                name: 'genui-mock',
                provider_type: 'openai',
                base_url: url,
                api_key: 'mock',
                no_proxy: true,
                no_ssl: false
            });
            data.models = (data.models ?? []).filter((model) => model.alias !== 'genui-mock');
            data.models.push({
                alias: 'genui-mock',
                provider_name: 'genui-mock',
                model_name: 'genui-mock',
                model_type: 'chat',
                reasoning_effort: ''
            });
            data.default_model = 'genui-mock';
            // 断言按中文文案写，固定界面语言
            data.locale = 'zh-CN';
            await window.settingAPI.saveSettingObjectDetailed(data);
        }, mockUrl);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await input(page).waitFor({ state: 'visible', timeout: 60_000 });
    });

    await step('showUI renders a data table that stays visible after the turn', async () => {
        await send(page, '[genui:table] 展示季度销售');
        const table = widget(page, 'data-table');
        await table.waitFor({ state: 'visible', timeout: TURN_TIMEOUT });
        const final = await waitForFinal(page, 'table');
        assert(final.includes('"shown":true'), `tool result not returned to the model: ${final}`);
        assert(await table.isVisible(), 'table collapsed with the finished process');
        const text = await table.innerText();
        for (const expected of ['季度销售', '华东', '华南', '¥', '12%', '达标']) {
            assert(text.includes(expected), `table misses "${expected}": ${text}`);
        }
        // 第一列默认按收入降序
        const firstRow = await table.locator('tbody tr').first().innerText();
        assert(firstRow.includes('华东'), `unexpected sort: ${firstRow}`);
        await shot(page, '01-data-table', table);
    });

    await step('showUI renders parallel chart, comparison, spec and link widgets', async () => {
        await send(page, '[genui:showcase] 展示几个卡片');
        await waitForFinal(page, 'showcase');
        for (const [component, expected] of [
            ['chart', '日活用户'],
            ['comparison-card', '专业版'],
            ['spec-sheet', '32 GB'],
            ['link-preview', 'OpenDesk 生成式 UI']
        ]) {
            const element = widget(page, component);
            await element.waitFor({ state: 'visible', timeout: 10_000 });
            const text = await element.innerText();
            assert(text.includes(expected), `${component} misses "${expected}": ${text}`);
        }
        assert((await page.locator('.od-genui-widget[data-component="chart"] svg').count()) > 0, 'chart has no svg');
        await shot(page, '02-showcase', page.locator('.od-genui-item').last());
    });

    let second;
    await step('askUI option list is answered from a second tab', async () => {
        await send(page, '[genui:ask] 帮我发布');
        const list = widget(page, 'option-list');
        const prodButton = list.getByRole('button', { name: /生产环境/ });
        await prodButton.waitFor({ state: 'visible', timeout: TURN_TIMEOUT });
        await shot(page, '03-option-list-waiting', list);

        second = await context.newPage();
        second.on('pageerror', (error) => pageErrors.push(`[tab2] ${String(error)}`));
        await second.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        await openTask(second);
        const otherButton = widget(second, 'option-list').getByRole('button', { name: /生产环境/ });
        await otherButton.waitFor({ state: 'visible', timeout: 30_000 });
        await otherButton.click();

        const final = await waitForFinal(page, 'ask');
        assert(final.includes('用户选择：生产环境'), `answer not returned to the model: ${final}`);
        // 两个标签页都收起成回执
        for (const target of [page, second]) {
            const receipt = widget(target, 'option-list');
            await receipt.getByRole('button').first().waitFor({ state: 'detached', timeout: 10_000 });
            const text = await receipt.innerText();
            assert(text.includes('生产环境') && !text.includes('预发环境'), `receipt shows: ${text}`);
        }
        await shot(page, '04-option-list-receipt', widget(page, 'option-list'));
    });

    await step('askUI approval card returns the decision', async () => {
        await send(page, '[genui:approve] 清理一下');
        const card = widget(page, 'approval-card');
        await card.getByRole('button', { name: '批准' }).waitFor({ state: 'visible', timeout: TURN_TIMEOUT });
        await shot(page, '05-approval-waiting', card);
        await card.getByRole('button', { name: '批准' }).click();
        const final = await waitForFinal(page, 'approve');
        assert(final.includes('用户批准了「清理构建产物」'), `decision not returned: ${final}`);
        assert((await card.innerText()).includes('已批准'), 'approval receipt missing');
    });

    await step('askUI form submits edited values', async () => {
        await send(page, '[genui:form] 准备发布');
        const form = widget(page, 'form');
        const versionInput = form.locator('input').first();
        await versionInput.waitFor({ state: 'visible', timeout: TURN_TIMEOUT });
        await versionInput.fill('2.0.0');
        await form.getByRole('button', { name: 'beta' }).click();
        await form.getByRole('switch').click();
        await shot(page, '06-form-filled', form);
        await form.getByRole('button', { name: '提交' }).click();
        const final = await waitForFinal(page, 'form');
        for (const expected of ['版本号（version）：2.0.0', '渠道（channel）：beta', '通知用户（notify）：false']) {
            assert(final.includes(expected), `form result misses "${expected}": ${final}`);
        }
        await form.locator('input').first().waitFor({ state: 'detached', timeout: 10_000 });
        assert((await form.innerText()).includes('已提交'), 'form receipt missing');
    });

    await step('askUI question flow walks through every step', async () => {
        await send(page, '[genui:flow] 帮我选方案');
        const flow = widget(page, 'question-flow');
        await flow.getByRole('button', { name: /10 人以上/ }).click({ timeout: TURN_TIMEOUT });
        await flow.getByRole('button', { name: /^低/ }).click({ timeout: 10_000 });
        const final = await waitForFinal(page, 'flow');
        assert(final.includes('回答：10 人以上') && final.includes('回答：低'), `flow result: ${final}`);
    });

    await step('invalid props come back to the model as a tool error', async () => {
        await send(page, '[genui:invalid] 画个图');
        const final = await waitForFinal(page, 'invalid');
        assert(final.includes('参数不合法'), `validation error not returned: ${final}`);
    });

    await step('widgets render as receipts after a reload', async () => {
        await second?.close();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openTask(page);
        await widget(page, 'data-table').waitFor({ state: 'visible', timeout: 30_000 });
        const optionText = await widget(page, 'option-list').innerText();
        assert(optionText.includes('生产环境') && !optionText.includes('预发环境'), `option receipt: ${optionText}`);
        assert((await widget(page, 'approval-card').innerText()).includes('已批准'), 'approval receipt lost');
        assert((await widget(page, 'form').innerText()).includes('2.0.0'), 'form receipt lost');
        assert((await page.locator('.od-genui-widget button:has-text("批准")').count()) === 0, 'stale approve button');
        await shot(page, '07-after-reload');
    });

    await step('task export renders widgets as static HTML', async () => {
        const exportPath = `/tmp/genui-export-${Date.now()}.html`;
        // 绕过保存对话框：直接让导出写到固定路径，再经 web 模式的文件路由读回
        await page.evaluate(async (filePath) => {
            const view = [...document.querySelectorAll('task-view')].find((element) => element.offsetParent !== null);
            const original = window.fsAPI.saveFile;
            window.fsAPI.saveFile = async () => ({ canceled: false, filePath });
            try {
                await view.exportTask();
            } finally {
                window.fsAPI.saveFile = original;
            }
        }, exportPath);
        const response = await page.request.get(`${baseUrl}/__opendesk/fs${exportPath}`);
        assert(response.ok(), `export not written: HTTP ${response.status()}`);
        const html = await response.text();
        fs.writeFileSync(path.join(outDir, 'export.html'), html);
        assert(!html.includes('od-genui-fallback'), 'export still contains placeholder fallbacks');
        for (const expected of ['data-component="data-table"', '华东', 'data-component="approval-card"', '已批准']) {
            assert(html.includes(expected), `export misses ${expected}`);
        }
        assert(/\.bg-background\s*\{/.test(html), 'export misses widget styles');

        const viewer = await context.newPage();
        await viewer.setContent(html, { waitUntil: 'domcontentloaded' });
        const table = viewer.locator('.od-genui-widget[data-component="data-table"]').first();
        await table.waitFor({ state: 'visible', timeout: 10_000 });
        await shot(viewer, '09-export-table', table);
        await viewer.close();
    });

    await step('widgets follow the dark theme', async () => {
        await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
        const table = widget(page, 'data-table');
        await table.scrollIntoViewIfNeeded();
        const background = await table
            .locator('[data-slot]')
            .first()
            .evaluate((element) => getComputedStyle(element).backgroundColor);
        await shot(page, '08-dark-table', table);
        assert(background !== 'rgb(255, 255, 255)', `dark background not applied: ${background}`);
    });

    await step('no page errors', async () => {
        assert(pageErrors.length === 0, pageErrors.join('\n'));
    });
} catch {
    // 首个失败的步骤已打印，后续步骤依赖它，不再继续
} finally {
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ results, pageErrors }, null, 2));
    await browser.close();
    await mock.close();
    const failed = results.filter((result) => !result.ok).length;
    console.log(`\n${results.length - failed}/${results.length} steps passed, screenshots in ${outDir}`);
    process.exitCode = failed ? 1 : 0;
}
