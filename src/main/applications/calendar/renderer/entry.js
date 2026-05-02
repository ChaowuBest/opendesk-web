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

/* ═══════════════════════════════════════════════════
 *  CONSTANTS
 * ═══════════════════════════════════════════════════ */

const EVENT_TYPES = [
    { id: 'meeting', label: '会议', icon: 'fa-users', color: '#34C759', bg: '#ECFDF5' },
    { id: 'video', label: '视频通话', icon: 'fa-video', color: '#AF52DE', bg: '#F5F3FF' },
    { id: 'deadline', label: '截止日期', icon: 'fa-flag-checkered', color: '#FF3B30', bg: '#FEF2F2' },
    { id: 'followup', label: '跟进', icon: 'fa-phone', color: '#007AFF', bg: '#EFF6FF' },
    { id: 'other', label: '其他', icon: 'fa-calendar', color: '#FF9500', bg: '#FFFBEB' }
];

const EVENT_PALETTES = [
    { bg: '#EEF2FF', border: '#6366F1', text: '#4338CA' },
    { bg: '#FEF2F2', border: '#EF4444', text: '#B91C1C' },
    { bg: '#F0FDF4', border: '#22C55E', text: '#166534' },
    { bg: '#FFF7ED', border: '#F97316', text: '#C2410C' },
    { bg: '#FDF4FF', border: '#A855F7', text: '#7E22CE' },
    { bg: '#FFF1F2', border: '#FB7185', text: '#BE123C' },
    { bg: '#ECFEFF', border: '#06B6D4', text: '#0E7490' },
    { bg: '#FFFBEB', border: '#F59E0B', text: '#B45309' }
];

const MONTH_NAMES_SHORT = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const HOUR_HEIGHT = 60;
const WEEK_DAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'];
const WEEK_DAYS_FULL = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const WEEK_HEADER_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/* ═══════════════════════════════════════════════════
 *  CSS
 * ═══════════════════════════════════════════════════ */

