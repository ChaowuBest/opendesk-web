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

import { AgentOperableHTMLElement } from '../../widget_utils.js';
import { escapeHtml } from '../../../utils/escape.js';

/* ═══════════════════════════════════════════════════
 *  TYPES
 * ═══════════════════════════════════════════════════ */

interface GlobalTodo {
    id: string;
    title: string;
    content: string;
    status: string;
    priority: string;
    category?: string;
    trigger?: { type: string; triggerAt?: string; cronExpression?: string; bundleName?: string; eventName?: string };
    deliver?: { channel: string; accountId: string; recipientId: string };
    last_triggered_at?: string;
    created_at: string;
    updated_at: string;
    completed_at?: string;
}

interface AppEvent {
    bundleName: string;
    appName: string;
    eventName: string;
    eventDescription: string;
}

type TriggerType = 'scheduled' | 'cron' | 'event';
type CardExpandedState = TriggerType | null;

/* ═══════════════════════════════════════════════════
 *  CSS
 * ═══════════════════════════════════════════════════ */

const TODOMGR_CSS = `
/* ---- Root ---- */
.tm-root {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    color: #1d1d1f;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #FAFAFA;
}

/* ---- Toolbar (top, always full-width) ---- */
.tm-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 36px 20px 14px 24px;
    border-bottom: 1px solid #F0F0F0;
    background: #fff;
    min-height: 56px;
    flex-shrink: 0;
}
.tm-toolbar-title {
    font-size: 16px;
    font-weight: 700;
    color: #1d1d1f;
    letter-spacing: -0.01em;
}
.tm-toolbar-subtitle {
    font-size: 12px;
    color: #8E8E93;
    font-weight: 400;
    margin-top: 2px;
}

/* ---- Content row (below toolbar, horizontal split) ---- */
.tm-content-row {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
}

/* ---- Left panel ---- */
.tm-left {
    flex: 1;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    background: #FAFAFA;
}

/* ---- Cards container ---- */
.tm-cards {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 12px 16px;
    min-height: 0;
    overflow: hidden;
}

/* ---- Category card ---- */
.tm-card {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: #fff;
    border: 1px solid #EBEBEB;
    border-radius: 14px;
    min-height: 0;
    overflow: hidden;
    transition: flex 320ms cubic-bezier(0.4, 0, 0.2, 1), opacity 200ms ease, margin 320ms cubic-bezier(0.4, 0, 0.2, 1);
    margin-bottom: 10px;
}
.tm-card:last-child { margin-bottom: 0; }
.tm-card.tm-card-collapsed {
    flex: 0 0 0px;
    opacity: 0;
    margin-bottom: 0;
    border-width: 0;
    overflow: hidden;
}
.tm-card.tm-card-expanded {
    flex: 1 0 0px;
}

.tm-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px 8px;
    flex-shrink: 0;
}
.tm-card-header-left {
    display: flex;
    align-items: center;
    gap: 8px;
}
.tm-card-icon {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    flex-shrink: 0;
}
.tm-card-title {
    font-size: 14px;
    font-weight: 600;
    color: #1d1d1f;
}
.tm-card-count {
    font-size: 12px;
    font-weight: 500;
    color: #8E8E93;
    margin-left: 4px;
}
.tm-card-actions {
    display: flex;
    align-items: center;
    gap: 4px;
}
.tm-card-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    border: none;
    background: transparent;
    cursor: pointer;
    color: #8E8E93;
    font-size: 13px;
    transition: all 0.15s;
}
.tm-card-btn:hover {
    background: #F2F2F7;
    color: #3C3C43;
}
.tm-card-btn:active { transform: scale(0.92); }

.tm-card-body {
    flex: 1;
    overflow-y: auto;
    padding: 0 10px 10px;
    min-height: 0;
}
.tm-card-body::-webkit-scrollbar { width: 4px; }
.tm-card-body::-webkit-scrollbar-track { background: transparent; }
.tm-card-body::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 4px; }
.tm-card-body::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.2); }

/* ---- Task item ---- */
.tm-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    cursor: pointer;
    transition: all 0.15s;
    border: 1.5px solid transparent;
}
.tm-item:hover {
    background: #F5F5F7;
}
.tm-item.tm-item-selected {
    background: #EDF2FE;
    border-color: #C2D4F8;
}
.tm-item-icon {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    flex-shrink: 0;
    margin-top: 1px;
}
.tm-item-body {
    flex: 1;
    min-width: 0;
}
.tm-item-title {
    font-size: 13px;
    font-weight: 600;
    color: #1d1d1f;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.tm-item-desc {
    font-size: 12px;
    color: #8E8E93;
    line-height: 1.4;
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.tm-item-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    flex-wrap: wrap;
}
.tm-item-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 7px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 500;
    line-height: 1.6;
}

/* ---- Empty state ---- */
.tm-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px 12px;
    color: #C7C7CC;
    font-size: 13px;
    gap: 4px;
}
.tm-empty i { font-size: 24px; opacity: 0.4; }

/* ---- Resizer ---- */
.tm-resizer {
    width: 5px;
    cursor: col-resize;
    flex-shrink: 0;
    position: relative;
    z-index: 2;
}
.tm-resizer-indicator {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 3px;
    height: 40px;
    border-radius: 9999px;
    background: rgba(0,0,0,0.1);
    opacity: 0;
    transition: opacity 0.2s;
    pointer-events: none;
}
.tm-resizer:hover .tm-resizer-indicator { opacity: 1; }

/* ---- Right panel ---- */
.tm-right {
    width: 0;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #fff;
    border-left: 1px solid #F0F0F0;
    overflow: hidden;
    opacity: 0;
    transition: width 280ms cubic-bezier(0.4, 0, 0.2, 1), opacity 280ms cubic-bezier(0.4, 0, 0.2, 1);
}
.tm-right.tm-right-open {
    opacity: 1;
}

.tm-detail-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 0;
    min-height: 0;
}
.tm-detail-scroll::-webkit-scrollbar { width: 4px; }
.tm-detail-scroll::-webkit-scrollbar-track { background: transparent; }
.tm-detail-scroll::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 4px; }

/* ---- Detail header ---- */
.tm-detail-header {
    padding: 20px 24px 16px;
    border-bottom: 1px solid #F0F0F0;
    flex-shrink: 0;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
}
.tm-detail-title {
    font-size: 17px;
    font-weight: 700;
    color: #1d1d1f;
    line-height: 1.35;
    flex: 1;
    min-width: 0;
}
.tm-detail-close {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    border: none;
    background: transparent;
    cursor: pointer;
    color: #8E8E93;
    font-size: 14px;
    flex-shrink: 0;
    transition: all 0.15s;
}
.tm-detail-close:hover { background: #F2F2F7; color: #3C3C43; }

/* ---- Detail body ---- */
.tm-detail-body {
    padding: 20px 24px;
}
.tm-detail-section {
    margin-bottom: 20px;
}
.tm-detail-section-title {
    font-size: 11px;
    font-weight: 600;
    color: #8E8E93;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
}
.tm-detail-content {
    font-size: 14px;
    color: #3C3C43;
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
}

/* ---- Detail attributes grid ---- */
.tm-detail-attrs {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px 16px;
    font-size: 13px;
}
.tm-detail-attr-label {
    color: #8E8E93;
    font-weight: 500;
    white-space: nowrap;
}
.tm-detail-attr-value {
    color: #1d1d1f;
    word-break: break-word;
}

/* ---- Detail footer ---- */
.tm-detail-footer {
    padding: 14px 24px;
    border-top: 1px solid #F0F0F0;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    background: #fff;
}
.tm-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 18px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    border: 1.5px solid #E5E5EA;
    background: #fff;
    color: #1d1d1f;
    white-space: nowrap;
}
.tm-btn:hover { background: #F5F5F7; border-color: #D1D1D6; }
.tm-btn:active { transform: scale(0.97); }
.tm-btn-primary {
    background: #1d1d1f;
    color: #fff;
    border-color: #1d1d1f;
}
.tm-btn-primary:hover { background: #333; border-color: #333; }
.tm-btn-danger {
    color: #DC2626;
    border-color: #FECACA;
}
.tm-btn-danger:hover { background: #FEF2F2; border-color: #FCA5A5; }

/* ---- Edit mode ---- */
.tm-edit-field {
    margin-bottom: 14px;
}
.tm-edit-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #8E8E93;
    margin-bottom: 5px;
}
.tm-edit-input,
.tm-edit-textarea,
.tm-edit-select {
    width: 100%;
    padding: 9px 12px;
    border: 1.5px solid #E5E5EA;
    border-radius: 10px;
    font-size: 13px;
    color: #1d1d1f;
    background: #fff;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
    font-family: inherit;
    box-sizing: border-box;
}
.tm-edit-input:focus,
.tm-edit-textarea:focus,
.tm-edit-select:focus {
    border-color: #3B82F6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}
.tm-edit-textarea {
    resize: vertical;
    min-height: 80px;
    line-height: 1.55;
}

/* ---- Cron builder ---- */
.tm-cron-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    flex-wrap: wrap;
}
.tm-cron-row label {
    font-size: 12px;
    color: #3C3C43;
    font-weight: 500;
    white-space: nowrap;
    min-width: 45px;
}
.tm-cron-select {
    padding: 6px 10px;
    border: 1.5px solid #E5E5EA;
    border-radius: 8px;
    font-size: 12px;
    color: #1d1d1f;
    background: #fff;
    outline: none;
    font-family: inherit;
    transition: border-color 0.15s;
}
.tm-cron-select:focus { border-color: #3B82F6; }
.tm-cron-preview {
    margin-top: 6px;
    padding: 8px 12px;
    background: #F5F5F7;
    border-radius: 8px;
    font-size: 12px;
    color: #3C3C43;
    font-family: 'Cascadia Code', 'SF Mono', monospace;
}
.tm-cron-dow-grid {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
}
.tm-cron-dow-btn {
    width: 32px;
    height: 28px;
    border-radius: 7px;
    border: 1.5px solid #E5E5EA;
    background: #fff;
    color: #3C3C43;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
}
.tm-cron-dow-btn:hover { border-color: #3B82F6; }
.tm-cron-dow-btn.active {
    background: #3B82F6;
    color: #fff;
    border-color: #3B82F6;
}

/* ---- Priority dots ---- */
.tm-priority-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
}
.tm-priority-high { background: #FF3B30; }
.tm-priority-medium { background: #FF9500; }
.tm-priority-low { background: #34C759; }

/* ---- Status indicator ---- */
.tm-status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
}
.tm-status-pending { background: #C7C7CC; }
.tm-status-in_progress { background: #007AFF; }
.tm-status-completed { background: #34C759; }

/* ---- Modal ---- */
.tm-modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.3);
    backdrop-filter: blur(6px);
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: tm-fade-in 250ms ease-out;
}
.tm-modal-overlay.tm-modal-closing {
    animation: tm-fade-out 180ms ease-in forwards;
}
.tm-modal-card {
    background: #fff;
    border-radius: 20px;
    box-shadow: 0 24px 80px rgba(0,0,0,0.18), 0 0 1px rgba(0,0,0,0.1);
    width: 400px;
    max-width: 92vw;
    padding: 28px;
    overflow: hidden;
    animation: tm-scale-in 250ms cubic-bezier(0.23, 1, 0.32, 1);
}
.tm-modal-closing .tm-modal-card {
    animation: tm-scale-out 180ms ease-in forwards;
}
.tm-modal-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
}
.tm-modal-icon {
    width: 42px;
    height: 42px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    flex-shrink: 0;
}
.tm-modal-title {
    font-size: 16px;
    font-weight: 700;
    color: #1d1d1f;
}
.tm-modal-message {
    font-size: 14px;
    color: #3C3C43;
    line-height: 1.6;
    margin-bottom: 22px;
}
.tm-modal-footer {
    border-top: 1px solid #F0F0F0;
    padding-top: 16px;
    display: flex;
    justify-content: flex-end;
    gap: 10px;
}
.tm-modal-btn {
    padding: 10px 24px;
    border-radius: 12px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    border: none;
}
.tm-modal-btn:active { transform: scale(0.97); }
.tm-modal-btn-cancel {
    background: #fff;
    color: #1d1d1f;
    border: 1.5px solid #E5E5EA;
}
.tm-modal-btn-cancel:hover { background: #F5F5F7; }
.tm-modal-btn-danger {
    background: #DC2626;
    color: #fff;
}
.tm-modal-btn-danger:hover { background: #B91C1C; }

@keyframes tm-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes tm-fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes tm-scale-in { from { opacity: 0; transform: scale(0.95) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }
@keyframes tm-scale-out { from { opacity: 1; transform: scale(1) translateY(0); } to { opacity: 0; transform: scale(0.95) translateY(10px); } }

/* ---- Custom DateTime Picker ---- */
.tm-dt-wrapper {
    border: 1.5px solid #E5E5EA;
    border-radius: 12px;
    background: #fff;
    overflow: hidden;
}
.tm-dt-display {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 9px 12px;
    cursor: pointer;
    user-select: none;
    font-size: 13px;
    color: #1d1d1f;
    transition: background 0.12s;
}
.tm-dt-display:hover { background: #F9F9FB; }
.tm-dt-display-text { flex: 1; }
.tm-dt-display-icon { color: #8E8E93; font-size: 14px; margin-left: 8px; }
.tm-dt-placeholder { color: #8E8E93; }
.tm-dt-panel {
    border-top: 1px solid #F0F0F0;
    padding: 14px;
    display: none;
}
.tm-dt-panel.open { display: block; }

.tm-dt-cal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
}
.tm-dt-cal-title {
    font-size: 13px;
    font-weight: 600;
    color: #1d1d1f;
}
.tm-dt-cal-nav {
    display: flex;
    gap: 4px;
}
.tm-dt-cal-nav-btn {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    border: 1px solid #E5E5EA;
    background: #fff;
    color: #3C3C43;
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.12s;
}
.tm-dt-cal-nav-btn:hover { background: #F5F5F7; border-color: #D1D1D6; }

.tm-dt-cal-weekdays {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
    margin-bottom: 4px;
}
.tm-dt-cal-wd {
    text-align: center;
    font-size: 11px;
    font-weight: 600;
    color: #8E8E93;
    padding: 4px 0;
}
.tm-dt-cal-days {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
}
.tm-dt-cal-day {
    text-align: center;
    font-size: 12px;
    padding: 6px 0;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.12s;
    color: #1d1d1f;
    border: none;
    background: transparent;
    font-family: inherit;
}
.tm-dt-cal-day:hover { background: #F0F0F5; }
.tm-dt-cal-day.other-month { color: #C7C7CC; }
.tm-dt-cal-day.today { font-weight: 700; color: #3B82F6; }
.tm-dt-cal-day.selected { background: #3B82F6; color: #fff; font-weight: 600; }
.tm-dt-cal-day.selected:hover { background: #2563EB; }

.tm-dt-time-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid #F0F0F0;
}
.tm-dt-time-label {
    font-size: 12px;
    color: #3C3C43;
    font-weight: 500;
    white-space: nowrap;
}
.tm-dt-time-select {
    padding: 6px 10px;
    border: 1.5px solid #E5E5EA;
    border-radius: 8px;
    font-size: 13px;
    color: #1d1d1f;
    background: #fff;
    outline: none;
    font-family: inherit;
    transition: border-color 0.15s;
    cursor: pointer;
}
.tm-dt-time-select:focus { border-color: #3B82F6; }
.tm-dt-time-colon {
    font-size: 14px;
    font-weight: 600;
    color: #3C3C43;
}
.tm-dt-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid #F0F0F0;
}
.tm-dt-today-btn {
    font-size: 12px;
    color: #3B82F6;
    background: none;
    border: none;
    cursor: pointer;
    font-weight: 500;
    font-family: inherit;
    padding: 4px 8px;
    border-radius: 6px;
    transition: background 0.12s;
}
.tm-dt-today-btn:hover { background: #EFF6FF; }
.tm-dt-confirm-btn {
    padding: 7px 20px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    background: #3B82F6;
    color: #fff;
    font-family: inherit;
    transition: all 0.15s;
}
.tm-dt-confirm-btn:hover { background: #2563EB; }
.tm-dt-confirm-btn:active { transform: scale(0.97); }
.tm-dt-confirm-btn:disabled { background: #C7C7CC; cursor: not-allowed; }
`;

