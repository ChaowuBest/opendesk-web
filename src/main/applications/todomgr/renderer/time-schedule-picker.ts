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

import { Cron } from 'croner';
import { escapeHtml } from '../../../../common/utils/escape.js';
import { formatDatetimeLocal, wallClockParts } from '../timezone.js';
import {
    getNextTodoRecurrenceRuns,
    getTodoRecurrenceError,
    getTodoRecurrenceDays,
    getTodoRecurrenceMonths,
    type TodoRecurrence
} from '../todo-recurrence.js';
import { describeLegacyRecurrence, describeTodoRecurrence } from '../recurrence-description.js';
import { getRecurrenceValidationIssue, type RecurrenceValidationField } from '../recurrence-validation.js';
import { fixedLayerOrigin, visibleViewportRect } from '../../../../renderer/utils/window-frame.js';
import { parseLegacyCronRecurrence } from '../legacy-cron.js';
import { describeLegacyCronInTimezone, getLegacyRecurrenceInTimezone } from './legacy-timezone.js';

type Translate = (key: string, params?: Record<string, string | number>) => string;
type Period = 'once' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'legacy';
const PERIOD_SUBMENU_IDS: Partial<Record<Period, string>> = {
    weekly: 'tm-frequency-period-day-options',
    biweekly: 'tm-frequency-period-day-options',
    monthly: 'tm-frequency-dates-options',
    yearly: 'tm-frequency-months-options'
};
type ScheduleTab = 'period' | 'interval' | 'cron';
interface FrequencyTab {
    name: ScheduleTab;
    labelKey: string;
    icon: string;
}
/** 频率页签定义：i18n key 与图标显式并列，避免拼接 key 时改名不报错（与侧边栏导航按钮一致的 14px 线性图标） */
const FREQUENCY_TABS: FrequencyTab[] = [
    {
        name: 'period',
        labelKey: 'renderer.todo.frequency.periodTab',
        icon: '<svg class="tm-frequency-tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 9.5h18"/></svg>'
    },
    {
        name: 'interval',
        labelKey: 'renderer.todo.frequency.intervalTab',
        icon: '<svg class="tm-frequency-tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>'
    },
    {
        name: 'cron',
        labelKey: 'renderer.todo.frequency.cronTab',
        icon: '<svg class="tm-frequency-tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 17 6-5-6-5"/><path d="M12.5 19H20"/></svg>'
    }
];

/** 页签顺序（键盘导航与可见性同步共用，避免各处再硬编码一份） */
const FREQUENCY_TAB_NAMES = FREQUENCY_TABS.map((tab) => tab.name);

type CalendarKind = 'dates' | 'months';
interface StoredTrigger {
    type: string;
    cronExpression?: string;
    timezone?: string;
    recurrence?: TodoRecurrence;
}
interface ExecutionPreviewOptions {
    onceTriggerAt: () => string | undefined;
    enabled: () => boolean;
}

export const TIME_SCHEDULE_CSS = `
.tm-time-schedule { font-size:var(--fs-base); }
.tm-time-schedule [hidden] { display:none !important; }
.tm-frequency-tabs { display:flex; width:100%; box-sizing:border-box; padding:4px; gap:2px; border-radius:12px; background:var(--tm-surface-muted,#f2f2f2); margin-bottom:12px; container:tm-frequency-tabs / inline-size; }
.tm-frequency-tab { flex:1 1 0; min-width:0; display:flex; align-items:center; justify-content:center; gap:6px; padding:8px 10px; border:0; border-radius:9px; background:transparent; color:var(--tm-text-secondary); font:inherit; font-weight:500; white-space:nowrap; cursor:pointer; overflow:hidden; }
.tm-frequency-tab[aria-selected="true"] { background:var(--tm-surface,#fff); color:var(--tm-text); box-shadow:0 1px 4px #0002; font-weight:600; }
.tm-frequency-tab-icon { flex:none; }
/* 文案比实测更宽时（自定义字体等）先省略，避免溢出到相邻按钮之上 */
.tm-frequency-tab > .tm-frequency-tab-label { min-width:0; overflow:hidden; text-overflow:ellipsis; }
/*
 * 空间不足时只保留图标（同侧边栏导航按钮）。按钮是等分的（flex:1 1 0），所以约束是最宽的那个
 * 按钮而不是三者需求之和：13px 下最宽的是英文 Interval（图标 14 + 间距 6 + 文案 44.8 + 内边距 20
 * = 84.8），三格共需 3×84.8 + 间距 4 + 容器内边距 8 ≈ 266px。容器查询量的是内容盒，需再减去
 * 容器内边距 8px，取 260px（≈ 外框 268px）留出字体差异余量。
 * 右栏默认内容宽 372px 与最窄的 232px 分居阈值两侧：默认显示文案，极窄时只剩图标。
 */
@container tm-frequency-tabs (max-width: 260px) {
    .tm-frequency-tab > .tm-frequency-tab-label { display:none; }
}
.tm-frequency-cron-input { font-family:'SF Mono',Consolas,monospace; }
.tm-cron-help-link { display:inline-flex; align-items:center; gap:3px; margin-top:6px; font-size:var(--fs-sm); color:var(--tm-text-muted,#8E8E93); text-decoration:none; cursor:pointer; }
.tm-cron-help-link:hover { color:var(--tm-accent,#3B82F6); }
.tm-frequency-period-trigger { display:flex; align-items:center; justify-content:space-between; width:100%; text-align:left; }
.tm-frequency-menu { position:fixed; z-index:10000; box-sizing:border-box; overflow:auto; padding:7px; border:1px solid var(--tm-border,#ddd); border-radius:12px; background:var(--tm-surface,#fff); box-shadow:0 10px 30px #0002; }
.tm-frequency-menu [hidden] { display:none !important; }
.tm-frequency-menu.tm-frequency-year-dates { z-index:10001; }
.tm-frequency-option { display:flex; width:100%; align-items:center; justify-content:space-between; padding:11px 13px; border:0; border-radius:8px; background:transparent; color:var(--tm-text); font:inherit; text-align:left; cursor:pointer; }
.tm-frequency-option:hover, .tm-frequency-option[aria-selected="true"] { background:var(--tm-surface-muted,#f5f5f5); }
.tm-frequency-option .tm-frequency-check { color:#00bfa5; }
.tm-frequency-option-icons { display:inline-flex; align-items:center; gap:12px; }
.tm-frequency-submenu-back { border-bottom:1px solid var(--tm-border,#ddd); border-radius:0; margin-bottom:5px; }
.tm-frequency-field { margin-top:12px; }
.tm-frequency-days { display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; min-height:38px; box-sizing:border-box; border:1px solid var(--tm-border,#ddd); border-radius:9px; padding:9px 12px; background:var(--tm-input-bg,var(--tm-surface)); color:var(--tm-text); font:inherit; line-height:1.5; text-align:left; cursor:pointer; }
.tm-frequency-days:focus-visible { outline:2px solid var(--tm-accent,#3b82f6); outline-offset:1px; }
.tm-frequency-selected { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.tm-frequency-placeholder, .tm-frequency-arrow { color:var(--tm-text-tertiary,#888); }
.tm-frequency-arrow { flex:none; }
.tm-frequency-select-all { border-bottom:1px solid var(--tm-border,#ddd); margin-bottom:5px; padding-bottom:12px !important; }
.tm-frequency-day-option input { margin:0; flex:none; }
.tm-frequency-day-option { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:7px; cursor:pointer; color:var(--tm-text); }
.tm-frequency-day-option:hover { background:var(--tm-surface-muted); }
.tm-frequency-interval-line { display:flex; align-items:center; flex-wrap:wrap; gap:8px; color:var(--tm-text-secondary); line-height:1.8; }
.tm-frequency-interval-line [data-days-host] { flex:1 1 170px; min-width:0; }
.tm-frequency-interval-value { display:inline-flex; align-items:center; gap:8px; flex:none; white-space:nowrap; }
.tm-frequency-hours { width:62px; border:1px solid var(--tm-border,#ddd); border-radius:8px; padding:8px; color:var(--tm-text); background:var(--tm-input-bg,var(--tm-surface)); font:inherit; text-align:center; }
.tm-frequency-interval-unit { min-width:84px; border:1px solid var(--tm-border,#ddd); border-radius:8px; padding:8px; color:var(--tm-text); background:var(--tm-input-bg,var(--tm-surface)); font:inherit; }
.tm-frequency-note { font-size:var(--fs-sm); line-height:1.6; color:var(--tm-text-tertiary,#888); margin-top:7px; }
.tm-frequency-error { margin-top:6px; color:var(--od-error,#DC2626); font-size:var(--fs-base); line-height:1.5; }
.tm-frequency-interval-line .tm-frequency-error { flex-basis:100%; margin-top:0; }
.tm-time-schedule [aria-invalid="true"][aria-describedby] { border-color:var(--od-error,#DC2626); outline-color:var(--od-error,#DC2626); }
.tm-time-schedule .tm-cron-preview { font-family:inherit; line-height:1.6; background:var(--tm-surface-muted); color:var(--tm-text-secondary); }
.tm-frequency-anchor { width:100%; box-sizing:border-box; padding:8px; border:1px solid var(--tm-border); border-radius:8px; color:var(--tm-text); background:var(--tm-input-bg); font:inherit; }
`;

