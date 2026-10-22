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

import { escapeHtml } from '../../../../common/utils/escape.js';
import { formatDatetimeLocal } from '../../../../common/utils/timezone.js';
import {
    getNextTodoRecurrenceRuns,
    getTodoRecurrenceError,
    getTodoRecurrenceDays,
    getTodoRecurrenceMonths,
    type TodoRecurrence
} from '../../../../common/utils/todo-recurrence.js';
import { describeLegacyRecurrence, describeTodoRecurrence } from '../recurrence-description.js';

type Translate = (key: string, params?: Record<string, string | number>) => string;
type Period = 'once' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'legacy';
const PERIOD_SUBMENU_IDS: Partial<Record<Period, string>> = {
    weekly: 'tm-frequency-period-day-options',
    biweekly: 'tm-frequency-period-day-options',
    monthly: 'tm-frequency-dates-options',
    yearly: 'tm-frequency-months-options'
};
type DayScope = 'period' | 'interval';
type CalendarKind = 'dates' | 'months';
interface StoredTrigger {
    type: string;
    cronExpression?: string;
    timezone?: string;
    recurrence?: TodoRecurrence;
}

export const TIME_SCHEDULE_CSS = `
.tm-time-schedule { font-size:var(--fs-base); }
.tm-time-schedule [hidden] { display:none !important; }
.tm-frequency-tabs { display:inline-flex; padding:4px; gap:2px; border-radius:12px; background:var(--tm-surface-muted,#f2f2f2); margin-bottom:12px; }
.tm-frequency-tab { padding:8px 22px; border:0; border-radius:9px; background:transparent; color:var(--tm-text-secondary); font:inherit; font-weight:500; cursor:pointer; }
.tm-frequency-tab[aria-selected="true"] { background:var(--tm-surface,#fff); color:var(--tm-text); box-shadow:0 1px 4px #0002; font-weight:600; }
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
.tm-frequency-note { font-size:var(--fs-sm); line-height:1.6; color:var(--tm-text-tertiary,#888); margin-top:7px; }
.tm-time-schedule .tm-cron-preview { font-family:inherit; line-height:1.6; background:var(--tm-surface-muted); color:var(--tm-text-secondary); }
.tm-frequency-anchor { width:100%; box-sizing:border-box; padding:8px; border:1px solid var(--tm-border); border-radius:8px; color:var(--tm-text); background:var(--tm-input-bg); font:inherit; }
`;

function fromLegacy(expression: string): TodoRecurrence | undefined {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return;
    const [minute, hour, day, month, weekday] = fields;
    if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || Number(minute) > 59 || Number(hour) > 23) return;
    const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    if (day !== '*' && weekday !== '*') return;
    if (month !== '*') {
        if (/^\d+$/.test(month) && /^\d+$/.test(day) && weekday === '*')
            return { mode: 'yearly', month: Number(month), day: Number(day), time };
        return;
    }
    if (weekday !== '*') {
        if (weekday === '1-5') return { mode: 'weekly', weekdays: [1, 2, 3, 4, 5], time };
        if (!/^[0-7](,[0-7])*$/.test(weekday)) return;
        return {
            mode: 'weekly',
            weekdays: [...new Set(weekday.split(',').map((value) => Number(value) % 7))].sort(),
            time
        };
    }
    if (day !== '*') return /^\d+$/.test(day) ? { mode: 'monthly', day: Number(day), time } : undefined;
    return { mode: 'daily', time };
}