/* ═══════════════════════════════════════════════════
 *  CONSTANTS
 * ═══════════════════════════════════════════════════ */

const CARD_CONFIG: Record<
    TriggerType,
    { label: string; icon: string; iconBg: string; iconColor: string; emptyIcon: string; emptyText: string }
> = {
    scheduled: {
        label: '定时任务',
        icon: 'fa-clock',
        iconBg: '#EFF6FF',
        iconColor: '#2563EB',
        emptyIcon: 'fa-clock',
        emptyText: '暂无定时任务'
    },
    cron: {
        label: '周期任务',
        icon: 'fa-arrows-rotate',
        iconBg: '#F0FDF4',
        iconColor: '#16A34A',
        emptyIcon: 'fa-arrows-rotate',
        emptyText: '暂无周期任务'
    },
    event: {
        label: '按需触发任务',
        icon: 'fa-bolt',
        iconBg: '#FFF7ED',
        iconColor: '#EA580C',
        emptyIcon: 'fa-bolt',
        emptyText: '暂无触发任务'
    }
};

const PRIORITY_CONFIG: Record<string, { label: string; color: string; bg: string; dot: string }> = {
    high: { label: '高', color: '#DC2626', bg: '#FEF2F2', dot: 'tm-priority-high' },
    medium: { label: '中', color: '#D97706', bg: '#FFFBEB', dot: 'tm-priority-medium' },
    low: { label: '低', color: '#16A34A', bg: '#F0FDF4', dot: 'tm-priority-low' }
};

const STATUS_CONFIG: Record<string, { label: string; dot: string }> = {
    pending: { label: '待执行', dot: 'tm-status-pending' },
    in_progress: { label: '执行中', dot: 'tm-status-in_progress' },
    completed: { label: '已完成', dot: 'tm-status-completed' }
};

const DEFAULT_RIGHT_WIDTH = 420;
const MIN_RIGHT_WIDTH = 280;

const DOW_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

/* ═══════════════════════════════════════════════════
 *  HELPERS
 * ═══════════════════════════════════════════════════ */

function categorizeTodos(todos: GlobalTodo[]): Record<TriggerType, GlobalTodo[]> {
    const result: Record<TriggerType, GlobalTodo[]> = { scheduled: [], cron: [], event: [] };
    for (const t of todos) {
        const type = t.trigger?.type as TriggerType | undefined;
        if (type && result[type]) {
            result[type].push(t);
        } else {
            result.event.push(t);
        }
    }
    return result;
}

function formatDate(iso: string): string {
    try {
        const d = new Date(iso);
        const month = d.getMonth() + 1;
        const day = d.getDate();
        const h = String(d.getHours()).padStart(2, '0');
        const m = String(d.getMinutes()).padStart(2, '0');
        return `${month}月${day}日 ${h}:${m}`;
    } catch {
        return iso;
    }
}

