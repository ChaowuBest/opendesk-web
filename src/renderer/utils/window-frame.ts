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
 * Linux 自绘圆角窗口（html.window-rounded）下的浮层坐标换算工具。
 *
 * 背景：window-rounded 时（见 styles/titlebar.css 与 main/windows/linux-window-shadow.ts），
 * #app-root 为 position:fixed + inset:var(--od-window-margin) + transform —— 它既是
 * 其 fixed 后代的包含块，又整体相对视口内缩一圈阴影边距。挂在 #app-root 子树内的
 * fixed 浮层若沿用视口坐标（getBoundingClientRect / clientX / window.innerWidth）
 * 定位，会整体偏移一个边距；最大化/全屏时 margin 折叠为 0，偏移随之消失。
 *
 * - fixedLayerOrigin(el)：求 el 所属 fixed 包含块原点在视口中的坐标。浮层定位时用
 *   「视口期望坐标 - 原点」得到应写入的 left/top。沿祖先链查找（穿透 shadow 宿主），
 *   中间存在任意带 transform 的祖先时依然正确；无包含块建立者时视口即原点 (0, 0)。
 * - visibleViewportRect()：窗口内可视内容矩形（视口坐标）。浮层的防溢出修正应基于
 *   它而非 window.innerWidth/innerHeight，否则边界情形会把菜单收进阴影边距区。
 */

export interface ViewportPoint {
    x: number;
    y: number;
}

export interface ViewportRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/**
 * 判断计算样式是否为 fixed 后代建立包含块（transform/perspective/filter/
 * backdrop-filter/will-change/contain 的 CSS Containment 规则）。
 * 空值统一按 none 处理，兼容测试环境的简化样式对象。
 */
function establishesContainingBlock(style: CSSStyleDeclaration): boolean {
    const orNone = (value: string | undefined): string => value || 'none';
    const backdrop = orNone(style.getPropertyValue ? style.getPropertyValue('backdrop-filter') : undefined);
    return (
        orNone(style.transform) !== 'none' ||
        orNone(style.perspective) !== 'none' ||
        orNone(style.filter) !== 'none' ||
        backdrop !== 'none' ||
        /transform|perspective|filter/.test(style.willChange || '') ||
        /paint|layout/.test(style.contain || '')
    );
}

/**
 * 求元素所属 fixed 包含块的原点（视口坐标）。
 *
 * 包含块 = 沿祖先链向上第一个为 fixed 后代建立包含块的祖先的 padding box 左上角
 * （含 shadow 边界：ShadowRoot 自身不参与判定，向上落到宿主元素继续查找）；
 * 不存在时 fixed 以视口为包含块，返回 (0, 0)。
 */
export function fixedLayerOrigin(el: HTMLElement): ViewportPoint {
    let node: Node | null = el.parentNode;
    while (node) {
        let candidate: Element | null = null;
        if (node.nodeType === 11 && 'host' in node) {
            // ShadowRoot（DOCUMENT_FRAGMENT_NODE 且带 host）：穿透 shadow 边界，
            // 包含块判定向上落到宿主元素继续
            candidate = (node as ShadowRoot).host;
            node = candidate ? candidate.parentNode : null;
        } else if (node.nodeType === 1) {
            // ELEMENT_NODE：以 nodeType 判定而非 instanceof，兼容未暴露
            // Element 构造器的 DOM 实现（如测试环境的 linkedom）
            candidate = node as Element;
            node = node.parentNode;
        } else {
            break;
        }
        const view = candidate?.ownerDocument?.defaultView;
        if (!candidate || !view) break;
        // 简化 DOM 实现（如测试环境的 linkedom）可能未提供 getComputedStyle，
        // 此时无法判定包含块，视为非建立者继续向上
        const style = view.getComputedStyle?.(candidate);
        if (!style || !establishesContainingBlock(style)) continue;
        const rect = candidate.getBoundingClientRect();
        // fixed 元素的包含块是祖先的 padding box，需补上边框宽度
        return {
            x: rect.left + (parseFloat(style.borderLeftWidth) || 0),
            y: rect.top + (parseFloat(style.borderTopWidth) || 0)
        };
    }
    return { x: 0, y: 0 };
}

/** 把视口坐标换算为 el 所属 fixed 包含块中的坐标。 */
export function viewportToLayer(el: HTMLElement, x: number, y: number): ViewportPoint {
    const origin = fixedLayerOrigin(el);
    return { x: x - origin.x, y: y - origin.y };
}

/**
 * 窗口内可视内容矩形（视口坐标）：window-rounded 下即 #app-root（圆角内容区）
 * 的矩形，最大化/全屏及其他平台退化为整个窗口视口。浮层防溢出修正统一用它。
 */
export function visibleViewportRect(): ViewportRect {
    const root = typeof document !== 'undefined' ? document.getElementById('app-root') : null;
    if (root) {
        const rect = root.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        }
    }
    return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}
