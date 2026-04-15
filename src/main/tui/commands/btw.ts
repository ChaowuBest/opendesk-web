import type { OpenDeskTUI } from '../entry.js';
import { LLM } from '../../aikernel/llm.js';
import { UserMessage } from '../../aikernel/messages.js';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';

export function registerBtwCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'btw',
        description: '快速提问 (不使用当前上下文和工具)',
        execute: async (args: string) => {
            const question = args.trim();
            if (!question) {
                tui.inputArea.btwResultPanel.show(chalk.magenta('btw'), chalk.dim('用法: /btw <你的问题>'));
                tui.tui.requestRender();
                return;
            }

            tui.inputArea.btwResultPanel.show(
                `${chalk.magenta('btw')} ${chalk.bold(question)}`,
                chalk.dim('⏳ 正在思考...')
            );
            tui.tui.requestRender();

            try {
                const answer = await LLM.ask(new UserMessage(question));
                tui.inputArea.btwResultPanel.showMarkdown(
                    `${chalk.magenta('btw')} ${chalk.bold(question)}`,
                    answer.trim() || '(无回复)'
                );
            } catch (err: any) {
                logger.error(`/btw failed: ${err}`);
                tui.inputArea.btwResultPanel.show(
                    `${chalk.magenta('btw')} ${chalk.bold(question)}`,
                    chalk.red(`请求失败: ${err?.message ?? err}`)
                );
            }
            tui.tui.requestRender();
        }
    });
}