function describeCronLocal(expr: string): string {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return expr;
    const [minute, hour, dom, month, dow] = fields;
    const parts: string[] = [];

    const offsetMin = -new Date().getTimezoneOffset();
    let lm = parseInt(minute, 10) + (offsetMin % 60);
    let lh = parseInt(hour, 10) + Math.floor(offsetMin / 60);
    let dayShift = 0;
    if (lm >= 60) {
        lh++;
        lm -= 60;
    }
    if (lm < 0) {
        lh--;
        lm += 60;
    }
    if (lh >= 24) {
        lh -= 24;
        dayShift = 1;
    }
    if (lh < 0) {
        lh += 24;
        dayShift = -1;
    }

    const canConvert = /^\d+$/.test(hour) && /^\d+$/.test(minute);
    const displayH = canConvert ? String(lh) : hour;
    const displayM = canConvert ? String(lm).padStart(2, '0') : minute;

    if (dow !== '*') {
        if (/^\d+$/.test(dow)) {
            let d = parseInt(dow, 10);
            if (canConvert && dayShift) d = (((d + dayShift) % 7) + 7) % 7;
            parts.push(`每周${DOW_LABELS[d] || d}`);
        } else if (/^\d+-\d+$/.test(dow)) {
            const [s, e] = dow.split('-').map(Number);
            parts.push(`周${DOW_LABELS[s]}-${DOW_LABELS[e]}`);
        } else if (/^[\d,]+$/.test(dow)) {
            const days = dow.split(',').map((d) => `周${DOW_LABELS[parseInt(d)] || d}`);
            parts.push(days.join('/'));
        } else {
            parts.push(`周${dow}`);
        }
    }
    if (dom !== '*') parts.push(`每月${dom}日`);
    if (month !== '*') parts.push(`${month}月`);
    if (displayH !== '*' && displayM !== '*') parts.push(`${displayH}:${displayM}`);
    else if (displayH !== '*') parts.push(`${displayH}时`);
    else if (displayM !== '*') parts.push(`每小时第${displayM}分`);
    if (!canConvert && (hour !== '*' || minute !== '*')) parts.push('(UTC)');
    return parts.length > 0 ? parts.join(' ') : '每分钟';
}

function getTriggerSummary(todo: GlobalTodo): string {
    if (!todo.trigger) return '手动触发';
    switch (todo.trigger.type) {
        case 'scheduled':
            return todo.trigger.triggerAt ? formatDate(todo.trigger.triggerAt) : '定时';
        case 'cron':
            return todo.trigger.cronExpression ? describeCronLocal(todo.trigger.cronExpression) : '周期';
        case 'event':
            return `${todo.trigger.bundleName || ''}:${todo.trigger.eventName || ''}`;
        default:
            return '未知';
    }
}

/**
 * Build a cron expression from structured selections (local time → UTC)
 */
function buildCronFromUI(
    mode: string,
    hour: number,
    minute: number,
    selectedDows: number[],
    dom: string,
    monthVal: string
): string {
    const offsetMin = -new Date().getTimezoneOffset();
    let utcM = minute - (offsetMin % 60);
    let utcH = hour - Math.floor(offsetMin / 60);
    let dayShift = 0;
    if (utcM < 0) {
        utcH--;
        utcM += 60;
    }
    if (utcM >= 60) {
        utcH++;
        utcM -= 60;
    }
    if (utcH < 0) {
        utcH += 24;
        dayShift = -1;
    }
    if (utcH >= 24) {
        utcH -= 24;
        dayShift = 1;
    }

    let cronDow = '*';
    if (mode === 'weekly' && selectedDows.length > 0 && selectedDows.length < 7) {
        cronDow = selectedDows
            .map((d) => (((d + dayShift) % 7) + 7) % 7)
            .sort((a, b) => a - b)
            .join(',');
    }
    const cronDom = mode === 'monthly' && dom !== '*' ? dom : '*';
    const cronMonth = monthVal !== '*' ? monthVal : '*';

    return `${utcM} ${utcH} ${cronDom} ${cronMonth} ${cronDow}`;
}

/* ═══════════════════════════════════════════════════
 *  WIDGET
 * ═══════════════════════════════════════════════════ */

class TodoMgrEntryWidget extends AgentOperableHTMLElement {
    private _onGlobalTodosUpdated: ((todos: any[]) => void) | null = null;
    private globalTodos: GlobalTodo[] = [];
    private selectedTodoId: string | null = null;
    private expandedCard: CardExpandedState = null;
    private rightWidth = DEFAULT_RIGHT_WIDTH;
    private isEditing = false;
    private isAddingNew = false;
    private addingType: TriggerType | null = null;

    private _isResizing = false;
    private _resizeRaf: number | null = null;
    private _boundMouseMove: ((e: MouseEvent) => void) | null = null;
    private _boundMouseUp: (() => void) | null = null;

    private _cachedEvents: AppEvent[] | null = null;

    private _dtYear = 0;
    private _dtMonth = 0;
    private _dtDay = 0;
    private _dtHour = 0;
    private _dtMinute = 0;
    private _dtViewYear = 0;
    private _dtViewMonth = 0;
    private _dtPanelOpen = false;

    connectedCallback() {
        this._injectCSS();
        this.render();
        this.loadData();
        this._prefetchEvents();

        this._onGlobalTodosUpdated = (todos: any[]) => {
            this.globalTodos = todos;
            this._refreshList();
            if (this.selectedTodoId && this.selectedTodoId !== '__new__') {
                const still = todos.find((t: any) => t.id === this.selectedTodoId);
                if (still) {
                    if (!this.isEditing) this._renderDetail(still);
                } else {
                    this._closeDetail();
                }
            }
        };
        window.applicationAPI.subscribe('globalTodosUpdated', this._onGlobalTodosUpdated);
    }

    disconnectedCallback() {
        if (this._onGlobalTodosUpdated) {
            window.applicationAPI.unsubscribe('globalTodosUpdated', this._onGlobalTodosUpdated);
            this._onGlobalTodosUpdated = null;
        }
        this._stopResize();
    }

    getAgentInstruct(): string {
        return '你是待办事项管理助手，可以帮助用户查看和管理自动化任务。当前页面展示了所有自动化任务（定时任务、周期任务和按需触发任务）。你可以使用 addGlobalTodo / updateGlobalTodo / deleteGlobalTodo / listGlobalTodos 等工具管理全局待办。';
    }

    /* ═══════════════════════════
     *  EVENTS (available events for event triggers)
     * ═══════════════════════════ */

    private async _prefetchEvents() {
        try {
            this._cachedEvents = await this._fetchAllEvents();
        } catch {
            /* ignore */
        }
    }

    private async _fetchAllEvents(): Promise<AppEvent[]> {
        const result = await window.applicationAPI.callMainWorld('getAllEventsForUI');
        return Array.isArray(result) ? result : [];
    }

    /* ═══════════════════════════
     *  RENDER SHELL
     * ═══════════════════════════ */

    private _injectCSS() {
        if (document.getElementById('tm-custom-css')) return;
        const s = document.createElement('style');
        s.id = 'tm-custom-css';
        s.textContent = TODOMGR_CSS;
        document.head.appendChild(s);
    }

    render() {
        this.innerHTML = `
        <div class="tm-root">
            <div class="tm-toolbar">
                <div>
                    <div class="tm-toolbar-title">自动化任务</div>
                    <div class="tm-toolbar-subtitle" id="tm-summary">加载中...</div>
                </div>
                <button class="tm-btn" id="tm-refresh-btn" style="padding:6px 14px;">
                    <i class="fas fa-arrow-rotate-right" style="font-size:12px;"></i>
                    刷新
                </button>
            </div>
            <div class="tm-content-row">
                <div class="tm-left" id="tm-left">
                    <div class="tm-cards" id="tm-cards">
                        ${this._renderCards()}
                    </div>
                </div>
                <div class="tm-resizer" id="tm-resizer" style="display:none;">
                    <div class="tm-resizer-indicator"></div>
                </div>
                <div class="tm-right" id="tm-right">
                    <div class="tm-detail-scroll" id="tm-detail-scroll"></div>
                    <div class="tm-detail-footer" id="tm-detail-footer" style="display:none;"></div>
                </div>
            </div>
        </div>`;

        this._bindEvents();
    }

    /* ═══════════════════════════
     *  LEFT: CARDS
     * ═══════════════════════════ */

    private _renderCards(): string {
        const categories = categorizeTodos(this.globalTodos);
        return (['scheduled', 'cron', 'event'] as TriggerType[])
            .map((type) => {
                const cfg = CARD_CONFIG[type];
                const todos = categories[type];
                return `
            <div class="tm-card" id="tm-card-${type}" data-type="${type}">
                <div class="tm-card-header">
                    <div class="tm-card-header-left">
                        <div class="tm-card-icon" style="background:${cfg.iconBg};color:${cfg.iconColor};">
                            <i class="fas ${cfg.icon}"></i>
                        </div>
                        <span class="tm-card-title">${cfg.label}</span>
                        <span class="tm-card-count" id="tm-count-${type}">${todos.length}</span>
                    </div>
                    <div class="tm-card-actions">
                        <button class="tm-card-btn" data-action="add" data-type="${type}" title="添加${cfg.label}">
                            <i class="fas fa-plus"></i>
                        </button>
                        <button class="tm-card-btn" data-action="toggle-expand" data-type="${type}" title="全屏">
                            <i class="fas fa-expand"></i>
                        </button>
                    </div>
                </div>
                <div class="tm-card-body" id="tm-list-${type}">
                    ${this._renderTodoItems(todos, type)}
                </div>
            </div>`;
            })
            .join('');
    }

