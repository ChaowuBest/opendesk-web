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
 * Each tool is a thin shell that delegates to BrowserController from
 * embedBrowserUse. The controller encapsulates all CDP / renderer bridge
 * logic so it can be reused by other Electron apps.
 */

import { BaseTool } from '../../aikernel/tool';
import { ToolCall } from '../../aikernel/messages';
import { Card } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import chalk from 'chalk';
import { z } from 'zod';
import { BrowserManager, BrowserController } from '../../../common/embedBrowserUse/main';
import type { TaskState } from '../../aikernel/states/tasks';
import type { PermissionRequest } from '../../aikernel/security/permission.js';
import type { BrowserApplication } from './app';
import { logger } from '../../utils/logger.js';
import { Setting } from '../../utils/setting.js';
import { cleanPathInput, fromMsysPath, getHomePath, normalizePath } from '../../../utils/path.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(data: Record<string, any>): string {
    return JSON.stringify({ success: true, ...data });
}

function fail(error: string): string {
    return JSON.stringify({ success: false, error });
}

function getWorkingDirectory(taskState?: TaskState): string {
    return taskState?.getWorkspace() || Setting.getInstance().getEffectiveWorkspace();
}

function sanitizeUploadPath(inputPath: string, basePath: string): string {
    if (!inputPath || typeof inputPath !== 'string') return '';

    let p = cleanPathInput(inputPath)
        .replace(/\x08/g, '\\b')
        .replace(/\x09/g, '\\t')
        .replace(/\x0A/g, '\\n')
        .replace(/\x0C/g, '\\f')
        .replace(/\x0D/g, '\\r');

    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
        p = getHomePath() + p.slice(1);
    }

    p = fromMsysPath(p);
    p = path.isAbsolute(p) ? path.resolve(p) : path.resolve(basePath, p);
    p = normalizePath(p);
    p = p.replace(/(?<!:)\/{2,}/g, '/');
    return p;
}

function getUploadInputPaths(args: { filePath?: string; filePaths?: string[] }): string[] {
    const inputs: string[] = [];
    if (args.filePath) inputs.push(args.filePath);
    if (Array.isArray(args.filePaths)) inputs.push(...args.filePaths);
    return inputs.filter((p) => typeof p === 'string' && p.trim().length > 0);
}

async function validateUploadFiles(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
            throw new Error(`Upload path is not a file: ${filePath}`);
        }
    }
}

/**
 * Get or create a BrowserController for the given task.
 * Uses the BrowserApplication's main window to create the controller.
 */
function getController(app: BrowserApplication, taskId: string) {
    return BrowserManager.getOrCreateController(taskId);
}

/**
 * 在工具操作成功后，可选地自动获取页面快照。
 * 当 doSnapshot 为 true 时，等待 500ms 后执行 snapshot 并拼入返回结果。
 * snapshot 失败不影响原操作结果。
 */
async function withSnapshot(
    ctrl: BrowserController,
    doSnapshot: boolean,
    result: Record<string, any>
): Promise<Record<string, any>> {
    if (!doSnapshot) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
        const snapshot = await ctrl.snapshot();
        const lines: string[] = [];
        lines.push('- Page URL: ' + snapshot.url);
        if (snapshot.title) lines.push('- Page Title: ' + snapshot.title);
        lines.push('- Viewport: ' + snapshot.viewport.width + 'x' + snapshot.viewport.height);
        if (snapshot.scroll.x || snapshot.scroll.y)
            lines.push('- Scroll: ' + snapshot.scroll.x + ',' + snapshot.scroll.y);
        lines.push('');
        lines.push('[Accessibility Snapshot]');
        lines.push(snapshot.ariaSnapshot);
        return { ...result, snapshot: lines.join('\n') };
    } catch {
        // snapshot 失败不影响原操作结果
        return result;
    }
}

// ========== navigate ==========

