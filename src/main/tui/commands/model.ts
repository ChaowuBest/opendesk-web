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
import type { AutocompleteItem } from '@mariozechner/pi-tui';
import { InfoOverlay } from '../components/notice.js';
import chalk from 'chalk';
import { t } from '../../../locale/index.js';
import { Setting } from '../../utils/setting.js';

export function registerModelCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'model',
        description: t('model.description'),

        getArgumentCompletions: (argPrefix: string): AutocompleteItem[] | null => {
            const setting = Setting.getInstance();
            const models = setting.getData().models ?? [];

            const items: AutocompleteItem[] = models
                .filter(
                    (m) =>
                        m.alias.toLowerCase().startsWith(argPrefix.toLowerCase()) ||
                        m.model_name.toLowerCase().includes(argPrefix.toLowerCase())
                )
                .map((m) => {
                    const parts = [`${m.provider_name}/${m.model_name}`];
                    if (m.reasoning_effort) {
                        parts.push(`[${m.reasoning_effort}]`);
                    }
                    if (m.context_length) {
                        parts.push(`(${Math.round(m.context_length / 1000)}k)`);
                    }

                    return {
                        value: m.alias,
                        label: m.alias,
                        description: parts.join(' ')
                    };
                });

            return items.length > 0 ? items : null;
        },

        execute: async (args: string) => {
            const alias = args.trim();
            const setting = Setting.getInstance();
            const models = setting.getData().models ?? [];

            // 无参数时显示当前模型和可用模型列表
            if (!alias) {
                const data = setting.getData();
                const currentModel = tui.model || data.default_model || '';

                const lines: string[] = [];

                if (models.length === 0) {
                    lines.push(chalk.yellow(t('model.no.models')));
                    lines.push('');
                    lines.push(chalk.gray(t('model.usage')));
                } else {
                    lines.push(chalk.bold(t('model.current')) + ': ' + chalk.cyan(currentModel));
                    lines.push('');
                    lines.push(chalk.bold(t('model.available')) + ':');
                    models.forEach((m, idx) => {
                        const marker = m.alias === currentModel ? chalk.green('● ') : '  ';
                        const info = `${m.provider_name}/${m.model_name}`;
                        const effort = m.reasoning_effort ? chalk.gray(` [${m.reasoning_effort}]`) : '';
                        const ctx = m.context_length ? chalk.gray(` (${Math.round(m.context_length / 1000)}k)`) : '';
                        lines.push(`${marker}${idx + 1}. ${chalk.cyan(m.alias)} - ${info}${effort}${ctx}`);
                    });
                    lines.push('');
                    lines.push(chalk.gray(t('model.usage')));
                }

                const info = new InfoOverlay(tui, {
                    title: t('model.description'),
                    message: lines.join('\n'),
                    closeLabel: t('common.close')
                });
                info.show();
                return;
            }

            // 验证模型是否存在
            const model = models.find((m) => m.alias === alias);

            if (!model) {
                const validAliases = models.map((m) => m.alias).join(', ');
                const info = new InfoOverlay(tui, {
                    title: t('model.not.found') + alias,
                    message: `${t('model.available')}: ${validAliases || t('model.no.models')}`,
                    closeLabel: t('common.close')
                });
                info.show();
                return;
            }

            // 检查是否已经是当前模型
            const currentModel = tui.model || setting.getData().default_model;
            if (currentModel === alias) {
                const info = new InfoOverlay(tui, {
                    title: t('model.description'),
                    message: chalk.gray(`已是当前模型: ${alias}`),
                    closeLabel: t('common.close')
                });
                info.show();
                return;
            }

            // 更新 TUI 的 model 属性
            tui.model = alias;

            // 如果有活跃任务，也更新任务的 model
            if (tui.activeTaskId) {
                const task = tui.taskManagerState.getTask(tui.activeTaskId);
                if (task) {
                    task.model = alias;
                }
            }

            // 刷新状态栏显示
            tui.resolveModelInfo();

            // 显示成功提示
            const info = new InfoOverlay(tui, {
                title: t('model.switched') + alias,
                message: `${model.provider_name}/${model.model_name}`,
                closeLabel: t('common.close')
            });
            info.show();
        }
    });
}
