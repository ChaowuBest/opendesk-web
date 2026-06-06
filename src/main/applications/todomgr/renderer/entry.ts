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
import { escapeHtml } from '../../../../common/utils/escape.js';
import type { TodoTemplate } from '../templates.js';

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
    enabled?: boolean;
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
    --tm-bg: #FAFAFA;
    --tm-surface: #fff;
    --tm-surface-muted: #F5F5F7;
    --tm-surface-hover: #F9F9FB;
    --tm-surface-pressed: #F0F0F5;
    --tm-border: #F0F0F0;
    --tm-border-strong: #E5E5EA;
    --tm-text: #1d1d1f;
    --tm-text-secondary: #3C3C43;
    --tm-text-muted: #8E8E93;
    --tm-text-disabled: #C7C7CC;
    --tm-accent: #3B82F6;
    --tm-accent-hover: #2563EB;
    --tm-accent-soft: #EFF6FF;
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
html[data-theme='dark'] .tm-root {
    --tm-bg: var(--od-bg, #1e1e1e);
    --tm-surface: var(--od-bg-elevated, #252526);
    --tm-surface-muted: var(--od-bg-muted, #2d2d30);
    --tm-surface-hover: var(--od-bg-muted, #2d2d30);
    --tm-surface-pressed: var(--od-bg-subtle, #333333);
    --tm-border: var(--od-border, rgba(255,255,255,0.12));
    --tm-border-strong: var(--od-border-strong, rgba(255,255,255,0.2));
    --tm-text: var(--od-text, #e4e4e4);
    --tm-text-secondary: var(--od-text, #e4e4e4);
    --tm-text-muted: var(--od-text-muted, #ababab);
    --tm-text-disabled: var(--od-text-disabled, #787878);
    --tm-accent: var(--od-accent, #60a5fa);
    --tm-accent-hover: #4b8fe8;
    --tm-accent-soft: rgba(96, 165, 250, 0.14);
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
    overflow-y: auto;
}
.tm-left::-webkit-scrollbar { width: 5px; }
.tm-left::-webkit-scrollbar-track { background: transparent; }
.tm-left::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.08); border-radius: 4px; }
.tm-left::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.15); }

/* ---- Section headers ---- */
.tm-section {
    padding: 20px 24px 0;
}
.tm-section-title {
    font-size: 13px;
    font-weight: 700;
    color: #1d1d1f;
    margin-bottom: 12px;
}

/* ---- Template recommendation area ---- */
.tm-templates-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 10px;
    padding: 0 24px 8px;
}
.tm-tpl-card {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 12px 14px;
    border-radius: 12px;
    background: #fff;
    border: 1px solid #EBEBEB;
    cursor: pointer;
    transition: all 0.15s;
    min-height: 80px;
}
.tm-tpl-card:hover {
    background: #F5F5F7;
    border-color: #D1D1D6;
    box-shadow: 0 2px 8px rgba(0,0,0,0.04);
}
.tm-tpl-card:active { transform: scale(0.98); }
.tm-tpl-header {
    display: flex;
    align-items: center;
    gap: 6px;
}
.tm-tpl-icon {
    width: 20px;
    height: 20px;
    border-radius: 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    flex-shrink: 0;
}
.tm-tpl-title {
    font-size: 13px;
    font-weight: 600;
    color: #1d1d1f;
    line-height: 1.35;
}
.tm-tpl-desc {
    font-size: 12px;
    color: #8E8E93;
    line-height: 1.45;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}

/* ---- Card icon (used in detail view) ---- */
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

/* ---- Todo list area ---- */
.tm-todo-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 10px;
    padding: 0 24px 24px;
}

/* ---- Todo card (created task) ---- */
.tm-todo-card {
    background: #fff;
    border: 1px solid #EBEBEB;
    border-radius: 12px;
    padding: 16px;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 80px;
    position: relative;
}
.tm-todo-card:hover {
    border-color: #D1D1D6;
    box-shadow: 0 2px 8px rgba(0,0,0,0.04);
}
.tm-todo-card.tm-todo-selected {
    border-color: #C2D4F8;
    background: #FBFCFF;
    box-shadow: 0 0 0 2px rgba(59,130,246,0.08);
}

.tm-todo-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}
.tm-todo-toggle {
    position: relative;
    width: 40px;
    height: 24px;
    flex-shrink: 0;
}
.tm-todo-toggle input {
    opacity: 0;
    width: 0;
    height: 0;
    position: absolute;
}
.tm-todo-toggle-slider {
    position: absolute;
    inset: 0;
    background: #D1D1D6;
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.25s ease;
}
.tm-todo-toggle-slider::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 20px;
    height: 20px;
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
    transition: transform 0.25s ease;
}
.tm-todo-toggle input:checked + .tm-todo-toggle-slider {
    background: #34C759;
}
.tm-todo-toggle input:checked + .tm-todo-toggle-slider::after {
    transform: translateX(16px);
}
.tm-todo-card-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.15s;
}
.tm-todo-card:hover .tm-todo-card-actions {
    opacity: 1;
}
.tm-todo-card-action-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    border: none;
    background: transparent;
    cursor: pointer;
    color: #8E8E93;
    font-size: 12px;
    transition: all 0.12s;
}
.tm-todo-card-action-btn:hover {
    background: #F2F2F7;
    color: #3C3C43;
}