const BrowserNavigateArgsSchema = z.object({
    url: z.string().describe('要访问的网址，例如 https://www.baidu.com'),
    newTab: z.boolean().default(false).describe('是否在新标签页中打开，默认 false'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取页面快照，默认 false')
});

export class BrowserNavigateTool extends BaseTool<typeof BrowserNavigateArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'navigate',
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

        try {
            const ctrl = getController(this.browserApp, taskId);
            const result = await ctrl.navigate(args.url, args.newTab);
            if (result.error) return fail(result.error);
            const finalResult = await withSnapshot(ctrl, args.snapshot, { url: result.url, title: result.title });
            return ok(finalResult);
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== snapshot ==========

const BrowserSnapshotArgsSchema = z.object({});

export class BrowserSnapshotTool extends BaseTool<typeof BrowserSnapshotArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'snapshot',
            '获取当前页面的无障碍（Accessibility）快照，以 YAML 格式返回完整的 ARIA 树结构。每个可交互元素标注 ref（如 e0、e3），用于后续 click / type 等操作的 target 定位。这是与页面交互前的必要步骤。',
            BrowserSnapshotArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'success' && toolcall.result) {
            // Extract page info from the markdown-formatted result
            const urlMatch = toolcall.result.match(/- Page URL: (.+)/);
            const titleMatch = toolcall.result.match(/- Page Title: (.+)/);
            if (urlMatch) body.push(chalk.dim('  URL: ') + chalk.cyan(truncText(urlMatch[1], width - 16)));
            if (titleMatch) body.push(chalk.dim('  标题: ') + chalk.white(truncText(titleMatch[1], width - 16)));
            // Count refs in YAML to report element count
            const refCount = (toolcall.result.match(/\[ref=e\d+\]/g) || []).length;
            body.push(chalk.dim('  可交互元素: ') + chalk.green(String(refCount) + ' 个'));
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
            const ctrl = getController(this.browserApp, taskId);
            const snapshot = await ctrl.snapshot();

            const lines: string[] = [];
            lines.push('- Page URL: ' + snapshot.url);
            if (snapshot.title) lines.push('- Page Title: ' + snapshot.title);
            lines.push('- Viewport: ' + snapshot.viewport.width + 'x' + snapshot.viewport.height);
            if (snapshot.scroll.x || snapshot.scroll.y)
                lines.push('- Scroll: ' + snapshot.scroll.x + ',' + snapshot.scroll.y);
            lines.push('');
            lines.push('[Accessibility Snapshot]');
            lines.push(snapshot.ariaSnapshot);
            return lines.join('\n');
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== click ==========

const BrowserClickArgsSchema = z.object({
    target: z.string().describe('要点击的元素：使用 ref（如 e3，从 snapshot 获取）或 CSS 选择器'),
    button: z.enum(['left', 'right', 'middle']).default('left').describe('鼠标按钮，默认 left'),
    doubleClick: z.boolean().default(false).describe('是否双击'),
    modifiers: z
        .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
        .optional()
        .describe('修饰键'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取页面快照，默认 false')
});

export class BrowserClickTool extends BaseTool<typeof BrowserClickArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'click',
            '点击页面元素。使用 ref（从 snapshot 获取，如 e3）或 CSS 选择器定位。通过 CDP 发送真实鼠标事件，兼容 React/Vue 等所有前端框架。',
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
            const ctrl = getController(this.browserApp, taskId);
            const result = await ctrl.click(args.target, {
                button: args.button,
                doubleClick: args.doubleClick,
                modifiers: args.modifiers
            });
            return ok(await withSnapshot(ctrl, args.snapshot, result));
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== type ==========

const BrowserTypeArgsSchema = z.object({
    target: z.string().describe('要输入的目标元素：ref（如 e3）或 CSS 选择器'),
    text: z.string().describe('要输入的文本内容'),
    clearFirst: z.boolean().default(true).describe('输入前是否先清空已有内容，默认 true'),
    submit: z.boolean().default(false).describe('输入完成后是否按 Enter 提交，默认 false'),
    slowly: z
        .boolean()
        .default(false)
        .describe('是否逐字符输入（触发页面逐键事件处理器）。默认 false（一次性填入整段文本）。'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取页面快照，默认 false')
});

export class BrowserTypeTool extends BaseTool<typeof BrowserTypeArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'type',
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
            const ctrl = getController(this.browserApp, taskId);
            const result = await ctrl.type(args.target, args.text, {
                clearFirst: args.clearFirst,
                submit: args.submit,
                slowly: args.slowly
            });
            return ok(await withSnapshot(ctrl, args.snapshot, result));
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== uploadFile ==========

const BrowserUploadFileArgsSchema = z.object({
    target: z
        .string()
        .describe(
            '上传控件的 ref（如 e3、e5-e3）或 CSS 选择器。可以是 input[type=file]、label 或触发文件选择的上传按钮。'
        ),
    filePath: z.string().optional().describe('要上传的单个本地文件路径。支持绝对路径、相对工作区路径和 ~/ 前缀。'),
    filePaths: z
        .array(z.string())
        .optional()
        .describe('要上传的多个本地文件路径。目标 input 必须支持 multiple；也可以只传一个文件。'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取页面快照，默认 false')
});

export class BrowserUploadFileTool extends BaseTool<typeof BrowserUploadFileArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'uploadFile',
            '向网页上传本地文件。使用 snapshot 得到上传控件 ref 后调用本工具，直接设置关联的 input[type=file]，不会弹出系统文件选择窗口。适用于图片上传、附件上传等控件。',
            BrowserUploadFileArgsSchema
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    getDeclaredPermissions(
        args: z.output<typeof BrowserUploadFileArgsSchema>,
        taskState?: TaskState
    ): PermissionRequest[] {
        const basePath = getWorkingDirectory(taskState);
        const seen = new Set<string>();
        const permissions: PermissionRequest[] = [];
        for (const inputPath of getUploadInputPaths(args)) {
            const filePath = sanitizeUploadPath(inputPath, basePath);
            if (!filePath || seen.has(filePath)) continue;
            seen.add(filePath);
            permissions.push({ resourceType: 'file', action: 'read', resourcePath: filePath });
        }
        return permissions;
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        const paths = getUploadInputPaths(args || {});
        if (args?.target) body.push(chalk.dim('  目标: ') + chalk.yellow(truncText(String(args.target), width - 14)));
        if (paths.length > 0) {
            const fileLabel =
                paths.length === 1 ? path.basename(paths[0]) : `${paths.length} 个文件：${path.basename(paths[0])}…`;
            body.push(chalk.dim('  文件: ') + chalk.cyan(truncText(fileLabel, width - 14)));
        }
        if (toolcall.status === 'running') body.push(chalk.dim('  ⏳ 正在上传…'));
        else if (toolcall.status === 'success') body.push(chalk.dim('  ✓ 已设置文件'));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({ icon: '📎', title: '上传文件', status: statusDisplay(toolcall.status), body }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserUploadFileArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        const rawPaths = getUploadInputPaths(args);
        if (rawPaths.length === 0) {
            return fail('必须提供 filePath 或 filePaths');
        }

        try {
            const basePath = getWorkingDirectory(taskState);
            const filePaths = rawPaths.map((p) => sanitizeUploadPath(p, basePath));
            await validateUploadFiles(filePaths);

            const ctrl = getController(this.browserApp, taskId);
            const result = await ctrl.uploadFile(args.target, filePaths);
            return ok(await withSnapshot(ctrl, args.snapshot, result));
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== hover ==========

const BrowserHoverArgsSchema = z.object({
    target: z.string().describe('要悬停的元素：ref（如 e3）或 CSS 选择器'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取页面快照，默认 false')
});

export class BrowserHoverTool extends BaseTool<typeof BrowserHoverArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'hover',
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
            const ctrl = getController(this.browserApp, taskId);
            const result = await ctrl.hover(args.target);
            return ok(result);
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== pressKey ==========

const BrowserPressKeyArgsSchema = z.object({
    key: z.string().describe('按键名称，如 Enter、Tab、Escape、ArrowDown、a、1 等'),
    modifiers: z
        .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
        .optional()
        .describe('修饰键'),
    iframeRef: z
        .string()
        .optional()
        .describe('如果焦点在 iframe 内，指定该 iframe 的 ref（如 e3 或 e3-e5），确保按键事件在 iframe 内触发'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取页面快照，默认 false')
});

export class BrowserPressKeyTool extends BaseTool<typeof BrowserPressKeyArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'pressKey',
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
            const ctrl = getController(this.browserApp, taskId);
            const result = await ctrl.pressKey(args.key, args.modifiers, args.iframeRef);
            return ok(result);
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== selectOption ==========

const BrowserSelectOptionArgsSchema = z.object({
    target: z.string().describe('select 元素的 ref（如 e3）或 CSS 选择器'),
    values: z.array(z.string()).describe('要选择的 option value 值列表')
});

export class BrowserSelectOptionTool extends BaseTool<typeof BrowserSelectOptionArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'selectOption',
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
            const ctrl = getController(this.browserApp, taskId);
            const result = await ctrl.selectOption(args.target, args.values);
            return ok(await withSnapshot(ctrl, args.snapshot, result));
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== scrollTo ==========

const BrowserScrollToArgsSchema = z.object({
    ref: z.string().describe('目标元素的 ref（如 e3）。支持嵌套 ref（如 e5-e3）定位 iframe 内元素'),
    block: z
        .enum(['start', 'center', 'end', 'nearest'])
        .default('nearest')
        .describe('垂直对齐方式，默认 nearest（最小滚动距离）'),
    inline: z.enum(['start', 'center', 'end', 'nearest']).default('nearest').describe('水平对齐方式，默认 nearest'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取页面快照，默认 false')
});

export class BrowserScrollToTool extends BaseTool<typeof BrowserScrollToArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('scrollTo', '滚动到指定元素。自动处理页面内和 iframe 内的可滚动容器。', BrowserScrollToArgsSchema);
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.ref) body.push(chalk.dim('  目标: ') + chalk.yellow('#' + args.ref));
        if (toolcall.status === 'success') {
            const r = toolcall.result as any;
            body.push(chalk.dim('  ✓ ') + chalk.green(r?.tag || '已滚动'));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }
        return new Card({ icon: '🔍', title: '滚动到元素', status: statusDisplay(toolcall.status), body }).render(
            width
        );
    }

    private async handleExecute(
        args: z.output<typeof BrowserScrollToArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            const ctrl = getController(this.browserApp, taskId);
            const result = await ctrl.scrollTo(args.ref, {
                block: args.block,
                inline: args.inline
            });
            return ok(result);
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== goBack ==========

const BrowserGoBackArgsSchema = z.object({});

export class BrowserGoBackTool extends BaseTool<typeof BrowserGoBackArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('goBack', '在浏览器中后退到上一个页面', BrowserGoBackArgsSchema);
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
            const ctrl = getController(this.browserApp, taskId);
            const info = await ctrl.goBack();
            if (info.error) return fail(`后退失败: ${info.error}`);
            const finalResult = await withSnapshot(ctrl, _args.snapshot, { url: info.url, title: info.title });
            return ok(finalResult);
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== goForward ==========

const BrowserGoForwardArgsSchema = z.object({
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取页面快照，默认 false')
});

export class BrowserGoForwardTool extends BaseTool<typeof BrowserGoForwardArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('goForward', '在浏览器中前进到下一个页面', BrowserGoForwardArgsSchema);
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
            const ctrl = getController(this.browserApp, taskId);
            const info = await ctrl.goForward();
            if (info.error) return fail(`前进失败: ${info.error}`);
            return ok(info);
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== reload ==========

const BrowserReloadArgsSchema = z.object({
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取页面快照，默认 false')
});

export class BrowserReloadTool extends BaseTool<typeof BrowserReloadArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super('reload', '刷新当前浏览器页面', BrowserReloadArgsSchema);
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
            const ctrl = getController(this.browserApp, taskId);
            const info = await ctrl.reload();
            if (info.error) return fail(`刷新后页面加载失败: ${info.error}`);
            return ok(info);
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== evaluate ==========

const BrowserEvaluateArgsSchema = z.object({
    expression: z.string().describe('要在页面中执行的 JavaScript 表达式，返回值将被序列化后返回'),
    iframeRef: z
        .string()
        .optional()
        .describe('如果要在 iframe 内执行，指定该 iframe 的 ref（如 e3 或 e3-e5）。不指定则在主页面执行'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取页面快照，默认 false')
});

export class BrowserEvaluateTool extends BaseTool<typeof BrowserEvaluateArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'evaluate',
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
            const ctrl = getController(this.browserApp, taskId);
            const result = await ctrl.evaluate(args.expression, args.iframeRef);
            return ok({ result });
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== tabs ==========

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
            'tabs',
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
            const ctrl = getController(this.browserApp, taskId);
            const result = await ctrl.tabs(args.action, args.tabId, args.url);
            return ok(await withSnapshot(ctrl, args.snapshot, result));
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== waitFor ==========

const BrowserWaitForArgsSchema = z.object({
    text: z.string().optional().describe('等待页面出现指定文本'),
    textGone: z.string().optional().describe('等待页面中指定文本消失'),
    timeout: z.number().default(10).describe('超时时间（秒），默认 10'),
    iframeRef: z.string().optional().describe('如果要在 iframe 内检测文本，指定该 iframe 的 ref（如 e3 或 e3-e5）'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取页面快照，默认 false')
});

export class BrowserWaitForTool extends BaseTool<typeof BrowserWaitForArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'waitFor',
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

        try {
            const ctrl = getController(this.browserApp, taskId);
            const result = await ctrl.waitFor({
                text: args.text,
                textGone: args.textGone,
                timeout: args.timeout,
                iframeRef: args.iframeRef
            });
            return ok(result);
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== dropHistory ==========

const BrowserDropHistoryArgsSchema = z.object({
    startTime: z.number().optional().describe('起始时间戳（Unix 毫秒），删除此时间点之后的历史记录'),
    endTime: z.number().optional().describe('结束时间戳（Unix 毫秒），删除此时间点之前的历史记录'),
    domains: z
        .array(z.string())
        .optional()
        .describe('要删除的域名列表，如 ["google.com", "baidu.com"]，匹配精确域名及其子域名')
});

export class BrowserDropHistoryTool extends BaseTool<typeof BrowserDropHistoryArgsSchema> {
    constructor() {
        super(
            'dropHistory',
            '按条件批量删除浏览器历史记录。支持按时间范围和/或域名筛选，可同时指定多个条件（AND 逻辑）。至少需要指定一个筛选条件。',
            BrowserDropHistoryArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.startTime || args?.endTime) {
            const start = args.startTime ? new Date(args.startTime).toLocaleString('zh-CN') : '不限';
            const end = args.endTime ? new Date(args.endTime).toLocaleString('zh-CN') : '不限';
            body.push(chalk.dim('  时间: ') + chalk.cyan(`${start} ~ ${end}`));
        }
        if (args?.domains?.length) {
            body.push(chalk.dim('  域名: ') + chalk.cyan(args.domains.join(', ')));
        }
        if (toolcall.status === 'running') body.push(chalk.dim('  ⏳ 正在删除…'));
        else if (toolcall.status === 'success') {
            try {
                const r = JSON.parse(toolcall.result || '{}');
                body.push(chalk.dim('  ✓ 已删除 ') + chalk.green(`${r.deleted ?? 0} 条记录`));
            } catch {
                body.push(chalk.dim('  ✓ 已删除'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }
        return new Card({ icon: '🗑️', title: '删除历史记录', status: statusDisplay(toolcall.status), body }).render(
            width
        );
    }

    private async handleExecute(
        args: z.output<typeof BrowserDropHistoryArgsSchema>,
        _taskState?: TaskState
    ): Promise<string> {
        if (!args.startTime && !args.endTime && (!args.domains || args.domains.length === 0)) {
            return fail('至少需要指定一个筛选条件（startTime/endTime 或 domains）');
        }

        const mainWin = BrowserManager.mainWindow;
        if (!mainWin || mainWin.isDestroyed()) {
            return fail('主窗口不可用，无法操作浏览器历史记录');
        }

        try {
            const script = `(() => {
                var STORAGE_KEY = 'opendesk-browser-history';
                var raw = localStorage.getItem(STORAGE_KEY);
                if (!raw) return JSON.stringify({ deleted: 0 });
                var history = JSON.parse(raw);
                var before = history.length;
                var startTime = ${args.startTime ?? 'null'};
                var endTime = ${args.endTime ?? 'null'};
                var domains = ${args.domains ? JSON.stringify(args.domains) : 'null'};
                history = history.filter(function(h) {
                    var timeMatch = true;
                    if (startTime !== null) timeMatch = timeMatch && h.timestamp >= startTime;
                    if (endTime !== null) timeMatch = timeMatch && h.timestamp <= endTime;
                    if (!timeMatch) return true;
                    if (domains && domains.length > 0) {
                        try {
                            var hostname = new URL(h.url).hostname;
                            var domainMatch = domains.some(function(d) {
                                return hostname === d || hostname.endsWith('.' + d);
                            });
                            return !domainMatch;
                        } catch(e) { return true; }
                    }
                    return !timeMatch;
                });
                localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
                window.dispatchEvent(new CustomEvent('opendesk-history-changed'));
                return JSON.stringify({ deleted: before - history.length });
            })()`;

            const resultStr = await mainWin.webContents.executeJavaScript(script);
            const result = typeof resultStr === 'string' ? JSON.parse(resultStr) : resultStr;
            logger.info(`dropHistory: deleted ${result.deleted} entries`);
            return ok({ deleted: result.deleted });
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}
