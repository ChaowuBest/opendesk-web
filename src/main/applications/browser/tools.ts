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
 * CDP-based browser tools for agent interaction.
 *
 * Architecture (aligned with Playwright MCP):
 *   Agent → tool handler → CDPSession (Electron debugger API) → guest webContents
 *
 * Element targeting uses a ref system (e0, e1, …) assigned by browserSnapshot.
 * Click / type / hover use CDP Input domain for real OS-level events,
 * fixing React/Vue synthetic event issues of the previous executeJavaScript approach.
 */

import { BaseTool } from '../../aikernel/tool';
import { ToolCall } from '../../aikernel/messages';
import { Card } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import chalk from 'chalk';
import { z } from 'zod';
import { captureSnapshot, resolveTargetCoords } from './cdp/snapshot';
import { resolveKey, modifiersBitmask, sleep, withRetry } from './cdp/utils';
import type { CDPSession } from './cdp/session';
import type { TaskState } from '../../aikernel/states/tasks';
import type { BrowserApplication } from './app';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get a healthy CDP session for the given task, with retry + health check.
 * Auto-reconnects via CDPSession._ensureAttached if the debugger was detached
 * (e.g. by page reload). Retries up to 4 times with increasing delays.
 */
async function requireCDP(app: BrowserApplication, taskId: string): Promise<CDPSession> {
    return withRetry(
        async () => {
            const session = await app.getCDPSession(taskId);
            if (!session) throw new Error('CDP session not available — browser may not be ready');
            // Probe health: triggers auto-reconnect inside session.send()
            const healthy = await session.isHealthy();
            if (!healthy) throw new Error('CDP session unhealthy — will retry');
            return session;
        },
        { delays: [300, 600, 1200, 2000], shouldRetry: () => true }
    );
}

function ok(data: Record<string, any>): string {
    return JSON.stringify({ success: true, ...data });
}

function fail(error: string): string {
    return JSON.stringify({ success: false, error });
}

/**
 * Read current page URL + title from a CDP session.
 * If the URL is a chrome-error:// page, extracts the real error info.
 */
async function readPageInfo(session: CDPSession): Promise<{ url: string; title: string; error?: string }> {
    const result = await session.send('Runtime.evaluate', {
        expression: `JSON.stringify({ url: location.href, title: document.title })`,
        returnByValue: true
    });
    const info = JSON.parse(result.result.value);

    // Detect Chromium error pages (chrome-error://chromewebdata/)
    if (typeof info.url === 'string' && info.url.startsWith('chrome-error://')) {
        // Try to extract the actual error from the error page's DOM
        try {
            const errResult = await session.send('Runtime.evaluate', {
                expression: `(() => {
                    var diag = document.getElementById('sub-frame-error-details') || document.getElementById('main-message');
                    var details = diag ? diag.innerText.trim() : '';
                    var heading = document.querySelector('.error-code') || document.querySelector('h1');
                    var code = heading ? heading.innerText.trim() : '';
                    return JSON.stringify({ code: code, details: details });
                })()`,
                returnByValue: true
            });
            const errInfo = JSON.parse(errResult.result.value);
            const errorMsg = [errInfo.code, errInfo.details].filter(Boolean).join(': ') || 'Page failed to load';
            return { url: info.url, title: info.title, error: errorMsg };
        } catch {
            return { url: info.url, title: info.title, error: 'Page failed to load (chrome-error)' };
        }
    }

    return info;
}

/**
 * Read compact page state after an action.
 * Like Playwright's "Page" section in responses: gives agent immediate feedback
 * about the current page without the cost of a full element snapshot.
 */
async function readPageState(session: CDPSession): Promise<Record<string, any> | null> {
    try {
        const result = await session.send('Runtime.evaluate', {
            expression: `JSON.stringify({
                url: location.href,
                title: document.title,
                scrollY: Math.round(window.scrollY),
                scrollHeight: document.documentElement.scrollHeight,
                viewportHeight: window.innerHeight,
            })`,
            returnByValue: true
        });
        return JSON.parse(result.result.value);
    } catch {
        return null;
    }
}

