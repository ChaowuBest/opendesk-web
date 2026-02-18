import chalk from 'chalk';
import { type Component, visibleWidth, truncateToWidth } from '@mariozechner/pi-tui';
import type { CardStatus } from './card';
import type { ToolCall } from '../../agents/messages';


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
        case 'pending': return { icon: chalk.dim('○'), text: chalk.dim('等待中') };
        case 'running': return { icon: chalk.blueBright('●'), text: chalk.blueBright('执行中…') };
        case 'success': return { icon: chalk.greenBright('✔'), text: chalk.greenBright('完成') };
        case 'error':   return { icon: chalk.redBright('✘'), text: chalk.redBright('失败') };
        default:        return { icon: chalk.dim('○'), text: chalk.dim(status) };
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
        const name = chalk.bold(this.toolCall.tool_name);

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
