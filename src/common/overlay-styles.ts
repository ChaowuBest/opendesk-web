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
.od-overlay-root {
    position: fixed;
    inset: 0;
    z-index: 99999;
}
:where(.od-overlay, .od-confirm-modal-overlay):not(dialog),
dialog.od-overlay::backdrop {
    background: rgb(0 0 0 / 30%);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
}
:where(html[data-theme='dark'], [data-theme='dark']) :where(.od-overlay, .od-confirm-modal-overlay):not(dialog),
:where(.od-overlay, .od-confirm-modal-overlay).od-modal-dark:not(dialog),
:host([data-theme='dark']) :where(.od-overlay, .od-confirm-modal-overlay):not(dialog),
:host-context([data-theme='dark']) :where(.od-overlay, .od-confirm-modal-overlay):not(dialog),
html[data-theme='dark'] dialog.od-overlay::backdrop {
    background: rgb(0 0 0 / 45%);
}
.od-overlay.od-overlay-local {
    position: absolute;
    border-radius: inherit;
}
`;
