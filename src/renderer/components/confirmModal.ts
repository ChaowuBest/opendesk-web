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
 * 通用模态弹窗组件 — 顶部色带风格。
 *
 * 设计规范参见 modal.html 设计标注稿：
 *   - 顶部色带：语义色浅底 + 实心图标 + 标题/副标题 + 关闭按钮
 *   - 四种语义变体：danger / info / warn / success
 *   - 深色/浅色双模式
 *   - 进入 250ms / 退出 180ms 动效
 *
 * 使用方式：
 *   const confirmed = await showConfirmModal({ title, message, variant: 'danger' });
 */

export type ModalVariant = 'danger' | 'info' | 'warn' | 'success';

export interface ConfirmModalOptions {
    /** 语义类型，决定色带颜色。未指定时根据 danger 推断 */
    variant?: ModalVariant;
    /** 图标的 FontAwesome class，如 'fa-trash-can' */
    icon?: string;
    /** 图标容器背景色（覆盖语义默认值，已废弃——请使用 variant） */
    iconBg?: string;
    /** 图标颜色（覆盖语义默认值，已废弃——请使用 variant） */
    iconColor?: string;
    /** 色带副标题 */
    subtitle?: string;
    /** 弹窗标题 */
    title: string;
    /** 弹窗内容描述（支持 HTML） */
    message: string;
    /** 确认按钮文本（默认 "确认"） */
    confirmText?: string;
    /** 取消按钮文本（默认 "取消"，传入 null 隐藏取消按钮） */
    cancelText?: string | null;
    /** 确认按钮是否为危险样式（红色）。已废弃，请使用 variant: 'danger' */
    danger?: boolean;
    /** 如果设置，则要求用户输入该验证码才能确认 */
    challenge?: string;
    /** challenge 模式下的提示文本，${code} 会被替换为验证码 */
    challengeHint?: string;
    /** 挂载目标（默认 document.body，可传 shadowRoot 中的元素） */
    mountTarget?: HTMLElement;
    /** 是否允许按回车默认触发"确认"（默认 false，仅个别弹窗显式开启） */
    enterToConfirm?: boolean;
}

const ANIM_DURATION_IN = 250;
const ANIM_DURATION_OUT = 180;

export { ANIM_DURATION_IN as MODAL_ANIM_DURATION_IN, ANIM_DURATION_OUT as MODAL_ANIM_DURATION_OUT };

interface VariantConfig {
    icon: string;
}

const VARIANT_CONFIG: Record<ModalVariant, VariantConfig> = {
    danger: { icon: 'fa-circle-exclamation' },
    info: { icon: 'fa-circle-info' },
    warn: { icon: 'fa-triangle-exclamation' },
    success: { icon: 'fa-circle-check' }
};

/**
 * FA 图标名 -> SVG path 映射。
 * 仅覆盖 confirmModal 和各应用 banner 中常用的图标，
 * 确保 Shadow DOM 中也能正确渲染（FA CSS 不穿透 Shadow DOM 边界）。
 */
