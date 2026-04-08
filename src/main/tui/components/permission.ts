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
import { visibleWidth, truncateToWidth } from '@mariozechner/pi-tui';
import { defaultSelectListTheme } from '../theme';
import type { OpenDeskTUI } from '../entry';
import type {
    PermissionRequest,
    PermissionUserResponse,
    PermissionPromptProvider
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
 */
export class PermissionPromptWidget implements Component {
    private list: SelectList;
    private titleLine: Text;
    private resourcePaths: string[];
    private questionText: string;
    private hintLine: Text;

    onDone?: (response: PermissionUserResponse) => void;

    constructor(requests: PermissionRequest[], toolName: string) {
        const c = permissionColors;

        const first = requests[0];
        const actionLabel = ACTION_LABELS[first.action] || first.action;
        const typeLabel = RESOURCE_TYPE_LABELS[first.resourceType] || first.resourceType;
        const typeActionLabel = `${actionLabel}${typeLabel}`;

        this.titleLine = new Text(c.title(` ${typeActionLabel} `));

        this.resourcePaths = requests.map((req) => `  ${c.path(req.resourcePath)}`);

        this.questionText = c.question(`  ${toolName} 请求${typeActionLabel}，是否允许？`);

        const items = [
            { value: 'allow', label: c.allow('本次允许') },
            { value: 'allow_exact', label: c.allowBright(`始终允许对上述路径的${typeActionLabel}操作`) },
            { value: 'allow_type', label: c.allowBright(`始终允许所有${typeActionLabel}操作`) },
            { value: 'deny', label: c.deny('拒绝') }
        ];

        this.list = new SelectList(items, items.length, defaultSelectListTheme);

        this.hintLine = new Text(c.hint('Esc 取消'));

        this.list.onSelect = (item) => {
            switch (item.value) {
                case 'allow':
                    this.onDone?.({ decision: 'allow', rememberScope: 'none' });
                    break;
                case 'allow_exact':
                    this.onDone?.({ decision: 'allow', rememberScope: 'exact' });
                    break;
                case 'allow_type':
                    this.onDone?.({ decision: 'allow', rememberScope: 'type' });
                    break;
                default:
                    this.onDone?.({ decision: 'deny', rememberScope: 'none' });
                    break;
            }
        };

        this.list.onCancel = () => {
            this.onDone?.({ decision: 'deny', rememberScope: 'none' });
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

        const lines: string[] = [];
        lines.push(c.separator('─'.repeat(width)));
        lines.push(emptyLine);
        for (const l of this.titleLine.render(width)) {
            lines.push(padBgLine(l, width, bgFn));
        }
        for (const p of this.resourcePaths) {
            lines.push(padBgLine(p, width, bgFn));
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
        return lines;
    }
}

/**
 * TUI 环境下的 PermissionPromptProvider 实现。
 *
 * 通过 AgentInputArea 的 showPermissionPrompt/hidePermissionPrompt 方法
 * 在输入框位置显示权限确认 widget，取代 overlay 弹窗方式。
 */
export class TUIPermissionPromptProvider implements PermissionPromptProvider {
    private openDeskTUI: OpenDeskTUI;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
    }

    async prompt(requests: PermissionRequest[], toolName: string): Promise<PermissionUserResponse> {
        const widget = new PermissionPromptWidget(requests, toolName);

        return new Promise<PermissionUserResponse>((resolve) => {
            widget.onDone = (response) => {
                this.openDeskTUI.inputArea.hidePermissionPrompt();
                this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
                this.openDeskTUI.tui.requestRender();
                resolve(response);
            };

            this.openDeskTUI.inputArea.showPermissionPrompt(widget);
            this.openDeskTUI.tui.setFocus(widget.getSelectList());
            this.openDeskTUI.tui.requestRender();
        });
    }
}
