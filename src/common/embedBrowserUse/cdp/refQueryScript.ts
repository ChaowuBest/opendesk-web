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
 * 注入脚本共用的片段集合。
 *
 * 快照的 DOM walk 会下钻 open shadow root 并给 shadow 内元素打 data-od-ref，
 * 但操作端（click/type/selectOption/scrollTo/uploadFile/坐标解析）此前全部用
 * light-DOM 的 document.querySelector 解析 ref，导致 shadow 内元素"快照可见、
 * 操作不可达"。宿主各脚本统一内插这些片段。
 *
 * 各片段必须内插在 IIFE 顶层（函数声明提升对整个作用域生效）。
 */
export const OD_REF_QUERY_HELPER = `
function __odFindRef(ref) {
    function deep(root, ref) {
        if (!root || !root.querySelector) return null;
        try {
            var hit = root.querySelector('[data-od-ref="' + ref + '"]');
            if (hit) return hit;
        } catch (e) { /* 非法选择器等 */ }
        var hosts;
        try { hosts = root.querySelectorAll('*'); } catch (e) { return null; }
        for (var i = 0; i < hosts.length; i++) {
            var sr = hosts[i].shadowRoot;
            if (sr) {
                var found = deep(sr, ref);
                if (found) return found;
            }
        }
        return null;
    }
    return deep(document, ref);
}
`;

/**
 * 注入脚本共用的"可见文本"提取。
 *
 * 直接 `el.innerText || el.textContent` 会踩坑：元素里只有 <style>/<script>
 * 这类不可见子节点时 innerText 是空串，回退到 textContent 就把整段 CSS/JS 文本
 * 当成了元素名称或文本（真实站点上表现为 listitem 名称是一堆 `.b_rs .b_vList…`）。
 * 这里在回退前先把这些不可见标签从克隆树里摘掉。
 */
export const OD_VISIBLE_TEXT_HELPER = `
function __odVisibleText(el) {
    if (!el) return '';
    var text = '';
    try { text = el.innerText || ''; } catch (e) { text = ''; }
    if (text && text.replace(/[\\s\\u00A0]+/g, ' ').trim()) return text;
    if (!el.textContent) return '';
    if (!el.cloneNode) return el.textContent;
    var clone;
    try { clone = el.cloneNode(true); } catch (e) { return el.textContent; }
    var junkTags = ['style', 'script', 'noscript', 'template', 'head'];
    for (var i = 0; i < junkTags.length; i++) {
        var junk = clone.querySelectorAll ? clone.querySelectorAll(junkTags[i]) : [];
        for (var j = 0; j < junk.length; j++) {
            if (junk[j].parentNode) junk[j].parentNode.removeChild(junk[j]);
        }
    }
    return clone.textContent || '';
}
`;

/**
 * 注入脚本共用的组合树祖先判定。
 *
 * document.elementFromPoint 对命中 shadow 内元素的点会 retarget 成 shadow 宿主
 * ——遮挡校验若只用同树的 contains 判定，shadow 内元素的点击坐标会被误判为
 * "被宿主遮挡"（快照可见、实际可点的元素得到虚假的遮挡警告）。此片段沿
 * parentNode/shadowRoot.host 链向上判定组合树祖先关系，替代裸 contains。
 */
export const OD_COMPOSED_ANCESTOR_HELPER = `
function isComposedAncestor(anc, node) {
    var n = node;
    while (n) {
        if (n === anc) return true;
        var p = n.parentNode;
        n = p && p.nodeType === 11 && p.host ? p.host : p;
    }
    return false;
}
`;
