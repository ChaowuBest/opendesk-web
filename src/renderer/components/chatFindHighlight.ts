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

// 高亮绘制层：普通文字使用 CSS Highlight API，SVG 文字使用临时多边形覆盖。
// 本模块只处理绘制和坐标换算，不负责查找关键词或加载消息。
import { FIND_DECORATION } from './chatFindContent.js';

// 普通结果与当前选中结果分开登记，当前结果使用更高优先级的颜色。
const MATCH_HIGHLIGHT = 'od-chat-find-match';
const ACTIVE_HIGHLIGHT = 'od-chat-find-active';
// W3C 规定的 SVG 命名空间；createElementNS 据此创建真正的 SVG 元素，不会请求此地址。
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
// 文档、Shadow DOM 和 iframe 有样式边界，需要为含命中的各个根单独注入相同规则。
const HIGHLIGHT_STYLES = `
::highlight(${MATCH_HIGHLIGHT}) {
    background-color: #ffe08a;
    color: #302000;
}

::highlight(${ACTIVE_HIGHLIGHT}) {
    background-color: #ff963f;
    color: #241000;
}
`;

/** 统一管理临时样式、SVG 装饰和各文档的高亮登记，关闭或重绘时可完整清除。 */
export class ChatFindHighlighter {
    // decorations 保存要移除的真实节点，documents/styledRoots 避免同轮绘制中重复初始化。
    private decorations: Element[] = [];
    private documents = new Set<Document>();
    private styledRoots = new Set<Node>();

    /** 清除上一轮绘制；既清理浏览器高亮登记，也删除注入的样式和 SVG 节点。 */
    clear(): void {
        for (const doc of this.documents) {
            doc.defaultView?.CSS?.highlights?.delete(MATCH_HIGHLIGHT);
            doc.defaultView?.CSS?.highlights?.delete(ACTIVE_HIGHLIGHT);
        }
        for (const decoration of this.decorations) decoration.remove();
        this.decorations = [];
        this.documents.clear();
        this.styledRoots.clear();
    }

    /** 登记一段文字的高亮；active 表示该段属于当前选中的搜索结果。 */
    add(range: Range, active: boolean): void {
        const element = range.startContainer.parentElement;
        if (!element) return;
        const svgText = element.closest('text');
        if (svgText?.namespaceURI === SVG_NAMESPACE) {
            this.paintSvg(range, svgText as SVGTextElement, active);
            return;
        }
        // iframe 有自己的窗口和高亮登记表，因此必须使用 Range 所属文档的 API。
        const doc = range.startContainer.ownerDocument!;
        const view = doc.defaultView;
        if (!view?.CSS?.highlights || !view.Highlight) return;
        if (!this.documents.has(doc)) {
            view.CSS.highlights.set(MATCH_HIGHLIGHT, new view.Highlight());
            const activeHighlight = new view.Highlight();
            // 当前结果同时属于普通命中集合，提高优先级使其颜色覆盖普通结果。
            activeHighlight.priority = 1;
            view.CSS.highlights.set(ACTIVE_HIGHLIGHT, activeHighlight);
            this.documents.add(doc);
        }
        view.CSS.highlights.get(MATCH_HIGHLIGHT)!.add(range);
        if (active) view.CSS.highlights.get(ACTIVE_HIGHLIGHT)!.add(range);
        // 高亮登记在文档上，但规则还需要注入文字所在的 ShadowRoot（或普通文档 head）。
        const root = range.startContainer.getRootNode();
        if (!this.styledRoots.has(root)) {
            const style = doc.createElement('style');
            style.setAttribute(FIND_DECORATION, '');
            style.textContent = HIGHLIGHT_STYLES;
            const shadowRoot = root as ShadowRoot;
            if (shadowRoot.host) {
                shadowRoot.appendChild(style);
            } else {
                doc.head.appendChild(style);
            }
            this.decorations.push(style);
            this.styledRoots.add(root);
        }
    }

    /** 根据命中字符的矩形绘制 SVG 底色，支持只高亮图形标签中的部分文字。 */
    private paintSvg(range: Range, text: SVGTextElement, active: boolean): void {
        const svg = text.ownerSVGElement;
        const matrix = svg?.getScreenCTM();
        if (!svg || !matrix) return; // 隐藏预览可参与搜索；没有可用布局矩阵时，等导航展开后再绘制。
        const inverse = matrix.inverse();
        const group = svg.ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
        group.setAttribute(FIND_DECORATION, '');
        // 装饰不接管鼠标事件，也不向屏幕阅读器重复暴露内容。
        group.setAttribute('pointer-events', 'none');
        group.setAttribute('aria-hidden', 'true');
        // Range 的矩形已经包含 text/tspan 排版和具体字符位置，一次命中可能对应多个矩形。
        // 用屏幕变换矩阵的逆矩阵，把窗口坐标换回 SVG 坐标，使高亮随图形一起缩放。
        for (const rect of Array.from(range.getClientRects())) {
            if (!rect.width || !rect.height) continue;
            const polygon = svg.ownerDocument.createElementNS(SVG_NAMESPACE, 'polygon');
            const viewportCorners = [
                [rect.left, rect.top],
                [rect.right, rect.top],
                [rect.right, rect.bottom],
                [rect.left, rect.bottom]
            ];
            const svgPoints: string[] = [];
            for (const [x, y] of viewportCorners) {
                const screenPoint = svg.createSVGPoint();
                screenPoint.x = x;
                screenPoint.y = y;
                const svgPoint = screenPoint.matrixTransform(inverse);
                svgPoints.push(`${svgPoint.x},${svgPoint.y}`);
            }
            polygon.setAttribute('points', svgPoints.join(' '));
            polygon.setAttribute('fill', active ? '#ff963f' : '#ffe08a');
            polygon.setAttribute('fill-opacity', '0.5');
            group.append(polygon);
        }
        if (group.childNodes.length) {
            svg.append(group);
            this.decorations.push(group);
        }
    }
}

/** 获取命中在外层聊天视口中的矩形，供滚动定位使用；iframe 内的坐标需要逐层向外累加。 */
export function chatFindRangeRect(range: Range): {
    top: number;
    bottom: number;
    left: number;
    right: number;
    height: number;
    width: number;
} {
    const rect = range.getBoundingClientRect();
    let top = rect.top;
    let left = rect.left;
    let view = range.startContainer.ownerDocument?.defaultView;
    // Range 的原始坐标相对于所属窗口；每跨一层 iframe，加上框架位置及其边框宽度。
    while (view?.frameElement) {
        const frame = view.frameElement;
        const frameRect = frame.getBoundingClientRect();
        top += frameRect.top + frame.clientTop;
        left += frameRect.left + frame.clientLeft;
        view = frame.ownerDocument.defaultView;
    }
    return { top, left, bottom: top + rect.height, right: left + rect.width, height: rect.height, width: rect.width };
}
