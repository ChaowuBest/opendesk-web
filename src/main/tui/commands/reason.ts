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
import { Setting } from '../../utils/setting.js';
import { InfoOverlay } from '../components/notice.js';
import chalk from 'chalk';
import {
    REASONING_EFFORT_CLI_TO_STORAGE,
    REASONING_EFFORT_CLI_TOKENS,
    labelForStoredReasoningEffort
} from '../../../common/reasoning-effort.js';
import { resolveModelReasoningEfforts } from '../../utils/model-context.js';
import { t } from '../../../locale/index.js';

const DISPLAY_OPTIONS = ['full', 'partial'];
const DISPLAY_LABELS: Record<string, string> = {
    full: t('reason.display.full'),
    partial: t('reason.display.partial')
};

/** effort 子命令可用的 token：按默认模型支持的档位过滤，未匹配模型时返回全部 */
function getSupportedEffortTokens(): string[] {
    const setting = Setting.getInstance();
    const alias = setting.data.default_model;
    const model = setting.data.models.find((m) => m.alias === alias);
    if (!model) {
        return [...REASONING_EFFORT_CLI_TOKENS];
    }
    const supportedValues = resolveModelReasoningEfforts(model);
    return REASONING_EFFORT_CLI_TOKENS.filter((opt) => supportedValues.includes(REASONING_EFFORT_CLI_TO_STORAGE[opt]!));
}