.tm-todo-card-title {
    font-size: 14px;
    font-weight: 600;
    color: #1d1d1f;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.tm-todo-card-desc {
    font-size: 12px;
    color: #8E8E93;
    line-height: 1.45;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}
.tm-todo-card-footer {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 4px;
}
.tm-todo-card-trigger {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: #8E8E93;
}
.tm-todo-card-trigger i {
    font-size: 10px;
}
.tm-todo-type-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 7px;
    border-radius: 5px;
    font-size: 10px;
    font-weight: 500;
    line-height: 1.6;
}

/* ---- Empty state ---- */
.tm-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 12px;
    color: #C7C7CC;
    font-size: 13px;
    gap: 6px;
    grid-column: 1 / -1;
}
.tm-empty i { font-size: 28px; opacity: 0.35; }

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
    font-family: 'Maple Mono', 'Cascadia Code', 'SF Mono', monospace;
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
.tm-cron-custom-area {
    margin-top: 8px;
}
.tm-cron-custom-input {
    width: 100%;
    padding: 7px 10px;
    border: 1.5px solid #E5E5EA;
    border-radius: 8px;
    font-size: 12px;
    font-family: 'Maple Mono', 'SF Mono', 'Menlo', 'Consolas', monospace;
    color: #1d1d1f;
    background: #fff;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s;
}
.tm-cron-custom-input:focus { border-color: #3B82F6; }
.tm-cron-custom-input.tm-input-error { border-color: #FF3B30; }
.tm-cron-help-link {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: #8E8E93;
    margin-top: 6px;
    text-decoration: none;
    cursor: pointer;
    transition: color 0.15s;
}
.tm-cron-help-link:hover { color: #3B82F6; }

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
    border: 1.5px solid var(--tm-border-strong);
    border-radius: 12px;
    background: var(--tm-surface);
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
    color: var(--tm-text);
    transition: background 0.12s;
}
.tm-dt-display:hover { background: var(--tm-surface-hover); }
.tm-dt-display-text { flex: 1; }
.tm-dt-display-icon { color: var(--tm-text-muted); font-size: 14px; margin-left: 8px; }
.tm-dt-placeholder { color: var(--tm-text-muted); }
.tm-dt-panel {
    border-top: 1px solid var(--tm-border);
    background: var(--tm-surface);
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
    color: var(--tm-text);
}
.tm-dt-cal-nav {
    display: flex;
    gap: 4px;
}
.tm-dt-cal-nav-btn {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    border: 1px solid var(--tm-border-strong);
    background: var(--tm-surface);
    color: var(--tm-text-secondary);
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.12s;
}
.tm-dt-cal-nav-btn:hover { background: var(--tm-surface-muted); border-color: var(--tm-border-strong); }

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
    color: var(--tm-text-muted);
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
    color: var(--tm-text);
    border: none;
    background: transparent;
    font-family: inherit;
}
.tm-dt-cal-day:hover { background: var(--tm-surface-pressed); }
.tm-dt-cal-day.other-month { color: var(--tm-text-disabled); }
.tm-dt-cal-day.today { font-weight: 700; color: var(--tm-accent); }
.tm-dt-cal-day.selected { background: var(--tm-accent); color: #fff; font-weight: 600; }
.tm-dt-cal-day.selected:hover { background: var(--tm-accent-hover); }

.tm-dt-time-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--tm-border);
}
.tm-dt-time-label {
    font-size: 12px;
    color: var(--tm-text-secondary);
    font-weight: 500;
    white-space: nowrap;
}
.tm-dt-time-select {
    padding: 6px 10px;
    border: 1.5px solid var(--tm-border-strong);
    border-radius: 8px;
    font-size: 13px;
    color: var(--tm-text);
    background: var(--tm-surface);
    outline: none;
    font-family: inherit;
    transition: border-color 0.15s;
    cursor: pointer;
}
.tm-dt-time-select:focus { border-color: var(--tm-accent); }
.tm-dt-time-select option {
    background: var(--tm-surface);
    color: var(--tm-text);
}
.tm-dt-time-colon {
    font-size: 14px;
    font-weight: 600;
    color: var(--tm-text-secondary);
}
.tm-dt-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--tm-border);
}
.tm-dt-today-btn {
    font-size: 12px;
    color: var(--tm-accent);
    background: none;
    border: none;
    cursor: pointer;
    font-weight: 500;
    font-family: inherit;
    padding: 4px 8px;
    border-radius: 6px;
    transition: background 0.12s;
}
.tm-dt-today-btn:hover { background: var(--tm-accent-soft); }
.tm-dt-confirm-btn {
    padding: 7px 20px;
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    background: var(--tm-accent);
    color: #fff;
    font-family: inherit;
    transition: all 0.15s;
}
.tm-dt-confirm-btn:hover { background: var(--tm-accent-hover); }
.tm-dt-confirm-btn:active { transform: scale(0.97); }
.tm-dt-confirm-btn:disabled { background: var(--tm-text-disabled); cursor: not-allowed; }
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

