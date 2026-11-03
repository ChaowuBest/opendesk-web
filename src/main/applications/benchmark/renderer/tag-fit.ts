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
 * 卡片/标题行胶囊的宽度预算计算。
 *
 * 抽成纯函数是因为裁剪逻辑最容易在边界上错（差一个 gap、兜底胶囊自己的宽度），
 * 而这些边界在没有布局能力的 DOM 环境里根本测不到。
 */

/** 胶囊的列间距，与 style.css 里 `.card-meta { gap }` 保持一致；读不到真实样式时用它兜底 */
export const PILL_GAP_PX = 6;

/**
 * 读 flex 容器的列间距。
 *
 * 不能用裸的全局 getComputedStyle：渲染层跑在没有布局实现的环境里（单测用的 linkedom）
 * 这个全局压根不存在，直接调用会抛 ReferenceError 把整棵渲染打断。
 */
export function resolveColumnGap(el: { ownerDocument?: Document | null }, fallback = PILL_GAP_PX): number {
    const view = el.ownerDocument?.defaultView;
    if (!view || typeof view.getComputedStyle !== 'function') return fallback;
    const parsed = Number.parseFloat(view.getComputedStyle(el as Element).columnGap || '');
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 从头累加宽度，返回在 budget 内放得下的胶囊个数。
 *
 * @param widths 各胶囊的实测宽度，顺序与实际渲染顺序一致
 * @param budget 可用宽度（不含兜底胶囊）
 * @param gap 相邻胶囊之间的间距
 * @param limit 最多只考虑前 limit 个（尾部要留给「等 N 个」兜底胶囊时传 length - 1）
 */
export function countTagsFitting(widths: number[], budget: number, gap: number, limit: number): number {
    const max = Math.min(limit, widths.length);
    let used = 0;
    let keep = 0;
    for (let i = 0; i < max; i += 1) {
        const next = used + (i > 0 ? gap : 0) + widths[i];
        if (next > budget) break;
        used = next;
        keep = i + 1;
    }
    return keep;
}