/** Overall timeout wrapper: rejects if fn doesn't resolve within ms. */
function withTimeout<T>(fn: Promise<T>, ms: number, message: string): Promise<T> {
    return Promise.race([fn, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

/**
 * Wait for click side-effects to settle (inspired by Playwright's waitForCompletion).
 * After executing `callback`, waits briefly and checks whether a navigation happened.
 * If so, waits for the new page to become ready. Otherwise returns immediately.
 */
async function waitForClickCompletion(session: CDPSession, callback: () => Promise<void>): Promise<void> {
    // Record URL before click
    let urlBefore: string | null = null;
    try {
        const r = await session.send('Runtime.evaluate', {
            expression: 'location.href',
            returnByValue: true
        });
        urlBefore = r.result.value;
    } catch {
        /* page may be in transition */
    }

    await callback();

    // Brief pause for any navigation to kick off
    await sleep(500);

    // Check if URL changed (indicating navigation)
    try {
        const r = await session.send('Runtime.evaluate', {
            expression: 'location.href',
            returnByValue: true
        });
        const urlAfter = r.result.value;
        if (urlAfter !== urlBefore) {
            // A navigation occurred — wait for load (cap at 8s like Playwright's 10s)
            await session.waitForPageReady(8000);
        }
    } catch {
        // Page context likely destroyed by navigation — wait for new page to load
        await session.waitForPageReady(8000);
    }
}

// ========== browserNavigate ==========

const BrowserNavigateArgsSchema = z.object({
    url: z.string().describe('要访问的网址，例如 https://www.baidu.com'),
    newTab: z.boolean().default(false).describe('是否在新标签页中打开，默认 false')
});

export class BrowserNavigateTool extends BaseTool<typeof BrowserNavigateArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserNavigate',
            '在当前任务的嵌入式浏览器中打开指定的网页。支持在当前标签页或新标签页中打开。浏览器会自动切换到前台显示。',
            BrowserNavigateArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const url = args?.['url'];
        const body: string[] = [];
        if (url) body.push(chalk.dim('网址: ') + chalk.cyan(truncText(String(url), width - 14)));
        if (args?.newTab) body.push(chalk.dim('  新标签页打开'));
        if (toolcall.status === 'running') body.push(chalk.dim('  ⏳ 正在加载页面…'));
        else if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 页面已打开'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '🌐', title: '打开网页', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserNavigateArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        // Normalize URL (like Playwright: bare hostname → https://)
        let url = args.url;
        try {
            new URL(url);
        } catch {
            if (url.startsWith('localhost') || /^\d+\.\d+\.\d+\.\d+/.test(url)) url = 'http://' + url;
            else if (!url.includes('://')) url = 'https://' + url;
        }

        const NAVIGATE_TIMEOUT = 20000;

        try {
            const navigateAndWait = async (): Promise<string> => {
                if (args.newTab) {
                    await this.browserApp.callRendererBrowser(taskId, 'browserAddTab', url);
                } else {
                    await this.browserApp.callRendererBrowser(taskId, 'browserNavigate', url);
                }

                await sleep(400);

                const session = await this.browserApp.getCDPSession(taskId);
                if (session) {
                    await session.waitForPageReady(NAVIGATE_TIMEOUT - 2000);
                    // Cap 'load' wait at 5s (like Playwright) — page is operational after domcontentloaded
                    await sleep(200);

                    const info = await readPageInfo(session);

                    if (info.error) {
                        return fail(`页面加载失败: ${info.error} (请求地址: ${url})`);
                    }
                    if (info.url && info.url !== 'about:blank') {
                        return ok({ url: info.url, title: info.title });
                    }
                }

                return ok({ url, title: '(页面加载中)' });
            };

            return await withTimeout(
                navigateAndWait(),
                NAVIGATE_TIMEOUT,
                `导航超时（${NAVIGATE_TIMEOUT / 1000}秒）：无法加载 ${url}，网址可能不可用或网络连接异常`
            );
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== browserSnapshot ==========

const BrowserSnapshotArgsSchema = z.object({});

export class BrowserSnapshotTool extends BaseTool<typeof BrowserSnapshotArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserSnapshot',
            '获取当前页面快照：URL、标题、viewport 及所有可交互元素列表（每个元素带有 ref 标识，如 e0、e1，用于后续 browserClick / browserType 等操作的目标定位）。这是与页面交互前的必要步骤。',
            BrowserSnapshotArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                if (result.url) body.push(chalk.dim('  URL: ') + chalk.cyan(truncText(String(result.url), width - 16)));
                if (result.title)
                    body.push(chalk.dim('  标题: ') + chalk.white(truncText(String(result.title), width - 16)));
                const elCount = result.elements?.length ?? 0;
                body.push(chalk.dim('  可交互元素: ') + chalk.green(String(elCount) + ' 个'));
            } catch {
                body.push(chalk.dim('  ✓ 已获取快照'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }
        return new Card({ icon: '📊', title: '页面快照', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        _args: z.output<typeof BrowserSnapshotArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            const session = await requireCDP(this.browserApp, taskId);
            const snapshot = await captureSnapshot(session);
            return JSON.stringify(snapshot);
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== browserClick ==========

const BrowserClickArgsSchema = z.object({
    target: z.string().describe('要点击的元素：使用 ref（如 e3，从 browserSnapshot 获取）或 CSS 选择器'),
    button: z.enum(['left', 'right', 'middle']).default('left').describe('鼠标按钮，默认 left'),
    doubleClick: z.boolean().default(false).describe('是否双击'),
    modifiers: z
        .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
        .optional()
        .describe('修饰键')
});

export class BrowserClickTool extends BaseTool<typeof BrowserClickArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserClick',
            '点击页面元素。使用 ref（从 browserSnapshot 获取，如 e3）或 CSS 选择器定位。通过 CDP 发送真实鼠标事件，兼容 React/Vue 等所有前端框架。',
            BrowserClickArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.target) body.push(chalk.dim('  目标: ') + chalk.yellow(truncText(String(args.target), width - 14)));
        if (toolcall.status === 'running') body.push(chalk.dim('  ⏳ 正在点击…'));
        else if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已点击'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '👆', title: '点击元素', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(args: z.output<typeof BrowserClickArgsSchema>, taskState?: TaskState): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            const session = await requireCDP(this.browserApp, taskId);
            const coords = await resolveTargetCoords(session, args.target);
            const modMask = modifiersBitmask(args.modifiers);
            const clickCount = args.doubleClick ? 2 : 1;
            // CDP Input.dispatchMouseEvent uses 'none'|'left'|'middle'|'right'|'back'|'forward'
            const button = args.button || 'left';

            const performClick = async () => {
                // Move → press → release (real CDP mouse events)
                await session.send('Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: coords.x,
                    y: coords.y,
                    modifiers: modMask
                });
                await session.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: coords.x,
                    y: coords.y,
                    button,
                    clickCount,
                    modifiers: modMask
                });
                await session.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: coords.x,
                    y: coords.y,
                    button,
                    clickCount,
                    modifiers: modMask
                });

                // For right-click, some pages need an explicit contextmenu event.
                // CDP dispatches it automatically from the mousePressed with button='right',
                // but if the page suppresses it, we fire it via JS as fallback.
                if (button === 'right') {
                    await session
                        .send('Runtime.evaluate', {
                            expression: `(() => {
                            var el = document.elementFromPoint(${coords.x}, ${coords.y});
                            if (el) el.dispatchEvent(new MouseEvent('contextmenu', {
                                bubbles: true, cancelable: true, view: window,
                                clientX: ${coords.x}, clientY: ${coords.y}, button: 2
                            }));
                        })()`,
                            returnByValue: true
                        })
                        .catch(() => {
                            /* best effort */
                        });
                }
            };

            // Wait for click side-effects (navigation, XHR, etc.) to settle
            await waitForClickCompletion(session, performClick);

            const pageState = await readPageState(session);
            return ok({
                target: args.target,
                tag: coords.tag,
                text: coords.text,
                ...(pageState && { page: pageState })
            });
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== browserType ==========

const BrowserTypeArgsSchema = z.object({
    target: z.string().describe('要输入的目标元素：ref（如 e3）或 CSS 选择器'),
    text: z.string().describe('要输入的文本内容'),
    clearFirst: z.boolean().default(true).describe('输入前是否先清空已有内容，默认 true'),
    submit: z.boolean().default(false).describe('输入完成后是否按 Enter 提交，默认 false'),
    slowly: z
        .boolean()
        .default(false)
        .describe('是否逐字符输入（触发页面逐键事件处理器）。默认 false（一次性填入整段文本）。')
});

export class BrowserTypeTool extends BaseTool<typeof BrowserTypeArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserType',
            '在页面输入框中输入文本。使用 ref 或 CSS 选择器定位元素，通过 CDP 发送真实键盘事件。支持清空已有内容和输入后按 Enter 提交。',
            BrowserTypeArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.target) body.push(chalk.dim('  目标: ') + chalk.yellow(truncText(String(args.target), width - 14)));
        if (args?.text) body.push(chalk.dim('  文本: ') + chalk.cyan(truncText(String(args.text), width - 14)));
        if (args?.submit) body.push(chalk.dim('  + Enter'));
        if (toolcall.status === 'running') body.push(chalk.dim('  ⏳ 正在输入…'));
        else if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已输入'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '⌨️', title: '输入文本', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(args: z.output<typeof BrowserTypeArgsSchema>, taskState?: TaskState): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            const session = await requireCDP(this.browserApp, taskId);

            // Click to focus the element
            const coords = await resolveTargetCoords(session, args.target);
            await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coords.x, y: coords.y });
            await session.send('Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: coords.x,
                y: coords.y,
                button: 'left',
                clickCount: 1
            });
            await session.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: coords.x,
                y: coords.y,
                button: 'left',
                clickCount: 1
            });
            await sleep(50);

            // Clear existing content if requested
            if (args.clearFirst) {
                // Select all (Ctrl/Cmd + A) then delete
                const selectAllMod = process.platform === 'darwin' ? 4 : 2; // Meta or Control
                await session.send('Input.dispatchKeyEvent', {
                    type: 'keyDown',
                    key: 'a',
                    code: 'KeyA',
                    windowsVirtualKeyCode: 65,
                    modifiers: selectAllMod
                });
                await session.send('Input.dispatchKeyEvent', {
                    type: 'keyUp',
                    key: 'a',
                    code: 'KeyA',
                    windowsVirtualKeyCode: 65,
                    modifiers: selectAllMod
                });
                await session.send('Input.dispatchKeyEvent', {
                    type: 'keyDown',
                    key: 'Backspace',
                    code: 'Backspace',
                    windowsVirtualKeyCode: 8
                });
                await session.send('Input.dispatchKeyEvent', {
                    type: 'keyUp',
                    key: 'Backspace',
                    code: 'Backspace',
                    windowsVirtualKeyCode: 8
                });
                await sleep(30);
            }

            if (args.text) {
                if (args.slowly) {
                    // Char-by-char: triggers keyDown/keyUp per char (like Playwright pressSequentially)
                    for (const ch of args.text) {
                        const desc = resolveKey(ch);
                        await session.send('Input.dispatchKeyEvent', {
                            type: 'keyDown',
                            key: desc.key,
                            code: desc.code,
                            windowsVirtualKeyCode: desc.keyCode,
                            text: desc.text || ''
                        });
                        await session.send('Input.dispatchKeyEvent', {
                            type: 'keyUp',
                            key: desc.key,
                            code: desc.code,
                            windowsVirtualKeyCode: desc.keyCode
                        });
                        await sleep(30);
                    }
                } else {
                    // Default fill mode: insert entire text at once (fast, like Playwright fill)
                    await session.send('Input.insertText', { text: args.text });
                }
            }

            // Press Enter if submit requested — wrap in waitForClickCompletion since
            // submit often triggers navigation
            if (args.submit) {
                await sleep(50);
                await waitForClickCompletion(session, async () => {
                    await session.send('Input.dispatchKeyEvent', {
                        type: 'keyDown',
                        key: 'Enter',
                        code: 'Enter',
                        windowsVirtualKeyCode: 13
                    });
                    await session.send('Input.dispatchKeyEvent', {
                        type: 'keyUp',
                        key: 'Enter',
                        code: 'Enter',
                        windowsVirtualKeyCode: 13
                    });
                });
            }

            return ok({ target: args.target, typed: args.text.length });
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== browserHover ==========

