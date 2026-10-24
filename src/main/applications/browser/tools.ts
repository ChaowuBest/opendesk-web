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
import { t } from './locale/index.js';
import {
    ACCESSIBILITY_SNAPSHOT_HEADING,
    BrowserManager,
    BrowserController,
    renderSnapshotText
} from '../../../common/embedBrowserUse/main';
import type { TaskState } from '../../aikernel/states/tasks';
import type { PermissionRequest } from '../../aikernel/security/permission.js';
import type { BrowserApplication } from './app';
import { logger } from '../../utils/logger.js';
import { Setting, getTaskArtifactDirectory } from '../../utils/setting.js';
import { makeActionInvokeExpression, renderBrowserHintsFor, resolveActionHint } from './hints.js';
import { cleanPathInput, fromMsysPath, getHomePath, normalizePath } from '../../../utils/path.js';
import { randomUUID } from 'node:crypto';
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
 *
 * 返回值为多行 YAML 文本（而非 JSON），使落盘结果可直接 readFile/grep，
 * 同时快照默认走 diff 模式：只返回相对上一次快照变化的子树，体积更小；
 * 无上一次基准时（首次快照）自动回退完整快照。
 */
async function withSnapshot(
    ctrl: BrowserController,
    doSnapshot: boolean,
    result: Record<string, any>
): Promise<string> {
    const lines: string[] = [];
    // 渲染操作结果的结构化字段为 YAML 行（简单标量直出，嵌套值单行 JSON）
    for (const [key, value] of Object.entries(result)) {
        if (value === undefined || value === null || value === '') continue;
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        lines.push(`- ${key}: ${rendered}`);
    }
    // URL 变化检测与自动快照解耦：操作（trigger / click 等）导致页面跳转时，
    // 即便未请求自动快照也告知 agent 新 URL，避免对旧 ref 产生误解
    // （SPA 路由 / 表单提交等场景下页面已导航但 agent 看不到任何变化）。
    let urlChanged = false;
    try {
        const urlBefore = ctrl.getLastUrl();
        const info = await ctrl.getPageInfo();
        if (urlBefore !== undefined && urlBefore !== info.url) {
            lines.push(`- Page Changed: yes (${urlBefore} → ${info.url})`);
            urlChanged = true;
        }
    } catch {
        // 页面可能处于导航过渡中，忽略
    }
    if (doSnapshot) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
            // 自动快照场景下对比 snapshot 的 URL：若上面未检测到变化
            // （如延迟跳转），在此补充；已检测到则避免重复输出。
            const urlBefore = ctrl.getLastUrl();
            const snapshot = await ctrl.snapshot({ mode: 'diff' });
            if (!urlChanged && urlBefore !== undefined && urlBefore !== snapshot.url) {
                lines.push(`- Page Changed: yes (${urlBefore} → ${snapshot.url})`);
            }
            // 插件贡献的页面提示放在快照正文之前，让 agent 先看到可用动作与约束
            const hintLines = await renderBrowserHintsFor(ctrl, snapshot);
            if (hintLines.length > 0) lines.push('', ...hintLines);
            lines.push('');
            lines.push(ACCESSIBILITY_SNAPSHOT_HEADING);
            lines.push(snapshot.ariaSnapshot);
        } catch {
            // snapshot 失败不影响原操作结果
        }
    }
    return lines.join('\n');
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
            '在当前任务的嵌入式浏览器中打开指定的网页。支持在当前标签页或新标签页中打开。当前可见任务首次使用时可自动展示；后续及后台任务保持静默，不改变用户当前布局或标签。',
            BrowserNavigateArgsSchema,
            undefined,
            { 'zh-CN': '打开网页', 'en-US': 'Open Page' }
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const url = args?.['url'];
        const body: string[] = [];
        if (url) body.push(chalk.dim(t('cli.label.url')) + chalk.cyan(truncText(String(url), width - 14)));
        if (args?.newTab) body.push(chalk.dim(t('cli.newTab.inNewTab')));
        if (toolcall.status === 'running') body.push(chalk.dim(t('cli.newTab.running')));
        else if (toolcall.status === 'success') body.push(chalk.dim(t('cli.newTab.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '🌐',
            title: t('cli.newTab.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
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
            return withSnapshot(ctrl, args.snapshot, { url: result.url, title: result.title });
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== snapshot ==========

const BrowserSnapshotArgsSchema = z.object({
    mode: z
        .enum(['full', 'diff'])
        .default('full')
        .describe(
            '快照模式：full=完整快照（默认，仍会折叠噪声/重复区域）；diff=仅返回相对上一次快照变化的 ref 子树，体积更小，适合操作后确认页面变化'
        ),
    viewportOnly: z
        .boolean()
        .default(false)
        .describe(
            '仅聚焦当前视口：视口外且无交互后代的子树折叠为一行摘要，长页面体积显著更小。适合长列表/长文页滚动定位场景'
        ),
    ref: z
        .string()
        .optional()
        .describe(
            '只渲染指定 ref 的子树（如 e3，或嵌套 ref 如 e5-e3），返回该节点的完整 ARIA 内容。适合大快照被截断时按需取某区域（如商品价格区），无需 evaluate 兜底'
        )
});

export class BrowserSnapshotTool extends BaseTool<typeof BrowserSnapshotArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'snapshot',
            '获取当前页面的无障碍（Accessibility）快照，以 YAML 格式返回完整的 ARIA 树结构。每个可交互元素标注 ref（如 e0、e3），用于后续 click / type 等操作的 target 定位。这是与页面交互前的必要步骤。噪声区域（iframe、页脚、深层装饰）默认折叠为一行摘要，可用 explore(ref) 展开。',
            BrowserSnapshotArgsSchema,
            undefined,
            { 'zh-CN': '页面快照', 'en-US': 'Page Snapshot' }
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
            if (titleMatch)
                body.push(chalk.dim(t('cli.label.title')) + chalk.white(truncText(titleMatch[1], width - 16)));
            // Count refs in YAML to report element count
            const refCount = (toolcall.result.match(/\[ref=e\d+.*?\]/g) || []).length;
            body.push(
                chalk.dim(t('cli.label.interactive')) + chalk.green(t('cli.snapshot.refCount', { count: refCount }))
            );
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }
        return new Card({
            icon: '📊',
            title: t('cli.snapshot.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserSnapshotArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            const ctrl = getController(this.browserApp, taskId);
            const snapshot = await ctrl.snapshot({ mode: args.mode, viewportOnly: args.viewportOnly, ref: args.ref });

            // 插件贡献的页面提示置于快照最前面，作为本页可用动作与约束的说明
            return renderSnapshotText(snapshot, {
                prefixLines: await renderBrowserHintsFor(ctrl, snapshot),
                infoLines: args.mode === 'diff' ? [t('cli.snapshot.diffMode')] : []
            });
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== explore ==========

const BrowserExploreArgsSchema = z.object({
    ref: z
        .string()
        .describe(
            '要展开的元素 ref（如 e3，或嵌套 ref 如 e5-e3）。展开其在快照中被折叠（iframe / 页脚 / 深层装饰）的子树，返回完整内容'
        ),
    snapshot: z.boolean().default(false).describe('展开后是否再获取一次完整页面快照（默认 false，仅返回该 ref 的子树）')
});

export class BrowserExploreTool extends BaseTool<typeof BrowserExploreArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'explore',
            '展开快照中某个 ref 折叠的子树，返回其完整 ARIA 内容。默认快照会把 iframe、页脚、深层装饰等噪声区域折叠为一行摘要；当你需要查看其中具体内容（如页脚链接、某个 iframe 的内部结构）时，用 explore(ref) 按需展开，避免每次快照都把整页内容塞进上下文。',
            BrowserExploreArgsSchema,
            undefined,
            { 'zh-CN': '探索页面', 'en-US': 'Explore Page' }
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.ref) body.push(chalk.dim('  ref: ') + chalk.yellow(args.ref));
        if (toolcall.status === 'success') body.push(chalk.dim(t('cli.explore.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '🔬',
            title: t('cli.explore.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserExploreArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            const ctrl = getController(this.browserApp, taskId);
            const result = await ctrl.explore(args.ref);
            if (args.snapshot) {
                return withSnapshot(ctrl, true, { ariaSnapshot: result.ariaSnapshot });
            }
            return ok({ ariaSnapshot: result.ariaSnapshot });
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
            BrowserClickArgsSchema,
            undefined,
            { 'zh-CN': '点击元素', 'en-US': 'Click Element' }
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.target)
            body.push(chalk.dim(t('cli.label.target')) + chalk.yellow(truncText(String(args.target), width - 14)));
        if (toolcall.status === 'running') body.push(chalk.dim(t('cli.click.running')));
        else if (toolcall.status === 'success') body.push(chalk.dim(t('cli.click.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '👆',
            title: t('cli.click.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
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
            return withSnapshot(ctrl, args.snapshot, result);
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
            BrowserTypeArgsSchema,
            undefined,
            { 'zh-CN': '输入文本', 'en-US': 'Type Text' }
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.target)
            body.push(chalk.dim(t('cli.label.target')) + chalk.yellow(truncText(String(args.target), width - 14)));
        if (args?.text)
            body.push(chalk.dim(t('cli.label.text')) + chalk.cyan(truncText(String(args.text), width - 14)));
        if (args?.submit) body.push(chalk.dim('  + Enter'));
        if (toolcall.status === 'running') body.push(chalk.dim(t('cli.type.running')));
        else if (toolcall.status === 'success') body.push(chalk.dim(t('cli.type.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '⌨️',
            title: t('cli.type.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
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
            return withSnapshot(ctrl, args.snapshot, result);
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
            BrowserUploadFileArgsSchema,
            undefined,
            { 'zh-CN': '上传文件', 'en-US': 'Upload File' }
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
        if (args?.target)
            body.push(chalk.dim(t('cli.label.target')) + chalk.yellow(truncText(String(args.target), width - 14)));
        if (paths.length > 0) {
            const fileLabel =
                paths.length === 1
                    ? path.basename(paths[0])
                    : t('cli.upload.files', { count: paths.length, name: path.basename(paths[0]) });
            body.push(chalk.dim(t('cli.label.file')) + chalk.cyan(truncText(fileLabel, width - 14)));
        }
        if (toolcall.status === 'running') body.push(chalk.dim(t('cli.upload.running')));
        else if (toolcall.status === 'success') body.push(chalk.dim(t('cli.upload.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '📎',
            title: t('cli.upload.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserUploadFileArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        const rawPaths = getUploadInputPaths(args);
        if (rawPaths.length === 0) {
            return fail(t('error.filePathRequired'));
        }

        try {
            const basePath = getWorkingDirectory(taskState);
            const filePaths = rawPaths.map((p) => sanitizeUploadPath(p, basePath));
            await validateUploadFiles(filePaths);

            const ctrl = getController(this.browserApp, taskId);
            const result = await ctrl.uploadFile(args.target, filePaths);
            return withSnapshot(ctrl, args.snapshot, result);
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
            BrowserHoverArgsSchema,
            undefined,
            { 'zh-CN': '悬停', 'en-US': 'Hover' }
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.target)
            body.push(chalk.dim(t('cli.label.target')) + chalk.yellow(truncText(String(args.target), width - 14)));
        if (toolcall.status === 'success') body.push(chalk.dim(t('cli.hover.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '🖱️',
            title: t('cli.hover.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
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
            BrowserPressKeyArgsSchema,
            undefined,
            { 'zh-CN': '按键', 'en-US': 'Press Key' }
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.key) body.push(chalk.dim(t('cli.label.key')) + chalk.yellow(String(args.key)));
        if (toolcall.status === 'success') body.push(chalk.dim(t('cli.press.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '⌨️',
            title: t('cli.press.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
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
            BrowserSelectOptionArgsSchema,
            undefined,
            { 'zh-CN': '选择选项', 'en-US': 'Select Option' }
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.target)
            body.push(chalk.dim(t('cli.label.target')) + chalk.yellow(truncText(String(args.target), width - 14)));
        if (args?.values)
            body.push(chalk.dim(t('cli.label.value')) + chalk.cyan(truncText(JSON.stringify(args.values), width - 14)));
        if (toolcall.status === 'success') body.push(chalk.dim(t('cli.select.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '📋',
            title: t('cli.select.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
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
            return withSnapshot(ctrl, args.snapshot, result);
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
        super(
            'scrollTo',
            '滚动到指定元素。自动处理页面内和 iframe 内的可滚动容器。',
            BrowserScrollToArgsSchema,
            undefined,
            { 'zh-CN': '滚动', 'en-US': 'Scroll' }
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.ref) body.push(chalk.dim(t('cli.label.target')) + chalk.yellow('#' + args.ref));
        if (toolcall.status === 'success') {
            const r = toolcall.result as any;
            body.push(chalk.dim('  ✓ ') + chalk.green(r?.tag || t('cli.scrollTo.done')));
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }
        return new Card({
            icon: '🔍',
            title: t('cli.scrollTo.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
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
        super('goBack', '在浏览器中后退到上一个页面', BrowserGoBackArgsSchema, undefined, {
            'zh-CN': '后退',
            'en-US': 'Go Back'
        });
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'success') body.push(chalk.dim(t('cli.goBack.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '⬅',
            title: t('cli.goBack.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
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
            if (info.error) return fail(t('cli.goBack.fail', { error: info.error }));
            return withSnapshot(ctrl, _args.snapshot, { url: info.url, title: info.title });
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
        super('goForward', '在浏览器中前进到下一个页面', BrowserGoForwardArgsSchema, undefined, {
            'zh-CN': '前进',
            'en-US': 'Go Forward'
        });
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'success') body.push(chalk.dim(t('cli.goForward.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '➡',
            title: t('cli.goForward.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
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
            if (info.error) return fail(t('cli.goForward.fail', { error: info.error }));
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
        super('reload', '刷新当前浏览器页面', BrowserReloadArgsSchema, undefined, {
            'zh-CN': '刷新页面',
            'en-US': 'Reload Page'
        });
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        if (toolcall.status === 'success') body.push(chalk.dim(t('cli.reload.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '🔄',
            title: t('cli.reload.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
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
            if (info.error) return fail(t('cli.reload.fail', { error: info.error }));
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
            BrowserEvaluateArgsSchema,
            undefined,
            { 'zh-CN': '执行脚本', 'en-US': 'Execute Script' }
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.expression)
            body.push(chalk.dim(t('cli.label.script')) + chalk.yellow(truncText(String(args.expression), width - 14)));
        if (toolcall.status === 'running') body.push(chalk.dim(t('cli.execute.running')));
        else if (toolcall.status === 'success') body.push(chalk.dim(t('cli.execute.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '⚡',
            title: t('cli.execute.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
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

// ========== trigger ==========

const BrowserTriggerArgsSchema = z.object({
    action: z.string().describe('要触发的动作名称，来自快照 Browser Hints 中的 Action Hints 列表'),
    args: z
        .record(z.string(), z.unknown())
        .default({})
        .describe('动作参数对象，键名与该动作声明的参数一致，例如 { "keyword": "OpenHarmony" }'),
    tabId: z.number().int().optional().describe('在指定标签页中触发（默认当前活动标签页）。会先切换到该标签页'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取页面快照，默认 false')
});

export class BrowserTriggerTool extends BaseTool<typeof BrowserTriggerArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'trigger',
            '触发当前页面的 Action Hint（由插件为该站点注册的快捷动作）。动作列表见 snapshot 返回的 Browser Hints / Action Hints 小节，动作只在匹配的页面上可用。',
            BrowserTriggerArgsSchema,
            undefined,
            { 'zh-CN': '触发事件', 'en-US': 'Trigger Action' }
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.action)
            body.push(chalk.dim(t('cli.label.action')) + chalk.yellow(truncText(String(args.action), width - 16)));
        if (args?.args && Object.keys(args.args).length > 0)
            body.push(chalk.dim(t('cli.label.args')) + chalk.cyan(truncText(JSON.stringify(args.args), width - 16)));
        if (toolcall.status === 'running') body.push(chalk.dim(t('cli.trigger.running')));
        else if (toolcall.status === 'success') body.push(chalk.dim(t('cli.trigger.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '🎯',
            title: t('cli.trigger.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserTriggerArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            const ctrl = getController(this.browserApp, taskId);
            // action 由页面 URL 决定，因此先切到目标标签页再解析可用动作
            if (args.tabId !== undefined) await ctrl.tabs('switch', args.tabId);
            const page = await ctrl.getPageInfo();
            const { hint, available } = await resolveActionHint(ctrl, page, args.action);
            if (!hint) {
                return fail(
                    available.length > 0
                        ? t('cli.trigger.unavailableOnPage', { action: args.action, available: available.join(', ') })
                        : t('cli.trigger.noHints', { action: args.action })
                );
            }
            const result = await ctrl.evaluate(makeActionInvokeExpression(hint, args.args));
            return withSnapshot(ctrl, args.snapshot, { action: hint.name, result });
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
            BrowserTabsArgsSchema,
            undefined,
            { 'zh-CN': '标签页管理', 'en-US': 'Manage Tabs' }
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        const action = args?.action ?? 'list';
        body.push(chalk.dim(t('cli.label.operation')) + chalk.yellow(action));
        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const r = JSON.parse(toolcall.result);
                const tabs = r.tabs || [];
                if (tabs.length > 0) {
                    body.push(chalk.dim(t('cli.label.tabCount')) + chalk.green(String(tabs.length)));
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
        return new Card({
            icon: '📑',
            title: t('cli.tabs.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(args: z.output<typeof BrowserTabsArgsSchema>, taskState?: TaskState): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            const ctrl = getController(this.browserApp, taskId);
            const result = await ctrl.tabs(args.action, args.tabId, args.url);
            return withSnapshot(ctrl, args.snapshot, result);
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== screenshot ==========

const BrowserScreenshotArgsSchema = z.object({
    tabId: z.number().int().optional().describe('要截图的标签页 ID（默认当前活动标签页）。指定时会先切换到该标签页')
});

export class BrowserScreenshotTool extends BaseTool<typeof BrowserScreenshotArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'screenshot',
            '将浏览器标签页当前视口的内容截图为 PNG，保存到当前任务的 artifacts 目录并返回文件路径。可通过 tabId 指定标签页（会先切换到该标签页），默认截取当前活动标签页。',
            BrowserScreenshotArgsSchema,
            undefined,
            { 'zh-CN': '页面截图', 'en-US': 'Page Screenshot' }
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.tabId !== undefined) body.push(chalk.dim(t('cli.label.tab')) + chalk.yellow(String(args.tabId)));
        if (toolcall.status === 'running') body.push(chalk.dim(t('cli.screenshot.running')));
        else if (toolcall.status === 'success' && toolcall.result) {
            try {
                const r = JSON.parse(toolcall.result);
                if (r.path)
                    body.push(chalk.dim(t('cli.screenshot.saved')) + chalk.cyan(truncText(String(r.path), width - 16)));
            } catch {
                /* ok */
            }
        } else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '📸',
            title: t('cli.screenshot.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserScreenshotArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        const taskId = taskState?.task_id;
        if (!taskId) return fail('No task context');

        try {
            const ctrl = getController(this.browserApp, taskId);
            // 截图作用于当前活动 webview，与 trigger 相同：先切换到目标标签页
            if (args.tabId !== undefined) await ctrl.tabs('switch', args.tabId);
            const dataUri = await ctrl.captureScreenshot();

            const match = dataUri.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/);
            if (!match) return fail(t('cli.screenshot.badDataUri', { uri: dataUri.slice(0, 64) }));
            const ext = match[1].split('/')[1] || 'png';
            const fileName = `screenshot-${Date.now()}-${randomUUID()}.${ext}`;
            const filePath = path.join(getTaskArtifactDirectory(taskId), fileName);
            await fs.writeFile(filePath, Buffer.from(match[2], 'base64'));

            const page = await ctrl.getPageInfo();
            return ok({ path: filePath, tabId: args.tabId, url: page.url, title: page.title });
        } catch (err: any) {
            return fail(err.message || String(err));
        }
    }
}

// ========== download ==========

const BrowserDownloadArgsSchema = z.object({
    url: z.string().describe('要下载的远端文件 URL（http/https）'),
    path: z.string().describe('保存目标路径，必须是包含文件名的完整路径，不能是目录')
});

export class BrowserDownloadTool extends BaseTool<typeof BrowserDownloadArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'download',
            '将远端 URL 的文件下载并保存到本地指定路径。经由浏览器共享会话发起请求，自动携带登录 Cookie（包括 HttpOnly），可用于下载需要登录态的站点附件。path 必须是包含文件名的完整路径。',
            BrowserDownloadArgsSchema,
            undefined,
            { 'zh-CN': '下载文件', 'en-US': 'Download File' }
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    getDeclaredPermissions(
        args: z.output<typeof BrowserDownloadArgsSchema>,
        taskState?: TaskState
    ): PermissionRequest[] {
        const target = sanitizeUploadPath(args.path, getWorkingDirectory(taskState));
        if (!target) return [];
        return [{ resourceType: 'file', action: 'write', resourcePath: target }];
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.url) body.push(chalk.dim(t('cli.label.url')) + chalk.cyan(truncText(String(args.url), width - 14)));
        if (args?.path)
            body.push(chalk.dim(t('cli.label.file')) + chalk.yellow(truncText(String(args.path), width - 14)));
        if (toolcall.status === 'running') body.push(chalk.dim(t('cli.download.running')));
        else if (toolcall.status === 'success') body.push(chalk.dim(t('cli.download.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '📥',
            title: t('cli.download.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserDownloadArgsSchema>,
        taskState?: TaskState
    ): Promise<string> {
        // 仅允许 http/https，禁止 file: 等协议
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(args.url);
        } catch {
            return fail(t('error.downloadInvalidUrl', { url: args.url }));
        }
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return fail(t('error.downloadInvalidUrl', { url: args.url }));
        }

        const targetPath = sanitizeUploadPath(args.path, getWorkingDirectory(taskState));
        if (!targetPath || targetPath.endsWith('/') || targetPath.endsWith('\\')) {
            return fail(t('error.downloadPathRequired'));
        }
        const stat = await fs.stat(targetPath).catch(() => null);
        if (stat?.isDirectory()) {
            return fail(t('error.downloadPathIsDirectory', { path: targetPath }));
        }

        // 经浏览器共享 session（persist:opendesk-browser）发起请求：
        // 自动带上该 session 的全部 cookies（含 HttpOnly 登录态），与 webview 内请求等效
        const session = BrowserManager.browserSession;
        if (!session) return fail(t('error.sessionNotInitialized'));

        let response: Response;
        try {
            response = await session.fetch(args.url);
        } catch (err: any) {
            return fail(err?.message || String(err));
        }

        if (!response.ok) {
            return fail(t('error.downloadHttpStatus', { status: response.status, url: args.url }));
        }

        try {
            const buffer = Buffer.from(await response.arrayBuffer());
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.writeFile(targetPath, buffer);
            return ok({ path: targetPath, size: buffer.length, url: args.url });
        } catch (err: any) {
            return fail(err?.message || String(err));
        }
    }
}

// ========== waitFor ==========

const BrowserWaitForArgsSchema = z.object({
    text: z.string().optional().describe('等待页面出现指定文本'),
    textGone: z.string().optional().describe('等待页面中指定文本消失'),
    timeout: z.number().default(3).describe('超时时间（秒），默认 3'),
    iframeRef: z.string().optional().describe('如果要在 iframe 内检测文本，指定该 iframe 的 ref（如 e3 或 e3-e5）'),
    snapshot: z.boolean().default(false).describe('操作完成后是否自动获取页面快照，默认 false')
});

export class BrowserWaitForTool extends BaseTool<typeof BrowserWaitForArgsSchema> {
    private browserApp: BrowserApplication;

    constructor(browserApp: BrowserApplication) {
        super(
            'waitFor',
            '等待页面满足指定条件：出现指定文本 (text) 或文本消失 (textGone)。用于等待页面加载、动态内容渲染等。',
            BrowserWaitForArgsSchema,
            undefined,
            { 'zh-CN': '等待', 'en-US': 'Wait' }
        );
        this.browserApp = browserApp;
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.text)
            body.push(chalk.dim(t('cli.label.waitText')) + chalk.cyan(truncText(String(args.text), width - 16)));
        if (args?.textGone)
            body.push(chalk.dim(t('cli.label.waitGone')) + chalk.cyan(truncText(String(args.textGone), width - 16)));
        if (toolcall.status === 'running') body.push(chalk.dim(t('cli.wait.running')));
        else if (toolcall.status === 'success') body.push(chalk.dim(t('cli.wait.success')));
        else if (toolcall.status === 'error' && toolcall.result)
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        return new Card({
            icon: '⏳',
            title: t('cli.wait.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
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
            BrowserDropHistoryArgsSchema,
            undefined,
            { 'zh-CN': '清除历史', 'en-US': 'Clear History' }
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as any;
        const body: string[] = [];
        if (args?.startTime || args?.endTime) {
            const start = args.startTime ? new Date(args.startTime).toLocaleString() : t('cli.deleteHistory.unlimited');
            const end = args.endTime ? new Date(args.endTime).toLocaleString() : t('cli.deleteHistory.unlimited');
            body.push(chalk.dim(t('cli.label.time')) + chalk.cyan(`${start} ~ ${end}`));
        }
        if (args?.domains?.length) {
            body.push(chalk.dim(t('cli.label.domain')) + chalk.cyan(args.domains.join(', ')));
        }
        if (toolcall.status === 'running') body.push(chalk.dim(t('cli.deleteHistory.running')));
        else if (toolcall.status === 'success') {
            try {
                const r = JSON.parse(toolcall.result || '{}');
                body.push(
                    chalk.dim('  ✓ ' + t('cli.deleteHistory.success') + ' ') +
                        chalk.green(t('cli.deleteHistory.deletedCount', { count: r.deleted ?? 0 }))
                );
            } catch {
                body.push(chalk.dim(`  ${t('cli.deleteHistory.success')}`));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }
        return new Card({
            icon: '🗑️',
            title: t('cli.deleteHistory.cardTitle'),
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async handleExecute(
        args: z.output<typeof BrowserDropHistoryArgsSchema>,
        _taskState?: TaskState
    ): Promise<string> {
        if (!args.startTime && !args.endTime && (!args.domains || args.domains.length === 0)) {
            return fail(t('error.deleteHistoryNoFilter'));
        }

        const mainWin = BrowserManager.mainWindow;
        if (!mainWin || mainWin.isDestroyed()) {
            return fail(t('error.mainWindowUnavailable'));
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
