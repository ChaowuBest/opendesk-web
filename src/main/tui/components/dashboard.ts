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

import { type Component, SelectList, Box, Text, truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import { defaultSelectListTheme, getAdaptiveGreen } from '../theme';
import { OpenDeskTUI } from '../entry';
import { Card, type CardStatus, type BorderConfig } from './card';
import { ApplicationRegistry } from '../../applications/registry';
import { renderResponsiveCells, type ResponsiveCell } from './responsive-bar';
import { getNotificationBadge } from './notification';
import chalk from 'chalk';
import type { GlobalTodo } from '../../applications/todomgr/common';
import type { TaskState } from '../../aikernel/states/tasks.js';
import { describeCron } from '../../utils/cron';
import type { ChannelRuntimeState } from '../../applications/channelmgr/app.js';
import { t } from '../../../locale/index.js';

// ━━━ 科幻配色 ━━━
// glow 使用 getter，每次访问时根据终端配色方案动态选择颜色
const C = {
    neon: chalk.hex('#00E5FF'), // 主色 - 霓虹青
    neonBold: chalk.hex('#00E5FF').bold,
    get glow() {
        return chalk.hex(getAdaptiveGreen());
    }, // 亮绿 - 在线/成功（自适应主题）
    amber: chalk.hex('#FFAB00'), // 琥珀 - 警告/中优先级
    red: chalk.hex('#FF1744'), // 红 - 错误/高优先级
    blue: chalk.hex('#448AFF'), // 蓝 - 低优先级
    ghost: chalk.hex('#4a4a4a'), // 幽灵灰 - 边框/分隔
    dim: chalk.hex('#666666'), // 暗灰 - 次要信息
    text: chalk.hex('#c0c0c0'), // 正文
    bright: chalk.hex('#e0e0e0').bold, // 高亮正文
    panel: chalk.hex('#1a1a2e'), // 面板底色参考
    headerBg: chalk.bgHex('#0a1628').hex('#00E5FF').bold
};

/** 进度条 */
function progressBar(ratio: number, barWidth: number): string {
    const filled = Math.round(ratio * barWidth);
    const empty = barWidth - filled;
    return C.neon('█'.repeat(filled)) + C.ghost('░'.repeat(empty));
}

export interface MailAccountInfo {
    email: string;
    name: string;
    active: boolean;
    newCount: number;
}

export interface DashboardData {
    globalTodos: GlobalTodo[];
    tasks: TaskState[];
    channelStates?: ChannelRuntimeState[];
    mailAccounts?: MailAccountInfo[];
}

export class DashboardOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private list: SelectList;
    private box: Box;
    private data: DashboardData;

    constructor(openDeskTUI: OpenDeskTUI, data: DashboardData) {
        this.openDeskTUI = openDeskTUI;
        this.data = data;

        const items = [{ value: 'close', label: C.neon('[ ESC / ENTER ] 关闭仪表盘') }];
        this.list = new SelectList(items, 1, defaultSelectListTheme);

        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#0a0e14').hex('#c0c0c0')(text));
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        const targetHeight = this.openDeskTUI.tui.terminal.rows;
        // Box padding 上下各 1 行 + list 1 行 + 空行 1 行 = 4
        const availableForContent = targetHeight - 4;

        this.box.clear();
        this.box.addChild(new DashboardRenderer(this.data, availableForContent));
        this.box.addChild(new Text(''));
        this.box.addChild(this.list);

        return this.box.render(width);
    }

    private close(): void {
        const restored = this.openDeskTUI.closeInputPrompt(this);
        this.openDeskTUI.focusAfterInputPromptClose(restored);
    }

    show() {
        if (this.openDeskTUI.deferInputPromptIfBlockedByMode(() => this.show())) {
            return;
        }

        this.openDeskTUI.inputArea.showPromptWidget(this);
        this.openDeskTUI.hasOpenOverlay = true;
        this.openDeskTUI.tui.setFocus(this.list);

        this.list.onSelect = () => {
            this.close();
        };

        this.list.onCancel = () => {
            this.close();
        };
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 仪表盘渲染器 —— 纯渲染，所有视觉逻辑在此
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class DashboardRenderer implements Component {
    private data: DashboardData;
    private targetHeight: number;

    constructor(data: DashboardData, targetHeight: number) {
        this.data = data;
        this.targetHeight = targetHeight;
    }

    invalidate(): void {}

    render(width: number): string[] {
        const W = width;

        const header = this.renderHeader(W);
        const statusBar = this.renderStatusBar(W);
        const mailPanel = this.renderMailPanel(W);
        const channelsPanel = this.renderChannelsPanel(W);
        const todosPanel = this.renderTodosPanel(W);
        const activePanel = this.renderActivePanel(W);
        const telemetryPanel = this.renderTelemetryPanel(W);

        const fixedLines =
            header.length +
            1 +
            statusBar.length +
            1 +
            mailPanel.length +
            1 +
            channelsPanel.length +
            1 +
            todosPanel.length +
            1 +
            activePanel.length +
            1 +
            1 +
            telemetryPanel.length;

        const historyAvailable = Math.max(3, this.targetHeight - fixedLines);
        const historyPanel = this.renderHistoryPanel(W, historyAvailable);

        const lines: string[] = [];
        lines.push(...header);
        lines.push('');
        lines.push(...statusBar);
        lines.push('');
        lines.push(...mailPanel);
        lines.push('');
        lines.push(...channelsPanel);
        lines.push('');
        lines.push(...todosPanel);
        lines.push('');
        lines.push(...activePanel);
        lines.push('');
        lines.push(...historyPanel);
        lines.push('');
        lines.push(...telemetryPanel);

        return lines;
    }

    // ──────────────────── 顶部标题 ────────────────────

    private renderHeader(W: number): string[] {
        const lines: string[] = [];
        const bar = C.ghost('━'.repeat(W));
        lines.push(bar);

        // 标题行
        const logo = C.neonBold('◈');
        const title = C.neonBold(' OPENDESK');
        const subtitle = C.dim(' CONTROL CENTER');

        const now = new Date();
        const timeStr = C.glow('■') + C.dim(` SYS.ONLINE  ${now.toLocaleTimeString()}`);

        const leftPart = `  ${logo}${title}${subtitle}`;
        const leftVis = visibleWidth(leftPart);
        const rightVis = visibleWidth(timeStr);
        const gap = Math.max(2, W - leftVis - rightVis - 2);

        lines.push(leftPart + ' '.repeat(gap) + timeStr);
        lines.push(bar);

        return lines;
    }

    // ──────────────────── 系统状态条 ────────────────────

    private renderStatusBar(W: number): string[] {
        const todos = this.data.globalTodos;
        const tasks = this.data.tasks;

        const activeTodos = todos.filter((t) => t.status !== 'completed').length;
        const cronTodos = todos.filter((t) => t.trigger?.type === 'cron').length;
        const eventTodos = todos.filter((t) => t.trigger?.type === 'event').length;
        const runningTasks = tasks.filter((t) => t.task_status === 'running').length;
        const totalTasks = tasks.length;

        const channelStates = this.data.channelStates || [];
        const onlineChannels = channelStates.filter((c) => c.status.online).length;
        const totalChannels = channelStates.length;

        const mailAccounts = this.data.mailAccounts || [];
        const totalUnread = mailAccounts.reduce((sum, a) => sum + a.newCount, 0);

        const cells = [
            (totalUnread > 0 ? C.amber('📬') : C.ghost('📭')) + C.dim(' MAIL ') + C.bright(String(totalUnread)),
            C.neon('▣') + C.dim(' TODOS ') + C.bright(String(activeTodos)),
            C.neon('⟳') + C.dim(' CRON ') + C.bright(String(cronTodos)),
            C.neon('⚡') + C.dim(' EVENT ') + C.bright(String(eventTodos)),
            (runningTasks > 0 ? C.glow('●') : C.ghost('●')) +
                C.dim(' TASKS ') +
                C.bright(`${runningTasks}/${totalTasks}`),
            (onlineChannels > 0 ? C.glow('◉') : C.ghost('◉')) +
                C.dim(' MSG ') +
                C.bright(`${onlineChannels}/${totalChannels}`)
        ];

        const sep = C.ghost('  │  ');
        const statusLine = '  ' + cells.join(sep);
        return [statusLine];
    }

    // ──────────────────── 邮箱账号面板 ────────────────────

    private renderMailPanel(W: number): string[] {
        const accounts = this.data.mailAccounts || [];
        const totalUnread = accounts.reduce((sum, a) => sum + a.newCount, 0);

        const body: string[] = [];
        if (accounts.length === 0) {
            body.push(C.dim('  ∅ 暂未配置邮箱账号'));
        } else {
            for (const acc of accounts) {
                const activeIcon = acc.active ? C.glow('●') : C.ghost('○');
                const nameLabel = C.text(acc.name || acc.email);
                const emailDim = acc.name ? C.dim(` <${acc.email}>`) : '';

                const leftPart = `  ${activeIcon} ${nameLabel}${emailDim}`;
                const leftVis = visibleWidth(leftPart);

                let rightPart: string;
                if (acc.newCount > 0) {
                    rightPart = C.amber(`${acc.newCount} 封新邮件`);
                } else {
                    rightPart = C.dim('无新邮件');
                }
                const rightVis = visibleWidth(rightPart);
                const inner = W - 6;
                const gap = Math.max(1, inner - leftVis - rightVis);
                body.push(leftPart + C.ghost(' ' + '·'.repeat(Math.max(0, gap - 2)) + ' ') + rightPart);
            }
        }

        const card = new Card({
            title: '邮箱账号',
            status: {
                icon: totalUnread > 0 ? C.amber('📬') : C.neon('📭'),
                text: C.dim(`${totalUnread} UNREAD / ${accounts.length} ACCOUNTS`)
            },
            body: body,
            border: { style: 'single', colorFn: C.ghost }
        });

        return card.render(W);
    }

    // ──────────────────── 消息插件状态面板 ────────────────────

    private renderChannelsPanel(W: number): string[] {
        const channels = this.data.channelStates || [];
        const online = channels.filter((c) => c.status.online).length;
        const total = channels.length;

        const body: string[] = [];
        if (channels.length === 0) {
            body.push(C.dim('  ∅ 暂无已加载的消息插件'));
        } else {
            for (const ch of channels) {
                const icon = ch.status.online ? C.glow('●') : C.red('○');
                const statusText = ch.status.statusText || (ch.status.online ? 'online' : 'offline');
                const label = C.text(`${ch.label}`);
                const idPart = C.dim(` (${ch.channelId}:${ch.accountId})`);
                const stLabel = ch.status.online ? C.glow(statusText.toUpperCase()) : C.red(statusText.toUpperCase());
                const errorText = ch.status.error ? C.red(` ${ch.status.error}`) : '';

                const leftPart = `  ${icon} ${label}${idPart}`;
                const leftVis = visibleWidth(leftPart);
                const rightPart = `${stLabel}${errorText}`;
                const rightVis = visibleWidth(rightPart);
                const inner = W - 6;
                const gap = Math.max(1, inner - leftVis - rightVis);
                body.push(leftPart + C.ghost(' ' + '·'.repeat(Math.max(0, gap - 2)) + ' ') + rightPart);
            }
        }

        const card = new Card({
            title: '消息插件连接状态',
            status: { icon: C.neon('◉'), text: C.dim(`${online}/${total} ONLINE`) },
            body: body,
            border: { style: 'single', colorFn: C.ghost }
        });

        return card.render(W);
    }

    // ──────────────────── 全局待办面板 ────────────────────

    private renderTodosPanel(W: number): string[] {
        const todos = this.data.globalTodos;
        const active = todos.filter((t) => t.status !== 'completed').length;
        const done = todos.filter((t) => t.status === 'completed').length;

        const body: string[] = [];
        if (todos.length === 0) {
            body.push(C.dim('  ∅ 暂无全局待办事项'));
        } else {
            for (const todo of todos.slice(0, 10)) {
                body.push(this.renderTodoLine(todo, W - 6));
            }
            if (todos.length > 10) {
                body.push(C.dim(`  ··· 还有 ${todos.length - 10} 项 ···`));
            }
        }

        const card = new Card({
            title: '全局待办事项',
            status: { icon: C.neon('▣'), text: C.dim(`${active} ACTIVE / ${done} DONE`) },
            body: body,
            border: { style: 'single', colorFn: C.ghost }
        });

        return card.render(W);
    }

    private renderTodoLine(todo: GlobalTodo, maxContentW: number): string {
        const statusIcons: Record<string, string> = {
            completed: C.glow('✓'),
            in_progress: C.neon('▶'),
            pending: C.ghost('▷')
        };
        const icon = statusIcons[todo.status] || C.ghost('▷');

        const priorityFn: Record<string, (s: string) => string> = {
            high: C.red,
            medium: C.amber,
            low: C.blue
        };
        const pFn = priorityFn[todo.priority] || C.amber;
        const pTag = pFn(`[${todo.priority.toUpperCase().padEnd(4)}]`);

        let triggerTag = '';
        if (todo.trigger) {
            switch (todo.trigger.type) {
                case 'event':
                    triggerTag = C.neon('📡 ') + C.dim(`${todo.trigger.bundleName}:${todo.trigger.eventName}`);
                    break;
                case 'scheduled':
                    triggerTag = C.amber('⏱  ') + C.dim(new Date(todo.trigger.triggerAt).toLocaleString());
                    break;
                case 'cron':
                    triggerTag = C.glow('⟳  ') + C.dim(describeCron(todo.trigger.cronExpression));
                    break;
            }
        }

        // 优先显示 title，如果没有则显示 content（兼容旧数据）
        const displayText = todo.title || todo.content;
        const content = todo.status === 'completed' ? chalk.strikethrough(C.dim(displayText)) : C.text(displayText);

        // 计算布局: icon pTag content ... triggerTag
        const leftPart = `  ${icon} ${pTag} ${content}`;
        const leftVis = visibleWidth(leftPart);
        const triggerVis = visibleWidth(triggerTag);

        if (triggerTag && leftVis + triggerVis + 3 <= maxContentW) {
            const gap = Math.max(1, maxContentW - leftVis - triggerVis);
            return leftPart + C.ghost(' ' + '·'.repeat(Math.max(0, gap - 2)) + ' ') + triggerTag;
        }

        return truncateToWidth(leftPart, maxContentW, '…');
    }

    // ──────────────────── 活跃进程面板 ────────────────────

    private renderActivePanel(W: number): string[] {
        const running = this.data.tasks.filter((t) => t.task_status === 'running');

        const body: string[] = [];
        if (running.length === 0) {
            body.push(C.dim('  ∅ 当前没有活跃进程'));
        } else {
            for (const task of running) {
                const name = task.task_name || '未命名任务';
                const bar = progressBar(0.6, 8);
                const label = C.glow(' EXEC');
                body.push(`  ${C.glow('◆')} ${C.text(name)}  ${bar}${label}`);
            }
        }

        const card = new Card({
            title: '当前运行中任务',
            status: { icon: C.neon('▶'), text: C.dim(`${running.length} RUNNING`) },
            body: body,
            border: { style: 'single', colorFn: C.ghost }
        });

        return card.render(W);
    }

    // ──────────────────── 任务归档面板（弹性高度） ────────────────────

    private renderHistoryPanel(W: number, availableHeight: number): string[] {
        const allHistory = this.data.tasks.filter((t) => t.task_status !== 'running').reverse();

        // 面板框架占 2 行（top + bottom）
        const contentSlots = Math.max(1, availableHeight - 2);
        const displayCount = Math.min(allHistory.length, contentSlots);
        const history = allHistory.slice(0, displayCount);

        const body: string[] = [];
        if (allHistory.length === 0) {
            body.push(C.dim('  ∅ 暂无归档任务'));
            // 用空行填满剩余
            for (let i = 1; i < contentSlots; i++) {
                body.push('');
            }
        } else {
            const statusCfg: Record<string, { icon: string; label: string }> = {
                stopped: { icon: C.glow('✦'), label: C.glow('DONE') },
                waiting: { icon: C.dim('○'), label: C.dim('IDLE') },
                failed: { icon: C.red('✖'), label: C.red('ABORT') }
            };

            for (const task of history) {
                const name = task.task_name || '未命名任务';
                const cfg = statusCfg[task.task_status] || statusCfg.stopped;
                const leftPart = `  ${cfg.icon} ${C.text(name)}`;
                const leftVis = visibleWidth(leftPart);
                const rightPart = cfg.label;
                const rightVis = visibleWidth(rightPart);
                const inner = W - 6;
                const gap = Math.max(1, inner - leftVis - rightVis);
                body.push(leftPart + C.ghost(' ' + '·'.repeat(Math.max(0, gap - 2)) + ' ') + rightPart);
            }

            // 任务不够填满时，用空行撑满
            const remaining = contentSlots - displayCount;
            for (let i = 0; i < remaining; i++) {
                body.push('');
            }
        }

        const card = new Card({
            title: '历史任务记录',
            status: {
                icon: C.neon('▣'),
                text: C.dim(`${history.length}/${allHistory.length} ITEMS`)
            },
            body: body,
            border: { style: 'single', colorFn: C.ghost }
        });

        return card.render(W);
    }

    // ──────────────────── 资源遥测面板 ────────────────────

    private renderTelemetryPanel(W: number): string[] {
        const barW = 20;

        const body: string[] = [];
        const metrics = [
            { label: '1H', value: '--.-K', ratio: 0 },
            { label: '1D', value: '--.-K', ratio: 0 },
            { label: '1M', value: '--.-K', ratio: 0 }
        ];

        for (const m of metrics) {
            const tag = C.neon('⬡') + ' ' + C.dim(m.label.padEnd(3));
            const bar = progressBar(m.ratio, barW);
            const val = C.bright(m.value.padStart(10));
            body.push(`  ${tag} ${bar} ${val} ${C.dim('tokens')}`);
        }

        body.push(C.dim('  (遥测模块开发中 ─ TELEMETRY MODULE IN DEV)'));

        const card = new Card({
            title: '资源使用累计',
            status: { icon: C.neon('◎'), text: C.dim('TOKEN USAGE') },
            body: body,
            border: { style: 'single', colorFn: C.ghost }
        });

        return card.render(W);
    }
}

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
    private visible = true;
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

    isVisible(): boolean {
        return this.visible;
    }

    setVisible(v: boolean): void {
        if (this.visible !== v) {
            this.visible = v;
            this.invalidated = true;
            this.requestRender();
        }
    }

    toggleVisible(): void {
        this.setVisible(!this.visible);
    }

    private async refresh(): Promise<void> {
        const cells: string[] = [];

        // 时钟（始终显示，放在最左侧，最后被隐藏）
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
        const weekdayKey = `datetime.weekday.${['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()]}`;
        const weekdayName = t(weekdayKey);
        cells.push(`🕐 ${hh}:${mm} ${weekdayName} ${now.getMonth() + 1}/${now.getDate()}`);

        // 通知角标
        const badge = getNotificationBadge();
        if (badge) {
            cells.push(badge);
        }

        // 从所有应用拉取状态
        const apps = Array.from(ApplicationRegistry.applications.values());
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
        if (!this.visible) return [];

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

        const sep = C.ghost(' │ ');
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