const BrowserHoverArgsSchema = z.object({
    target: z.string().describe('要悬停的元素：ref（如 e3）或 CSS 选择器')
});

export class BrowserHoverTool extends BaseTool<typeof BrowserHoverArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserHover',
            '将鼠标悬停在指定元素上。用于触发 hover 效果、显示 tooltip、展开下拉菜单等。',
            BrowserHoverArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.target) body.push(chalk.dim('  目标: ') + chalk.yellow(truncText(String(args.target), width - 14)));
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已悬停'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '🖱️', title: '悬停', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(args: z.output<typeof BrowserHoverArgsSchema>, taskState?: TaskState): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            const session = await requireCDP(this.browserApp, taskId);
            const coords = await resolveTargetCoords(session, args.target);

            await session.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: coords.x,
                y: coords.y
            });

            return ok({ target: args.target, tag: coords.tag, text: coords.text });
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== browserPressKey ==========

const BrowserPressKeyArgsSchema = z.object({
    key: z.string().describe('按键名称，如 Enter、Tab、Escape、ArrowDown、a、1 等'),
    modifiers: z
        .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
        .optional()
        .describe('修饰键')
});

export class BrowserPressKeyTool extends BaseTool<typeof BrowserPressKeyArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserPressKey',
            '在当前焦点元素上按下指定按键。支持功能键（Enter、Tab、Escape、方向键等）和修饰键组合。',
            BrowserPressKeyArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.key) body.push(chalk.dim('  按键: ') + chalk.yellow(String(args.key)));
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已按键'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '⌨️', title: '按键', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserPressKeyArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            const session = await requireCDP(this.browserApp, taskId);
            const keyDesc = resolveKey(args.key);
            const modMask = modifiersBitmask(args.modifiers);

            await session.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                key: keyDesc.key,
                code: keyDesc.code,
                windowsVirtualKeyCode: keyDesc.keyCode,
                text: keyDesc.text || '',
                modifiers: modMask
            });
            await session.send('Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: keyDesc.key,
                code: keyDesc.code,
                windowsVirtualKeyCode: keyDesc.keyCode,
                modifiers: modMask
            });

            return ok({ key: args.key });
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== browserSelectOption ==========