    private _renderTodoItems(todos: GlobalTodo[], type: TriggerType): string {
        if (todos.length === 0) {
            const cfg = CARD_CONFIG[type];
            return `<div class="tm-empty">
                <i class="fas ${cfg.emptyIcon}"></i>
                <span>${cfg.emptyText}</span>
            </div>`;
        }
        return todos
            .map((t) => {
                const pr = PRIORITY_CONFIG[t.priority] || PRIORITY_CONFIG.medium;
                const st = STATUS_CONFIG[t.status] || STATUS_CONFIG.pending;
                const isSelected = t.id === this.selectedTodoId;
                const summary = getTriggerSummary(t);
                return `
            <div class="tm-item${isSelected ? ' tm-item-selected' : ''}" data-id="${escapeHtml(t.id)}" data-type="${type}">
                <div class="tm-item-icon" style="background:${pr.bg};color:${pr.color};">
                    <span class="tm-priority-dot ${pr.dot}"></span>
                </div>
                <div class="tm-item-body">
                    <div class="tm-item-title">${escapeHtml(t.title)}</div>
                    <div class="tm-item-desc">${escapeHtml(summary)}</div>
                    <div class="tm-item-meta">
                        <span class="tm-item-badge" style="background:${st.dot === 'tm-status-completed' ? '#F0FDF4' : st.dot === 'tm-status-in_progress' ? '#EFF6FF' : '#F5F5F7'};color:${st.dot === 'tm-status-completed' ? '#16A34A' : st.dot === 'tm-status-in_progress' ? '#2563EB' : '#8E8E93'};">
                            <span class="tm-status-dot ${st.dot}"></span>
                            ${st.label}
                        </span>
                        ${t.category ? `<span class="tm-item-badge" style="background:#F5F3FF;color:#7C3AED;">${escapeHtml(t.category)}</span>` : ''}
                    </div>
                </div>
            </div>`;
            })
            .join('');
    }

    private _refreshList() {
        const categories = categorizeTodos(this.globalTodos);
        for (const type of ['scheduled', 'cron', 'event'] as TriggerType[]) {
            const listEl = this.querySelector(`#tm-list-${type}`);
            const countEl = this.querySelector(`#tm-count-${type}`);
            if (listEl) listEl.innerHTML = this._renderTodoItems(categories[type], type);
            if (countEl) countEl.textContent = String(categories[type].length);
        }
        this._updateSummary();
    }

    private _updateSummary() {
        const el = this.querySelector('#tm-summary') as HTMLElement;
        if (!el) return;
        const total = this.globalTodos.length;
        const active = this.globalTodos.filter((t) => t.status !== 'completed').length;
        el.textContent = total === 0 ? '暂无任务' : `共 ${total} 个任务，${active} 个进行中`;
    }

    /* ═══════════════════════════
     *  EXPAND / COLLAPSE CARD
     * ═══════════════════════════ */

    private _toggleCardExpand(type: TriggerType) {
        const btn = this.querySelector(`[data-action="toggle-expand"][data-type="${type}"]`) as HTMLElement;

        if (this.expandedCard === type) {
            for (const t of ['scheduled', 'cron', 'event'] as TriggerType[]) {
                const card = this.querySelector(`#tm-card-${t}`) as HTMLElement;
                if (card) card.classList.remove('tm-card-collapsed', 'tm-card-expanded');
            }
            this.expandedCard = null;
            if (btn) {
                const icon = btn.querySelector('i');
                if (icon) icon.className = 'fas fa-expand';
                btn.title = '全屏';
            }
        } else {
            for (const t of ['scheduled', 'cron', 'event'] as TriggerType[]) {
                const card = this.querySelector(`#tm-card-${t}`) as HTMLElement;
                const otherBtn = this.querySelector(`[data-action="toggle-expand"][data-type="${t}"]`) as HTMLElement;
                if (!card) continue;
                if (t === type) {
                    card.classList.remove('tm-card-collapsed');
                    card.classList.add('tm-card-expanded');
                    if (otherBtn) {
                        const icon = otherBtn.querySelector('i');
                        if (icon) icon.className = 'fas fa-compress';
                        otherBtn.title = '恢复';
                    }
                } else {
                    card.classList.add('tm-card-collapsed');
                    card.classList.remove('tm-card-expanded');
                    if (otherBtn) {
                        const icon = otherBtn.querySelector('i');
                        if (icon) icon.className = 'fas fa-expand';
                        otherBtn.title = '全屏';
                    }
                }
            }
            this.expandedCard = type;
        }
    }

    /* ═══════════════════════════
     *  RIGHT PANEL: OPEN / CLOSE
     * ═══════════════════════════ */

    private _openDetail(todo: GlobalTodo) {
        this.selectedTodoId = todo.id;
        this.isEditing = false;
        this.isAddingNew = false;
        this._refreshList();
        this._renderDetail(todo);

        const right = this.querySelector('#tm-right') as HTMLElement;
        const resizer = this.querySelector('#tm-resizer') as HTMLElement;
        if (!right) return;

        right.style.display = 'flex';
        right.style.width = '0px';
        right.style.opacity = '0';
        right.style.overflow = 'hidden';
        if (resizer) resizer.style.display = '';

        requestAnimationFrame(() => {
            right.style.width = this.rightWidth + 'px';
            right.style.opacity = '1';
            right.classList.add('tm-right-open');
        });

        const onEnd = (e: TransitionEvent) => {
            if (e.propertyName !== 'width') return;
            right.removeEventListener('transitionend', onEnd);
            right.style.overflow = '';
        };
        right.addEventListener('transitionend', onEnd);
    }

    private _closeDetail() {
        this.selectedTodoId = null;
        this.isEditing = false;
        this.isAddingNew = false;
        this._refreshList();

        const right = this.querySelector('#tm-right') as HTMLElement;
        const resizer = this.querySelector('#tm-resizer') as HTMLElement;
        if (!right) return;

        this.rightWidth = parseInt(right.style.width) || DEFAULT_RIGHT_WIDTH;
        right.style.overflow = 'hidden';

        requestAnimationFrame(() => {
            right.style.width = '0px';
            right.style.opacity = '0';
            right.classList.remove('tm-right-open');
        });

        const onEnd = (e: TransitionEvent) => {
            if (e.propertyName !== 'width') return;
            right.removeEventListener('transitionend', onEnd);
            right.style.display = 'none';
            right.style.overflow = '';
            if (resizer) resizer.style.display = 'none';
        };
        right.addEventListener('transitionend', onEnd);
    }

    /* ═══════════════════════════
     *  RIGHT PANEL: DETAIL VIEW
     * ═══════════════════════════ */

    private _renderDetail(todo: GlobalTodo) {
        const scroll = this.querySelector('#tm-detail-scroll') as HTMLElement;
        const footer = this.querySelector('#tm-detail-footer') as HTMLElement;
        if (!scroll || !footer) return;

        const pr = PRIORITY_CONFIG[todo.priority] || PRIORITY_CONFIG.medium;
        const st = STATUS_CONFIG[todo.status] || STATUS_CONFIG.pending;
        const triggerType = todo.trigger?.type || 'manual';
        const cardCfg = CARD_CONFIG[triggerType as TriggerType] || CARD_CONFIG.event;

        scroll.innerHTML = `
        <div class="tm-detail-header">
            <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                    <div class="tm-card-icon" style="background:${cardCfg.iconBg};color:${cardCfg.iconColor};width:32px;height:32px;border-radius:9px;">
                        <i class="fas ${cardCfg.icon}" style="font-size:14px;"></i>
                    </div>
                    <span style="font-size:12px;color:#8E8E93;font-weight:500;">${cardCfg.label}</span>
                </div>
                <div class="tm-detail-title">${escapeHtml(todo.title)}</div>
            </div>
            <button class="tm-detail-close" id="tm-close-detail" title="关闭">
                <i class="fas fa-xmark"></i>
            </button>
        </div>

        <div class="tm-detail-body">
            <div class="tm-detail-section">
                <div class="tm-detail-section-title">任务内容</div>
                <div class="tm-detail-content">${escapeHtml(todo.content)}</div>
            </div>

            <div class="tm-detail-section">
                <div class="tm-detail-section-title">任务属性</div>
                <div class="tm-detail-attrs">
                    <span class="tm-detail-attr-label">状态</span>
                    <span class="tm-detail-attr-value" style="display:flex;align-items:center;gap:6px;">
                        <span class="tm-status-dot ${st.dot}"></span>
                        ${st.label}
                    </span>

                    <span class="tm-detail-attr-label">优先级</span>
                    <span class="tm-detail-attr-value" style="display:flex;align-items:center;gap:6px;">
                        <span class="tm-priority-dot ${pr.dot}"></span>
                        ${pr.label}
                    </span>

                    ${
                        todo.category
                            ? `
                    <span class="tm-detail-attr-label">分类</span>
                    <span class="tm-detail-attr-value">${escapeHtml(todo.category)}</span>
                    `
                            : ''
                    }

                    <span class="tm-detail-attr-label">触发方式</span>
                    <span class="tm-detail-attr-value">${escapeHtml(getTriggerSummary(todo))}</span>

                    ${
                        todo.trigger?.type === 'cron' && todo.trigger.cronExpression
                            ? `
                    <span class="tm-detail-attr-label">Cron 表达式</span>
                    <span class="tm-detail-attr-value" style="font-family:'Cascadia Code','SF Mono',monospace;font-size:12px;">${escapeHtml(todo.trigger.cronExpression)}</span>
                    `
                            : ''
                    }

                    ${
                        todo.trigger?.type === 'event'
                            ? `
                    <span class="tm-detail-attr-label">事件源</span>
                    <span class="tm-detail-attr-value">${escapeHtml(todo.trigger.bundleName || '-')}</span>
                    <span class="tm-detail-attr-label">事件名</span>
                    <span class="tm-detail-attr-value">${escapeHtml(todo.trigger.eventName || '-')}</span>
                    `
                            : ''
                    }

                    ${
                        todo.deliver
                            ? `
                    <span class="tm-detail-attr-label">投递目标</span>
                    <span class="tm-detail-attr-value">${escapeHtml(todo.deliver.channel)}:${escapeHtml(todo.deliver.accountId)} → ${escapeHtml(todo.deliver.recipientId)}</span>
                    `
                            : ''
                    }

                    <span class="tm-detail-attr-label">创建时间</span>
                    <span class="tm-detail-attr-value">${formatDate(todo.created_at)}</span>

                    <span class="tm-detail-attr-label">更新时间</span>
                    <span class="tm-detail-attr-value">${formatDate(todo.updated_at)}</span>

                    ${
                        todo.last_triggered_at
                            ? `
                    <span class="tm-detail-attr-label">上次触发</span>
                    <span class="tm-detail-attr-value">${formatDate(todo.last_triggered_at)}</span>
                    `
                            : ''
                    }

                    ${
                        todo.completed_at
                            ? `
                    <span class="tm-detail-attr-label">完成时间</span>
                    <span class="tm-detail-attr-value">${formatDate(todo.completed_at)}</span>
                    `
                            : ''
                    }
                </div>
            </div>
        </div>`;

        footer.style.display = 'flex';
        footer.innerHTML = `
        <button class="tm-btn" id="tm-btn-edit"><i class="fas fa-pen" style="font-size:12px;"></i> 编辑</button>
        <button class="tm-btn tm-btn-danger" id="tm-btn-delete"><i class="fas fa-trash-can" style="font-size:12px;"></i> 删除</button>
        <div style="flex:1;"></div>
        <button class="tm-btn tm-btn-primary" id="tm-btn-execute"><i class="fas fa-play" style="font-size:12px;"></i> 立即执行</button>`;

        this.querySelector('#tm-close-detail')?.addEventListener('click', () => this._closeDetail());
        this.querySelector('#tm-btn-edit')?.addEventListener('click', () => this._enterEditMode(todo));
        this.querySelector('#tm-btn-delete')?.addEventListener('click', () => this._confirmDelete(todo));
        this.querySelector('#tm-btn-execute')?.addEventListener('click', () => this._executeNow(todo));
    }