const ICON_SVG_MAP: Record<string, string> = {
    'fa-circle-exclamation':
        '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    'fa-circle-info':
        '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    'fa-triangle-exclamation':
        '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    'fa-circle-check': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    'fa-circle-xmark':
        '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    'fa-trash-can':
        '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
    'fa-trash':
        '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
    'fa-trash-alt':
        '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
    'fa-exclamation-triangle':
        '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    'fa-info-circle':
        '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    'fa-times-circle':
        '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    'fa-check': '<polyline points="20 6 9 17 4 12"/>',
    'fa-shield-halved':
        '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 22s8-4 8-10V5l-8-3" fill="currentColor" opacity="0.3"/>',
    'fa-right-from-bracket':
        '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    'fa-bullseye': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    'fa-arrows-rotate':
        '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    'fa-sync-alt':
        '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    'fa-redo-alt': '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    'fa-gear':
        '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    'fa-download':
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    'fa-upload':
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    'fa-key':
        '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    'fa-globe':
        '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    'fa-rotate-left': '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    'fa-folder-open':
        '<path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>',
    'fa-pen-to-square':
        '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    'fa-edit':
        '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    'fa-ban': '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
    'fa-bolt': '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    'fa-user-plus':
        '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>',
    'fa-layer-group':
        '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    'fa-link':
        '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    'fa-list-check':
        '<path d="M9 6l11 0"/><path d="M9 12l11 0"/><path d="M9 18l11 0"/><polyline points="3 6 4 7 5.5 5.5"/><polyline points="3 12 4 13 5.5 11.5"/><polyline points="3 18 4 19 5.5 17.5"/>',
    'fa-image':
        '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    'fa-plus': '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    'fa-flask': '<path d="M9 2v6L4 19a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3L15 8V2"/><path d="M8 2h8"/><path d="M7 15h10"/>',
    'fa-file-export':
        '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M11 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9l5 5v4"/><path d="M18 15l3 3-3 3"/><path d="M21 18h-7"/>',
    'fa-file-import':
        '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M11 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9l5 5v4"/><path d="M15 18l-3-3 3-3"/><path d="M8 15h7"/>',
    'fa-save':
        '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
    'fa-eye': '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    'fa-calendar-plus':
        '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="12" y1="14" x2="12" y2="18"/><line x1="10" y1="16" x2="14" y2="16"/>',
    'fa-calendar':
        '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    'fa-arrows-up-down-left-right':
        '<polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/>',
    'fa-server':
        '<rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
    'fa-microchip':
        '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="2" x2="9" y2="4"/><line x1="15" y1="2" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="22"/><line x1="15" y1="20" x2="15" y2="22"/><line x1="20" y1="9" x2="22" y2="9"/><line x1="20" y1="14" x2="22" y2="14"/><line x1="2" y1="9" x2="4" y2="9"/><line x1="2" y1="14" x2="4" y2="14"/>',
    'fa-satellite-dish': '<path d="M3 12h4l3-9 4 18 3-9h4"/>',
    'fa-users':
        '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    'fa-user-tie':
        '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><path d="M12 11l-2 5 2 3 2-3-2-5z"/>',
    'fa-comment': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    'fa-heart':
        '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
    'fa-star':
        '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    'fa-bookmark': '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    'fa-bug':
        '<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 7l-3 2"/><path d="M5 7l3 2"/><path d="M19 13H5"/><path d="M19 19l-3-2"/><path d="M5 19l3-2"/><path d="M12 6V4"/><path d="M12 4a2 2 0 0 0-2-2H8"/><path d="M12 4a2 2 0 0 0 2-2h2"/>',
    'fa-wand-sparkles':
        '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M15 9h0M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"/>',
    'fa-stop': '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    'fa-tag':
        '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    'fa-clock-rotate-left': '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>',
    'fa-clock': '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    'fa-envelope': '<rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,6 12,13 2,6"/>',
    'fa-envelope-open':
        '<path d="M2 6.5L12 13l10-6.5"/><path d="M2 6.5V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6.5L12 2 2 6.5z"/>',
    'fa-paper-plane': '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    'fa-reply': '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    'fa-share':
        '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>',
    'fa-book-open':
        '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    'fa-newspaper':
        '<rect x="2" y="3" width="20" height="18" rx="2"/><line x1="6" y1="7" x2="18" y2="7"/><line x1="6" y1="11" x2="18" y2="11"/><line x1="6" y1="15" x2="13" y2="15"/>',
    'fa-inbox':
        '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    'fa-flag-checkered':
        '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
    'fa-circle-arrow-left':
        '<circle cx="12" cy="12" r="10"/><polyline points="16 12 8 12"/><polyline points="12 16 8 12 12 8"/>',
    'fa-circle-question':
        '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    'fa-handshake':
        '<path d="M11 17l-2 2-3-3 5-5"/><path d="M14 7l2-2 3 3-5 5"/><path d="M5 13l-3-3V5h5l3 3"/><path d="M19 11l3 3v5h-5l-3-3"/>',
    'fa-certificate': '<circle cx="12" cy="9" r="6"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
    'fa-chart-pie': '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
    'fa-stethoscope':
        '<path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3"/><path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4"/><circle cx="20" cy="10" r="2"/>',
    'fa-brain':
        '<path d="M12 5a3 3 0 1 0-5.997.142 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 0 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.142 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 0 1 12 18Z"/>',
    'fa-spell-check': '<path d="M6 16V8l4 8 4-8v8"/><path d="M14 19l2 2 4-4"/>',
    'fa-code-compare': '<path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/>',
    'fa-code-fork':
        '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M6 9v6"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    'fa-compress':
        '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
    'fa-reply-all':
        '<polyline points="7 17 2 12 7 7"/><polyline points="12 18l-5-6 5-6"/><path d="M22 4v8a4 4 0 0 1-4 4H12"/>',
    'fa-film':
        '<rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
    'fa-video': '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
    'fa-phone':
        '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    'fa-book':
        '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    'fa-arrow-down-a-z':
        '<path d="M3 7h12"/><path d="M3 12h9"/><path d="M3 17h6"/><path d="M17 4v16"/><path d="M13 16l4 4 4-4"/>',
    'fa-arrow-up-right-from-square':
        '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    'fa-xmark': '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    'fa-pen':
        '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/>'
};

