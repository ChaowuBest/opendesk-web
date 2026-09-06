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
 * 知乎 hint 定义：
 * - 全站（www.zhihu.com）：Search(keyword, type)，type=content(全部)|video|user|column，
 *   一步跳到知乎搜索结果页；
 * - 问题页（www.zhihu.com/question）：ExpandContent（一键展开全部"阅读全文"与"显示全部
 *   回复"截断内容）、SortAnswers(mode)（按推荐/按时间排序，URL 驱动，mode=hot|updated）；
 * - 专栏文章页（zhuanlan.zhihu.com）：Search + ExpandContent。
 * 知乎搜索与问题页均为无限滚动加载，无 URL 翻页参数，不提供翻页动作。
 */

const ZHIHU_SEARCH_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    const raw = args && typeof args.type === 'string' && args.type.trim() ? args.type.trim().toLowerCase() : 'content';
    const map = { content: 'content', video: 'zvideo', user: 'people', column: 'column' };
    const t = map[raw];
    if (!t) throw new Error('unsupported type "' + args.type + '": use content | video | user | column');
    location.href = 'https://www.zhihu.com/search?type=' + t + '&q=' + encodeURIComponent(kw);
    return { keyword: kw, type: t, navigating: true };
}`;

const ZHIHU_EXPAND_FN = `async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => el.getBoundingClientRect().width > 0;
    // 知乎按钮文本首尾常带零宽字符（U+200B），需先清洗再匹配
    const txt = (el) => (el.textContent || '').replace(/[\\u200b\\u200c\\u200d\\ufeff]/g, '').trim();
    const isExpandBtn = (t) => t === '阅读全文' || /^(查看全部|显示全部|展开其他|展开)\\s*\\d*\\s*条?回复$/.test(t);
    // 展开后可能出现新的截断按钮（嵌套回复），重复执行直到没有可展开项
    let total = 0;
    for (let round = 0; round < 3; round++) {
        let clicked = 0;
        for (const b of [...document.querySelectorAll('button')]) {
            if (visible(b) && isExpandBtn(txt(b))) {
                b.click();
                clicked += 1;
                total += 1;
                await sleep(250);
            }
        }
        if (!clicked) break;
    }
    return { expandedCount: total };
}`;

const ZHIHU_SORT_FN = `async (args) => {
    const raw = args && typeof args.mode === 'string' && args.mode.trim() ? args.mode.trim().toLowerCase() : 'hot';
    if (!['hot', 'updated'].includes(raw)) throw new Error('unsupported mode "' + args.mode + '": use hot(默认推荐) | updated(按时间)');
    const m = location.pathname.match(/\\/question\\/(\\d+)/);
    if (!m) throw new Error('not a question page: this action only works on zhihu question pages');
    // 按时间排序是 /answers/updated；默认推荐没有独立路径，回到问题主 URL
    location.href = location.origin + '/question/' + m[1] + (raw === 'updated' ? '/answers/updated' : '');
    return { mode: raw, navigating: true };
}`;

const ZHIHU_SEARCH = {
    kind: 'action',
    name: 'Search',
    description: '在知乎搜索：一步跳转到知乎搜索结果页，无需手动填搜索框',
    args: {
        keyword: '搜索关键词，如：React 性能优化',
        type: '可选。content(全部，默认) | video(视频) | user(用户) | column(专栏)'
    },
    functionStr: ZHIHU_SEARCH_FN
};

const ZHIHU_EXPAND = {
    kind: 'action',
    name: 'ExpandContent',
    description: '一键展开本页全部被截断的内容：所有「阅读全文」与「显示全部 N 条回复」，用于读取完整回答/文章/评论',
    functionStr: ZHIHU_EXPAND_FN
};

const ZHIHU_SORT = {
    kind: 'action',
    name: 'SortAnswers',
    description: '切换知乎问题页回答排序',
    args: {
        mode: 'hot(默认推荐) | updated(按时间)'
    },
    functionStr: ZHIHU_SORT_FN
};

export function registerZhihuHints(ctx) {
    ctx.browser.hint.register('www.zhihu.com', () => [ZHIHU_SEARCH]);
    ctx.browser.hint.register('www.zhihu.com/question', () => [ZHIHU_EXPAND, ZHIHU_SORT]);
    ctx.browser.hint.register('zhuanlan.zhihu.com', () => [ZHIHU_SEARCH, ZHIHU_EXPAND]);
}