const BrowserSelectOptionArgsSchema = z.object({
    target: z.string().describe('select 元素的 ref（如 e3）或 CSS 选择器'),
    values: z.array(z.string()).describe('要选择的 option value 值列表')
});

export class BrowserSelectOptionTool extends BaseTool<typeof BrowserSelectOptionArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserSelectOption',
            '在下拉选择框（<select>）中选择指定选项。通过 value 值匹配要选中的选项。',
            BrowserSelectOptionArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.target) body.push(chalk.dim('  目标: ') + chalk.yellow(truncText(String(args.target), width - 14)));
        if (args?.values)
            body.push(chalk.dim('  值: ') + chalk.cyan(truncText(JSON.stringify(args.values), width - 14)));
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已选择'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '📋', title: '选择选项', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserSelectOptionArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            const session = await requireCDP(this.browserApp, taskId);
            const valuesJSON = JSON.stringify(args.values);

            // Resolve element and use DOM manipulation + events for select
            const isRef = /^e\d+$/.test(args.target);
            const selectorExpr = isRef
                ? `document.querySelector('[data-od-ref="${args.target}"]')`
                : `document.querySelector(${JSON.stringify(args.target)})`;

            const result = await session.send('Runtime.evaluate', {
                expression: `(() => {
                    var el = ${selectorExpr};
                    if (!el) return JSON.stringify({ error: 'Element not found' });
                    if (el.tagName.toLowerCase() !== 'select') return JSON.stringify({ error: 'Element is not a <select>' });
                    var values = ${valuesJSON};
                    for (var i = 0; i < el.options.length; i++) {
                        el.options[i].selected = values.indexOf(el.options[i].value) !== -1;
                    }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return JSON.stringify({ selected: values });
                })()`,
                returnByValue: true
            });

            const info = JSON.parse(result.result.value);
            if (info.error) return fail(info.error);
            return ok(info);
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== browserScroll ==========

