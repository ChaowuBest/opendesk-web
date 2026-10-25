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

import { type Component, Box, Text, Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import { getOverlayColors } from '../theme';
import { OpenDeskTUI } from '../entry';
import chalk from 'chalk';
import { t } from '../../../locale/index.js';
import {
    getUsageDashboardSummary,
    getUsageRankings,
    type RankPeriod,
    type UsageDashboardSummary,
    type UsagePeriodSummary,
    type UsageRankings,
    type UsageModelRankItem,
    type UsageTaskRankItem
} from '../../telemetry/index.js';
import { logger } from '../../utils/logger.js';

type UsageTab = 'task' | 'today' | 'week' | 'month';

// Box padding(2) + header(1) + separator(1) + tabbar(1) + separator(1) + close(1) = 7
// 内容区：摘要(2) + 模型排行(5) + 任务排行(5) = 12，合计 19
const MAX_HEIGHT = 20;
const FIXED_LINES = 7;
const MAX_CONTENT_LINES = MAX_HEIGHT - FIXED_LINES;
const TOP_RANK_LIMIT = 5;

function formatTokens(tokens: number): string {
    if (!Number.isFinite(tokens) || tokens < 0) return '0';
    if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(2) + 'M';
    if (tokens >= 1_000) return (tokens / 1_000).toFixed(2) + 'K';
    return String(tokens);
}

function formatTokenBreakdown(inputTokens: number, outputTokens: number): string {
    return `↑${formatTokens(inputTokens)} ↓${formatTokens(outputTokens)}`;
}

function formatDateTime(iso?: string): string {
    if (!iso) return '--';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export class UsageOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private box: Box;
    private activeTab: UsageTab;

    private loaded = false;
    private loadError: string | null = null;
    private dashboardSummary: UsageDashboardSummary | null = null;
    private todayRankings: UsageRankings | null = null;
    private weekRankings: UsageRankings | null = null;
    private monthRankings: UsageRankings | null = null;

    private get tabOrder(): UsageTab[] {
        const task = this.openDeskTUI.getActiveTask();
        if (task && this.openDeskTUI.isTaskStarted(task)) {
            return ['task', 'today', 'week', 'month'];
        }
        return ['today', 'week', 'month'];
    }

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
        this.activeTab = this.tabOrder[0];
        this.box = new Box(1, 1);
        const oc = getOverlayColors();
        this.box.setBgFn((text: string) => chalk.bgHex(oc.bg).hex(oc.fg)(text));
        this.loadData();
    }

    private async loadData(): Promise<void> {
        try {
            const [summary, todayR, weekR, monthR] = await Promise.all([
                getUsageDashboardSummary({ rankPeriod: 'month', rankLimit: 30 }),
                getUsageRankings('today', 10),
                getUsageRankings('week', 10),
                getUsageRankings('month', 10)
            ]);
            this.dashboardSummary = summary;
            this.todayRankings = todayR;
            this.weekRankings = weekR;
            this.monthRankings = monthR;
            this.loaded = true;
        } catch (err) {
            this.loadError = String(err);
            logger.error(`UsageOverlay: failed to load data: ${err}`);
        }
        this.openDeskTUI.tui.requestRender();
    }

    private buildTabBar(): string {
        const allTabs: { key: UsageTab; label: string }[] = [
            { key: 'task', label: t('usage.tab.task') },
            { key: 'today', label: t('usage.period.today') },
            { key: 'week', label: t('usage.period.week') },
            { key: 'month', label: t('usage.period.month') }
        ];
        const visible = allTabs.filter((tab) => this.tabOrder.includes(tab.key));
        const parts = visible.map((tab) => {
            const text = ` ${tab.label} `;
            return this.activeTab === tab.key ? chalk.bold.underline(text) : chalk.dim(text);
        });
        return `${parts.join('  ')}  ${chalk.dim(t('usage.tab.switch'))}`;
    }

    private renderTaskTab(): string[] {
        const lines: string[] = [];
        const task = this.openDeskTUI.getActiveTask();

        if (!task) {
            lines.push(chalk.gray(t('usage.no.active.task')));
            return lines;
        }

        const name = task.task_name || task.task_id;
        const modelInfo = task.resolveBenchmarkUsageModelInfo();
        const summary = task.usage_summary;

        lines.push(
            `${chalk.bold(t('usage.task.name'))}: ${chalk.cyan(name)}  ${chalk.gray(t('usage.task.id') + ': ' + task.task_id)}`
        );

        const modelParts: string[] = [];
        if (modelInfo.model) modelParts.push(chalk.cyan(modelInfo.model));
        if (modelInfo.provider) modelParts.push(chalk.gray(modelInfo.provider));
        if (modelParts.length > 0) {
            lines.push(`${chalk.bold(t('usage.model'))}: ${modelParts.join(chalk.gray(' · '))}`);
        }

        if (!summary) {
            lines.push(chalk.gray(t('usage.no.data')));
            return lines;
        }

        lines.push(
            `${t('usage.requests')}: ${chalk.cyan(summary.request_count)}  ${t('usage.total')}: ${chalk.yellow(formatTokens(summary.total_tokens))}`
        );
        lines.push(
            `${t('usage.input')}: ${chalk.green(formatTokens(summary.input_tokens))}  ${t('usage.output')}: ${chalk.green(formatTokens(summary.output_tokens))}`
        );

        if (summary.cache_creation_input_tokens > 0 || summary.cache_read_input_tokens > 0) {
            lines.push(
                `${t('usage.cache.create')}: ${chalk.gray(formatTokens(summary.cache_creation_input_tokens))}  ${t('usage.cache.read')}: ${chalk.gray(formatTokens(summary.cache_read_input_tokens))}`
            );
        }

        if (summary.updated_at) {
            lines.push(chalk.gray(t('usage.last.updated') + ': ' + formatDateTime(summary.updated_at)));
        }

        return lines;
    }

    private computeMonthSummary(rankings: UsageRankings): UsagePeriodSummary {
        const summary: UsagePeriodSummary = {
            task_count: rankings.tasks.length,
            request_count: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            // 模型榜单未聚合缓存明细，置 0（falsy）以维持原有的缓存行隐藏行为
            cache_read_input_tokens: 0,
            cache_miss_input_tokens: 0
        };
        for (const m of rankings.models) {
            summary.request_count += m.request_count;
            summary.input_tokens += m.input_tokens;
            summary.output_tokens += m.output_tokens;
            summary.total_tokens += m.total_tokens;
        }
        return summary;
    }

    private renderPeriodTab(period: RankPeriod, summary: UsagePeriodSummary, rankings: UsageRankings): string[] {
        const lines: string[] = [];

        lines.push(
            `${t('usage.tasks')}: ${chalk.cyan(summary.task_count)}  ${t('usage.requests')}: ${chalk.cyan(summary.request_count)}  ${t('usage.total')}: ${chalk.yellow(formatTokens(summary.total_tokens))}`
        );
        lines.push(
            `${t('usage.input')}: ${chalk.green(formatTokens(summary.input_tokens))}  ${t('usage.output')}: ${chalk.green(formatTokens(summary.output_tokens))}`
        );

        const models = rankings.models.slice(0, TOP_RANK_LIMIT);
        if (models.length > 0) {
            const fmtModel = (m: UsageModelRankItem) => {
                const provider = m.provider ? ' · ' + m.provider : '';
                return m.model + provider + '  ' + formatTokenBreakdown(m.input_tokens, m.output_tokens);
            };
            lines.push(`${chalk.bold(t('usage.top.models'))} ${chalk.gray(fmtModel(models[0]))}`);
            for (let i = 1; i < models.length; i++) {
                lines.push(chalk.gray('  ' + fmtModel(models[i])));
            }
        }

        const tasks = rankings.tasks.slice(0, TOP_RANK_LIMIT);
        if (tasks.length > 0) {
            const fmtTask = (task: UsageTaskRankItem) => {
                const name = task.task_name || task.task_id.slice(0, 8);
                const model = task.model ? ' [' + task.model + ']' : '';
                return name + model + '  ' + formatTokenBreakdown(task.input_tokens, task.output_tokens);
            };
            lines.push(`${chalk.bold(t('usage.top.tasks'))} ${chalk.cyan(fmtTask(tasks[0]))}`);
            for (let i = 1; i < tasks.length; i++) {
                lines.push(chalk.cyan('  ' + fmtTask(tasks[i])));
            }
        }

        return lines;
    }

    private renderContent(): string[] {
        if (this.loadError) {
            return [chalk.red(t('usage.load.fail') + ': ' + this.loadError)];
        }
        if (!this.loaded) {
            return [chalk.gray(t('usage.loading'))];
        }

        if (this.activeTab === 'task') {
            return this.renderTaskTab();
        }

        if (this.activeTab === 'today' && this.dashboardSummary && this.todayRankings) {
            return this.renderPeriodTab('today', this.dashboardSummary.today, this.todayRankings);
        }

        if (this.activeTab === 'week' && this.dashboardSummary && this.weekRankings) {
            return this.renderPeriodTab('week', this.dashboardSummary.week, this.weekRankings);
        }

        if (this.activeTab === 'month' && this.monthRankings) {
            const monthSummary = this.computeMonthSummary(this.monthRankings);
            return this.renderPeriodTab('month', monthSummary, this.monthRankings);
        }

        return [chalk.gray(t('usage.no.data'))];
    }

    private buildSeparator(contentWidth: number): string {
        const { border } = getOverlayColors();
        return chalk.hex(border)('━'.repeat(Math.max(0, contentWidth)));
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        // 如果 activeTab 已不在 tabOrder 中（如任务被清除），回退到第一个 tab
        if (!this.tabOrder.includes(this.activeTab)) {
            this.activeTab = this.tabOrder[0];
        }

        const contentWidth = Math.max(1, width - 2);
        const truncate = (line: string): string => truncateToWidth(line, contentWidth, '…');

        this.box.clear();

        this.box.addChild(new Text(truncate(chalk.bold('📊 ' + t('usage.title'))), 0, 0));
        this.box.addChild(new Text(this.buildSeparator(contentWidth), 0, 0));
        this.box.addChild(new Text(truncate(this.buildTabBar()), 0, 0));
        this.box.addChild(new Text(this.buildSeparator(contentWidth), 0, 0));

        const lines = this.renderContent().slice(0, MAX_CONTENT_LINES);
        for (const line of lines) {
            this.box.addChild(new Text(truncate(line), 0, 0));
        }

        this.box.addChild(new Text(truncate(chalk.gray(t('usage.close.hint'))), 0, 0));

        return this.box.render(width);
    }

    handleInput(keyData: string): void {
        if (matchesKey(keyData, Key.left) || matchesKey(keyData, Key.right)) {
            const order = this.tabOrder;
            const idx = order.indexOf(this.activeTab);
            if (idx === -1) {
                this.activeTab = order[0];
                this.openDeskTUI.tui.requestRender();
                return;
            }
            const dir = matchesKey(keyData, Key.right) ? 1 : -1;
            const newIdx = (idx + dir + order.length) % order.length;
            this.activeTab = order[newIdx];
            this.openDeskTUI.tui.requestRender();
            return;
        }
        if (matchesKey(keyData, Key.enter) || matchesKey(keyData, Key.escape)) {
            this.close();
            return;
        }
    }

    private close(): void {
        const restored = this.openDeskTUI.closeInputPrompt(this);
        this.openDeskTUI.focusAfterInputPromptClose(restored);
    }

    show(): void {
        if (this.openDeskTUI.deferInputPromptIfBlockedByMode(() => this.show())) {
            return;
        }

        this.openDeskTUI.inputArea.showPromptWidget(this);
        this.openDeskTUI.hasOpenOverlay = true;
        this.openDeskTUI.tui.setFocus(this);
    }
}
