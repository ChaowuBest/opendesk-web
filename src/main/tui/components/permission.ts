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
 * TUI 权限确认组件。
 *
 * 当工具调用需要 ask 权限时，临时隐藏输入框（Editor），在输入框的位置
 * 显示权限确认信息和选项列表，让用户做出选择。
 * 确认完成后恢复输入框和焦点。
 *
 * 支持合并后的多条同类请求（相同 resourceType + action），一次展示所有路径。
 * 自动适配终端深色/浅色主题。
 */

import {
    type Component,
    SelectList,
    Text,
    visibleWidth,
    truncateToWidth,
    wrapTextWithAnsi
} from '@earendil-works/pi-tui';
import { defaultSelectListTheme } from '../theme';
import type { OpenDeskTUI } from '../entry';
import type {
    PermissionRequest,
    PermissionUserResponse,
    PermissionPromptProvider,
    PermissionTaskInfo
} from '../../aikernel/security/permission';
import chalk from 'chalk';
import { t } from '../../../locale/index.js';

function getActionLabel(action: string): string {
    const key = `permission.action.${action}`;
    const result = t(key);
    return result === key ? action : result;
}

function getResourceTypeLabel(resourceType: string): string {
    const key = `permission.resource.${resourceType}`;
    const result = t(key);
    return result === key ? resourceType : result;
}

function padBgLine(line: string, width: number, bgFn: (s: string) => string): string {
    const truncated = truncateToWidth(line, width);
    const w = visibleWidth(truncated);
    const pad = Math.max(0, width - w);
    return bgFn(truncated + ' '.repeat(pad));
}

/**
 * 从左边截断文本，省略号在左边，保留右边的路径/信息完整。
 * 适用于文件路径等场景：用户更关心路径的尾部（文件名和最近目录），
 * 而非路径的头部（根目录和上层目录）。
 *
 * 正确处理 ANSI 转义码（不计入可见宽度）和宽字符（如中文）。
 * 不添加 reset 码，避免破坏外层样式（如背景色）。
 */
function truncateToWidthFromLeft(text: string, maxWidth: number, ellipsis: string = '...'): string {
    const textVisibleWidth = visibleWidth(text);
    if (textVisibleWidth <= maxWidth) {
        return text;
    }
    const ellipsisWidth = visibleWidth(ellipsis);
    const targetWidth = maxWidth - ellipsisWidth;
    if (targetWidth <= 0) {
        return ellipsis.substring(0, maxWidth);
    }

    // 使用 Intl.Segmenter 逐 grapheme 从右向左扫描
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const segments: { type: 'ansi' | 'grapheme'; value: string; width: number }[] = [];

    // 先分离 ANSI 码和可见字符
    let i = 0;
    while (i < text.length) {
        const code = text.charCodeAt(i);
        // 检测 ANSI 转义序列
        if (code === 0x1b && i + 1 < text.length) {
            const next = text[i + 1];
            let end = i + 2;
            if (next === '[') {
                while (end < text.length && !/[mGKHJ]/.test(text[end])) end++;
                if (end < text.length) end++;
            } else if (next === ']' || next === '_') {
                while (end < text.length) {
                    if (text[end] === '\x07') {
                        end++;
                        break;
                    }
                    if (text[end] === '\x1b' && text[end + 1] === '\\') {
                        end += 2;
                        break;
                    }
                    end++;
                }
            } else {
                segments.push({ type: 'grapheme', value: text[i], width: visibleWidth(text[i]) });
                i++;
                continue;
            }
            segments.push({ type: 'ansi', value: text.slice(i, end), width: 0 });
            i = end;
        } else {
            // 找到下一个 ANSI 码或字符串结尾
            let textEnd = i;
            while (textEnd < text.length && text.charCodeAt(textEnd) !== 0x1b) textEnd++;
            for (const seg of segmenter.segment(text.slice(i, textEnd))) {
                segments.push({ type: 'grapheme', value: seg.segment, width: visibleWidth(seg.segment) });
            }
            i = textEnd;
        }
    }

    // 从右向左收集 grapheme，直到达到 targetWidth
    // 同时收集这些 grapheme 之前的 ANSI 码（保持样式连续性）
    let accumulatedWidth = 0;
    let cutIndex = segments.length; // 从哪个位置开始保留
    for (let j = segments.length - 1; j >= 0; j--) {
        const seg = segments[j];
        if (seg.type === 'ansi') continue;
        if (accumulatedWidth + seg.width > targetWidth) {
            cutIndex = j + 1;
            break;
        }
        accumulatedWidth += seg.width;
        cutIndex = j;
    }

    // 向前扫描，将截断点之前的连续 ANSI 码也包含进来，保持颜色样式
    while (cutIndex > 0 && segments[cutIndex - 1].type === 'ansi') {
        cutIndex--;
    }

    // 从 cutIndex 开始收集所有 segment（包括 ANSI 码）
    let result = '';
    for (let j = cutIndex; j < segments.length; j++) {
        result += segments[j].value;
    }

    return ellipsis + result;
}