export class TimeSchedulePicker {
    private root!: HTMLElement;
    private tab: ScheduleTab = 'period';
    private period: Period;
    private weekdays: Set<number>;
    private calendar: Record<CalendarKind, Set<number>>;
    private anchorAt: string;
    private onceRendered = false;
    private signature = '';
    private originalRecurrence?: TodoRecurrence;
    private executionTimeEdited = false;
    private calendarSelectionsEdited = new Set<CalendarKind>();
    private weekdaysEdited = false;
    private intervalUnitChanged = false;
    private nextIntervalRun?: Date;
    private menuTrigger: HTMLElement | null = null;
    private periodSubmenuTrigger: HTMLElement | null = null;
    private periodSubmenu: HTMLElement | null = null;
    private yearDatesTrigger: HTMLInputElement | null = null;
    private validationControls: HTMLElement[] = [];
    private previewTimer?: ReturnType<typeof setTimeout>;
    private outsideClick = (event: Event) => {
        const path = event.composedPath();
        const inMenu =
            path.includes(this.root) &&
            path.some(
                (node) =>
                    node instanceof Element &&
                    node.matches(
                        '.tm-frequency-menu, [data-days-toggle], [data-calendar-toggle], #tm-frequency-period-trigger'
                    )
            );
        if (!inMenu) this.closeMenus();
    };

    constructor(
        private container: HTMLElement,
        private t: Translate,
        private timezone: () => string,
        private renderOnce: (container: HTMLElement) => void,
        private original?: StoredTrigger,
        initialPeriod: 'once' | 'daily' = 'once',
        private executionPreview?: ExecutionPreviewOptions
    ) {
        const rawCron = original?.type === 'cron' && original.recurrence === undefined;
        // 未存时区的结构化规则仅投影到当前展示时区；原始 Cron 保留表达式和 UTC 时区。
        const recurrence =
            original?.type === 'cron' && original.timezone === undefined
                ? getLegacyRecurrenceInTimezone(original, this.timezone())
                : (original?.recurrence ??
                  (original?.cronExpression ? parseLegacyCronRecurrence(original.cronExpression) : undefined));
        this.originalRecurrence = recurrence;
        this.period =
            original?.type === 'scheduled'
                ? 'once'
                : recurrence?.mode === 'interval'
                  ? 'daily'
                  : (recurrence?.mode ?? (rawCron ? 'daily' : original?.type === 'cron' ? 'legacy' : initialPeriod));
        if (recurrence && getTodoRecurrenceError(recurrence)) this.period = 'legacy';
        this.tab = rawCron ? 'cron' : recurrence?.mode === 'interval' ? 'interval' : 'period';
        const calendarInterval =
            recurrence?.mode === 'interval' && recurrence.intervalUnit && recurrence.intervalUnit !== 'hour';
        const oldCalendarInterval = calendarInterval && recurrence.time === undefined;
        const intervalDate = calendarInterval
            ? new Date(`${formatDatetimeLocal(recurrence.anchorAt!, this.timezone()).slice(0, 10)}T00:00:00Z`)
            : undefined;
        this.weekdays = new Set(
            recurrence?.mode === 'weekly' || recurrence?.mode === 'biweekly'
                ? recurrence.weekdays
                : recurrence?.mode === 'interval'
                  ? (recurrence.weekdays ??
                    (calendarInterval && recurrence.intervalUnit === 'week' && oldCalendarInterval
                        ? [intervalDate!.getUTCDay()]
                        : []))
                  : []
        );
        this.calendar = {
            dates: new Set(
                recurrence?.mode === 'monthly' || recurrence?.mode === 'yearly'
                    ? getTodoRecurrenceDays(recurrence)
                    : calendarInterval && (recurrence.intervalUnit === 'month' || recurrence.intervalUnit === 'year')
                      ? oldCalendarInterval
                          ? [intervalDate!.getUTCDate()]
                          : getTodoRecurrenceDays(recurrence)
                      : []
            ),
            months: new Set(
                recurrence?.mode === 'yearly'
                    ? getTodoRecurrenceMonths(recurrence)
                    : calendarInterval && recurrence.intervalUnit === 'year'
                      ? oldCalendarInterval
                          ? [intervalDate!.getUTCMonth() + 1]
                          : getTodoRecurrenceMonths(recurrence)
                      : []
            )
        };
        this.anchorAt =
            recurrence?.mode === 'interval'
                ? recurrence.anchorAt!
                : new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
        this.render();
        this.signature = this.currentSignature();
        this.refreshPreview();
    }

    destroy(): void {
        clearTimeout(this.previewTimer);
        this.clearValidationError();
        this.container.ownerDocument.removeEventListener('click', this.outsideClick);
    }
    isOnce(): boolean {
        return this.tab === 'period' && this.period === 'once';
    }
    private value(selector: string): string {
        return this.root.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!.value;
    }
    private dayName(day: number): string {
        return this.t('cron.desc.dow', { day: this.t(`cron.desc.dowNames.${day}`) });
    }
    private numberOptions(count: number, selected: number, start = 0): string {
        return Array.from({ length: count }, (_, index) => start + index)
            .map(
                (value) =>
                    `<option value="${value}"${value === selected ? ' selected' : ''}>${String(value).padStart(2, '0')}</option>`
            )
            .join('');
    }

    private renderTab(tab: FrequencyTab): string {
        const label = escapeHtml(this.t(tab.labelKey));
        return `<button type="button" class="tm-frequency-tab" id="tm-frequency-${tab.name}-tab" role="tab" aria-selected="${this.tab === tab.name}" aria-controls="tm-frequency-${tab.name}-panel" data-frequency-tab="${tab.name}" title="${label}" aria-label="${label}">${tab.icon}<span class="tm-frequency-tab-label">${label}</span></button>`;
    }

