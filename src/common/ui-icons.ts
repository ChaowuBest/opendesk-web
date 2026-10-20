/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * 内联 SVG chevron 图标（线条风格，与输入区模型菜单的展开箭头同款观感）。
 * GUI 图标不使用 Unicode 几何字符（▶ ▸ ▾ 等，跨平台字体渲染差异大），
 * 也不使用 Font Awesome（依赖样式表注入，Shadow DOM 与导出的静态 HTML 中不可用）。
 * 尺寸通过 1em 跟随所在文字的 font-size，颜色继承 currentColor。
 */

const CHEVRON_ATTRS =
    'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
    'style="width:1em;height:1em;display:inline-block;vertical-align:-0.125em"';

/** 右向 chevron；配合 CSS transform: rotate(90deg) 表达展开态 */
export const CHEVRON_RIGHT_SVG = `<svg ${CHEVRON_ATTRS}><path d="M9 6l6 6-6 6"/></svg>`;

/** 下向 chevron */
export const CHEVRON_DOWN_SVG = `<svg ${CHEVRON_ATTRS}><path d="M6 9l6 6 6-6"/></svg>`;

/** 上向 chevron */
export const CHEVRON_UP_SVG = `<svg ${CHEVRON_ATTRS}><path d="M6 15l6-6 6 6"/></svg>`;
