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
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { Box, Text } from '@earendil-works/pi-tui';
import { InfoOverlay } from '../components/notice.js';
import { SelectTable, type SelectRow } from '../components/selecttable.js';
import { defaultSelectListTheme, getOverlayColors } from '../theme.js';
import chalk from 'chalk';
import { t } from '../../../locale/index.js';
import { Setting } from '../../utils/setting.js';
import { lookupKnownContextSize, lookupKnownMaxOutputTokens } from '../../utils/model-context.js';

function isChatModel(model: any): boolean {
    return model?.model_type !== 'embedding';
}

function formatInferred(value: number): string {
    if (!value) return '';
    return chalk.cyan(`~${Math.round(value / 1000)}k`);
}

class ModelSelectOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private box: Box;
    private table: SelectTable;
    private models: any[];
    private currentModel: string;

    constructor(openDeskTUI: OpenDeskTUI, models: any[], currentModel: string) {
        this.openDeskTUI = openDeskTUI;
        this.models = models;
        this.currentModel = currentModel;

        const maxVisibleRows = Math.max(5, Math.min(20, openDeskTUI.tui.terminal.rows - 8));

        const rows: SelectRow[] = [
            {
                labels: [
                    chalk.bold(t('model.alias')),
                    chalk.bold(t('model.provider_model')),
                    chalk.bold(t('model.effort')),
                    chalk.bold(t('model.context')),
                    chalk.bold(t('model.max_output'))
                ],
                value: '_header'
            }
        ];
        rows.push(
            ...models.map((m) => ({
                labels: [
                    m.alias === currentModel ? chalk.green('● ' + m.alias) : '  ' + m.alias,
                    `${m.provider_name}/${m.model_name}`,
                    m.reasoning_effort
                        ? chalk.gray(t('reasoning.effort.' + m.reasoning_effort))
                        : chalk.gray(t('model.default_effort')),
                    m.context_length
                        ? chalk.gray(`(${Math.round(m.context_length / 1000)}k)`)
                        : formatInferred(lookupKnownContextSize(m.model_name)),
                    m.max_output_tokens
                        ? chalk.gray(`(${Math.round(m.max_output_tokens / 1000)}k)`)
                        : formatInferred(lookupKnownMaxOutputTokens(m.model_name))
                ],
                value: m.alias
            }))
        );

        this.table = new SelectTable(rows, maxVisibleRows, defaultSelectListTheme);
        this.table.setColumnStrechFactors([0, 1, 0, 0, 0]);
        this.table.columnSeparator = '  ';

        this.table.onSelect = (alias) => {
            if (alias === '_header') return;
            this.close();
            this.switchModel(alias);
        };
        this.table.onCancel = () => {
            this.close();
        };

        const header = new Text(chalk.bold(`ℹ️ ${t('model.description')}`));
        this.box = new Box(1, 1);
        const oc = getOverlayColors();
        this.box.setBgFn((text: string) => chalk.bgHex(oc.bg).hex(oc.fg)(text));
        this.box.addChild(header);
        this.box.addChild(this.table);
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }

    handleInput(keyData: string): void {
        this.table.handleInput(keyData);
        this.openDeskTUI.tui.requestRender();
    }

    show() {
        if (this.openDeskTUI.deferInputPromptIfBlockedByMode(() => this.show())) {
            return;
        }

        this.openDeskTUI.inputArea.showPromptWidget(this);
        this.openDeskTUI.hasOpenOverlay = true;
        this.openDeskTUI.tui.setFocus(this);
    }

    private close() {
        const restored = this.openDeskTUI.closeInputPrompt(this);
        this.openDeskTUI.focusAfterInputPromptClose(restored);
    }

    private switchModel(alias: string) {
        const model = this.models.find((m: any) => m.alias === alias);
        if (!model) return;

        if (alias === this.currentModel) {
            const activeTask = this.openDeskTUI.getActiveTask();
            if (!this.openDeskTUI.isTaskStarted(activeTask)) {
                this.openDeskTUI.setGlobalDefaultModel(alias);
                this.openDeskTUI.resolveModelInfo();
            }
            return;
        }

        const activeTask = this.openDeskTUI.getActiveTask();
        if (activeTask && this.openDeskTUI.isTaskStarted(activeTask)) {
            activeTask.model = alias;
            activeTask.persistLater();
        } else {
            this.openDeskTUI.setGlobalDefaultModel(alias);
        }

        this.openDeskTUI.resolveModelInfo();
    }
}

export function registerModelCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'model',
        description: t('model.description'),

        getArgumentCompletions: (argPrefix: string): AutocompleteItem[] | null => {
            const setting = Setting.getInstance();
            const models = (setting.getData().models ?? []).filter(isChatModel);

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
            const models = (setting.getData().models ?? []).filter(isChatModel);

            // 无参数时显示模型选择列表
            if (!alias) {
                if (models.length === 0) {
                    const info = new InfoOverlay(tui, {
                        title: t('model.description'),
                        message: chalk.yellow(t('model.no.models')) + '\n\n' + chalk.gray(t('model.usage')),
                        closeLabel: t('common.close'),
                        type: 'warning'
                    });
                    info.show();
                    return;
                }

                const currentModel = tui.getCurrentModelAlias();
                new ModelSelectOverlay(tui, models, currentModel).show();
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
            const currentModel = tui.getCurrentModelAlias();
            const activeTask = tui.getActiveTask();
            const taskStarted = tui.isTaskStarted(activeTask);
            if (currentModel === alias) {
                if (!taskStarted) {
                    tui.setGlobalDefaultModel(alias);
                    tui.resolveModelInfo();
                }
                // 如果 setGlobalDefaultModel 触发了 confirm overlay（切换默认模型提示），
                // 则不再显示 InfoOverlay，避免两个 overlay 叠加导致焦点问题
                if (tui.isInputBlocked()) return;

                const info = new InfoOverlay(tui, {
                    title: t('model.description'),
                    message: chalk.gray(`已是当前模型: ${alias}`),
                    closeLabel: t('common.close')
                });
                info.show();
                return;
            }

            if (activeTask && taskStarted) {
                activeTask.model = alias;
                activeTask.persistLater();
            } else {
                tui.setGlobalDefaultModel(alias);
            }

            // 刷新状态栏显示
            tui.resolveModelInfo();

            // 如果 setGlobalDefaultModel 触发了 confirm overlay（切换默认模型提示），
            // 则不再显示 InfoOverlay，避免两个 overlay 叠加导致焦点问题
            if (tui.isInputBlocked()) return;

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