    private render(): void {
        const recurrence = this.originalRecurrence;
        const anchorTime =
            recurrence?.mode === 'interval' && recurrence.intervalUnit && recurrence.intervalUnit !== 'hour'
                ? formatDatetimeLocal(recurrence.anchorAt!, this.timezone()).slice(11, 16)
                : undefined;
        const [hour, minute] = (recurrence?.time ?? anchorTime ?? '09:00').split(':').map(Number);
        const intervalValue = recurrence?.intervalValue ?? recurrence?.intervalHours ?? 1;
        const intervalUnit = recurrence?.intervalUnit ?? 'hour';
        const anchorDate =
            recurrence?.anchorDate ?? formatDatetimeLocal(new Date().toISOString(), this.timezone()).slice(0, 10);
        this.container.innerHTML = `<div class="tm-edit-field tm-time-schedule">
            <div class="tm-frequency-tabs" role="tablist" aria-label="${escapeHtml(this.t('renderer.todo.frequency.label'))}">
                ${FREQUENCY_TABS.map((tab) => this.renderTab(tab)).join('')}
            </div>
            <div id="tm-frequency-period-panel" role="tabpanel" aria-labelledby="tm-frequency-period-tab">
                <button class="tm-edit-select tm-frequency-period-trigger" type="button" id="tm-frequency-period-trigger" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="tm-frequency-period-options"><span id="tm-frequency-period-label"></span><span aria-hidden="true">⌄</span></button>
                <div class="tm-frequency-menu" id="tm-frequency-period-options" role="listbox" hidden>${[
                    'once',
                    'daily',
                    'weekly',
                    'biweekly',
                    'monthly',
                    'yearly'
                ]
                    .map((mode) => {
                        const submenuId = PERIOD_SUBMENU_IDS[mode as Period];
                        return `<button type="button" role="option" class="tm-frequency-option" data-period-mode="${mode}" aria-selected="${mode === this.period}"${submenuId ? ` aria-haspopup="dialog" aria-expanded="false" aria-controls="${submenuId}"` : ''}>${escapeHtml(this.t(`renderer.todo.frequency.period.${mode}`))}<span class="tm-frequency-option-icons"><span class="tm-frequency-check" aria-hidden="true">${mode === this.period ? '✓' : ''}</span>${submenuId ? '<span class="tm-frequency-arrow" aria-hidden="true">›</span>' : ''}</span></button>`;
                    })
                    .join('')}</div>
                <div id="tm-frequency-legacy" class="tm-frequency-note">${escapeHtml(this.t('renderer.todo.frequency.legacyHint'))}<button type="button" class="tm-btn" id="tm-frequency-replace">${escapeHtml(this.t('renderer.todo.frequency.replaceLegacy'))}</button></div>
                <div id="tm-frequency-once" class="tm-frequency-field"></div>
                <div id="tm-frequency-calendar-fields">
                <div id="tm-frequency-period-weekdays" class="tm-frequency-field"><label class="tm-edit-label" for="tm-frequency-period-days">${escapeHtml(this.t('renderer.todo.frequency.weekdays'))}</label><div data-days-host="period"></div></div>
                <div id="tm-frequency-anchor" class="tm-frequency-field"><label class="tm-edit-label" for="tm-frequency-anchor-week">${escapeHtml(this.t('renderer.todo.frequency.anchorWeek'))}</label><input type="date" class="tm-frequency-anchor" id="tm-frequency-anchor-week" value="${escapeHtml(anchorDate)}"><div class="tm-frequency-note">${escapeHtml(this.t('renderer.todo.frequency.anchorWeekHint'))}</div></div>
                <div id="tm-frequency-month-field" class="tm-frequency-field"><label class="tm-edit-label" for="tm-frequency-month">${escapeHtml(this.t('renderer.todo.frequency.month'))}</label><div data-calendar-host="months"></div></div>
                <div id="tm-frequency-day-field" class="tm-frequency-field"><label class="tm-edit-label" for="tm-frequency-day">${escapeHtml(this.t('renderer.todo.frequency.day'))}</label><div data-calendar-host="dates"></div></div>
                <div id="tm-frequency-time-field" class="tm-frequency-field"><label class="tm-edit-label">${escapeHtml(this.t('renderer.todo.frequency.time'))}</label><div class="tm-cron-row"><select class="tm-cron-select" id="tm-cron-hour" aria-label="${escapeHtml(this.t('renderer.todo.frequency.hours'))}">${this.numberOptions(24, hour)}</select><span>:</span><select class="tm-cron-select" id="tm-cron-minute" aria-label="${escapeHtml(this.t('renderer.todo.frequency.time'))}">${this.numberOptions(60, minute)}</select></div></div>
                </div>
            </div>
            <div id="tm-frequency-interval-panel" role="tabpanel" aria-labelledby="tm-frequency-interval-tab"><div class="tm-frequency-interval-line"><span>${escapeHtml(this.t('renderer.todo.frequency.every'))}</span><input type="number" min="1" max="10000" step="1" class="tm-frequency-hours" id="tm-frequency-hours" aria-label="${escapeHtml(this.t('renderer.todo.frequency.intervalValueLabel'))}" value="${intervalValue}"><select class="tm-frequency-interval-unit" id="tm-frequency-interval-unit" aria-label="${escapeHtml(this.t('renderer.todo.frequency.intervalUnitLabel'))}">${(['hour', 'day', 'week', 'month', 'year'] as const).map((unit) => `<option value="${unit}"${unit === intervalUnit ? ' selected' : ''}>${escapeHtml(this.t(`renderer.todo.frequency.intervalUnit.${unit}`))}</option>`).join('')}</select></div></div>
            <div id="tm-frequency-cron-panel" role="tabpanel" aria-labelledby="tm-frequency-cron-tab">
                <label class="tm-edit-label" for="tm-cron-custom-input">${escapeHtml(this.t('renderer.todo.detail.attr.cronExpression'))}</label>
                <input type="text" class="tm-edit-input tm-frequency-cron-input" id="tm-cron-custom-input" value="${escapeHtml(this.original?.recurrence === undefined ? (this.original?.cronExpression ?? '') : '')}" placeholder="${escapeHtml(this.t('renderer.todo.cron.customPlaceholder'))}" autocomplete="off" spellcheck="false">
                <a class="tm-cron-help-link" href="https://support.huaweicloud.com/usermanual-coc/coc_um_05_03_03.html" target="_blank" rel="noopener"><i class="fas fa-circle-question" aria-hidden="true"></i>${escapeHtml(this.t('renderer.todo.cron.helpText'))}</a>
            </div>
            <div class="tm-cron-preview" id="tm-cron-preview" aria-live="polite"></div>
            <div class="tm-frequency-note" id="tm-frequency-next-run" aria-live="polite" hidden></div>
            <div class="tm-frequency-error" id="tm-frequency-validation-error" role="alert" hidden></div>
        </div>`;
        this.root = this.container.querySelector('.tm-time-schedule')!;
        this.renderDays();
        this.renderCalendar('dates');
        this.renderCalendar('months');
        this.root.addEventListener('click', (event) => this.onClick(event));
        this.root.addEventListener('input', (event) => {
            this.clearValidationError();
            const id = (event.target as HTMLElement).id;
            if (id === 'tm-cron-custom-input') this.refreshPreview();
            else if (id === 'tm-frequency-hours') this.refreshNextRun();
        });
        this.root.addEventListener('change', (event) => this.onChange(event));
        this.root.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this.closeMenus(true);
                return;
            }
            const target = event.target as HTMLElement;
            // 页签按 tabs 模式支持方向键 / Home / End 循环移动并立即激活
            if (
                target.closest('.tm-frequency-tab') &&
                (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End')
            ) {
                event.preventDefault();
                this.moveTabFocus(event.key);
                return;
            }
            if (event.key === 'ArrowLeft' && this.yearDatesTrigger && target.closest('#tm-frequency-dates-options')) {
                event.preventDefault();
                this.closeYearDates(true);
                return;
            }
            if (event.key === 'ArrowRight' && target.matches('#tm-frequency-months-options input')) {
                event.preventDefault();
                this.openYearDates(target as HTMLInputElement, true);
                return;
            }
            if (event.key === 'ArrowLeft' && this.periodSubmenu?.contains(target)) {
                event.preventDefault();
                this.closePeriodSubmenu(true);
                return;
            }
            if (event.key === 'ArrowRight' && target.matches('[data-period-mode][aria-haspopup="dialog"]')) {
                event.preventDefault();
                target.click();
                return;
            }
            if (
                (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
                target.matches('[data-days-toggle], [data-calendar-toggle]')
            ) {
                event.preventDefault();
                const menu = this.root.querySelector<HTMLElement>(`#${target.getAttribute('aria-controls')}`)!;
                if (menu.hidden) this.openMenu(menu, target);
                menu.querySelector<HTMLInputElement>('input:checked, input')?.focus();
                return;
            }
            if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && target.id === 'tm-frequency-period-trigger') {
                event.preventDefault();
                const menu = this.root.querySelector<HTMLElement>('#tm-frequency-period-options')!;
                if (menu.hidden) this.openMenu(menu, target);
                menu.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
                return;
            }
            if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && target.matches('[data-period-mode]')) {
                event.preventDefault();
                this.closePeriodSubmenu();
                const options = Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-period-mode]'));
                const index = options.indexOf(target as HTMLButtonElement);
                options[(index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length].focus();
            }
        });
        this.container.ownerDocument.addEventListener('click', this.outsideClick);
        this.updateVisibility();
        this.refreshPreview();
    }

    private renderPeriodBack(kind: string): string {
        return `<button type="button" class="tm-frequency-option tm-frequency-submenu-back" id="tm-frequency-${kind}-back" data-period-back hidden><span aria-hidden="true">‹</span><span data-back-label>${escapeHtml(this.t('renderer.todo.frequency.back'))}</span></button>`;
    }

    private renderDays(): void {
        const host = this.root.querySelector<HTMLElement>('[data-days-host="period"]')!;
        host.innerHTML = `<button type="button" class="tm-frequency-days" id="tm-frequency-period-days" data-days-toggle="period" data-selection-label="${escapeHtml(this.t('renderer.todo.frequency.weekdays'))}" aria-haspopup="dialog" aria-expanded="false" aria-controls="tm-frequency-period-day-options"><span class="tm-frequency-selected"></span><span class="tm-frequency-arrow" aria-hidden="true">⌄</span></button>
            <div class="tm-frequency-menu" id="tm-frequency-period-day-options" role="dialog" aria-label="${escapeHtml(this.t('renderer.todo.frequency.weekdays'))}" hidden>${this.renderPeriodBack('days')}<label class="tm-frequency-day-option tm-frequency-select-all"><input type="checkbox" data-select-all="period">${escapeHtml(this.t('renderer.todo.frequency.selectAll'))}</label>${[1, 2, 3, 4, 5, 6, 0].map((day) => `<label class="tm-frequency-day-option"><input type="checkbox" data-day-scope="period" data-weekday="${day}">${escapeHtml(this.dayName(day))}</label>`).join('')}</div>`;
        this.syncDays();
    }

    private calendarLabel(kind: CalendarKind, value: number): string {
        return kind === 'months'
            ? this.t(`date.month.${value}`)
            : this.t('renderer.todo.cron.domOption', { day: value });
    }

    private renderCalendar(kind: CalendarKind): void {
        const host = this.root.querySelector<HTMLElement>(`[data-calendar-host="${kind}"]`)!;
        const month = kind === 'months';
        const selectKey = month ? 'selectMonths' : 'selectDates';
        const labelKey = month ? 'month' : 'day';
        const triggerId = month ? 'tm-frequency-month' : 'tm-frequency-day';
        host.innerHTML = `<button type="button" class="tm-frequency-days" id="${triggerId}" data-calendar-toggle="${kind}" data-selection-label="${escapeHtml(this.t(`renderer.todo.frequency.${labelKey}`))}" aria-label="${escapeHtml(this.t(`renderer.todo.frequency.${selectKey}`))}" aria-haspopup="dialog" aria-expanded="false" aria-controls="tm-frequency-${kind}-options"><span class="tm-frequency-selected"></span><span class="tm-frequency-arrow" aria-hidden="true">⌄</span></button>
            <div class="tm-frequency-menu" id="tm-frequency-${kind}-options" role="dialog" aria-label="${escapeHtml(this.t(`renderer.todo.frequency.${labelKey}`))}" hidden>${this.renderPeriodBack(kind)}<label class="tm-frequency-day-option tm-frequency-select-all"><input type="checkbox" data-calendar-select-all="${kind}">${escapeHtml(this.t(`renderer.todo.frequency.${month ? 'selectAllMonths' : 'selectAllDates'}`))}</label>${Array.from(
                { length: month ? 12 : 31 },
                (_, index) => index + 1
            )
                .map(
                    (value) =>
                        `<label class="tm-frequency-day-option"><input type="checkbox" data-calendar-kind="${kind}" data-calendar-value="${value}">${escapeHtml(this.calendarLabel(kind, value))}</label>`
                )
                .join('')}</div>`;
        this.syncCalendar(kind);
    }

    private syncSelection(
        trigger: HTMLButtonElement,
        menu: HTMLElement,
        selected: Set<number>,
        valueAttribute: string,
        allSelector: string,
        placeholder: string
    ): void {
        const options = Array.from(menu.querySelectorAll<HTMLInputElement>(`input[${valueAttribute}]`));
        const labels: string[] = [];
        for (const input of options) {
            const checked = selected.has(Number(input.getAttribute(valueAttribute)));
            input.checked = checked;
            input.toggleAttribute('checked', checked);
            if (checked) labels.push(input.parentElement!.textContent!.trim());
        }
        const summary = labels.join(this.t('recurrence.desc.separator')) || placeholder;
        const text = trigger.querySelector<HTMLElement>('.tm-frequency-selected')!;
        text.textContent = summary;
        text.classList.toggle('tm-frequency-placeholder', labels.length === 0);
        trigger.title = summary;
        trigger.setAttribute('aria-label', `${trigger.dataset.selectionLabel}: ${summary}`);
        const all = menu.querySelector<HTMLInputElement>(allSelector)!;
        all.checked = labels.length === options.length;
        all.indeterminate = labels.length > 0 && labels.length < options.length;
        all.setAttribute('aria-checked', all.indeterminate ? 'mixed' : String(all.checked));
    }

    private syncDays(): void {
        this.syncSelection(
            this.root.querySelector('[data-days-toggle="period"]')!,
            this.root.querySelector('#tm-frequency-period-day-options')!,
            this.weekdays,
            'data-weekday',
            '[data-select-all]',
            this.t('renderer.todo.frequency.selectDays')
        );
    }

    private syncCalendar(kind: CalendarKind): void {
        this.syncSelection(
            this.root.querySelector(`[data-calendar-toggle="${kind}"]`)!,
            this.root.querySelector(`#tm-frequency-${kind}-options`)!,
            this.calendar[kind],
            'data-calendar-value',
            '[data-calendar-select-all]',
            this.t(`renderer.todo.frequency.${kind === 'months' ? 'selectMonths' : 'selectDates'}`)
        );
    }

    private closeMenus(restoreFocus = false): void {
        this.closePeriodSubmenu();
        this.root.querySelectorAll<HTMLElement>('.tm-frequency-menu').forEach((menu) => (menu.hidden = true));
        this.root
            .querySelectorAll<HTMLElement>('[aria-expanded]')
            .forEach((button) => button.setAttribute('aria-expanded', 'false'));
        if (restoreFocus && this.menuTrigger?.isConnected) this.menuTrigger.focus();
        this.menuTrigger = null;
    }

    private closePeriodSubmenu(restoreFocus = false): void {
        this.closeYearDates();
        const trigger = this.periodSubmenuTrigger;
        if (!trigger) return;
        this.periodSubmenu!.hidden = true;
        this.periodSubmenu!.querySelector<HTMLElement>('[data-period-back]')!.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        this.periodSubmenuTrigger = null;
        this.periodSubmenu = null;
        if (restoreFocus && trigger.isConnected) trigger.focus();
    }

    private openPeriodSubmenu(trigger: HTMLElement, menuId: string): void {
        const parent = this.root.querySelector<HTMLElement>('#tm-frequency-period-options')!;
        if (parent.hidden) this.openMenu(parent, this.root.querySelector<HTMLElement>('#tm-frequency-period-trigger')!);
        this.closePeriodSubmenu();
        const menu = this.root.querySelector<HTMLElement>(`#${menuId}`)!;
        const back = menu.querySelector<HTMLElement>('[data-period-back]')!;
        const rect = trigger.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();
        const viewport = visibleViewportRect();
        const origin = fixedLayerOrigin(menu);
        const availableWidth = Math.max(0, viewport.right - viewport.left - 24);
        const width = Math.min(220, availableWidth);
        const right = parentRect.right + 6;
        const left = parentRect.left - width - 6;
        const fitsRight = right + width <= viewport.right - 12;
        const compact = !fitsRight && left < viewport.left + 12;
        const height = Math.min(320, Math.max(0, viewport.bottom - viewport.top - 24));
        menu.hidden = false;
        back.hidden = !compact;
        const menuWidth = compact ? Math.min(parentRect.width, availableWidth) : width;
        menu.style.width = `${menuWidth}px`;
        menu.style.maxHeight = `${height}px`;
        const menuLeft = compact
            ? Math.max(viewport.left + 12, Math.min(parentRect.left, viewport.right - menuWidth - 12))
            : fitsRight
              ? right
              : left;
        menu.style.left = `${menuLeft - origin.x}px`;
        const menuHeight = Math.min(menu.scrollHeight || height, height);
        menu.style.top = `${Math.max(viewport.top + 12, Math.min(compact ? parentRect.top : rect.top, viewport.bottom - menuHeight - 12)) - origin.y}px`;
        this.periodSubmenuTrigger = trigger;
        this.periodSubmenu = menu;
        trigger.setAttribute('aria-expanded', 'true');
        (
            menu.querySelector<HTMLInputElement>('input:checked') ?? menu.querySelector<HTMLInputElement>('input')
        )?.focus();
    }

    private closeYearDates(restoreFocus = false): void {
        const trigger = this.yearDatesTrigger;
        if (!trigger) return;
        const menu = this.root.querySelector<HTMLElement>('#tm-frequency-dates-options')!;
        menu.hidden = true;
        menu.classList.remove('tm-frequency-year-dates');
        const back = menu.querySelector<HTMLElement>('[data-period-back]')!;
        back.hidden = true;
        back.querySelector<HTMLElement>('[data-back-label]')!.textContent = this.t('renderer.todo.frequency.back');
        this.yearDatesTrigger = null;
        if (restoreFocus && trigger.isConnected) trigger.focus();
    }

    private openYearDates(trigger: HTMLInputElement, focus = false): void {
        const months = this.root.querySelector<HTMLElement>('#tm-frequency-months-options')!;
        const yearly =
            this.tab === 'period' ? this.period === 'yearly' : this.value('#tm-frequency-interval-unit') === 'year';
        if (!yearly || !this.calendar.months.size || months.hidden) return;
        const menu = this.root.querySelector<HTMLElement>('#tm-frequency-dates-options')!;
        const opening = !this.yearDatesTrigger || menu.hidden;
        let focusBack = false;
        this.yearDatesTrigger = trigger;
        if (opening) {
            const parent = this.root.querySelector<HTMLElement>('#tm-frequency-period-options')!;
            const parentRect = parent.hidden ? null : parent.getBoundingClientRect();
            const rect = months.getBoundingClientRect();
            const viewport = visibleViewportRect();
            const origin = fixedLayerOrigin(menu);
            const availableWidth = Math.max(0, viewport.right - viewport.left - 24);
            const width = Math.min(220, availableWidth);
            const available = (left: number) =>
                left >= viewport.left + 12 &&
                left + width <= viewport.right - 12 &&
                (!parentRect || left + width <= parentRect.left || left >= parentRect.right);
            const right = rect.right + 6;
            const left = rect.left - width - 6;
            const fitsRight = available(right);
            const compact = !fitsRight && !available(left);
            focusBack = compact;
            const height = Math.min(320, Math.max(0, viewport.bottom - viewport.top - 24));
            menu.hidden = false;
            menu.classList.add('tm-frequency-year-dates');
            const back = menu.querySelector<HTMLElement>('[data-period-back]')!;
            back.hidden = !compact;
            back.querySelector<HTMLElement>('[data-back-label]')!.textContent = this.t(
                'renderer.todo.frequency.backMonths'
            );
            const menuWidth = compact ? Math.min(rect.width, availableWidth) : width;
            menu.style.width = `${menuWidth}px`;
            menu.style.maxHeight = `${height}px`;
            const menuLeft = compact
                ? Math.max(viewport.left + 12, Math.min(rect.left, viewport.right - menuWidth - 12))
                : fitsRight
                  ? right
                  : left;
            menu.style.left = `${menuLeft - origin.x}px`;
            const menuHeight = Math.min(menu.scrollHeight || height, height);
            menu.style.top = `${Math.max(viewport.top + 12, Math.min(rect.top, viewport.bottom - menuHeight - 12)) - origin.y}px`;
        }
        if (focusBack) menu.querySelector<HTMLElement>('[data-period-back]')!.focus();
        else if (focus)
            (
                menu.querySelector<HTMLInputElement>('input:checked') ?? menu.querySelector<HTMLInputElement>('input')
            )?.focus();
    }

    private openMenu(menu: HTMLElement, trigger: HTMLElement): void {
        const opening = menu.hidden;
        this.closeMenus();
        if (!opening) return;
        menu.hidden = false;
        this.menuTrigger = trigger;
        trigger.setAttribute('aria-expanded', 'true');
        const rect = trigger.getBoundingClientRect();
        const viewport = visibleViewportRect();
        const origin = fixedLayerOrigin(menu);
        const height = Math.min(320, Math.max(0, viewport.bottom - viewport.top - 24));
        const width = Math.min(Math.max(rect.width, 190), Math.max(0, viewport.right - viewport.left - 24));
        menu.style.width = `${width}px`;
        menu.style.maxHeight = `${height}px`;
        menu.style.left = `${Math.max(viewport.left + 12, Math.min(rect.left, viewport.right - width - 12)) - origin.x}px`;
        const below = viewport.bottom - rect.bottom - 12;
        const menuHeight = Math.min(menu.scrollHeight || height, height);
        const top = below >= menuHeight ? rect.bottom + 6 : rect.top - menuHeight - 6;
        menu.style.top = `${Math.max(viewport.top + 12, Math.min(top, viewport.bottom - menuHeight - 12)) - origin.y}px`;
    }

    /** 切换页签：同步可见性、校验提示与预览，供点击与键盘导航共用 */
    private selectTab(name: ScheduleTab): void {
        this.clearValidationError();
        this.tab = name;
        this.closeMenus();
        this.updateVisibility();
        this.refreshPreview();
    }

    /** tabs 模式的键盘导航：左右循环、Home/End 跳到首尾，并立即激活 */
    private moveTabFocus(key: string): void {
        const last = FREQUENCY_TAB_NAMES.length - 1;
        const current = FREQUENCY_TAB_NAMES.indexOf(this.tab);
        const next =
            key === 'Home'
                ? FREQUENCY_TAB_NAMES[0]
                : key === 'End'
                  ? FREQUENCY_TAB_NAMES[last]
                  : FREQUENCY_TAB_NAMES[(current + (key === 'ArrowRight' ? 1 : last)) % FREQUENCY_TAB_NAMES.length];
        this.selectTab(next);
        this.root.querySelector<HTMLButtonElement>(`.tm-frequency-tab[data-frequency-tab="${next}"]`)?.focus();
    }

    private onClick(event: Event): void {
        const button = (event.target as Element).closest<HTMLButtonElement>('button');
        if (!button) return;
        if (button.id === 'tm-frequency-period-trigger') {
            this.openMenu(this.root.querySelector('#tm-frequency-period-options')!, button);
            return;
        }
        if (button.dataset.daysToggle) {
            const scope = button.dataset.daysToggle;
            if (this.periodSubmenuTrigger || this.yearDatesTrigger) this.closeMenus();
            this.openMenu(this.root.querySelector(`#tm-frequency-${scope}-day-options`)!, button);
            return;
        }
        if (button.dataset.calendarToggle) {
            if (this.periodSubmenuTrigger || this.yearDatesTrigger) this.closeMenus();
            this.openMenu(this.root.querySelector(`#tm-frequency-${button.dataset.calendarToggle}-options`)!, button);
            return;
        }
        if (button.hasAttribute('data-period-back')) {
            if (this.yearDatesTrigger && button.id === 'tm-frequency-dates-back') {
                this.closeYearDates(true);
                return;
            }
            this.closePeriodSubmenu(true);
            return;
        }
        if (button.dataset.periodMode || button.id === 'tm-frequency-replace') {
            this.clearValidationError();
            this.period = (button.dataset.periodMode ?? 'daily') as Period;
            this.updateVisibility();
            this.refreshPreview();
            const submenuId = PERIOD_SUBMENU_IDS[this.period];
            if (submenuId) this.openPeriodSubmenu(button, submenuId);
            else this.closeMenus(true);
            return;
        } else if (button.classList.contains('tm-frequency-tab')) {
            const name = button.dataset.frequencyTab as ScheduleTab | undefined;
            if (name) this.selectTab(name);
            return;
        }
        this.updateVisibility();
        this.refreshPreview();
    }

    private onChange(event: Event): void {
        this.clearValidationError();
        const input = event.target as HTMLInputElement;
        if (input.id === 'tm-cron-hour' || input.id === 'tm-cron-minute') this.executionTimeEdited = true;
        if (input.id === 'tm-frequency-interval-unit') {
            this.closeMenus();
            this.prefillIntervalUnitChange();
            this.updateVisibility();
        }
        if (input.dataset.calendarValue !== undefined || input.dataset.calendarSelectAll) {
            const kind = (input.dataset.calendarKind ?? input.dataset.calendarSelectAll) as CalendarKind;
            this.calendarSelectionsEdited.add(kind);
            if (input.dataset.calendarSelectAll) {
                this.calendar[kind] = new Set(
                    input.checked ? Array.from({ length: kind === 'months' ? 12 : 31 }, (_, index) => index + 1) : []
                );
            } else {
                const value = Number(input.dataset.calendarValue);
                if (input.checked) this.calendar[kind].add(value);
                else this.calendar[kind].delete(value);
            }
            this.syncCalendar(kind);
            if (kind === 'months') {
                if (this.calendar.months.size) this.openYearDates(input);
                else this.closeYearDates();
            }
        }
        if (input.dataset.weekday !== undefined || input.dataset.selectAll) {
            this.weekdaysEdited = true;
            if (input.dataset.selectAll) this.weekdays = new Set(input.checked ? [0, 1, 2, 3, 4, 5, 6] : []);
            else {
                const day = Number(input.dataset.weekday);
                if (input.checked) this.weekdays.add(day);
                else this.weekdays.delete(day);
            }
            this.syncDays();
        }
        this.refreshPreview();
    }

    private prefillIntervalUnitChange(): void {
        const original = this.original?.recurrence;
        const unit = this.value('#tm-frequency-interval-unit');
        if (original?.mode !== 'interval') return;
        if (!this.intervalUnitChanged) {
            if (unit === (original.intervalUnit ?? 'hour')) return;
            // Use one original occurrence for the edit session so switching units
            // repeatedly cannot advance the new schedule's starting point.
            this.nextIntervalRun = getNextTodoRecurrenceRuns(original, this.original?.timezone ?? 'UTC', 1)[0];
        }
        this.intervalUnitChanged = true;
        if (!this.nextIntervalRun) return;

        this.anchorAt = this.nextIntervalRun.toISOString();
        const timezone = this.timezone();
        const timezoneChanged = timezone !== (this.original?.timezone ?? 'UTC');
        const local = formatDatetimeLocal(this.anchorAt, timezone);
        const date = new Date(`${local.slice(0, 10)}T00:00:00Z`);
        if (!this.executionTimeEdited) {
            const [hour, minute] = local.slice(11, 16).split(':').map(Number);
            for (const [selector, selected] of [
                ['#tm-cron-hour', hour],
                ['#tm-cron-minute', minute]
            ] as const) {
                this.root.querySelector<HTMLOptionElement>(`${selector} option[value="${selected}"]`)!.selected = true;
            }
        }
        const hourlyWeekdayFilter = unit === 'hour' && original.time === undefined && original.weekdays !== undefined;
        if (
            (unit === 'week' || hourlyWeekdayFilter) &&
            !this.weekdaysEdited &&
            (this.weekdays.size === 0 ||
                original.weekdays === undefined ||
                (timezoneChanged && !this.weekdays.has(date.getUTCDay())))
        ) {
            this.weekdays = new Set([date.getUTCDay()]);
            this.syncDays();
        }
        for (const [kind, selected] of [
            ['dates', date.getUTCDate()],
            ['months', date.getUTCMonth() + 1]
        ] as const) {
            const visible = kind === 'dates' ? unit === 'month' || unit === 'year' : unit === 'year';
            const originalSelection = kind === 'dates' ? original.days : original.months;
            if (
                visible &&
                !this.calendarSelectionsEdited.has(kind) &&
                (this.calendar[kind].size === 0 ||
                    originalSelection === undefined ||
                    (timezoneChanged && !this.calendar[kind].has(selected)))
            ) {
                this.calendar[kind] = new Set([selected]);
                this.syncCalendar(kind);
            }
        }
    }

    private updateVisibility(): void {
        for (const name of FREQUENCY_TAB_NAMES) {
            const tabButton = this.root.querySelector<HTMLButtonElement>(
                `.tm-frequency-tab[data-frequency-tab="${name}"]`
            )!;
            const selected = this.tab === name;
            tabButton.setAttribute('aria-selected', String(selected));
            // tabs 模式：只有当前页签在 Tab 键序列内，其余靠方向键到达
            tabButton.setAttribute('tabindex', selected ? '0' : '-1');
        }
        const interval = this.tab === 'interval';
        const period = this.tab === 'period';
        const unit = this.value('#tm-frequency-interval-unit');
        const calendarInterval = interval && unit !== 'hour';
        const calendarMode = interval
            ? ({ day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' } as Record<string, string>)[unit]
            : this.period;
        const fields = this.root.querySelector<HTMLElement>('#tm-frequency-calendar-fields')!;
        const panel = this.root.querySelector<HTMLElement>(`#tm-frequency-${interval ? 'interval' : 'period'}-panel`)!;
        if (fields.parentElement !== panel) panel.appendChild(fields);
        const visible: Record<string, boolean> = {
            'tm-frequency-period-panel': period,
            'tm-frequency-interval-panel': interval,
            'tm-frequency-cron-panel': this.tab === 'cron',
            'tm-frequency-once': period && this.period === 'once',
            'tm-frequency-legacy': period && this.period === 'legacy',
            'tm-frequency-calendar-fields':
                calendarInterval || (period && this.period !== 'once' && this.period !== 'legacy'),
            'tm-frequency-period-weekdays': calendarMode === 'weekly' || calendarMode === 'biweekly',
            'tm-frequency-anchor': period && this.period === 'biweekly',
            'tm-frequency-month-field': calendarMode === 'yearly',
            'tm-frequency-day-field': calendarMode === 'monthly' || calendarMode === 'yearly',
            'tm-frequency-time-field':
                calendarInterval || (period && this.period !== 'once' && this.period !== 'legacy')
        };
        for (const [id, show] of Object.entries(visible))
            this.root.querySelector<HTMLElement>(`#${id}`)!.hidden = !show;
        const trigger = this.root.querySelector<HTMLButtonElement>('#tm-frequency-period-trigger')!;
        trigger.disabled = this.period === 'legacy';
        this.root.querySelector('#tm-frequency-period-label')!.textContent = this.t(
            `renderer.todo.frequency.${this.period === 'legacy' ? 'legacy' : `period.${this.period}`}`
        );
        this.root.querySelectorAll<HTMLElement>('[data-period-mode]').forEach((option) => {
            const selected = option.dataset.periodMode === this.period;
            option.setAttribute('aria-selected', String(selected));
            option.querySelector('.tm-frequency-check')!.textContent = selected ? '✓' : '';
        });
        if (this.isOnce() && !this.onceRendered) {
            this.renderOnce(this.root.querySelector('#tm-frequency-once')!);
            this.onceRendered = true;
        }
    }

    getRecurrence(): TodoRecurrence | undefined {
        if (this.tab === 'cron') return;
        if (this.tab === 'interval') {
            const value = Number(this.value('#tm-frequency-hours'));
            const unit = this.value('#tm-frequency-interval-unit') as TodoRecurrence['intervalUnit'];
            const legacy =
                !this.intervalUnitChanged &&
                this.originalRecurrence?.mode === 'interval' &&
                this.originalRecurrence.intervalUnit === undefined &&
                this.originalRecurrence.intervalHours !== undefined &&
                unit === 'hour' &&
                value === this.originalRecurrence.intervalHours;
            const time = `${this.value('#tm-cron-hour').padStart(2, '0')}:${this.value('#tm-cron-minute').padStart(2, '0')}`;
            if (legacy)
                return {
                    mode: 'interval',
                    intervalHours: value,
                    anchorAt: this.anchorAt,
                    weekdays: [...new Set(this.originalRecurrence?.weekdays)].sort()
                };

            const originalElapsedInterval =
                this.originalRecurrence?.mode === 'interval' &&
                this.originalRecurrence.intervalUnit !== undefined &&
                this.originalRecurrence.time === undefined;
            const preserveElapsedInterval =
                !this.intervalUnitChanged &&
                originalElapsedInterval &&
                unit === this.originalRecurrence?.intervalUnit &&
                !this.executionTimeEdited &&
                this.calendarSelectionsEdited.size === 0;
            const recurrence: TodoRecurrence = {
                mode: 'interval',
                intervalValue: value,
                intervalUnit: unit,
                anchorAt: this.anchorAt
            };
            if (unit !== 'hour' && !preserveElapsedInterval) recurrence.time = time;

            if (preserveElapsedInterval) {
                if (this.originalRecurrence?.weekdays !== undefined || this.weekdaysEdited)
                    recurrence.weekdays = [...this.weekdays].sort();
            } else if (
                unit === 'week' ||
                (unit === 'hour' &&
                    this.originalRecurrence?.mode === 'interval' &&
                    this.originalRecurrence.time === undefined &&
                    this.originalRecurrence.weekdays !== undefined)
            ) {
                recurrence.weekdays = [...this.weekdays].sort();
            }
            if (!preserveElapsedInterval && (unit === 'month' || unit === 'year'))
                recurrence.days = [...this.calendar.dates].sort((a, b) => a - b);
            if (!preserveElapsedInterval && unit === 'year')
                recurrence.months = [...this.calendar.months].sort((a, b) => a - b);
            return recurrence;
        }
        if (this.period === 'once' || this.period === 'legacy') return;
        const time = `${this.value('#tm-cron-hour').padStart(2, '0')}:${this.value('#tm-cron-minute').padStart(2, '0')}`;
        if (this.period === 'weekly' || this.period === 'biweekly')
            return {
                mode: this.period,
                time,
                weekdays: [...this.weekdays].sort(),
                ...(this.period === 'biweekly' ? { anchorDate: this.value('#tm-frequency-anchor-week') } : {})
            };
        if (this.period === 'monthly' || this.period === 'yearly')
            return {
                mode: this.period,
                time,
                days: [...this.calendar.dates].sort((a, b) => a - b),
                ...(this.period === 'yearly' ? { months: [...this.calendar.months].sort((a, b) => a - b) } : {})
            };
        return { mode: 'daily', time };
    }

    private currentSignature(): string {
        if (this.tab === 'cron') return JSON.stringify({ cronExpression: this.value('#tm-cron-custom-input').trim() });
        return JSON.stringify(this.getRecurrence()) ?? this.period;
    }

    isUnchanged(): boolean {
        return this.currentSignature() === this.signature;
    }

    hasValidationError(): boolean {
        const error = this.root.querySelector<HTMLElement>('#tm-frequency-validation-error');
        return !!error && !error.hidden;
    }

    clearValidationError(): void {
        const error = this.root.querySelector<HTMLElement>('#tm-frequency-validation-error');
        if (error) {
            error.hidden = true;
            error.textContent = '';
        }
        for (const control of this.validationControls) {
            control.removeAttribute('aria-invalid');
            const describedBy = (control.getAttribute('aria-describedby') ?? '')
                .split(/\s+/)
                .filter((id) => id && id !== 'tm-frequency-validation-error');
            if (describedBy.length) control.setAttribute('aria-describedby', describedBy.join(' '));
            else control.removeAttribute('aria-describedby');
        }
        this.validationControls = [];
    }

    private showValidationError(field: RecurrenceValidationField, message: string): void {
        this.closeMenus();
        const intervalRow = '#tm-frequency-interval-panel .tm-frequency-interval-line';
        const fields: Record<RecurrenceValidationField, [string, string]> = {
            frequency:
                this.tab === 'cron'
                    ? ['#tm-frequency-cron-panel', '#tm-cron-custom-input']
                    : this.tab === 'interval'
                      ? [intervalRow, '#tm-frequency-interval-unit']
                      : ['#tm-frequency-period-panel', '#tm-frequency-period-trigger'],
            weekdays: ['#tm-frequency-period-weekdays', '[data-days-toggle="period"]'],
            months: ['#tm-frequency-month-field', '#tm-frequency-month'],
            days: ['#tm-frequency-day-field', '#tm-frequency-day'],
            time: ['#tm-frequency-time-field', '#tm-cron-hour, #tm-cron-minute'],
            intervalValue: [intervalRow, '#tm-frequency-hours'],
            intervalUnit: [intervalRow, '#tm-frequency-interval-unit'],
            anchorDate: ['#tm-frequency-anchor', '#tm-frequency-anchor-week'],
            anchorAt: [intervalRow, '#tm-frequency-hours']
        };
        const [hostSelector, controlSelector] = fields[field];
        const host = this.root.querySelector<HTMLElement>(hostSelector)!;
        const error = this.root.querySelector<HTMLElement>('#tm-frequency-validation-error')!;
        const before =
            field === 'frequency' && this.tab === 'period'
                ? this.root.querySelector('#tm-frequency-period-options')
                : host.querySelector('.tm-frequency-note');
        host.insertBefore(error, before);
        error.textContent = message;
        error.hidden = false;
        this.validationControls = Array.from(this.root.querySelectorAll<HTMLElement>(controlSelector));
        for (const control of this.validationControls) {
            control.setAttribute('aria-invalid', 'true');
            const describedBy = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
            control.setAttribute('aria-describedby', [...new Set([...describedBy, error.id])].join(' '));
        }
        this.validationControls[0]?.focus?.({ preventScroll: true });
        error.scrollIntoView?.({ block: 'nearest' });
    }

    getTrigger(): StoredTrigger {
        this.clearValidationError();
        const preserved = this.getPreservedTrigger();
        if (preserved) return preserved;
        if (this.tab === 'cron') {
            const message = this.getCronValidationMessage();
            if (message) {
                this.showValidationError('frequency', message);
                throw new Error(message);
            }
            return {
                type: 'cron',
                cronExpression: this.value('#tm-cron-custom-input').trim(),
                timezone: this.timezone()
            };
        }
        const recurrence = this.getRecurrence();
        const issue = getRecurrenceValidationIssue(recurrence, this.t);
        if (issue || !recurrence) {
            const message = issue?.message ?? this.t('error.recurrenceInvalid');
            this.showValidationError(issue?.field ?? 'frequency', message);
            throw new Error(message);
        }
        if (!getNextTodoRecurrenceRuns(recurrence, this.timezone(), 1).length) {
            const field =
                recurrence.mode === 'interval'
                    ? ['month', 'year'].includes(recurrence.intervalUnit ?? '')
                        ? 'days'
                        : 'intervalValue'
                    : ['monthly', 'yearly'].includes(recurrence.mode)
                      ? 'days'
                      : 'time';
            const message = this.t('error.recurrenceNoNext');
            this.showValidationError(field, message);
            throw new Error(message);
        }
        return { type: 'cron', cronExpression: '* * * * *', timezone: this.timezone(), recurrence };
    }

    private getPreservedTrigger(): StoredTrigger | undefined {
        if (this.original?.type !== 'cron' || !this.isUnchanged()) return;
        if (this.tab === 'cron') {
            if (this.original.recurrence === undefined && this.timezone() === (this.original.timezone ?? 'UTC'))
                return { ...this.original };
            return;
        }
        // 旧 UTC 规则的初始字段已换算到展示时区；未改频率时保留原 trigger，
        // 不把时区展示变化持久化成新的执行计划。预览和保存使用同一份有效规则。
        if (this.original.timezone === undefined || this.timezone() === this.original.timezone)
            return { ...this.original };
        const originalRule = this.original.recurrence;
        const oldCalendarTimezoneChanged =
            originalRule?.mode === 'interval' &&
            originalRule.intervalUnit !== undefined &&
            originalRule.intervalUnit !== 'hour' &&
            originalRule.time === undefined &&
            this.timezone() !== (this.original.timezone ?? 'UTC');
        if (!oldCalendarTimezoneChanged) return { ...this.original, timezone: this.timezone() };
    }

    private getNextCronRun(expression: string, timezone: string): Date | null {
        const cron = new Cron(expression, { timezone });
        try {
            return cron.nextRun();
        } finally {
            cron.stop();
        }
    }

    private getCronValidationMessage(): string | undefined {
        const expression = this.value('#tm-cron-custom-input').trim();
        if (!expression) return this.t('error.cronInvalid');
        try {
            if (!this.getNextCronRun(expression, this.timezone())) return this.t('error.recurrenceNoNext');
        } catch {
            return this.t('error.cronInvalid');
        }
    }

    refreshNextRun(): void {
        clearTimeout(this.previewTimer);
        const preview = this.root.querySelector<HTMLElement>('#tm-frequency-next-run')!;
        preview.textContent = '';
        preview.hidden = true;
        if (!this.executionPreview) return;
        let next: Date | null | undefined;
        let value: string;
        try {
            if (!this.executionPreview.enabled()) {
                value = this.t('renderer.todo.frequency.nextRunDisabled');
            } else {
                if (this.isOnce()) {
                    const triggerAt = this.executionPreview.onceTriggerAt();
                    if (!triggerAt) return;
                    const date = new Date(triggerAt);
                    if (!Number.isFinite(date.getTime())) return;
                    next = date.getTime() > Date.now() ? date : undefined;
                } else {
                    const preserved = this.getPreservedTrigger();
                    const timezone = preserved ? (preserved.timezone ?? 'UTC') : this.timezone();
                    const recurrence = preserved ? preserved.recurrence : this.getRecurrence();
                    if (recurrence) {
                        if (getTodoRecurrenceError(recurrence)) return;
                        next = getNextTodoRecurrenceRuns(recurrence, timezone, 1)[0];
                    } else {
                        const expression =
                            preserved?.cronExpression ??
                            (this.tab === 'cron' ? this.value('#tm-cron-custom-input').trim() : '');
                        if (!expression) return;
                        next = this.getNextCronRun(expression, timezone);
                    }
                }
                if (next) {
                    const parts = wallClockParts(next, this.timezone(), true);
                    value = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} (${this.timezone()})`;
                    // Recalculate when the shown occurrence passes, bounded to one minute for clock changes.
                    this.previewTimer = setTimeout(
                        () => this.refreshNextRun(),
                        Math.min(60_000, Math.max(1_000, next.getTime() - Date.now() + 1))
                    );
                } else {
                    value = this.t('renderer.todo.frequency.nextRunNone');
                }
            }
        } catch {
            return;
        }
        preview.textContent = this.t('renderer.todo.frequency.nextRun', { time: value });
        preview.hidden = false;
    }

    refreshPreview(): void {
        this.refreshNextRun();
        const preview = this.root.querySelector<HTMLElement>('#tm-cron-preview')!;
        preview.hidden = this.isOnce();
        if (this.isOnce()) return;
        try {
            if (this.tab === 'cron') {
                if (this.getCronValidationMessage()) throw new Error('invalid');
                preview.textContent = describeLegacyRecurrence(
                    this.value('#tm-cron-custom-input').trim(),
                    this.t,
                    this.timezone()
                );
                return;
            }
            // 旧规则的展示投影未修改时，预览也保持原计划的 UTC 语义。
            if (this.original?.type === 'cron' && this.original.timezone === undefined && this.isUnchanged()) {
                preview.textContent = describeLegacyCronInTimezone(this.original, this.timezone(), this.t);
                return;
            }
            const recurrence = this.getRecurrence();
            if (recurrence) {
                if (getTodoRecurrenceError(recurrence)) throw new Error('invalid');
                preview.textContent = describeTodoRecurrence(recurrence, this.t, this.timezone());
            } else {
                preview.textContent = describeLegacyRecurrence(this.original!.cronExpression!, this.t, this.timezone());
            }
        } catch {
            preview.textContent = '';
            preview.hidden = true;
        }
    }
}
