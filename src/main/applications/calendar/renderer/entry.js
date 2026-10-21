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

import { OVERLAY_CSS } from '../../../../common/overlay-styles.js';
import { createTranslatorForCalendar } from '../locale/renderer.js';
import { resolveRendererLocale } from '../../../../renderer/locale.js';

const EVENT_TYPES = [
    { id: 'meeting', icon: 'fa-users', color: '#34C759', bg: '#ECFDF5' },
    { id: 'video', icon: 'fa-video', color: '#AF52DE', bg: '#F5F3FF' },
    { id: 'deadline', icon: 'fa-flag-checkered', color: '#FF3B30', bg: '#FEF2F2' },
    { id: 'followup', icon: 'fa-phone', color: '#007AFF', bg: '#EFF6FF' },
    { id: 'other', icon: 'fa-calendar', color: '#FF9500', bg: '#FFFBEB' }
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

const HOUR_HEIGHT = 60;

/* ═══════════════════════════════════════════════════
 *  CSS
 * ═══════════════════════════════════════════════════ */

const CALENDAR_CSS = `
${OVERLAY_CSS}
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
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.cal-toolbar-btn {
    width: 33px; height: 33px; display: flex; align-items: center; justify-content: center;
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
    border-radius: 10px; border: none; background: #1d1d1f; color: #fff;
    height: 33px;
    font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s;
    box-shadow: 0 2px 8px rgba(0,0,0,0.12); white-space: nowrap; flex-shrink: 0;
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
    padding-right: 6px;
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
.cal-allday-bar { display: flex; border-bottom: 1px solid #F0F0F0; background: #FAFBFF; flex-shrink: 0; min-height: 0; padding-right: 6px; }
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
    display: flex; align-items: center; justify-content: center;
    animation: cal-fade 0.2s ease-out;
}
.cal-modal-bg.leaving {
    animation: cal-fade-out 0.18s ease-in forwards;
}
.cal-modal-card {
    background: #fff; border-radius: 16px;
    box-shadow: 0 24px 80px rgba(0,0,0,0.2), 0 0 1px rgba(0,0,0,0.1);
    width: 460px; max-width: 92vw; max-height: 85vh; overflow-y: auto;
    animation: cal-scale-in 0.25s cubic-bezier(0.23, 1, 0.32, 1);
}
.cal-modal-banner {
    display: flex; align-items: center; gap: 12px;
    padding: 16px 24px; border-bottom: 1px solid rgba(0,0,0,0.06);
}
.cal-modal-banner-info { background: #EBF1FB; }
.cal-modal-banner-icon {
    width: 36px; height: 36px; border-radius: 10px;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.cal-modal-banner-info .cal-modal-banner-icon { background: #4267B2; }
.cal-modal-banner-icon i, .cal-modal-banner-icon svg { color: #fff; font-size: 16px; }
.cal-modal-banner-text { flex: 1; min-width: 0; }
.cal-modal-banner-title { font-size: 15px; font-weight: 700; color: #1d1d1f; }
.cal-modal-banner-subtitle { font-size: 11px; color: #86868B; }
.cal-modal-banner-close {
    width: 26px; height: 26px; border-radius: 7px;
    border: none; background: rgba(0,0,0,0.06); color: #555;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; transition: all 0.15s;
}
.cal-modal-banner-close:hover { background: rgba(0,0,0,0.12); color: #333; }
.cal-modal-banner-close svg { width: 14px; height: 14px; }
.cal-modal-bg.leaving .cal-modal-card {
    animation: cal-scale-out 0.18s ease-in forwards;
}
.cal-input {
    width: 100%; padding: 10px 14px; border-radius: 8px; border: 1.5px solid #E5E5EA;
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
    padding: 7px 16px; border-radius: 8px; border: none; font-size: 12.5px; font-weight: 600;
    background: #DF4436; color: white; cursor: pointer; transition: all 0.15s;
}
.cal-btn-primary:hover { background: #C43A2E; }
.cal-btn-primary:active { transform: scale(0.97); }
.cal-btn-secondary {
    padding: 7px 16px; border-radius: 8px; border: 1.5px solid #E5E5EA;
    font-size: 12.5px; font-weight: 500; background: #fff; color: #1d1d1f;
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
    font-size: 13px; font-weight: 500; color: #1d1d1f;
}
.cal-mini-num-today {
    font-size: 13px; color: #007AFF;
}
.cal-mini-num-out {
    color: #C7C7CC;
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
@keyframes cal-fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes cal-scale-in { from { opacity: 0; transform: scale(0.96) translateY(8px); } to { opacity: 1; transform: scale(1) translateY(0); } }
@keyframes cal-scale-out { from { opacity: 1; transform: scale(1) translateY(0); } to { opacity: 0; transform: scale(0.96) translateY(8px); } }
@keyframes cal-pop-in { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
@keyframes cal-detail-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

.cal-detail-card { animation: cal-detail-in 0.3s ease-out; }

/* ---- Drag ghost ---- */
.cal-drag-ghost {
    position: absolute; border: 2px dashed #007AFF; border-radius: 8px;
    background: rgba(0,122,255,0.06); pointer-events: none; z-index: 30;
    display: flex; align-items: center; justify-content: center;
}
.cal-drag-ghost-label {
    font-size: 11px; font-weight: 600; color: #007AFF; opacity: 0.9;
    text-align: center; padding: 2px 8px;
}
.cal-drag-ghost-month {
    border: 2px dashed #007AFF; border-radius: 8px;
    background: rgba(0,122,255,0.06); pointer-events: none;
}
.cal-ev-block.dragging { opacity: 0.35; }
.cal-month-pill.dragging { opacity: 0.35; }
.cal-allday-pill.dragging { opacity: 0.35; }

/* ---- Disabled input ---- */
.cal-input:disabled { background: #F2F2F7; color: #8E8E93; cursor: not-allowed; border-color: #E5E5EA; }

/* ---- Modal specific ---- */
.cal-modal-title {
    font-size: 16px; font-weight: 700; color: #1d1d1f;
}
.cal-modal-allday {
    display: flex; align-items: center; gap: 8px;
}
.cal-modal-allday input[type="checkbox"] {
    width: 18px; height: 18px; border-radius: 6px; accent-color: #007AFF;
}
.cal-modal-allday-label {
    font-size: 14px; font-weight: 500; color: #1d1d1f;
}
.cal-modal-footer {
    display: flex; justify-content: flex-end; gap: 10px;
    margin-top: 28px; padding-top: 20px; border-top: 1px solid #F0F0F0;
}

/* ---- Detail view ---- */
.cal-detail-back-btn {
    display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600;
    color: #007AFF; background: none; border: none; cursor: pointer; padding: 4px 0; margin-bottom: 20px;
}
.cal-detail-card-title {
    font-size: 17px; font-weight: 700; color: #1d1d1f; letter-spacing: -0.01em; margin-bottom: 4px;
}
.cal-detail-date-box {
    display: flex; align-items: flex-start; gap: 14px; margin-bottom: 24px;
    padding: 16px; border-radius: 14px; background: #fff; border: 1px solid #F0F0F0;
}
.cal-detail-date-icon {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    width: 52px; height: 52px; border-radius: 12px; background: #FAFAFA; border: 1px solid #EBEBEB; flex-shrink: 0;
}
.cal-detail-date-month {
    font-size: 10px; font-weight: 700; color: #FF3B30; text-transform: uppercase;
}
.cal-detail-date-day {
    font-size: 18px; font-weight: 800; color: #1d1d1f; line-height: 1;
}
.cal-detail-date-time {
    display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: #1d1d1f;
}
.cal-detail-date-info {
    display: flex; align-items: center; gap: 8px; font-size: 13px; color: #8E8E93;
}
.cal-detail-date-location {
    display: flex; align-items: center; gap: 8px; font-size: 13px; color: #8E8E93;
}
.cal-detail-date-time-icon {
    color: #8E8E93; font-size: 13px;
}
.cal-detail-edit-btn {
    flex: 1; padding: 10px; border-radius: 12px; border: 1.5px solid #E5E5EA;
    background: #fff; font-size: 13px; font-weight: 600; color: #1d1d1f;
    cursor: pointer; transition: all 0.15s; text-align: center;
}
.cal-detail-edit-btn:hover { background: #F5F5F7; }
.cal-detail-delete-btn {
    flex: 1; padding: 10px; border-radius: 12px; border: 1.5px solid #FFD5D5;
    background: #FFF5F5; font-size: 13px; font-weight: 600; color: #FF3B30;
    cursor: pointer; transition: all 0.15s; text-align: center;
}
.cal-detail-delete-btn:hover { background: #FFE5E5; }

/* ---- Detail list items ---- */
.cal-detail-title {
    font-size: 14px; font-weight: 700; color: #1d1d1f; margin-bottom: 16px;
}
.cal-detail-label {
    font-size: 11px; font-weight: 600; color: #8E8E93; text-transform: uppercase;
    letter-spacing: 0.04em; margin-bottom: 6px;
}
.cal-detail-event-card {
    display: flex; gap: 12px; padding: 12px; border-radius: 14px;
    background: #fff; border: 1px solid #F0F0F0; cursor: pointer; transition: box-shadow 0.15s;
}
.cal-detail-event-card:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
.cal-detail-event-title {
    font-size: 14px; font-weight: 600; color: #1d1d1f; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
}
.cal-detail-event-time {
    font-size: 12px; color: #8E8E93; margin-top: 3px;
}
.cal-detail-event-location {
    font-size: 12px; color: #8E8E93; margin-top: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cal-detail-all-day-location {
    font-size: 11px; color: #8E8E93; margin-top: 2px;
}
.cal-detail-all-day-location i {
    font-size: 9px; margin-right: 4px;
}
.cal-detail-empty-icon-wrap {
    width: 56px; height: 56px; border-radius: 16px; background: #F2F2F7;
    display: inline-flex; align-items: center; justify-content: center; margin-bottom: 16px;
}
.cal-detail-empty-icon {
    color: #8E8E93;
}
.cal-detail-empty-title {
    font-size: 14px; font-weight: 600; color: #1d1d1f;
}
.cal-detail-empty-subtitle {
    font-size: 12px; color: #8E8E93; margin-top: 4px;
}

/* ---- Left panel header ---- */
.cal-left-date-big {
    font-size: 17px; font-weight: 700; color: #1d1d1f; line-height: 1.2; letter-spacing: -0.01em;
}
.cal-left-date-sub {
    font-size: 13px; color: #8E8E93; font-weight: 500; margin-top: 3px;
}
.cal-mini-title {
    font-size: 15px; font-weight: 700; color: #1d1d1f;
}
.cal-left-divider {
    margin: 8px 24px; height: 1px; background: #EBEBEB; flex-shrink: 0;
}
.cal-left-month-badge {
    background: #FF3B30; color: #fff; border-radius: 10px; padding: 4px 12px;
    font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
}
.cal-left-month-badge-dark {
    background: #FF453A; color: #fff; border-radius: 10px; padding: 4px 12px;
    font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
}

/* ---- Right panel ---- */
.cal-right-panel {
    background: #fff;
}

/* ---- Mini calendar header ---- */
.cal-mini-header-cell {
    height: 28px; display: flex; align-items: center; justify-content: center;
    font-size: 12px; font-weight: 600; color: #8E8E93;
}

/* ---- Drag confirm modal ---- */
.cal-drag-icon-wrap {
    width: 36px; height: 36px; border-radius: 10px; background: #4267B2;
    display: flex; align-items: center; justify-content: center;
}
.cal-drag-icon {
    color: #fff; font-size: 16px;
}
.cal-drag-title {
    font-size: 15px; font-weight: 700; color: #1d1d1f;
}
.cal-drag-subject {
    font-size: 14px; font-weight: 600; color: #1d1d1f; margin-bottom: 12px;
}
.cal-drag-label-old {
    font-size: 12px; font-weight: 600; color: #8E8E93; min-width: 32px;
}
.cal-drag-value-old {
    font-size: 13px; color: #1d1d1f;
}
.cal-drag-label-new {
    font-size: 12px; font-weight: 600; color: #007AFF; min-width: 32px;
}
.cal-drag-value-new {
    font-size: 13px; color: #007AFF; font-weight: 600;
}
.cal-drag-footer {
    display: flex; justify-content: flex-end; gap: 10px;
    padding-top: 16px; border-top: 1px solid #F0F0F0;
}

/* ---- Dark mode ---- */
[data-theme="dark"] .cal-root {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-left {
    background: #1C1C1E;
    border-right-color: #38383A;
}
[data-theme="dark"] .cal-seg {
    background: #2C2C2E;
}
[data-theme="dark"] .cal-seg-indicator {
    background: #3A3A3C;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
}
[data-theme="dark"] .cal-seg-btn {
    color: #8E8E93;
}
[data-theme="dark"] .cal-seg-btn.active {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-toolbar {
    background: #1C1C1E;
    border-bottom-color: #38383A;
}
[data-theme="dark"] .cal-toolbar-title {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-toolbar-btn {
    background: #2C2C2E;
    border-color: #38383A;
    color: #EBEBF0;
}
[data-theme="dark"] .cal-toolbar-btn:hover {
    background: #3A3A3C;
    border-color: #48484A;
}
[data-theme="dark"] .cal-today-btn {
    background: #2C2C2E;
    border-color: #38383A;
    color: #EBEBF0;
}
[data-theme="dark"] .cal-today-btn:hover {
    background: #3A3A3C;
    border-color: #48484A;
}
[data-theme="dark"] .cal-add-event-btn {
    background: #EBEBF0;
    color: #1C1C1E;
}
[data-theme="dark"] .cal-add-event-btn:hover {
    background: #FFFFFF;
}
[data-theme="dark"] .cal-month-header-row {
    background: #1C1C1E;
    border-bottom-color: #38383A;
}
[data-theme="dark"] .cal-month-header-cell {
    color: #98989D;
}
[data-theme="dark"] .cal-month-grid {
    background: #1C1C1E;
}
[data-theme="dark"] .cal-month-cell {
    border-right-color: #2C2C2E;
    border-bottom-color: #2C2C2E;
}
[data-theme="dark"] .cal-month-cell:hover {
    background: #2C2C2E;
}
[data-theme="dark"] .cal-month-cell.today {
    background: rgba(10,132,255,0.1);
}
[data-theme="dark"] .cal-month-cell.selected {
    background: rgba(10,132,255,0.15);
}
[data-theme="dark"] .cal-month-day-num {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-month-day-num.out-month {
    color: #48484A;
}
[data-theme="dark"] .cal-month-more {
    color: #8E8E93;
}
[data-theme="dark"] .cal-month-more:hover {
    color: #0A84FF;
}
[data-theme="dark"] .cal-time-grid-header {
    background: #1C1C1E;
    border-bottom-color: #38383A;
}
[data-theme="dark"] .cal-time-grid-header-cell {
    border-left-color: #2C2C2E;
}
[data-theme="dark"] .cal-wh-weekday {
    color: #8E8E93;
}
[data-theme="dark"] .cal-wh-day {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-time-grid-header-cell.today-col .cal-wh-day:not(.today-circle) {
    color: #0A84FF;
}
[data-theme="dark"] .cal-wh-date-label {
    color: #8E8E93;
}
[data-theme="dark"] .cal-time-grid-body {
    background: #1C1C1E;
}
[data-theme="dark"] .cal-time-grid-gutter {
    border-right-color: #2C2C2E;
}
[data-theme="dark"] .cal-time-grid-gutter-label {
    color: #8E8E93;
}
[data-theme="dark"] .cal-time-grid-col {
    border-left-color: #2C2C2E;
}
[data-theme="dark"] .cal-time-grid-col.today-col {
    background: rgba(10,132,255,0.03);
}
[data-theme="dark"] .cal-time-grid-col.selected-col {
    background: rgba(99,102,241,0.05);
}
[data-theme="dark"] .cal-allday-bar {
    background: #252527;
    border-bottom-color: #38383A;
}
[data-theme="dark"] .cal-allday-gutter {
    color: #8E8E93;
}
[data-theme="dark"] .cal-allday-col {
    border-left-color: #2C2C2E;
}
[data-theme="dark"] .cal-time-grid-hour-line {
    border-top-color: #2C2C2E;
}
[data-theme="dark"] .cal-time-grid-half-line {
    border-top-color: #252527;
}
[data-theme="dark"] .cal-ctx {
    background: rgba(44,44,46,0.95);
    backdrop-filter: blur(40px) saturate(180%);
    border-color: rgba(255,255,255,0.1);
    box-shadow: 0 12px 40px rgba(0,0,0,0.4), 0 0 1px rgba(255,255,255,0.05);
}
[data-theme="dark"] .cal-ctx-item {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-ctx-sep {
    background: rgba(255,255,255,0.08);
}
[data-theme="dark"] .cal-modal-card {
    background: #2A2826;
    box-shadow: 0 24px 80px rgba(0,0,0,0.5), 0 0 1px rgba(255,255,255,0.1);
}
[data-theme="dark"] .cal-modal-banner-info {
    background: rgba(122,162,232,0.16);
}
[data-theme="dark"] .cal-modal-banner-info .cal-modal-banner-icon {
    background: #7AA2E8;
}
[data-theme="dark"] .cal-modal-banner-title {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-modal-banner-subtitle {
    color: #8E8E93;
}
[data-theme="dark"] .cal-modal-banner-close {
    background: rgba(255,255,255,0.08); color: #ccc;
}
[data-theme="dark"] .cal-modal-banner-close:hover {
    background: rgba(255,255,255,0.15); color: #fff;
}
[data-theme="dark"] .cal-modal-title {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-label {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-input {
    background: #3A3A3C;
    border-color: #48484A;
    color: #EBEBF0;
}
[data-theme="dark"] .cal-input:focus {
    background: #3A3A3C;
    border-color: #0A84FF;
    box-shadow: 0 0 0 3px rgba(10,132,255,0.2);
}
[data-theme="dark"] .cal-input:disabled {
    background: #2C2C2E;
    color: #636366;
    border-color: #3A3A3C;
}
[data-theme="dark"] .cal-select {
    background-color: #3A3A3C;
    border-color: #48484A;
    color: #EBEBF0;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2398989D' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E");
}
[data-theme="dark"] .cal-select:focus {
    background-color: #3A3A3C;
    border-color: #0A84FF;
    box-shadow: 0 0 0 3px rgba(10,132,255,0.2);
}
[data-theme="dark"] .cal-modal-allday-label {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-modal-footer {
    border-top-color: #38383A;
}
[data-theme="dark"] .cal-btn-secondary {
    background: #3A3A3C;
    border-color: #48484A;
    color: #EBEBF0;
}
[data-theme="dark"] .cal-btn-secondary:hover {
    background: #48484A;
}
[data-theme="dark"] .cal-btn-primary {
    background: #E85A5A; color: #fff;
}
[data-theme="dark"] .cal-btn-primary:hover {
    background: #D04A4A;
}
[data-theme="dark"] .cal-left-month-badge {
    background: #FF453A;
}
[data-theme="dark"] .cal-drag-icon-wrap {
    background: rgba(122,162,232,0.16);
}
[data-theme="dark"] .cal-drag-icon {
    color: #7AA2E8;
}
[data-theme="dark"] .cal-drag-title {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-drag-subject {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-drag-value-old {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-drag-footer {
    border-top-color: #38383A;
}
[data-theme="dark"] .cal-right-panel {
    background: #1C1C1E;
}
[data-theme="dark"] .cal-left-date-big {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-left-date-sub {
    color: #8E8E93;
}
[data-theme="dark"] .cal-mini-title {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-left-divider {
    background: #38383A;
}
[data-theme="dark"] .cal-mini-header-cell {
    color: #8E8E93;
}
[data-theme="dark"] .cal-detail-title {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-detail-label {
    color: #8E8E93;
}
[data-theme="dark"] .cal-detail-event-card {
    background: #2C2C2E;
    border-color: #38383A;
}
[data-theme="dark"] .cal-detail-event-card:hover {
    box-shadow: 0 2px 12px rgba(0,0,0,0.3);
}
[data-theme="dark"] .cal-detail-event-title {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-detail-event-time {
    color: #8E8E93;
}
[data-theme="dark"] .cal-detail-event-location {
    color: #8E8E93;
}
[data-theme="dark"] .cal-detail-empty-icon-wrap {
    background: #2C2C2E;
}
[data-theme="dark"] .cal-detail-empty-icon {
    color: #8E8E93;
}
[data-theme="dark"] .cal-detail-empty-title {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-detail-empty-subtitle {
    color: #8E8E93;
}
[data-theme="dark"] .cal-detail-card-title {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-detail-date-box {
    background: #2C2C2E;
    border-color: #38383A;
}
[data-theme="dark"] .cal-detail-date-icon {
    background: #3A3A3C;
    border-color: #48484A;
}
[data-theme="dark"] .cal-detail-date-day {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-detail-date-time {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-detail-date-info {
    color: #8E8E93;
}
[data-theme="dark"] .cal-detail-date-location {
    color: #8E8E93;
}
[data-theme="dark"] .cal-detail-date-time-icon {
    color: #8E8E93;
}
[data-theme="dark"] .cal-detail-edit-btn {
    background: #3A3A3C;
    border-color: #48484A;
    color: #EBEBF0;
}
[data-theme="dark"] .cal-detail-edit-btn:hover {
    background: #48484A;
}
[data-theme="dark"] .cal-detail-delete-btn {
    background: rgba(255,59,48,0.12);
    border-color: rgba(255,59,48,0.3);
    color: #FF453A;
}
[data-theme="dark"] .cal-detail-delete-btn:hover {
    background: rgba(255,59,48,0.2);
}
[data-theme="dark"] .cal-mini-num {
    color: #EBEBF0;
}
[data-theme="dark"] .cal-mini-num-out {
    color: #48484A;
}
[data-theme="dark"] .cal-mini-cell:hover .cal-mini-num {
    background: rgba(255,255,255,0.08);
}
[data-theme="dark"] .cal-mini-cell.selected .cal-mini-num {
    background: #EBEBF0;
    color: #1C1C1E;
}
[data-theme="dark"] .cal-mini-cell.selected:hover .cal-mini-num {
    background: #FFFFFF;
}
[data-theme="dark"] .cal-scroll::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.15);
}
[data-theme="dark"] .cal-scroll::-webkit-scrollbar-thumb:hover {
    background: rgba(255,255,255,0.25);
}
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

function fmtTime24(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
        this._t = createTranslatorForCalendar();
        this._locale = undefined;
        this._settingUnsubscribe = null;
        this.currentDate = new Date();
        this.viewMode = 'month';
        this.selectedEvent = null;
        this.eventsMap = new Map();
        this._nowTimer = null;
    }

    async connectedCallback() {
        let setting;
        try {
            setting = await window.settingAPI?.loadSettingObject?.();
        } catch {
            setting = undefined;
        }
        this._applyLocaleSetting(setting);
        // 等待设置加载期间元素可能已被移除，避免对脱离 DOM 的元素启动定时器和渲染
        if (!this.isConnected) return;
        this._subscribeLocaleChanges();
        this._injectStyles();
        this._initDrag();
        this._render();
        this._bindCore();
        this._refreshAll();
        this._nowTimer = setInterval(() => this._updateNowIndicator(), 60000);
    }

    disconnectedCallback() {
        if (this._nowTimer) clearInterval(this._nowTimer);
        this._settingUnsubscribe?.();
        this._settingUnsubscribe = null;
        this._dragCleanup();
    }

    _applyLocaleSetting(setting) {
        this._locale = resolveRendererLocale(setting);
        this._t = createTranslatorForCalendar(setting);
    }

    /* 语言设置变化时重建翻译器并刷新整个界面（打开中的弹窗为用户输入态，不重建） */
    _subscribeLocaleChanges() {
        if (this._settingUnsubscribe) return;
        this._settingUnsubscribe = window.settingAPI?.onSettingChanged?.((setting) => {
            if (!this.isConnected) return;
            if (resolveRendererLocale(setting) === this._locale) return;
            this._applyLocaleSetting(setting);
            this._refreshAll();
        });
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
                                <div id="cal-left-month-badge" class="cal-left-month-badge"></div>
                                <div>
                                    <div id="cal-left-date-big" class="cal-left-date-big"></div>
                                    <div id="cal-left-date-sub" class="cal-left-date-sub"></div>
                                </div>
                            </div>

                            <!-- Mini calendar -->
                            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                                <h3 id="cal-mini-title" class="cal-mini-title"></h3>
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

                        <div class="cal-left-divider"></div>

                        <!-- Detail / day events -->
                        <div id="cal-detail" class="flex-1 overflow-y-auto cal-scroll" style="padding:16px 24px;"></div>
                    </div>
                </div>

                <!-- Right Panel -->
                <div slot="right" class="cal-right-panel w-full h-full overflow-hidden">
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

    fmtTime(ts) {
        const d = new Date(ts);
        const h = d.getHours();
        const m = String(d.getMinutes()).padStart(2, '0');
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return `${h12}:${m} ${ampm}`;
    }

    fmtDateFull(d) {
        return this._t('renderer.calendar.date.full', {
            year: d.getFullYear(),
            month: d.getMonth() + 1,
            day: d.getDate(),
            monthName: this._t(`renderer.calendar.month.${d.getMonth() + 1}`)
        });
    }

    fmtMonthDay(d) {
        return this._t('renderer.calendar.date.monthDay', {
            month: d.getMonth() + 1,
            day: d.getDate(),
            monthName: this._t(`renderer.calendar.month.${d.getMonth() + 1}`)
        });
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

        badge.textContent = this._t(`renderer.calendar.month.${d.getMonth() + 1}`);
        big.textContent = `${this.fmtDateFull(d)}`;
        sub.textContent = this._t(`renderer.calendar.weekday.${d.getDay()}`);
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
        title.textContent = this._t('renderer.calendar.date.monthYear', {
            year: y,
            monthName: this._t(`renderer.calendar.month.${m + 1}`)
        });

        const today = new Date();
        const firstDay = new Date(y, m, 1);
        const dow = (firstDay.getDay() + 6) % 7;
        const startDate = new Date(y, m, 1 - dow);

        let html = '';
        for (let i = 1; i <= 7; i++) {
            html += `<div class="cal-mini-header-cell">${this._t(`renderer.calendar.weekdayShort.${i}`)}</div>`;
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
            let numCls = 'cal-mini-num';
            if (isSel) {
                cls += ' selected';
            } else if (isToday) {
                cls += ' today-cell';
                numCls += ' cal-mini-num-today';
            } else if (!inMonth) {
                numCls += ' cal-mini-num-out';
            }

            html += `<div class="${cls}" data-mini-date="${dk}">
                <div class="${numCls}">${d.getDate()}</div>
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

            let html = `<div class="cal-detail-title">${this.fmtDateFull(this.currentDate)} ${this._t(`renderer.calendar.weekday.${this.currentDate.getDay()}`)}</div>`;

            const allDayEvents = dayEvents.filter((e) => e.isAllDay);
            const timedEvents = dayEvents.filter((e) => !e.isAllDay);

            if (allDayEvents.length > 0) {
                html += '<div style="margin-bottom:12px;">';
                html += `<div class="cal-detail-label">${this._t('renderer.calendar.allDay')}</div>`;
                for (const ev of allDayEvents) {
                    const c = getEventColor(ev);
                    html += `<div style="display:flex;gap:12px;padding:10px 12px;border-radius:12px;background:${c.bg};margin-bottom:4px;cursor:pointer;border-left:4px solid ${c.border};" data-detail-uid="${ev.uid}">
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:13px;font-weight:600;color:${c.text};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${ev.subject}</div>
                            ${ev.location ? `<div class="cal-detail-all-day-location"><i class="fa-solid fa-location-dot"></i>${ev.location}</div>` : ''}
                        </div>
                    </div>`;
                }
                html += '</div>';
            }

            if (dayEvents.length === 0) {
                html += `<div style="text-align:center;padding-top:40px;">
                    <div class="cal-detail-empty-icon-wrap">
                        <i class="fa-regular fa-calendar text-xl cal-detail-empty-icon"></i>
                    </div>
                    <p class="cal-detail-empty-title">${this._t('renderer.calendar.noEvents')}</p>
                    <p class="cal-detail-empty-subtitle">${this._t('renderer.calendar.noEventsHint')}</p>
                </div>`;
            } else if (timedEvents.length > 0) {
                html += '<div style="display:flex;flex-direction:column;gap:8px;">';
                for (const ev of timedEvents) {
                    const c = getEventColor(ev);
                    html += `<div class="cal-detail-event-card" data-detail-uid="${ev.uid}">
                        <div style="width:4px;border-radius:4px;background:${c.border};flex-shrink:0;"></div>
                        <div style="flex:1;min-width:0;">
                            <div class="cal-detail-event-title">${ev.subject}</div>
                            <div class="cal-detail-event-time">${this.fmtTime(ev.startTime)} — ${this.fmtTime(ev.endTime)}</div>
                            ${ev.location ? `<div class="cal-detail-event-location"><i class="fa-solid fa-location-dot" style="font-size:10px;margin-right:4px;"></i>${ev.location}</div>` : ''}
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
        const monthLabel = this._t(`renderer.calendar.month.${start.getMonth() + 1}`);

        el.innerHTML = `
        <div class="cal-detail-card">
            <button id="cal-detail-back" class="cal-detail-back-btn">
                <svg width="8" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
                ${this._t('renderer.calendar.back')}
            </button>

            <div class="cal-detail-card-title">${ev.subject}</div>
            ${
                typeDef
                    ? `<div style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:6px;background:${c.bg};margin-bottom:20px;">
                <span style="width:6px;height:6px;border-radius:50%;background:${c.border};"></span>
                <span style="font-size:12px;font-weight:600;color:${c.text};">${this._t(`renderer.calendar.eventType.${typeDef.id}`)}</span>
            </div>`
                    : ''
            }

            <div class="cal-detail-date-box">
                <div class="cal-detail-date-icon">
                    <span class="cal-detail-date-month">${monthLabel}</span>
                    <span class="cal-detail-date-day">${start.getDate()}</span>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;padding-top:2px;">
                    <div class="cal-detail-date-time">
                        <i class="fa-regular fa-clock cal-detail-date-time-icon"></i>
                        ${ev.isAllDay ? this._t('renderer.calendar.allDay') : `${this.fmtTime(ev.startTime)} — ${this.fmtTime(ev.endTime)}`}
                    </div>
                    <div class="cal-detail-date-info">
                        <i class="fa-regular fa-calendar" style="font-size:13px;"></i>
                        ${this.fmtDateFull(start)} ${this._t(`renderer.calendar.weekday.${start.getDay()}`)}
                    </div>
                    ${
                        ev.location
                            ? `<div class="cal-detail-date-location">
                        <i class="fa-solid fa-location-dot" style="font-size:13px;"></i>
                        ${ev.location}
                    </div>`
                            : ''
                    }
                </div>
            </div>

            <div style="display:flex;gap:8px;">
                <button id="cal-detail-edit" class="cal-detail-edit-btn">
                    <i class="fa-solid fa-pen" style="font-size:11px;margin-right:4px;"></i>${this._t('renderer.calendar.edit')}
                </button>
                <button id="cal-detail-delete" class="cal-detail-delete-btn">
                    <i class="fa-solid fa-trash-can" style="font-size:11px;margin-right:4px;"></i>${this._t('renderer.calendar.delete')}
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
        <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;overflow:hidden;">
            <span id="cal-toolbar-title" class="cal-toolbar-title"></span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
            <button id="cal-nav-prev" class="cal-toolbar-btn">
                <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
            </button>
            <button id="cal-nav-next" class="cal-toolbar-btn">
                <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            </button>
            <button id="cal-nav-today" class="cal-today-btn">${this._t('renderer.calendar.today')}</button>
            <div class="cal-seg" id="cal-seg" style="margin-left:8px;">
                <div class="cal-seg-indicator" id="cal-seg-ind"></div>
                <button class="cal-seg-btn ${this.viewMode === 'day' ? 'active' : ''}" data-view="day">${this._t('renderer.calendar.view.day')}</button>
                <button class="cal-seg-btn ${this.viewMode === 'week' ? 'active' : ''}" data-view="week">${this._t('renderer.calendar.view.week')}</button>
                <button class="cal-seg-btn ${this.viewMode === 'month' ? 'active' : ''}" data-view="month">${this._t('renderer.calendar.view.month')}</button>
            </div>
            <button id="cal-add-btn" class="cal-add-event-btn" style="margin-left:8px;">
                <i class="fa-solid fa-plus" style="font-size:12px;"></i> ${this._t('renderer.calendar.addEvent')}
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
            el.textContent = this._t('renderer.calendar.date.monthYear', {
                year: d.getFullYear(),
                monthName: this._t(`renderer.calendar.month.${d.getMonth() + 1}`)
            });
        } else if (this.viewMode === 'week') {
            const ws = getWeekStart(d);
            const we = new Date(ws);
            we.setDate(we.getDate() + 6);
            el.textContent = `${this.fmtMonthDay(ws)} — ${this.fmtMonthDay(we)}, ${ws.getFullYear()}`;
        } else {
            el.textContent = `${this.fmtDateFull(d)} ${this._t(`renderer.calendar.weekday.${d.getDay()}`)}`;
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
        for (let i = 1; i <= 7; i++) {
            html += `<div class="cal-month-header-cell">${this._t(`renderer.calendar.weekdayShort.${i}`)}</div>`;
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
                const timeLabel = ev.isAllDay ? this._t('renderer.calendar.allDay') : this.fmtTime(ev.startTime);
                html += `<div class="cal-month-pill" style="background:${c.bg};color:${c.text};" data-event-uid="${ev.uid}">
                    <div class="cal-month-pill-dot" style="background:${c.border};"></div>
                    <span class="cal-month-pill-time">${timeLabel}</span>
                    <span class="cal-month-pill-subject">${ev.subject}</span>
                </div>`;
            }
            if (evts.length > maxShow) {
                html += `<div class="cal-month-more">${this._t('renderer.calendar.more', { count: evts.length - maxShow })}</div>`;
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
            const monthStr = this.fmtMonthDay(d);
            html += `<div class="cal-time-grid-header-cell ${isToday ? 'today-col' : ''} ${isSel ? 'selected-hdr' : ''}" data-date="${dateKey(d)}">
                <div class="cal-wh-weekday">${this._t(`renderer.calendar.weekday.${(i + 1) % 7}`)}</div>
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
            html += `<div class="cal-allday-gutter">${this._t('renderer.calendar.allDay')}</div>`;
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
                    <div class="cal-ev-block-time">${compact ? fmtTime24(ev.startTime) : `${this.fmtTime(ev.startTime)} – ${this.fmtTime(ev.endTime)}`}</div>
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
            html += `<div class="cal-allday-gutter">${this._t('renderer.calendar.allDay')}</div>`;
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
                <div class="cal-ev-block-time">${compact ? fmtTime24(ev.startTime) : `${this.fmtTime(ev.startTime)} — ${this.fmtTime(ev.endTime)}`}</div>
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
                if (this._dragJustEnded) {
                    this._dragJustEnded = false;
                    return;
                }
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

        this._bindDragEvents(container);
    }

    /* ═══════════════════════════════════════════════════
     *  CONTEXT MENU
     * ═══════════════════════════════════════════════════ */

    _showCtx(x, y, eventUid, targetDate, clickHour = -1) {
        const ctx = this.querySelector('#cal-ctx');
        if (!ctx) return;

        let html = '<div class="cal-ctx">';
        html += `<div class="cal-ctx-item" data-action="add"><i class="fa-solid fa-plus"></i>${this._t('renderer.calendar.addEvent')}</div>`;
        if (eventUid) {
            html += '<div class="cal-ctx-sep"></div>';
            html += `<div class="cal-ctx-item" data-action="edit" data-uid="${eventUid}"><i class="fa-solid fa-pen"></i>${this._t('renderer.calendar.editEvent')}</div>`;
            html += `<div class="cal-ctx-item danger" data-action="delete" data-uid="${eventUid}"><i class="fa-solid fa-trash-can"></i>${this._t('renderer.calendar.deleteEvent')}</div>`;
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
            (t) =>
                `<option value="${t.id}" ${event?.type === t.id ? 'selected' : ''}>${this._t(
                    `renderer.calendar.eventType.${t.id}`
                )}</option>`
        ).join('');

        modal.innerHTML = `
        <div class="cal-modal-bg od-overlay fixed inset-0" id="cal-modal-bg">
            <div class="cal-modal-card">
                <div class="cal-modal-banner cal-modal-banner-info">
                    <div class="cal-modal-banner-icon">
                        <i class="fa-solid fa-calendar-plus"></i>
                    </div>
                    <div class="cal-modal-banner-text">
                        <div class="cal-modal-banner-title">${isEdit ? this._t('renderer.calendar.editEvent') : this._t('renderer.calendar.addEvent')}</div>
                        <div class="cal-modal-banner-subtitle">${this._t('renderer.calendar.modal.subtitle')}</div>
                    </div>
                    <button id="cal-modal-close" class="cal-modal-banner-close">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
                <div style="padding:16px 24px;">

                    <div style="display:flex;flex-direction:column;gap:18px;">
                        <div>
                            <label class="cal-label">${this._t('renderer.calendar.modal.labelTitle')}</label>
                            <input id="cal-m-subject" class="cal-input" type="text" placeholder="${this._t('renderer.calendar.modal.placeholderTitle')}" value="${event?.subject || ''}" />
                        </div>

                        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
                            <div>
                                <label class="cal-label">${this._t('renderer.calendar.modal.labelDate')}</label>
                                <input id="cal-m-date" class="cal-input" type="date" value="${dateStr}" />
                            </div>
                            <div>
                                <label class="cal-label">${this._t('renderer.calendar.modal.labelStart')}</label>
                                <input id="cal-m-start" class="cal-input" type="time" value="${startTimeStr}" />
                            </div>
                            <div>
                                <label class="cal-label">${this._t('renderer.calendar.modal.labelEnd')}</label>
                                <input id="cal-m-end" class="cal-input" type="time" value="${endTimeStr}" />
                            </div>
                        </div>

                        <div>
                            <label class="cal-label">${this._t('renderer.calendar.modal.labelType')}</label>
                            <select id="cal-m-type" class="cal-select">
                                <option value="">${this._t('renderer.calendar.modal.placeholderType')}</option>
                                ${typeOptions}
                            </select>
                        </div>

                        <div>
                            <label class="cal-label">${this._t('renderer.calendar.modal.labelLocation')}</label>
                            <input id="cal-m-location" class="cal-input" type="text" placeholder="${this._t('renderer.calendar.modal.placeholderLocation')}" value="${event?.location || ''}" />
                        </div>

                        <div class="cal-modal-allday">
                            <input id="cal-m-allday" type="checkbox" />
                            <label for="cal-m-allday" class="cal-modal-allday-label">${this._t('renderer.calendar.allDay')}</label>
                        </div>
                    </div>

                    <div class="cal-modal-footer">
                        <button id="cal-modal-cancel" class="cal-btn-secondary">${this._t('renderer.calendar.modal.cancel')}</button>
                        <button id="cal-modal-save" class="cal-btn-primary">${isEdit ? this._t('renderer.calendar.modal.save') : this._t('renderer.calendar.modal.add')}</button>
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

        const allDayCheckbox = modal.querySelector('#cal-m-allday');
        const startInput = modal.querySelector('#cal-m-start');
        const endInput = modal.querySelector('#cal-m-end');
        const syncAllDay = () => {
            if (allDayCheckbox.checked) {
                startInput.value = '00:00';
                endInput.value = '00:00';
                startInput.disabled = true;
                endInput.disabled = true;
            } else {
                startInput.disabled = false;
                endInput.disabled = false;
            }
        };
        allDayCheckbox.addEventListener('change', syncAllDay);
        syncAllDay();

        modal.querySelector('#cal-m-subject').focus();
    }

    /* ═══════════════════════════════════════════════════
     *  DRAG & DROP
     * ═══════════════════════════════════════════════════ */

    _initDrag() {
        this._drag = null;
        this._onDragMove = this._onDragMove.bind(this);
        this._onDragUp = this._onDragUp.bind(this);
        this._onDragKey = this._onDragKey.bind(this);
    }

    _bindDragEvents(container) {
        container.querySelectorAll('[data-event-uid]').forEach((el) => {
            el.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                const uid = el.dataset.eventUid;
                const ev = this._findEvent(uid);
                if (!ev) return;
                e.preventDefault();

                this._drag = {
                    uid,
                    event: ev,
                    startX: e.clientX,
                    startY: e.clientY,
                    el,
                    started: false,
                    ghost: null
                };
                document.addEventListener('mousemove', this._onDragMove);
                document.addEventListener('mouseup', this._onDragUp);
                document.addEventListener('keydown', this._onDragKey);
            });
        });
    }

    _onDragMove(e) {
        if (!this._drag) return;
        const dx = e.clientX - this._drag.startX;
        const dy = e.clientY - this._drag.startY;
        if (!this._drag.started && Math.abs(dx) + Math.abs(dy) < 8) return;

        if (!this._drag.started) {
            this._drag.started = true;
            this._drag.el.classList.add('dragging');
        }

        if (this.viewMode === 'month') {
            this._dragMoveMonth(e);
        } else {
            this._dragMoveTimeGrid(e);
        }
    }

    _dragMoveTimeGrid(e) {
        const container = this.querySelector('#cal-view');
        if (!container) return;
        const ev = this._drag.event;
        const isAllDay = ev.isAllDay;

        if (isAllDay) {
            const allDayCols = container.querySelectorAll('.cal-allday-col');
            let targetCol = null;
            for (const col of allDayCols) {
                const rect = col.getBoundingClientRect();
                if (
                    e.clientX >= rect.left &&
                    e.clientX <= rect.right &&
                    e.clientY >= rect.top - 20 &&
                    e.clientY <= rect.bottom + 20
                ) {
                    targetCol = col;
                    break;
                }
            }

            if (!this._drag.ghost) {
                this._drag.ghost = document.createElement('div');
                this._drag.ghost.className = 'cal-drag-ghost';
                this._drag.ghost.innerHTML = `<div class="cal-drag-ghost-label">${this._t('renderer.calendar.drag.hint')}</div>`;
                this._drag.ghost.style.position = 'fixed';
                this._drag.ghost.style.height = '28px';
                this._drag.ghost.style.zIndex = '9990';
                document.body.appendChild(this._drag.ghost);
            }

            if (targetCol) {
                const rect = targetCol.getBoundingClientRect();
                this._drag.ghost.style.left = rect.left + 'px';
                this._drag.ghost.style.top = rect.top + 'px';
                this._drag.ghost.style.width = rect.width + 'px';
                this._drag.ghost.style.display = 'flex';

                const colEl = targetCol.closest('.cal-allday-cols');
                if (colEl) {
                    const cols = [...colEl.children];
                    const idx = cols.indexOf(targetCol);
                    if (this.viewMode === 'week') {
                        const ws = getWeekStart(this.currentDate);
                        const targetDate = new Date(ws);
                        targetDate.setDate(targetDate.getDate() + idx);
                        this._drag.targetDate = targetDate;
                    } else {
                        this._drag.targetDate = new Date(this.currentDate);
                    }
                }
            } else {
                this._drag.ghost.style.display = 'none';
            }
            return;
        }

        const gridCols = container.querySelectorAll('.cal-time-grid-col');
        let targetCol = null;
        let colIdx = -1;
        for (let i = 0; i < gridCols.length; i++) {
            const rect = gridCols[i].getBoundingClientRect();
            if (e.clientX >= rect.left && e.clientX <= rect.right) {
                targetCol = gridCols[i];
                colIdx = i;
                break;
            }
        }

        if (!targetCol) {
            if (this._drag.ghost) this._drag.ghost.style.display = 'none';
            return;
        }

        const bodyEl = container.querySelector('.cal-time-grid-body');
        if (!bodyEl) return;
        const colsEl = bodyEl.querySelector('.cal-time-grid-cols');
        if (!colsEl) return;
        const colsRect = colsEl.getBoundingClientRect();

        const duration = ev.endTime - ev.startTime;
        const durationMin = Math.max(15, Math.round(duration / 60000));
        const halfDurMin = durationMin / 2;

        const yInCols = e.clientY - colsRect.top;
        const centerMinutes = Math.max(0, Math.min(24 * 60 - 1, Math.round((yInCols / (24 * HOUR_HEIGHT)) * 24 * 60)));
        const startMinutes = Math.max(0, Math.min(24 * 60 - durationMin, centerMinutes - halfDurMin));
        const snappedMinutes = Math.round(startMinutes / 15) * 15;

        const topPx = (snappedMinutes / 60) * HOUR_HEIGHT;
        const heightPx = Math.max((durationMin / 60) * HOUR_HEIGHT, 22);

        if (!this._drag.ghost) {
            this._drag.ghost = document.createElement('div');
            this._drag.ghost.className = 'cal-drag-ghost';
            this._drag.ghost.innerHTML = `<div class="cal-drag-ghost-label">${this._t('renderer.calendar.drag.hint')}</div>`;
            document.body.appendChild(this._drag.ghost);
        }

        this._drag.ghost.style.position = 'absolute';
        this._drag.ghost.style.display = 'flex';

        if (colsEl && this._drag.ghost.parentElement !== colsEl) {
            colsEl.appendChild(this._drag.ghost);
        }

        if (this.viewMode === 'week') {
            const left = (colIdx / gridCols.length) * 100;
            const width = (1 / gridCols.length) * 100;
            this._drag.ghost.style.left = `calc(${left}% + 2px)`;
            this._drag.ghost.style.width = `calc(${width}% - 4px)`;
        } else {
            this._drag.ghost.style.left = '4px';
            this._drag.ghost.style.width = 'calc(100% - 8px)';
        }
        this._drag.ghost.style.top = topPx + 'px';
        this._drag.ghost.style.height = heightPx + 'px';

        if (targetCol.dataset.date) {
            const parts = targetCol.dataset.date.split('-');
            this._drag.targetDate = new Date(+parts[0], +parts[1] - 1, +parts[2]);
        }
        this._drag.targetMinutes = snappedMinutes;
        this._drag.targetDurationMin = durationMin;
    }

    _dragMoveMonth(e) {
        const container = this.querySelector('#cal-view');
        if (!container) return;
        const cells = container.querySelectorAll('.cal-month-cell[data-date]');
        let targetCell = null;

        for (const cell of cells) {
            const rect = cell.getBoundingClientRect();
            if (
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom
            ) {
                targetCell = cell;
                break;
            }
        }

        container.querySelectorAll('.cal-drag-ghost-month').forEach((g) => g.remove());

        if (targetCell) {
            const ghost = document.createElement('div');
            ghost.className = 'cal-drag-ghost-month';
            ghost.innerHTML = `<div class="cal-drag-ghost-label" style="padding:4px 6px;font-size:10px;">${this._t('renderer.calendar.drag.hint')}</div>`;
            ghost.style.position = 'absolute';
            ghost.style.inset = '0';
            targetCell.style.position = 'relative';
            targetCell.appendChild(ghost);

            const parts = targetCell.dataset.date.split('-');
            this._drag.targetDate = new Date(+parts[0], +parts[1] - 1, +parts[2]);
        }
    }

    _onDragUp(e) {
        if (!this._drag || !this._drag.started) {
            this._dragCleanup();
            return;
        }
        this._dragJustEnded = true;
        setTimeout(() => {
            this._dragJustEnded = false;
        }, 50);
        const ev = this._drag.event;
        const targetDate = this._drag.targetDate;

        if (!targetDate) {
            this._dragCleanup();
            return;
        }

        let newStart, newEnd;
        if (ev.isAllDay) {
            const origStart = new Date(ev.startTime);
            const origEnd = new Date(ev.endTime);
            const dayDiff = Math.round(
                (targetDate.getTime() -
                    new Date(origStart.getFullYear(), origStart.getMonth(), origStart.getDate()).getTime()) /
                    86400000
            );
            if (dayDiff === 0) {
                this._dragCleanup();
                return;
            }
            newStart = new Date(ev.startTime + dayDiff * 86400000);
            newEnd = new Date(ev.endTime + dayDiff * 86400000);
        } else if (this.viewMode === 'month') {
            const origStart = new Date(ev.startTime);
            const origEnd = new Date(ev.endTime);
            const dayDiff = Math.round(
                (targetDate.getTime() -
                    new Date(origStart.getFullYear(), origStart.getMonth(), origStart.getDate()).getTime()) /
                    86400000
            );
            if (dayDiff === 0) {
                this._dragCleanup();
                return;
            }
            newStart = new Date(ev.startTime + dayDiff * 86400000);
            newEnd = new Date(ev.endTime + dayDiff * 86400000);
        } else {
            const minutes = this._drag.targetMinutes ?? 0;
            const durMin = this._drag.targetDurationMin ?? 60;
            newStart = new Date(targetDate);
            newStart.setHours(0, minutes, 0, 0);
            newEnd = new Date(newStart.getTime() + durMin * 60000);

            if (newStart.getTime() === ev.startTime && newEnd.getTime() === ev.endTime) {
                this._dragCleanup();
                return;
            }
        }

        this._dragCleanup();
        this._showDragConfirmModal(ev, newStart, newEnd);
    }

    _onDragKey(e) {
        if (e.key === 'Escape' && this._drag) {
            this._dragCleanup();
        }
    }

    _dragCleanup() {
        if (!this._drag) return;
        if (this._drag.ghost) this._drag.ghost.remove();
        if (this._drag.el) this._drag.el.classList.remove('dragging');
        this.querySelectorAll('.cal-drag-ghost-month').forEach((g) => g.remove());
        this._drag = null;
        document.removeEventListener('mousemove', this._onDragMove);
        document.removeEventListener('mouseup', this._onDragUp);
        document.removeEventListener('keydown', this._onDragKey);
    }

    _showDragConfirmModal(ev, newStart, newEnd) {
        const modal = this.querySelector('#cal-modal');
        if (!modal) return;
        modal.classList.remove('hidden');

        const origS = new Date(ev.startTime);
        const formatRange = (s, e, allDay) => {
            if (allDay) return `${this.fmtDateFull(s)} ${this._t('renderer.calendar.allDay')}`;
            return `${this.fmtDateFull(s)} ${fmtTime24(s.getTime())} — ${fmtTime24(e.getTime())}`;
        };

        modal.innerHTML = `
        <div class="cal-modal-bg od-overlay fixed inset-0" id="cal-modal-bg">
            <div class="cal-modal-card" style="width:400px;">
                <div class="cal-modal-banner cal-modal-banner-info">
                    <div class="cal-modal-banner-icon">
                        <i class="fa-solid fa-arrows-up-down-left-right"></i>
                    </div>
                    <div class="cal-modal-banner-text">
                        <div class="cal-modal-banner-title">${this._t('renderer.calendar.drag.title')}</div>
                    </div>
                    <button id="cal-drag-close" class="cal-modal-banner-close">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
                <div style="padding:16px 24px;">
                    <div style="margin-bottom:20px;">
                        <div class="cal-drag-subject">${ev.subject}</div>
                        <div style="display:flex;flex-direction:column;gap:8px;">
                            <div style="display:flex;align-items:center;gap:8px;">
                                <span class="cal-drag-label-old">${this._t('renderer.calendar.drag.old')}</span>
                                <span class="cal-drag-value-old">${formatRange(origS, new Date(ev.endTime), ev.isAllDay)}</span>
                            </div>
                            <div style="display:flex;align-items:center;gap:8px;">
                                <span class="cal-drag-label-new">${this._t('renderer.calendar.drag.new')}</span>
                                <span class="cal-drag-value-new">${formatRange(newStart, newEnd, ev.isAllDay)}</span>
                            </div>
                        </div>
                    </div>
                    <div class="cal-drag-footer">
                        <button id="cal-drag-cancel" class="cal-btn-secondary">${this._t('renderer.calendar.modal.cancel')}</button>
                        <button id="cal-drag-confirm" class="cal-btn-primary">${this._t('renderer.calendar.drag.confirm')}</button>
                    </div>
                </div>
            </div>
        </div>`;

        const close = () => {
            const bg = modal.querySelector('.cal-modal-bg');
            if (bg) {
                bg.classList.add('leaving');
                // 等待退出动画结束后再真正隐藏
                setTimeout(() => {
                    modal.classList.add('hidden');
                    modal.innerHTML = '';
                }, 180);
            } else {
                modal.classList.add('hidden');
                modal.innerHTML = '';
            }
            document.removeEventListener('keydown', escH);
        };
        const escH = (e) => {
            if (e.key === 'Escape') close();
        };
        document.addEventListener('keydown', escH);

        modal.querySelector('#cal-modal-bg').addEventListener('click', (e) => {
            if (e.target.id === 'cal-modal-bg') close();
        });
        modal.querySelector('#cal-drag-cancel').addEventListener('click', close);
        modal.querySelector('#cal-drag-close')?.addEventListener('click', close);
        modal.querySelector('#cal-drag-confirm').addEventListener('click', async () => {
            try {
                await window.applicationAPI.call('updateCalendarItem', ev.uid, {
                    startTime: newStart.getTime(),
                    endTime: newEnd.getTime()
                });
                close();
                await this._refreshAll();
            } catch (err) {
                console.error('移动日程失败:', err);
                close();
            }
        });
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