/**
 * 将 UTC cron 表达式转换为本地时间描述。
 * 所有 cron 表达式存储时使用 UTC，此函数负责转成本地时间来展示。
 */
function describeCronLocal(expr: string): string {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return expr;
    const [minute, hour, dom, month, dow] = fields;
    const parts: string[] = [];

    const offsetMin = -new Date().getTimezoneOffset();
    const hourIsNum = /^\d+$/.test(hour);
    const minIsNum = /^\d+$/.test(minute);

    let displayH = hour;
    let displayM = minute;
    let dayShift = 0;

    if (hourIsNum && minIsNum) {
        let lm = parseInt(minute, 10) + (offsetMin % 60);
        let lh = parseInt(hour, 10) + Math.floor(offsetMin / 60);
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
        displayH = String(lh);
        displayM = String(lm).padStart(2, '0');
    } else if (hourIsNum) {
        let lh = parseInt(hour, 10) + Math.floor(offsetMin / 60);
        if (lh >= 24) {
            lh -= 24;
            dayShift = 1;
        }
        if (lh < 0) {
            lh += 24;
            dayShift = -1;
        }
        displayH = String(lh);
    } else if (minIsNum) {
        let lm = parseInt(minute, 10) + (offsetMin % 60);
        if (lm >= 60) {
            lm -= 60;
        }
        if (lm < 0) {
            lm += 60;
        }
        displayM = String(lm).padStart(2, '0');
    }

    if (dow !== '*') {
        if (/^[\d,]+$/.test(dow)) {
            const days = dow.split(',').map((d) => {
                let v = parseInt(d.trim(), 10);
                if (dayShift) v = (((v + dayShift) % 7) + 7) % 7;
                return `周${DOW_LABELS[v] || v}`;
            });
            parts.push(days.length === 1 ? `每${days[0]}` : days.join('/'));
        } else {
            parts.push(`周(${dow})`);
        }
    }
    if (dom !== '*') parts.push(`每月${dom}日`);
    if (month !== '*') parts.push(`${month}月`);
    if (displayH !== '*' && displayM !== '*') parts.push(`${displayH}:${displayM}`);
    else if (displayH !== '*') parts.push(`${displayH}时`);
    else if (displayM !== '*') parts.push(`每小时第${displayM}分`);
    else parts.push('每分钟');
    return parts.join(' ');
}

/**
 * 将本地时间的 cron 表达式转为 UTC 存储。
 * 仅转换纯数字的 hour/minute 字段，其他表达式（如 * / 范围等）保持原样。
 */
function convertCronLocalToUTC(expr: string): string {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return expr;
    const [minute, hour, dom, month, dow] = fields;

    const hourIsNum = /^\d+$/.test(hour);
    const minIsNum = /^\d+$/.test(minute);
    if (!hourIsNum && !minIsNum) return expr;

    const offsetMin = -new Date().getTimezoneOffset();
    let utcM = minIsNum ? parseInt(minute, 10) - (offsetMin % 60) : NaN;
    let utcH = hourIsNum ? parseInt(hour, 10) - Math.floor(offsetMin / 60) : NaN;
    let dayShift = 0;

    if (minIsNum) {
        if (utcM < 0) {
            if (hourIsNum) utcH--;
            utcM += 60;
        }
        if (utcM >= 60) {
            if (hourIsNum) utcH++;
            utcM -= 60;
        }
    }
    if (hourIsNum) {
        if (utcH < 0) {
            utcH += 24;
            dayShift = -1;
        }
        if (utcH >= 24) {
            utcH -= 24;
            dayShift = 1;
        }
    }

    const newMin = minIsNum ? String(utcM) : minute;
    const newHour = hourIsNum ? String(utcH) : hour;

    let newDow = dow;
    if (dayShift && dow !== '*' && /^[\d,]+$/.test(dow)) {
        newDow = dow
            .split(',')
            .map((d) => {
                const v = parseInt(d.trim(), 10);
                return (((v + dayShift) % 7) + 7) % 7;
            })
            .sort((a, b) => a - b)
            .join(',');
    }

    return `${newMin} ${newHour} ${dom} ${month} ${newDow}`;
}