/**
 * 根据选项类型为标签文本着色。
 * 与构造函数中原来的颜色逻辑一致：allow=绿色，prefix/allow_type=亮蓝色，deny=红色。
 */
function colorizeOptionLabel(value: string, text: string, c: typeof permissionColors): string {
    if (value === 'allow') return c.allow(text);
    if (value === 'deny') return c.deny(text);
    // prefix:* 和 allow_type
    return c.allowBright(text);
}

/**
 * 权限确认框配色——不区分深浅主题，选用在黑底和白底下都有良好可读性的中性色值。
 * 背景使用 ANSI 256 色中的深灰蓝 (#2e3440)，在浅色终端上有足够区分度，
 * 在深色终端上也不会与纯黑背景混为一体。
 */
const permissionColors = {
    bg: (s: string) => chalk.bgHex('#2e3440')(s),
    title: (s: string) => chalk.bgHex('#d08700').hex('#1a1a1a').bold(s),
    taskBadge: (s: string) => chalk.bgHex('#4c566a').hex('#ebcb8b').bold(s),
    path: (s: string) => chalk.hex('#5cbbf6')(s),
    question: (s: string) => chalk.hex('#e0e0e0').bold(s),
    allow: (s: string) => chalk.hex('#5cbb5c')(s),
    allowBright: (s: string) => chalk.hex('#6cb6e6')(s),
    deny: (s: string) => chalk.hex('#e05555')(s),
    hint: (s: string) => chalk.hex('#888888')(s),
    separator: (s: string) => chalk.hex('#888888')(s)
};

/**
 * 权限确认 widget，直接嵌入输入区域替换 Editor。
 * 支持一组同类型的合并请求，展示所有资源路径。
 * 支持前缀选项：用户可以选择授权精确路径、某个父目录、或所有同类操作。
 */
export class PermissionPromptWidget implements Component {
    private list: SelectList;
    private titleLine: Text;
    private rawPaths: string[];
    private questionText: string;
    private hintLine: Text;
    private taskBadge: string | null;
    private queueHint: string | null;

    onDone?: (response: PermissionUserResponse) => void;

