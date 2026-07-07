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

import {
    type Component,
    SelectList,
    Box,
    Text,
    Key,
    matchesKey,
    visibleWidth,
    truncateToWidth
} from '../../tui/pi-tui.js';
import { HorizontalLayout } from '../../tui/components/layout';
import { defaultSelectListTheme } from '../../tui/theme';
import type { OpenDeskTUI } from '../../tui/entry';
import { ApplicationRegistry } from '../../applications/registry';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';

// ━━━ 配色方案 ━━━

const CC = {
    accent: chalk.hex('#5B9BD5'),
    accentBold: chalk.hex('#5B9BD5').bold,
    cyan: chalk.hex('#70C0E8'),
    cyanBold: chalk.hex('#70C0E8').bold,
    green: chalk.hex('#7ECE8E'),
    amber: chalk.hex('#E5A84B'),
    red: chalk.hex('#E55B5B'),
    ghost: chalk.hex('#333333'),
    dim: chalk.hex('#606060'),
    muted: chalk.hex('#808080'),
    text: chalk.hex('#c0c0c0'),
    bright: chalk.hex('#e0e0e0').bold,
    today: chalk.bgHex('#1e3a5f').hex('#70C0E8').bold,
    selected: chalk.bgHex('#1a2735').hex('#70C0E8').bold,
    weekend: chalk.hex('#D4846A'),
    otherMonth: chalk.hex('#2a2a2a'),
    section: chalk.hex('#70C0E8').bold
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
const WEEKDAY_SHORT_EN = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function formatTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatDateFull(date: Date): string {
    return (
        date.toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        }) +
        ' ' +
        WEEKDAY_NAMES[date.getDay()]
    );
}

function formatDateShort(date: Date): string {
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const wd = WEEKDAY_NAMES[date.getDay()];
    return `${m}月${d}日 ${wd}`;
}

function toDateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CalendarOverlay — 全屏日历 TUI
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const calendarSelectListTheme = {
    ...defaultSelectListTheme,
    selectedPrefix: (text: string) => chalk.bgHex('#1a2735').hex('#5B9BD5')(text),
    selectedText: (text: string) => chalk.bgHex('#1a2735').bold(text)
};