/**
 * 将 FA 图标名渲染为内联 SVG（Shadow DOM 兼容）。
 * 如果图标名不在映射表中，回退到 FA `<i>` 标签。
 */
export function renderIcon(iconName: string): string {
    // 如果已经是 SVG 或 HTML，直接返回
    if (iconName.startsWith('<')) return iconName;
    // 去掉 fa-solid / fas 前缀，只取图标名
    const cleanName = iconName.replace(/^(fa-solid|fas|fa-regular|far|fa-brands|fab)\s+/, '').trim();
    const path = ICON_SVG_MAP[cleanName];
    if (path) {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    }
    // 回退：使用 FA <i> 标签（仅在非 Shadow DOM 环境下有效）
    return `<i class="fas ${iconName}"></i>`;
}

/**
 * 检测当前是否为深色模式（兼容 document 和 Shadow DOM 上下文）。
 */
export function detectDarkMode(mountTarget: HTMLElement = document.body): boolean {
    if (document.documentElement.getAttribute('data-theme') === 'dark') return true;
    const root = mountTarget.getRootNode();
    // Use duck-typing instead of `instanceof ShadowRoot` for environments where ShadowRoot is not defined
    if (root && typeof root === 'object' && 'host' in root) {
        const host = (root as ShadowRoot).host as HTMLElement;
        if (host?.getAttribute('data-theme') === 'dark') return true;
        if (host?.closest?.('[data-theme="dark"]')) return true;
    }
    if (mountTarget.closest?.('[data-theme="dark"]')) return true;
    return false;
}

/**
 * 模态弹窗基础 CSS — 顶部色带风格。
 * 供 showConfirmModal 及其他复用该风格的弹窗组件使用。
 */