const CALENDAR_CSS = `
/* ---- Root ---- */
.cal-root {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    color: #1d1d1f;
}

/* ---- Left panel ---- */
.cal-left {
    background: #FAFAFA;
    border-right: 1px solid #F0F0F0;
}

/* ---- Segmented Control (macOS style) ---- */
.cal-seg {
    position: relative; display: inline-flex; align-items: center;
    background: #F2F2F7; border-radius: 8px; padding: 2px; gap: 0;
}
.cal-seg-indicator {
    position: absolute; top: 2px; bottom: 2px; border-radius: 7px;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 0.5px 1px rgba(0,0,0,0.06);
    transition: left 0.28s cubic-bezier(0.4,0,0.2,1), width 0.28s cubic-bezier(0.4,0,0.2,1);
    z-index: 0;
}
.cal-seg-btn {
    position: relative; z-index: 1; padding: 5px 16px; font-size: 13px; font-weight: 500;
    color: #8E8E93; cursor: pointer; border: none; background: none; transition: color 0.2s;
    white-space: nowrap;
}
.cal-seg-btn.active { color: #1d1d1f; font-weight: 600; }

/* ---- Right toolbar ---- */
.cal-toolbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 36px 14px 16px 24px; border-bottom: 1px solid #F0F0F0;
    background: #fff; min-height: 64px;
}
.cal-toolbar-title {
    font-size: 16px; font-weight: 700; color: #1d1d1f; letter-spacing: -0.01em;
}
.cal-toolbar-btn {
    width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;
    border-radius: 10px; border: 1px solid #E5E5EA; background: #fff; cursor: pointer;
    color: #3C3C43; transition: all 0.15s;
}
.cal-toolbar-btn:hover { background: #F5F5F7; border-color: #D1D1D6; }
.cal-toolbar-btn:active { transform: scale(0.95); }
.cal-today-btn {
    padding: 6px 16px; border-radius: 10px; border: 1px solid #E5E5EA;
    background: #fff; font-size: 13px; font-weight: 600; color: #1d1d1f;
    cursor: pointer; transition: all 0.15s;
}
.cal-today-btn:hover { background: #F5F5F7; border-color: #D1D1D6; }
.cal-add-event-btn {
    display: flex; align-items: center; gap: 6px; padding: 8px 18px;
    border-radius: 12px; border: none; background: #1d1d1f; color: #fff;
    font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s;
    box-shadow: 0 2px 8px rgba(0,0,0,0.12);
}
.cal-add-event-btn:hover { background: #333; box-shadow: 0 4px 16px rgba(0,0,0,0.16); }
.cal-add-event-btn:active { transform: scale(0.97); }

/* ---- Month grid ---- */
.cal-month-header-row {
    display: grid; grid-template-columns: repeat(7, 1fr);
    border-bottom: 1px solid #F0F0F0; background: #fff;
}
.cal-month-header-cell {
    padding: 12px 16px; font-size: 13px; font-weight: 600; color: #8E8E93;
    text-transform: capitalize;
}
.cal-month-grid {
    display: grid; grid-template-columns: repeat(7, 1fr);
    flex: 1; min-height: 0;
}
.cal-month-cell {
    border-right: 1px solid #F5F5F7; border-bottom: 1px solid #F5F5F7;
    padding: 6px 8px; overflow: hidden; cursor: pointer; transition: background 0.15s;
    display: flex; flex-direction: column; min-height: 0;
}
.cal-month-cell:nth-child(7n) { border-right: none; }
.cal-month-cell:hover { background: #FAFBFF; }
.cal-month-cell.today { background: #F0F5FF; }
.cal-month-cell.selected { background: #EBF0FF; }
.cal-month-day-num {
    font-size: 13px; font-weight: 500; color: #1d1d1f; margin-bottom: 4px;
    width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
    border-radius: 50%; flex-shrink: 0;
}
.cal-month-day-num.today-num {
    background: #007AFF; color: #fff; font-weight: 700;
    box-shadow: 0 1px 4px rgba(0,122,255,0.3);
}
.cal-month-day-num.out-month { color: #C7C7CC; }
.cal-month-events { flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: 2px; }
.cal-month-pill {
    display: flex; align-items: center; gap: 6px;
    padding: 2px 8px; border-radius: 6px; font-size: 12px; line-height: 20px;
    font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: pointer; transition: opacity 0.15s;
}
.cal-month-pill:hover { opacity: 0.75; }
.cal-month-pill-dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
}
.cal-month-pill-time {
    font-weight: 600; flex-shrink: 0;
}
.cal-month-pill-subject {
    overflow: hidden; text-overflow: ellipsis;
}
.cal-month-more {
    font-size: 11px; font-weight: 600; color: #8E8E93; padding: 0 8px; cursor: pointer;
}
.cal-month-more:hover { color: #007AFF; }

/* ---- Week / Day columns ---- */
.cal-time-grid-header {
    display: flex; border-bottom: 1px solid #F0F0F0; background: #fff; flex-shrink: 0;
}
.cal-time-grid-header-gutter { width: 64px; flex-shrink: 0; }
.cal-time-grid-header-cell {
    flex: 1; text-align: center; padding: 10px 0 8px; border-left: 1px solid #F5F5F7;
}
.cal-time-grid-header-cell.today-col .cal-wh-day:not(.today-circle) { color: #007AFF; }
.cal-wh-weekday { font-size: 11px; font-weight: 600; color: #8E8E93; text-transform: uppercase; letter-spacing: 0.04em; }
.cal-wh-day {
    font-size: 18px; font-weight: 700; color: #1d1d1f; line-height: 1; margin-top: 2px;
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 32px; min-height: 32px;
}
.cal-wh-day.today-circle {
    width: 34px; height: 34px; border-radius: 50%; background: #007AFF; color: #fff !important;
    font-size: 15px; font-weight: 700; box-shadow: 0 1px 4px rgba(0,122,255,0.3);
}
.cal-wh-date-label {
    font-size: 11px; color: #8E8E93; font-weight: 500; margin-top: 1px;
}

/* ---- Time grid body ---- */
.cal-time-grid-body { display: flex; position: relative; padding-top: 16px; padding-bottom: 20px; }
.cal-time-grid-gutter {
    width: 64px; flex-shrink: 0; position: relative; border-right: 1px solid #F5F5F7;
}
.cal-time-grid-gutter-label {
    position: absolute; width: 100%; text-align: right; padding-right: 12px;
    font-size: 11px; font-weight: 500; color: #8E8E93; transform: translateY(-50%);
}
.cal-time-grid-cols { flex: 1; display: flex; position: relative; }
.cal-time-grid-col {
    flex: 1; position: relative; border-left: 1px solid #F5F5F7;
}
.cal-time-grid-col.today-col { background: rgba(0,122,255,0.015); }
.cal-time-grid-col.selected-col { background: rgba(99,102,241,0.03); }
.cal-time-grid-header-cell.selected-hdr { background: rgba(99,102,241,0.04); }

/* ---- All-day bar ---- */
.cal-allday-bar { display: flex; border-bottom: 1px solid #F0F0F0; background: #FAFBFF; flex-shrink: 0; min-height: 0; }
.cal-allday-gutter { width: 64px; flex-shrink: 0; display: flex; align-items: center; justify-content: flex-end; padding-right: 12px; font-size: 10px; font-weight: 600; color: #8E8E93; }
.cal-allday-cols { flex: 1; display: flex; }
.cal-allday-col { flex: 1; padding: 4px 2px; border-left: 1px solid #F5F5F7; display: flex; flex-direction: column; gap: 2px; }
.cal-allday-pill {
    padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
}
.cal-time-grid-hour-line {
    position: absolute; left: 0; right: 0; border-top: 1px solid #F0F0F0;
}
.cal-time-grid-half-line {
    position: absolute; left: 0; right: 0; border-top: 1px dashed #F8F8FA;
}

/* ---- Event block (week/day) ---- */
.cal-ev-block {
    position: absolute; border-radius: 8px; padding: 6px 10px; overflow: hidden;
    cursor: pointer; border-left: 3.5px solid transparent;
    transition: box-shadow 0.15s, transform 0.1s;
    display: flex; flex-direction: column; gap: 2px;
}
.cal-ev-block.cal-ev-compact {
    flex-direction: row; align-items: center; gap: 6px; padding: 2px 8px;
}
.cal-ev-block:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.1); transform: translateY(-1px); }
.cal-ev-block-title { font-size: 12px; font-weight: 600; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cal-ev-block-time { font-size: 11px; opacity: 0.7; line-height: 1.2; white-space: nowrap; flex-shrink: 0; }

/* ---- Now indicator ---- */
.cal-now-line {
    position: absolute; left: 0; right: 0; pointer-events: none; z-index: 20;
    display: flex; align-items: center;
}
.cal-now-dot {
    width: 10px; height: 10px; border-radius: 50%; background: #FF3B30;
    margin-left: -5px; flex-shrink: 0; box-shadow: 0 0 6px rgba(255,59,48,0.4);
}
.cal-now-rule { flex: 1; height: 2px; background: #FF3B30; }

/* ---- Context Menu ---- */
.cal-ctx {
    background: rgba(255,255,255,0.92); backdrop-filter: blur(40px) saturate(180%);
    border-radius: 12px; border: 0.5px solid rgba(0,0,0,0.1);
    box-shadow: 0 12px 40px rgba(0,0,0,0.15), 0 0 1px rgba(0,0,0,0.1);
    padding: 5px; min-width: 200px; animation: cal-pop-in 0.12s ease-out;
}
.cal-ctx-item {
    display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-radius: 8px;
    font-size: 13px; font-weight: 500; color: #1d1d1f; cursor: pointer; transition: background 0.1s;
}
.cal-ctx-item:hover { background: #007AFF; color: #fff; }
.cal-ctx-item:hover i { opacity: 1; color: #fff; }
.cal-ctx-item i { width: 16px; text-align: center; font-size: 13px; opacity: 0.55; }
.cal-ctx-item.danger { color: #FF3B30; }
.cal-ctx-item.danger:hover { background: #FF3B30; color: #fff; }
.cal-ctx-sep { height: 1px; background: rgba(0,0,0,0.06); margin: 4px 8px; }

/* ---- Modal ---- */
.cal-modal-bg {
    background: rgba(0,0,0,0.3); backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center;
    animation: cal-fade 0.2s ease-out;
}
.cal-modal-card {
    background: #fff; border-radius: 20px;
    box-shadow: 0 24px 80px rgba(0,0,0,0.2), 0 0 1px rgba(0,0,0,0.1);
    width: 460px; max-width: 92vw; max-height: 85vh; overflow-y: auto;
    animation: cal-scale-in 0.25s cubic-bezier(0.23, 1, 0.32, 1);
}
.cal-input {
    width: 100%; padding: 10px 14px; border-radius: 10px; border: 1.5px solid #E5E5EA;
    background: #FAFAFA; font-size: 14px; color: #1d1d1f;
    outline: none; transition: border-color 0.15s, box-shadow 0.15s;
}
.cal-input:focus { border-color: #007AFF; box-shadow: 0 0 0 3px rgba(0,122,255,0.12); background: #fff; }
.cal-label { display: block; font-size: 13px; font-weight: 600; color: #3C3C43; margin-bottom: 6px; }
.cal-select {
    width: 100%; padding: 10px 14px; border-radius: 10px; border: 1.5px solid #E5E5EA;
    background: #FAFAFA; font-size: 14px; color: #1d1d1f;
    outline: none; appearance: none; cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%238E8E93' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 14px center;
}
.cal-select:focus { border-color: #007AFF; box-shadow: 0 0 0 3px rgba(0,122,255,0.12); background: #fff; }
.cal-btn-primary {
    padding: 10px 24px; border-radius: 12px; border: none; font-size: 14px; font-weight: 600;
    background: #1d1d1f; color: white; cursor: pointer; transition: all 0.15s;
}
.cal-btn-primary:hover { background: #333; }
.cal-btn-primary:active { transform: scale(0.97); }
.cal-btn-secondary {
    padding: 10px 24px; border-radius: 12px; border: 1.5px solid #E5E5EA;
    font-size: 14px; font-weight: 500; background: #fff; color: #1d1d1f;
    cursor: pointer; transition: all 0.15s;
}
.cal-btn-secondary:hover { background: #F5F5F7; }

/* ---- Mini calendar ---- */
.cal-mini-grid { gap: 0; }
.cal-mini-cell {
    height: 36px; display: flex; flex-direction: column; align-items: center; justify-content: center;
    cursor: pointer; position: relative;
}
.cal-mini-num {
    width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
    border-radius: 50%; transition: background 0.12s;
}
.cal-mini-cell:hover .cal-mini-num { background: rgba(0,0,0,0.05); }
.cal-mini-cell.selected .cal-mini-num { background: #1d1d1f; color: #fff; }
.cal-mini-cell.selected:hover .cal-mini-num { background: #333; }
.cal-mini-cell.today-cell .cal-mini-num { font-weight: 800; }
.cal-mini-dot-wrap { height: 4px; margin-top: 1px; }
.cal-mini-dot { width: 4px; height: 4px; border-radius: 50%; background: #007AFF; }

/* ---- Scrollbar ---- */
.cal-scroll::-webkit-scrollbar { width: 6px; }
.cal-scroll::-webkit-scrollbar-track { background: transparent; }
.cal-scroll::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 3px; }
.cal-scroll::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.18); }

/* ---- Animations ---- */
@keyframes cal-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes cal-scale-in { from { opacity: 0; transform: scale(0.96) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
@keyframes cal-pop-in { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
@keyframes cal-detail-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.cal-detail-card { animation: cal-detail-in 0.3s ease-out; }
`;

