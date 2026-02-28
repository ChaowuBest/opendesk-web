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

import { type Component, SelectList, Box, Text, Key, matchesKey, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { defaultSelectListTheme } from "../../tui/theme";
import type { OpenDeskTUI } from "../../tui/entry";
import { ApplicationRegistry } from "../../applications/registry";
import { logger } from "../../utils/logger.js";
import chalk from "chalk";

// ━━━ 日历配色 ━━━
const CC = {
    accent: chalk.hex('#4A90D9'),
    accentBold: chalk.hex('#4A90D9').bold,
    neon: chalk.hex('#00E5FF'),
    neonBold: chalk.hex('#00E5FF').bold,
    green: chalk.hex('#39FF14'),
    amber: chalk.hex('#FFAB00'),
    red: chalk.hex('#FF1744'),
    ghost: chalk.hex('#4a4a4a'),
    dim: chalk.hex('#666666'),
    text: chalk.hex('#c0c0c0'),
    bright: chalk.hex('#e0e0e0').bold,
    today: chalk.hex('#4A90D9').bold,
    selected: chalk.bgHex('#1a2735').hex('#00E5FF').bold,
    weekend: chalk.hex('#FF6B6B'),
    otherMonth: chalk.hex('#333333'),
};

// ━━━ 类型定义 ━━━

interface CalendarItem {
    uid: string;
    subject: string;
    startTime: number;
    endTime: number;
    location: string;
    isAllDay: boolean;
    isCancelled: boolean;
}

type CalendarViewState = 'loading' | 'calendar' | 'detail';

// ━━━ Worker 通信 ━━━

async function callCalendarWorker(method: string, ...args: any[]): Promise<any> {
    const result = await ApplicationRegistry.callWorker('calendar', method, ...args);
    if (result?.status === 'error') {
        throw new Error(result.message || `calendar.${method} failed`);
    }
    return result?.data;
}

// ━━━ 工具函数 ━━━

function sanitizeLine(line: string): string {
    // eslint-disable-next-line no-control-regex
    return line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\r]/g, '').replace(/\t/g, '   ');
}

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

function formatTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatDateFull(date: Date): string {
    return date.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    }) + ' ' + WEEKDAY_NAMES[date.getDay()];
}

function toDateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CalendarOverlay — 全屏日历 TUI 界面
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const calendarSelectListTheme = {
    ...defaultSelectListTheme,
    selectedPrefix: (text: string) => chalk.bgHex('#1a2735').hex('#4A90D9')(text),
    selectedText: (text: string) => chalk.bgHex('#1a2735').bold(text),
};