export const MODAL_CSS = `
.od-confirm-modal-overlay {
    position: fixed; inset: 0; z-index: 99999;
    display: flex; align-items: center; justify-content: center;
    animation: od-modal-fade-in ${ANIM_DURATION_IN}ms ease-out forwards;
    --mc-card-bg: #FFFFFF;
    --mc-bg: #F5F4F2;
    --mc-hover: #F5F4F2;
    --mc-ink: #1C1917;
    --mc-ink2: #4A4642;
    --mc-ink3: #8A8580;
    --mc-ink4: #B4AFA9;
    --mc-line: #E7E5E2;
    --mc-line-soft: #EFEEEA;
    --mc-overlay-bg: rgba(0,0,0,0.3);
    --mc-overlay-blur: blur(6px);
    --mc-accent: #DF4436;
    --mc-accent-hover: #E8563F;
    --mc-red: #DC2626;
    --mc-close-bg: rgba(0,0,0,0.06);
    --mc-close-hover-bg: rgba(0,0,0,0.12);
    background: var(--mc-overlay-bg);
    backdrop-filter: var(--mc-overlay-blur);
    -webkit-backdrop-filter: var(--mc-overlay-blur);
}
.od-confirm-modal-overlay.od-modal-dark {
    --mc-card-bg: #2A2826;
    --mc-bg: #232120;
    --mc-hover: #33302D;
    --mc-ink: #EFEDEA;
    --mc-ink2: #D5D1CB;
    --mc-ink3: #9B968F;
    --mc-ink4: #6F6A63;
    --mc-line: #3B3835;
    --mc-line-soft: #33302D;
    --mc-overlay-bg: rgba(0,0,0,0.45);
    --mc-overlay-blur: blur(8px);
    --mc-accent: #E8563F;
    --mc-accent-hover: #ED6B56;
    --mc-red: #E85A5A;
    --mc-close-bg: rgba(255,255,255,0.08);
    --mc-close-hover-bg: rgba(255,255,255,0.15);
}
.od-confirm-modal-overlay.od-modal-leaving {
    animation: od-modal-fade-out ${ANIM_DURATION_OUT}ms ease-in forwards;
}
.od-confirm-modal-card {
    background: var(--mc-card-bg);
    border-radius: 16px;
    overflow: hidden;
    width: 400px; max-width: 92vw;
    box-shadow: 0 24px 80px rgba(0,0,0,0.18), 0 0 1px rgba(0,0,0,0.1);
    animation: od-modal-scale-in ${ANIM_DURATION_IN}ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
}
.od-confirm-modal-overlay.od-modal-leaving .od-confirm-modal-card {
    animation: od-modal-scale-out ${ANIM_DURATION_OUT}ms ease-in forwards;
}
.od-confirm-modal-banner {
    padding: 16px 24px;
    display: flex; align-items: center; gap: 12px;
}
.od-confirm-modal-banner.danger { background: #FEF2F2; }
.od-confirm-modal-banner.info { background: #EBF1FB; }
.od-confirm-modal-banner.warn { background: #FDF3E3; }
.od-confirm-modal-banner.success { background: #E7F5EE; }
.od-modal-dark .od-confirm-modal-banner.danger { background: rgba(232,90,90,0.15); }
.od-modal-dark .od-confirm-modal-banner.info { background: rgba(122,162,232,0.16); }
.od-modal-dark .od-confirm-modal-banner.warn { background: rgba(226,162,59,0.15); }
.od-modal-dark .od-confirm-modal-banner.success { background: rgba(61,191,130,0.15); }
.od-confirm-modal-icon {
    width: 36px; height: 36px; border-radius: 10px;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.od-confirm-modal-icon i { font-size: 17px; color: #fff; }
.od-confirm-modal-icon svg { width: 17px; height: 17px; color: #fff; }
.od-confirm-modal-banner.danger .od-confirm-modal-icon { background: #DC2626; }
.od-confirm-modal-banner.info .od-confirm-modal-icon { background: #4267B2; }
.od-confirm-modal-banner.warn .od-confirm-modal-icon { background: #B87503; }
.od-confirm-modal-banner.success .od-confirm-modal-icon { background: #1F9D66; }
.od-modal-dark .od-confirm-modal-banner.danger .od-confirm-modal-icon { background: #E85A5A; }
.od-modal-dark .od-confirm-modal-banner.info .od-confirm-modal-icon { background: #7AA2E8; }
.od-modal-dark .od-confirm-modal-banner.warn .od-confirm-modal-icon { background: #E2A23B; }
.od-modal-dark .od-confirm-modal-banner.success .od-confirm-modal-icon { background: #3DBF82; }
.od-confirm-modal-banner-text { flex: 1; min-width: 0; }
.od-confirm-modal-title {
    font-size: 15px; font-weight: 700; color: var(--mc-ink); line-height: 1.3;
}
.od-confirm-modal-subtitle {
    font-size: 11px; color: var(--mc-ink3); margin-top: 2px;
}
.od-confirm-modal-close {
    width: 26px; height: 26px; border: 0; border-radius: 7px;
    background: var(--mc-close-bg); color: var(--mc-ink3);
    cursor: pointer; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s, color 0.15s;
}
.od-confirm-modal-close:hover { background: var(--mc-close-hover-bg); color: var(--mc-ink2); }
.od-confirm-modal-close svg { width: 13px; height: 13px; }
.od-confirm-modal-body {
    padding: 16px 24px;
    font-size: 13px; color: var(--mc-ink3); line-height: 1.6;
}
.od-confirm-modal-body b { color: var(--mc-ink2); font-weight: 600; }
.od-confirm-modal-challenge {
    padding: 0 24px 4px;
}
.od-confirm-modal-challenge-hint {
    font-size: 12px; color: var(--mc-ink2); margin-bottom: 8px;
}
.od-confirm-modal-challenge-hint code {
    font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
    font-size: 13px; font-weight: 700;
    background: var(--mc-hover); padding: 1px 6px; border-radius: 4px;
    color: var(--mc-accent);
}
.od-confirm-modal-challenge-input {
    width: 100%; box-sizing: border-box;
    padding: 8px 12px; border-radius: 8px;
    border: 1.5px solid var(--mc-line);
    background: var(--mc-card-bg); color: var(--mc-ink);
    font-size: 14px; font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
    outline: none; transition: border-color 0.15s;
}
.od-confirm-modal-challenge-input:focus { border-color: var(--mc-accent); }
.od-confirm-modal-challenge-input::placeholder { color: var(--mc-ink4); }
.od-confirm-modal-footer {
    padding: 14px 24px 18px;
    display: flex; justify-content: flex-end; gap: 10px;
    border-top: 1px solid var(--mc-line-soft);
}
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

@keyframes od-modal-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes od-modal-fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes od-modal-scale-in {
    from { opacity: 0; transform: scale(0.95) translateY(10px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes od-modal-scale-out {
    from { opacity: 1; transform: scale(1) translateY(0); }
    to { opacity: 0; transform: scale(0.95) translateY(10px); }
}
`;

