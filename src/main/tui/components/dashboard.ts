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

import { type Component, visibleWidth } from '@earendil-works/pi-tui';
import { getAdaptiveGreen } from '../theme';
import { ApplicationRegistry } from '../../applications/registry';
import { getFeatureManager } from '../../../common/features/manager.js';
import { renderResponsiveCells, type ResponsiveCell } from './responsive-bar';
import { getNotificationBadge } from './notification';
import chalk from 'chalk';
import { Setting, type SettingData, getShortcuts } from '../../utils/setting.js';
import { SlashCommandRegistry } from '../commands/index.js';
import { t } from '../../../locale/index.js';

const HIDDEN_DASHBOARD_STATUS_BUNDLES = new Set(['channelmgr', 'todomgr', 'filemgr']);

export function shouldShowDashboardStatusBlock(bundleName: string): boolean {
    // 被插件禁用的应用（disableApplication）不再贡献状态块：图标已隐藏、工具集与事件已停用。
    // 仅隐藏入口（hideApplication）的应用仍在后台运行，状态照常显示。
    if (getFeatureManager().isApplicationDisabled(bundleName)) return false;
    return !HIDDEN_DASHBOARD_STATUS_BUNDLES.has(bundleName);
}

function getCleanEnvValue(value: string | undefined): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function getEnvPathName(rawValue: string, fallback: string): string {
    const trimmed = rawValue.trim().replace(/[\\/]+$/, '');
    return trimmed.split(/[\\/]/).pop() || fallback;
}

export function getPythonEnvironmentPrompt(env: NodeJS.ProcessEnv = process.env): string | null {
    const prompts: string[] = [];
    const virtualEnv = getCleanEnvValue(env.VIRTUAL_ENV);
    if (virtualEnv) {
        prompts.push(`(venv: ${getEnvPathName(virtualEnv, 'venv')})`);
    }

    const condaPrefix = getCleanEnvValue(env.CONDA_PREFIX);
    const condaName = getCleanEnvValue(env.CONDA_DEFAULT_ENV);
    if (condaName || condaPrefix) {
        prompts.push(`(conda: ${condaName ?? getEnvPathName(condaPrefix!, 'conda')})`);
    }

    return prompts.length > 0 ? prompts.join(' ') : null;
}

export function shouldShowPythonEnvironmentPrompt(settingData: Pick<SettingData, 'cli_config'>): boolean {
    // inherit_venv=false 时用户 Python 环境始终被剥离，无需显示 prompt
    return settingData.cli_config?.inherit_venv !== false;
}

// ━━━ 配色 ━━━
// glow 使用 getter，每次访问时根据终端配色方案动态选择颜色
const C = {
    get glow() {
        return chalk.hex(getAdaptiveGreen());
    }, // 亮绿 - 在线/成功（自适应主题）
    ghost: chalk.hex('#4a4a4a'), // 幽灵灰 - 边框/分隔
    dim: chalk.hex('#666666') // 暗灰 - 次要信息
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DashboardBar — compact 模式底栏
// 通过遍历所有应用的 getTUIStatusBlock() 动态拉取状态，
// 使用 ResponsiveBar 在宽度不足时从右到左逐个隐藏。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class DashboardBar implements Component {
    /** 每个元素是一段已含 ANSI 着色的单行字符串 */
    private cells: string[] = [];
    private refreshTimer?: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
    private invalidated = true;
    private cachedOutput?: string[];
    private lastWidth?: number;
    private requestRender: () => void;
    private initialFetchDone = false;
    private steadyIntervalMs = 60_000;
    private callbacksBound = false;

    constructor(requestRender: () => void) {
        this.requestRender = requestRender;
    }

    start(steadyIntervalMs = 60_000): void {
        this.steadyIntervalMs = steadyIntervalMs;

        // 向所有应用注入 noticeTUIStatusUpdate 回调（只注入一次）
        if (!this.callbacksBound) {
            this.callbacksBound = true;
            for (const [, app] of ApplicationRegistry.applications) {
                app.setTUIStatusUpdateCallback(() => this.refresh());
            }
        }

        // 立即执行首次刷新（时钟等同步数据即时可用，异步数据陆续到达）
        this.refresh();

        // warmup 阶段频繁轮询，应用 worker 可能还在初始化
        const warmupSchedule = [3_000, 8_000, 15_000];
        let step = 0;

        const tick = () => {
            this.refresh();
            step++;
            if (step < warmupSchedule.length) {
                this.refreshTimer = setTimeout(tick, warmupSchedule[step]);
            } else {
                this.refreshTimer = setInterval(() => this.refresh(), this.steadyIntervalMs);
            }
        };

        this.refreshTimer = setTimeout(tick, warmupSchedule[0]);
    }

    stop(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer as any);
            clearTimeout(this.refreshTimer as any);
            this.refreshTimer = undefined;
        }
    }

    private buildHelpHintCell(): string {
        // 模式与输出显示的切换提示已并入 TaskStatusBar 的对应显示项（`模式名 [快捷键]`），这里只保留帮助
        return `${SlashCommandRegistry.formatKeyLabel(getShortcuts().show_help)} ${t('input.statusbar.help')}`;
    }

    private async refresh(): Promise<void> {
        const cells: string[] = [];

        const settingData = Setting.getInstance().getData();
        const pythonEnvPrompt = shouldShowPythonEnvironmentPrompt(settingData) ? getPythonEnvironmentPrompt() : null;
        if (pythonEnvPrompt) {
            cells.push(C.glow(pythonEnvPrompt));
        }

        // 时钟（始终显示，放在 venv prompt 后面，最后被隐藏）
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const weekdayKey = `datetime.weekday.${['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()]}`;
        const weekdayName = t(weekdayKey);
        cells.push(`🕐 ${hh}:${mm} ${weekdayName} ${now.getMonth() + 1}/${now.getDate()}`);

        // 快捷键提示（键位从 TUI 快捷键配置中读取）
        cells.push(this.buildHelpHintCell());

        // 通知角标
        const badge = getNotificationBadge();
        if (badge) {
            cells.push(badge);
        }

        // 从所有应用拉取状态
        const apps = Array.from(ApplicationRegistry.applications.values()).filter((app) =>
            shouldShowDashboardStatusBlock(app.bundleName)
        );
        const results = await Promise.allSettled(apps.map((app) => app.getTUIStatusBlock()));
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                cells.push(result.value);
            }
        }

        this.cells = cells;
        this.initialFetchDone = true;
        this.invalidated = true;
        this.requestRender();
    }

    invalidate(): void {
        this.invalidated = true;
    }

    render(width: number): string[] {
        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }
        this.lastWidth = width;

        if (!this.initialFetchDone) {
            const loadingText = C.dim('⠋ 加载中...');
            const loadingVis = visibleWidth(loadingText);
            const leftPad = Math.max(0, Math.floor((width - loadingVis) / 2));
            this.cachedOutput = [C.ghost('┄'.repeat(width)), ' '.repeat(leftPad) + loadingText];
            return this.cachedOutput;
        }

        const responsiveCells: ResponsiveCell[] = this.cells.map((text) => ({ text }));

        if (responsiveCells.length === 0) {
            this.cachedOutput = [];
            this.invalidated = false;
            return [];
        }

        const sep = C.ghost(' • ');
        const line = renderResponsiveCells(responsiveCells, width, {
            separator: sep,
            horizontalPadding: 1
        });

        if (!line) {
            this.cachedOutput = [];
            this.invalidated = false;
            return [];
        }

        this.cachedOutput = [C.ghost('┄'.repeat(width)), line];

        this.invalidated = false;
        return this.cachedOutput;
    }
}