    constructor(
        requests: PermissionRequest[],
        toolName: string,
        prefixOptions: { label: string; pattern: string }[] = [],
        options?: { isBackground?: boolean; taskName?: string | null; queueSize?: number }
    ) {
        const c = permissionColors;

        const first = requests[0];
        const actionLabel = getActionLabel(first.action);
        const typeLabel = getResourceTypeLabel(first.resourceType);
        const typeActionLabel = `${actionLabel}${typeLabel}`;

        if (options?.isBackground) {
            const name = options.taskName || t('permission.task.unnamed');
            this.taskBadge = c.taskBadge(` ${t('permission.task.background', { name })} `);
        } else {
            this.taskBadge = null;
        }

        this.queueHint =
            options?.queueSize && options.queueSize > 0
                ? c.hint(`  ${t('permission.queue.remaining', { count: options.queueSize })}`)
                : null;

        this.titleLine = new Text(c.title(` ${typeActionLabel} `));

        this.rawPaths = requests.map((req) => req.resourcePath);

        this.questionText = c.question(`  ${t('permission.question', { toolName, typeAction: typeActionLabel })}`);

        const items: { value: string; label: string }[] = [];
        items.push({ value: 'allow', label: t('permission.option.allow') });

        for (let i = 0; i < Math.min(prefixOptions.length, 4); i++) {
            const opt = prefixOptions[i];
            items.push({
                value: `prefix:${opt.pattern}`,
                label: t('permission.option.always.prefix', { label: opt.label, typeAction: typeActionLabel })
            });
        }

        items.push({ value: 'allow_type', label: t('permission.option.always.type', { typeAction: typeActionLabel }) });
        items.push({ value: 'deny', label: t('permission.option.deny') });

        this.list = new SelectList(items, items.length, defaultSelectListTheme, {
            maxPrimaryColumnWidth: 999,
            truncatePrimary: (ctx) => {
                const text = ctx.text;
                if (visibleWidth(text) <= ctx.maxWidth) {
                    return colorizeOptionLabel(ctx.item.value, text, c);
                }
                const prefixStr = t('permission.truncate.prefix');
                const suffixPattern = `${t('permission.truncate.suffix')}${typeActionLabel}`;
                if (text.startsWith(prefixStr) && text.includes(suffixPattern)) {
                    const suffixStart = text.lastIndexOf(suffixPattern);
                    const pathPart = text.slice(prefixStr.length, suffixStart);
                    const prefixWidth = visibleWidth(prefixStr);
                    const suffixWidth = visibleWidth(suffixPattern);
                    const maxPathWidth = ctx.maxWidth - prefixWidth - suffixWidth;
                    if (maxPathWidth > 5) {
                        const truncatedPath = truncateToWidthFromLeft(pathPart, maxPathWidth);
                        return colorizeOptionLabel(ctx.item.value, prefixStr + truncatedPath + suffixPattern, c);
                    }
                }
                // 其他情况：从左边截断
                return colorizeOptionLabel(ctx.item.value, truncateToWidthFromLeft(text, ctx.maxWidth), c);
            }
        });

        this.hintLine = new Text(c.hint(t('permission.hint.cancel')));

        this.list.onSelect = (item) => {
            if (item.value === 'allow') {
                this.onDone?.({ decision: 'allow', rememberScope: 'none' });
            } else if (item.value === 'allow_type') {
                this.onDone?.({ decision: 'allow', rememberScope: 'type' });
            } else if (item.value === 'deny') {
                this.onDone?.({ decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' });
            } else if (item.value.startsWith('prefix:')) {
                const pattern = item.value.slice('prefix:'.length);
                this.onDone?.({ decision: 'allow', rememberScope: 'prefix', selectedPrefixPattern: pattern });
            } else {
                this.onDone?.({ decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' });
            }
        };

        this.list.onCancel = () => {
            this.onDone?.({ decision: 'deny', rememberScope: 'none', denyReason: 'user_denied' });
        };
    }

    getSelectList(): SelectList {
        return this.list;
    }

    invalidate(): void {
        this.titleLine.invalidate();
        this.list.invalidate();
        this.hintLine.invalidate();
    }

    render(width: number): string[] {
        const c = permissionColors;
        const bgFn = c.bg;
        const emptyLine = bgFn(' '.repeat(width));
        const indent = '  ';
        const pathWidth = Math.max(10, width - visibleWidth(indent));

        const lines: string[] = [];
        lines.push(c.separator('─'.repeat(width)));
        lines.push(emptyLine);
        if (this.taskBadge) {
            lines.push(padBgLine(this.taskBadge, width, bgFn));
        }
        for (const l of this.titleLine.render(width)) {
            lines.push(padBgLine(l, width, bgFn));
        }
        for (const rawPath of this.rawPaths) {
            const coloredPath = c.path(rawPath);
            // 右边留出与左边 indent 相同的 padding，避免换行后文字紧贴右边界
            const wrapped = wrapTextWithAnsi(coloredPath, pathWidth - visibleWidth(indent));
            for (const wrappedLine of wrapped) {
                lines.push(padBgLine(indent + wrappedLine, width, bgFn));
            }
        }
        lines.push(emptyLine);
        lines.push(padBgLine(this.questionText, width, bgFn));
        for (const l of this.list.render(width)) {
            lines.push(padBgLine(l, width, bgFn));
        }
        lines.push(emptyLine);
        for (const l of this.hintLine.render(width)) {
            lines.push(padBgLine(l, width, bgFn));
        }
        if (this.queueHint) {
            lines.push(padBgLine(this.queueHint, width, bgFn));
        }
        return lines;
    }
}

interface QueuedPermissionRequest {
    requests: PermissionRequest[];
    toolName: string;
    prefixOptions: { label: string; pattern: string }[];
    taskInfo?: PermissionTaskInfo;
    resolve: (response: PermissionUserResponse) => void;
}

/**
 * 用户通过"始终允许"授予的宽泛权限，用于自动批准队列中的后续同类请求。
 */
interface GrantedPermission {
    resourceType: string;
    action: string;
    scope: 'prefix' | 'type';
    /** scope='prefix' 时的目录前缀（不含尾部 / 和 **） */
    prefixPath?: string;
    /** 原始 glob pattern，传给 auto-resolve 的 response */
    pattern?: string;
}

/**
 * TUI 环境下的 PermissionPromptProvider 实现。
 *
 * 通过 AgentInputArea 的 showPromptWidget/hidePromptWidget 方法
 * 在输入框位置显示权限确认 widget，取代 overlay 弹窗方式。
 *
 * 内置请求队列：当多个任务并发请求权限时，依次弹出弹窗而非同时显示，
 * 避免焦点冲突导致的输入失效问题。
 *
 * 自动批准：用户选择"始终允许"后，队列中匹配的后续请求自动批准，无需再次弹窗。
 */
export class TUIPermissionPromptProvider implements PermissionPromptProvider {
    private openDeskTUI: OpenDeskTUI;
    private queue: QueuedPermissionRequest[] = [];
    private current: QueuedPermissionRequest | null = null;
    /** 弹窗是否正在显示（widget 已显示且用户未完成交互） */
    private isShowing = false;
    /** 阻塞状态下请求已入队但未处理 */
    private isPending = false;
    private grantedPermissions: GrantedPermission[] = [];

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
    }

    async prompt(
        requests: PermissionRequest[],
        toolName: string,
        prefixOptions: { label: string; pattern: string }[],
        taskInfo?: PermissionTaskInfo
    ): Promise<PermissionUserResponse> {
        return new Promise<PermissionUserResponse>((resolve) => {
            this.queue.push({ requests, toolName, prefixOptions, taskInfo, resolve });
            // 标记有请求待处理，避免 taskview 在此期间渲染 tool card
            this.isPending = true;
            // 配置/overlay 模式下不入队显示，等退出后再处理
            if (this.openDeskTUI.isInputBlocked()) {
                return;
            }
            this.processQueue();
        });
    }

    /**
     * 尝试处理队列（仅在非阻塞状态下才真正显示弹窗）。
     * 供外部在退出配置/overlay 模式后调用。
     */
    processQueueIfReady(): void {
        this.processQueue();
    }

    cancelTaskPrompts(taskIds: string[]): void {
        if (taskIds.length === 0) return;
        const ids = new Set(taskIds);
        let cancelledAny = false;

        this.queue = this.queue.filter((item) => {
            if (!this.matchesTask(item, ids)) return true;
            item.resolve({ decision: 'deny', rememberScope: 'none', denyReason: 'task_stopped' });
            cancelledAny = true;
            return false;
        });

        if (this.current && this.matchesTask(this.current, ids)) {
            const current = this.current;
            this.openDeskTUI.inputArea.hidePromptWidget();
            this.current = null;
            this.isShowing = false;
            current.resolve({ decision: 'deny', rememberScope: 'none', denyReason: 'task_stopped' });
            cancelledAny = true;
            this.processQueue();
            this.openDeskTUI.tui.requestRender();
        } else if (cancelledAny) {
            if (this.queue.length === 0) {
                this.isPending = false;
                if (!this.isShowing) {
                    this.openDeskTUI.focusInputAreaIfAvailable();
                }
            } else {
                this.processQueue();
            }
            this.openDeskTUI.tui.requestRender();
        }
    }

    /**
     * 检查请求是否可被已授权规则自动批准。
     * 返回自动生成的 response，或 null 表示仍需用户确认。
     */
    private tryAutoResolve(item: QueuedPermissionRequest): PermissionUserResponse | null {
        const first = item.requests[0];
        if (!first) return null;

        for (const granted of this.grantedPermissions) {
            if (granted.resourceType !== first.resourceType || granted.action !== first.action) {
                continue;
            }
            if (granted.scope === 'type') {
                return { decision: 'allow', rememberScope: 'type' };
            }
            if (granted.scope === 'prefix' && granted.prefixPath) {
                const prefix = granted.prefixPath;
                const allCovered = item.requests.every(
                    (r) => r.resourcePath === prefix || r.resourcePath.startsWith(prefix + '/')
                );
                if (allCovered) {
                    return {
                        decision: 'allow',
                        rememberScope: 'prefix',
                        selectedPrefixPattern: granted.pattern
                    };
                }
            }
        }
        return null;
    }

    /**
     * 记录用户授予的宽泛权限，用于自动批准后续同类请求。
     */
    private recordGrant(item: QueuedPermissionRequest, response: PermissionUserResponse): void {
        const first = item.requests[0];
        if (!first || response.decision !== 'allow') return;

        if (response.rememberScope === 'type') {
            this.grantedPermissions.push({
                resourceType: first.resourceType,
                action: first.action,
                scope: 'type'
            });
        } else if (response.rememberScope === 'prefix' && response.selectedPrefixPattern) {
            const prefixPath = response.selectedPrefixPattern.replace(/\/\*\*$/, '');
            this.grantedPermissions.push({
                resourceType: first.resourceType,
                action: first.action,
                scope: 'prefix',
                prefixPath,
                pattern: response.selectedPrefixPattern
            });
        }
    }

    private processQueue(): void {
        if (this.isShowing || this.queue.length === 0) return;

        // 阻塞状态下不弹窗，等待退出后再处理
        if (this.openDeskTUI.isInputBlocked()) {
            return;
        }

        // 自动批准匹配已授权规则的请求，无需弹窗
        while (this.queue.length > 0) {
            const autoResponse = this.tryAutoResolve(this.queue[0]);
            if (!autoResponse) break;
            const autoItem = this.queue.shift()!;
            autoItem.resolve(autoResponse);
        }

        if (this.queue.length === 0) {
            this.isPending = false;
            this.openDeskTUI.focusInputAreaIfAvailable();
            this.openDeskTUI.tui.requestRender();
            return;
        }

        this.isShowing = true;
        this.isPending = false;
        const item = this.queue.shift()!;
        this.current = item;
        const remainingCount = this.queue.length;

        const isBackground = item.taskInfo ? item.taskInfo.taskId !== this.openDeskTUI.activeTaskId : false;

        const widget = new PermissionPromptWidget(item.requests, item.toolName, item.prefixOptions, {
            isBackground,
            taskName: item.taskInfo?.taskName,
            queueSize: remainingCount
        });

        widget.onDone = (response) => {
            this.openDeskTUI.inputArea.hidePromptWidget(widget);
            this.isShowing = false;
            this.current = null;
            this.recordGrant(item, response);
            item.resolve(response);

            if (this.queue.length > 0) {
                this.processQueue();
            } else {
                this.openDeskTUI.focusInputAreaIfAvailable();
            }
            this.openDeskTUI.tui.requestRender();
        };

        this.openDeskTUI.inputArea.showPromptWidget(widget);
        this.openDeskTUI.tui.setFocus(widget.getSelectList());
        this.openDeskTUI.tui.requestRender();
    }

    private matchesTask(item: QueuedPermissionRequest, taskIds: Set<string>): boolean {
        const taskInfo = item.taskInfo;
        if (!taskInfo) return false;
        return (
            taskIds.has(taskInfo.taskId) ||
            (taskInfo.sourceTaskId ? taskIds.has(taskInfo.sourceTaskId) : false) ||
            (taskInfo.parentTaskId ? taskIds.has(taskInfo.parentTaskId) : false)
        );
    }
}