/* ═══════════════════════════════════════════════════
 *  UTILITIES
 * ═══════════════════════════════════════════════════ */

function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function getEventColor(item) {
    if (item.type) {
        const t = EVENT_TYPES.find((et) => et.id === item.type);
        if (t) return { bg: t.bg, border: t.color, text: t.color };
    }
    return EVENT_PALETTES[hashStr(item.uid || item.subject) % EVENT_PALETTES.length];
}

function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtTime(ts) {
    const d = new Date(ts);
    const h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${m} ${ampm}`;
}

function fmtTime24(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDateFull(d) {
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function fmtMonthDay(d) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function getWeekStart(d) {
    const r = new Date(d);
    const day = r.getDay() || 7;
    r.setDate(r.getDate() - day + 1);
    r.setHours(0, 0, 0, 0);
    return r;
}

function layoutOverlapping(events) {
    const sorted = [...events].sort(
        (a, b) => a.startTime - b.startTime || b.endTime - b.startTime - (a.endTime - a.startTime)
    );
    const cols = [];
    for (const ev of sorted) {
        let placed = false;
        for (let c = 0; c < cols.length; c++) {
            const last = cols[c][cols[c].length - 1];
            if (ev.startTime >= last.endTime) {
                cols[c].push(ev);
                ev._col = c;
                placed = true;
                break;
            }
        }
        if (!placed) {
            ev._col = cols.length;
            cols.push([ev]);
        }
    }
    const total = Math.max(cols.length, 1);
    for (const ev of sorted) ev._totalCols = total;
    return sorted;
}

/* ═══════════════════════════════════════════════════
 *  CALENDAR WIDGET
 * ═══════════════════════════════════════════════════ */

class CalendarEntryWidget extends HTMLElement {
    constructor() {
        super();
        this.currentDate = new Date();
        this.viewMode = 'month';
        this.selectedEvent = null;
        this.eventsMap = new Map();
        this._nowTimer = null;
    }

    connectedCallback() {
        this._injectStyles();
        this._render();
        this._bindCore();
        this._refreshAll();
        this._nowTimer = setInterval(() => this._updateNowIndicator(), 60000);
    }

    disconnectedCallback() {
        if (this._nowTimer) clearInterval(this._nowTimer);
    }

    _injectStyles() {
        if (document.getElementById('cal-custom-css')) return;
        const s = document.createElement('style');
        s.id = 'cal-custom-css';
        s.textContent = CALENDAR_CSS;
        document.head.appendChild(s);
    }

    /* ═══════════════════════════════════════════════════
     *  MAIN LAYOUT
     * ═══════════════════════════════════════════════════ */

    _render() {
        this.innerHTML = `
        <div class="cal-root relative w-full h-full select-none" style="display:flex;">
            <splitter-widget class="w-full h-full" initial-width="320">
                <!-- Left Panel -->
                <div slot="left" class="cal-left w-full h-full overflow-hidden">
                    <div class="flex flex-col h-full">
                        <!-- Date header like ref image 2 -->
                        <div style="padding:28px 24px 0;">
                            <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:24px;">
                                <div id="cal-left-month-badge" style="background:#FF3B30;color:#fff;border-radius:10px;padding:4px 12px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;"></div>
                                <div>
                                    <div id="cal-left-date-big" style="font-size:17px;font-weight:700;color:#1d1d1f;line-height:1.2;letter-spacing:-0.01em;"></div>
                                    <div id="cal-left-date-sub" style="font-size:13px;color:#8E8E93;font-weight:500;margin-top:3px;"></div>
                                </div>
                            </div>

                            <!-- Mini calendar -->
                            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                                <h3 id="cal-mini-title" style="font-size:15px;font-weight:700;color:#1d1d1f;"></h3>
                                <div style="display:flex;gap:4px;">
                                    <button id="cal-mini-prev" class="cal-toolbar-btn" style="width:28px;height:28px;border-radius:8px;">
                                        <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
                                    </button>
                                    <button id="cal-mini-next" class="cal-toolbar-btn" style="width:28px;height:28px;border-radius:8px;">
                                        <svg width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
                                    </button>
                                </div>
                            </div>
                            <div id="cal-mini-grid" class="cal-mini-grid grid grid-cols-7" style="margin-bottom:4px;"></div>
                        </div>

                        <div style="margin:8px 24px;height:1px;background:#EBEBEB;flex-shrink:0;"></div>

                        <!-- Detail / day events -->
                        <div id="cal-detail" class="flex-1 overflow-y-auto cal-scroll" style="padding:16px 24px;"></div>
                    </div>
                </div>

                <!-- Right Panel -->
                <div slot="right" class="w-full h-full overflow-hidden" style="background:#fff;">
                    <div class="flex flex-col h-full">
                        <div id="cal-toolbar" class="cal-toolbar"></div>
                        <div id="cal-view" class="flex-1 overflow-hidden relative" style="display:flex;flex-direction:column;"></div>
                    </div>
                </div>
            </splitter-widget>
            <div id="cal-ctx" class="fixed z-[9999] hidden"></div>
            <div id="cal-modal" class="fixed inset-0 z-[9998] hidden"></div>
        </div>`;
    }

    /* ═══════════════════════════════════════════════════
     *  CORE
     * ═══════════════════════════════════════════════════ */

    _bindCore() {
        this.querySelector('#cal-mini-prev').addEventListener('click', () => {
            this.currentDate = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth() - 1, 1);
            this._refreshAll();
        });
        this.querySelector('#cal-mini-next').addEventListener('click', () => {
            this.currentDate = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth() + 1, 1);
            this._refreshAll();
        });
        document.addEventListener('click', (e) => {
            const ctx = this.querySelector('#cal-ctx');
            if (ctx && !ctx.contains(e.target)) ctx.classList.add('hidden');
        });
        document.addEventListener('contextmenu', (e) => {
            const ctx = this.querySelector('#cal-ctx');
            if (ctx && !ctx.contains(e.target) && !this.querySelector('#cal-view')?.contains(e.target)) {
                ctx.classList.add('hidden');
            }
        });
    }

    async _refreshAll() {
        await this._loadEvents();
        this._renderLeftHeader();
        this._renderMiniCalendar();
        this._renderToolbar();
        this._renderView();
        this._renderDetail();
    }

    /* ═══════════════════════════════════════════════════
     *  DATA
     * ═══════════════════════════════════════════════════ */

    async _loadEvents() {
        const y = this.currentDate.getFullYear();
        const m = this.currentDate.getMonth();
        const start = new Date(y, m - 1, 1, 0, 0, 0, 0).getTime();
        const end = new Date(y, m + 2, 0, 23, 59, 59, 999).getTime();
        try {
            const items = await window.applicationAPI.call('getCalendarItemsInRange', start, end);
            this.eventsMap.clear();
            for (const item of items) {
                const dk = dateKey(new Date(item.startTime));
                if (!this.eventsMap.has(dk)) this.eventsMap.set(dk, []);
                this.eventsMap.get(dk).push(item);
            }
        } catch {
            this.eventsMap.clear();
        }
    }

    _eventsFor(dk) {
        return this.eventsMap.get(dk) || [];
    }

    _findEvent(uid) {
        for (const arr of this.eventsMap.values()) {
            const found = arr.find((e) => e.uid === uid);
            if (found) return found;
        }
        return null;
    }

    /* ═══════════════════════════════════════════════════
     *  LEFT PANEL: HEADER
     * ═══════════════════════════════════════════════════ */

    _renderLeftHeader() {
        const d = this.currentDate;
        const badge = this.querySelector('#cal-left-month-badge');
        const big = this.querySelector('#cal-left-date-big');
        const sub = this.querySelector('#cal-left-date-sub');
        if (!badge || !big || !sub) return;

        badge.textContent = MONTH_NAMES_SHORT[d.getMonth()];
        big.textContent = `${fmtDateFull(d)}`;
        sub.textContent = WEEK_DAYS_FULL[d.getDay()];
    }

    /* ═══════════════════════════════════════════════════
     *  LEFT PANEL: MINI CALENDAR
     * ═══════════════════════════════════════════════════ */

    _renderMiniCalendar() {
        const title = this.querySelector('#cal-mini-title');
        const grid = this.querySelector('#cal-mini-grid');
        if (!title || !grid) return;

        const y = this.currentDate.getFullYear();
        const m = this.currentDate.getMonth();
        title.textContent = `${y}年 ${m + 1}月`;

        const today = new Date();
        const firstDay = new Date(y, m, 1);
        const dow = (firstDay.getDay() + 6) % 7;
        const startDate = new Date(y, m, 1 - dow);

        let html = '';
        const headers = ['一', '二', '三', '四', '五', '六', '日'];
        for (const h of headers) {
            html += `<div style="height:28px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#8E8E93;">${h}</div>`;
        }

        for (let i = 0; i < 42; i++) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + i);
            const inMonth = d.getMonth() === m;
            const isToday = isSameDay(d, today);
            const isSel = isSameDay(d, this.currentDate);
            const dk = dateKey(d);
            const hasEvents = this.eventsMap.has(dk);

            let cls = 'cal-mini-cell';
            let numStyle = `font-size:13px;font-weight:500;color:${inMonth ? '#1d1d1f' : '#C7C7CC'};`;
            if (isSel) {
                cls += ' selected';
                numStyle = 'font-size:13px;font-weight:700;';
            } else if (isToday) {
                cls += ' today-cell';
                numStyle = 'font-size:13px;color:#007AFF;';
            }

            html += `<div class="${cls}" data-mini-date="${dk}">
                <div class="cal-mini-num" style="${numStyle}">${d.getDate()}</div>
                <div class="cal-mini-dot-wrap">${hasEvents && !isSel ? '<div class="cal-mini-dot"></div>' : ''}</div>
            </div>`;
        }

        grid.innerHTML = html;
        grid.querySelectorAll('[data-mini-date]').forEach((cell) => {
            cell.addEventListener('click', () => {
                const parts = cell.dataset.miniDate.split('-');
                this.currentDate = new Date(+parts[0], +parts[1] - 1, +parts[2]);
                this._refreshAll();
            });
        });
    }

    /* ═══════════════════════════════════════════════════
     *  LEFT PANEL: DETAIL
     * ═══════════════════════════════════════════════════ */

    _renderDetail() {
        const el = this.querySelector('#cal-detail');
        if (!el) return;

        if (!this.selectedEvent) {
            const dk = dateKey(this.currentDate);
            const dayEvents = this._eventsFor(dk);

            let html = `<div style="font-size:14px;font-weight:700;color:#1d1d1f;margin-bottom:16px;">${fmtDateFull(this.currentDate)} ${WEEK_DAYS_FULL[this.currentDate.getDay()]}</div>`;

            const allDayEvents = dayEvents.filter((e) => e.isAllDay);
            const timedEvents = dayEvents.filter((e) => !e.isAllDay);

            if (allDayEvents.length > 0) {
                html += '<div style="margin-bottom:12px;">';
                html +=
                    '<div style="font-size:11px;font-weight:600;color:#8E8E93;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">全天</div>';
                for (const ev of allDayEvents) {
                    const c = getEventColor(ev);
                    html += `<div style="display:flex;gap:12px;padding:10px 12px;border-radius:12px;background:${c.bg};margin-bottom:4px;cursor:pointer;border-left:4px solid ${c.border};" data-detail-uid="${ev.uid}">
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:13px;font-weight:600;color:${c.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${ev.subject}</div>
                            ${ev.location ? `<div style="font-size:11px;color:#8E8E93;margin-top:2px;"><i class="fa-solid fa-location-dot" style="font-size:9px;margin-right:4px;"></i>${ev.location}</div>` : ''}
                        </div>
                    </div>`;
                }
                html += '</div>';
            }

            if (dayEvents.length === 0) {
                html += `<div style="text-align:center;padding-top:40px;">
                    <div style="width:56px;height:56px;border-radius:16px;background:#F2F2F7;display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">
                        <i class="fa-regular fa-calendar text-xl" style="color:#8E8E93;"></i>
                    </div>
                    <p style="font-size:14px;font-weight:600;color:#1d1d1f;">暂无日程</p>
                    <p style="font-size:12px;color:#8E8E93;margin-top:4px;">右键点击日历来添加新日程</p>
                </div>`;
            } else if (timedEvents.length > 0) {
                html += '<div style="display:flex;flex-direction:column;gap:8px;">';
                for (const ev of timedEvents) {
                    const c = getEventColor(ev);
                    html += `<div style="display:flex;gap:12px;padding:12px;border-radius:14px;background:#fff;border:1px solid #F0F0F0;cursor:pointer;transition:box-shadow 0.15s;" data-detail-uid="${ev.uid}" onmouseover="this.style.boxShadow='0 2px 12px rgba(0,0,0,0.06)'" onmouseout="this.style.boxShadow='none'">
                        <div style="width:4px;border-radius:4px;background:${c.border};flex-shrink:0;"></div>
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:14px;font-weight:600;color:#1d1d1f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${ev.subject}</div>
                            <div style="font-size:12px;color:#8E8E93;margin-top:3px;">${fmtTime(ev.startTime)} — ${fmtTime(ev.endTime)}</div>
                            ${ev.location ? `<div style="font-size:12px;color:#8E8E93;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><i class="fa-solid fa-location-dot" style="font-size:10px;margin-right:4px;"></i>${ev.location}</div>` : ''}
                        </div>
                    </div>`;
                }
                html += '</div>';
            }

            el.innerHTML = html;
            el.querySelectorAll('[data-detail-uid]').forEach((item) => {
                item.addEventListener('click', () => {
                    this.selectedEvent = this._findEvent(item.dataset.detailUid);
                    this._renderDetail();
                });
            });
            return;
        }

        const ev = this.selectedEvent;
        const c = getEventColor(ev);
        const start = new Date(ev.startTime);
        const typeDef = EVENT_TYPES.find((t) => t.id === ev.type);
        const monthLabel = MONTH_NAMES_SHORT[start.getMonth()];

        el.innerHTML = `
        <div class="cal-detail-card">
            <button id="cal-detail-back" style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:#007AFF;background:none;border:none;cursor:pointer;padding:4px 0;margin-bottom:20px;">
                <svg width="8" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
                返回
            </button>

            <div style="font-size:17px;font-weight:700;color:#1d1d1f;letter-spacing:-0.01em;margin-bottom:4px;">${ev.subject}</div>
            ${
                typeDef
                    ? `<div style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:6px;background:${c.bg};margin-bottom:20px;">
                <span style="width:6px;height:6px;border-radius:50%;background:${c.border};"></span>
                <span style="font-size:12px;font-weight:600;color:${c.text};">${typeDef.label}</span>
            </div>`
                    : ''
            }

            <div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:24px;padding:16px;border-radius:14px;background:#fff;border:1px solid #F0F0F0;">
                <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:52px;height:52px;border-radius:12px;background:#FAFAFA;border:1px solid #EBEBEB;flex-shrink:0;">
                    <span style="font-size:10px;font-weight:700;color:#FF3B30;text-transform:uppercase;">${monthLabel}</span>
                    <span style="font-size:18px;font-weight:800;color:#1d1d1f;line-height:1;">${start.getDate()}</span>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;padding-top:2px;">
                    <div style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:#1d1d1f;">
                        <i class="fa-regular fa-clock" style="color:#8E8E93;font-size:13px;"></i>
                        ${ev.isAllDay ? '全天' : `${fmtTime(ev.startTime)} — ${fmtTime(ev.endTime)}`}
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#8E8E93;">
                        <i class="fa-regular fa-calendar" style="font-size:13px;"></i>
                        ${fmtDateFull(start)} ${WEEK_DAYS_FULL[start.getDay()]}
                    </div>
                    ${
                        ev.location
                            ? `<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:#8E8E93;">
                        <i class="fa-solid fa-location-dot" style="font-size:13px;"></i>
                        ${ev.location}
                    </div>`
                            : ''
                    }
                </div>
            </div>

            <div style="display:flex;gap:8px;">
                <button id="cal-detail-edit" style="flex:1;padding:10px;border-radius:12px;border:1.5px solid #E5E5EA;background:#fff;font-size:13px;font-weight:600;color:#1d1d1f;cursor:pointer;transition:all 0.15s;text-align:center;">
                    <i class="fa-solid fa-pen" style="font-size:11px;margin-right:4px;"></i>编辑
                </button>
                <button id="cal-detail-delete" style="flex:1;padding:10px;border-radius:12px;border:1.5px solid #FFD5D5;background:#FFF5F5;font-size:13px;font-weight:600;color:#FF3B30;cursor:pointer;transition:all 0.15s;text-align:center;">
                    <i class="fa-solid fa-trash-can" style="font-size:11px;margin-right:4px;"></i>删除
                </button>
            </div>
        </div>`;

        this.querySelector('#cal-detail-back').addEventListener('click', () => {
            this.selectedEvent = null;
            this._renderDetail();
        });
        this.querySelector('#cal-detail-edit').addEventListener('click', () => this._showModal(ev));
        this.querySelector('#cal-detail-delete').addEventListener('click', () => this._deleteEvent(ev.uid));
    }

    /* ═══════════════════════════════════════════════════
     *  TOOLBAR
     * ═══════════════════════════════════════════════════ */

    _renderToolbar() {
        const tb = this.querySelector('#cal-toolbar');
        if (!tb) return;

        tb.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
            <span id="cal-toolbar-title" class="cal-toolbar-title"></span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
            <button id="cal-nav-prev" class="cal-toolbar-btn">
                <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
            </button>
            <button id="cal-nav-next" class="cal-toolbar-btn">
                <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            </button>
            <button id="cal-nav-today" class="cal-today-btn">Today</button>
            <div class="cal-seg" id="cal-seg" style="margin-left:8px;">
                <div class="cal-seg-indicator" id="cal-seg-ind"></div>
                <button class="cal-seg-btn ${this.viewMode === 'day' ? 'active' : ''}" data-view="day">日</button>
                <button class="cal-seg-btn ${this.viewMode === 'week' ? 'active' : ''}" data-view="week">周</button>
                <button class="cal-seg-btn ${this.viewMode === 'month' ? 'active' : ''}" data-view="month">月</button>
            </div>
            <button id="cal-add-btn" class="cal-add-event-btn" style="margin-left:8px;">
                <i class="fa-solid fa-plus" style="font-size:12px;"></i> 添加日程
            </button>
        </div>`;

        this.querySelector('#cal-nav-prev').addEventListener('click', () => this._navPrev());
        this.querySelector('#cal-nav-next').addEventListener('click', () => this._navNext());
        this.querySelector('#cal-nav-today').addEventListener('click', () => this._goToday());
        this.querySelector('#cal-add-btn').addEventListener('click', () => this._showModal(null));

        this.querySelector('#cal-seg')
            .querySelectorAll('.cal-seg-btn')
            .forEach((btn) => {
                btn.addEventListener('click', () => this._setView(btn.dataset.view));
            });

        this._updateToolbarTitle();
        requestAnimationFrame(() => this._moveSegIndicator());
    }

    _updateToolbarTitle() {
        const el = this.querySelector('#cal-toolbar-title');
        if (!el) return;
        const d = this.currentDate;
        if (this.viewMode === 'month') {
            el.textContent = `${d.getFullYear()}年 ${d.getMonth() + 1}月`;
        } else if (this.viewMode === 'week') {
            const ws = getWeekStart(d);
            const we = new Date(ws);
            we.setDate(we.getDate() + 6);
            el.textContent = `${fmtMonthDay(ws)} — ${fmtMonthDay(we)}, ${ws.getFullYear()}`;
        } else {
            el.textContent = `${fmtDateFull(d)} ${WEEK_DAYS_FULL[d.getDay()]}`;
        }
    }

    _moveSegIndicator() {
        const seg = this.querySelector('#cal-seg');
        const ind = this.querySelector('#cal-seg-ind');
        if (!seg || !ind) return;
        const active = seg.querySelector('.cal-seg-btn.active');
        if (!active) return;
        ind.style.left = active.offsetLeft + 'px';
        ind.style.width = active.offsetWidth + 'px';
    }

    /* ═══════════════════════════════════════════════════
     *  NAVIGATION
     * ═══════════════════════════════════════════════════ */

    _navPrev() {
        const d = this.currentDate;
        if (this.viewMode === 'month') this.currentDate = new Date(d.getFullYear(), d.getMonth() - 1, 1);
        else if (this.viewMode === 'week') {
            this.currentDate = new Date(d);
            this.currentDate.setDate(d.getDate() - 7);
        } else {
            this.currentDate = new Date(d);
            this.currentDate.setDate(d.getDate() - 1);
        }
        this._refreshAll();
    }

    _navNext() {
        const d = this.currentDate;
        if (this.viewMode === 'month') this.currentDate = new Date(d.getFullYear(), d.getMonth() + 1, 1);
        else if (this.viewMode === 'week') {
            this.currentDate = new Date(d);
            this.currentDate.setDate(d.getDate() + 7);
        } else {
            this.currentDate = new Date(d);
            this.currentDate.setDate(d.getDate() + 1);
        }
        this._refreshAll();
    }

    _goToday() {
        this.currentDate = new Date();
        this._refreshAll();
    }

    _setView(mode) {
        if (mode === this.viewMode) return;
        this.viewMode = mode;
        this.querySelector('#cal-seg')
            ?.querySelectorAll('.cal-seg-btn')
            .forEach((b) => {
                b.classList.toggle('active', b.dataset.view === mode);
            });
        this._moveSegIndicator();
        this._updateToolbarTitle();
        this._renderView();
    }

    _renderView() {
        if (this.viewMode === 'month') this._renderMonthView();
        else if (this.viewMode === 'week') this._renderWeekView();
        else this._renderDayView();
    }

    /* ═══════════════════════════════════════════════════
     *  MONTH VIEW  (ref: image 1)
     * ═══════════════════════════════════════════════════ */

    _renderMonthView() {
        const container = this.querySelector('#cal-view');
        if (!container) return;
        const y = this.currentDate.getFullYear();
        const m = this.currentDate.getMonth();
        const firstDay = new Date(y, m, 1);
        const dow = (firstDay.getDay() + 6) % 7;
        const startDate = new Date(y, m, 1 - dow);
        const today = new Date();

        let html = '';

        html += '<div class="cal-month-header-row">';
        const dayHeaders = ['Mon', 'Tues', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        for (const dh of dayHeaders) {
            html += `<div class="cal-month-header-cell">${dh}</div>`;
        }
        html += '</div>';

        html += '<div class="cal-month-grid" style="flex:1;min-height:0;">';
        for (let i = 0; i < 42; i++) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + i);
            const inMonth = d.getMonth() === m;
            const isToday = isSameDay(d, today);
            const isSel = isSameDay(d, this.currentDate);
            const dk = dateKey(d);
            const evts = this._eventsFor(dk);

            let cellCls = 'cal-month-cell';
            if (isToday) cellCls += ' today';
            if (isSel) cellCls += ' selected';

            html += `<div class="${cellCls}" data-date="${dk}">`;

            let numCls = 'cal-month-day-num';
            if (isToday) numCls += ' today-num';
            else if (!inMonth) numCls += ' out-month';
            html += `<div class="${numCls}">${d.getDate()}</div>`;

            html += '<div class="cal-month-events">';
            const maxShow = 3;
            for (let j = 0; j < Math.min(evts.length, maxShow); j++) {
                const ev = evts[j];
                const c = getEventColor(ev);
                const timeLabel = ev.isAllDay ? '全天' : fmtTime(ev.startTime);
                html += `<div class="cal-month-pill" style="background:${c.bg};color:${c.text};" data-event-uid="${ev.uid}">
                    <div class="cal-month-pill-dot" style="background:${c.border};"></div>
                    <span class="cal-month-pill-time">${timeLabel}</span>
                    <span class="cal-month-pill-subject">${ev.subject}</span>
                </div>`;
            }
            if (evts.length > maxShow) {
                html += `<div class="cal-month-more">+${evts.length - maxShow} more…</div>`;
            }
            html += '</div>';

            html += '</div>';
        }
        html += '</div>';

        container.innerHTML = html;
        this._bindViewEvents(container);
    }

    /* ═══════════════════════════════════════════════════
     *  WEEK VIEW  (ref: image 2 right side)
     * ═══════════════════════════════════════════════════ */

    _renderWeekView() {
        const container = this.querySelector('#cal-view');
        if (!container) return;
        const ws = getWeekStart(this.currentDate);
        const days = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(ws);
            d.setDate(d.getDate() + i);
            days.push(d);
        }
        const today = new Date();
        const totalH = 24 * HOUR_HEIGHT;
        const selKey = dateKey(this.currentDate);

        let html = '';

        html += '<div class="cal-time-grid-header">';
        html += '<div class="cal-time-grid-header-gutter"></div>';
        for (let i = 0; i < 7; i++) {
            const d = days[i];
            const isToday = isSameDay(d, today);
            const isSel = dateKey(d) === selKey && !isToday;
            const monthStr = `${d.getMonth() + 1}月${d.getDate()}日`;
            html += `<div class="cal-time-grid-header-cell ${isToday ? 'today-col' : ''} ${isSel ? 'selected-hdr' : ''}" data-date="${dateKey(d)}">
                <div class="cal-wh-weekday">${WEEK_HEADER_FULL[i]}</div>
                <div class="cal-wh-day ${isToday ? 'today-circle' : ''}">${d.getDate()}</div>
                <div class="cal-wh-date-label">${monthStr}</div>
            </div>`;
        }
        html += '</div>';

        let hasAllDay = false;
        for (const d of days) {
            const allDayEvts = this._eventsFor(dateKey(d)).filter((e) => e.isAllDay);
            if (allDayEvts.length > 0) {
                hasAllDay = true;
                break;
            }
        }
        if (hasAllDay) {
            html += '<div class="cal-allday-bar">';
            html += '<div class="cal-allday-gutter">全天</div>';
            html += '<div class="cal-allday-cols">';
            for (let i = 0; i < 7; i++) {
                const dk = dateKey(days[i]);
                const allDayEvts = this._eventsFor(dk).filter((e) => e.isAllDay);
                html += '<div class="cal-allday-col">';
                for (const ev of allDayEvts) {
                    const cc = getEventColor(ev);
                    html += `<div class="cal-allday-pill" style="background:${cc.bg};color:${cc.text};" data-event-uid="${ev.uid}">${ev.subject}</div>`;
                }
                html += '</div>';
            }
            html += '</div></div>';
        }

        html += `<div style="flex:1;overflow-y:auto;" class="cal-scroll" id="cal-week-scroll">`;
        html += `<div class="cal-time-grid-body" style="height:${totalH}px;position:relative;">`;

        html += '<div class="cal-time-grid-gutter">';
        for (let h = 0; h < 24; h++) {
            html += `<div class="cal-time-grid-gutter-label" style="top:${h * HOUR_HEIGHT}px;">${String(h).padStart(2, '0')}:00</div>`;
        }
        html += '</div>';

        html += '<div class="cal-time-grid-cols">';

        for (let h = 0; h < 24; h++) {
            html += `<div class="cal-time-grid-hour-line" style="top:${h * HOUR_HEIGHT}px;left:0;right:0;position:absolute;"></div>`;
            html += `<div class="cal-time-grid-half-line" style="top:${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px;left:0;right:0;position:absolute;"></div>`;
        }

        for (let i = 0; i < 7; i++) {
            const d = days[i];
            const dk = dateKey(d);
            const isToday = isSameDay(d, today);
            const isSel = dk === selKey && !isToday;
            const evts = this._eventsFor(dk).filter((e) => !e.isAllDay);
            const laid = layoutOverlapping(evts);

            html += `<div class="cal-time-grid-col ${isToday ? 'today-col' : ''} ${isSel ? 'selected-col' : ''}" data-date="${dk}">`;
            for (const ev of laid) {
                const s = new Date(ev.startTime);
                const e = new Date(ev.endTime);
                const sm = s.getHours() * 60 + s.getMinutes();
                const em = e.getHours() * 60 + e.getMinutes();
                const top = (sm / 60) * HOUR_HEIGHT;
                const height = Math.max(((em - sm) / 60) * HOUR_HEIGHT, 22);
                const left = (ev._col / ev._totalCols) * 100;
                const width = (1 / ev._totalCols) * 100;
                const cc = getEventColor(ev);
                const compact = height < 36;
                html += `<div class="cal-ev-block ${compact ? 'cal-ev-compact' : ''}" style="top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px);background:${cc.bg};border-left-color:${cc.border};color:${cc.text};" data-event-uid="${ev.uid}">
                    <div class="cal-ev-block-title">${ev.subject}</div>
                    <div class="cal-ev-block-time">${compact ? fmtTime24(ev.startTime) : `${fmtTime(ev.startTime)} – ${fmtTime(ev.endTime)}`}</div>
                </div>`;
            }
            html += '</div>';
        }

        const todayIdx = days.findIndex((dd) => isSameDay(dd, today));
        if (todayIdx >= 0) {
            const now = new Date();
            const nm = now.getHours() * 60 + now.getMinutes();
            const ntop = (nm / 60) * HOUR_HEIGHT;
            const nleft = (todayIdx / 7) * 100;
            const nw = 100 / 7;
            html += `<div class="cal-now-line" id="cal-now-line" style="top:${ntop}px;left:${nleft}%;width:${nw}%;"><div class="cal-now-dot"></div><div class="cal-now-rule"></div></div>`;
        }

        html += '</div></div></div>';

        container.innerHTML = html;
        this._bindViewEvents(container);
        this._scrollToNow('cal-week-scroll');
    }

    /* ═══════════════════════════════════════════════════
     *  DAY VIEW
     * ═══════════════════════════════════════════════════ */

    _renderDayView() {
        const container = this.querySelector('#cal-view');
        if (!container) return;
        const d = this.currentDate;
        const today = new Date();
        const isToday = isSameDay(d, today);
        const totalH = 24 * HOUR_HEIGHT;
        const dk = dateKey(d);
        const allDayEvts = this._eventsFor(dk).filter((e) => e.isAllDay);
        const evts = this._eventsFor(dk).filter((e) => !e.isAllDay);
        const laid = layoutOverlapping(evts);

        let html = '';

        if (allDayEvts.length > 0) {
            html += '<div class="cal-allday-bar">';
            html += '<div class="cal-allday-gutter">全天</div>';
            html +=
                '<div class="cal-allday-cols"><div class="cal-allday-col" style="flex-direction:row;flex-wrap:wrap;gap:4px;padding:6px 8px;">';
            for (const ev of allDayEvts) {
                const cc = getEventColor(ev);
                html += `<div class="cal-allday-pill" style="background:${cc.bg};color:${cc.text};" data-event-uid="${ev.uid}">${ev.subject}</div>`;
            }
            html += '</div></div></div>';
        }

        html += `<div style="flex:1;overflow-y:auto;" class="cal-scroll" id="cal-day-scroll">`;
        html += `<div class="cal-time-grid-body" style="height:${totalH}px;position:relative;">`;

        html += '<div class="cal-time-grid-gutter">';
        for (let h = 0; h < 24; h++) {
            html += `<div class="cal-time-grid-gutter-label" style="top:${h * HOUR_HEIGHT}px;">${String(h).padStart(2, '0')}:00</div>`;
        }
        html += '</div>';

        html += '<div class="cal-time-grid-cols">';

        for (let h = 0; h < 24; h++) {
            html += `<div class="cal-time-grid-hour-line" style="top:${h * HOUR_HEIGHT}px;left:0;right:0;position:absolute;"></div>`;
            html += `<div class="cal-time-grid-half-line" style="top:${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px;left:0;right:0;position:absolute;"></div>`;
        }

        html += `<div class="cal-time-grid-col ${isToday ? 'today-col' : ''}" style="width:100%;" data-date="${dk}">`;
        for (const ev of laid) {
            const s = new Date(ev.startTime);
            const e = new Date(ev.endTime);
            const sm = s.getHours() * 60 + s.getMinutes();
            const em = e.getHours() * 60 + e.getMinutes();
            const top = (sm / 60) * HOUR_HEIGHT;
            const height = Math.max(((em - sm) / 60) * HOUR_HEIGHT, 22);
            const left = (ev._col / ev._totalCols) * 100;
            const width = (1 / ev._totalCols) * 100;
            const cc = getEventColor(ev);
            const compact = height < 36;
            html += `<div class="cal-ev-block ${compact ? 'cal-ev-compact' : ''}" style="top:${top}px;height:${height}px;left:calc(${left}% + 4px);width:calc(${width}% - 8px);background:${cc.bg};border-left-color:${cc.border};color:${cc.text};" data-event-uid="${ev.uid}">
                <div class="cal-ev-block-title" style="${compact ? '' : 'font-size:13px;'}">${ev.subject}</div>
                <div class="cal-ev-block-time">${compact ? fmtTime24(ev.startTime) : `${fmtTime(ev.startTime)} — ${fmtTime(ev.endTime)}`}</div>
                ${!compact && ev.location ? `<div style="font-size:10px;opacity:0.6;margin-top:2px;"><i class="fa-solid fa-location-dot" style="font-size:8px;margin-right:3px;"></i>${ev.location}</div>` : ''}
            </div>`;
        }
        html += '</div>';

        if (isToday) {
            const now = new Date();
            const nm = now.getHours() * 60 + now.getMinutes();
            html += `<div class="cal-now-line" id="cal-now-line" style="top:${(nm / 60) * HOUR_HEIGHT}px;"><div class="cal-now-dot"></div><div class="cal-now-rule"></div></div>`;
        }

        html += '</div></div></div>';

        container.innerHTML = html;
        this._bindViewEvents(container);
        this._scrollToNow('cal-day-scroll');
    }

    /* ═══════════════════════════════════════════════════
     *  VIEW HELPERS
     * ═══════════════════════════════════════════════════ */

    _updateNowIndicator() {
        const existing = this.querySelector('#cal-now-line');
        if (existing) {
            const now = new Date();
            const nm = now.getHours() * 60 + now.getMinutes();
            existing.style.top = (nm / 60) * HOUR_HEIGHT + 'px';
        }
    }

    _scrollToNow(scrollId) {
        const sc = this.querySelector(`#${scrollId}`);
        if (!sc) return;
        const today = new Date();

        if (isSameDay(this.currentDate, today)) {
            sc.scrollTop = Math.max(0, (today.getHours() - 1) * HOUR_HEIGHT);
            return;
        }

        const dk = dateKey(this.currentDate);
        const evts = this._eventsFor(dk).filter((e) => !e.isAllDay);
        if (evts.length > 0) {
            const earliest = evts.reduce((a, b) => (a.startTime < b.startTime ? a : b));
            const s = new Date(earliest.startTime);
            const hourPos = (s.getHours() * 60 + s.getMinutes()) / 60;
            sc.scrollTop = Math.max(0, (hourPos - 0.5) * HOUR_HEIGHT);
        } else {
            sc.scrollTop = 8 * HOUR_HEIGHT;
        }
    }

    _bindViewEvents(container) {
        container.querySelectorAll('[data-event-uid]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selectedEvent = this._findEvent(el.dataset.eventUid);
                this._renderDetail();
            });
        });

        container.querySelectorAll('[data-date]').forEach((el) => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('[data-event-uid]')) return;
                const parts = el.dataset.date.split('-');
                this.currentDate = new Date(+parts[0], +parts[1] - 1, +parts[2]);
                this.selectedEvent = null;
                this._renderMiniCalendar();
                this._renderLeftHeader();
                this._renderDetail();
                this._updateToolbarTitle();

                const selDk = dateKey(this.currentDate);
                const today = new Date();

                if (this.viewMode === 'month') {
                    container.querySelectorAll('.cal-month-cell').forEach((c) => {
                        const dk = c.dataset.date;
                        const p = dk?.split('-');
                        const cd = p ? new Date(+p[0], +p[1] - 1, +p[2]) : null;
                        c.classList.toggle('selected', dk === selDk);
                        c.classList.toggle('today', cd ? isSameDay(cd, today) : false);
                    });
                } else if (this.viewMode === 'week') {
                    container.querySelectorAll('.cal-time-grid-col').forEach((c) => {
                        const dk = c.dataset.date;
                        const p = dk?.split('-');
                        const cd = p ? new Date(+p[0], +p[1] - 1, +p[2]) : null;
                        const isToday = cd ? isSameDay(cd, today) : false;
                        c.classList.toggle('selected-col', dk === selDk && !isToday);
                    });
                    container.querySelectorAll('.cal-time-grid-header-cell').forEach((c) => {
                        const dk = c.dataset.date;
                        const p = dk?.split('-');
                        const cd = p ? new Date(+p[0], +p[1] - 1, +p[2]) : null;
                        const isToday = cd ? isSameDay(cd, today) : false;
                        c.classList.toggle('selected-hdr', dk === selDk && !isToday);
                    });
                }
            });
        });

        container.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const evEl = e.target.closest('[data-event-uid]');
            const dateEl = e.target.closest('[data-date]');
            const uid = evEl?.dataset?.eventUid || null;
            let targetDate = this.currentDate;
            if (dateEl) {
                const parts = dateEl.dataset.date.split('-');
                targetDate = new Date(+parts[0], +parts[1] - 1, +parts[2]);
            }

            let clickHour = -1;
            if (this.viewMode !== 'month') {
                const colEl = e.target.closest('.cal-time-grid-col');
                if (colEl) {
                    const rect = colEl.getBoundingClientRect();
                    const yOff = e.clientY - rect.top;
                    clickHour = Math.max(0, Math.min(23, Math.floor(yOff / HOUR_HEIGHT)));
                }
            }
            this._showCtx(e.clientX, e.clientY, uid, targetDate, clickHour);
        });
    }

    /* ═══════════════════════════════════════════════════
     *  CONTEXT MENU
     * ═══════════════════════════════════════════════════ */

    _showCtx(x, y, eventUid, targetDate, clickHour = -1) {
        const ctx = this.querySelector('#cal-ctx');
        if (!ctx) return;

        let html = '<div class="cal-ctx">';
        html += `<div class="cal-ctx-item" data-action="add"><i class="fa-solid fa-plus"></i>添加日程</div>`;
        if (eventUid) {
            html += '<div class="cal-ctx-sep"></div>';
            html += `<div class="cal-ctx-item" data-action="edit" data-uid="${eventUid}"><i class="fa-solid fa-pen"></i>修改日程</div>`;
            html += `<div class="cal-ctx-item danger" data-action="delete" data-uid="${eventUid}"><i class="fa-solid fa-trash-can"></i>删除日程</div>`;
        }
        html += '</div>';
        ctx.innerHTML = html;
        ctx.classList.remove('hidden');

        requestAnimationFrame(() => {
            const rect = ctx.firstElementChild.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            ctx.style.left = (x + rect.width > vw ? vw - rect.width - 8 : x) + 'px';
            ctx.style.top = (y + rect.height > vh ? vh - rect.height - 8 : y) + 'px';
        });

        ctx.querySelector('[data-action="add"]')?.addEventListener('click', () => {
            ctx.classList.add('hidden');
            let modalDate = targetDate;
            if (clickHour >= 0) {
                modalDate = new Date(targetDate);
                modalDate.setHours(clickHour, 0, 0, 0);
            }
            this._showModal(null, modalDate);
        });
        ctx.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
            ctx.classList.add('hidden');
            const ev = this._findEvent(eventUid);
            if (ev) this._showModal(ev);
        });
        ctx.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
            ctx.classList.add('hidden');
            this._deleteEvent(eventUid);
        });
    }

    /* ═══════════════════════════════════════════════════
     *  MODAL
     * ═══════════════════════════════════════════════════ */

    _showModal(event, defaultDate) {
        const modal = this.querySelector('#cal-modal');
        if (!modal) return;
        modal.classList.remove('hidden');

        const isEdit = !!event;
        const d = event ? new Date(event.startTime) : defaultDate || this.currentDate;
        const dEnd = event ? new Date(event.endTime) : new Date(d.getTime() + 3600000);

        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const startTimeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const endTimeStr = `${String(dEnd.getHours()).padStart(2, '0')}:${String(dEnd.getMinutes()).padStart(2, '0')}`;

        const typeOptions = EVENT_TYPES.map(
            (t) => `<option value="${t.id}" ${event?.type === t.id ? 'selected' : ''}>${t.label}</option>`
        ).join('');

        modal.innerHTML = `
        <div class="cal-modal-bg fixed inset-0" id="cal-modal-bg">
            <div class="cal-modal-card">
                <div style="padding:28px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
                        <h3 style="font-size:16px;font-weight:700;color:#1d1d1f;">${isEdit ? '修改日程' : '添加日程'}</h3>
                        <button id="cal-modal-close" class="cal-toolbar-btn" style="width:32px;height:32px;">
                            <i class="fa-solid fa-xmark" style="font-size:14px;"></i>
                        </button>
                    </div>

                    <div style="display:flex;flex-direction:column;gap:18px;">
                        <div>
                            <label class="cal-label">标题</label>
                            <input id="cal-m-subject" class="cal-input" type="text" placeholder="日程标题" value="${event?.subject || ''}" />
                        </div>

                        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
                            <div>
                                <label class="cal-label">日期</label>
                                <input id="cal-m-date" class="cal-input" type="date" value="${dateStr}" />
                            </div>
                            <div>
                                <label class="cal-label">开始时间</label>
                                <input id="cal-m-start" class="cal-input" type="time" value="${startTimeStr}" />
                            </div>
                            <div>
                                <label class="cal-label">结束时间</label>
                                <input id="cal-m-end" class="cal-input" type="time" value="${endTimeStr}" />
                            </div>
                        </div>

                        <div>
                            <label class="cal-label">类型</label>
                            <select id="cal-m-type" class="cal-select">
                                <option value="">选择类型</option>
                                ${typeOptions}
                            </select>
                        </div>

                        <div>
                            <label class="cal-label">地点</label>
                            <input id="cal-m-location" class="cal-input" type="text" placeholder="地点（可选）" value="${event?.location || ''}" />
                        </div>

                        <div style="display:flex;align-items:center;gap:8px;">
                            <input id="cal-m-allday" type="checkbox" style="width:18px;height:18px;border-radius:6px;accent-color:#007AFF;" ${event?.isAllDay ? 'checked' : ''} />
                            <label for="cal-m-allday" style="font-size:14px;font-weight:500;color:#1d1d1f;">全天</label>
                        </div>
                    </div>

                    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:28px;padding-top:20px;border-top:1px solid #F0F0F0;">
                        <button id="cal-modal-cancel" class="cal-btn-secondary">取消</button>
                        <button id="cal-modal-save" class="cal-btn-primary">${isEdit ? '保存修改' : '添加'}</button>
                    </div>
                </div>
            </div>
        </div>`;

        const close = () => {
            modal.classList.add('hidden');
            modal.innerHTML = '';
            document.removeEventListener('keydown', escHandler);
        };
        const escHandler = (e) => {
            if (e.key === 'Escape') close();
        };
        document.addEventListener('keydown', escHandler);
        modal.querySelector('#cal-modal-close').addEventListener('click', close);
        modal.querySelector('#cal-modal-cancel').addEventListener('click', close);
        modal.querySelector('#cal-modal-bg').addEventListener('click', (e) => {
            if (e.target.id === 'cal-modal-bg') close();
        });

        modal.querySelector('#cal-modal-save').addEventListener('click', async () => {
            const subject = modal.querySelector('#cal-m-subject').value.trim();
            if (!subject) {
                modal.querySelector('#cal-m-subject').style.borderColor = '#FF3B30';
                return;
            }

            const dateParts = modal.querySelector('#cal-m-date').value.split('-');
            const startParts = modal.querySelector('#cal-m-start').value.split(':');
            const endParts = modal.querySelector('#cal-m-end').value.split(':');
            const isAllDay = modal.querySelector('#cal-m-allday').checked;

            const startDate = new Date(+dateParts[0], +dateParts[1] - 1, +dateParts[2], +startParts[0], +startParts[1]);
            const endDate = new Date(+dateParts[0], +dateParts[1] - 1, +dateParts[2], +endParts[0], +endParts[1]);

            if (endDate <= startDate && !isAllDay) endDate.setDate(endDate.getDate() + 1);

            const data = {
                subject,
                startTime: startDate.getTime(),
                endTime: endDate.getTime(),
                location: modal.querySelector('#cal-m-location').value.trim(),
                type: modal.querySelector('#cal-m-type').value,
                isAllDay
            };

            try {
                if (isEdit) await window.applicationAPI.call('updateCalendarItem', event.uid, data);
                else await window.applicationAPI.call('addCalendarItem', data);
                close();
                this.selectedEvent = null;
                await this._refreshAll();
            } catch (err) {
                console.error('保存日程失败:', err);
            }
        });

        modal.querySelector('#cal-m-subject').focus();
    }

    /* ═══════════════════════════════════════════════════
     *  DELETE
     * ═══════════════════════════════════════════════════ */

    async _deleteEvent(uid) {
        try {
            await window.applicationAPI.call('deleteCalendarItem', uid);
            if (this.selectedEvent?.uid === uid) this.selectedEvent = null;
            await this._refreshAll();
        } catch (err) {
            console.error('删除日程失败:', err);
        }
    }
}

customElements.define('calendar-entry-widget', CalendarEntryWidget);
