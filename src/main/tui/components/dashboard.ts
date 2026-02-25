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

import { type Component, SelectList, Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { defaultSelectListTheme } from "../theme";
import { OpenDeskTUI } from "../entry";
import chalk from "chalk";
import type { GlobalTodo } from "../../applications/todomgr/common";
import type { TaskState } from "../../states/tasks";

// ━━━ 科幻配色 ━━━
const C = {
    neon:      chalk.hex('#00E5FF'),       // 主色 - 霓虹青
    neonBold:  chalk.hex('#00E5FF').bold,
    glow:      chalk.hex('#39FF14'),       // 亮绿 - 在线/成功
    amber:     chalk.hex('#FFAB00'),       // 琥珀 - 警告/中优先级
    red:       chalk.hex('#FF1744'),       // 红 - 错误/高优先级
    blue:      chalk.hex('#448AFF'),       // 蓝 - 低优先级
    ghost:     chalk.hex('#4a4a4a'),       // 幽灵灰 - 边框/分隔
    dim:       chalk.hex('#666666'),       // 暗灰 - 次要信息
    text:      chalk.hex('#c0c0c0'),       // 正文
    bright:    chalk.hex('#e0e0e0').bold,  // 高亮正文
    panel:     chalk.hex('#1a1a2e'),       // 面板底色参考
    headerBg:  chalk.bgHex('#0a1628').hex('#00E5FF').bold,
};

/** 用可见字符宽度生成右对齐填充 */
function padRight(str: string, targetWidth: number): string {
    const w = visibleWidth(str);
    if (w >= targetWidth) return truncateToWidth(str, targetWidth, '…');
    return str + ' '.repeat(targetWidth - w);
}

/** 带两侧竖线的内容行 */
function framedLine(content: string, width: number, borderColor: (s: string) => string): string {
    const inner = width - 4;
    const padded = padRight(content, inner);
    return borderColor('│') + ' ' + padded + ' ' + borderColor('│');
}

/** 面板顶边 ┌─ TITLE ──────── extra ─┐ */
function panelTop(title: string, extra: string, width: number, borderColor: (s: string) => string, titleColor: (s: string) => string): string {
    const inner = width - 2;
    const prefix = borderColor('┌') + borderColor('─ ');
    const titleStr = titleColor(title);
    const extraStr = extra ? ' ' + C.dim(extra) + ' ' : ' ';
    const prefixVis = 3; // ┌─_
    const titleVis = visibleWidth(titleStr);
    const extraVis = visibleWidth(extraStr);
    const suffixVis = 1; // ┐
    const fillLen = Math.max(0, width - prefixVis - titleVis - extraVis - suffixVis);
    return prefix + titleStr + ' ' + borderColor('─'.repeat(fillLen)) + extraStr + borderColor('┐');
}

/** 面板底边 └──────────────────────────┘ */
function panelBottom(width: number, borderColor: (s: string) => string): string {
    return borderColor('└' + '─'.repeat(Math.max(0, width - 2)) + '┘');
}

/** 进度条 */
function progressBar(ratio: number, barWidth: number): string {
    const filled = Math.round(ratio * barWidth);
    const empty = barWidth - filled;
    return C.neon('█'.repeat(filled)) + C.ghost('░'.repeat(empty));
}

export interface DashboardData {
    globalTodos: GlobalTodo[];
    tasks: TaskState[];
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

    show() {
        const handle = this.openDeskTUI.tui.showOverlay(this, {
            width: "100%",
            maxHeight: "100%",
            anchor: "center",
        });

        this.openDeskTUI.hasOpenOverlay = true;
        this.openDeskTUI.tui.setFocus(this.list);

        this.list.onSelect = () => {
            handle.hide();
            this.openDeskTUI.hasOpenOverlay = false;
            this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
        };

        this.list.onCancel = () => {
            handle.hide();
            this.openDeskTUI.hasOpenOverlay = false;
            this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
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

        // 先渲染所有固定高度的面板
        const header = this.renderHeader(W);
        const statusBar = this.renderStatusBar(W);
        const todosPanel = this.renderTodosPanel(W);
        const activePanel = this.renderActivePanel(W);
        const telemetryPanel = this.renderTelemetryPanel(W);

        // 计算固定部分占据的行数（含面板间空行）
        const fixedLines = header.length + 1
            + statusBar.length + 1
            + todosPanel.length + 1
            + activePanel.length + 1
            + 1  // history 与 telemetry 之间的空行
            + telemetryPanel.length;

        // 剩余空间全部给 TASK ARCHIVE
        const historyAvailable = Math.max(3, this.targetHeight - fixedLines);
        const historyPanel = this.renderHistoryPanel(W, historyAvailable);

        const lines: string[] = [];
        lines.push(...header);
        lines.push('');
        lines.push(...statusBar);
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

        const activeTodos = todos.filter(t => t.status !== 'completed').length;
        const cronTodos = todos.filter(t => t.trigger?.type === 'cron').length;
        const eventTodos = todos.filter(t => t.trigger?.type === 'event').length;
        const runningTasks = tasks.filter(t => t.task_status === 'running').length;
        const totalTasks = tasks.length;

        const cells = [
            C.neon('▣') + C.dim(' TODOS ') + C.bright(String(activeTodos)),
            C.neon('⟳') + C.dim(' CRON ') + C.bright(String(cronTodos)),
            C.neon('⚡') + C.dim(' EVENT ') + C.bright(String(eventTodos)),
            (runningTasks > 0 ? C.glow('●') : C.ghost('●')) + C.dim(' TASKS ') + C.bright(`${runningTasks}/${totalTasks}`),
        ];

        const sep = C.ghost('  │  ');
        const statusLine = '  ' + cells.join(sep);
        return [statusLine];
    }

    // ──────────────────── 全局待办面板 ────────────────────

    private renderTodosPanel(W: number): string[] {
        const todos = this.data.globalTodos;
        const active = todos.filter(t => t.status !== 'completed').length;
        const done = todos.filter(t => t.status === 'completed').length;
        const bc = C.ghost;
        const lines: string[] = [];

        lines.push(panelTop('GLOBAL TODOS', `${active} ACTIVE / ${done} DONE`, W, bc, C.neonBold));

        if (todos.length === 0) {
            lines.push(framedLine(C.dim('  ∅ 暂无全局待办事项'), W, bc));
        } else {
            for (const todo of todos.slice(0, 10)) {
                lines.push(framedLine(this.renderTodoLine(todo, W - 6), W, bc));
            }
            if (todos.length > 10) {
                lines.push(framedLine(C.dim(`  ··· 还有 ${todos.length - 10} 项 ···`), W, bc));
            }
        }

        lines.push(panelBottom(W, bc));
        return lines;
    }

    private renderTodoLine(todo: GlobalTodo, maxContentW: number): string {
        const statusIcons: Record<string, string> = {
            completed: C.glow('✓'),
            in_progress: C.neon('▶'),
            pending: C.ghost('▷'),
        };
        const icon = statusIcons[todo.status] || C.ghost('▷');

        const priorityFn: Record<string, (s: string) => string> = {
            high: C.red, medium: C.amber, low: C.blue,
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
                    triggerTag = C.glow('⟳  ') + C.dim(todo.trigger.cronExpression);
                    break;
            }
        }

        const content = todo.status === 'completed'
            ? chalk.strikethrough(C.dim(todo.content))
            : C.text(todo.content);

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
        const running = this.data.tasks.filter(t => t.task_status === 'running');
        const bc = C.ghost;
        const lines: string[] = [];

        lines.push(panelTop('ACTIVE PROCESSES', `${running.length} RUNNING`, W, bc, C.neonBold));

        if (running.length === 0) {
            lines.push(framedLine(C.dim('  ∅ 当前没有活跃进程'), W, bc));
        } else {
            for (const task of running) {
                const name = task.task_name || '未命名任务';
                const bar = progressBar(0.6, 8);
                const label = C.glow(' EXEC');
                const line = `  ${C.glow('◆')} ${C.text(name)}  ${bar}${label}`;
                lines.push(framedLine(line, W, bc));
            }
        }

        lines.push(panelBottom(W, bc));
        return lines;
    }

    // ──────────────────── 任务归档面板（弹性高度） ────────────────────

    private renderHistoryPanel(W: number, availableHeight: number): string[] {
        const allHistory = this.data.tasks
            .filter(t => t.task_status !== 'running')
            .reverse();
        const bc = C.ghost;
        const lines: string[] = [];

        // 面板框架占 2 行（top + bottom）
        const contentSlots = Math.max(1, availableHeight - 2);
        const displayCount = Math.min(allHistory.length, contentSlots);
        const history = allHistory.slice(0, displayCount);

        lines.push(panelTop('TASK ARCHIVE', `${history.length}/${allHistory.length} ITEMS`, W, bc, C.neonBold));

        if (allHistory.length === 0) {
            lines.push(framedLine(C.dim('  ∅ 暂无归档任务'), W, bc));
            // 用空的 framed 行填满剩余
            for (let i = 1; i < contentSlots; i++) {
                lines.push(framedLine('', W, bc));
            }
        } else {
            const statusCfg: Record<string, { icon: string; label: string }> = {
                stopped:  { icon: C.glow('✦'), label: C.glow('DONE') },
                waiting:  { icon: C.dim('○'), label: C.dim('IDLE') },
                failed:   { icon: C.red('✖'), label: C.red('ABORT') },
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
                const line = leftPart + C.ghost(' ' + '·'.repeat(Math.max(0, gap - 2)) + ' ') + rightPart;
                lines.push(framedLine(line, W, bc));
            }

            // 任务不够填满时，用空 framed 行撑满
            const remaining = contentSlots - displayCount;
            for (let i = 0; i < remaining; i++) {
                lines.push(framedLine('', W, bc));
            }
        }

        lines.push(panelBottom(W, bc));
        return lines;
    }

    // ──────────────────── 资源遥测面板 ────────────────────

    private renderTelemetryPanel(W: number): string[] {
        const bc = C.ghost;
        const lines: string[] = [];
        const barW = 20;

        lines.push(panelTop('RESOURCE TELEMETRY', 'TOKEN USAGE', W, bc, C.neonBold));

        const metrics = [
            { label: '1H', value: '--.-K', ratio: 0 },
            { label: '1D', value: '--.-K', ratio: 0 },
            { label: '1M', value: '--.-K', ratio: 0 },
        ];

        for (const m of metrics) {
            const tag = C.neon('⬡') + ' ' + C.dim(m.label.padEnd(3));
            const bar = progressBar(m.ratio, barW);
            const val = C.bright(m.value.padStart(10));
            const line = `  ${tag} ${bar} ${val} ${C.dim('tokens')}`;
            lines.push(framedLine(line, W, bc));
        }

        lines.push(framedLine(C.dim('  (遥测模块开发中 ─ TELEMETRY MODULE IN DEV)'), W, bc));
        lines.push(panelBottom(W, bc));
        return lines;
    }
}