const CLOSE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

/**
 * 绑定"点击遮罩关闭"逻辑。
 *
 * 注意：不能直接监听 overlay 的 click 事件并判断 e.target 是否为遮罩，
 * 因为 click 事件的目标是 mousedown 与 mouseup 目标的最近公共祖先——
 * 当鼠标在弹窗内按下、在遮罩上松开时（例如全选表单文本拖出弹窗），
 * click 会在公共祖先（遮罩）上触发，导致误关闭。
 * 这里要求 mousedown 与 mouseup 都发生在遮罩本身上才触发关闭。
 *
 * @param overlay 遮罩元素
 * @param onDismiss 遮罩点击确认后触发的关闭回调
 * @param isTarget 判断事件目标是否为"遮罩本身"（默认 e.target === overlay）
 * @param enabled 是否允许点击遮罩关闭；带表单填写的弹窗应传 false，防止误关丢失输入
 */
export function bindOverlayDismiss(
    overlay: HTMLElement,
    onDismiss: () => void,
    isTarget: (target: EventTarget | null) => boolean = (t) => t === overlay,
    enabled = true
): void {
    if (!enabled) return;
    let downOnOverlay = false;
    overlay.addEventListener('mousedown', (e) => {
        downOnOverlay = isTarget(e.target);
    });
    overlay.addEventListener('mouseup', (e) => {
        if (downOnOverlay && isTarget(e.target)) {
            onDismiss();
        }
        downOnOverlay = false;
    });
}

/**
 * 判断弹窗内按下回车时是否应由弹窗默认触发"确认"。
 *
 * 规则：
 *  - challenge 未匹配（确认按钮禁用）时不触发；
 *  - 焦点在可交互元素（输入框 / 按钮 / 链接 / 可编辑富文本）上时不拦截，
 *    回车交给原生行为（例如 challenge 输入框由自身处理器负责）。
 */
export function shouldConfirmOnEnter(
    target: EventTarget | null,
    hasChallenge: boolean,
    confirmDisabled: boolean
): boolean {
    if (hasChallenge && confirmDisabled) return false;
    if (!target) return true;
    const el = target as HTMLElement;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return false;
    if (el.isContentEditable) return false;
    return true;
}

