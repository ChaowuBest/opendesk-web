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

import { type Component, SelectList, Text } from '@mariozechner/pi-tui';
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from '@mariozechner/pi-tui';
import { defaultSelectListTheme } from '../theme';
import type { OpenDeskTUI } from '../entry';
import type {
    PermissionRequest,
    PermissionUserResponse,
    PermissionPromptProvider,
    PermissionTaskInfo
} from '../../aikernel/security/permission';
import chalk from 'chalk';

const ACTION_LABELS: Record<string, string> = {
    read: '读取',
    write: '编辑',
    execute: '执行',
    access: '访问'
};

const RESOURCE_TYPE_LABELS: Record<string, string> = {
    file: '文件',
    network: '网络',
    skill: '技能'
};

function padBgLine(line: string, width: number, bgFn: (s: string) => string): string {
    const truncated = truncateToWidth(line, width);
    const w = visibleWidth(truncated);
    const pad = Math.max(0, width - w);
    return bgFn(truncated + ' '.repeat(pad));
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
        const actionLabel = ACTION_LABELS[first.action] || first.action;
        const typeLabel = RESOURCE_TYPE_LABELS[first.resourceType] || first.resourceType;
        const typeActionLabel = `${actionLabel}${typeLabel}`;

        if (options?.isBackground) {
            const name = options.taskName || '未命名任务';
            this.taskBadge = c.taskBadge(` ⏳ 后台任务: ${name} `);
        } else {
            this.taskBadge = null;
        }

        this.queueHint =
            options?.queueSize && options.queueSize > 0
                ? c.hint(`  还有 ${options.queueSize} 个权限请求等待确认`)
                : null;

        this.titleLine = new Text(c.title(` ${typeActionLabel} `));

        this.rawPaths = requests.map((req) => req.resourcePath);

        this.questionText = c.question(`  ${toolName} 请求${typeActionLabel}，是否允许？`);

        const items: { value: string; label: string }[] = [];
        items.push({ value: 'allow', label: c.allow('本次允许') });

        for (let i = 0; i < Math.min(prefixOptions.length, 4); i++) {
            const opt = prefixOptions[i];
            items.push({
                value: `prefix:${opt.pattern}`,
                label: c.allowBright(`始终允许 ${opt.label} 的${typeActionLabel}`)
            });
        }

        items.push({ value: 'allow_type', label: c.allowBright(`始终允许所有${typeActionLabel}操作`) });
        items.push({ value: 'deny', label: c.deny('拒绝') });

        this.list = new SelectList(items, items.length, defaultSelectListTheme);

        this.hintLine = new Text(c.hint('Esc 取消'));

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
            const wrapped = wrapTextWithAnsi(coloredPath, pathWidth);
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
 * 通过 AgentInputArea 的 showPermissionPrompt/hidePermissionPrompt 方法
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
    private isPrompting = false;
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
            this.processQueue();
        });
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
        if (this.isPrompting || this.queue.length === 0) return;

        // 自动批准匹配已授权规则的请求，无需弹窗
        while (this.queue.length > 0) {
            const autoResponse = this.tryAutoResolve(this.queue[0]);
            if (!autoResponse) break;
            const autoItem = this.queue.shift()!;
            autoItem.resolve(autoResponse);
        }

        if (this.queue.length === 0) {
            this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
            this.openDeskTUI.tui.requestRender();
            return;
        }

        this.isPrompting = true;
        const item = this.queue.shift()!;
        const remainingCount = this.queue.length;

        const isBackground = item.taskInfo ? item.taskInfo.taskId !== this.openDeskTUI.activeTaskId : false;

        const widget = new PermissionPromptWidget(item.requests, item.toolName, item.prefixOptions, {
            isBackground,
            taskName: item.taskInfo?.taskName,
            queueSize: remainingCount
        });

        widget.onDone = (response) => {
            this.openDeskTUI.inputArea.hidePermissionPrompt();
            this.isPrompting = false;
            this.recordGrant(item, response);
            item.resolve(response);

            if (this.queue.length > 0) {
                this.processQueue();
            } else {
                this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
            }
            this.openDeskTUI.tui.requestRender();
        };

        this.openDeskTUI.inputArea.showPermissionPrompt(widget);
        this.openDeskTUI.tui.setFocus(widget.getSelectList());
        this.openDeskTUI.tui.requestRender();
    }
}