    /* ═══════════════════════════
     *  EDIT MODE (also used for Add)
     * ═══════════════════════════ */

    private async _enterEditMode(todo: GlobalTodo | null, addType?: TriggerType) {
        this.isEditing = true;
        this.isAddingNew = !todo;
        this.addingType = addType || null;

        if (!this._cachedEvents) {
            try {
                this._cachedEvents = await this._fetchAllEvents();
            } catch {
                this._cachedEvents = [];
            }
        }

        const scroll = this.querySelector('#tm-detail-scroll') as HTMLElement;
        const footer = this.querySelector('#tm-detail-footer') as HTMLElement;
        if (!scroll || !footer) return;

        const isNew = !todo;
        const title = isNew ? '' : todo.title;
        const content = isNew ? '' : todo.content;
        const priority = isNew ? 'medium' : todo.priority;
        const category = isNew ? '' : todo.category || '';
        const status = isNew ? 'pending' : todo.status;
        const triggerType = isNew ? addType || 'scheduled' : todo.trigger?.type || 'scheduled';

        scroll.innerHTML = `
        <div class="tm-detail-header">
            <div class="tm-detail-title">${isNew ? '新建任务' : '编辑任务'}</div>
            <button class="tm-detail-close" id="tm-edit-cancel-top" title="取消">
                <i class="fas fa-xmark"></i>
            </button>
        </div>
        <div class="tm-detail-body">
            <div class="tm-edit-field">
                <label class="tm-edit-label">标题</label>
                <input class="tm-edit-input" id="tm-edit-title" value="${escapeHtml(title)}" placeholder="任务标题" />
            </div>
            <div class="tm-edit-field">
                <label class="tm-edit-label">内容</label>
                <textarea class="tm-edit-textarea" id="tm-edit-content" rows="4" placeholder="详细的任务描述，将发送给 Agent 执行...">${escapeHtml(content)}</textarea>
            </div>
            <div class="tm-edit-field">
                <label class="tm-edit-label">优先级</label>
                <select class="tm-edit-select" id="tm-edit-priority">
                    <option value="low"${priority === 'low' ? ' selected' : ''}>低</option>
                    <option value="medium"${priority === 'medium' ? ' selected' : ''}>中</option>
                    <option value="high"${priority === 'high' ? ' selected' : ''}>高</option>
                </select>
            </div>
            <div class="tm-edit-field">
                <label class="tm-edit-label">分类</label>
                <input class="tm-edit-input" id="tm-edit-category" value="${escapeHtml(category)}" placeholder="如 bug, feature, idea（可选）" />
            </div>
            <div class="tm-edit-field">
                <label class="tm-edit-label">状态</label>
                <select class="tm-edit-select" id="tm-edit-status">
                    <option value="pending"${status === 'pending' ? ' selected' : ''}>待执行</option>
                    <option value="in_progress"${status === 'in_progress' ? ' selected' : ''}>执行中</option>
                    <option value="completed"${status === 'completed' ? ' selected' : ''}>已完成</option>
                </select>
            </div>
            <div class="tm-edit-field">
                <label class="tm-edit-label">触发类型</label>
                <select class="tm-edit-select" id="tm-edit-trigger-type">
                    <option value="scheduled"${triggerType === 'scheduled' ? ' selected' : ''}>定时（一次性）</option>
                    <option value="cron"${triggerType === 'cron' ? ' selected' : ''}>周期（Cron）</option>
                    <option value="event"${triggerType === 'event' ? ' selected' : ''}>事件触发</option>
                </select>
            </div>
            <div id="tm-trigger-fields"></div>
        </div>`;

        this._renderTriggerFields(triggerType, todo);

        footer.style.display = 'flex';
        footer.innerHTML = `
        <button class="tm-btn" id="tm-edit-cancel">取消</button>
        <div style="flex:1;"></div>
        <button class="tm-btn tm-btn-primary" id="tm-edit-save"><i class="fas fa-check" style="font-size:12px;"></i> ${isNew ? '创建' : '保存'}</button>`;

        const cancelHandler = () => {
            if (isNew) this._closeDetail();
            else {
                this.isEditing = false;
                this._renderDetail(todo!);
            }
        };
        this.querySelector('#tm-edit-cancel')?.addEventListener('click', cancelHandler);
        this.querySelector('#tm-edit-cancel-top')?.addEventListener('click', cancelHandler);
        this.querySelector('#tm-edit-save')?.addEventListener('click', () => this._saveEdit(todo));

        this.querySelector('#tm-edit-trigger-type')?.addEventListener('change', (e) => {
            const sel = (e.target as HTMLSelectElement).value;
            this._renderTriggerFields(sel, null);
        });
    }

    private _renderTriggerFields(type: string, existingTodo: GlobalTodo | null) {
        const container = this.querySelector('#tm-trigger-fields') as HTMLElement;
        if (!container) return;

        switch (type) {
            case 'scheduled': {
                this._renderDateTimePicker(container, existingTodo);
                break;
            }
            case 'cron': {
                this._renderCronBuilder(container, existingTodo);
                break;
            }
            case 'event': {
                this._renderEventSelector(container, existingTodo);
                break;
            }
            default:
                container.innerHTML = '';
        }
    }

    /* ═══════════════════════════
     *  CUSTOM DATETIME PICKER
     * ═══════════════════════════ */

    private _renderDateTimePicker(container: HTMLElement, existingTodo: GlobalTodo | null) {
        const now = new Date();
        if (existingTodo?.trigger?.type === 'scheduled' && existingTodo.trigger.triggerAt) {
            try {
                const d = new Date(existingTodo.trigger.triggerAt);
                this._dtYear = d.getFullYear();
                this._dtMonth = d.getMonth() + 1;
                this._dtDay = d.getDate();
                this._dtHour = d.getHours();
                this._dtMinute = d.getMinutes();
            } catch {
                this._dtYear = now.getFullYear();
                this._dtMonth = now.getMonth() + 1;
                this._dtDay = now.getDate();
                this._dtHour = now.getHours();
                this._dtMinute = 0;
            }
        } else {
            this._dtYear = now.getFullYear();
            this._dtMonth = now.getMonth() + 1;
            this._dtDay = now.getDate();
            this._dtHour = now.getHours();
            this._dtMinute = 0;
        }
        this._dtViewYear = this._dtYear;
        this._dtViewMonth = this._dtMonth;
        this._dtPanelOpen = true;

        container.innerHTML = `<div class="tm-edit-field">
            <label class="tm-edit-label">触发时间</label>
            <div class="tm-dt-wrapper" id="tm-dt-wrapper">
                <div class="tm-dt-display" id="tm-dt-display">
                    <span class="tm-dt-display-text" id="tm-dt-display-text"></span>
                    <i class="fa-solid fa-calendar-days tm-dt-display-icon"></i>
                </div>
                <div class="tm-dt-panel open" id="tm-dt-panel">
                    <div class="tm-dt-cal-header">
                        <span class="tm-dt-cal-title" id="tm-dt-cal-title"></span>
                        <div class="tm-dt-cal-nav">
                            <button class="tm-dt-cal-nav-btn" id="tm-dt-prev-month" type="button"><i class="fa-solid fa-chevron-left" style="font-size:10px;"></i></button>
                            <button class="tm-dt-cal-nav-btn" id="tm-dt-next-month" type="button"><i class="fa-solid fa-chevron-right" style="font-size:10px;"></i></button>
                        </div>
                    </div>
                    <div class="tm-dt-cal-weekdays">
                        <span class="tm-dt-cal-wd">一</span>
                        <span class="tm-dt-cal-wd">二</span>
                        <span class="tm-dt-cal-wd">三</span>
                        <span class="tm-dt-cal-wd">四</span>
                        <span class="tm-dt-cal-wd">五</span>
                        <span class="tm-dt-cal-wd">六</span>
                        <span class="tm-dt-cal-wd">日</span>
                    </div>
                    <div class="tm-dt-cal-days" id="tm-dt-cal-days"></div>
                    <div class="tm-dt-time-row">
                        <span class="tm-dt-time-label">时间</span>
                        <select class="tm-dt-time-select" id="tm-dt-hour"></select>
                        <span class="tm-dt-time-colon">:</span>
                        <select class="tm-dt-time-select" id="tm-dt-minute"></select>
                    </div>
                    <div class="tm-dt-footer">
                        <button class="tm-dt-today-btn" id="tm-dt-today" type="button">今天</button>
                        <button class="tm-dt-confirm-btn" id="tm-dt-confirm" type="button">确认</button>
                    </div>
                </div>
            </div>
        </div>`;

        this._buildTimeSelects();
        this._renderCalendar();
        this._updateDtDisplay();
        this._bindDtEvents();
    }

