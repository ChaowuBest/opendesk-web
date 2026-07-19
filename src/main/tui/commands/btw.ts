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

import type { OpenDeskTUI } from '../entry.js';
import { LLM } from '../../aikernel/llm.js';
import { UserMessage } from '../../aikernel/messages.js';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';
import { t } from '../../../locale/index.js';

export function registerBtwCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'btw',
        description: t('btw.description'),
        execute: async (args: string) => {
            const question = args.trim();
            if (!question) {
                tui.inputArea.btwResultPanel.show(chalk.magenta('btw'), chalk.dim(t('btw.usage')));
                tui.tui.requestRender();
                return;
            }

            tui.inputArea.btwResultPanel.show(
                `${chalk.magenta('btw')} ${chalk.bold(question)}`,
                chalk.dim('⏳ ' + t('btw.thinking'))
            );
            tui.tui.requestRender();

            try {
                const answer = await LLM.ask(new UserMessage(question));
                tui.inputArea.btwResultPanel.showMarkdown(
                    `${chalk.magenta('btw')} ${chalk.bold(question)}`,
                    answer.trim() || t('btw.no.reply')
                );
            } catch (err: any) {
                logger.error(`/btw failed: ${err}`);
                tui.inputArea.btwResultPanel.show(
                    `${chalk.magenta('btw')} ${chalk.bold(question)}`,
                    chalk.red(`${t('btw.request.fail')}${err?.message ?? err}`)
                );
            }
            tui.tui.requestRender();
        }
    });
}
