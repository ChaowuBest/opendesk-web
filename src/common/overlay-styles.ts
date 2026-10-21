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

/** Shared by document styles, Shadow DOM dialogs and native dialog backdrops. */
export const OVERLAY_CSS = `
/* 窗口级遮罩铺满「可视内容矩形」而非窗口矩形：Linux 自绘圆角窗口下 body 含四周
   透明阴影边距，直接 inset:0 会把边距涂黑并画出直角（遮罩超出窗口外框）。
   --od-overlay-inset/--od-overlay-radius 由 titlebar.css 在 window-rounded 下赋值，
   其余平台未定义时退化为 0，行为不变。 */
.od-overlay-root {
    position: fixed;
    inset: var(--od-overlay-inset, 0px);
    border-radius: var(--od-overlay-radius, 0px);
    z-index: 99999;
}
:where(.od-overlay, .od-confirm-modal-overlay):not(dialog) {
    background: rgb(0 0 0 / 30%);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
}
:where(html[data-theme='dark'], [data-theme='dark']) :where(.od-overlay, .od-confirm-modal-overlay):not(dialog),
:where(.od-overlay, .od-confirm-modal-overlay).od-modal-dark:not(dialog),
:host([data-theme='dark']) :where(.od-overlay, .od-confirm-modal-overlay):not(dialog),
:host-context([data-theme='dark']) :where(.od-overlay, .od-confirm-modal-overlay):not(dialog) {
    background: rgb(0 0 0 / 45%);
}
/* 原生 dialog 的 ::backdrop 恒铺满视口，无法内缩或圆角（Linux 自绘圆角窗口下会
   涂黑四周透明阴影边距）。暗色与模糊统一交给 createOverlay() 生成的伴生遮罩，
   ::backdrop 保持透明，仅承担 top-layer 的点击拦截。 */
dialog.od-overlay::backdrop {
    background: transparent;
}
.od-overlay.od-overlay-local {
    position: absolute;
    inset: 0;
    border-radius: inherit;
}
`;
