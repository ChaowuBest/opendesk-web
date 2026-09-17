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

import { RESIZE_HANDLE_THICKNESS } from './cardLayout.js';

/** 沉浸桌面组件样式（晨光玻璃视觉：浅色极光背景 + 白色磨砂玻璃卡片 + 圆角 dock）。 */
export function buildDesktopStyles(): string {
    return `
    <style>
        immersive-desktop {
            --od-bg: #f5f6f8;
            --od-ink: #191b1f;
            --od-ink-dim: rgba(25, 27, 31, 0.56);
            --od-ink-faint: rgba(25, 27, 31, 0.34);
            --od-card: rgba(255, 255, 255, 0.62);
            --od-card-hi: rgba(255, 255, 255, 0.85);
            --od-card-border: rgba(255, 255, 255, 0.9);
            --od-card-line: rgba(25, 39, 70, 0.07);
            --od-blue: #3d6fff;
            --od-violet: #7c5cff;
            --od-green: #10b981;
            --od-amber: #f59e0b;
            --od-red: #ef4444;
            --od-shadow: 0 18px 50px rgba(31, 41, 66, 0.08), 0 2px 8px rgba(31, 41, 66, 0.03);
            --od-panel: rgba(255, 255, 255, 0.82);
        }
        immersive-desktop.theme-dark {
            --od-bg: #12141a;
            --od-ink: #e8eaf0;
            --od-ink-dim: rgba(232, 234, 240, 0.6);
            --od-ink-faint: rgba(232, 234, 240, 0.36);
            --od-card: rgba(38, 42, 54, 0.62);
            --od-card-hi: rgba(48, 53, 68, 0.85);
            --od-card-border: rgba(255, 255, 255, 0.14);
            --od-card-line: rgba(255, 255, 255, 0.08);
            --od-shadow: 0 18px 50px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.3);
            --od-panel: rgba(32, 36, 46, 0.9);
        }
        immersive-desktop, immersive-desktop * { margin: 0; padding: 0; box-sizing: border-box; }
        immersive-desktop {
            position: fixed; inset: 0; z-index: 50000;
            background: var(--od-bg); color: var(--od-ink);
            font-family: -apple-system, 'SF Pro SC', 'PingFang SC', 'Microsoft YaHei UI', 'Segoe UI', sans-serif;
            overflow: hidden; -webkit-font-smoothing: antialiased;
            opacity: 0; transform: scale(0.965);
            transition: opacity 420ms cubic-bezier(0.16, 1, 0.3, 1), transform 420ms cubic-bezier(0.16, 1, 0.3, 1);
            user-select: none;
        }
        immersive-desktop.od-active { opacity: 1; transform: scale(1); }
        immersive-desktop.od-leaving { opacity: 0; transform: scale(0.96); pointer-events: none; }

        /* ---------- 背景：浅色极光 ---------- */
        .od-bg { position: fixed; inset: 0; z-index: 0; overflow: hidden; }
        .od-blob { position: absolute; border-radius: 50%; filter: blur(100px); }
        .od-blob-1 { width: 52vw; height: 52vw; left: -12vw; top: -18vw; background: radial-gradient(circle, rgba(147, 183, 255, 0.5) 0%, transparent 65%); animation: od-drift1 26s ease-in-out infinite alternate; }
        .od-blob-2 { width: 44vw; height: 44vw; right: -10vw; top: 4vh; background: radial-gradient(circle, rgba(196, 173, 255, 0.42) 0%, transparent 65%); animation: od-drift2 32s ease-in-out infinite alternate; }
        .od-blob-3 { width: 40vw; height: 40vw; left: 28vw; bottom: -22vh; background: radial-gradient(circle, rgba(255, 205, 176, 0.4) 0%, transparent 65%); animation: od-drift3 38s ease-in-out infinite alternate; }
        .od-blob-4 { width: 30vw; height: 30vw; right: 16vw; bottom: -10vh; background: radial-gradient(circle, rgba(163, 230, 208, 0.36) 0%, transparent 65%); animation: od-drift1 30s ease-in-out infinite alternate-reverse; }
        immersive-desktop.theme-dark .od-blob-1 { background: radial-gradient(circle, rgba(76, 106, 190, 0.4) 0%, transparent 65%); }
        immersive-desktop.theme-dark .od-blob-2 { background: radial-gradient(circle, rgba(118, 92, 220, 0.34) 0%, transparent 65%); }
        immersive-desktop.theme-dark .od-blob-3 { background: radial-gradient(circle, rgba(190, 128, 80, 0.26) 0%, transparent 65%); }
        immersive-desktop.theme-dark .od-blob-4 { background: radial-gradient(circle, rgba(52, 158, 128, 0.28) 0%, transparent 65%); }
        @keyframes od-drift1 { to { transform: translate(7vw, 5vh) scale(1.12); } }
        @keyframes od-drift2 { to { transform: translate(-6vw, 7vh) scale(0.92); } }
        @keyframes od-drift3 { to { transform: translate(-7vw, -5vh) scale(1.16); } }

        .od-bloom {
            position: fixed; inset: -20%; z-index: 50; pointer-events: none; opacity: 0;
            background: radial-gradient(circle at 50% 42%, rgba(255, 255, 255, 0.95), rgba(185, 208, 255, 0.4) 32%, transparent 62%);
        }
        immersive-desktop.theme-dark .od-bloom { background: radial-gradient(circle at 50% 42%, rgba(210, 225, 255, 0.55), rgba(120, 130, 255, 0.3) 32%, transparent 62%); }
        immersive-desktop.od-play .od-bloom { animation: od-bloom 1.4s ease-out both; }
        @keyframes od-bloom { 0% { opacity: 0; transform: scale(0.35); } 22% { opacity: 1; } 100% { opacity: 0; transform: scale(1.65); } }

        /* ---------- 骨架布局 ---------- */
        .od-app {
            position: relative; z-index: 1; height: 100vh;
            display: flex; flex-direction: column; gap: 14px;
            padding: 16px 22px 132px;
        }
        .od-topbar { display: flex; align-items: center; justify-content: space-between; }
        .od-brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 15px; letter-spacing: 0.01em; }
        /* 品牌桌面图标：灰色描边，与主界面侧边栏图标同风格 */
        .od-brand-icon { width: 17px; height: 17px; color: var(--od-ink-dim); flex: none; }
        .od-brand em { font-style: normal; color: var(--od-ink-dim); font-weight: 400; font-size: 13px; }
        .od-status { display: flex; align-items: center; gap: 8px; color: var(--od-ink-dim); font-size: 12.5px; }
        .od-chip { padding: 5px 12px; border-radius: 999px; border: 1px solid var(--od-card-border); background: var(--od-card); backdrop-filter: blur(16px); box-shadow: 0 2px 10px rgba(31, 41, 66, 0.05); }
        /* 顶栏"添加卡片"按钮：虚线边框呼应原 ghost 的视觉语言 */
        .od-add-card-btn {
            display: inline-flex; align-items: center; gap: 6px;
            border-style: dashed; border-color: rgba(25, 39, 70, 0.22);
            color: var(--od-ink-dim); font-size: 12.5px; font-family: inherit;
            cursor: pointer; padding: 5px 12px; transition: 0.2s;
        }
        .od-add-card-btn i { font-size: 11px; }
        .od-add-card-btn:hover {
            color: var(--od-ink); border-color: rgba(61, 111, 255, 0.5);
            background: rgba(61, 111, 255, 0.08);
            box-shadow: 0 4px 14px rgba(61, 111, 255, 0.12);
        }
        .od-refresh-chip { display: inline-flex; align-items: center; gap: 7px; color: var(--od-violet); }
        .od-refresh-chip[hidden] { display: none; }
        .od-icon-ghost {
            width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--od-card-border);
            background: var(--od-card); color: var(--od-ink-dim); cursor: pointer; font-size: 13px;
            display: flex; align-items: center; justify-content: center; transition: 0.25s;
        }
        .od-icon-ghost:hover { color: var(--od-ink); border-color: rgba(239, 68, 68, 0.45); transform: scale(1.08); }
        .od-icon-ghost.od-theme-toggle:hover {
            border-color: rgba(61, 111, 255, 0.45); background: rgba(61, 111, 255, 0.08);
        }

        /* ---------- 网格与卡片 ---------- */
        /* 网格仅用于吸附定位，不绘制可见网格线 */
        .od-stage {
            flex: 1; min-height: 0; position: relative;
            border-radius: 22px;
        }
        .od-empty-state {
            position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
            padding: 24px; text-align: center; color: var(--od-ink-faint); font-size: 14px;
            pointer-events: none;
        }
        .od-empty-state[hidden] { display: none; }
        .od-card {
            position: absolute; overflow: hidden; min-width: 40px; min-height: 40px;
            border-radius: 22px; border: 1px solid var(--od-card-border);
            background: var(--od-card); backdrop-filter: blur(24px) saturate(1.5);
            box-shadow: var(--od-shadow);
            display: flex; flex-direction: column;
            transition: left 140ms ease-out, top 140ms ease-out, width 140ms ease-out, height 140ms ease-out, background 0.3s, box-shadow 0.3s;
        }
        .od-card.od-card-enter { animation: od-card-in 0.9s cubic-bezier(0.16, 1, 0.3, 1) both; animation-delay: calc(0.18s + var(--od-i, 0) * 0.07s); }
        @keyframes od-card-in { from { opacity: 0; transform: translateY(38px) scale(0.97); filter: blur(18px); } to { opacity: 1; transform: none; filter: blur(0); } }
        .od-card.od-card-dragging, .od-card.od-card-resizing {
            transition: none; animation: none !important; opacity: 0.92; z-index: 60 !important;
            box-shadow: 0 30px 80px rgba(31, 41, 66, 0.22);
        }
        /* 拖动/缩放时屏蔽 iframe 吞掉指针事件 */
        .od-card.od-card-dragging .od-card-frame, .od-card.od-card-resizing .od-card-frame { pointer-events: none; }
        /* 悬停玻璃提亮（对齐设计稿），不做位移以免与拖动定位相互干扰 */
        .od-card:hover { background: var(--od-card-hi); }
        /* 任何拖动/缩放交互期间，指针进入其它卡片或应用窗口的 iframe/webview 时事件不能被其文档吞掉 */
        immersive-desktop.od-interacting iframe, immersive-desktop.od-interacting webview { pointer-events: none !important; }
        /* 动效敏感用户：停掉装饰性无限动画与交错入场 */
        @media (prefers-reduced-motion: reduce) {
            immersive-desktop { transition: opacity 200ms ease; transform: none; }
            immersive-desktop:focus { outline: none; }
            .od-blob { animation: none !important; }
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
            background: rgba(16, 185, 129, 0.08); border-radius: 999px; padding: 2px 8px;
            letter-spacing: 0.12em; font-weight: 600;
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
            border: none; background: rgba(61, 111, 255, 0.08); color: var(--od-blue);
            font-size: 12px; border-radius: 999px; padding: 5px 14px; cursor: pointer;
            font-family: inherit; transition: 0.2s;
        }
        .od-error-task-link:hover { background: rgba(61, 111, 255, 0.16); }
        .od-card-body { flex: 1; min-height: 0; position: relative; margin: 8px 6px 6px; overflow: hidden; }
        .od-card.od-card-done .od-card-body { margin: 0; }
        .od-card-frame { width: 100%; height: 100%; border: none; background: transparent; }
        .od-card-hint {
            position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 10px; color: var(--od-ink-faint); font-size: 13px; text-align: center; padding: 0 18px;
        }
        .od-card-hint i { font-size: 26px; opacity: 0.6; }
        .od-gen-head { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--od-ink-dim); padding: 10px 16px 0; }
        .od-pulse-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--od-violet); animation: od-pulse 1.4s ease-in-out infinite; flex: none; }
        @keyframes od-pulse { 0%, 100% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1.1); } }
        .od-sk-lines { flex: 1; display: flex; flex-direction: column; gap: 10px; justify-content: center; padding: 0 22px 16px; }
        .od-sk-line { height: 12px; border-radius: 6px; background: linear-gradient(90deg, rgba(25, 39, 70, 0.05), rgba(25, 39, 70, 0.13), rgba(25, 39, 70, 0.05)); background-size: 220% 100%; animation: od-shimmer-x 1.3s linear infinite; }
        immersive-desktop.theme-dark .od-sk-line { background: linear-gradient(90deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.05)); background-size: 220% 100%; }
        @keyframes od-shimmer-x { 0% { background-position: 120% 0; } 100% { background-position: -120% 0; } }
        .od-card-updating {
            position: absolute; top: 8px; right: 10px; z-index: 3;
            display: flex; align-items: center; gap: 6px;
            font-size: 11px; color: var(--od-violet);
            background: var(--od-panel); border: 1px solid rgba(124, 92, 255, 0.35);
            border-radius: 999px; padding: 3px 10px; pointer-events: none;
        }
        .od-card-error {
            position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 8px; color: var(--od-ink-dim); font-size: 12.5px; text-align: center; padding: 0 16px;
        }
        .od-card-error i { color: var(--od-amber); font-size: 20px; }
        .od-card-error span { color: var(--od-ink-faint); font-size: 11.5px; word-break: break-all; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
        .od-card-error small { color: var(--od-ink-faint); font-size: 11px; }
        .od-card-new { box-shadow: 0 18px 50px rgba(124, 92, 255, 0.14); }

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
            position: fixed; left: 0; right: 0; bottom: 26px; z-index: 5;
            display: flex; flex-direction: column; align-items: center; gap: 10px; pointer-events: none;
        }
        immersive-desktop.od-play .od-dock-wrap { animation: od-fade-up 0.9s 0.45s cubic-bezier(0.16, 1, 0.3, 1) both; }
        immersive-desktop.od-play .od-topbar { animation: od-fade-down 0.8s 0.12s cubic-bezier(0.16, 1, 0.3, 1) both; }
        @keyframes od-fade-down { from { opacity: 0; transform: translateY(-16px); } }
        @keyframes od-fade-up { from { opacity: 0; transform: translateY(26px); } }
        .od-suggests { display: flex; gap: 8px; pointer-events: auto; flex-wrap: wrap; justify-content: center; max-width: 92vw; }
        .od-sug {
            font-size: 12.5px; color: var(--od-ink-dim); padding: 6px 14px; border-radius: 999px;
            border: 1px solid var(--od-card-border); background: rgba(255, 255, 255, 0.66);
            backdrop-filter: blur(12px); cursor: pointer; transition: 0.25s;
            box-shadow: 0 2px 10px rgba(31, 41, 66, 0.05); font-family: inherit;
        }
        immersive-desktop.theme-dark .od-sug { background: rgba(48, 53, 68, 0.66); }
        .od-sug:hover { color: var(--od-ink); border-color: rgba(61, 111, 255, 0.45); box-shadow: 0 6px 18px rgba(61, 111, 255, 0.12); }
        .od-dock {
            width: min(760px, 92vw); height: 58px; border-radius: 999px;
            display: flex; align-items: center; gap: 6px; padding: 0 10px 0 12px;
            background: rgba(255, 255, 255, 0.78); border: 1px solid var(--od-card-border);
            backdrop-filter: blur(28px) saturate(1.6);
            box-shadow: 0 22px 60px rgba(31, 41, 66, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.9);
            transition: box-shadow 0.3s, border-color 0.3s; pointer-events: auto;
        }
        immersive-desktop.theme-dark .od-dock { background: rgba(40, 44, 56, 0.82); box-shadow: 0 22px 60px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.08); }
        .od-dock:focus-within { border-color: rgba(61, 111, 255, 0.5); box-shadow: 0 22px 60px rgba(31, 41, 66, 0.14), 0 0 0 4px rgba(61, 111, 255, 0.1); }
        .od-task-input { flex: 1; background: none; border: none; outline: none; color: var(--od-ink); font-size: 14.5px; font-family: inherit; min-width: 0; }
        .od-task-input::placeholder { color: var(--od-ink-faint); }
        .od-icon-btn {
            width: 38px; height: 38px; border-radius: 50%; border: none; background: transparent;
            color: var(--od-ink-dim); cursor: pointer; display: flex; align-items: center; justify-content: center;
            transition: 0.2s; flex: none; font-size: 15px;
        }
        .od-icon-btn:hover, .od-icon-btn.active { background: rgba(25, 39, 70, 0.06); color: var(--od-ink); }
        immersive-desktop.theme-dark .od-icon-btn:hover, immersive-desktop.theme-dark .od-icon-btn.active { background: rgba(255, 255, 255, 0.1); }
        .od-send {
            width: 40px; height: 40px; border-radius: 50%; border: none; cursor: pointer;
            background: linear-gradient(135deg, var(--od-blue), var(--od-violet)); color: #fff;
            display: flex; align-items: center; justify-content: center; flex: none;
            box-shadow: 0 6px 20px rgba(61, 111, 255, 0.4); transition: 0.25s; font-size: 15px;
        }
        .od-send:hover:not(:disabled) { transform: scale(1.08); box-shadow: 0 8px 26px rgba(61, 111, 255, 0.5); }
        .od-send:disabled { opacity: 0.45; cursor: default; box-shadow: none; }

        /* 最小化窗口 pills */
        .od-minimized { display: flex; gap: 8px; pointer-events: auto; flex-wrap: wrap; justify-content: center; max-width: 80vw; }
        .od-minimized:empty { display: none; }
        .od-minimized-pill {
            display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--od-ink-dim);
            padding: 5px 12px; border-radius: 999px; border: 1px solid var(--od-card-border);
            background: var(--od-panel); cursor: pointer; max-width: 220px;
        }
        .od-minimized-pill strong { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

        /* ---------- 应用列表浮窗 ---------- */
        /*
         * 层级说明：浮动窗口的 zIndex 由 _zSeed 随每次聚焦/创建无上限递增，
         * 应用列表/右键菜单/设置模态必须始终位于窗口 z 序之上，因此取 9000+。
         */
        .od-applist {
            position: fixed; z-index: 9000; bottom: 108px; left: 50%; transform: translateX(-50%);
            width: 480px; max-width: 92vw; max-height: 46vh;
            border-radius: 20px; border: 1px solid var(--od-card-border);
            background: var(--od-panel); backdrop-filter: blur(28px) saturate(1.6);
            box-shadow: 0 22px 60px rgba(31, 41, 66, 0.2);
            display: flex; flex-direction: column; overflow: hidden;
            animation: od-pop-in 0.22s cubic-bezier(0.16, 1, 0.3, 1) both;
            transform-origin: 50% 100%;
        }
        @keyframes od-pop-in { from { opacity: 0; transform: translateX(-50%) translateY(10px) scale(0.97); } }
        .od-applist[hidden] { display: none; }
        .od-applist-head {
            display: flex; align-items: center; justify-content: space-between;
            padding: 12px 16px 8px; font-size: 13px; font-weight: 600; color: var(--od-ink-dim);
        }
        .od-applist-grid {
            display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px;
            padding: 4px 12px 14px; overflow-y: auto;
        }
        .od-applist-item {
            display: flex; flex-direction: column; align-items: center; gap: 6px;
            padding: 10px 4px; border-radius: 14px; cursor: pointer; border: none; background: transparent;
            color: var(--od-ink-dim); font-size: 11.5px; font-family: inherit; transition: 0.2s;
        }
        .od-applist-item:hover { background: rgba(61, 111, 255, 0.08); color: var(--od-ink); }
        .od-applist-item img, .od-applist-item .fallback { width: 34px; height: 34px; border-radius: 10px; object-fit: contain; }
        .od-applist-item .fallback { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, rgba(61, 111, 255, 0.16), rgba(124, 92, 255, 0.16)); color: var(--od-blue); font-size: 15px; }
        .od-applist-item span { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .od-applist-empty { padding: 18px; text-align: center; color: var(--od-ink-faint); font-size: 12.5px; }

        /* ---------- 浮动应用窗口 ---------- */
        .od-floating-window {
            position: fixed; z-index: 30; display: flex; flex-direction: column;
            border-radius: 18px; border: 1px solid var(--od-card-border);
            background: var(--od-panel); backdrop-filter: blur(28px) saturate(1.6);
            box-shadow: 0 24px 70px rgba(31, 41, 66, 0.25);
            overflow: hidden; min-width: 320px; min-height: 220px;
        }
        /* 入场动画绑定一次性类：最小化恢复（display 切换）不会重播 */
        .od-floating-window.od-window-enter { animation: od-window-in 0.24s cubic-bezier(0.16, 1, 0.3, 1) both; }
        @keyframes od-window-in { from { opacity: 0; transform: translateY(14px) scale(0.98); } }
        .od-floating-window[hidden] { display: none; }
        .od-floating-window-titlebar {
            flex: none; display: flex; align-items: center; justify-content: space-between; gap: 10px;
            padding: 8px 10px 8px 14px; cursor: grab; border-bottom: 1px solid var(--od-card-line);
        }
        .od-floating-window-title { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--od-ink-dim); min-width: 0; }
        .od-floating-window-title img { width: 16px; height: 16px; border-radius: 4px; object-fit: contain; }
        .od-floating-window-title strong { font-weight: 600; color: var(--od-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .od-floating-window-controls { display: flex; align-items: center; gap: 4px; }
        .od-floating-window-controls button {
            width: 26px; height: 26px; border-radius: 50%; border: none; background: transparent;
            color: var(--od-ink-dim); cursor: pointer; font-size: 11px;
            display: flex; align-items: center; justify-content: center; transition: 0.2s;
        }
        .od-floating-window-controls button:hover { background: rgba(25, 39, 70, 0.08); color: var(--od-ink); }
        immersive-desktop.theme-dark .od-floating-window-controls button:hover { background: rgba(255, 255, 255, 0.12); }
        .od-floating-window-controls button[data-window-close]:hover { background: rgba(239, 68, 68, 0.12); color: var(--od-red); }
        .od-floating-window-content { flex: 1; min-height: 0; position: relative; background: var(--od-bg); }
        .od-floating-window-content > iframe, .od-floating-window-content > browser-entry-widget { width: 100%; height: 100%; border: none; display: block; }
        .od-window-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--od-ink-faint); font-size: 13px; }
        .od-spinner {
            width: 14px; height: 14px; border-radius: 50%;
            border: 2px solid rgba(61, 111, 255, 0.2); border-top-color: var(--od-blue);
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
            position: fixed; z-index: 9200; min-width: 180px; padding: 6px;
            border-radius: 14px; border: 1px solid var(--od-card-border);
            background: var(--od-panel); backdrop-filter: blur(28px) saturate(1.6);
            box-shadow: 0 18px 50px rgba(31, 41, 66, 0.2);
            animation: od-menu-in 0.16s cubic-bezier(0.16, 1, 0.3, 1) both;
            transform-origin: 0 0;
        }
        @keyframes od-menu-in { from { opacity: 0; transform: scale(0.96); } }
        .od-context-menu[hidden] { display: none; }
        .od-context-item {
            display: flex; align-items: center; gap: 10px; width: 100%;
            padding: 8px 12px; border: none; border-radius: 9px; background: transparent;
            color: var(--od-ink); font-size: 13px; cursor: pointer; text-align: left; font-family: inherit;
        }
        .od-context-item:hover { background: rgba(61, 111, 255, 0.08); }
        .od-context-item i { width: 16px; text-align: center; color: var(--od-ink-dim); font-size: 12.5px; }
        .od-context-item.danger { color: var(--od-red); }
        .od-context-item.danger i { color: var(--od-red); }
        .od-context-item:disabled { opacity: 0.4; cursor: default; }
        .od-context-item:disabled:hover { background: transparent; }
        .od-context-sep { height: 1px; background: var(--od-card-line); margin: 4px 8px; }

        /* ---------- 卡片设置模态 ---------- */
        .od-modal-overlay {
            position: fixed; inset: 0; z-index: 9400; display: flex; align-items: center; justify-content: center;
            background: rgba(25, 39, 70, 0.24); backdrop-filter: blur(6px);
            animation: od-fade-in 0.2s ease-out both;
        }
        @keyframes od-fade-in { from { opacity: 0; } }
        .od-modal {
            width: min(480px, 92vw); border-radius: 22px; padding: 24px;
            background: var(--od-panel); border: 1px solid var(--od-card-border);
            box-shadow: 0 30px 80px rgba(31, 41, 66, 0.3);
            display: flex; flex-direction: column; gap: 14px;
            animation: od-modal-in 0.28s cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        @keyframes od-modal-in { from { opacity: 0; transform: translateY(18px) scale(0.97); } }
        .od-modal h2 { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
        .od-modal h2 .dot { width: 8px; height: 8px; border-radius: 3px; background: linear-gradient(135deg, var(--od-blue), var(--od-violet)); }
        .od-modal label { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; color: var(--od-ink-dim); }
        .od-modal textarea, .od-modal select {
            border-radius: 12px; border: 1px solid var(--od-card-line); background: var(--od-bg);
            color: var(--od-ink); font-family: inherit; font-size: 13.5px; padding: 10px 12px; outline: none;
        }
        .od-modal textarea { min-height: 110px; resize: vertical; }
        .od-modal textarea:focus, .od-modal select:focus { border-color: rgba(61, 111, 255, 0.5); box-shadow: 0 0 0 3px rgba(61, 111, 255, 0.1); }
        .od-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 2px; }
        .od-btn {
            padding: 8px 18px; border-radius: 999px; border: 1px solid var(--od-card-line);
            background: transparent; color: var(--od-ink-dim); font-size: 13px; cursor: pointer; font-family: inherit; transition: 0.2s;
        }
        .od-btn:hover { color: var(--od-ink); border-color: var(--od-ink-faint); }
        .od-btn.primary {
            border: none; color: #fff; background: linear-gradient(135deg, var(--od-blue), var(--od-violet));
            box-shadow: 0 6px 20px rgba(61, 111, 255, 0.35);
        }
        .od-btn.primary:hover { box-shadow: 0 8px 26px rgba(61, 111, 255, 0.5); color: #fff; }
    </style>`;
}