    private _buildTimeSelects() {
        const hourSel = this.querySelector('#tm-dt-hour') as HTMLSelectElement;
        const minSel = this.querySelector('#tm-dt-minute') as HTMLSelectElement;
        if (!hourSel || !minSel) return;

        let hourHtml = '';
        for (let h = 0; h < 24; h++) {
            const sel = h === this._dtHour ? ' selected' : '';
            hourHtml += `<option value="${h}"${sel}>${String(h).padStart(2, '0')}</option>`;
        }
        hourSel.innerHTML = hourHtml;

        let minHtml = '';
        for (let m = 0; m < 60; m += 5) {
            const sel = m === this._dtMinute ? ' selected' : '';
            minHtml += `<option value="${m}"${sel}>${String(m).padStart(2, '0')}</option>`;
        }
        const minuteRounded = Math.round(this._dtMinute / 5) * 5;
        if (minuteRounded !== this._dtMinute) {
            this._dtMinute = minuteRounded >= 60 ? 55 : minuteRounded;
        }
        minSel.innerHTML = minHtml;
    }

    private _renderCalendar() {
        const grid = this.querySelector('#tm-dt-cal-days') as HTMLElement;
        const title = this.querySelector('#tm-dt-cal-title') as HTMLElement;
        if (!grid || !title) return;

        title.textContent = `${this._dtViewYear}年${this._dtViewMonth}月`;

        const firstDay = new Date(this._dtViewYear, this._dtViewMonth - 1, 1);
        const lastDay = new Date(this._dtViewYear, this._dtViewMonth, 0);
        const daysInMonth = lastDay.getDate();
        let startWeekday = firstDay.getDay();
        if (startWeekday === 0) startWeekday = 7;

        const today = new Date();
        const todayY = today.getFullYear();
        const todayM = today.getMonth() + 1;
        const todayD = today.getDate();

        let html = '';
        const prevLast = new Date(this._dtViewYear, this._dtViewMonth - 1, 0).getDate();
        for (let i = startWeekday - 1; i > 0; i--) {
            html += `<button class="tm-dt-cal-day other-month" data-day="${prevLast - i + 1}" data-offset="-1" type="button">${prevLast - i + 1}</button>`;
        }
        for (let d = 1; d <= daysInMonth; d++) {
            const classes: string[] = [];
            if (todayY === this._dtViewYear && todayM === this._dtViewMonth && todayD === d) classes.push('today');
            if (this._dtYear === this._dtViewYear && this._dtMonth === this._dtViewMonth && this._dtDay === d)
                classes.push('selected');
            html += `<button class="tm-dt-cal-day${classes.length ? ' ' + classes.join(' ') : ''}" data-day="${d}" data-offset="0" type="button">${d}</button>`;
        }
        const totalCells = startWeekday - 1 + daysInMonth;
        const remainder = totalCells % 7;
        if (remainder > 0) {
            for (let d = 1; d <= 7 - remainder; d++) {
                html += `<button class="tm-dt-cal-day other-month" data-day="${d}" data-offset="1" type="button">${d}</button>`;
            }
        }

        grid.innerHTML = html;
    }

    private _updateDtDisplay() {
        const text = this.querySelector('#tm-dt-display-text') as HTMLElement;
        if (!text) return;
        if (this._dtYear && this._dtMonth && this._dtDay) {
            const pad = (n: number) => String(n).padStart(2, '0');
            text.textContent = `${this._dtYear}年${this._dtMonth}月${this._dtDay}日 ${pad(this._dtHour)}:${pad(this._dtMinute)}`;
            text.classList.remove('tm-dt-placeholder');
        } else {
            text.textContent = '点击选择日期和时间';
            text.classList.add('tm-dt-placeholder');
        }
    }

    private _bindDtEvents() {
        const prevBtn = this.querySelector('#tm-dt-prev-month') as HTMLElement;
        const nextBtn = this.querySelector('#tm-dt-next-month') as HTMLElement;
        const grid = this.querySelector('#tm-dt-cal-days') as HTMLElement;
        const hourSel = this.querySelector('#tm-dt-hour') as HTMLSelectElement;
        const minSel = this.querySelector('#tm-dt-minute') as HTMLSelectElement;
        const todayBtn = this.querySelector('#tm-dt-today') as HTMLElement;
        const confirmBtn = this.querySelector('#tm-dt-confirm') as HTMLElement;
        const display = this.querySelector('#tm-dt-display') as HTMLElement;
        const panel = this.querySelector('#tm-dt-panel') as HTMLElement;

        prevBtn?.addEventListener('click', () => {
            this._dtViewMonth--;
            if (this._dtViewMonth < 1) {
                this._dtViewMonth = 12;
                this._dtViewYear--;
            }
            this._renderCalendar();
        });
        nextBtn?.addEventListener('click', () => {
            this._dtViewMonth++;
            if (this._dtViewMonth > 12) {
                this._dtViewMonth = 1;
                this._dtViewYear++;
            }
            this._renderCalendar();
        });

        grid?.addEventListener('click', (e) => {
            const btn = (e.target as HTMLElement).closest('.tm-dt-cal-day') as HTMLElement;
            if (!btn) return;
            const day = parseInt(btn.dataset.day!, 10);
            const offset = parseInt(btn.dataset.offset!, 10);
            if (offset === -1) {
                this._dtViewMonth--;
                if (this._dtViewMonth < 1) {
                    this._dtViewMonth = 12;
                    this._dtViewYear--;
                }
            } else if (offset === 1) {
                this._dtViewMonth++;
                if (this._dtViewMonth > 12) {
                    this._dtViewMonth = 1;
                    this._dtViewYear++;
                }
            }
            this._dtYear = this._dtViewYear;
            this._dtMonth = this._dtViewMonth;
            this._dtDay = day;
            this._renderCalendar();
            this._updateDtDisplay();
        });

        hourSel?.addEventListener('change', () => {
            this._dtHour = parseInt(hourSel.value, 10);
            this._updateDtDisplay();
        });
        minSel?.addEventListener('change', () => {
            this._dtMinute = parseInt(minSel.value, 10);
            this._updateDtDisplay();
        });

        todayBtn?.addEventListener('click', () => {
            const now = new Date();
            this._dtYear = now.getFullYear();
            this._dtMonth = now.getMonth() + 1;
            this._dtDay = now.getDate();
            this._dtViewYear = this._dtYear;
            this._dtViewMonth = this._dtMonth;
            this._renderCalendar();
            this._updateDtDisplay();
        });

        confirmBtn?.addEventListener('click', () => {
            if (panel) {
                panel.classList.remove('open');
                this._dtPanelOpen = false;
            }
        });

        display?.addEventListener('click', () => {
            if (panel) {
                this._dtPanelOpen = !this._dtPanelOpen;
                panel.classList.toggle('open', this._dtPanelOpen);
                if (this._dtPanelOpen) {
                    this._dtViewYear = this._dtYear || new Date().getFullYear();
                    this._dtViewMonth = this._dtMonth || new Date().getMonth() + 1;
                    this._renderCalendar();
                }
            }
        });
    }

    /* ═══════════════════════════
     *  CRON BUILDER UI
     * ═══════════════════════════ */

