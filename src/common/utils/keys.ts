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
 * 回车键图标（键帽 + return 箭头），用于输入框富文本 placeholder 提示。
 * 颜色跟随 currentColor，浅色/深色主题分别通过外层容器着色。
 */
export const ENTER_KEY_ICON_SVG =
    '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<rect x="1" y="1" width="18" height="18" rx="4.5" fill="currentColor" opacity="0.12"/>' +
    '<rect x="1.5" y="1.5" width="17" height="17" rx="4" stroke="currentColor" stroke-width="1" opacity="0.7"/>' +
    '<path d="M15 4v5.2a3.2 3.2 0 0 1-3.2 3.3H4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M6.5 10 4 12.5l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

/**
 * Shift 键图标（键帽 + 上箭头），用于输入框富文本 placeholder 提示。
 */
export const SHIFT_KEY_ICON_SVG =
    '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<rect x="1" y="1" width="18" height="18" rx="4.5" fill="currentColor" opacity="0.12"/>' +
    '<rect x="1.5" y="1.5" width="17" height="17" rx="4" stroke="currentColor" stroke-width="1" opacity="0.7"/>' +
    '<path d="M10 4.6 5.6 8.8h2.7v4.6h3.4V8.8h2.7L10 4.6Z" fill="currentColor" opacity="0.9"/>' +
    '</svg>';

/**
 * Ctrl 键图标（键帽 + caret 上尖符号），用于输入框富文本 placeholder 提示。
 */
export const CTRL_KEY_ICON_SVG =
    '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<rect x="1" y="1" width="18" height="18" rx="4.5" fill="currentColor" opacity="0.12"/>' +
    '<rect x="1.5" y="1.5" width="17" height="17" rx="4" stroke="currentColor" stroke-width="1" opacity="0.7"/>' +
    '<path d="M10 6 5.4 12h9.2L10 6Z" fill="currentColor" opacity="0.9"/>' +
    '</svg>';