export class CalendarOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private box: Box;

    private state: CalendarViewState = 'loading';
    private currentDate: Date;
    private events: CalendarItem[] = [];
    private selectedEvent?: CalendarItem;
    private loadingText = '正在加载日历...';
    private errorText?: string;

    private eventList?: SelectList;
    private handle?: any;
    private inputListenerRemove?: () => void;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#0a0e14').hex('#c0c0c0')(text));
        this.currentDate = new Date();
    }

    invalidate(): void {
        this.box.invalidate();
    }

    // ──────────────────── 生命周期 ────────────────────

    async show() {
        this.handle = this.openDeskTUI.tui.showOverlay(this, {
            width: "100%",
            maxHeight: "100%",
            anchor: "center",
        });
        this.openDeskTUI.hasOpenOverlay = true;

        this.inputListenerRemove = this.openDeskTUI.tui.addInputListener((data: string) => {
            return this.handleInput(data);
        });

        await this.loadEvents();
    }

    private close() {
        this.inputListenerRemove?.();
        this.handle?.hide();
        this.openDeskTUI.hasOpenOverlay = false;
        this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
    }

    // ──────────────────── 输入处理 ────────────────────

    handleInput(data: string): { consume: boolean } | undefined {
        if (this.state === 'detail') {
            if (matchesKey(data, Key.escape) || data === 'q') {
                this.selectedEvent = undefined;
                this.buildCalendarView();
                return { consume: true };
            }
            return { consume: true };
        }

        if (this.state === 'calendar') {
            // h / ← 前一天
            if (data === 'h' || matchesKey(data, Key.left)) {
                this.changeDay(-1);
                return { consume: true };
            }
            // l / → 后一天
            if (data === 'l' || matchesKey(data, Key.right)) {
                this.changeDay(1);
                return { consume: true };
            }
            // H / Shift+Left 上个月
            if (data === 'H' || data === '[') {
                this.changeMonth(-1);
                return { consume: true };
            }
            // L / Shift+Right 下个月
            if (data === 'L' || data === ']') {
                this.changeMonth(1);
                return { consume: true };
            }
            // t 跳转到今天
            if (data === 't' || data === 'T') {
                this.currentDate = new Date();
                this.loadEvents();
                return { consume: true };
            }
        }

        return undefined;
    }

    // ──────────────────── 数据加载 ────────────────────

    private async loadEvents() {
        this.state = 'loading';
        this.loadingText = '正在加载日程...';
        this.errorText = undefined;
        this.openDeskTUI.tui.requestRender();

        try {
            const dateStr = toDateString(this.currentDate);
            const data = await callCalendarWorker('getCalendarItems', dateStr);
            this.events = Array.isArray(data) ? data : [];
            this.events.sort((a, b) => a.startTime - b.startTime);
            this.buildCalendarView();
        } catch (err: any) {
            logger.error(`加载日程失败: ${err}`);
            this.errorText = `加载失败: ${err?.message || '未知错误'}`;
            this.events = [];
            this.buildCalendarView();
        }
    }

    // ──────────────────── 日期操作 ────────────────────

    private changeDay(delta: number) {
        this.currentDate = new Date(
            this.currentDate.getFullYear(),
            this.currentDate.getMonth(),
            this.currentDate.getDate() + delta
        );
        this.loadEvents();
    }

    private changeMonth(delta: number) {
        const newDate = new Date(
            this.currentDate.getFullYear(),
            this.currentDate.getMonth() + delta,
            1
        );
        const daysInNewMonth = new Date(newDate.getFullYear(), newDate.getMonth() + 1, 0).getDate();
        const day = Math.min(this.currentDate.getDate(), daysInNewMonth);
        this.currentDate = new Date(newDate.getFullYear(), newDate.getMonth(), day);
        this.loadEvents();
    }

    // ──────────────────── 日历视图 ────────────────────

    /**
     * 日历视图布局（精确到行，确保填满屏幕）：
     *   Box top padding          1
     *   CalendarHeaderBar        3  (bar + title + bar)
     *   空行                     1
     *   MonthNavBar              1
     *   WeekdayHeader            1
     *   MonthGrid                gridRows (动态 4-6)
     *   空行                     1
     *   SeparatorLine            1
     *   DayScheduleHeader        1
     *   [error]                  0 | 1
     *   SelectList(events)       ← 弹性区域
     *   空行                     1
     *   CalendarFooter           1
     *   Box bottom padding       1
     *   ─────────────────────────
     *   固定合计(无grid/error):  13
     */
    private buildCalendarView() {
        this.state = 'calendar';

        const rows = this.openDeskTUI.tui.terminal.rows;
        const gridRows = this.computeMonthGridRows();
        const fixedLines = 13 + gridRows + (this.errorText ? 1 : 0);
        const visibleCount = Math.max(1, rows - fixedLines);

        const items = this.events.map((event) => ({
            value: event.uid,
            label: this.formatEventItem(event),
        }));

        if (items.length === 0) {
            items.push({ value: '__empty__', label: CC.dim('  ∅ 今日暂无日程') });
        }

        this.eventList = new SelectList(items, visibleCount, calendarSelectListTheme);
        this.openDeskTUI.tui.setFocus(this.eventList);

        this.eventList.onSelect = async (item: any) => {
            if (item.value === '__empty__') return;
            const event = this.events.find(e => e.uid === item.value);
            if (event) {
                this.selectedEvent = event;
                this.buildDetailView();
            }
        };

        this.eventList.onCancel = () => {
            this.close();
        };

        this.openDeskTUI.tui.requestRender();
    }

    private formatEventItem(event: CalendarItem): string {
        const timeStr = event.isAllDay
            ? CC.amber('全天  ')
            : CC.dim(formatTime(event.startTime).padEnd(6));

        const cancelledTag = event.isCancelled ? CC.red('✕ ') : '';

        const subject = event.isCancelled
            ? CC.dim(event.subject || '(无标题)')
            : CC.text(event.subject || '(无标题)');

        const location = event.location
            ? CC.ghost(' · ' + event.location)
            : '';

        return `  ${timeStr} ${cancelledTag}${subject}${location}`;
    }

    private computeMonthGridRows(): number {
        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth();
        const firstDayOfWeek = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        return Math.ceil((firstDayOfWeek + daysInMonth) / 7);
    }

    // ──────────────────── 详情视图 ────────────────────

    private buildDetailView() {
        this.state = 'detail';
        this.openDeskTUI.tui.setFocus(null);
        this.openDeskTUI.tui.requestRender();
    }

    // ──────────────────── 渲染 ────────────────────

    render(width: number): string[] {
        const targetHeight = this.openDeskTUI.tui.terminal.rows;
        const availableForContent = targetHeight - 2; // Box padding top+bottom

        this.box.clear();

        switch (this.state) {
            case 'loading':
                this.box.addChild(new CalendarHeaderBar(this.currentDate));
                this.box.addChild(new VerticalFiller(this.loadingText, availableForContent - 3));
                break;

            case 'calendar': {
                this.box.addChild(new CalendarHeaderBar(this.currentDate));          // 3
                this.box.addChild(new Text(''));                                       // 1
                this.box.addChild(new MonthNavBar(this.currentDate));                 // 1
                this.box.addChild(new WeekdayHeader());                               // 1
                this.box.addChild(new MonthGrid(this.currentDate, this.events));      // gridRows
                this.box.addChild(new Text(''));                                       // 1
                this.box.addChild(new SeparatorLine());                               // 1
                this.box.addChild(new DayScheduleHeader(this.currentDate, this.events.length)); // 1
                if (this.errorText) {
                    this.box.addChild(new Text(CC.red(`  ⚠ ${this.errorText}`)));     // 1
                }
                if (this.eventList) {
                    this.box.addChild(this.eventList);                                 // flex
                }
                this.box.addChild(new Text(''));                                       // 1
                this.box.addChild(new CalendarFooter());                               // 1
                break;
            }

            case 'detail': {
                if (this.selectedEvent) {
                    const detailComp = new EventDetailView(this.selectedEvent, availableForContent);
                    this.box.addChild(detailComp);
                }
                break;
            }
        }

        const result = this.box.render(width).map(l => truncateToWidth(sanitizeLine(l), width, '', true));
        while (result.length < targetHeight) {
            result.push('');
        }
        return result;
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 子组件
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class CalendarHeaderBar implements Component {
    constructor(private currentDate: Date) { }
    invalidate() { }
    render(width: number): string[] {
        const bar = CC.ghost('━'.repeat(width));

        const logo = CC.neonBold('◈');
        const title = CC.neonBold(' OPENDESK CALENDAR');

        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth() + 1;
        const dateInfo = CC.dim(`${year}年 ${month}月`);

        const leftPart = `  ${logo}${title}`;
        const leftVis = visibleWidth(leftPart);
        const rightVis = visibleWidth(dateInfo);
        const gap = Math.max(1, width - leftVis - rightVis);

        let titleLine: string;
        if (leftVis + rightVis >= width) {
            titleLine = truncateToWidth(leftPart, width, '…');
        } else {
            titleLine = leftPart + ' '.repeat(gap) + dateInfo;
        }

        return [bar, truncateToWidth(titleLine, width, '…'), bar];
    }
}

class MonthNavBar implements Component {
    constructor(private currentDate: Date) { }
    invalidate() { }
    render(width: number): string[] {
        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth() + 1;
        const nav = `  ${CC.neon('◀')} ${CC.bright(`${year}年 ${month}月`)} ${CC.neon('▶')}`;
        const hint = CC.ghost('[/] 切换月份');
        const leftVis = visibleWidth(nav);
        const rightVis = visibleWidth(hint);
        const gap = Math.max(1, width - leftVis - rightVis - 2);

        if (leftVis + rightVis + 2 >= width) {
            return [truncateToWidth(nav, width, '…')];
        }
        return [truncateToWidth(nav + ' '.repeat(gap) + hint, width, '…')];
    }
}

class WeekdayHeader implements Component {
    invalidate() { }
    render(width: number): string[] {
        const cellW = Math.max(3, Math.floor((width - 4) / 7));
        const headers = WEEKDAY_SHORT.map((d, i) => {
            const padded = d.padStart(Math.floor((cellW + 1) / 2)).padEnd(cellW);
            return (i === 0 || i === 6) ? CC.weekend(padded) : CC.dim(padded);
        });
        return [truncateToWidth('  ' + headers.join(''), width, '…')];
    }
}

class MonthGrid implements Component {
    constructor(private currentDate: Date, private events: CalendarItem[]) { }
    invalidate() { }
    render(width: number): string[] {
        const cellW = Math.max(3, Math.floor((width - 4) / 7));
        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth();
        const selectedDay = this.currentDate.getDate();

        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const firstDayOfWeek = firstDay.getDay();
        const daysInMonth = lastDay.getDate();
        const prevMonthLastDay = new Date(year, month, 0).getDate();

        const today = new Date();
        const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;

        const cells: string[] = [];

        // 上月填充日
        for (let i = firstDayOfWeek - 1; i >= 0; i--) {
            const day = prevMonthLastDay - i;
            cells.push(this.formatCell(String(day), cellW, 'other'));
        }

        // 当月日期
        for (let day = 1; day <= daysInMonth; day++) {
            let style: 'normal' | 'today' | 'selected' | 'other' = 'normal';
            if (day === selectedDay) {
                style = 'selected';
            } else if (isCurrentMonth && day === today.getDate()) {
                style = 'today';
            }
            cells.push(this.formatCell(String(day), cellW, style));
        }

        // 下月填充日
        const totalCells = firstDayOfWeek + daysInMonth;
        const totalRows = Math.ceil(totalCells / 7);
        const targetCells = totalRows * 7;
        for (let day = 1; cells.length < targetCells; day++) {
            cells.push(this.formatCell(String(day), cellW, 'other'));
        }

        const lines: string[] = [];
        for (let row = 0; row < totalRows; row++) {
            const rowCells = cells.slice(row * 7, row * 7 + 7);
            lines.push(truncateToWidth('  ' + rowCells.join(''), width, '…'));
        }

        return lines;
    }

    private formatCell(text: string, cellW: number, style: 'normal' | 'today' | 'selected' | 'other'): string {
        const padded = text.padStart(Math.floor((cellW + 1) / 2)).padEnd(cellW);
        switch (style) {
            case 'selected':
                return CC.selected(padded);
            case 'today':
                return CC.today(padded);
            case 'other':
                return CC.otherMonth(padded);
            default:
                return CC.text(padded);
        }
    }
}

class DayScheduleHeader implements Component {
    constructor(private currentDate: Date, private count: number) { }
    invalidate() { }
    render(width: number): string[] {
        const dateStr = formatDateFull(this.currentDate);
        const countStr = this.count > 0
            ? CC.neon(` (${this.count}项)`)
            : CC.ghost(' (无日程)');
        return [truncateToWidth(`  ${CC.bright(dateStr)}${countStr}`, width, '…')];
    }
}

class SeparatorLine implements Component {
    constructor(private char: string = '━') { }
    invalidate() { }
    render(width: number): string[] {
        return [CC.ghost(this.char.repeat(width))];
    }
}

class VerticalFiller implements Component {
    constructor(private text: string, private totalLines: number) { }
    invalidate() { }
    render(_width: number): string[] {
        const lines: string[] = [];
        const padTop = Math.max(0, Math.floor(this.totalLines / 2));
        for (let i = 0; i < padTop; i++) lines.push('');
        lines.push(CC.neon(`  ⟳ ${this.text}`));
        const remaining = this.totalLines - padTop - 1;
        for (let i = 0; i < remaining; i++) lines.push('');
        return lines;
    }
}

class CalendarFooter implements Component {
    invalidate() { }
    render(width: number): string[] {
        const hints = [
            CC.neon('←→') + CC.dim(' 切日'),
            CC.neon('[]') + CC.dim(' 切月'),
            CC.neon('t') + CC.dim(' 今天'),
            CC.neon('↑↓') + CC.dim(' 选择'),
            CC.neon('Enter') + CC.dim(' 详情'),
            CC.neon('ESC') + CC.dim(' 关闭'),
        ];
        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}

// ━━━ 详情视图 ━━━

class EventDetailView implements Component {
    constructor(private event: CalendarItem, private availableLines: number) { }
    invalidate() { }
    render(width: number): string[] {
        const lines: string[] = [];
        const e = this.event;

        // header bar
        const bar = CC.ghost('━'.repeat(width));
        const logo = CC.neonBold('◈');
        const title = CC.neonBold(' 日程详情');
        const hint = CC.dim('ESC 返回');
        const leftPart = `  ${logo}${title}`;
        const leftVis = visibleWidth(leftPart);
        const rightVis = visibleWidth(hint);
        const gap = Math.max(1, width - leftVis - rightVis);

        let titleLine: string;
        if (leftVis + rightVis >= width) {
            titleLine = truncateToWidth(leftPart, width, '…');
        } else {
            titleLine = leftPart + ' '.repeat(gap) + hint;
        }
        lines.push(bar);
        lines.push(truncateToWidth(titleLine, width, '…'));
        lines.push(bar);

        // 空行
        lines.push('');

        // 标题
        const cancelTag = e.isCancelled ? CC.red(' [已取消]') : '';
        lines.push(truncateToWidth(`  ${CC.bright(e.subject || '(无标题)')}${cancelTag}`, width, '…'));
        lines.push('');

        // 元数据
        const metaLine = (label: string, value: string) => {
            const styledLabel = CC.dim(label + '  ');
            return truncateToWidth(`  ${styledLabel}${value}`, width, '…');
        };

        // 时间
        const startDate = new Date(e.startTime);
        const endDate = new Date(e.endTime);
        if (e.isAllDay) {
            lines.push(metaLine('时  间', CC.amber('全天')));
        } else {
            const startStr = formatTime(e.startTime);
            const endStr = formatTime(e.endTime);
            lines.push(metaLine('时  间', CC.text(`${startStr} — ${endStr}`)));
        }

        // 日期
        lines.push(metaLine('日  期', CC.text(formatDateFull(startDate))));

        // 持续时长
        if (!e.isAllDay) {
            const durationMin = Math.round((e.endTime - e.startTime) / 60000);
            const hours = Math.floor(durationMin / 60);
            const mins = durationMin % 60;
            let durationStr = '';
            if (hours > 0) durationStr += `${hours}小时`;
            if (mins > 0) durationStr += `${mins}分钟`;
            if (durationStr) {
                lines.push(metaLine('时  长', CC.dim(durationStr)));
            }
        }

        // 地点
        if (e.location) {
            lines.push(metaLine('地  点', CC.accent(e.location)));
        }

        // 分隔线
        lines.push('');
        lines.push(CC.ghost('─'.repeat(width)));

        // 底部提示填充
        while (lines.length < this.availableLines - 1) {
            lines.push('');
        }

        // footer
        const footerHints = [
            CC.neon('q/ESC') + CC.dim(' 返回'),
        ];
        lines.push(truncateToWidth('  ' + footerHints.join('   '), width, '…'));

        return lines;
    }
}
