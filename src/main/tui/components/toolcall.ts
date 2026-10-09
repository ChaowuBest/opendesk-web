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

import chalk from 'chalk';
import { type Component, visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';
import type { CardStatus } from './card';
import type { ToolCall } from '../../aikernel/messages';
import { t } from '../../../locale/index.js';

/**
 * Truncate a string (may contain ANSI codes / wide chars) to fit within
 * maxWidth visible columns, appending '…' if truncated.
 */
export function truncText(str: string, maxWidth: number): string {
    return truncateToWidth(str, maxWidth, '…');
}

/** Resolve a tool-call status string into a styled CardStatus */
export function statusDisplay(status: string): CardStatus {
    switch (status) {
        case 'pending':
            return { icon: chalk.dim('○'), text: chalk.dim(t('toolcall.status.pending')) };
        case 'running':
            return { icon: chalk.blueBright('●'), text: chalk.blueBright(t('toolcall.status.running')) };
        case 'success':
            return { icon: chalk.greenBright('✔'), text: chalk.greenBright(t('toolcall.status.success')) };
        case 'interrupted':
            return { icon: chalk.yellowBright('⊘'), text: chalk.yellowBright(t('toolcall.status.interrupted')) };
        case 'error':
            return { icon: chalk.redBright('✘'), text: chalk.redBright(t('toolcall.status.error')) };
        default:
            return { icon: chalk.dim('○'), text: chalk.dim(status) };
    }
}

/**
 * 默认的工具调用视图，以简洁的单行形式展示工具名称和状态。
 *
 *   ● toolname ·········· 执行中…
 */
export class DefaultToolCallView implements Component {
    private toolCall: ToolCall;

    constructor(toolCall: ToolCall) {
        this.toolCall = toolCall;
    }

    invalidate() {}

    render(width: number): string[] {
        const { icon, text } = statusDisplay(this.toolCall.status);
        const name = chalk.bold(this.toolCall.getResolvedToolDisplayName());

        const iconVis = visibleWidth(icon);
        const nameVis = visibleWidth(name);
        const textVis = visibleWidth(text);
        const overhead = 2 + iconVis + 1 + nameVis + 1 + 1 + textVis;
        const dotCount = Math.max(2, width - overhead);
        const dots = chalk.dim('·'.repeat(dotCount));
        const line = `  ${icon} ${name} ${dots} ${text}`;
        return [truncateToWidth(line, width, '…', true)];
    }
}