const BrowserScrollArgsSchema = z.object({
    direction: z.enum(['up', 'down']).describe('滚动方向：up 向上 / down 向下'),
    amount: z.number().int().default(500).describe('滚动距离（像素），默认 500')
});

export class BrowserScrollTool extends BaseTool<typeof BrowserScrollArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserScroll', '滚动当前浏览器页面。返回滚动后的位置和页面总高度信息。', BrowserScrollArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.direction)
            body.push(chalk.dim('  方向: ') + chalk.yellow(args.direction === 'up' ? '↑ 向上' : '↓ 向下'));
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已滚动'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '📜', title: '滚动页面', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserScrollArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            const session = await requireCDP(this.browserApp, taskId);
            const deltaY = args.direction === 'up' ? -args.amount : args.amount;

            // Get actual viewport size for center-of-viewport scroll
            const vpResult = await session.send('Runtime.evaluate', {
                expression: `JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`,
                returnByValue: true
            });
            const vp = JSON.parse(vpResult.result.value);
            const cx = Math.round(vp.w / 2);
            const cy = Math.round(vp.h / 2);

            await session.send('Input.dispatchMouseEvent', {
                type: 'mouseWheel',
                x: cx,
                y: cy,
                deltaX: 0,
                deltaY
            });

            await sleep(200);

            // Read scroll state
            const result = await session.send('Runtime.evaluate', {
                expression: `JSON.stringify({
                    scrollY: Math.round(window.scrollY),
                    scrollHeight: document.documentElement.scrollHeight,
                    viewportHeight: window.innerHeight,
                    atTop: window.scrollY <= 0,
                    atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1,
                    percentScrolled: Math.round(window.scrollY / Math.max(document.documentElement.scrollHeight - window.innerHeight, 1) * 100)
                })`,
                returnByValue: true
            });

            const info = JSON.parse(result.result.value);
            return ok(info);
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== browserGoBack ==========

