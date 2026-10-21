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

/** Shared confirmation button appearance for modals and non-modal browser prompts. */
export const CONFIRM_LIGHT_TOKENS = `
    --mc-card-bg: #FFFFFF;
    --mc-bg: #F5F4F2;
    --mc-hover: #F5F4F2;
    --mc-ink: #1C1917;
    --mc-ink2: #4A4642;
    --mc-ink3: #8A8580;
    --mc-ink4: #B4AFA9;
    --mc-line: #E7E5E2;
    --mc-line-soft: #EFEEEA;
    --mc-accent: #DF4436;
    --mc-accent-hover: #E8563F;
    --mc-red: #DC2626;
    --mc-close-bg: rgba(0,0,0,0.06);
    --mc-close-hover-bg: rgba(0,0,0,0.12);
`;

export const CONFIRM_DARK_TOKENS = `
    --mc-card-bg: #2A2826;
    --mc-bg: #232120;
    --mc-hover: #33302D;
    --mc-ink: #EFEDEA;
    --mc-ink2: #D5D1CB;
    --mc-ink3: #9B968F;
    --mc-ink4: #6F6A63;
    --mc-line: #3B3835;
    --mc-line-soft: #33302D;
    --mc-accent: #E8563F;
    --mc-accent-hover: #ED6B56;
    --mc-red: #E85A5A;
    --mc-close-bg: rgba(255,255,255,0.08);
    --mc-close-hover-bg: rgba(255,255,255,0.15);
`;

export const CONFIRM_BUTTON_CSS = `
.od-confirm-btn {
    padding: 7px 16px; border-radius: 8px; border: none;
    font-size: 12.5px; font-weight: 600; cursor: pointer;
    transition: background 0.15s, filter 0.15s, border-color 0.15s, color 0.15s;
    font-family: inherit;
}
.od-confirm-btn:active { transform: scale(0.97); }
.od-confirm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.od-confirm-btn-cancel {
    background: var(--mc-card-bg); color: var(--mc-ink2);
    border: 1px solid var(--mc-line);
}
.od-confirm-btn-cancel:hover { border-color: var(--mc-accent); color: var(--mc-accent); }
.od-confirm-btn-primary {
    background: var(--mc-accent); color: #fff;
}
.od-confirm-btn-primary:hover { background: var(--mc-accent-hover); }
.od-confirm-btn-danger {
    background: var(--mc-red); color: #fff;
}
.od-confirm-btn-danger:hover { filter: brightness(0.9); }
`;
