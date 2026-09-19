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

/**
 * 本地网络服务对外提供的聊天页面。
 *
 * 视觉规范与数字员工办公室会话视图（renderer/style.css 的 .chat/.messages/.composer）
 * 保持一致：暖灰底、白面板、珊瑚红点缀、无气泡消息流、HarmonyOS Sans。
 * 正文 HTML 由服务端用与桌面端完全相同的 renderSafeMarkdown 预渲染，
 * 页面本身零第三方依赖，直接以静态模板输出。
 *
 * 注意：本文件内容会被 esbuild（CLI）与 Vite（Electron）共同打包，
 * 页面脚本刻意不使用模板字符串与 "${" 序列，避免嵌套模板转义问题。
 */
const CHAT_PAGE_TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<!-- 显式声明同时适配深浅色，阻止部分 WebView 对页面强制反色 -->
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#252526" media="(prefers-color-scheme: dark)">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%23df4436'/%3E%3Cpath d='M9 11h14v8h-9l-5 4z' fill='%23fff'/%3E%3C/svg%3E">
<title>OpenDesk</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
/* 页面多处用 class 设 display，必须压过 UA 的 [hidden] 规则才能真正隐藏 */
[hidden] { display: none !important; }
.root { -webkit-tap-highlight-color: transparent; color-scheme: light dark; }
/* 选区用半透明品牌色且不翻转文字色，避免深浅主题下出现刺眼高亮块 */
.root ::selection { background: rgba(223, 68, 54, 0.3); }
/* 界面骨架禁止选中：拖选时只有消息正文出现选区，避免满屏碎框 */
.chat-head,
.powered,
.empty-card,
.notice,
.typing,
.load-older,
.scroll-bottom,
.composer-toolbar,
.composer-send-options-panel,
.avatar,
.message-meta time {
    user-select: none;
    -webkit-user-select: none;
}
/* 消息正文保持可选可复制 */
.message-bubble,
.message-markdown {
    user-select: text;
    -webkit-user-select: text;
}
/* 焦点框仅服务键盘导航：半透明品牌色，鼠标点击不触发 */
button:focus-visible {
    outline: 2px solid rgba(223, 68, 54, 0.55);
    outline-offset: 2px;
}
/* 输入框的聚焦态由 composer-outer 描边承担（与桌面端一致），不画第二层框 */
.composer-textarea:focus-visible,
.composer-textarea:focus {
    outline: none;
}
:root {
    --fs-2xs: 9px;
    --fs-xs: 10px;
    --fs-sm: 11px;
    --fs-md: 12px;
    --fs-base: 13px;
    --fs-lg: 14px;
    --fs-xl: 16px;
}
.root {
    /* 设计令牌：暖灰底 × 珊瑚红点缀（与办公室会话视图一致，浅色） */
    --page: #eeedeb;
    --surface: #ffffff;
    --muted-surface: #fafafa;
    --ink: #1c1917;
    --ink2: #4a4642;
    --ink3: #79736d;
    --line: #e7e5e2;
    --line-soft: #f0efec;
    --accent: #df4436;
    --accent-ink: #bb352a;
    --accent-soft: #fdeeec;
    --blue: #4267b2;
    --bubble: #f4f3f1;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    color: var(--ink);
    font-family: system-ui, -apple-system, 'Segoe UI', 'HarmonyOS Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    font-size: var(--fs-base);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
}
/* Firefox 滚动条细化（webkit 前缀版本见 .messages 处） */
.messages {
    scrollbar-width: thin;
    scrollbar-color: var(--line) transparent;
}
@media (prefers-color-scheme: dark) {
    .root {
        color-scheme: dark;
        --surface: #252526;
        --muted-surface: #22201e;
        --ink: #efedea;
        --ink2: #d5d1cb;
        --ink3: #aaa49e;
        --line: #3b3835;
        --line-soft: #33302d;
        --accent: #e8563f;
        --accent-ink: #ff9a89;
        --accent-soft: #422c29;
        --blue: #96b5ec;
        --bubble: #33302d;
    }
}
button, input, textarea { font: inherit; color: inherit; }
button { border: 0; cursor: pointer; background: transparent; }
button:disabled { opacity: 0.4; cursor: default; }