const BrowserGoBackArgsSchema = z.object({});

export class BrowserGoBackTool extends BaseTool<typeof BrowserGoBackArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserGoBack', '在浏览器中后退到上一个页面', BrowserGoBackArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已后退'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '⬅', title: '后退', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        _args: z.output<typeof BrowserGoBackArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            await this.browserApp.callRendererBrowser(taskId, 'browserGoBack');

            const session = await this.browserApp.getCDPSession(taskId);
            if (session) {
                await session.waitForPageReady(8000);
                try {
                    const info = await readPageInfo(session);
                    if (info.error) return fail(`后退失败: ${info.error}`);
                    return ok(info);
                } catch {
                    /* fall through */
                }
            }

            await sleep(500);
            const raw = await this.browserApp.runOnActiveWebview(
                taskId,
                `JSON.stringify({ url: location.href, title: document.title })`,
                5000
            );
            const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return ok({ url: info.url, title: info.title });
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== browserGoForward ==========

const BrowserGoForwardArgsSchema = z.object({});

export class BrowserGoForwardTool extends BaseTool<typeof BrowserGoForwardArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserGoForward', '在浏览器中前进到下一个页面', BrowserGoForwardArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已前进'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '➡', title: '前进', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        _args: z.output<typeof BrowserGoForwardArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            await this.browserApp.callRendererBrowser(taskId, 'browserGoForward');

            const session = await this.browserApp.getCDPSession(taskId);
            if (session) {
                await session.waitForPageReady(8000);
                try {
                    const info = await readPageInfo(session);
                    if (info.error) return fail(`前进失败: ${info.error}`);
                    return ok(info);
                } catch {
                    /* fall through */
                }
            }

            await sleep(500);
            const raw = await this.browserApp.runOnActiveWebview(
                taskId,
                `JSON.stringify({ url: location.href, title: document.title })`,
                5000
            );
            const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return ok({ url: info.url, title: info.title });
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== browserReload ==========

