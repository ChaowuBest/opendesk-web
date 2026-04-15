import type { OpenDeskTUI } from '../entry.js';
import type { AutocompleteItem } from '@mariozechner/pi-tui';
import { Setting } from '../../utils/setting.js';
import { InfoOverlay } from '../components/notice.js';
import chalk from 'chalk';
import {
    REASONING_EFFORT_CLI_TO_STORAGE,
    REASONING_EFFORT_CLI_TOKENS,
    labelForStoredReasoningEffort
} from '../../../common/reasoning-effort.js';

const DISPLAY_OPTIONS = ['full', 'partial'];
const DISPLAY_LABELS: Record<string, string> = {
    full: '完整显示',
    partial: '尾部预览（末 10 行）'
};

export function registerReasonCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'reason',
        description: '思考配置: /reason effort [default|none|low|medium|high] | display [full|partial]',
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
                        description: opt === 'effort' ? '设置推理深度' : '设置思考内容显示模式'
                    }));
            }

            // 子命令已确定，补全子参数
            if (hasTrailingSpace || parts.length >= 2) {
                // effort 子命令：补全 effort 值
                // pi-tui 会用 item.value 替换「第一个空格后的整段 argumentText」，
                // 不能只返回第二段 token，否则 `/reason display on` 会变成 `/reason on`。
                if (subCommand === 'effort') {
                    return REASONING_EFFORT_CLI_TOKENS.filter((opt) => opt.startsWith(subArg)).map((opt) => ({
                        value: `effort ${opt}`,
                        label: opt,
                        description: labelForStoredReasoningEffort(REASONING_EFFORT_CLI_TO_STORAGE[opt]!)
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
                const currentDisplay = setting.data.reason_display || 'partial';
                const currentModelAlias = setting.data.default_model;
                const currentModel = setting.data.models.find((m) => m.alias === currentModelAlias);
                const currentEffort = currentModel?.reasoning_effort || '';

                const lines: string[] = [];
                lines.push(chalk.bold('当前思考配置:'));
                lines.push(`  显示模式: ${chalk.cyan(DISPLAY_LABELS[currentDisplay] ?? currentDisplay)}`);
                if (currentModel) {
                    lines.push(`  当前模型: ${chalk.cyan(currentModelAlias)}`);
                    lines.push(`  推理深度: ${chalk.cyan(labelForStoredReasoningEffort(currentEffort))}`);
                }
                lines.push('');
                lines.push(chalk.dim('用法:'));
                lines.push(chalk.dim('  /reason effort [default|none|low|medium|high]'));
                lines.push(chalk.dim('  /reason display [full|partial]'));

                const info = new InfoOverlay(tui, {
                    title: '思考配置',
                    message: lines.join('\n'),
                    closeLabel: '确定'
                });
                info.show();
                return;
            }

            if (subCommand === 'effort') {
                if (!subArg) {
                    const info = new InfoOverlay(tui, {
                        title: '错误',
                        message: chalk.red('请指定推理深度: /reason effort [default|none|low|medium|high]'),
                        closeLabel: '确定'
                    });
                    info.show();
                    return;
                }

                // 将 'default' 转换为空字符串
                const effortValue = REASONING_EFFORT_CLI_TO_STORAGE[subArg] ?? null;

                if (effortValue === null) {
                    const info = new InfoOverlay(tui, {
                        title: '错误',
                        message: chalk.red(`无效的推理深度: ${subArg}\n可选值: default, none, low, medium, high`),
                        closeLabel: '确定'
                    });
                    info.show();
                    return;
                }

                const setting = Setting.getInstance();
                const modelAlias = setting.data.default_model;

                if (!modelAlias) {
                    const info = new InfoOverlay(tui, {
                        title: '错误',
                        message: chalk.red('当前没有设置默认模型，请先在设置中配置模型'),
                        closeLabel: '确定'
                    });
                    info.show();
                    return;
                }

                const modelIndex = setting.data.models.findIndex((m) => m.alias === modelAlias);
                if (modelIndex === -1) {
                    const info = new InfoOverlay(tui, {
                        title: '错误',
                        message: chalk.red(`找不到模型: ${modelAlias}`),
                        closeLabel: '确定'
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
                    | 'high';
                setting.save();

                const effortLabel = labelForStoredReasoningEffort(effortValue);
                const info = new InfoOverlay(tui, {
                    title: '推理深度已更新',
                    message: chalk.green(
                        `模型 ${chalk.cyan(modelAlias)} 的推理深度已设置为: ${chalk.cyan(effortLabel)}`
                    ),
                    closeLabel: '确定'
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
                        title: '错误',
                        message: chalk.red('请指定显示模式: /reason display [full|partial]'),
                        closeLabel: '确定'
                    });
                    info.show();
                    return;
                }

                if (!DISPLAY_OPTIONS.includes(subArg)) {
                    const info = new InfoOverlay(tui, {
                        title: '错误',
                        message: chalk.red(`无效的显示模式: ${subArg}\n可选值: full, partial`),
                        closeLabel: '确定'
                    });
                    info.show();
                    return;
                }

                const setting = Setting.getInstance();
                const oldDisplay = setting.data.reason_display || 'partial';

                if (oldDisplay === subArg) {
                    const info = new InfoOverlay(tui, {
                        title: '显示模式',
                        message: chalk.dim(`思考内容显示模式已为: ${DISPLAY_LABELS[subArg] ?? subArg}`),
                        closeLabel: '确定'
                    });
                    info.show();
                    return;
                }

                // 更新 reason_display
                setting.data.reason_display = subArg as 'full' | 'partial';
                setting.save();

                const info = new InfoOverlay(tui, {
                    title: '显示模式已更新',
                    message: chalk.green(`思考内容显示模式已设置为: ${chalk.cyan(DISPLAY_LABELS[subArg])}`),
                    closeLabel: '确定'
                });
                info.show(() => {
                    // 刷新当前会话的渲染效果
                    tui.taskView.invalidate();
                    tui.tui.requestRender();
                });
                return;
            }

            const info = new InfoOverlay(tui, {
                title: '错误',
                message: chalk.red(`未知的子命令: ${subCommand}\n可用: effort, display`),
                closeLabel: '确定'
            });
            info.show();
        }
    });
}
