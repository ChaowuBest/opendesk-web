/**
 * Webview Preload — window.open Proxy Injection
 *
 * 此 preload 在 webview guest 页面任何脚本执行之前运行。
 * 配合 contextIsolation=no，直接在同一 JS 上下文中 patch window.open，
 * 确保页面的同步 <script> 块中调用 window.open 时已返回 proxy 而非 null。
 *
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { BROWSER_FOCUS_TRAP_SCRIPT, WINDOW_OPEN_PROXY_SCRIPT } from './webviewScripts';

// 在 webview guest 上下文中直接执行注入脚本

eval(WINDOW_OPEN_PROXY_SCRIPT);
eval(BROWSER_FOCUS_TRAP_SCRIPT);