    private _renderCronBuilder(container: HTMLElement, existingTodo: GlobalTodo | null) {
        let mode = 'daily';
        let hour = 9;
        let minute = 0;
        let selectedDows = [1, 2, 3, 4, 5]; // Mon-Fri
        let dom = '1';

        if (existingTodo?.trigger?.type === 'cron' && existingTodo.trigger.cronExpression) {
            const parsed = this._parseCronForUI(existingTodo.trigger.cronExpression);
            mode = parsed.mode;
            hour = parsed.hour;
            minute = parsed.minute;
            selectedDows = parsed.selectedDows;
            dom = parsed.dom;
        }

        const hourOptions = Array.from(
            { length: 24 },
            (_, i) => `<option value="${i}"${i === hour ? ' selected' : ''}>${String(i).padStart(2, '0')}</option>`
        ).join('');
        const minOptions = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
            .map((m) => `<option value="${m}"${m === minute ? ' selected' : ''}>${String(m).padStart(2, '0')}</option>`)
            .join('');
        const domOptions = Array.from(
            { length: 31 },
            (_, i) => `<option value="${i + 1}"${String(i + 1) === dom ? ' selected' : ''}>${i + 1}日</option>`
        ).join('');

        container.innerHTML = `
        <div class="tm-edit-field">
            <label class="tm-edit-label">重复频率</label>
            <div class="tm-cron-row">
                <select class="tm-cron-select" id="tm-cron-mode" style="flex:1;">
                    <option value="daily"${mode === 'daily' ? ' selected' : ''}>每天</option>
                    <option value="weekly"${mode === 'weekly' ? ' selected' : ''}>每周指定日</option>
                    <option value="monthly"${mode === 'monthly' ? ' selected' : ''}>每月指定日</option>
                </select>
            </div>

            <div id="tm-cron-dow-area" style="${mode === 'weekly' ? '' : 'display:none;'}">
                <label class="tm-edit-label" style="margin-top:8px;">选择日期</label>
                <div class="tm-cron-dow-grid" id="tm-cron-dow-grid">
                    ${DOW_LABELS.map((label, i) => `<button type="button" class="tm-cron-dow-btn${selectedDows.includes(i) ? ' active' : ''}" data-dow="${i}">${label}</button>`).join('')}
                </div>
            </div>

            <div id="tm-cron-dom-area" style="${mode === 'monthly' ? '' : 'display:none;'}">
                <label class="tm-edit-label" style="margin-top:8px;">选择日期</label>
                <div class="tm-cron-row">
                    <select class="tm-cron-select" id="tm-cron-dom">${domOptions}</select>
                </div>
            </div>

            <label class="tm-edit-label" style="margin-top:10px;">执行时间</label>
            <div class="tm-cron-row">
                <select class="tm-cron-select" id="tm-cron-hour">${hourOptions}</select>
                <span style="color:#8E8E93;">:</span>
                <select class="tm-cron-select" id="tm-cron-minute">${minOptions}</select>
            </div>

            <div class="tm-cron-preview" id="tm-cron-preview"></div>
        </div>`;

        this._updateCronPreview();
        this._bindCronEvents();
    }

    private _parseCronForUI(expr: string): {
        mode: string;
        hour: number;
        minute: number;
        selectedDows: number[];
        dom: string;
    } {
        const fields = expr.trim().split(/\s+/);
        if (fields.length !== 5) return { mode: 'daily', hour: 9, minute: 0, selectedDows: [1, 2, 3, 4, 5], dom: '1' };
        const [cronMin, cronHour, cronDom, , cronDow] = fields;

        const offsetMin = -new Date().getTimezoneOffset();
        let lm = parseInt(cronMin, 10) + (offsetMin % 60);
        let lh = parseInt(cronHour, 10) + Math.floor(offsetMin / 60);
        let dayShift = 0;
        if (lm >= 60) {
            lh++;
            lm -= 60;
        }
        if (lm < 0) {
            lh--;
            lm += 60;
        }
        if (lh >= 24) {
            lh -= 24;
            dayShift = 1;
        }
        if (lh < 0) {
            lh += 24;
            dayShift = -1;
        }

        let mode = 'daily';
        let selectedDows = [1, 2, 3, 4, 5];
        let dom = '1';

        if (cronDow !== '*') {
            mode = 'weekly';
            selectedDows = cronDow.split(',').map((d) => {
                const v = parseInt(d.trim(), 10);
                return (((v + dayShift) % 7) + 7) % 7;
            });
        } else if (cronDom !== '*') {
            mode = 'monthly';
            dom = cronDom;
        }

        return { mode, hour: isNaN(lh) ? 9 : lh, minute: isNaN(lm) ? 0 : lm, selectedDows, dom };
    }

    private _bindCronEvents() {
        const modeEl = this.querySelector('#tm-cron-mode') as HTMLSelectElement;
        const dowGrid = this.querySelector('#tm-cron-dow-grid') as HTMLElement;

        modeEl?.addEventListener('change', () => {
            const mode = modeEl.value;
            const dowArea = this.querySelector('#tm-cron-dow-area') as HTMLElement;
            const domArea = this.querySelector('#tm-cron-dom-area') as HTMLElement;
            if (dowArea) dowArea.style.display = mode === 'weekly' ? '' : 'none';
            if (domArea) domArea.style.display = mode === 'monthly' ? '' : 'none';
            this._updateCronPreview();
        });

        dowGrid?.addEventListener('click', (e) => {
            const btn = (e.target as HTMLElement).closest('.tm-cron-dow-btn') as HTMLElement;
            if (!btn) return;
            btn.classList.toggle('active');
            this._updateCronPreview();
        });

        for (const id of ['#tm-cron-hour', '#tm-cron-minute', '#tm-cron-dom']) {
            this.querySelector(id)?.addEventListener('change', () => this._updateCronPreview());
        }
    }

    private _getCronFromUI(): string {
        const mode = (this.querySelector('#tm-cron-mode') as HTMLSelectElement)?.value || 'daily';
        const hour = parseInt((this.querySelector('#tm-cron-hour') as HTMLSelectElement)?.value || '9');
        const minute = parseInt((this.querySelector('#tm-cron-minute') as HTMLSelectElement)?.value || '0');
        const dom = (this.querySelector('#tm-cron-dom') as HTMLSelectElement)?.value || '1';
        const dowBtns = this.querySelectorAll('#tm-cron-dow-grid .tm-cron-dow-btn.active');
        const selectedDows = Array.from(dowBtns).map((b) => parseInt((b as HTMLElement).dataset.dow || '0'));
        return buildCronFromUI(mode, hour, minute, selectedDows, dom, '*');
    }

    private _updateCronPreview() {
        const previewEl = this.querySelector('#tm-cron-preview') as HTMLElement;
        if (!previewEl) return;
        const cron = this._getCronFromUI();
        previewEl.textContent = `${describeCronLocal(cron)}（${cron}）`;
    }

    /* ═══════════════════════════
     *  EVENT SELECTOR UI
     * ═══════════════════════════ */

    private _renderEventSelector(container: HTMLElement, existingTodo: GlobalTodo | null) {
        const events = this._cachedEvents || [];
        const curBundle = existingTodo?.trigger?.type === 'event' ? existingTodo.trigger.bundleName || '' : '';
        const curEvent = existingTodo?.trigger?.type === 'event' ? existingTodo.trigger.eventName || '' : '';

        // Group by bundleName
        const appMap = new Map<
            string,
            { appName: string; events: { eventName: string; eventDescription: string }[] }
        >();
        for (const ev of events) {
            if (!appMap.has(ev.bundleName)) {
                appMap.set(ev.bundleName, { appName: ev.appName, events: [] });
            }
            appMap.get(ev.bundleName)!.events.push({ eventName: ev.eventName, eventDescription: ev.eventDescription });
        }

        const bundleOptions = Array.from(appMap.entries())
            .map(
                ([bn, info]) =>
                    `<option value="${escapeHtml(bn)}"${bn === curBundle ? ' selected' : ''}>${escapeHtml(info.appName)}（${escapeHtml(bn)}）</option>`
            )
            .join('');

        container.innerHTML = `
        <div class="tm-edit-field">
            <label class="tm-edit-label">事件源应用</label>
            <select class="tm-edit-select" id="tm-edit-event-bundle">
                <option value="">请选择应用...</option>
                ${bundleOptions}
            </select>
        </div>
        <div class="tm-edit-field">
            <label class="tm-edit-label">事件名称</label>
            <select class="tm-edit-select" id="tm-edit-event-name">
                <option value="">请先选择应用...</option>
            </select>
        </div>`;

        // If there's a current bundle selected, populate events
        if (curBundle) this._updateEventNameOptions(curBundle, curEvent);

        this.querySelector('#tm-edit-event-bundle')?.addEventListener('change', (e) => {
            const bn = (e.target as HTMLSelectElement).value;
            this._updateEventNameOptions(bn, '');
        });
    }

    private _updateEventNameOptions(bundleName: string, selectedEvent: string) {
        const eventSelect = this.querySelector('#tm-edit-event-name') as HTMLSelectElement;
        if (!eventSelect) return;

        const events = this._cachedEvents || [];
        const bundleEvents = events.filter((e) => e.bundleName === bundleName);

        if (bundleEvents.length === 0) {
            eventSelect.innerHTML = '<option value="">该应用暂无已注册事件</option>';
            return;
        }

        eventSelect.innerHTML =
            '<option value="">请选择事件...</option>' +
            bundleEvents
                .map(
                    (e) =>
                        `<option value="${escapeHtml(e.eventName)}"${e.eventName === selectedEvent ? ' selected' : ''}>${escapeHtml(e.eventName)} — ${escapeHtml(e.eventDescription)}</option>`
                )
                .join('');
    }

    /* ═══════════════════════════
     *  SAVE EDIT
     * ═══════════════════════════ */

