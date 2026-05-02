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

import { BaseTool } from '../../aikernel/tool';
import { ToolCall } from '../../aikernel/messages';
import { Card } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import chalk from 'chalk';
import { z } from 'zod';
import type { TaskState } from '../../aikernel/states/tasks';
import type { BrowserApplication } from './app';

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

        if (url) {
            body.push(chalk.dim('网址: ') + chalk.cyan(truncText(String(url), width - 14)));
        }
        if (args?.newTab) {
            body.push(chalk.dim('  新标签页打开'));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 正在加载页面…'));
        } else if (toolcall.status === 'success') {
            body.push(chalk.dim('  ✓ 页面已打开'));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '🌐',
            title: '打开网页',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserNavigateArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        try {
            if (args.newTab) {
                await this.browserApp.callRendererBrowser(taskId, 'browserAddTab', args.url);
            } else {
                await this.browserApp.callRendererBrowser(taskId, 'browserNavigate', args.url);
            }
            // 等待页面开始加载
            await new Promise((r) => setTimeout(r, 500));

            // 获取导航后的页面信息
            const stateScript = `(() => {
                return JSON.stringify({ url: location.href, title: document.title });
            })()`;
            try {
                const raw = await this.browserApp.runOnActiveWebview(taskId, stateScript);
                const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
                return JSON.stringify({ success: true, url: info.url, title: info.title });
            } catch {
                return JSON.stringify({ success: true, url: args.url });
            }
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserGetState ==========

const BrowserGetStateArgsSchema = z.object({});

export class BrowserGetStateTool extends BaseTool<typeof BrowserGetStateArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserGetState',
            '获取当前页面状态，包括 URL、标题、viewport 尺寸、滚动位置，以及页面上所有可交互元素的索引列表。后续的 browserClick / browserInput 操作依赖此索引定位元素。',
            BrowserGetStateArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const result = JSON.parse(toolcall.result);
                if (result.url) {
                    body.push(chalk.dim('  URL: ') + chalk.cyan(truncText(String(result.url), width - 16)));
                }
                if (result.title) {
                    body.push(chalk.dim('  标题: ') + chalk.white(truncText(String(result.title), width - 16)));
                }
                const elCount = result.interactive_elements?.length ?? 0;
                body.push(chalk.dim('  可交互元素: ') + chalk.green(String(elCount) + ' 个'));
            } catch {
                body.push(chalk.dim('  ✓ 已获取状态'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '📊',
            title: '页面状态',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        _args: z.output<typeof BrowserGetStateArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        try {
            const data = await this.browserApp.runOnActiveWebview(taskId, GET_STATE_SCRIPT);
            return typeof data === 'string' ? data : JSON.stringify(data);
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

const GET_STATE_SCRIPT = `(() => {
    var SEL = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="textbox"], [role="combobox"], [onclick], [tabindex]:not([tabindex="-1"]), summary, details';
    var els = [];
    var idx = 0;
    var allEls = document.querySelectorAll(SEL);
    for (var k = 0; k < allEls.length; k++) {
        var el = allEls[k];
        var rect = el.getBoundingClientRect();
        var style = getComputedStyle(el);
        if (rect.width === 0 && rect.height === 0) continue;
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        if (el.disabled) continue;
        el.setAttribute('data-oi', String(idx));
        var info = {
            index: idx,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || undefined,
            role: el.getAttribute('role') || undefined,
            text: (el.innerText || el.textContent || '').trim().slice(0, 120),
            placeholder: el.getAttribute('placeholder') || undefined,
            value: ('value' in el && el.tagName.match(/^(INPUT|TEXTAREA|SELECT)$/i)) ? String(el.value).slice(0, 120) : undefined,
            href: el.getAttribute('href') || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            name: el.getAttribute('name') || undefined,
            checked: (el.type === 'checkbox' || el.type === 'radio') ? el.checked : undefined,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
        };
        Object.keys(info).forEach(function(k) { if (info[k] === undefined || info[k] === '') delete info[k]; });
        els.push(info);
        idx++;
    }
    return JSON.stringify({
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        page: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
        interactive_elements: els
    });
})()`;

// ========== browserClick ==========

const BrowserClickArgsSchema = z.object({
    index: z.number().int().min(0).optional().describe('要点击的元素索引（通过 browserGetState 获取）。与坐标二选一。'),
    x: z.number().int().optional().describe('点击的 X 坐标（像素，从视口左边缘算起）。需与 y 一起使用。'),
    y: z.number().int().optional().describe('点击的 Y 坐标（像素，从视口顶部算起）。需与 x 一起使用。')
});

export class BrowserClickTool extends BaseTool<typeof BrowserClickArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserClick',
            '点击页面上的元素。可通过 index（从 browserGetState 获取）或坐标 (x, y) 定位。使用 index 时会先滚动到元素位置再点击。',
            BrowserClickArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.index !== undefined) {
            body.push(chalk.dim('  元素索引: ') + chalk.yellow(String(args.index)));
        }
        if (args?.x !== undefined && args?.y !== undefined) {
            body.push(chalk.dim('  坐标: ') + chalk.yellow(`(${args.x}, ${args.y})`));
        }
        if (toolcall.status === 'running') body.push(chalk.dim('  ⏳ 正在点击…'));
        else if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已点击'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '👆', title: '点击元素', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(args: z.output<typeof BrowserClickArgsSchema>, taskState?: TaskState): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        if (args.index === undefined && (args.x === undefined || args.y === undefined)) {
            return JSON.stringify({
                success: false,
                error: '必须提供 index 或 (x, y) 坐标之一。使用 index 需先调用 browserGetState 获取元素列表。'
            });
        }

        let script: string;

        if (args.index !== undefined) {
            const idx = args.index;
            script = `(() => {
                var el = document.querySelector('[data-oi="${idx}"]');
                if (!el) return JSON.stringify({ success: false, error: '索引 ${idx} 对应的元素未找到，页面可能已变化。请重新调用 browserGetState 刷新元素列表。' });
                el.scrollIntoView({ block: 'center', behavior: 'instant' });
                var rect = el.getBoundingClientRect();
                var cx = rect.left + rect.width / 2;
                var cy = rect.top + rect.height / 2;
                var evtInit = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
                el.dispatchEvent(new PointerEvent('pointerdown', evtInit));
                el.dispatchEvent(new MouseEvent('mousedown', evtInit));
                el.dispatchEvent(new PointerEvent('pointerup', evtInit));
                el.dispatchEvent(new MouseEvent('mouseup', evtInit));
                el.dispatchEvent(new MouseEvent('click', evtInit));
                var tag = el.tagName.toLowerCase();
                var text = (el.innerText || '').trim().slice(0, 80);
                return JSON.stringify({ success: true, tag: tag, text: text, index: ${idx} });
            })()`;
        } else {
            const cx = args.x!;
            const cy = args.y!;
            script = `(() => {
                var el = document.elementFromPoint(${cx}, ${cy});
                if (!el) return JSON.stringify({ success: false, error: '坐标 (${cx}, ${cy}) 处没有可点击的元素' });
                var evtInit = { bubbles: true, cancelable: true, view: window, clientX: ${cx}, clientY: ${cy} };
                el.dispatchEvent(new PointerEvent('pointerdown', evtInit));
                el.dispatchEvent(new MouseEvent('mousedown', evtInit));
                el.dispatchEvent(new PointerEvent('pointerup', evtInit));
                el.dispatchEvent(new MouseEvent('mouseup', evtInit));
                el.dispatchEvent(new MouseEvent('click', evtInit));
                var tag = el.tagName.toLowerCase();
                var text = (el.innerText || '').trim().slice(0, 80);
                return JSON.stringify({ success: true, tag: tag, text: text, x: ${cx}, y: ${cy} });
            })()`;
        }

        try {
            const raw = await this.browserApp.runOnActiveWebview(taskId, script);
            return typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserInput ==========

const BrowserInputArgsSchema = z.object({
    index: z.number().int().min(0).describe('要输入文本的元素索引，通过 browserGetState 获取'),
    text: z.string().describe('要输入的文本内容。传空字符串 "" 表示清空输入框。'),
    clearFirst: z.boolean().default(true).describe('是否先清空已有内容，默认 true'),
    pressEnter: z.boolean().default(false).describe('输入完成后是否按下 Enter 键（用于提交搜索框等），默认 false')
});

export class BrowserInputTool extends BaseTool<typeof BrowserInputArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserInput',
            '在页面上指定索引的输入框中填写文本。通过模拟键盘事件逐字符输入（keyDown/char/keyUp），兼容所有前端框架，不受元素尺寸限制。支持输入后按 Enter 提交。',
            BrowserInputArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.index !== undefined) body.push(chalk.dim('  元素索引: ') + chalk.yellow(String(args.index)));
        if (args?.text) body.push(chalk.dim('  文本: ') + chalk.cyan(truncText(String(args.text), width - 14)));
        if (args?.pressEnter) body.push(chalk.dim('  + Enter'));
        if (toolcall.status === 'running') body.push(chalk.dim('  ⏳ 正在输入…'));
        else if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已输入'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '⌨️', title: '输入文本', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(args: z.output<typeof BrowserInputArgsSchema>, taskState?: TaskState): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        const idx = args.index;

        // Step 1: Focus the element and optionally clear it
        const focusScript = `(() => {
            var el = document.querySelector('[data-oi="${idx}"]');
            if (!el) return JSON.stringify({ success: false, error: '索引 ${idx} 对应的元素未找到，请重新调用 browserGetState。' });

            el.scrollIntoView({ block: 'center', behavior: 'instant' });

            // Click to focus (more reliable than el.focus() for some mobile UIs)
            var rect = el.getBoundingClientRect();
            var cx = rect.left + rect.width / 2;
            var cy = rect.top + rect.height / 2;
            var evtInit = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
            el.dispatchEvent(new PointerEvent('pointerdown', evtInit));
            el.dispatchEvent(new MouseEvent('mousedown', evtInit));
            el.dispatchEvent(new PointerEvent('pointerup', evtInit));
            el.dispatchEvent(new MouseEvent('mouseup', evtInit));
            el.dispatchEvent(new MouseEvent('click', evtInit));
            el.focus();

            var isContentEditable = el.isContentEditable || el.getAttribute('contenteditable') === 'true';

            if (${args.clearFirst}) {
                if (isContentEditable) {
                    while (el.firstChild) el.removeChild(el.firstChild);
                    el.textContent = '';
                    el.innerHTML = '';
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                } else if (el.value !== undefined) {
                    try { el.select(); } catch(e) {}
                    var nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
                    if (nativeSetter && nativeSetter.set) {
                        nativeSetter.set.call(el, '');
                    } else {
                        el.value = '';
                    }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }

            return JSON.stringify({ success: true, ready: true, isContentEditable: isContentEditable });
        })()`;

        try {
            const focusRaw = await this.browserApp.runOnActiveWebview(taskId, focusScript);
            const focusResult = typeof focusRaw === 'string' ? JSON.parse(focusRaw) : focusRaw;
            if (!focusResult.success) return JSON.stringify(focusResult);
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }

        // Step 2: Type text character by character using keyboard events
        if (args.text) {
            const textEscaped = JSON.stringify(args.text);
            const typeScript = `(async () => {
                var text = ${textEscaped};

                function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

                for (var i = 0; i < text.length; i++) {
                    var char = text[i];

                    if (char === '\\n') {
                        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
                            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
                        }));
                        document.activeElement.dispatchEvent(new KeyboardEvent('keypress', {
                            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
                        }));
                        document.activeElement.dispatchEvent(new InputEvent('beforeinput', {
                            inputType: 'insertLineBreak', bubbles: true, cancelable: true, composed: true
                        }));
                        document.activeElement.dispatchEvent(new InputEvent('input', {
                            inputType: 'insertLineBreak', bubbles: true, composed: true
                        }));
                        document.activeElement.dispatchEvent(new KeyboardEvent('keyup', {
                            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
                        }));
                    } else {
                        var keyCode = char.charCodeAt(0);

                        // keydown
                        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
                            key: char, code: '', keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true
                        }));

                        // keypress (deprecated but some frameworks still listen)
                        document.activeElement.dispatchEvent(new KeyboardEvent('keypress', {
                            key: char, code: '', keyCode: keyCode, which: keyCode, charCode: keyCode, bubbles: true, cancelable: true
                        }));

                        // beforeinput + input (the actual insertion)
                        document.activeElement.dispatchEvent(new InputEvent('beforeinput', {
                            data: char, inputType: 'insertText', bubbles: true, cancelable: true, composed: true
                        }));

                        // Actually insert the character
                        var ae = document.activeElement;
                        if (ae.isContentEditable || ae.getAttribute('contenteditable') === 'true') {
                            document.execCommand('insertText', false, char);
                        } else if (ae.value !== undefined) {
                            var start = ae.selectionStart || ae.value.length;
                            var end = ae.selectionEnd || ae.value.length;
                            var before = ae.value.substring(0, start);
                            var after = ae.value.substring(end);
                            var nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ae), 'value');
                            if (nativeSetter && nativeSetter.set) {
                                nativeSetter.set.call(ae, before + char + after);
                            } else {
                                ae.value = before + char + after;
                            }
                            ae.selectionStart = ae.selectionEnd = start + 1;
                        }

                        document.activeElement.dispatchEvent(new InputEvent('input', {
                            data: char, inputType: 'insertText', bubbles: true, composed: true
                        }));

                        // keyup
                        document.activeElement.dispatchEvent(new KeyboardEvent('keyup', {
                            key: char, code: '', keyCode: keyCode, which: keyCode, bubbles: true
                        }));
                    }

                    if (i < text.length - 1) await sleep(5);
                }

                return JSON.stringify({ success: true, typed: text.length });
            })()`;

            try {
                const typeRaw = await this.browserApp.runOnActiveWebview(taskId, typeScript);
                const typeResult = typeof typeRaw === 'string' ? JSON.parse(typeRaw) : typeRaw;
                if (!typeResult.success) return JSON.stringify(typeResult);
            } catch (err: any) {
                return JSON.stringify({ success: false, error: err.message || String(err) });
            }
        }

        // Step 3: Press Enter if requested
        if (args.pressEnter) {
            const enterScript = `(() => {
                var ae = document.activeElement;
                if (!ae) return JSON.stringify({ success: true });
                var enterEvt = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
                ae.dispatchEvent(new KeyboardEvent('keydown', enterEvt));
                ae.dispatchEvent(new KeyboardEvent('keypress', enterEvt));
                ae.dispatchEvent(new KeyboardEvent('keyup', enterEvt));
                var form = ae.closest && ae.closest('form');
                if (form) {
                    var submitEvt = new Event('submit', { bubbles: true, cancelable: true });
                    if (form.dispatchEvent(submitEvt)) {
                        if (typeof form.requestSubmit === 'function') form.requestSubmit();
                    }
                }
                return JSON.stringify({ success: true });
            })()`;

            try {
                await this.browserApp.runOnActiveWebview(taskId, enterScript);
            } catch {
                // Non-critical
            }
        }

        return JSON.stringify({ success: true, index: idx });
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
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        const dy = args.direction === 'up' ? -args.amount : args.amount;
        const script = `(() => {
            window.scrollBy(0, ${dy});
            var scrollY = Math.round(window.scrollY);
            var scrollHeight = document.documentElement.scrollHeight;
            var viewportHeight = window.innerHeight;
            var atTop = scrollY <= 0;
            var atBottom = scrollY + viewportHeight >= scrollHeight - 1;
            return JSON.stringify({
                success: true,
                scrollY: scrollY,
                scrollHeight: scrollHeight,
                viewportHeight: viewportHeight,
                atTop: atTop,
                atBottom: atBottom,
                percentScrolled: Math.round(scrollY / Math.max(scrollHeight - viewportHeight, 1) * 100)
            });
        })()`;

        try {
            const raw = await this.browserApp.runOnActiveWebview(taskId, script);
            return typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserGoBack ==========

const BrowserGoBackArgsSchema = z.object({});

export class BrowserGoBackTool extends BaseTool<typeof BrowserGoBackArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserGoBack', '在浏览器中后退到上一个页面，返回后退后的页面 URL', BrowserGoBackArgsSchema);
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
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        try {
            await this.browserApp.callRendererBrowser(taskId, 'browserGoBack');
            await new Promise((r) => setTimeout(r, 300));
            const script = `JSON.stringify({ url: location.href, title: document.title })`;
            const raw = await this.browserApp.runOnActiveWebview(taskId, script);
            const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return JSON.stringify({ success: true, url: info.url, title: info.title });
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserGoForward ==========

const BrowserGoForwardArgsSchema = z.object({});

export class BrowserGoForwardTool extends BaseTool<typeof BrowserGoForwardArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserGoForward', '在浏览器中前进到下一个页面，返回前进后的页面 URL', BrowserGoForwardArgsSchema);
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
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        try {
            await this.browserApp.callRendererBrowser(taskId, 'browserGoForward');
            await new Promise((r) => setTimeout(r, 300));
            const script = `JSON.stringify({ url: location.href, title: document.title })`;
            const raw = await this.browserApp.runOnActiveWebview(taskId, script);
            const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return JSON.stringify({ success: true, url: info.url, title: info.title });
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserRefresh ==========

const BrowserRefreshArgsSchema = z.object({});

export class BrowserRefreshTool extends BaseTool<typeof BrowserRefreshArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserRefresh', '刷新当前浏览器页面，返回刷新后的页面 URL', BrowserRefreshArgsSchema);
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
        _args: z.output<typeof BrowserRefreshArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        try {
            await this.browserApp.callRendererBrowser(taskId, 'browserRefresh');
            await new Promise((r) => setTimeout(r, 800));
            const script = `JSON.stringify({ url: location.href, title: document.title })`;
            const raw = await this.browserApp.runOnActiveWebview(taskId, script);
            const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return JSON.stringify({ success: true, url: info.url, title: info.title });
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserExtractContent ==========

const BrowserExtractContentArgsSchema = z.object({
    selector: z.string().optional().describe('可选的 CSS 选择器，只提取匹配元素内的内容。不提供则提取整个页面正文。'),
    includeLinks: z.boolean().default(true).describe('是否包含链接列表，默认 true'),
    maxLength: z.number().int().default(30000).describe('提取文本的最大字符数，默认 30000')
});

export class BrowserExtractContentTool extends BaseTool<typeof BrowserExtractContentArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserExtractContent',
            '提取当前页面的结构化文本内容（标题、正文、链接等）。可通过 CSS 选择器限定提取范围。',
            BrowserExtractContentArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'running') body.push(chalk.dim('  ⏳ 正在提取内容…'));
        else if (toolcall.status === 'success') {
            try {
                const r = JSON.parse(toolcall.result || '{}');
                body.push(chalk.dim('  标题: ') + chalk.cyan(truncText(String(r.title || ''), width - 14)));
                const textLen = r.text?.length ?? 0;
                body.push(chalk.dim('  文本长度: ') + chalk.green(String(textLen) + ' 字符'));
            } catch {
                body.push(chalk.dim('  ✓ 已提取'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }
        return new Card({ icon: '📄', title: '提取内容', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserExtractContentArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        const selectorEscaped = args.selector ? JSON.stringify(args.selector) : 'null';
        const script = `(() => {
            var maxLen = ${args.maxLength};
            var selector = ${selectorEscaped};
            var root = selector ? document.querySelector(selector) : document.body;
            if (!root) return JSON.stringify({ success: false, error: '选择器 ' + selector + ' 未匹配到任何元素' });

            var text = (root.innerText || '').slice(0, maxLen);

            var result = {
                title: document.title,
                url: location.href,
                text: text,
                textLength: (root.innerText || '').length
            };

            ${
                args.includeLinks
                    ? `
            var links = [];
            var allLinks = root.querySelectorAll('a[href]');
            for (var i = 0; i < Math.min(allLinks.length, 80); i++) {
                var a = allLinks[i];
                var t = (a.innerText || '').trim();
                if (t && a.href) links.push({ text: t.slice(0, 100), href: a.href });
            }
            result.links = links;
            `
                    : ''
            }

            return JSON.stringify(result);
        })()`;

        try {
            const raw = await this.browserApp.runOnActiveWebview(taskId, script);
            return typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserGetHtml ==========

const BrowserGetHtmlArgsSchema = z.object({
    selector: z
        .string()
        .optional()
        .describe('CSS 选择器，获取匹配元素的 outerHTML。不提供则返回完整页面 HTML（可能非常大）。')
});

export class BrowserGetHtmlTool extends BaseTool<typeof BrowserGetHtmlArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserGetHtml', '获取页面的原始 HTML 或指定 CSS 选择器匹配的元素的 HTML', BrowserGetHtmlArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.selector) {
            body.push(chalk.dim('  选择器: ') + chalk.yellow(truncText(String(args.selector), width - 14)));
        }
        if (toolcall.status === 'running') body.push(chalk.dim('  ⏳ 正在获取…'));
        else if (toolcall.status === 'success') {
            const len = toolcall.result?.length ?? 0;
            body.push(chalk.dim('  HTML 长度: ') + chalk.green(String(len) + ' 字符'));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }
        return new Card({ icon: '🏷️', title: '获取 HTML', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserGetHtmlArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        const selectorEscaped = args.selector ? JSON.stringify(args.selector) : 'null';
        const script = `(() => {
            var selector = ${selectorEscaped};
            if (selector) {
                var el = document.querySelector(selector);
                if (!el) return JSON.stringify({ success: false, error: '选择器 ' + selector + ' 未匹配到任何元素' });
                return JSON.stringify({ success: true, html: el.outerHTML.slice(0, 100000) });
            } else {
                return JSON.stringify({ success: true, html: document.documentElement.outerHTML.slice(0, 200000) });
            }
        })()`;

        try {
            const raw = await this.browserApp.runOnActiveWebview(taskId, script);
            const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!result.success) return JSON.stringify(result);
            return result.html;
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserExecuteScript ==========

const BrowserExecuteScriptArgsSchema = z.object({
    script: z.string().describe('要在页面中执行的 JavaScript 代码，代码的返回值会被返回给调用者')
});

export class BrowserExecuteScriptTool extends BaseTool<typeof BrowserExecuteScriptArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'browserExecuteScript',
            '在当前页面中执行任意 JavaScript 代码并返回结果。用于高级页面交互或数据提取，当其他工具无法满足需求时使用。',
            BrowserExecuteScriptArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const script = args?.['script'];
        const body: string[] = [];

        if (script) {
            body.push(chalk.dim('脚本: ') + chalk.yellow(truncText(String(script), width - 14)));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 正在执行脚本…'));
        } else if (toolcall.status === 'success') {
            body.push(chalk.dim('  ✓ 执行完成'));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '⚡',
            title: '执行脚本',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserExecuteScriptArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        try {
            const data = await this.browserApp.runOnActiveWebview(taskId, args.script);
            return JSON.stringify({ success: true, result: data });
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserListTabs ==========

const BrowserListTabsArgsSchema = z.object({});

export class BrowserListTabsTool extends BaseTool<typeof BrowserListTabsArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserListTabs', '列出当前任务浏览器中所有打开的标签页', BrowserListTabsArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const r = JSON.parse(toolcall.result);
                const tabs = r.tabs || [];
                body.push(chalk.dim('  标签页数: ') + chalk.green(String(tabs.length)));
                for (const t of tabs.slice(0, 5)) {
                    const mark = t.active ? chalk.green('▸ ') : '  ';
                    body.push(mark + chalk.dim(`[${t.id}] `) + chalk.cyan(truncText(t.title || t.url, width - 20)));
                }
            } catch {
                body.push(chalk.dim('  ✓ 已获取'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }
        return new Card({ icon: '📑', title: '标签页列表', status: statusDisplay(toolcall.status), body }).render(
            width
        );
    }

    private async handleExecute(
        _args: z.output<typeof BrowserListTabsArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        try {
            const tabs = await this.browserApp.callRendererBrowser(taskId, 'browserListTabs');
            return JSON.stringify({ success: true, tabs });
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserSwitchTab ==========

const BrowserSwitchTabArgsSchema = z.object({
    tabId: z.number().int().describe('要切换到的标签页 ID，通过 browserListTabs 获取')
});

export class BrowserSwitchTabTool extends BaseTool<typeof BrowserSwitchTabArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserSwitchTab', '切换到指定的浏览器标签页', BrowserSwitchTabArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.tabId !== undefined) body.push(chalk.dim('  标签页 ID: ') + chalk.yellow(String(args.tabId)));
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已切换'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '🔀', title: '切换标签页', status: statusDisplay(toolcall.status), body }).render(
            width
        );
    }

    private async handleExecute(
        args: z.output<typeof BrowserSwitchTabArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        try {
            await this.browserApp.callRendererBrowser(taskId, 'browserSwitchTab', args.tabId);
            return JSON.stringify({ success: true, tabId: args.tabId });
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}

// ========== browserCloseTab ==========

const BrowserCloseTabArgsSchema = z.object({
    tabId: z.number().int().describe('要关闭的标签页 ID，通过 browserListTabs 获取')
});

export class BrowserCloseTabTool extends BaseTool<typeof BrowserCloseTabArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('browserCloseTab', '关闭指定的浏览器标签页', BrowserCloseTabArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.tabId !== undefined) body.push(chalk.dim('  标签页 ID: ') + chalk.yellow(String(args.tabId)));
        if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已关闭'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '❌', title: '关闭标签页', status: statusDisplay(toolcall.status), body }).render(
            width
        );
    }

    private async handleExecute(
        args: z.output<typeof BrowserCloseTabArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return JSON.stringify({ success: false, error: 'No task context' });

        try {
            await this.browserApp.callRendererBrowser(taskId, 'browserCloseTab', args.tabId);
            return JSON.stringify({ success: true, tabId: args.tabId });
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err.message || String(err) });
        }
    }
}