export function registerReasonCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'reason',
        description: t('reason.description'),
        getArgumentCompletions: (argPrefix: string): AutocompleteItem[] | null => {
            const trimmed = argPrefix.trim();
            const hasTrailingSpace = argPrefix.endsWith(' ');
            const parts = trimmed.split(/\s+/);
            const subCommand = parts[0]?.toLowerCase() || '';
            const subArg = parts[1]?.toLowerCase() || '';

            // 第一个参数：子命令补全（没有空格时）
            if (!hasTrailingSpace && parts.length === 1) {
                const options = ['effort', 'display'];
                return options
                    .filter((opt) => opt.startsWith(subCommand))
                    .map((opt) => ({
                        value: opt,
                        label: opt,
                        description: opt === 'effort' ? t('reason.effort.description') : t('reason.display.description')
                    }));
            }

            // 子命令已确定，补全子参数
            if (hasTrailingSpace || parts.length >= 2) {
                // effort 子命令：补全 effort 值（按默认模型支持的档位过滤）
                // pi-tui 会用 item.value 替换「第一个空格后的整段 argumentText」，
                // 不能只返回第二段 token，否则 `/reason display on` 会变成 `/reason on`。
                if (subCommand === 'effort') {
                    return getSupportedEffortTokens()
                        .filter((opt) => opt.startsWith(subArg))
                        .map((opt) => ({
                            value: `effort ${opt}`,
                            label: opt,
                            description: labelForStoredReasoningEffort(REASONING_EFFORT_CLI_TO_STORAGE[opt]!, t)
                        }));
                }

                if (subCommand === 'display') {
                    return DISPLAY_OPTIONS.filter((opt) => opt.startsWith(subArg)).map((opt) => ({
                        value: `display ${opt}`,
                        label: opt,
                        description: DISPLAY_LABELS[opt]
                    }));
                }
            }

            return null;
        },
        execute: async (args: string) => {
            const parts = args.trim().split(/\s+/);
            const subCommand = parts[0]?.toLowerCase();
            const subArg = parts[1]?.toLowerCase();

            if (!subCommand) {
                // 显示当前配置
                const setting = Setting.getInstance();
                const currentDisplay = setting.data.cli_config?.reason_display || 'partial';
                const currentModelAlias = setting.data.default_model;
                const currentModel = setting.data.models.find((m) => m.alias === currentModelAlias);
                const currentEffort = currentModel?.reasoning_effort || '';

                const lines: string[] = [];
                lines.push(chalk.bold(t('reason.current.title') + ':'));
                lines.push(
                    `  ${t('reason.current.displaymode')}: ${chalk.cyan(DISPLAY_LABELS[currentDisplay] ?? currentDisplay)}`
                );
                if (currentModel) {
                    lines.push(`  ${t('reason.current.model')}: ${chalk.cyan(currentModelAlias)}`);
                    lines.push(
                        `  ${t('reason.current.depth')}: ${chalk.cyan(labelForStoredReasoningEffort(currentEffort, t))}`
                    );
                }
                lines.push('');
                lines.push(chalk.dim(t('reason.usage.title') + ':'));
                lines.push(chalk.dim('  /reason effort [default|none|low|medium|high|max]'));
                lines.push(chalk.dim('  /reason display [full|partial]'));

                const info = new InfoOverlay(tui, {
                    title: t('reason.current.title'),
                    message: lines.join('\n'),
                    closeLabel: t('common.close')
                });
                info.show();
                return;
            }

            if (subCommand === 'effort') {
                if (!subArg) {
                    const info = new InfoOverlay(tui, {
                        title: t('common.close'),
                        message: chalk.red(t('reason.error.specify.effort')),
                        closeLabel: t('common.close')
                    });
                    info.show();
                    return;
                }

                // 将 'default' 转换为空字符串
                const effortValue = REASONING_EFFORT_CLI_TO_STORAGE[subArg] ?? null;

                if (effortValue === null) {
                    const info = new InfoOverlay(tui, {
                        title: t('common.close'),
                        message: chalk.red(t('reason.error.invalid.effort', { value: subArg })),
                        closeLabel: t('common.close')
                    });
                    info.show();
                    return;
                }

                const setting = Setting.getInstance();
                const modelAlias = setting.data.default_model;

                if (!modelAlias) {
                    const info = new InfoOverlay(tui, {
                        title: t('common.close'),
                        message: chalk.red(t('reason.error.no.model')),
                        closeLabel: t('common.close')
                    });
                    info.show();
                    return;
                }

                const modelIndex = setting.data.models.findIndex((m) => m.alias === modelAlias);
                if (modelIndex === -1) {
                    const info = new InfoOverlay(tui, {
                        title: t('common.close'),
                        message: chalk.red(`Model not found: ${modelAlias}`),
                        closeLabel: t('common.close')
                    });
                    info.show();
                    return;
                }

                // 更新模型的 reasoning_effort
                setting.data.models[modelIndex].reasoning_effort = effortValue as
                    | ''
                    | 'none'
                    | 'low'
                    | 'medium'
                    | 'high'
                    | 'max';
                setting.save();

                const effortLabel = labelForStoredReasoningEffort(effortValue, t);
                const info = new InfoOverlay(tui, {
                    title: t('reason.effort.set'),
                    message: chalk.green(t('reason.effort.set.message', { alias: modelAlias, effort: effortLabel })),
                    closeLabel: t('common.close')
                });
                info.show(() => {
                    // 刷新状态栏显示
                    tui.resolveModelInfo();
                });
                return;
            }

            if (subCommand === 'display') {
                if (!subArg) {
                    const info = new InfoOverlay(tui, {
                        title: t('common.close'),
                        message: chalk.red(t('reason.error.specify.display')),
                        closeLabel: t('common.close')
                    });
                    info.show();
                    return;
                }

                if (!DISPLAY_OPTIONS.includes(subArg)) {
                    const info = new InfoOverlay(tui, {
                        title: t('common.close'),
                        message: chalk.red(t('reason.error.invalid.display', { value: subArg })),
                        closeLabel: t('common.close')
                    });
                    info.show();
                    return;
                }

                const setting = Setting.getInstance();
                const oldDisplay = setting.data.cli_config?.reason_display || 'partial';

                if (oldDisplay === subArg) {
                    const info = new InfoOverlay(tui, {
                        title: t('reason.display.already'),
                        message: chalk.dim(
                            t('reason.display.already.message', { mode: DISPLAY_LABELS[subArg] ?? subArg })
                        ),
                        closeLabel: t('common.close')
                    });
                    info.show();
                    return;
                }

                // 更新 reason_display
                if (!setting.data.cli_config) {
                    setting.data.cli_config = {} as typeof setting.data.cli_config;
                }
                setting.data.cli_config.reason_display = subArg as 'full' | 'partial';
                setting.save();

                const info = new InfoOverlay(tui, {
                    title: t('reason.display.set'),
                    message: chalk.green(t('reason.display.set.message', { mode: DISPLAY_LABELS[subArg] })),
                    closeLabel: t('common.close')
                });
                info.show(() => {
                    // 刷新当前会话的渲染效果
                    tui.taskView.invalidate();
                    tui.tui.requestRender();
                });
                return;
            }

            const info = new InfoOverlay(tui, {
                title: t('common.close'),
                message: chalk.red(t('reason.error.unknown', { subcmd: subCommand })),
                closeLabel: t('common.close')
            });
            info.show();
        }
    });
}
