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

/**
 * 通用确认按钮样式。
 *
 * 所有规则统一带 `button` 类型选择器：弹窗经常被注入到宿主应用自己的 Shadow DOM 里
 * （插件中心、笔记、MCP 管理等都把弹窗挂在自己的 shadowRoot），宿主的通用
 * `button` / `button:hover` / `:host([data-theme="dark"]) button:hover` 规则同样会命中
 * 这些按钮。
 *
 * 只用单个类时 `.od-confirm-btn-danger` 的优先级 (0,1,0) 低于 `button:hover` 的
 * (0,1,1)，危险按钮 hover 时背景会被宿主的浅色 hover 背景覆盖，而文字仍是白色，
 * 变成几乎不可读的"白字浅底"（卸载弹窗的回归问题）。加上 `button` 前缀后基础规则提到
 * (0,1,1)、变体提到 (0,2,1)/(0,3,1)，不再依赖样式表插入顺序。
 *
 * 取消按钮的 hover 背景用 `--mc-hover` 而不是卡片底色：后者会抵消掉 hover 反馈
 * （宿主的暗色 hover 背景同样被本规则压过）。
 */
export const CONFIRM_BUTTON_CSS = `
button.od-confirm-btn {
    padding: 7px 16px; border-radius: 8px; border: none;
    font-size: 12.5px; font-weight: 600; cursor: pointer;
    transition: background 0.15s, filter 0.15s, border-color 0.15s, color 0.15s;
    font-family: inherit;
}
button.od-confirm-btn:active { transform: scale(0.97); }
button.od-confirm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
button.od-confirm-btn.od-confirm-btn-cancel {
    background: var(--mc-card-bg); color: var(--mc-ink2);
    border: 1px solid var(--mc-line);
}
button.od-confirm-btn.od-confirm-btn-cancel:hover {
    background: var(--mc-hover);
    border-color: var(--mc-accent);
    color: var(--mc-accent);
}
button.od-confirm-btn.od-confirm-btn-primary {
    background: var(--mc-accent); color: #fff;
}
button.od-confirm-btn.od-confirm-btn-primary:hover { background: var(--mc-accent-hover); color: #fff; }
button.od-confirm-btn.od-confirm-btn-danger {
    background: var(--mc-red); color: #fff;
}
button.od-confirm-btn.od-confirm-btn-danger:hover {
    background: var(--mc-red);
    color: #fff;
    filter: brightness(0.9);
}
`;