const BrowserReloadArgsSchema = z.object({});

export class BrowserReloadTool extends BaseTool<typeof BrowserReloadArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserReload', '刷新当前浏览器页面', BrowserReloadArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已刷新'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '🔄', title: '刷新', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        _args: z.output<typeof BrowserReloadArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            // Use the renderer bridge (webview.reload) instead of CDP Page.reload.
            // CDP Page.reload on a <webview>'s guest webContents can cause the
            // Electron host frame to reload or navigate to about:blank.
            await this.browserApp.callRendererBrowser(taskId, 'browserRefresh');

            const session = await this.browserApp.getCDPSession(taskId);
            if (session) {
                await session.waitForPageReady(12000);
                try {
                    const info = await readPageInfo(session);
                    if (info.error) return fail(`刷新后页面加载失败: ${info.error}`);
                    return ok(info);
                } catch {
                    /* fall through */
                }
            }

            await sleep(1000);
            try {
                const raw = await this.browserApp.runOnActiveWebview(
                    taskId,
                    `JSON.stringify({ url: location.href, title: document.title })`,
                    5000
                );
                const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
                return ok({ url: info.url, title: info.title });
            } catch {
                /* best effort */
            }

            return ok({ url: '(reloaded)' });
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== browserEvaluate ==========

const BrowserEvaluateArgsSchema = z.object({
    expression: z.string().describe('要在页面中执行的 JavaScript 表达式，返回值将被序列化后返回')
});

export class BrowserEvaluateTool extends BaseTool<typeof BrowserEvaluateArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserEvaluate',
            '在当前页面执行任意 JavaScript 并返回结果。适用于其他工具无法满足需求时的高级操作或数据提取。',
            BrowserEvaluateArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.expression)
            body.push(chalk.dim('脚本: ') + chalk.yellow(truncText(String(args.expression), width - 14)));
        if (toolcall.status === 'running') body.push(chalk.dim('  ⏳ 正在执行…'));
        else if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 执行完成'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '⚡', title: '执行脚本', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserEvaluateArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            const session = await requireCDP(this.browserApp, taskId);
            const result = await session.send('Runtime.evaluate', {
                expression: args.expression,
                returnByValue: true,
                awaitPromise: true
            });

            if (result.exceptionDetails) {
                const msg =
                    result.exceptionDetails.text ||
                    result.exceptionDetails.exception?.description ||
                    'Evaluation error';
                return fail(msg);
            }

            return ok({ result: result.result.value });
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== browserTabs ==========

const BrowserTabsArgsSchema = z.object({
    action: z
        .enum(['list', 'new', 'close', 'switch'])
        .default('list')
        .describe('操作类型：list=列出标签页，new=新建标签页，close=关闭标签页，switch=切换标签页'),
    tabId: z.number().int().optional().describe('标签页 ID（close / switch 时需要）'),
    url: z.string().optional().describe('新标签页的 URL（action=new 时使用）')
});