export function showConfirmModal(options: ConfirmModalOptions): Promise<boolean> {
    return new Promise((resolve) => {
        const {
            variant: explicitVariant,
            icon: explicitIcon,
            subtitle,
            title,
            message,
            confirmText = '确认',
            cancelText = '取消',
            danger = false,
            challenge,
            challengeHint,
            enterToConfirm = false,
            mountTarget = document.body
        } = options;

        const variant: ModalVariant = explicitVariant ?? (danger ? 'danger' : 'info');
        const vc = VARIANT_CONFIG[variant];
        const iconName = explicitIcon ?? vc.icon;
        const isDanger = variant === 'danger';
        const hasChallenge = !!challenge;

        const cancelButtonHtml = cancelText
            ? `<button class="od-confirm-btn od-confirm-btn-cancel" data-action="cancel">${cancelText}</button>`
            : '';
        const confirmDisabled = hasChallenge ? ' disabled' : '';
        const footerHtml = `<div class="od-confirm-modal-footer">${cancelButtonHtml}<button class="od-confirm-btn ${isDanger ? 'od-confirm-btn-danger' : 'od-confirm-btn-primary'}" data-action="confirm"${confirmDisabled}>${confirmText}</button></div>`;

        const challengeHtml = hasChallenge
            ? `<div class="od-confirm-modal-challenge">
                   <div class="od-confirm-modal-challenge-hint">${(challengeHint ?? '').replace(challenge!, `<code>${challenge}</code>`)}</div>
                   <input class="od-confirm-modal-challenge-input" type="text" placeholder="${challenge ?? ''}" autocomplete="off" spellcheck="false" data-action="challenge-input" />
               </div>`
            : '';

        const overlay = document.createElement('div');
        overlay.className = 'od-confirm-modal-overlay';
        if (detectDarkMode(mountTarget)) {
            overlay.classList.add('od-modal-dark');
        }
        overlay.innerHTML = `
<style>${MODAL_CSS}</style>
<div class="od-confirm-modal-card">
    <div class="od-confirm-modal-banner ${variant}">
        <div class="od-confirm-modal-icon">${renderIcon(iconName)}</div>
        <div class="od-confirm-modal-banner-text">
            <div class="od-confirm-modal-title">${title}</div>
            ${subtitle ? `<div class="od-confirm-modal-subtitle">${subtitle}</div>` : ''}
        </div>
        <button class="od-confirm-modal-close" data-action="close" aria-label="关闭">${CLOSE_SVG}</button>
    </div>
    <div class="od-confirm-modal-body">${message}</div>
    ${challengeHtml}
    ${footerHtml}
</div>`;

        let resolved = false;
        // 仅当调用方显式开启 enterToConfirm 时才会注册，用于在关闭时同步移除
        let enterHandler: ((e: KeyboardEvent) => void) | undefined;
        const close = (result: boolean) => {
            if (resolved) return;
            resolved = true;
            overlay.classList.add('od-modal-leaving');
            setTimeout(() => {
                overlay.remove();
                resolve(result);
            }, ANIM_DURATION_OUT);
            document.removeEventListener('keydown', escHandler);
            if (enterHandler) {
                document.removeEventListener('keydown', enterHandler);
            }
        };

        const escHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close(false);
            }
        };
        document.addEventListener('keydown', escHandler);

        bindOverlayDismiss(
            overlay,
            () => {
                if (cancelText) close(false);
            },
            (t) => !!(t as HTMLElement | null)?.classList?.contains?.('od-confirm-modal-overlay'),
            !hasChallenge
        );

        overlay.querySelector('[data-action="close"]')!.addEventListener('click', () => close(false));
        const cancelBtn = overlay.querySelector('[data-action="cancel"]');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => close(false));
        }

        const confirmBtn = overlay.querySelector('[data-action="confirm"]')! as HTMLButtonElement;
        confirmBtn.addEventListener('click', () => {
            if (hasChallenge && confirmBtn.disabled) return;
            close(true);
        });

        // 回车默认触发"确认"（例如"确认编辑消息"弹窗中回车=继续对话）。
        // 仅当调用方显式开启 enterToConfirm 时才生效，不影响其他确认弹窗。
        // 焦点在可交互元素上时由 shouldConfirmOnEnter 放行给原生行为。
        if (enterToConfirm) {
            enterHandler = (e: KeyboardEvent) => {
                if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
                if (e.isComposing) return;
                if (!shouldConfirmOnEnter(e.target, hasChallenge, confirmBtn.disabled)) return;
                e.preventDefault();
                e.stopPropagation();
                close(true);
            };
            document.addEventListener('keydown', enterHandler);
        }

        if (hasChallenge && challenge) {
            const challengeInput = overlay.querySelector('[data-action="challenge-input"]')! as HTMLInputElement;
            challengeInput.addEventListener('input', () => {
                const matched = challengeInput.value === challenge;
                confirmBtn.disabled = !matched;
            });
            challengeInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !confirmBtn.disabled) {
                    e.preventDefault();
                    close(true);
                }
            });
            setTimeout(() => challengeInput.focus(), ANIM_DURATION_IN);
        }

        mountTarget.appendChild(overlay);
    });
}

/* ================ 关闭窗口确认弹窗 ================ */

export interface CloseDialogOptions {
    title: string;
    message: string;
    cancelText: string;
    minimizeText: string;
    quitText: string;
    dontAskText: string;
    dontAskHint?: string;
    mountTarget?: HTMLElement;
}

export interface CloseDialogResult {
    action: 'quit' | 'minimize' | 'cancel';
    dontAsk: boolean;
}

/**
 * 关闭窗口确认弹窗 -- warn 色带 + 双操作按钮 + "不再询问" 复选框。
 *
 * 设计遵循 modal.html 顶部色带风格，复用 MODAL_CSS 基础样式。
 * 点击关闭按钮 / ESC / 遮罩等同于"取消"（不关闭窗口）。
 */
