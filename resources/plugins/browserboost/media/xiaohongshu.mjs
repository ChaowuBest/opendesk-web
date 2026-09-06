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
 * 小红书 hint 定义：
 * - 全站（www.xiaohongshu.com）：Search(keyword)，一步跳到小红书搜索结果页。
 * 小红书 PC 站的搜索结果为无限滚动（无 URL 翻页参数），笔记/用户等结果类型 tab
 * 由前端状态驱动（URL 不含可用的 type 参数），因此仅提供搜索入口动作。
 */

const XHS_SEARCH_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const XHS_SEARCH = {
    kind: 'action',
    name: 'Search',
    description: '在小红书搜索：一步跳转到小红书搜索结果页，无需手动填搜索框',
    args: {
        keyword: '搜索关键词，如：露营装备清单'
    },
    functionStr: XHS_SEARCH_FN
};

export function registerXiaohongshuHints(ctx) {
    ctx.browser.hint.register('www.xiaohongshu.com', () => [XHS_SEARCH]);
}