export class BrowserTabsTool extends BaseTool<typeof BrowserTabsArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserTabs',
            '管理浏览器标签页：列出 (list)、新建 (new)、关闭 (close)、切换 (switch)。',
            BrowserTabsArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        const action = args?.action ?? 'list';
        body.push(chalk.dim('  操作: ') + chalk.yellow(action));
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const r = JSON.parse(toolcall.result);
                const tabs = r.tabs || [];
                if (tabs.length > 0) {
                    body.push(chalk.dim('  标签页数: ') + chalk.green(String(tabs.length)));
                    for (const t of tabs.slice(0, 5)) {
                        const mark = t.active ? chalk.green('▸ ') : '  ';
                        body.push(mark + chalk.dim(`[${t.id}] `) + chalk.cyan(truncText(t.title || t.url, width - 20)));
                    }
                }
            } catch {
                /* ok */
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }
        return new Card({ icon: '📑', title: '标签页管理', status: statusDisplay(toolcall.status), body }).render(
            width
        );
    }

    private async handleExecute(args: z.output<typeof BrowserTabsArgsSchema>, taskState?: TaskState): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            switch (args.action) {
                case 'list': {
                    const tabs = await this.browserApp.callRendererBrowser(taskId, 'browserListTabs');
                    return ok({ tabs });
                }
                case 'new': {
                    const url = args.url || 'about:blank';
                    const tabId = await this.browserApp.callRendererBrowser(taskId, 'browserAddTab', url);
                    return ok({ tabId, url });
                }
                case 'close': {
                    if (args.tabId === undefined) return fail('close 操作需要提供 tabId');
                    await this.browserApp.callRendererBrowser(taskId, 'browserCloseTab', args.tabId);
                    return ok({ closed: args.tabId });
                }
                case 'switch': {
                    if (args.tabId === undefined) return fail('switch 操作需要提供 tabId');
                    await this.browserApp.callRendererBrowser(taskId, 'browserSwitchTab', args.tabId);
                    return ok({ switched: args.tabId });
                }
                default:
                    return fail(`Unknown action: ${args.action}`);
            }
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== browserWaitFor ==========

const BrowserWaitForArgsSchema = z.object({
    text: z.string().optional().describe('等待页面出现指定文本'),
    textGone: z.string().optional().describe('等待页面中指定文本消失'),
    timeout: z.number().default(10).describe('超时时间（秒），默认 10')
});

export class BrowserWaitForTool extends BaseTool<typeof BrowserWaitForArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserWaitFor',
            '等待页面满足指定条件：出现指定文本 (text) 或文本消失 (textGone)。用于等待页面加载、动态内容渲染等。',
            BrowserWaitForArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.text) body.push(chalk.dim('  等待文本: ') + chalk.cyan(truncText(String(args.text), width - 16)));
        if (args?.textGone)
            body.push(chalk.dim('  等待消失: ') + chalk.cyan(truncText(String(args.textGone), width - 16)));
        if (toolcall.status === 'running') body.push(chalk.dim('  ⏳ 等待中…'));
        else if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 条件满足'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '⏳', title: '等待条件', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserWaitForArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        if (!args.text && !args.textGone) {
            return fail('必须提供 text 或 textGone 之一');
        }

        try {
            const session = await requireCDP(this.browserApp, taskId);
            const timeoutMs = (args.timeout ?? 10) * 1000;
            const pollInterval = 400;
            const deadline = Date.now() + timeoutMs;

            const needle = args.text || args.textGone!;
            const wantPresent = !!args.text;

            // Build a robust text-search expression that handles CJK / dynamic content:
            // 1. Use both innerText (visible) and textContent (all) for wider coverage
            // 2. Normalize whitespace (CJK pages often have irregular spacing)
            // 3. Check across document.body (not just a single element)
            const needleEscaped = JSON.stringify(needle);
            const checkExpr = `(() => {
                var needle = ${needleEscaped};
                var normalize = function(s) { return s.replace(/[\\s\\u00A0\\u3000]+/g, ' ').trim(); };
                var haystack = normalize(document.body.innerText || '');
                if (haystack.indexOf(needle) !== -1) return true;
                haystack = normalize(document.body.textContent || '');
                if (haystack.indexOf(needle) !== -1) return true;
                var nNeedle = normalize(needle);
                if (nNeedle !== needle) {
                    haystack = normalize(document.body.innerText || '');
                    if (haystack.indexOf(nNeedle) !== -1) return true;
                }
                return false;
            })()`;

            while (Date.now() < deadline) {
                try {
                    const result = await session.send('Runtime.evaluate', {
                        expression: checkExpr,
                        returnByValue: true
                    });

                    const found = result.result.value === true;
                    if (wantPresent ? found : !found) {
                        return ok({ condition: wantPresent ? 'text found' : 'text gone' });
                    }
                } catch {
                    // Page may be reloading — retry
                }

                await sleep(pollInterval);
            }

            return fail(
                `等待超时（${args.timeout}秒）：${wantPresent ? `文本 "${needle}" 未出现` : `文本 "${needle}" 未消失`}`
            );
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}