export class TimeSchedulePicker {
    private root!: HTMLElement;
    private tab: DayScope = 'period';
    private period: Period;
    private days: Record<DayScope, Set<number>>;
    private calendar: Record<CalendarKind, Set<number>>;
    private anchorAt: string;
    private onceRendered = false;
    private signature = '';
    private originalRecurrence?: TodoRecurrence;
    private menuTrigger: HTMLElement | null = null;
    private periodSubmenuTrigger: HTMLElement | null = null;
    private periodSubmenu: HTMLElement | null = null;
    private yearDatesTrigger: HTMLInputElement | null = null;
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
        initialPeriod: 'once' | 'daily' = 'once'
    ) {
        const recurrence =
            original?.recurrence ?? (original?.cronExpression ? fromLegacy(original.cronExpression) : undefined);
        this.originalRecurrence = recurrence;
        this.period =
            original?.type === 'scheduled'
                ? 'once'
                : recurrence?.mode === 'interval'
                  ? 'daily'
                  : (recurrence?.mode ?? (original?.type === 'cron' ? 'legacy' : initialPeriod));
        if (recurrence && getTodoRecurrenceError(recurrence)) this.period = 'legacy';
        this.tab = recurrence?.mode === 'interval' ? 'interval' : 'period';
        this.days = {
            period: new Set(
                recurrence?.mode === 'weekly' || recurrence?.mode === 'biweekly' ? recurrence.weekdays : [1, 2, 3, 4, 5]
            ),
            interval: new Set(recurrence?.mode === 'interval' ? recurrence.weekdays : [0, 1, 2, 3, 4, 5, 6])
        };
        this.calendar = {
            dates: new Set(
                recurrence?.mode === 'monthly' || recurrence?.mode === 'yearly'
                    ? getTodoRecurrenceDays(recurrence)
                    : [1]
            ),
            months: new Set(recurrence?.mode === 'yearly' ? getTodoRecurrenceMonths(recurrence) : [1])
        };
        this.anchorAt =
            recurrence?.mode === 'interval'
                ? recurrence.anchorAt!
                : new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
        this.render();
        this.signature = this.currentSignature();
    }

    destroy(): void {
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

    private render(): void {
        const recurrence = this.originalRecurrence;
        const [hour, minute] = (recurrence?.time ?? '09:00').split(':').map(Number);
        const anchorDate =
            recurrence?.anchorDate ?? formatDatetimeLocal(new Date().toISOString(), this.timezone()).slice(0, 10);
        this.container.innerHTML = `<div class="tm-edit-field tm-time-schedule">
            <div class="tm-frequency-tabs" role="tablist" aria-label="${escapeHtml(this.t('renderer.todo.frequency.label'))}">
                <button type="button" class="tm-frequency-tab" id="tm-frequency-period-tab" role="tab" aria-selected="${this.tab === 'period'}" aria-controls="tm-frequency-period-panel">${escapeHtml(this.t('renderer.todo.frequency.periodTab'))}</button>
                <button type="button" class="tm-frequency-tab" id="tm-frequency-interval-tab" role="tab" aria-selected="${this.tab === 'interval'}" aria-controls="tm-frequency-interval-panel">${escapeHtml(this.t('renderer.todo.frequency.intervalTab'))}</button>
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
                <div id="tm-frequency-period-weekdays" class="tm-frequency-field"><label class="tm-edit-label" for="tm-frequency-period-days">${escapeHtml(this.t('renderer.todo.frequency.weekdays'))}</label><div data-days-host="period"></div></div>
                <div id="tm-frequency-anchor" class="tm-frequency-field"><label class="tm-edit-label" for="tm-frequency-anchor-week">${escapeHtml(this.t('renderer.todo.frequency.anchorWeek'))}</label><input type="date" class="tm-frequency-anchor" id="tm-frequency-anchor-week" value="${escapeHtml(anchorDate)}"><div class="tm-frequency-note">${escapeHtml(this.t('renderer.todo.frequency.anchorWeekHint'))}</div></div>
                <div id="tm-frequency-month-field" class="tm-frequency-field"><label class="tm-edit-label" for="tm-frequency-month">${escapeHtml(this.t('renderer.todo.frequency.month'))}</label><div data-calendar-host="months"></div></div>
                <div id="tm-frequency-day-field" class="tm-frequency-field"><label class="tm-edit-label" for="tm-frequency-day">${escapeHtml(this.t('renderer.todo.frequency.day'))}</label><div data-calendar-host="dates"></div><div class="tm-frequency-note">${escapeHtml(this.t('renderer.todo.frequency.missingDate'))}</div></div>
                <div id="tm-frequency-time-field" class="tm-frequency-field"><label class="tm-edit-label">${escapeHtml(this.t('renderer.todo.frequency.time'))}</label><div class="tm-cron-row"><select class="tm-cron-select" id="tm-cron-hour" aria-label="${escapeHtml(this.t('renderer.todo.frequency.hours'))}">${this.numberOptions(24, hour)}</select><span>:</span><select class="tm-cron-select" id="tm-cron-minute" aria-label="${escapeHtml(this.t('renderer.todo.frequency.time'))}">${this.numberOptions(60, minute)}</select></div></div>
            </div>
            <div id="tm-frequency-interval-panel" role="tabpanel" aria-labelledby="tm-frequency-interval-tab"><div class="tm-frequency-interval-line"><span>${escapeHtml(this.t('renderer.todo.frequency.everyWeek'))}</span><div data-days-host="interval"></div><div class="tm-frequency-interval-value"><span>${escapeHtml(this.t('renderer.todo.frequency.every'))}</span><input type="number" min="1" max="8760" step="1" class="tm-frequency-hours" id="tm-frequency-hours" aria-label="${escapeHtml(this.t('renderer.todo.frequency.hours'))}" value="${recurrence?.intervalHours ?? 1}"><span>${escapeHtml(this.t('renderer.todo.frequency.intervalSuffix'))}</span></div></div></div>
            <div class="tm-cron-preview" id="tm-cron-preview" aria-live="polite"></div>
        </div>`;
        this.root = this.container.querySelector('.tm-time-schedule')!;
        this.renderDays('period');
        this.renderDays('interval');
        this.renderCalendar('dates');
        this.renderCalendar('months');
        this.root.addEventListener('click', (event) => this.onClick(event));
        this.root.addEventListener('change', (event) => this.onChange(event));
        this.root.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this.closeMenus(true);
                return;
            }
            const target = event.target as HTMLElement;
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

    private renderDays(scope: DayScope): void {
        const host = this.root.querySelector<HTMLElement>(`[data-days-host="${scope}"]`)!;
        const triggerId = `tm-frequency-${scope}-days`;
        host.innerHTML = `<button type="button" class="tm-frequency-days" id="${triggerId}" data-days-toggle="${scope}" data-selection-label="${escapeHtml(this.t('renderer.todo.frequency.weekdays'))}" aria-haspopup="dialog" aria-expanded="false" aria-controls="tm-frequency-${scope}-day-options"><span class="tm-frequency-selected"></span><span class="tm-frequency-arrow" aria-hidden="true">⌄</span></button>
            <div class="tm-frequency-menu" id="tm-frequency-${scope}-day-options" role="dialog" aria-label="${escapeHtml(this.t('renderer.todo.frequency.weekdays'))}" hidden>${scope === 'period' ? this.renderPeriodBack('days') : ''}<label class="tm-frequency-day-option tm-frequency-select-all"><input type="checkbox" data-select-all="${scope}">${escapeHtml(this.t('renderer.todo.frequency.selectAll'))}</label>${[1, 2, 3, 4, 5, 6, 0].map((day) => `<label class="tm-frequency-day-option"><input type="checkbox" data-day-scope="${scope}" data-weekday="${day}">${escapeHtml(this.dayName(day))}</label>`).join('')}</div>`;
        this.syncDays(scope);
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

    private syncDays(scope: DayScope): void {
        this.syncSelection(
            this.root.querySelector(`[data-days-toggle="${scope}"]`)!,
            this.root.querySelector(`#tm-frequency-${scope}-day-options`)!,
            this.days[scope],
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
        const viewport = this.root.ownerDocument.defaultView!;
        const width = Math.min(220, viewport.innerWidth - 24);
        const right = parentRect.right + 6;
        const left = parentRect.left - width - 6;
        const fitsRight = right + width <= viewport.innerWidth - 12;
        const compact = !fitsRight && left < 12;
        const height = Math.min(320, viewport.innerHeight - 24);
        menu.hidden = false;
        back.hidden = !compact;
        menu.style.width = `${compact ? Math.min(parentRect.width, viewport.innerWidth - 24) : width}px`;
        menu.style.maxHeight = `${height}px`;
        menu.style.left = `${compact ? Math.max(12, Math.min(parentRect.left, viewport.innerWidth - parseFloat(menu.style.width) - 12)) : fitsRight ? right : left}px`;
        const menuHeight = Math.min(menu.scrollHeight || height, height);
        menu.style.top = `${Math.max(12, Math.min(compact ? parentRect.top : rect.top, viewport.innerHeight - menuHeight - 12))}px`;
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
        if (this.tab !== 'period' || this.period !== 'yearly' || !this.calendar.months.size || months.hidden) return;
        const menu = this.root.querySelector<HTMLElement>('#tm-frequency-dates-options')!;
        const opening = !this.yearDatesTrigger || menu.hidden;
        let focusBack = false;
        this.yearDatesTrigger = trigger;
        if (opening) {
            const parent = this.root.querySelector<HTMLElement>('#tm-frequency-period-options')!;
            const parentRect = parent.hidden ? null : parent.getBoundingClientRect();
            const rect = months.getBoundingClientRect();
            const viewport = this.root.ownerDocument.defaultView!;
            const width = Math.min(220, viewport.innerWidth - 24);
            const available = (left: number) =>
                left >= 12 &&
                left + width <= viewport.innerWidth - 12 &&
                (!parentRect || left + width <= parentRect.left || left >= parentRect.right);
            const right = rect.right + 6;
            const left = rect.left - width - 6;
            const fitsRight = available(right);
            const compact = !fitsRight && !available(left);
            focusBack = compact;
            const height = Math.min(320, viewport.innerHeight - 24);
            menu.hidden = false;
            menu.classList.add('tm-frequency-year-dates');
            const back = menu.querySelector<HTMLElement>('[data-period-back]')!;
            back.hidden = !compact;
            back.querySelector<HTMLElement>('[data-back-label]')!.textContent = this.t(
                'renderer.todo.frequency.backMonths'
            );
            menu.style.width = `${compact ? Math.min(rect.width, viewport.innerWidth - 24) : width}px`;
            menu.style.maxHeight = `${height}px`;
            menu.style.left = `${compact ? Math.max(12, Math.min(rect.left, viewport.innerWidth - parseFloat(menu.style.width) - 12)) : fitsRight ? right : left}px`;
            const menuHeight = Math.min(menu.scrollHeight || height, height);
            menu.style.top = `${Math.max(12, Math.min(rect.top, viewport.innerHeight - menuHeight - 12))}px`;
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
        const viewport = this.root.ownerDocument.defaultView!;
        const height = Math.min(320, Math.max(120, viewport.innerHeight - 24));
        const width = Math.min(Math.max(rect.width, 190), viewport.innerWidth - 24);
        menu.style.width = `${width}px`;
        menu.style.maxHeight = `${height}px`;
        menu.style.left = `${Math.max(12, Math.min(rect.left, viewport.innerWidth - width - 12))}px`;
        const below = viewport.innerHeight - rect.bottom - 12;
        const menuHeight = Math.min(menu.scrollHeight || height, height);
        menu.style.top = `${below >= menuHeight ? rect.bottom + 6 : Math.max(12, rect.top - menuHeight - 6)}px`;
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
            this.period = (button.dataset.periodMode ?? 'daily') as Period;
            this.updateVisibility();
            this.refreshPreview();
            const submenuId = PERIOD_SUBMENU_IDS[this.period];
            if (submenuId) this.openPeriodSubmenu(button, submenuId);
            else this.closeMenus(true);
            return;
        } else if (button.id === 'tm-frequency-period-tab' || button.id === 'tm-frequency-interval-tab') {
            this.tab = button.id === 'tm-frequency-period-tab' ? 'period' : 'interval';
            this.closeMenus();
        }
        this.updateVisibility();
        this.refreshPreview();
    }

    private onChange(event: Event): void {
        const input = event.target as HTMLInputElement;
        if (input.dataset.calendarValue !== undefined || input.dataset.calendarSelectAll) {
            const kind = (input.dataset.calendarKind ?? input.dataset.calendarSelectAll) as CalendarKind;
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
            const scope = (input.dataset.dayScope ?? input.dataset.selectAll) as DayScope;
            if (input.dataset.selectAll) this.days[scope] = new Set(input.checked ? [0, 1, 2, 3, 4, 5, 6] : []);
            else {
                const day = Number(input.dataset.weekday);
                if (input.checked) this.days[scope].add(day);
                else this.days[scope].delete(day);
            }
            this.syncDays(scope);
        }
        this.refreshPreview();
    }

    private updateVisibility(): void {
        this.root
            .querySelector('#tm-frequency-period-tab')!
            .setAttribute('aria-selected', String(this.tab === 'period'));
        this.root
            .querySelector('#tm-frequency-interval-tab')!
            .setAttribute('aria-selected', String(this.tab === 'interval'));
        const visible: Record<string, boolean> = {
            'tm-frequency-period-panel': this.tab === 'period',
            'tm-frequency-interval-panel': this.tab === 'interval',
            'tm-frequency-once': this.period === 'once',
            'tm-frequency-legacy': this.period === 'legacy',
            'tm-frequency-period-weekdays': this.period === 'weekly' || this.period === 'biweekly',
            'tm-frequency-anchor': this.period === 'biweekly',
            'tm-frequency-month-field': this.period === 'yearly',
            'tm-frequency-day-field': this.period === 'monthly' || this.period === 'yearly',
            'tm-frequency-time-field': this.period !== 'once' && this.period !== 'legacy'
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
        if (this.tab === 'interval')
            return {
                mode: 'interval',
                intervalHours: Number(this.value('#tm-frequency-hours')),
                anchorAt: this.anchorAt,
                weekdays: [...this.days.interval].sort()
            };
        if (this.period === 'once' || this.period === 'legacy') return;
        const time = `${this.value('#tm-cron-hour').padStart(2, '0')}:${this.value('#tm-cron-minute').padStart(2, '0')}`;
        if (this.period === 'weekly' || this.period === 'biweekly')
            return {
                mode: this.period,
                time,
                weekdays: [...this.days.period].sort(),
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
        return JSON.stringify(this.getRecurrence()) ?? this.period;
    }

    getTrigger(): StoredTrigger {
        if (this.original?.type === 'cron' && this.currentSignature() === this.signature)
            return { ...this.original, timezone: this.timezone() };
        const recurrence = this.getRecurrence();
        if (
            !recurrence ||
            getTodoRecurrenceError(recurrence) ||
            !getNextTodoRecurrenceRuns(recurrence, this.timezone(), 1).length
        )
            throw new Error(this.t('error.recurrenceInvalid'));
        return { type: 'cron', cronExpression: '* * * * *', timezone: this.timezone(), recurrence };
    }

    refreshPreview(): void {
        const preview = this.root.querySelector<HTMLElement>('#tm-cron-preview')!;
        preview.hidden = this.isOnce();
        if (this.isOnce()) return;
        try {
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
