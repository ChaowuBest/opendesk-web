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

import { CARD_GRID_INSET, RESIZE_HANDLE_THICKNESS } from './cardLayout.js';

/** 沉浸桌面组件样式：沿用 OpenDesk 主界面的语义色、克制层级与紧凑控件。 */
export function buildDesktopStyles(): string {
    return `
    <style>
        immersive-desktop {
            --od-ink: var(--od-text, #1f2937);
            --od-ink-dim: var(--od-text-muted, #6b7280);
            --od-ink-faint: var(--od-text-disabled, #9ca3af);
            --od-card: color-mix(in srgb, var(--od-bg-elevated, #ffffff) 96%, transparent);
            --od-card-hi: var(--od-bg-elevated, #ffffff);
            --od-card-border: var(--od-border, rgba(0, 0, 0, 0.08));
            --od-card-line: var(--od-border, rgba(0, 0, 0, 0.08));
            --od-blue: var(--od-accent, #3b82f6);
            --od-green: var(--chat-green, #1f9d66);
            --od-amber: var(--chat-amber, #b87503);
            --od-red: #dc2626;
            --od-shadow: 0 1px 2px rgba(28, 25, 23, 0.04), 0 10px 28px rgba(28, 25, 23, 0.07);
            --od-panel: var(--od-bg-elevated, #ffffff);
            --od-panel-muted: var(--od-bg-muted, #fafafa);
            --od-hover: var(--chat-hover, #f4f3f1);
            --od-accent-soft: color-mix(in srgb, var(--od-blue) 10%, transparent);
            --od-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
            --od-grid-edge: 28px;
            --od-grid-card-inset: ${CARD_GRID_INSET}px;
            --od-dock-bottom: 18px;
            --od-dock-height: 52px;
        }
        immersive-desktop.theme-dark {
            --od-card: color-mix(in srgb, var(--od-bg-elevated, #252526) 94%, transparent);
            --od-shadow: 0 1px 2px rgba(0, 0, 0, 0.38), 0 14px 36px rgba(0, 0, 0, 0.28);
            --od-hover: var(--chat-hover, #33302d);
        }
        immersive-desktop, immersive-desktop * { margin: 0; padding: 0; box-sizing: border-box; }
        immersive-desktop {
            position: fixed; inset: 0; z-index: 50000;
            background: var(--od-bg); color: var(--od-ink);
            font-family: var(--font-sans, -apple-system, 'PingFang SC', 'Segoe UI', sans-serif);
            overflow: hidden; -webkit-font-smoothing: antialiased;
            opacity: 0; transform: translateY(-2px) scale(0.996); transform-origin: top right;
            clip-path: inset(36px 18px calc(100% - 76px) calc(100% - 250px) round 12px);
            transition: opacity 300ms ease, transform 440ms var(--od-ease-out), clip-path 440ms var(--od-ease-out);
            user-select: none;
        }
        immersive-desktop:focus { outline: none; }
        immersive-desktop.od-active { opacity: 1; transform: none; clip-path: inset(0 round 0); }
        immersive-desktop.od-leaving {
            opacity: 0.16; transform: translateY(-2px) scale(0.996);
            clip-path: inset(36px 18px calc(100% - 76px) calc(100% - 250px) round 12px);
            pointer-events: none;
        }

        /* ---------- 背景：延续主界面的中性工作区 ---------- */
        .od-bg {
            position: fixed; inset: 0; z-index: 0; overflow: hidden; background: var(--od-bg);
            border-top: 1px solid color-mix(in srgb, var(--od-blue) 14%, transparent);
        }
        .od-bg::before {
            content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0.55;
            background: linear-gradient(180deg, var(--od-accent-soft) 0, transparent 150px);
        }
        /* ---------- 骨架布局 ---------- */
        .od-app {
            position: relative; z-index: 1; height: 100vh;
            display: flex; flex-direction: column;
            gap: calc(var(--od-grid-edge) - var(--od-grid-card-inset));
            padding-top: 10px;
            padding-inline: calc(var(--od-grid-edge) - var(--od-grid-card-inset));
            padding-bottom: calc(var(--od-dock-bottom) + var(--od-dock-height) + var(--od-grid-edge) - var(--od-grid-card-inset));
        }
        .od-topbar {
            min-height: 46px; padding-bottom: 10px;
            display: flex; align-items: center; justify-content: space-between; gap: 18px;
            border-bottom: 1px solid var(--od-card-line);
            -webkit-app-region: drag;
        }
        .od-brand { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13px; }
        /* 品牌桌面图标：灰色描边，与主界面侧边栏图标同风格 */
        .od-brand-icon { width: 16px; height: 16px; color: var(--od-ink-dim); flex: none; }
        .od-brand em { font-style: normal; color: var(--od-ink-dim); font-weight: 400; font-size: 12px; }
        .od-status { display: flex; align-items: center; gap: 6px; color: var(--od-ink-dim); font-size: 12px; }
        .od-status, .od-status * { -webkit-app-region: no-drag; }
        .od-chip { padding: 5px 9px; border-radius: 8px; border: 1px solid transparent; background: transparent; }
        .od-add-card-btn {
            display: inline-flex; align-items: center; gap: 6px;
            border-color: var(--od-card-border); background: var(--od-panel);
            color: var(--od-ink-dim); font-size: 12px; font-family: inherit;
            cursor: pointer; padding: 5px 10px; transition: 0.15s ease;
        }
        .od-add-card-btn i { font-size: 11px; }
        .od-add-card-btn:hover {
            color: var(--od-blue); border-color: color-mix(in srgb, var(--od-blue) 32%, var(--od-card-border));
            background: var(--od-accent-soft);
        }
        .od-refresh-chip { display: inline-flex; align-items: center; gap: 7px; color: var(--od-blue); background: var(--od-accent-soft); }
        .od-refresh-chip[hidden] { display: none; }
        .od-clock-chip { color: var(--od-ink-faint); font-variant-numeric: tabular-nums; }
        .od-icon-ghost {
            width: 30px; height: 30px; border-radius: 8px; border: 1px solid transparent;
            background: transparent; color: var(--od-ink-dim); cursor: pointer; font-size: 12px;
            display: flex; align-items: center; justify-content: center; transition: 0.15s ease;
        }
        .od-icon-ghost:hover { color: var(--od-red); background: color-mix(in srgb, var(--od-red) 10%, transparent); }
        .od-icon-ghost.od-theme-toggle:hover {
            color: var(--od-ink); border-color: var(--od-card-border); background: var(--od-hover);
        }

        /* ---------- 网格与卡片 ---------- */
        /* 网格仅用于吸附定位，不绘制可见网格线 */
        .od-stage {
            flex: 1; min-height: 0; position: relative;
            border-radius: 12px;
        }
        .od-empty-state {
            position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
            padding: 24px; text-align: center; color: var(--od-ink-faint); font-size: 14px;
            pointer-events: none;
        }
        .od-empty-state[hidden] { display: none; }
        .od-card {
            position: absolute; overflow: hidden; min-width: 40px; min-height: 40px;
            border-radius: 14px; border: 1px solid var(--od-card-border);
            background: var(--od-card); backdrop-filter: blur(18px);
            box-shadow: var(--od-shadow);
            display: flex; flex-direction: column;
            transition: left 140ms ease-out, top 140ms ease-out, width 140ms ease-out, height 140ms ease-out, background 0.18s, border-color 0.18s, box-shadow 0.18s;
        }
        .od-card.od-card-enter { animation: od-card-in 0.46s var(--od-ease-out) both; animation-delay: calc(0.08s + var(--od-i, 0) * 0.035s); }
        @keyframes od-card-in { from { opacity: 0; transform: translateY(12px) scale(0.99); } to { opacity: 1; transform: none; } }
        .od-card.od-card-dragging, .od-card.od-card-resizing {
            transition: none; animation: none !important; opacity: 0.96; z-index: 60 !important;
            border-color: var(--od-border-strong); box-shadow: 0 18px 44px rgba(28, 25, 23, 0.16);
        }
        /* 拖动/缩放时屏蔽 iframe 吞掉指针事件 */
        .od-card.od-card-dragging .od-card-frame, .od-card.od-card-resizing .od-card-frame { pointer-events: none; }
        .od-card:hover { background: var(--od-card-hi); border-color: var(--od-border-strong); }
        /* 任何拖动/缩放交互期间，指针进入其它卡片或应用窗口的 iframe/webview 时事件不能被其文档吞掉 */
        immersive-desktop.od-interacting iframe, immersive-desktop.od-interacting webview { pointer-events: none !important; }
        /* 动效敏感用户：停掉装饰性无限动画与交错入场 */
        @media (prefers-reduced-motion: reduce) {
            immersive-desktop { transition: opacity 160ms ease; transform: none; clip-path: inset(0 round 0); }
            immersive-desktop.od-leaving { transform: none; clip-path: inset(0 round 0); }
            immersive-desktop:focus { outline: none; }
            .od-card.od-card-enter, immersive-desktop.od-play .od-topbar, immersive-desktop.od-play .od-dock-wrap { animation-duration: 0.01ms !important; animation-delay: 0ms !important; }
            .od-applist, .od-context-menu, .od-floating-window.od-window-enter { animation: none !important; }
            .od-card { transition: background 0.3s, box-shadow 0.3s; }
        }
        .od-card-header {
            flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px;
            padding: 12px 18px 0; cursor: grab; min-height: 30px;
        }
        /* 已生成卡片把内容铺满；标题只在悬停时作为顶部浮层出现，不挤压内容。 */
        .od-card.od-card-done .od-card-header {
            position: absolute; z-index: 4; top: 0; left: 0; right: 0;
            max-height: 0; min-height: 0; padding: 0 18px; opacity: 0;
            overflow: hidden; pointer-events: none; transform: translateY(-8px);
            background: var(--od-panel); backdrop-filter: blur(14px);
            transition: max-height 160ms ease, padding 160ms ease, opacity 120ms ease, transform 160ms ease;
        }
        .od-card.od-card-done:hover .od-card-header,
        .od-card.od-card-done.od-card-dragging .od-card-header {
            max-height: 42px; min-height: 30px; padding: 12px 18px 0; opacity: 1;
            pointer-events: auto; transform: translateY(0);
        }
        .od-card.od-card-dragging .od-card-header { cursor: grabbing; }
        .od-card-title {
            font-size: 12.5px; color: var(--od-ink-dim); letter-spacing: 0.06em;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
        }
        .od-card-live {
            flex: none; font-size: 10px; color: var(--od-green);
            background: color-mix(in srgb, var(--od-green) 10%, transparent); border-radius: 5px; padding: 2px 7px;
            font-weight: 600;
        }
        /* 刷新失败警告标记：位于头部间隔标签右侧，点击直达出错任务 */
        .od-card-warn {
            flex: none; width: 20px; height: 20px; border-radius: 50%;
            border: 1px solid rgba(245, 158, 11, 0.45); background: rgba(245, 158, 11, 0.12);
            color: var(--od-amber); font-size: 10px; cursor: pointer;
            display: inline-flex; align-items: center; justify-content: center; padding: 0;
            transition: 0.2s;
        }
        .od-card-warn:hover { background: rgba(245, 158, 11, 0.24); color: var(--od-ink); }
        /* 无内容错误态中的"查看出错任务"链接 */
        .od-error-task-link {
            border: 1px solid color-mix(in srgb, var(--od-blue) 24%, transparent);
            background: var(--od-accent-soft); color: var(--od-blue);
            font-size: 12px; border-radius: 7px; padding: 5px 10px; cursor: pointer;
            font-family: inherit; transition: 0.15s ease;
        }
        .od-error-task-link:hover { background: color-mix(in srgb, var(--od-blue) 16%, transparent); }
        .od-card-body { flex: 1; min-height: 0; position: relative; margin: 8px 6px 6px; overflow: hidden; }
        .od-card.od-card-done .od-card-body { margin: 0; }
        .od-card-frame { width: 100%; height: 100%; border: none; background: transparent; }
        .od-card-hint {
            position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 10px; color: var(--od-ink-faint); font-size: 13px; text-align: center; padding: 0 18px;
        }
        .od-card-hint i { font-size: 26px; opacity: 0.6; }
        .od-gen-head { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--od-ink-dim); padding: 10px 16px 0; }
        .od-pulse-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--od-blue); animation: od-pulse 1.4s ease-in-out infinite; flex: none; }
        @keyframes od-pulse { 0%, 100% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1.1); } }
        .od-sk-lines { flex: 1; display: flex; flex-direction: column; gap: 10px; justify-content: center; padding: 0 22px 16px; }
        .od-sk-line { height: 12px; border-radius: 6px; background: linear-gradient(90deg, rgba(25, 39, 70, 0.05), rgba(25, 39, 70, 0.13), rgba(25, 39, 70, 0.05)); background-size: 220% 100%; animation: od-shimmer-x 1.3s linear infinite; }
        immersive-desktop.theme-dark .od-sk-line { background: linear-gradient(90deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.05)); background-size: 220% 100%; }
        @keyframes od-shimmer-x { 0% { background-position: 120% 0; } 100% { background-position: -120% 0; } }
        .od-card-updating {
            position: absolute; top: 8px; right: 10px; z-index: 3;
            display: flex; align-items: center; gap: 6px;
            font-size: 11px; color: var(--od-blue);
            background: var(--od-panel); border: 1px solid color-mix(in srgb, var(--od-blue) 28%, transparent);
            border-radius: 6px; padding: 3px 8px; pointer-events: none;
        }
        .od-card-error {
            position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 8px; color: var(--od-ink-dim); font-size: 12.5px; text-align: center; padding: 0 16px;
        }
        .od-card-error i { color: var(--od-amber); font-size: 20px; }
        .od-card-error span { color: var(--od-ink-faint); font-size: 11.5px; word-break: break-all; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
        .od-card-error small { color: var(--od-ink-faint); font-size: 11px; }
        .od-card-new { box-shadow: 0 0 0 1px color-mix(in srgb, var(--od-blue) 24%, transparent), var(--od-shadow); }

        /* 缩放手柄 */
        .od-card-resize-handle { position: absolute; z-index: 5; touch-action: none; }
        .od-card-resize-handle[data-dir='n'] { top: -2px; left: 12px; right: 12px; height: ${RESIZE_HANDLE_THICKNESS}px; cursor: ns-resize; }
        .od-card-resize-handle[data-dir='s'] { bottom: -2px; left: 12px; right: 12px; height: ${RESIZE_HANDLE_THICKNESS}px; cursor: ns-resize; }
        .od-card-resize-handle[data-dir='e'] { right: -2px; top: 12px; bottom: 12px; width: ${RESIZE_HANDLE_THICKNESS}px; cursor: ew-resize; }
        .od-card-resize-handle[data-dir='w'] { left: -2px; top: 12px; bottom: 12px; width: ${RESIZE_HANDLE_THICKNESS}px; cursor: ew-resize; }
        .od-card-resize-handle[data-dir='ne'] { top: -2px; right: -2px; width: 16px; height: 16px; cursor: nesw-resize; }
        .od-card-resize-handle[data-dir='nw'] { top: -2px; left: -2px; width: 16px; height: 16px; cursor: nwse-resize; }
        .od-card-resize-handle[data-dir='se'] { bottom: -2px; right: -2px; width: 16px; height: 16px; cursor: nwse-resize; }
        .od-card-resize-handle[data-dir='sw'] { bottom: -2px; left: -2px; width: 16px; height: 16px; cursor: nesw-resize; }

        /* ---------- 底部 dock ---------- */
        .od-dock-wrap {
            position: fixed; left: 0; right: 0; bottom: var(--od-dock-bottom); z-index: 9000;
            display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none;
        }
        immersive-desktop.od-play .od-dock-wrap { animation: od-fade-up 0.42s 0.08s var(--od-ease-out) both; }
        immersive-desktop.od-play .od-topbar { animation: od-fade-down 0.34s 0.04s var(--od-ease-out) both; }
        @keyframes od-fade-down { from { opacity: 0; transform: translateY(-6px); } }
        @keyframes od-fade-up { from { opacity: 0; transform: translateY(10px); } }
        .od-dock {
            position: relative; width: min(760px, 92vw); height: var(--od-dock-height); border-radius: 999px;
            display: flex; align-items: center; gap: 6px; padding: 5px;
            background: color-mix(in srgb, var(--od-panel) 94%, transparent); border: 1px solid var(--od-card-border);
            backdrop-filter: blur(18px); box-shadow: 0 1px 2px rgba(28, 25, 23, 0.04), 0 12px 34px rgba(28, 25, 23, 0.1);
            transition: box-shadow 0.18s ease, border-color 0.18s ease; pointer-events: auto;
        }
        immersive-desktop.theme-dark .od-dock { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.36), 0 16px 38px rgba(0, 0, 0, 0.28); }
        .od-dock:focus-within { border-color: color-mix(in srgb, var(--od-blue) 48%, var(--od-card-border)); box-shadow: 0 0 0 3px var(--od-accent-soft), 0 12px 34px rgba(28, 25, 23, 0.1); }
        .od-task-input { flex: 1; height: 100%; background: none; border: none; outline: none; color: var(--od-ink); font-size: 13.5px; font-family: inherit; min-width: 0; }
        .od-task-input::placeholder { color: var(--od-ink-faint); }
        .od-icon-btn {
            width: 40px; height: 40px; border-radius: 50%; border: none; background: transparent;
            color: var(--od-ink-dim); cursor: pointer; display: flex; align-items: center; justify-content: center;
            transition: 0.15s ease; flex: none;
        }
        .od-icon-btn svg { width: 16px; height: 16px; }
        .od-icon-btn:hover, .od-icon-btn.active { background: var(--od-hover); color: var(--od-ink); }
        .od-send {
            width: 40px; height: 40px; border-radius: 50%; border: none; cursor: pointer;
            background: var(--od-blue); color: #fff;
            display: flex; align-items: center; justify-content: center; flex: none;
            box-shadow: 0 2px 8px color-mix(in srgb, var(--od-blue) 28%, transparent); transition: 0.15s ease; font-size: 14px;
        }
        .od-send:hover:not(:disabled) { filter: brightness(0.96); box-shadow: 0 3px 10px color-mix(in srgb, var(--od-blue) 34%, transparent); }
        .od-send:disabled {
            opacity: 1; cursor: default; box-shadow: none;
            background: var(--od-bg-subtle); color: var(--od-ink-faint);
        }

        /* 最小化窗口 pills */
        .od-minimized { display: flex; gap: 8px; pointer-events: auto; flex-wrap: wrap; justify-content: center; max-width: 80vw; }
        .od-minimized:empty { display: none; }
        .od-minimized-pill {
            display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--od-ink-dim);
            padding: 5px 10px; border-radius: 8px; border: 1px solid var(--od-card-border);
            background: var(--od-panel); cursor: pointer; max-width: 220px; box-shadow: 0 1px 2px rgba(28, 25, 23, 0.04);
        }
        .od-minimized-pill strong { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

        /* ---------- 应用列表浮窗 ---------- */
        /*
         * 层级说明：浮动窗口的 zIndex 由 _zSeed 随每次聚焦/创建无上限递增，
         * 应用列表/右键菜单/设置模态必须始终位于窗口 z 序之上，因此取 9000+。
         */
        .od-applist {
            position: absolute; z-index: 9000; bottom: calc(100% + 8px); left: 5px;
            width: 220px; max-width: calc(100vw - 28px); max-height: min(360px, calc(100vh - 96px));
            padding: 8px; border-radius: 12px; border: 1px solid var(--od-card-border);
            background: var(--od-panel); box-shadow: 0 12px 40px -8px rgba(0, 0, 0, 0.12), 0 4px 12px -2px rgba(0, 0, 0, 0.06);
            display: flex; flex-direction: column; overflow-y: auto;
            animation: od-pop-in 0.16s ease-out both; transform-origin: 20px 100%;
        }
        .od-applist::-webkit-scrollbar { width: 4px; }
        .od-applist::-webkit-scrollbar-track { background: transparent; }
        .od-applist::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 2px; }
        .od-applist::-webkit-scrollbar-thumb:hover { background: #9ca3af; }
        immersive-desktop.theme-dark .od-applist::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.18); }
        immersive-desktop.theme-dark .od-applist::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.28); }
        @keyframes od-pop-in { from { opacity: 0; transform: translateY(4px); } }
        .od-applist[hidden] { display: none; }
        .od-applist-grid {
            display: flex; flex-direction: column; gap: 2px;
        }
        .od-applist-item {
            display: flex; flex-direction: row; align-items: center; gap: 10px; width: 100%;
            padding: 7px 8px; border-radius: 8px; cursor: pointer; border: none; background: transparent;
            color: var(--od-ink-dim); font-family: inherit; text-align: left; transition: background 0.12s ease;
        }
        .od-applist-item:hover { background: var(--od-hover); color: var(--od-ink); }
        .od-applist-item:active { transform: scale(0.98); }
        .od-applist-icon { width: 14px; height: 14px; border-radius: 4px; flex: none; }
        .od-applist-icon img { width: 100%; height: 100%; border-radius: 4px; object-fit: cover; }
        immersive-desktop.theme-dark .od-applist-icon img.od-app-icon-svg { filter: invert(1); }
        .od-applist-label { min-width: 0; font-size: var(--fs-base, 13px); color: var(--od-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .od-applist-empty { padding: 10px 8px; color: var(--od-ink-faint); font-size: 12.5px; }

        /* ---------- 浮动应用窗口 ---------- */
        .od-floating-window {
            position: fixed; z-index: 30; display: flex; flex-direction: column;
            border-radius: 12px; border: 1px solid var(--od-card-border);
            background: var(--od-panel); box-shadow: 0 1px 2px rgba(28, 25, 23, 0.08), 0 18px 48px rgba(28, 25, 23, 0.16);
            overflow: hidden; min-width: 320px; min-height: 220px;
        }
        /* 入场动画绑定一次性类：最小化恢复（display 切换）不会重播 */
        .od-floating-window.od-window-enter { animation: od-window-in 0.24s var(--od-ease-out) both; }
        @keyframes od-window-in { from { opacity: 0; transform: translateY(8px) scale(0.99); } }
        .od-floating-window[hidden] { display: none; }
        .od-floating-window-titlebar {
            flex: none; display: flex; align-items: center; justify-content: space-between; gap: 10px;
            min-height: 38px; padding: 5px 7px 5px 12px; cursor: grab;
            border-bottom: 1px solid var(--od-card-line); background: var(--od-panel-muted);
        }
        .od-floating-window-title { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--od-ink-dim); min-width: 0; }
        .od-floating-window-title img { width: 16px; height: 16px; border-radius: 4px; object-fit: contain; }
        .od-floating-window-title strong { font-weight: 600; color: var(--od-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .od-floating-window-controls { display: flex; align-items: center; gap: 4px; }
        .od-floating-window-controls button {
            width: 26px; height: 26px; border-radius: 7px; border: none; background: transparent;
            color: var(--od-ink-dim); cursor: pointer; font-size: 11px;
            display: flex; align-items: center; justify-content: center; transition: 0.15s ease;
        }
        .od-floating-window-controls button:hover { background: var(--od-hover); color: var(--od-ink); }
        .od-floating-window-controls button[data-window-close]:hover { background: color-mix(in srgb, var(--od-red) 11%, transparent); color: var(--od-red); }
        .od-floating-window-content { flex: 1; min-width: 0; min-height: 0; position: relative; overflow: hidden; background: var(--od-bg); }
        .od-floating-window-content > iframe, .od-floating-window-content > browser-entry-widget { width: 100%; height: 100%; border: none; display: block; }
        .od-floating-window-content > task-view {
            display: block; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden;
        }
        .od-window-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--od-ink-faint); font-size: 13px; }
        .od-spinner {
            width: 14px; height: 14px; border-radius: 50%;
            border: 2px solid color-mix(in srgb, var(--od-blue) 20%, transparent); border-top-color: var(--od-blue);
            animation: od-rot 0.9s linear infinite; flex: none;
        }
        @keyframes od-rot { to { transform: rotate(360deg); } }
        .od-window-resize-handle { position: absolute; z-index: 5; }
        .od-window-resize-handle[data-dir='n'] { top: -3px; left: 12px; right: 12px; height: ${RESIZE_HANDLE_THICKNESS}px; cursor: ns-resize; }
        .od-window-resize-handle[data-dir='e'] { right: -3px; top: 12px; bottom: 12px; width: ${RESIZE_HANDLE_THICKNESS}px; cursor: ew-resize; }
        .od-window-resize-handle[data-dir='w'] { left: -3px; top: 12px; bottom: 12px; width: ${RESIZE_HANDLE_THICKNESS}px; cursor: ew-resize; }
        .od-window-resize-handle[data-dir='s'] { bottom: -3px; left: 12px; right: 12px; height: ${RESIZE_HANDLE_THICKNESS}px; cursor: ns-resize; }
        .od-window-resize-handle[data-dir='se'] { bottom: -3px; right: -3px; width: 18px; height: 18px; cursor: nwse-resize; }
        .od-window-resize-handle[data-dir='sw'] { bottom: -3px; left: -3px; width: 18px; height: 18px; cursor: nesw-resize; }
        .od-window-resize-handle[data-dir='ne'] { top: -3px; right: -3px; width: 18px; height: 18px; cursor: nesw-resize; }
        .od-window-resize-handle[data-dir='nw'] { top: -3px; left: -3px; width: 18px; height: 18px; cursor: nwse-resize; }

        /* ---------- 右键菜单 ---------- */
        .od-context-menu {
            position: fixed; z-index: 9200; min-width: 180px; padding: 5px;
            border-radius: 12px; border: 1px solid var(--od-card-border);
            background: var(--od-panel); box-shadow: var(--od-shadow);
            animation: od-menu-in 0.16s var(--od-ease-out) both;
            transform-origin: 0 0;
        }
        @keyframes od-menu-in { from { opacity: 0; transform: translateY(-3px) scale(0.98); } }
        .od-context-menu[hidden] { display: none; }
        .od-context-item {
            display: flex; align-items: center; gap: 10px; width: 100%;
            padding: 7px 10px; border: none; border-radius: 7px; background: transparent;
            color: var(--od-ink-dim); font-size: 12.5px; cursor: pointer; text-align: left; font-family: inherit;
            transition: background 0.12s ease, color 0.12s ease;
        }
        .od-context-item:hover { background: var(--od-hover); color: var(--od-ink); }
        .od-context-item i { width: 16px; text-align: center; color: var(--od-ink-dim); font-size: 12.5px; }
        .od-context-item.danger { color: var(--od-red); }
        .od-context-item.danger i { color: var(--od-red); }
        .od-context-item:disabled { opacity: 0.4; cursor: default; }
        .od-context-item:disabled:hover { background: transparent; }
        .od-context-sep { height: 1px; background: var(--od-card-line); margin: 4px 8px; }

        /* ---------- 卡片设置模态 ---------- */
        .od-modal-overlay {
            position: fixed; inset: 0; z-index: 9400; display: flex; align-items: center; justify-content: center;
            background: color-mix(in srgb, var(--od-ink) 24%, transparent); backdrop-filter: blur(4px);
            animation: od-fade-in 0.2s ease-out both;
        }
        @keyframes od-fade-in { from { opacity: 0; } }
        .od-modal {
            width: min(480px, 92vw); border-radius: 16px; padding: 22px;
            background: var(--od-panel); border: 1px solid var(--od-card-border);
            box-shadow: 0 24px 64px rgba(28, 25, 23, 0.24);
            display: flex; flex-direction: column; gap: 14px;
            animation: od-modal-in 0.24s var(--od-ease-out) both;
        }
        @keyframes od-modal-in { from { opacity: 0; transform: translateY(10px) scale(0.99); } }
        .od-modal h2 { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .od-modal h2 .dot { width: 7px; height: 7px; border-radius: 2px; background: var(--od-blue); }
        .od-modal label { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; color: var(--od-ink-dim); }
        .od-modal textarea, .od-modal select {
            border-radius: 9px; border: 1px solid var(--od-card-line); background: var(--od-bg);
            color: var(--od-ink); font-family: inherit; font-size: 13.5px; padding: 10px 12px; outline: none;
        }
        .od-modal textarea { min-height: 110px; resize: vertical; }
        .od-modal textarea:focus, .od-modal select:focus { border-color: color-mix(in srgb, var(--od-blue) 52%, var(--od-card-line)); box-shadow: 0 0 0 3px var(--od-accent-soft); }
        .od-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 2px; }
        .od-btn {
            padding: 8px 14px; border-radius: 8px; border: 1px solid var(--od-card-line);
            background: transparent; color: var(--od-ink-dim); font-size: 13px; cursor: pointer; font-family: inherit; transition: 0.15s ease;
        }
        .od-btn:hover { color: var(--od-ink); border-color: var(--od-ink-faint); }
        .od-btn.primary {
            border-color: transparent; color: #fff; background: var(--od-blue);
            box-shadow: 0 2px 8px color-mix(in srgb, var(--od-blue) 26%, transparent);
        }
        .od-btn.primary:hover { filter: brightness(0.96); color: #fff; }

        @media (max-width: 720px) {
            .od-brand em { display: none; }
            .od-clock-chip { display: none; }
            .od-dock { width: calc(100vw - 28px); }
        }
    </style>`;
}