    private async _saveEdit(existingTodo: GlobalTodo | null) {
        const title = (this.querySelector('#tm-edit-title') as HTMLInputElement)?.value?.trim();
        const content = (this.querySelector('#tm-edit-content') as HTMLTextAreaElement)?.value?.trim();
        const priority = (this.querySelector('#tm-edit-priority') as HTMLSelectElement)?.value || 'medium';
        const category = (this.querySelector('#tm-edit-category') as HTMLInputElement)?.value?.trim() || undefined;
        const status = (this.querySelector('#tm-edit-status') as HTMLSelectElement)?.value || 'pending';
        const triggerType = (this.querySelector('#tm-edit-trigger-type') as HTMLSelectElement)?.value;

        if (!title || !content) {
            this._flashInputError('#tm-edit-title', !title);
            this._flashInputError('#tm-edit-content', !content);
            return;
        }

        let trigger: any;
        switch (triggerType) {
            case 'scheduled': {
                if (this._dtYear && this._dtMonth && this._dtDay) {
                    const d = new Date(this._dtYear, this._dtMonth - 1, this._dtDay, this._dtHour, this._dtMinute);
                    trigger = { type: 'scheduled', triggerAt: d.toISOString() };
                }
                break;
            }
            case 'cron': {
                const cronVal = this._getCronFromUI();
                if (cronVal) trigger = { type: 'cron', cronExpression: cronVal };
                break;
            }
            case 'event': {
                const bundleName = (this.querySelector('#tm-edit-event-bundle') as HTMLSelectElement)?.value;
                const eventName = (this.querySelector('#tm-edit-event-name') as HTMLSelectElement)?.value;
                if (bundleName && eventName) trigger = { type: 'event', bundleName, eventName };
                break;
            }
        }

        try {
            const saveBtn = this.querySelector('#tm-edit-save') as HTMLButtonElement;
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.textContent = '保存中...';
            }

            if (existingTodo) {
                await window.applicationAPI.call('updateGlobalTodo', existingTodo.id, {
                    title,
                    content,
                    priority,
                    category,
                    status,
                    trigger
                });
            } else {
                await window.applicationAPI.call('addGlobalTodo', title, content, priority, category, trigger);
            }

            this.isEditing = false;
            this.isAddingNew = false;
            await this.loadData();

            if (existingTodo) {
                const updated = this.globalTodos.find((t) => t.id === existingTodo.id);
                if (updated) {
                    this.selectedTodoId = updated.id;
                    this._renderDetail(updated);
                }
            } else {
                this._closeDetail();
            }
        } catch (err: any) {
            const saveBtn = this.querySelector('#tm-edit-save') as HTMLButtonElement;
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerHTML = '<i class="fas fa-check" style="font-size:12px;"></i> 重试';
            }
            console.error('Save failed:', err);
        }
    }

    private _flashInputError(selector: string, shouldFlash: boolean) {
        if (!shouldFlash) return;
        const el = this.querySelector(selector) as HTMLElement;
        if (!el) return;
        el.style.borderColor = '#FF3B30';
        el.style.boxShadow = '0 0 0 3px rgba(255,59,48,0.15)';
        setTimeout(() => {
            el.style.borderColor = '';
            el.style.boxShadow = '';
        }, 1500);
    }

    /* ═══════════════════════════
     *  ADD NEW
     * ═══════════════════════════ */

    private _addNew(type: TriggerType) {
        const right = this.querySelector('#tm-right') as HTMLElement;
        const isOpen = right && right.style.display !== 'none' && parseInt(right.style.width) > 0;

        if (isOpen) {
            this.selectedTodoId = '__new__';
            this._enterEditMode(null, type);
        } else {
            this.selectedTodoId = '__new__';
            const rightEl = this.querySelector('#tm-right') as HTMLElement;
            const resizer = this.querySelector('#tm-resizer') as HTMLElement;
            if (!rightEl) return;

            rightEl.style.display = 'flex';
            rightEl.style.width = '0px';
            rightEl.style.opacity = '0';
            rightEl.style.overflow = 'hidden';
            if (resizer) resizer.style.display = '';

            requestAnimationFrame(() => {
                rightEl.style.width = this.rightWidth + 'px';
                rightEl.style.opacity = '1';
                rightEl.classList.add('tm-right-open');
            });

            const onEnd = (e: TransitionEvent) => {
                if (e.propertyName !== 'width') return;
                rightEl.removeEventListener('transitionend', onEnd);
                rightEl.style.overflow = '';
                this._enterEditMode(null, type);
            };
            rightEl.addEventListener('transitionend', onEnd);
        }
    }

    /* ═══════════════════════════
     *  DELETE
     * ═══════════════════════════ */

    private async _confirmDelete(todo: GlobalTodo) {
        const overlay = document.createElement('div');
        overlay.className = 'tm-modal-overlay';
        overlay.innerHTML = `
        <div class="tm-modal-card">
            <div class="tm-modal-header">
                <div class="tm-modal-icon" style="background:#FEF2F2;color:#DC2626;">
                    <i class="fas fa-trash-can"></i>
                </div>
                <div class="tm-modal-title">删除任务</div>
            </div>
            <div class="tm-modal-message">
                确定要删除任务「<b>${escapeHtml(todo.title)}</b>」吗？此操作不可撤销。
            </div>
            <div class="tm-modal-footer">
                <button class="tm-modal-btn tm-modal-btn-cancel" id="tm-modal-cancel">取消</button>
                <button class="tm-modal-btn tm-modal-btn-danger" id="tm-modal-confirm">删除</button>
            </div>
        </div>`;

        document.body.appendChild(overlay);

        const close = (confirmed: boolean) => {
            overlay.classList.add('tm-modal-closing');
            setTimeout(() => {
                overlay.remove();
                if (confirmed) this._doDelete(todo);
            }, 180);
        };

        overlay.querySelector('#tm-modal-cancel')?.addEventListener('click', () => close(false));
        overlay.querySelector('#tm-modal-confirm')?.addEventListener('click', () => close(true));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(false);
        });
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', onKey);
                close(false);
            }
        };
        document.addEventListener('keydown', onKey);
    }

    private async _doDelete(todo: GlobalTodo) {
        try {
            await window.applicationAPI.call('deleteGlobalTodo', todo.id);
            this._closeDetail();
            await this.loadData();
        } catch (err: any) {
            console.error('Delete failed:', err);
        }
    }

    /* ═══════════════════════════
     *  EXECUTE NOW
     * ═══════════════════════════ */

    private async _executeNow(todo: GlobalTodo) {
        try {
            const btn = this.querySelector('#tm-btn-execute') as HTMLButtonElement;
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:12px;"></i> 触发中...';
            }
            await window.applicationAPI.callMainWorld('triggerGlobalTodoNowFromUI', todo.id);
            if (btn) {
                btn.innerHTML = '<i class="fas fa-check" style="font-size:12px;color:#34C759;"></i> 已触发';
                setTimeout(() => {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-play" style="font-size:12px;"></i> 立即执行';
                }, 2000);
            }
        } catch (err: any) {
            const btn = this.querySelector('#tm-btn-execute') as HTMLButtonElement;
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-play" style="font-size:12px;"></i> 立即执行';
            }
            console.error('Execute failed:', err);
        }
    }

    /* ═══════════════════════════
     *  RESIZER
     * ═══════════════════════════ */

    private _initResize() {
        const resizer = this.querySelector('#tm-resizer') as HTMLElement;
        if (!resizer) return;
        resizer.addEventListener('mousedown', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            this._startResize();
        });
    }

    private _startResize() {
        if (this._isResizing) return;
        this._isResizing = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        this._boundMouseMove = (e: MouseEvent) => this._onResizeMove(e);
        this._boundMouseUp = () => this._stopResize();
        document.addEventListener('mousemove', this._boundMouseMove);
        document.addEventListener('mouseup', this._boundMouseUp);
    }

    private _onResizeMove(e: MouseEvent) {
        if (!this._isResizing) return;
        e.preventDefault();
        if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
        this._resizeRaf = requestAnimationFrame(() => {
            const row = this.querySelector('.tm-content-row') as HTMLElement;
            const right = this.querySelector('#tm-right') as HTMLElement;
            if (!row || !right) return;
            const rect = row.getBoundingClientRect();
            const newWidth = rect.right - e.clientX;
            if (newWidth < MIN_RIGHT_WIDTH || newWidth > rect.width * 0.65) return;
            right.style.width = newWidth + 'px';
            right.style.transition = 'none';
            this.rightWidth = newWidth;
        });
    }

    private _stopResize() {
        if (!this._isResizing) return;
        this._isResizing = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (this._boundMouseMove) document.removeEventListener('mousemove', this._boundMouseMove);
        if (this._boundMouseUp) document.removeEventListener('mouseup', this._boundMouseUp);
        const right = this.querySelector('#tm-right') as HTMLElement;
        if (right) right.style.transition = '';
    }

    /* ═══════════════════════════
     *  EVENT BINDINGS
     * ═══════════════════════════ */

    private _bindEvents() {
        this.querySelector('#tm-refresh-btn')?.addEventListener('click', () => this.loadData());

        this.querySelector('#tm-cards')?.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            const btn = target.closest('[data-action]') as HTMLElement;
            if (btn) {
                const action = btn.dataset.action;
                const type = btn.dataset.type as TriggerType;
                if (action === 'toggle-expand' && type) this._toggleCardExpand(type);
                else if (action === 'add' && type) this._addNew(type);
                return;
            }
            const item = target.closest('.tm-item') as HTMLElement;
            if (item) {
                const id = item.dataset.id;
                if (!id) return;
                const todo = this.globalTodos.find((t) => t.id === id);
                if (todo) this._openDetail(todo);
            }
        });

        this._initResize();
    }

    /* ═══════════════════════════
     *  DATA
     * ═══════════════════════════ */

    async loadData() {
        try {
            const result = await window.applicationAPI.call('listGlobalTodos', 'all');
            if (Array.isArray(result)) {
                this.globalTodos = result;
            } else if (typeof result === 'string') {
                const data = JSON.parse(result);
                this.globalTodos = Array.isArray(data) ? data : (data.todos ?? []);
            } else if (result && typeof result === 'object') {
                this.globalTodos = result.todos ?? [];
            }
            this._refreshList();
        } catch (error: any) {
            this.globalTodos = [];
            this._refreshList();
            console.error('loadData failed:', error);
        }
    }
}

customElements.define('todomgr-entry-widget', TodoMgrEntryWidget);