.chat {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
    min-width: 0;
    flex: 1;
    background: var(--muted-surface);
}
/* 宽屏下会话列居中（约 880px），窄屏自然占满 */
.chat-head,
.messages,
.composer-wrap {
    width: 100%;
    max-width: 880px;
    margin: 0 auto;
}
.chat-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 22px 28px 15px;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--line-soft);
}
.chat-head-main { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
.chat-who { flex: 1; min-width: 0; }
.chat-title {
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.5px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    color: var(--ink);
}
.pill {
    padding: 3px 9px;
    border-radius: 7px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: var(--fs-xs);
    font-weight: 500;
    letter-spacing: 0;
}
.detail-subtitle {
    font-size: var(--fs-xs);
    color: var(--ink3);
    margin-top: 6px;
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
}
.status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line); flex: none; }
.status-dot.on { background: #238257; }
.status-dot.run { background: var(--accent); }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.powered {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 7px 10px;
    font-size: var(--fs-sm);
    color: var(--ink3);
}
.powered .powered-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--blue); flex: none; }
.avatar {
    width: 35px;
    height: 35px;
    border-radius: 11px;
    object-fit: cover;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 500;
    flex: none;
    font-size: var(--fs-md);
    overflow: hidden;
}
.avatar.lg { width: 44px; height: 44px; border-radius: 13px; font-size: var(--fs-lg); }
.avatar-img { width: 100%; height: 100%; border-radius: inherit; object-fit: cover; display: block; }
.avatar-neutral { background: var(--bubble); color: var(--ink2); }
.av-g1 { background: linear-gradient(135deg, #5b7fbe, #4267b2); }
.av-g2 { background: linear-gradient(135deg, #3d9d74, #238257); }
.av-g3 { background: linear-gradient(135deg, #c08a2e, #996718); }
.av-g4 { background: linear-gradient(135deg, #e8563f, #bb352a); }
@media (prefers-color-scheme: dark) {
    .av-g1 { background: linear-gradient(135deg, #96b5ec, #5f7fc0); }
    .av-g2 { background: linear-gradient(135deg, #67c99b, #3d8f68); }
    .av-g3 { background: linear-gradient(135deg, #dbb068, #a97e35); }
    .av-g4 { background: linear-gradient(135deg, #e8563f, #c2452f); }
}
.messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 24px 28px 7px;
}
.messages::-webkit-scrollbar { width: 6px; height: 6px; }
.messages::-webkit-scrollbar-thumb { border-radius: 3px; background: var(--line); }
.messages::-webkit-scrollbar-thumb:hover { background: var(--ink3); }
.messages::-webkit-scrollbar-track { background: transparent; }
.empty-card { display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; }
.empty-card .avatar { width: 64px; height: 64px; border-radius: 20px; font-size: 24px; margin-bottom: 6px; }
.empty-name { font-size: var(--fs-xl); font-weight: 500; color: var(--ink); }
.empty-hint { font-size: var(--fs-sm); color: var(--ink3); }
.load-older {
    display: block;
    margin: 0 auto 16px;
    padding: 6px 12px;
    font-size: var(--fs-sm);
    color: var(--ink3);
    border: 1px solid var(--line);
    border-radius: 7px;
    background: var(--surface);
}
.load-older:hover { background: var(--bubble); color: var(--ink); }
.empty {
    height: 100%;
    min-height: 220px;
    display: grid;
    place-items: center;
    color: var(--ink3);
    text-align: center;
    font-size: var(--fs-md);
    padding: 35px 14px;
}
.message { display: flex; flex-direction: row; gap: 10px; margin-bottom: 19px; align-items: flex-start; }
.message .avatar { width: 30px; height: 30px; border-radius: 9px; font-size: var(--fs-sm); margin-top: 1px; }
.message-content { max-width: min(82%, 760px); min-width: 0; }
.message-meta {
    font-size: var(--fs-xs);
    color: var(--ink2);
    margin: 0 0 6px;
    display: flex;
    gap: 9px;
    align-items: baseline;
    justify-content: flex-start;
}
.message-meta time { font-size: var(--fs-2xs); color: var(--ink3); }
.msg-copy {
    opacity: 0;
    transition: opacity 0.15s;
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 1px 7px;
    font-size: var(--fs-2xs);
    color: var(--ink3);
    background: var(--surface);
}
.message:hover .msg-copy,
.msg-copy:focus-visible { opacity: 1; }
.msg-copy:hover { color: var(--ink); border-color: var(--ink3); }
@media (hover: none) {
    .msg-copy { opacity: 1; }
}
.message.user .message-meta { color: var(--accent-ink); }
.message-bubble { color: var(--ink2); line-height: 1.8; font-size: var(--fs-md); overflow-wrap: anywhere; min-width: 0; }
.message.error .message-bubble {
    display: inline-block;
    padding: 11px 13px;
    border-radius: 9px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: var(--fs-sm);
    line-height: 1.7;
}
.message.user .message-markdown a { color: var(--accent-ink); text-decoration: underline; }
.message-markdown { min-width: 0; overflow-wrap: anywhere; font-size: var(--fs-md); }
.message-markdown > :first-child { margin-top: 0; }
.message-markdown > :last-child { margin-bottom: 0; }
.message-markdown p { margin: 0 0 0.65em; }
.message-markdown h1, .message-markdown h2, .message-markdown h3,
.message-markdown h4, .message-markdown h5, .message-markdown h6 {
    margin: 1em 0 0.45em;
    line-height: 1.3;
    font-weight: 650;
}
.message-markdown h1 { font-size: 1.25em; }
.message-markdown h2 { font-size: 1.15em; }
.message-markdown h3 { font-size: 1.05em; }
.message-markdown ul, .message-markdown ol { margin: 0.45em 0 0.7em; padding-left: 1.6em; }
.message-markdown li + li { margin-top: 0.2em; }
.message-markdown blockquote { margin: 0.7em 0; padding: 0.15em 0.8em; border-left: 3px solid var(--line); color: var(--ink3); }
.message-markdown code {
    padding: 0.12em 0.35em;
    border-radius: 4px;
    background: var(--bubble);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 0.9em;
}
.message-markdown pre {
    max-width: 100%;
    margin: 0.7em 0;
    padding: 10px 12px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
}
.message-markdown pre code { padding: 0; background: transparent; }
.message-markdown pre::-webkit-scrollbar { width: 6px; height: 6px; }
.message-markdown pre::-webkit-scrollbar-thumb { border-radius: 3px; background: var(--line); }
.message-markdown pre::-webkit-scrollbar-thumb:hover { background: var(--ink3); }
.message-markdown table {
    display: block;
    max-width: 100%;
    margin: 0.7em 0;
    overflow: auto;
    border-collapse: collapse;
    font-size: var(--fs-sm);
}
.message-markdown th, .message-markdown td { padding: 6px 8px; border: 1px solid var(--line); text-align: left; }
.message-markdown th { background: var(--bubble); font-weight: 650; }
.message-markdown a { color: var(--blue); text-decoration: none; }
.message-markdown a:hover { text-decoration: underline; }
.message-markdown hr { margin: 0.8em 0; border: 0; border-top: 1px solid var(--line); }
.message-markdown img {
    display: block;
    max-width: 100%;
    max-height: 320px;
    margin: 0.6em 0;
    border-radius: 8px;
    object-fit: contain;
}
.resource { margin-top: 9px; max-width: 360px; }
.resource img, .resource video {
    max-width: 100%;
    max-height: 260px;
    border-radius: 8px;
    border: 1px solid var(--line);
    display: block;
    background: var(--surface);
}
.resource audio { max-width: 100%; }
.resource a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 8px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--ink2);
    font-size: var(--fs-sm);
    text-decoration: none;
}
.resource a:hover { background: var(--bubble); color: var(--ink); }
.notice { color: var(--accent-ink); font-size: var(--fs-sm); margin: 0 0 8px; }
.composer-wrap {
    position: relative;
    padding: 12px 28px calc(20px + env(safe-area-inset-bottom));
    flex: none;
}
.composer-card.disabled { opacity: 0.55; }
.scroll-bottom {
    position: absolute;
    top: -40px;
    right: 28px;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--surface);
    border: 1px solid var(--line);
    color: var(--ink2);
    display: grid;
    place-items: center;
    box-shadow: 0 4px 14px rgba(28, 25, 23, 0.12);
    transition: color 0.15s, border-color 0.15s;
}
.scroll-bottom:hover { color: var(--ink); border-color: var(--ink3); }
.scroll-bottom svg { width: 14px; height: 14px; }
.typing { display: flex; align-items: center; gap: 5px; padding: 2px 0 6px 40px; }
.typing .tdot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ink3);
    opacity: 0.3;
    animation: tdot-pulse 1.2s ease-in-out infinite;
}
.typing .tdot:nth-child(2) { animation-delay: 0.2s; }
.typing .tdot:nth-child(3) { animation-delay: 0.4s; }
.typing .tlabel { margin-left: 4px; font-size: var(--fs-xs); color: var(--ink3); font-style: normal; }
@keyframes tdot-pulse {
    0%, 100% { opacity: 0.25; transform: translateY(0); }
    50% { opacity: 1; transform: translateY(-2px); }
}
.message-new { animation: message-in 0.22s ease; }
@keyframes message-in {
    from { opacity: 0; transform: translateY(8px); }
}
@media (prefers-reduced-motion: reduce) {
    .message-new { animation: none; }
    .typing .tdot { animation: none; opacity: 0.8; }
}
.composer-outer {
    width: 100%;
    padding: 4px;
    border-radius: 24px;
    background: rgba(255, 255, 255, 0.4);
    border: 1px solid rgba(231, 229, 226, 0.6);
    box-shadow: 0 8px 30px -12px rgba(0, 0, 0, 0.07);
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
@media (prefers-color-scheme: dark) {
    .composer-outer { background: rgba(255, 255, 255, 0.06); border-color: rgba(255, 255, 255, 0.12); }
}
.composer-outer:focus-within { border-color: var(--accent); }
.composer-card { background: var(--surface); border-radius: 20px; padding: 6px 8px 8px; }
.composer-textarea-wrap { padding: 4px 8px 0; }
.composer-textarea {
    width: 100%;
    height: 52px;
    resize: none;
    border: 0;
    outline: none;
    background: transparent;
    padding: 2px 0;
    font-size: var(--fs-md);
    line-height: 1.7;
    color: var(--ink);
    caret-color: var(--accent);
    overflow-y: auto;
}
.composer-textarea::placeholder { color: transparent; }
.composer-textarea:disabled { cursor: not-allowed; color: var(--ink3); }
.composer-placeholder-wrap { position: relative; }
.composer-placeholder {
    position: absolute;
    top: 2px;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 5px;
    pointer-events: none;
    font-size: var(--fs-md);
    line-height: 1.7;
    color: var(--ink3);
    white-space: nowrap;
    overflow: hidden;
    opacity: 1;
    transition: opacity 0.15s ease;
}
.composer-textarea:not(:placeholder-shown) ~ .composer-placeholder { opacity: 0; }
.composer-placeholder-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    color: inherit;
}
.composer-placeholder-icon svg { display: block; width: 100%; height: 100%; }
.composer-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 0 0;
    gap: 8px;
    flex-wrap: nowrap;
}
.composer-toolbar-left {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 0;
}
.composer-toolbar-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.composer-toolbar-control {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    color: var(--ink3);
    transition: background 0.15s ease, color 0.15s ease;
}
.composer-toolbar-control:hover { background: var(--bubble); color: var(--ink); }
.composer-toolbar-control svg { width: 15px; height: 15px; }
.composer-send-divider { width: 1px; height: 16px; background: var(--line); margin: 0 2px; }
.composer-send-menu-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 15px;
    color: var(--ink3);
    background: var(--bubble);
    transition: background 0.15s, color 0.15s;
}
.composer-send-menu-btn.composer-send-active { background: var(--accent); color: #fff; }
.composer-send-menu-btn svg { width: 14px; height: 14px; }
.composer-image-previews {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 0 8px;
}
.composer-image-thumb {
    position: relative;
    width: 56px;
    height: 56px;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--line);
    flex-shrink: 0;
    background: var(--muted-surface);
}
.composer-image-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.composer-image-thumb-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: rgba(28, 25, 23, 0.55);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    line-height: 1;
    opacity: 0;
    transition: opacity 0.12s ease, background 0.12s ease;
}
.composer-image-thumb:hover .composer-image-thumb-remove { opacity: 1; }
.composer-image-thumb-remove:hover { background: var(--accent); }
.composer-send-options-panel {
    position: absolute;
    right: 0;
    bottom: calc(100% + 8px);
    min-width: 190px;
    padding: 6px;
    border-radius: 11px;
    background: var(--surface);
    border: 1px solid var(--line);
    box-shadow: 0 12px 40px rgba(28, 25, 23, 0.18);
    z-index: 30;
}
.composer-send-menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 9px;
    border-radius: 8px;
    cursor: pointer;
}
.composer-send-menu-item:hover { background: var(--bubble); }
.composer-send-menu-item-label { font-size: var(--fs-md); color: var(--ink); white-space: nowrap; }
.composer-send-toggle { position: relative; width: 34px; height: 20px; flex-shrink: 0; }
.composer-send-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
.composer-send-toggle-slider {
    position: absolute;
    inset: 0;
    background: var(--line);
    border-radius: 20px;
    transition: background 0.15s;
}
.composer-send-toggle-slider::before {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--surface);
    box-shadow: 0 1px 3px rgba(28, 25, 23, 0.2);
    transition: transform 0.15s;
}
.composer-send-toggle input:checked + .composer-send-toggle-slider { background: var(--accent); }
.composer-send-toggle input:checked + .composer-send-toggle-slider::before { transform: translateX(14px); }
.composer-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 6px 6px 0; }
.composer-send-group { display: inline-flex; align-items: center; }
.composer-send-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    border-radius: 14px;
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--ink3);
    background: var(--bubble);
    transition: background 0.15s, color 0.15s;
}
.composer-send-btn.composer-send-active { background: var(--accent); color: #fff; }
.composer-send-btn.composer-send-active:hover { background: var(--accent-ink); }
.composer-send-btn.composer-send-inactive:hover { background: var(--line-soft); color: var(--ink2); }
.composer-send-btn svg { width: 12px; height: 12px; }
@media (max-width: 760px) {
    .chat-head { padding: 16px 16px 12px; }
    .chat-title { font-size: 18px; }
    .messages, .composer-wrap { padding-left: 16px; padding-right: 16px; }
    .message-content { max-width: 100%; }
}
/* ---------- “不显示员工信息”模式 ---------- */
/* 仅隐藏头部资料区（头像/姓名/状态），“OpenDesk 数字员工”徽标悬浮到页面右上角；
   消息流与空态照常展示员工身份，访客依然看得到在和谁对话 */
.root.hide-staff-info .chat-head-main { display: none; }
.root.hide-staff-info .chat-head { padding: 0; border-bottom-color: transparent; }
.root.hide-staff-info .powered {
    position: fixed;
    top: 14px;
    right: 16px;
    z-index: 50;
    opacity: 0.88;
    box-shadow: 0 4px 14px rgba(28, 25, 23, 0.14);
}

</style>
</head>
<body>
<div class="root">
    <section class="chat">
        <header class="chat-head">
            <div class="chat-head-main">
                <span class="avatar lg av-g1" id="avatar"></span>
                <div class="chat-who">
                    <h2 class="chat-title" id="staff-name"></h2>
                    <div class="detail-subtitle"><span class="status-dot" id="status-dot"></span><span class="truncate" id="staff-status"></span></div>
                </div>
            </div>
            <div class="chat-head-actions"><span class="powered"><span class="powered-dot"></span><span id="powered-label"></span></span></div>
        </header>
        <div class="messages" id="messages">
            <button class="load-older" id="load-older" hidden></button>
            <div class="empty" id="empty"></div>
            <div class="typing" id="typing" hidden><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span><em class="tlabel" id="typing-label"></em></div>
        </div>
        <div class="composer-wrap">
            <div class="notice" id="notice" hidden></div>
            <button class="scroll-bottom" id="scroll-bottom" hidden aria-label="scroll to bottom">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
            </button>
            <div class="composer-outer">
                <div class="composer-card">
                    <div class="composer-image-previews" id="image-previews" hidden></div>
                    <div class="composer-textarea-wrap">
                        <div class="composer-placeholder-wrap">
                            <textarea id="message-input" class="composer-textarea" rows="1"></textarea>
                            <div class="composer-placeholder" id="composer-placeholder" aria-hidden="true"></div>
                        </div>
                    </div>
                    <div class="composer-toolbar">
                        <div class="composer-toolbar-left">
                            <button type="button" class="composer-toolbar-control" id="attach-btn" title="">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                            </button>
                            <input type="file" id="attach-input" accept="image/*" multiple hidden>
                        </div>
                        <div class="composer-toolbar-right">
                            <div class="composer-send-group">
                                <button class="composer-send-btn composer-send-inactive" id="send-btn">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
                                    <span id="send-label"></span>
                                </button>
                                <div class="composer-send-divider"></div>
                                <button type="button" class="composer-send-menu-btn composer-send-inactive" id="send-menu-btn" title="">
                                    <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>
</div>
<script>
(function () {
    'use strict';
    var state = {
        strings: {},
        locale: 'en-US',
        staff: null,
        messages: [],
        hasMore: false,
        cursor: null,
        busy: false,
        staffEnabled: true,
        ctrlEnterSend: false,
        images: [],
        urlToken: '',
        hideInfo: false
    };
    var gradients = ['av-g1', 'av-g2', 'av-g3', 'av-g4'];

    function $(id) { return document.getElementById(id); }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function gradientIndex(name) {
        var hash = 0;
        for (var i = 0; i < name.length; i++) hash = (hash * 131 + name.charCodeAt(i)) >>> 0;
        hash = ((hash ^ (hash >>> 13)) * 0x5bd1e995) >>> 0;
        hash = (hash ^ (hash >>> 15)) >>> 0;
        return hash % gradients.length;
    }

    function formatTime(value) {
        var date = new Date(value);
        if (isNaN(date.getTime())) return '';
        try { return date.toLocaleString(state.locale); } catch (e) { return date.toLocaleString(); }
    }

    function nearBottom() {
        var box = $('messages');
        return box.scrollTop + box.clientHeight >= box.scrollHeight - 80;
    }

    function scrollToBottom() {
        var box = $('messages');
        box.scrollTop = box.scrollHeight;
    }

    function setNotice(text) {
        var notice = $('notice');
        notice.textContent = text || '';
        notice.hidden = !text;
    }

    function updateSendState() {
        var hasContent = Boolean($('message-input').value.trim()) || state.images.length > 0;
        var button = $('send-btn');
        button.disabled = !state.staffEnabled;
        button.classList.toggle('composer-send-active', hasContent && state.staffEnabled);
        button.classList.toggle('composer-send-inactive', !hasContent || !state.staffEnabled);
        var menuButton = $('send-menu-btn');
        menuButton.classList.toggle('composer-send-active', hasContent && state.staffEnabled);
        menuButton.classList.toggle('composer-send-inactive', !hasContent || !state.staffEnabled);
        menuButton.disabled = !state.staffEnabled;
    }

    /** 占位覆盖层内容随发送模式切换（Enter / Ctrl+Enter 两种提示变体） */
    function updateComposerPlaceholder() {
        var overlay = $('composer-placeholder');
        if (overlay) {
            overlay.innerHTML = state.ctrlEnterSend
                ? state.strings.placeholderCtrlHtml || ''
                : state.strings.placeholderHtml || '';
        }
    }

    function renderImageThumbs() {
        var wrap = $('image-previews');
        if (!wrap) return;
        wrap.textContent = '';
        wrap.hidden = state.images.length === 0;
        state.images.forEach(function (image, index) {
            var thumb = el('div', 'composer-image-thumb');
            var img = document.createElement('img');
            img.src = image.dataUrl;
            img.alt = image.name;
            thumb.appendChild(img);
            var remove = el('button', 'composer-image-thumb-remove', '×');
            remove.type = 'button';
            remove.addEventListener('click', function () {
                state.images.splice(index, 1);
                renderImageThumbs();
                updateSendState();
            });
            thumb.appendChild(remove);
            wrap.appendChild(thumb);
        });
    }

    function addImagesFromFiles(files) {
        Array.prototype.forEach.call(files, function (file) {
            if (!file.type || file.type.indexOf('image/') !== 0) return;
            var reader = new FileReader();
            reader.onload = function () {
                state.images.push({ dataUrl: String(reader.result), name: file.name || 'image' });
                renderImageThumbs();
                updateSendState();
            };
            reader.readAsDataURL(file);
        });
    }

    function avatarNode(isSelf, initial, portraitUrl, small) {
        var avatar;
        if (isSelf) {
            avatar = el('span', 'avatar avatar-neutral' + (small ? '' : ''));
            avatar.textContent = initial;
            return avatar;
        }
        avatar = el('span', 'avatar ' + gradients[gradientIndex(state.staff && state.staff.name ? state.staff.name : 'AI')]);
        if (portraitUrl) {
            var img = document.createElement('img');
            img.className = 'avatar-img';
            img.src = apiUrl(portraitUrl);
            img.alt = '';
            avatar.appendChild(img);
        } else {
            avatar.textContent = initial;
        }
        return avatar;
    }

    function resourceNode(part) {
        var wrap = el('div', 'resource');
        // 资源接口同样受令牌保护，URL 必须透传 token 参数
        var url = apiUrl(part.url);
        if (part.media_type === 'image') {
            var img = document.createElement('img');
            img.src = part.url;
            img.alt = part.name;
            img.loading = 'lazy';
            wrap.appendChild(img);
        } else if (part.media_type === 'video') {
            var video = document.createElement('video');
            video.controls = true;
            video.src = part.url;
            wrap.appendChild(video);
        } else if (part.media_type === 'audio') {
            var audio = document.createElement('audio');
            audio.controls = true;
            audio.src = part.url;
            wrap.appendChild(audio);
        } else {
            var link = document.createElement('a');
            link.href = part.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = part.name;
            wrap.appendChild(link);
        }
        return wrap;
    }

    function messageNode(message) {
        var isSelf = message.role === 'user';
        var article = el('article', 'message ' + message.role + (message.kind === 'error' ? ' error' : ''));
        var youLabel = state.strings.you || 'You';
        var author = isSelf ? youLabel : (state.staff && state.staff.name) || 'AI';
        var selfInitial = (youLabel.slice(0, 1) || 'Y').toUpperCase();
        var staffInitial = state.staff && state.staff.initial ? state.staff.initial : 'A';
        article.appendChild(avatarNode(isSelf, isSelf ? selfInitial : staffInitial, isSelf ? null : state.staff && state.staff.portrait, true));
        var content = el('div', 'message-content');
        var meta = el('div', 'message-meta');
        meta.appendChild(el('span', null, author));
        meta.appendChild(document.createElement('time')).textContent = formatTime(message.created_at);
        var textParts = (message.content || []).filter(function (part) { return part.type === 'text'; });
        if (textParts.length > 0) {
            meta.appendChild(buildCopyButton(textParts));
        }
        content.appendChild(meta);
        (message.content || []).forEach(function (part) {
            if (part.type === 'resource') {
                content.appendChild(resourceNode(part));
                return;
            }
            var bubble = el('div', 'message-bubble');
            var markdown = el('div', 'message-markdown');
            markdown.innerHTML = part.html || '';
            bubble.appendChild(markdown);
            content.appendChild(bubble);
        });
        article.appendChild(content);
        return article;
    }

    // 顺序完全信任服务端（与桌面端一致）：fresh 是最新一页（旧→新），
    // older 是此前通过"加载更早"累积的分页，只做去重拼接，不按时间重排
    /** 局域网 HTTP 属非安全上下文，navigator.clipboard 可能不存在，退回 execCommand */
    function copyPlain(text, done) {
        var legacy = function () {
            var helper = document.createElement('textarea');
            helper.value = text;
            helper.style.position = 'fixed';
            helper.style.opacity = '0';
            document.body.appendChild(helper);
            helper.select();
            try { document.execCommand('copy'); done(); } catch (e) {}
            document.body.removeChild(helper);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, legacy);
            return;
        }
        legacy();
    }

    function buildCopyButton(textParts) {
        // 模板字符串会把换行转义序列变成真实换行，join 的参数必须写成字符串转义序列的形式
        var plain = textParts.map(function (part) { return part.text; }).join('\\n\\n');
        var button = el('button', 'msg-copy');
        button.type = 'button';
        button.textContent = state.strings.copy || 'Copy';
        button.addEventListener('click', function () {
            copyPlain(plain, function () {
                button.textContent = state.strings.copied || '✓';
                setTimeout(function () {
                    if (button.isConnected) button.textContent = state.strings.copy || 'Copy';
                }, 1200);
            });
        });
        return button;
    }

    function mergeMessages(fresh) {
        var seen = {};
        fresh.forEach(function (message) { seen[message.id] = true; });
        var older = state.messages.filter(function (message) { return !seen[message.id]; });
        state.messages = older.concat(fresh);
    }

    function renderMessages() {
        var box = $('messages');
        var olderButton = $('load-older');
        var empty = $('empty');
        // 先删后插会让 scrollHeight 骤降、scrollTop 被浏览器钳到 0，导致发消息后列表跳顶
        var prevTop = box.scrollTop;
        var prevCount = box.querySelectorAll('.message').length;
        box.querySelectorAll('.message').forEach(function (node) { node.remove(); });
        empty.hidden = state.messages.length > 0;
        olderButton.hidden = !state.hasMore;
        olderButton.textContent = state.strings.loadOlder || '';
        var fragment = document.createDocumentFragment();
        state.messages.forEach(function (message) { fragment.appendChild(messageNode(message)); });
        // 只给本次新追加的消息加入场动画，避免整列表重放
        if (prevCount > 0 && state.messages.length > prevCount) {
            Array.prototype.forEach.call(fragment.children, function (node, index) {
                if (index >= prevCount) node.classList.add('message-new');
            });
        }
        box.insertBefore(fragment, olderButton.nextSibling);
        box.scrollTop = prevTop;
        updateSendState();
        updateScrollPill();
    }

    function renderStaff(staff) {
        state.staff = staff;
        state.staffEnabled = Boolean(staff.enabled);
        // “不显示员工信息”：仅隐藏头部资料区，消息流与空态照常展示员工身份
        state.hideInfo = Boolean(staff.hide_staff_info);
        document.querySelector('.root').classList.toggle('hide-staff-info', state.hideInfo);
        document.title = staff.name || document.title;
        var avatar = $('avatar');
        avatar.className = 'avatar lg ' + gradients[gradientIndex(staff.name || 'AI')];
        avatar.textContent = '';
        if (staff.portrait) {
            var img = document.createElement('img');
            img.className = 'avatar-img';
            img.src = apiUrl(staff.portrait);
            img.alt = '';
            avatar.appendChild(img);
        } else {
            avatar.textContent = staff.initial || (staff.name || 'A').slice(0, 1).toUpperCase();
        }
        $('staff-name').textContent = staff.name || '';
        if (staff.specialties && staff.specialties[0]) {
            $('staff-name').appendChild(el('span', 'pill', staff.specialties[0]));
        }
        var dot = $('status-dot');
        dot.className = 'status-dot ' + (staff.active_task_id ? 'run' : staff.enabled ? 'on' : '');
        var statusText = staff.active_task_id
            ? (state.strings.running || '')
            : staff.enabled
              ? (state.strings.enabled || '')
              : (state.strings.disabled || '');
        var parts = [statusText, staff.title || ''].filter(function (part) { return part; });
        $('staff-status').textContent = parts.join(' · ');
        var input = $('message-input');
        input.placeholder = composerPlaceholder();
        input.disabled = !state.staffEnabled;
        var composerCard = document.querySelector('.composer-card');
        if (composerCard) composerCard.classList.toggle('disabled', !state.staffEnabled);
        $('powered-label').textContent = state.strings.poweredBy || 'OpenDesk';
        $('attach-btn').title = state.strings.attach || '';
        $('send-menu-btn').title = state.strings.sendOptions || '';
        updateComposerPlaceholder();
        var typing = $('typing');
        if (typing) {
            // 任务运行中在消息流末尾展示打字指示器，给访客"对方正在处理"的即时反馈
            typing.hidden = !state.staffEnabled || !staff.active_task_id;
            $('typing-label').textContent = state.strings.processing || '';
        }
        renderEmptyState(staff);
        updateSendState();
    }

    /** 空会话占位：大头像 + 员工名 + 引导语，替代单一文本 */
    function renderEmptyState(staff) {
        var empty = $('empty');
        if (!empty) return;
        empty.textContent = '';
        var card = el('div', 'empty-card');
        var avatar = el('span', 'avatar ' + gradients[gradientIndex(staff.name || 'AI')]);
        if (staff.portrait) {
            var img = document.createElement('img');
            img.className = 'avatar-img';
            img.src = apiUrl(staff.portrait);
            img.alt = '';
            avatar.appendChild(img);
        } else {
            avatar.textContent = staff.initial || (staff.name || 'A').slice(0, 1).toUpperCase();
        }
        card.appendChild(avatar);
        card.appendChild(el('div', 'empty-name', staff.name || ''));
        if (staff.specialties && staff.specialties[0]) {
            card.appendChild(el('div', 'pill', staff.specialties[0]));
        }
        card.appendChild(el('div', 'empty-hint', state.strings.noMessages || ''));
        empty.appendChild(card);
    }

    /** 触屏设备没有 Enter/Shift 快捷键，placeholder 只保留输入提示 */
    function composerPlaceholder() {
        var base = state.strings.placeholder || '';
        try {
            if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
                var first = base.split('·')[0].trim();
                if (first) return first;
            }
        } catch (e) {}
        return base;
    }

    /** 令牌透传：页面 URL 携带的 token 参数必须附加到后续所有 API/SSE 请求上 */
    function apiUrl(path) {
        if (!state.urlToken) return path;
        return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(state.urlToken);
    }

    function fetchJson(url, options) {
        return fetch(apiUrl(url), options).then(function (response) {
            if (!response.ok) {
                return response.json().catch(function () { return null; }).then(function (data) {
                    var error = new Error((data && data.error) || response.statusText || 'request failed');
                    throw error;
                });
            }
            return response.json();
        });
    }

    function loadMessages(older) {
        var url = '/api/messages?limit=50' + (older && state.cursor ? '&cursor=' + encodeURIComponent(state.cursor) : '');
        return fetchJson(url).then(function (data) {
            if (older) {
                state.messages = state.messages.concat(data.messages);
            } else {
                mergeMessages(data.messages);
            }
            state.hasMore = Boolean(data.has_more);
            state.cursor = data.next_cursor;
            renderMessages();
        });
    }

    function refreshMessages() {
        var wasNearBottom = nearBottom();
        return fetchJson('/api/messages?limit=50').then(function (data) {
            mergeMessages(data.messages);
            state.hasMore = Boolean(data.has_more);
            state.cursor = data.next_cursor;
            renderMessages();
            if (wasNearBottom) scrollToBottom();
        }).catch(function () {});
    }

    function updateScrollPill() {
        var pill = $('scroll-bottom');
        if (!pill) return;
        pill.hidden = state.messages.length === 0 || nearBottom();
    }

    function sendMessage() {
        var input = $('message-input');
        var text = input.value.trim();
        if ((!text && state.images.length === 0) || state.busy || !state.staffEnabled) return;
        state.busy = true;
        setNotice('');
        input.value = '';
        var imageDataUris = state.images.map(function (image) { return image.dataUrl; });
        state.images = [];
        renderImageThumbs();
        updateSendState();
        fetchJson('/api/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: text, image_data_uris: imageDataUris })
        }).then(function () {
            return refreshMessages();
        }).catch(function (error) {
            setNotice(error.message || state.strings.sendFailed || 'send failed');
            input.value = text;
            updateSendState();
        }).then(function () {
            state.busy = false;
        });
    }

    function connectEvents() {
        if (typeof EventSource === 'undefined') return;
        var source = new EventSource(apiUrl('/api/events'));
        source.addEventListener('messages', function () { void refreshMessages(); });
        source.addEventListener('staff', function (event) {
            try {
                var payload = JSON.parse(event.data);
                if (payload && payload.id === (state.staff && state.staff.id)) renderStaff(payload);
            } catch (e) {}
        });
        source.onopen = function () { setNotice(''); };
        source.onerror = function () { setNotice(state.strings.disconnected || ''); };
    }

    /** 发送选项菜单（对齐桌面端"···"菜单）：Ctrl+Enter 发送模式开关 */
    function toggleSendMenu() {
        var existing = $('composer-send-options-panel');
        if (existing) {
            existing.remove();
            document.removeEventListener('mousedown', closeSendMenuOnOutside);
            return;
        }
        var menu = el('div', 'composer-send-options-panel');
        menu.id = 'composer-send-options-panel';
        var item = el('div', 'composer-send-menu-item');
        item.appendChild(el('span', 'composer-send-menu-item-label', state.strings.ctrlEnterSend || ''));
        var toggle = el('label', 'composer-send-toggle');
        var checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = state.ctrlEnterSend;
        checkbox.addEventListener('change', function () {
            state.ctrlEnterSend = checkbox.checked;
            updateComposerPlaceholder();
        });
        var slider = el('span', 'composer-send-toggle-slider');
        toggle.appendChild(checkbox);
        toggle.appendChild(slider);
        item.appendChild(toggle);
        menu.appendChild(item);
        $('send-menu-btn').appendChild(menu);
        document.addEventListener('mousedown', closeSendMenuOnOutside);
    }

    function closeSendMenuOnOutside(event) {
        var panel = $('composer-send-options-panel');
        if (!panel) {
            document.removeEventListener('mousedown', closeSendMenuOnOutside);
            return;
        }
        var target = event.target;
        if (panel.contains(target) || target === $('send-menu-btn') || $('send-menu-btn').contains(target)) return;
        panel.remove();
        document.removeEventListener('mousedown', closeSendMenuOnOutside);
    }

    function initialize() {
        var params = new URLSearchParams(window.location.search);
        state.urlToken = params.get('token') || '';
        $('send-btn').addEventListener('click', sendMessage);
        $('load-older').addEventListener('click', function () {
            void loadMessages(true);
        });
        var input = $('message-input');
        input.addEventListener('input', updateSendState);
        input.addEventListener('keydown', function (event) {
            if (event.isComposing) return;
            var enterPressed = event.key === 'Enter';
            if (state.ctrlEnterSend) {
                if (enterPressed && event.ctrlKey && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage();
                }
                return;
            }
            if (enterPressed && !event.ctrlKey && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });
        input.addEventListener('paste', function (event) {
            var items = event.clipboardData ? event.clipboardData.items : null;
            if (!items) return;
            var imageFiles = [];
            for (var i = 0; i < items.length; i++) {
                if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) {
                    imageFiles.push(items[i].getAsFile());
                }
            }
            if (imageFiles.length > 0) {
                event.preventDefault();
                addImagesFromFiles(imageFiles);
            }
        });
        $('attach-btn').addEventListener('click', function () {
            $('attach-input').click();
        });
        $('attach-input').addEventListener('change', function () {
            addImagesFromFiles(this.files || []);
            this.value = '';
        });
        $('send-menu-btn').addEventListener('click', toggleSendMenu);
        var messagesBox = $('messages');
        messagesBox.addEventListener('scroll', updateScrollPill);
        $('scroll-bottom').addEventListener('click', function () {
            scrollToBottom();
        });
        var ready = fetchJson('/api/session').then(function (session) {
            state.strings = session.strings || {};
            state.locale = session.locale || 'en-US';
            $('send-label').textContent = state.strings.send || '';
            renderStaff(session.staff);
        });
        void ready.then(function () { return loadMessages(false); })
            .then(function () { scrollToBottom(); })
            .catch(function (error) { setNotice(error.message || 'load failed'); });
        connectEvents();
    }

    initialize();
})();
</script>
</body>
</html>`;

/**
 * 生成聊天页面 HTML。
 */
export function chatPageHtml(): string {
    return CHAT_PAGE_TEMPLATE;
}