export class CalendarOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private box: Box;

    private state: CalendarViewState = 'loading';
    private currentDate: Date;
    private events: CalendarItem[] = [];
    private nextDayEvents: CalendarItem[] = [];
    private selectedEvent?: CalendarItem;
    private loadingText = '正在加载日历...';
    private errorText?: string;

    private eventList?: SelectList;
    private handle?: any;
    private inputListenerRemove?: () => void;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#0c1018').hex('#c0c0c0')(text));
        this.currentDate = new Date();
    }

    invalidate(): void {
        this.box.invalidate();
    }

    // ──────────────────── 生命周期 ────────────────────

    async show() {
        this.handle = this.openDeskTUI.tui.showOverlay(this, {
            width: '100%',
            maxHeight: '100%',
            anchor: 'center'
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
            if (data === 'h' || matchesKey(data, Key.left)) {
                this.changeDay(-1);
                return { consume: true };
            }
            if (data === 'l' || matchesKey(data, Key.right)) {
                this.changeDay(1);
                return { consume: true };
            }
            if (data === 'k') {
                this.changeDay(-7);
                return { consume: true };
            }
            if (data === 'j') {
                this.changeDay(7);
                return { consume: true };
            }
            if (data === 'H' || data === '[') {
                this.changeMonth(-1);
                return { consume: true };
            }
            if (data === 'L' || data === ']') {
                this.changeMonth(1);
                return { consume: true };
            }
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
            const nextDay = new Date(
                this.currentDate.getFullYear(),
                this.currentDate.getMonth(),
                this.currentDate.getDate() + 1
            );
            const nextDateStr = toDateString(nextDay);

            const [todayData, tomorrowData] = await Promise.all([
                callCalendarWorker('getCalendarItems', dateStr),
                callCalendarWorker('getCalendarItems', nextDateStr)
            ]);

            this.events = (Array.isArray(todayData) ? todayData : []).sort(
                (a: CalendarItem, b: CalendarItem) => a.startTime - b.startTime
            );
            this.nextDayEvents = (Array.isArray(tomorrowData) ? tomorrowData : []).sort(
                (a: CalendarItem, b: CalendarItem) => a.startTime - b.startTime
            );
            this.buildCalendarView();
        } catch (err: any) {
            logger.error(`加载日程失败: ${err}`);
            this.errorText = `加载失败: ${err?.message || '未知错误'}`;
            this.events = [];
            this.nextDayEvents = [];
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
        const newDate = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth() + delta, 1);
        const daysInNewMonth = new Date(newDate.getFullYear(), newDate.getMonth() + 1, 0).getDate();
        const day = Math.min(this.currentDate.getDate(), daysInNewMonth);
        this.currentDate = new Date(newDate.getFullYear(), newDate.getMonth(), day);
        this.loadEvents();
    }

    // ──────────────────── 日历视图 ────────────────────

    /**
     * 日历视图布局：
     *   Box padding top              1
     *   CalendarHeaderBar            2  (title + separator)
     *   空行                          1
     *   HorizontalLayout             flex (左：多月日历 | 右：事件面板)
     *   空行                          1
     *   SeparatorLine                1
     *   CalendarFooter               1
     *   Box padding bottom           1
     *   ─────────────────────────────
     *   固定合计：                     8
     */
    private buildCalendarView() {
        this.state = 'calendar';

        const rows = this.openDeskTUI.tui.terminal.rows;
        const nextDayDisplayCount = Math.max(1, Math.min(this.nextDayEvents.length, 6));
        const rightOverhead = 2 + 1 + 2 + nextDayDisplayCount + (this.errorText ? 1 : 0);
        const visibleCount = Math.max(1, rows - 8 - rightOverhead);

        const items = this.events.map((event) => ({
            value: event.uid,
            label: this.formatEventItem(event)
        }));

        if (items.length === 0) {
            items.push({ value: '__empty__', label: CC.dim('  暂无日程') });
        }

        this.eventList = new SelectList(items, visibleCount, calendarSelectListTheme);
        this.openDeskTUI.tui.setFocus(this.eventList);

        this.eventList.onSelect = async (item: any) => {
            if (item.value === '__empty__') return;
            const event = this.events.find((e) => e.uid === item.value);
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
        const timeStr = event.isAllDay ? CC.amber('全天  ') : CC.dim(formatTime(event.startTime).padEnd(6));

        const cancelledTag = event.isCancelled ? CC.red('✕ ') : '';

        const subject = event.isCancelled ? CC.dim(event.subject || '(无标题)') : CC.text(event.subject || '(无标题)');

        const location = event.location ? CC.ghost(' · ' + event.location) : '';

        return `  ${timeStr} ${cancelledTag}${subject}${location}`;
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
        const contentHeight = targetHeight - 2;

        this.box.clear();

        switch (this.state) {
            case 'loading':
                this.box.addChild(new CalendarHeaderBar(this.currentDate));
                this.box.addChild(new VerticalFiller(this.loadingText, contentHeight - 2));
                break;

            case 'calendar': {
                this.box.addChild(new CalendarHeaderBar(this.currentDate));
                this.box.addChild(new Text(''));

                const layoutSpacing = 4;
                const mainLayout = new HorizontalLayout({
                    spacing: layoutSpacing,
                    alignVertical: 'top'
                });

                const monthCount = Math.max(1, Math.min(4, Math.floor((contentHeight - 6) / 8)));

                const calendarFixedWidth = 30;
                const availableForChildren = width - 2 - layoutSpacing;
                const rightWeight = Math.max(1, availableForChildren - calendarFixedWidth);

                mainLayout.addChild(new MultiMonthPanel(this.currentDate, monthCount), calendarFixedWidth);

                const nextDay = new Date(
                    this.currentDate.getFullYear(),
                    this.currentDate.getMonth(),
                    this.currentDate.getDate() + 1
                );
                mainLayout.addChild(
                    new EventsPanel(
                        this.currentDate,
                        this.events,
                        nextDay,
                        this.nextDayEvents,
                        this.eventList,
                        this.errorText
                    ),
                    rightWeight
                );

                this.box.addChild(mainLayout);
                this.box.addChild(new Text(''));
                this.box.addChild(new SeparatorLine());
                this.box.addChild(new CalendarFooter());
                break;
            }

            case 'detail': {
                if (this.selectedEvent) {
                    this.box.addChild(new EventDetailView(this.selectedEvent, contentHeight));
                }
                break;
            }
        }

        const result = this.box.render(width).map((l) => truncateToWidth(sanitizeLine(l), width, '', true));
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
    constructor(private currentDate: Date) {}
    invalidate() {}
    render(width: number): string[] {
        const logo = CC.cyanBold('◈');
        const title = CC.cyanBold(' CALENDAR');
        const dateInfo = CC.muted(formatDateFull(this.currentDate));

        const leftPart = `  ${logo}${title}`;
        const leftVis = visibleWidth(leftPart);
        const rightVis = visibleWidth(dateInfo);
        const gap = Math.max(1, width - leftVis - rightVis - 2);

        let titleLine: string;
        if (leftVis + rightVis + 2 >= width) {
            titleLine = truncateToWidth(leftPart, width, '…');
        } else {
            titleLine = leftPart + ' '.repeat(gap) + dateInfo + '  ';
        }

        return [truncateToWidth(titleLine, width, '…'), CC.ghost('─'.repeat(width))];
    }
}

// ━━━ 多月日历面板（左侧） ━━━

class MultiMonthPanel implements Component {
    constructor(
        private selectedDate: Date,
        private monthCount: number
    ) {}
    invalidate() {}
    render(width: number): string[] {
        const lines: string[] = [];
        let year = this.selectedDate.getFullYear();
        let month = this.selectedDate.getMonth();

        for (let i = 0; i < this.monthCount; i++) {
            if (i > 0) lines.push('');
            const mini = new MiniMonth(year, month, this.selectedDate);
            lines.push(...mini.render(width));
            month++;
            if (month > 11) {
                month = 0;
                year++;
            }
        }

        return lines;
    }
}

class MiniMonth implements Component {
    private static MONTH_NAMES = [
        '1月',
        '2月',
        '3月',
        '4月',
        '5月',
        '6月',
        '7月',
        '8月',
        '9月',
        '10月',
        '11月',
        '12月'
    ];

    constructor(
        private year: number,
        private month: number,
        private selectedDate: Date
    ) {}

    invalidate() {}

    render(width: number): string[] {
        const cellW = Math.min(4, Math.max(3, Math.floor((width - 2) / 7)));
        const indent = '  ';

        const titleText = `${MiniMonth.MONTH_NAMES[this.month]} ${this.year}`;
        const titleLine = indent + CC.bright(titleText);

        const weekdayLine =
            indent +
            WEEKDAY_SHORT_EN.map((d, i) => {
                const padded = d.padStart(cellW - 1) + ' ';
                return i >= 5 ? CC.weekend(padded) : CC.dim(padded);
            }).join('');

        const firstDay = new Date(this.year, this.month, 1);
        const lastDay = new Date(this.year, this.month + 1, 0);
        const firstDayOfWeek = (firstDay.getDay() + 6) % 7;
        const daysInMonth = lastDay.getDate();
        const prevMonthLastDay = new Date(this.year, this.month, 0).getDate();

        const today = new Date();
        const isCurrentMonth = today.getFullYear() === this.year && today.getMonth() === this.month;
        const isSelectedMonth =
            this.selectedDate.getFullYear() === this.year && this.selectedDate.getMonth() === this.month;

        const cells: string[] = [];

        for (let i = firstDayOfWeek - 1; i >= 0; i--) {
            cells.push(this.fmtCell(String(prevMonthLastDay - i), cellW, 'other'));
        }

        for (let day = 1; day <= daysInMonth; day++) {
            let style: 'normal' | 'today' | 'selected' | 'other' | 'weekend' = 'normal';
            if (isSelectedMonth && day === this.selectedDate.getDate()) {
                style = 'selected';
            } else if (isCurrentMonth && day === today.getDate()) {
                style = 'today';
            } else {
                const dow = (new Date(this.year, this.month, day).getDay() + 6) % 7;
                if (dow >= 5) style = 'weekend';
            }
            cells.push(this.fmtCell(String(day), cellW, style));
        }

        const totalCells = firstDayOfWeek + daysInMonth;
        const totalRows = Math.ceil(totalCells / 7);
        for (let day = 1; cells.length < totalRows * 7; day++) {
            cells.push(this.fmtCell(String(day), cellW, 'other'));
        }

        const lines = [titleLine, weekdayLine];
        for (let row = 0; row < totalRows; row++) {
            lines.push(truncateToWidth(indent + cells.slice(row * 7, row * 7 + 7).join(''), width, ''));
        }

        return lines;
    }

    private fmtCell(text: string, cellW: number, style: 'normal' | 'today' | 'selected' | 'other' | 'weekend'): string {
        const padded = text.padStart(cellW - 1) + ' ';
        switch (style) {
            case 'selected':
                return CC.selected(padded);
            case 'today':
                return CC.today(padded);
            case 'other':
                return CC.otherMonth(padded);
            case 'weekend':
                return CC.weekend(padded);
            default:
                return CC.text(padded);
        }
    }
}

// ━━━ 事件面板（右侧） ━━━

class EventsPanel implements Component {
    constructor(
        private selectedDate: Date,
        private events: CalendarItem[],
        private nextDay: Date,
        private nextDayEvents: CalendarItem[],
        private selectList: SelectList | undefined,
        private errorText: string | undefined
    ) {}

    invalidate() {}

    render(width: number): string[] {
        const lines: string[] = [];
        const today = new Date();

        const isToday = isSameDay(this.selectedDate, today);
        const dayLabel = isToday ? '今天' : formatDateShort(this.selectedDate);
        const eventCount = this.events.length;
        const countInfo = eventCount > 0 ? CC.muted(` · ${eventCount}项日程`) : CC.dim(' · 无日程');

        lines.push(CC.section(`  ${dayLabel}`) + countInfo);
        lines.push(CC.ghost('  ' + '─'.repeat(Math.max(1, width - 4))));

        if (this.errorText) {
            lines.push(CC.red(`  ⚠ ${this.errorText}`));
        }

        if (this.selectList) {
            lines.push(...this.selectList.render(width));
        }

        lines.push('');

        const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
        const isTomorrow = isSameDay(this.nextDay, tomorrow);
        const nextLabel = isTomorrow ? '明天' : formatDateShort(this.nextDay);
        const nextCount = this.nextDayEvents.length;
        const nextCountInfo = nextCount > 0 ? CC.muted(` · ${nextCount}项日程`) : CC.dim(' · 无日程');

        lines.push(CC.section(`  ${nextLabel}`) + nextCountInfo);
        lines.push(CC.ghost('  ' + '─'.repeat(Math.max(1, width - 4))));

        if (this.nextDayEvents.length === 0) {
            lines.push(CC.dim('  暂无日程'));
        } else {
            for (const event of this.nextDayEvents.slice(0, 6)) {
                lines.push(this.fmtEvent(event, width));
            }
            if (this.nextDayEvents.length > 6) {
                lines.push(CC.dim(`  +${this.nextDayEvents.length - 6} 更多`));
            }
        }

        return lines;
    }

    private fmtEvent(event: CalendarItem, width: number): string {
        const timeStr = event.isAllDay ? CC.amber('全天  ') : CC.dim(formatTime(event.startTime).padEnd(6));

        const cancelledTag = event.isCancelled ? CC.red('✕ ') : '';
        const subject = event.isCancelled ? CC.dim(event.subject || '(无标题)') : CC.text(event.subject || '(无标题)');

        return truncateToWidth(`  ${timeStr} ${cancelledTag}${subject}`, width, '…');
    }
}

// ━━━ 通用子组件 ━━━

class SeparatorLine implements Component {
    invalidate() {}
    render(width: number): string[] {
        return [CC.ghost('─'.repeat(width))];
    }
}

class VerticalFiller implements Component {
    constructor(
        private text: string,
        private totalLines: number
    ) {}
    invalidate() {}
    render(_width: number): string[] {
        const lines: string[] = [];
        const padTop = Math.max(0, Math.floor(this.totalLines / 2));
        for (let i = 0; i < padTop; i++) lines.push('');
        lines.push(CC.cyan(`  ⟳ ${this.text}`));
        const remaining = this.totalLines - padTop - 1;
        for (let i = 0; i < remaining; i++) lines.push('');
        return lines;
    }
}

class CalendarFooter implements Component {
    invalidate() {}
    render(width: number): string[] {
        const hints = [
            CC.cyan('h/l') + CC.dim(' 切日'),
            CC.cyan('j/k') + CC.dim(' 切周'),
            CC.cyan('[]') + CC.dim(' 切月'),
            CC.cyan('t') + CC.dim(' 今天'),
            CC.cyan('↑↓') + CC.dim(' 选择'),
            CC.cyan('⏎') + CC.dim(' 详情'),
            CC.cyan('ESC') + CC.dim(' 关闭')
        ];
        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}

// ━━━ 详情视图 ━━━

class EventDetailView implements Component {
    constructor(
        private event: CalendarItem,
        private availableLines: number
    ) {}
    invalidate() {}
    render(width: number): string[] {
        const lines: string[] = [];
        const e = this.event;

        const logo = CC.cyanBold('◈');
        const title = CC.cyanBold(' 日程详情');
        const hint = CC.dim('ESC 返回');
        const leftPart = `  ${logo}${title}`;
        const leftVis = visibleWidth(leftPart);
        const rightVis = visibleWidth(hint);
        const gap = Math.max(1, width - leftVis - rightVis - 2);

        let titleLine: string;
        if (leftVis + rightVis + 2 >= width) {
            titleLine = truncateToWidth(leftPart, width, '…');
        } else {
            titleLine = leftPart + ' '.repeat(gap) + hint + '  ';
        }

        lines.push(truncateToWidth(titleLine, width, '…'));
        lines.push(CC.ghost('─'.repeat(width)));
        lines.push('');

        const cancelTag = e.isCancelled ? CC.red(' [已取消]') : '';
        lines.push(truncateToWidth(`  ${CC.bright(e.subject || '(无标题)')}${cancelTag}`, width, '…'));
        lines.push('');

        const metaLine = (label: string, value: string) =>
            truncateToWidth(`  ${CC.dim(label + '  ')}${value}`, width, '…');

        if (e.isAllDay) {
            lines.push(metaLine('时  间', CC.amber('全天')));
        } else {
            lines.push(metaLine('时  间', CC.text(`${formatTime(e.startTime)} — ${formatTime(e.endTime)}`)));
        }

        const startDate = new Date(e.startTime);
        lines.push(metaLine('日  期', CC.text(formatDateFull(startDate))));

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

        if (e.location) {
            lines.push(metaLine('地  点', CC.accent(e.location)));
        }

        lines.push('');
        lines.push(CC.ghost('─'.repeat(width)));

        while (lines.length < this.availableLines - 1) {
            lines.push('');
        }

        const footerHints = [CC.cyan('q/ESC') + CC.dim(' 返回')];
        lines.push(truncateToWidth('  ' + footerHints.join('   '), width, '…'));

        return lines;
    }
}