export function showCloseDialog(options: CloseDialogOptions): Promise<CloseDialogResult> {
    return new Promise((resolve) => {
        const {
            title,
            message,
            cancelText,
            minimizeText,
            quitText,
            dontAskText,
            dontAskHint,
            mountTarget = document.body
        } = options;

        const overlay = document.createElement('div');
        overlay.className = 'od-confirm-modal-overlay';
        if (detectDarkMode(mountTarget)) {
            overlay.classList.add('od-modal-dark');
        }

        overlay.innerHTML = `
<style>${MODAL_CSS}
.od-close-dialog-body { padding: 16px 24px 0; font-size: 13px; color: var(--mc-ink3); line-height: 1.6; }
.od-close-dialog-body b { color: var(--mc-ink2); font-weight: 600; }
.od-close-dialog-checkbox-wrapper { padding: 12px 24px 0; }
.od-close-dialog-checkbox {
    display: flex; align-items: center; gap: 7px;
    font-size: 12px; color: var(--mc-ink2); cursor: pointer;
}
.od-close-dialog-checkbox input { accent-color: var(--mc-accent); width: 14px; height: 14px; }
.od-close-dialog-checkbox-hint {
    color: var(--mc-ink3); font-size: 11px; line-height: 1.5;
    padding-left: 21px; margin-top: 4px;
}
.od-close-dialog-footer {
    padding: 14px 24px 18px; display: flex; justify-content: flex-end; gap: 10px;
    border-top: 1px solid var(--mc-line-soft); margin-top: 16px;
}
</style>
<div class="od-confirm-modal-card">
    <div class="od-confirm-modal-banner warn">
        <div class="od-confirm-modal-icon">${renderIcon('fa-circle-question')}</div>
        <div class="od-confirm-modal-banner-text">
            <div class="od-confirm-modal-title">${title}</div>
        </div>
        <button class="od-confirm-modal-close" data-action="close" aria-label="关闭">${CLOSE_SVG}</button>
    </div>
    <div class="od-close-dialog-body">${message}</div>
    <div class="od-close-dialog-checkbox-wrapper">
        <label class="od-close-dialog-checkbox">
            <input type="checkbox" data-action="dontask" />
            ${dontAskText}
        </label>
        ${dontAskHint ? `<div class="od-close-dialog-checkbox-hint">${dontAskHint}</div>` : ''}
    </div>
    <div class="od-close-dialog-footer">
        <button class="od-confirm-btn od-confirm-btn-cancel" data-action="cancel">${cancelText}</button>
        <button class="od-confirm-btn od-confirm-btn-cancel" data-action="minimize">${minimizeText}</button>
        <button class="od-confirm-btn od-confirm-btn-danger" data-action="quit">${quitText}</button>
    </div>
</div>`;

        let resolved = false;
        const finish = (result: CloseDialogResult) => {
            if (resolved) return;
            resolved = true;
            overlay.classList.add('od-modal-leaving');
            setTimeout(() => {
                overlay.remove();
                resolve(result);
            }, ANIM_DURATION_OUT);
            document.removeEventListener('keydown', escHandler);
        };

        const escHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                finish({ action: 'cancel', dontAsk: false });
            }
        };
        document.addEventListener('keydown', escHandler);

        // 点击遮罩 = 取消（不关闭窗口）
        bindOverlayDismiss(
            overlay,
            () => finish({ action: 'cancel', dontAsk: false }),
            (t) => !!(t as HTMLElement | null)?.classList?.contains?.('od-confirm-modal-overlay')
        );

        const getDontAsk = () =>
            (overlay.querySelector('[data-action="dontask"]') as HTMLInputElement)?.checked ?? false;

        overlay
            .querySelector('[data-action="close"]')!
            .addEventListener('click', () => finish({ action: 'cancel', dontAsk: getDontAsk() }));
        overlay
            .querySelector('[data-action="cancel"]')!
            .addEventListener('click', () => finish({ action: 'cancel', dontAsk: getDontAsk() }));
        overlay
            .querySelector('[data-action="minimize"]')!
            .addEventListener('click', () => finish({ action: 'minimize', dontAsk: getDontAsk() }));
        overlay
            .querySelector('[data-action="quit"]')!
            .addEventListener('click', () => finish({ action: 'quit', dontAsk: getDontAsk() }));

        mountTarget.appendChild(overlay);
    });
}