/**
 * 将 UTC 存储的 cron 表达式转回本地时间，供编辑时显示。
 * 逻辑与 convertCronLocalToUTC 方向相反。
 */
function convertCronUTCToLocal(expr: string): string {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return expr;
    const [minute, hour, dom, month, dow] = fields;

    const hourIsNum = /^\d+$/.test(hour);
    const minIsNum = /^\d+$/.test(minute);
    if (!hourIsNum && !minIsNum) return expr;

    const offsetMin = -new Date().getTimezoneOffset();
    let lm = minIsNum ? parseInt(minute, 10) + (offsetMin % 60) : NaN;
    let lh = hourIsNum ? parseInt(hour, 10) + Math.floor(offsetMin / 60) : NaN;
    let dayShift = 0;

    if (minIsNum) {
        if (lm >= 60) {
            if (hourIsNum) lh++;
            lm -= 60;
        }
        if (lm < 0) {
            if (hourIsNum) lh--;
            lm += 60;
        }
    }
    if (hourIsNum) {
        if (lh >= 24) {
            lh -= 24;
            dayShift = 1;
        }
        if (lh < 0) {
            lh += 24;
            dayShift = -1;
        }
    }

    const newMin = minIsNum ? String(lm) : minute;
    const newHour = hourIsNum ? String(lh) : hour;

    let newDow = dow;
    if (dayShift && dow !== '*' && /^[\d,]+$/.test(dow)) {
        newDow = dow
            .split(',')
            .map((d) => {
                const v = parseInt(d.trim(), 10);
                return (((v + dayShift) % 7) + 7) % 7;
            })
            .sort((a, b) => a - b)
            .join(',');
    }

    return `${newMin} ${newHour} ${dom} ${month} ${newDow}`;
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
    private _skipNextRefresh = false;

    private _isResizing = false;
    private _resizeRaf: number | null = null;
    private _boundMouseMove: ((e: MouseEvent) => void) | null = null;
    private _boundMouseUp: (() => void) | null = null;

    private _cachedEvents: AppEvent[] | null = null;
    private _templates: TodoTemplate[] = [];

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
        this._loadTemplates().then(() => {
            const tplGrid = this.querySelector('#tm-templates-grid') as HTMLElement;
            if (tplGrid) tplGrid.innerHTML = this._renderTemplates();
        });
        this.render();
        this.loadData();
        this._prefetchEvents();

        this._onGlobalTodosUpdated = (todos: any[]) => {
            this.globalTodos = todos;
            if (this._skipNextRefresh) {
                this._skipNextRefresh = false;
            } else {
                this._refreshList();
            }
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
     *  TEMPLATES
     * ═══════════════════════════ */

    private async _loadTemplates() {
        try {
            const mod = await import('../templates.js');
            this._templates = mod.TODO_TEMPLATES || [];
        } catch {
            this._templates = [];
        }
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
                    <div class="tm-toolbar-subtitle" id="tm-summary">让 Agent 按计划自动执行任务，持续为你处理重复工作</div>
                </div>
                <div style="display:flex;gap:8px;">
                    <button class="tm-btn" id="tm-quick-add-btn" style="padding:8px 16px;">
                        <i class="fas fa-wand-magic-sparkles" style="font-size:12px;"></i>
                        一句话创建
                    </button>
                    <button class="tm-btn tm-btn-primary" id="tm-create-btn" style="padding:8px 16px;">
                        <i class="fas fa-plus" style="font-size:12px;"></i>
                        创建
                    </button>
                </div>
            </div>
            <div class="tm-content-row">
                <div class="tm-left" id="tm-left">
                    <div class="tm-section" id="tm-templates">
                        <div class="tm-section-title">可以试试从这些常见任务入手</div>
                    </div>
                    <div class="tm-templates-grid" id="tm-templates-grid">
                        ${this._renderTemplates()}
                    </div>
                    <div class="tm-section">
                        <div class="tm-section-title">已创建的自动化任务</div>
                    </div>
                    <div class="tm-todo-list" id="tm-todo-list">
                        ${this._renderTodoCards()}
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
     *  LEFT: TODO CARDS
     * ═══════════════════════════ */

    private _renderTodoCards(): string {
        if (this.globalTodos.length === 0) {
            return `<div class="tm-empty">
                <i class="fas fa-inbox"></i>
                <span>暂无自动化任务</span>
                <span style="font-size:11px;">点击上方模板快速创建</span>
            </div>`;
        }
        return this.globalTodos
            .map((t) => {
                const triggerType = (t.trigger?.type || 'event') as TriggerType;
                const cfg = CARD_CONFIG[triggerType];
                const summary = getTriggerSummary(t);
                const isEnabled = t.enabled !== false;
                const isSelected = t.id === this.selectedTodoId;
                return `<div class="tm-todo-card${isSelected ? ' tm-todo-selected' : ''}" data-id="${escapeHtml(t.id)}">
                <div class="tm-todo-card-top">
                    <label class="tm-todo-toggle" title="${isEnabled ? '已启用，点击禁用' : '已禁用，点击启用'}">
                        <input type="checkbox" data-toggle-id="${escapeHtml(t.id)}" ${isEnabled ? 'checked' : ''}>
                        <span class="tm-todo-toggle-slider"></span>
                    </label>
                    <div class="tm-todo-card-actions">
                        <button class="tm-todo-card-action-btn" data-action="more" data-id="${escapeHtml(t.id)}" title="更多">
                            <i class="fas fa-ellipsis"></i>
                        </button>
                    </div>
                </div>
                <div class="tm-todo-card-title">${escapeHtml(t.title)}</div>
                <div class="tm-todo-card-desc">${escapeHtml(t.content)}</div>
                <div class="tm-todo-card-footer">
                    <div><span class="tm-todo-type-badge" style="background:${cfg.iconBg};color:${cfg.iconColor};">
                        <i class="fas ${cfg.icon}" style="font-size:9px;"></i>
                        ${cfg.label}
                    </span></div>
                    <span class="tm-todo-card-trigger">
                        <i class="fas fa-clock"></i>
                        ${escapeHtml(summary)}
                    </span>
                </div>
            </div>`;
            })
            .join('');
    }

    private _refreshList() {
        const listEl = this.querySelector('#tm-todo-list');
        if (listEl) listEl.innerHTML = this._renderTodoCards();
        this._updateSummary();
    }

    private _updateSummary() {
        const el = this.querySelector('#tm-summary') as HTMLElement;
        if (!el) return;
        el.textContent = '让 Agent 按计划自动执行任务，持续为你处理重复工作';
    }

    /* ═══════════════════════════
     *  TEMPLATES AREA
     * ═══════════════════════════ */

    private _renderTemplates(): string {
        if (!this._templates || this._templates.length === 0) {
            return '';
        }
        const tplIconColors: Record<string, { bg: string; color: string }> = {
            scheduled: { bg: '#EFF6FF', color: '#2563EB' },
            cron: { bg: '#F0FDF4', color: '#16A34A' },
            event: { bg: '#FFF7ED', color: '#EA580C' }
        };
        return this._templates
            .map((tpl) => {
                const colors = tplIconColors[tpl.triggerType] || tplIconColors.cron;
                return `<div class="tm-tpl-card" data-tpl-id="${escapeHtml(tpl.id)}">
                <div class="tm-tpl-header">
                    <div class="tm-tpl-icon" style="background:${colors.bg};color:${colors.color};">
                        <i class="fas ${tpl.icon}"></i>
                    </div>
                    <div class="tm-tpl-title">${escapeHtml(tpl.title)}</div>
                </div>
                <div class="tm-tpl-desc">${escapeHtml(tpl.description)}</div>
            </div>`;
            })
            .join('');
    }

    private _onTemplateClick(tplId: string) {
        const tpl = this._templates.find((t) => t.id === tplId);
        if (!tpl) return;
        this._addNewFromTemplate(tpl);
    }

    private _addNewFromTemplate(tpl: TodoTemplate) {
        const right = this.querySelector('#tm-right') as HTMLElement;
        const isOpen = right && right.style.display !== 'none' && parseInt(right.style.width) > 0;

        const doOpen = () => {
            this.selectedTodoId = '__new__';
            this.isEditing = true;
            this.isAddingNew = true;
            this.addingType = tpl.triggerType;
            this._enterEditModeFromTemplate(tpl);
        };

        if (isOpen) {
            doOpen();
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
                doOpen();
            };
            rightEl.addEventListener('transitionend', onEnd);
        }
    }

    private async _enterEditModeFromTemplate(tpl: TodoTemplate) {
        // 构造一个预填充的伪 todo 用于初始化表单，但 _saveEdit 传入 null 表示创建
        const prefilledTodo: GlobalTodo = {
            id: '__tpl__',
            title: tpl.title,
            content: tpl.defaultContent,
            status: 'pending',
            priority: tpl.defaultPriority,
            category: tpl.defaultCategory,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        if (tpl.triggerType === 'cron' && tpl.defaultCronMode) {
            const localH = tpl.defaultLocalHour ?? 9;
            const localM = tpl.defaultLocalMinute ?? 0;
            const dows = tpl.defaultDows ?? [];
            const dom = '1';
            const cronExpr = buildCronFromUI(tpl.defaultCronMode, localH, localM, dows, dom, '*');
            prefilledTodo.trigger = { type: 'cron', cronExpression: cronExpr };
        } else if (tpl.triggerType === 'event') {
            prefilledTodo.trigger = {
                type: 'event',
                bundleName: tpl.defaultBundleName || '',
                eventName: tpl.defaultEventName || ''
            };
        } else if (tpl.triggerType === 'scheduled') {
            const now = new Date();
            now.setHours(now.getHours() + 1, 0, 0, 0);
            prefilledTodo.trigger = { type: 'scheduled', triggerAt: now.toISOString() };
        }

        // 使用预填充的 todo 来填充表单字段，但标记为新增模式
        this.isEditing = true;
        this.isAddingNew = true;
        this.addingType = tpl.triggerType;
        await this._enterEditMode(prefilledTodo, tpl.triggerType);
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
                    <span class="tm-detail-attr-value" style="font-family:'Maple Mono','Cascadia Code','SF Mono',monospace;font-size:12px;">${escapeHtml(todo.trigger.cronExpression)}</span>
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
        const isTemplatePreFill = todo?.id === '__tpl__';
        this.isEditing = true;
        if (!isTemplatePreFill) {
            this.isAddingNew = !todo;
        }
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

        const isNew = !todo || isTemplatePreFill;
        const title = !todo ? '' : todo.title;
        const content = !todo ? '' : todo.content;
        const priority = !todo ? 'medium' : todo.priority;
        const category = !todo ? '' : todo.category || '';
        const status = !todo ? 'pending' : todo.status;
        const triggerType = !todo ? addType || 'scheduled' : todo.trigger?.type || addType || 'scheduled';

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
            <div class="tm-edit-field">
                <label class="tm-edit-label">发送到</label>
                <select class="tm-edit-select" id="tm-edit-deliver-target">
                    <option value="">默认</option>
                </select>
                <div style="font-size:11px;color:var(--text-tertiary,#888);margin-top:4px;">指定后，任务产生的回复将自动发送到该渠道</div>
            </div>
        </div>`;

        this._renderTriggerFields(triggerType, todo);
        this._loadDeliverTargets(todo);

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
        this.querySelector('#tm-edit-save')?.addEventListener('click', () =>
            this._saveEdit(isTemplatePreFill ? null : todo)
        );

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

    private async _loadDeliverTargets(todo: GlobalTodo | null) {
        const select = this.querySelector('#tm-edit-deliver-target') as HTMLSelectElement;
        if (!select) return;

        try {
            const channels: {
                channelId: string;
                accountId: string;
                label: string;
                online: boolean;
                recipients: { recipientId: string; displayName: string; chatType: string }[];
            }[] = await window.applicationAPI.callMainWorld('getConnectedChannelsForUI');

            for (const ch of channels) {
                if (ch.recipients.length === 0) {
                    const opt = document.createElement('option');
                    opt.value = '';
                    opt.textContent = `${ch.label}（暂无联系人，请先通过该渠道发一条消息）`;
                    opt.disabled = true;
                    select.appendChild(opt);
                } else {
                    for (const r of ch.recipients) {
                        const opt = document.createElement('option');
                        opt.value = `${ch.channelId}:${ch.accountId}:${r.recipientId}`;
                        const typeHint = r.chatType === 'group' ? '群' : '';
                        opt.textContent = `${ch.label} - ${r.displayName}${typeHint ? ` [${typeHint}]` : ''}`;
                        select.appendChild(opt);
                    }
                }
            }

            // 如果已有 deliver 配置，选中对应项
            if (todo?.deliver && todo.deliver.type === 'channel') {
                const key = `${todo.deliver.channel}:${todo.deliver.accountId}:${todo.deliver.recipientId}`;
                select.value = key;
            }
        } catch {
            // 获取渠道列表失败时保持默认选项
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
        let customCron = '';

        if (existingTodo?.trigger?.type === 'cron' && existingTodo.trigger.cronExpression) {
            const parsed = this._parseCronForUI(existingTodo.trigger.cronExpression);
            mode = parsed.mode;
            hour = parsed.hour;
            minute = parsed.minute;
            selectedDows = parsed.selectedDows;
            dom = parsed.dom;
            if (mode === 'custom') {
                customCron = convertCronUTCToLocal(existingTodo.trigger.cronExpression);
            }
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

        const isCustom = mode === 'custom';

        container.innerHTML = `
        <div class="tm-edit-field">
            <label class="tm-edit-label">重复频率</label>
            <div class="tm-cron-row">
                <select class="tm-cron-select" id="tm-cron-mode" style="flex:1;">
                    <option value="daily"${mode === 'daily' ? ' selected' : ''}>每天</option>
                    <option value="weekly"${mode === 'weekly' ? ' selected' : ''}>每周指定日</option>
                    <option value="monthly"${mode === 'monthly' ? ' selected' : ''}>每月指定日</option>
                    <option value="custom"${isCustom ? ' selected' : ''}>自定义 Cron 表达式</option>
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

            <div id="tm-cron-time-area" style="${isCustom ? 'display:none;' : ''}">
                <label class="tm-edit-label" style="margin-top:10px;">执行时间</label>
                <div class="tm-cron-row">
                    <select class="tm-cron-select" id="tm-cron-hour">${hourOptions}</select>
                    <span style="color:#8E8E93;">:</span>
                    <select class="tm-cron-select" id="tm-cron-minute">${minOptions}</select>
                </div>
            </div>

            <div id="tm-cron-custom-area" class="tm-cron-custom-area" style="${isCustom ? '' : 'display:none;'}">
                <label class="tm-edit-label" style="margin-top:8px;">Cron 表达式</label>
                <input type="text" class="tm-cron-custom-input" id="tm-cron-custom-input"
                    value="${escapeHtml(customCron)}"
                    placeholder="例如: 0 9 * * 1-5（工作日每天9点，使用本地时间）">
                <a class="tm-cron-help-link" href="https://support.huaweicloud.com/usermanual-coc/coc_um_05_03_03.html" target="_blank" rel="noopener">
                    <i class="fas fa-circle-question" style="font-size:11px;"></i>
                    什么是 Cron 表达式？
                </a>
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
        if (fields.length !== 5) return { mode: 'custom', hour: 9, minute: 0, selectedDows: [1, 2, 3, 4, 5], dom: '1' };
        const [cronMin, cronHour, cronDom, cronMonth, cronDow] = fields;

        // 包含 / - L 或月份字段非 * 的表达式无法用简单 UI 表达，归为自定义
        const isSimpleNum = (s: string) => /^\d+$/.test(s);
        if (!isSimpleNum(cronMin) || !isSimpleNum(cronHour) || cronMonth !== '*') {
            return { mode: 'custom', hour: 9, minute: 0, selectedDows: [], dom: '1' };
        }

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
            // 星期字段含非数字/逗号字符 (如 1-5) → 自定义
            if (!/^[\d,]+$/.test(cronDow)) {
                return { mode: 'custom', hour: lh, minute: lm, selectedDows: [], dom: '1' };
            }
            mode = 'weekly';
            selectedDows = cronDow.split(',').map((d) => {
                const v = parseInt(d.trim(), 10);
                return (((v + dayShift) % 7) + 7) % 7;
            });
        } else if (cronDom !== '*') {
            if (!isSimpleNum(cronDom)) {
                return { mode: 'custom', hour: lh, minute: lm, selectedDows: [], dom: '1' };
            }
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
            const timeArea = this.querySelector('#tm-cron-time-area') as HTMLElement;
            const customArea = this.querySelector('#tm-cron-custom-area') as HTMLElement;
            if (dowArea) dowArea.style.display = mode === 'weekly' ? '' : 'none';
            if (domArea) domArea.style.display = mode === 'monthly' ? '' : 'none';
            if (timeArea) timeArea.style.display = mode === 'custom' ? 'none' : '';
            if (customArea) customArea.style.display = mode === 'custom' ? '' : 'none';
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

        this.querySelector('#tm-cron-custom-input')?.addEventListener('input', () => this._updateCronPreview());
    }

    private _getCronFromUI(): string {
        const mode = (this.querySelector('#tm-cron-mode') as HTMLSelectElement)?.value || 'daily';
        if (mode === 'custom') {
            const raw = (this.querySelector('#tm-cron-custom-input') as HTMLInputElement)?.value?.trim() || '';
            return convertCronLocalToUTC(raw);
        }
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
        const mode = (this.querySelector('#tm-cron-mode') as HTMLSelectElement)?.value || 'daily';
        const customInput = this.querySelector('#tm-cron-custom-input') as HTMLInputElement;

        if (mode === 'custom') {
            if (!cron) {
                previewEl.textContent = '请输入 Cron 表达式';
                previewEl.style.color = '#8E8E93';
                if (customInput) customInput.classList.remove('tm-input-error');
                return;
            }
            const fields = cron.split(/\s+/);
            if (fields.length !== 5) {
                previewEl.textContent = '格式错误：Cron 表达式需要5个字段（分 时 日 月 周）';
                previewEl.style.color = '#FF3B30';
                if (customInput) customInput.classList.add('tm-input-error');
                return;
            }
            if (customInput) customInput.classList.remove('tm-input-error');
            previewEl.style.color = '';
        }
        const localDesc = describeCronLocal(cron);
        if (mode === 'custom') {
            const rawInput = (this.querySelector('#tm-cron-custom-input') as HTMLInputElement)?.value?.trim() || '';
            previewEl.textContent = `${localDesc}（${rawInput}）`;
        } else {
            previewEl.textContent = `${localDesc}（${convertCronUTCToLocal(cron)}）`;
        }
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

        let trigger: any = null;
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

        // 解析投递目标（格式: channelId:accountId:recipientId）
        const deliverTargetValue = (this.querySelector('#tm-edit-deliver-target') as HTMLSelectElement)?.value || '';
        let deliver: any = undefined;
        if (deliverTargetValue) {
            const parts = deliverTargetValue.split(':');
            const channelId = parts[0];
            const accountId = parts[1];
            const recipientId = parts.slice(2).join(':');
            if (channelId && accountId && recipientId) {
                deliver = { type: 'channel', channel: channelId, accountId, recipientId };
            }
        }

        try {
            const saveBtn = this.querySelector('#tm-edit-save') as HTMLButtonElement;
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.textContent = '保存中...';
            }

            // 构建更新对象，确保 trigger 始终作为显式属性发送（避免 undefined 在 IPC 序列化时被丢弃）
            const updatePayload: Record<string, any> = { title, content, priority, category, status };
            if (trigger !== null) {
                updatePayload.trigger = trigger;
            }
            // 投递目标：null 表示清除，对象表示设置
            updatePayload.deliver = deliver || null;

            if (existingTodo) {
                await window.applicationAPI.call('updateGlobalTodo', existingTodo.id, updatePayload);
            } else {
                await window.applicationAPI.call('addGlobalTodo', title, content, priority, category, trigger, deliver);
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

    private async _toggleEnabled(todoId: string, enabled: boolean) {
        this._skipNextRefresh = true;
        try {
            await window.applicationAPI.call('updateGlobalTodo', todoId, { enabled });
        } catch (err: any) {
            console.error('Toggle enabled failed:', err);
            this._skipNextRefresh = false;
            await this.loadData();
        }
    }

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

    private _navigateToHomeWithPrompt(prompt: string) {
        const root = (window.parent || window) as any;
        if (root.globalControlAPI?.openHomePage) {
            root.globalControlAPI.openHomePage();
            setTimeout(() => {
                const homepage = root.document.querySelector('home-page');
                if (homepage) {
                    const textarea =
                        homepage.querySelector('#agent-input-textarea') ||
                        homepage.querySelector('#agent-input-main #agent-input-textarea');
                    if (textarea) {
                        (textarea as HTMLTextAreaElement).value = prompt;
                        (textarea as HTMLTextAreaElement).focus();
                        textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }
            }, 300);
        }
    }

    private _bindEvents() {
        this.querySelector('#tm-create-btn')?.addEventListener('click', () => this._addNew('cron'));
        this.querySelector('#tm-quick-add-btn')?.addEventListener('click', () => {
            this._navigateToHomeWithPrompt('/manage-global-todos 请在这里描述你需要的自动化任务内容');
        });

        this.querySelector('#tm-templates-grid')?.addEventListener('click', (e) => {
            const card = (e.target as HTMLElement).closest('.tm-tpl-card') as HTMLElement;
            if (card) {
                const tplId = card.dataset.tplId;
                if (tplId) this._onTemplateClick(tplId);
            }
        });

        this.querySelector('#tm-todo-list')?.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            // 开关切换 — 拦截整个 toggle label 区域（包括 slider 伪元素）
            const toggleLabel = target.closest('.tm-todo-toggle') as HTMLElement;
            if (toggleLabel) {
                e.preventDefault();
                e.stopPropagation();
                const input = toggleLabel.querySelector('input[data-toggle-id]') as HTMLInputElement;
                if (input) {
                    input.checked = !input.checked;
                    const todoId = input.dataset.toggleId;
                    if (todoId) this._toggleEnabled(todoId, input.checked);
                }
                return;
            }
            // 点击卡片打开详情
            const card = target.closest('.tm-todo-card') as HTMLElement;
            if (card) {
                const id = card.dataset.id;
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
