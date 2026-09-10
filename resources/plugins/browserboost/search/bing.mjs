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
 * 必应 hint 定义：Search / SearchImage / SearchNews / SearchVideos / SearchMaps /
 * SearchSite / SearchFile（任意必应页面）+ NextPage / PrevPage（仅 web 搜索结果页）。
 *
 * 必应垂直搜索用不同路径区分：/search（网页）、/images/search（图片）、
 * /news/search（新闻）、/videos/search（视频）；web 结果页翻页用 first 参数
 * （每页 10 条，first=1/11/21…），图片结果页每页 35 张（first=1/36/71…），
 * 两类结果页分别注册翻页动作；新闻/视频结果页的 URL 翻页不可靠，不提供。
 * 国内网络下 www.bing.com 会 302 到 cn.bing.com，两个域名都注册；国内版必应
 * 不支持 filetype:/ext: 高级语法，因此不提供 SearchFile 动作。
 * SearchSite/SearchFile 基于 site: 与 filetype: 高级运算符拼接查询词。
 */

const BING_SEARCH_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.bing.com/search?q=' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const BING_IMAGE_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.bing.com/images/search?q=' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const BING_NEWS_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.bing.com/news/search?q=' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const BING_VIDEOS_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.bing.com/videos/search?q=' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const BING_MAPS_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.bing.com/maps?q=' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const BING_SITE_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    let site = args && typeof args.site === 'string' ? args.site.trim() : '';
    if (!site) throw new Error('site is required, e.g. zhihu.com');
    site = site.replace(/^https?:\\/\\//i, '').replace(/^www\\./i, '').replace(/[\\/?#].*$/, '');
    if (!site) throw new Error('site looks invalid: pass a domain like zhihu.com');
    const query = kw ? kw + ' site:' + site : 'site:' + site;
    location.href = 'https://www.bing.com/search?q=' + encodeURIComponent(query);
    return { query: query, navigating: true };
}`;

const BING_NEXT_FN = `async () => {
    const u = new URL(location.href);
    const cur = parseInt(u.searchParams.get('first') || '1', 10) || 1;
    const next = cur + 10;
    u.searchParams.set('first', String(next));
    location.href = u.href;
    return { first: next, navigating: true };
}`;

const BING_PREV_FN = `async () => {
    const u = new URL(location.href);
    const cur = parseInt(u.searchParams.get('first') || '1', 10) || 1;
    if (cur <= 1) throw new Error('already on the first page');
    const next = cur - 10;
    if (next > 1) u.searchParams.set('first', String(next)); else u.searchParams.delete('first');
    location.href = u.href;
    return { first: Math.max(1, next), navigating: true };
}`;

const BING_IMG_NEXT_FN = `async () => {
    const u = new URL(location.href);
    const cur = parseInt(u.searchParams.get('first') || '1', 10) || 1;
    const next = cur + 35;
    u.searchParams.set('first', String(next));
    location.href = u.href;
    return { first: next, navigating: true };
}`;

const BING_IMG_PREV_FN = `async () => {
    const u = new URL(location.href);
    const cur = parseInt(u.searchParams.get('first') || '1', 10) || 1;
    if (cur <= 1) throw new Error('already on the first page');
    const next = cur - 35;
    if (next > 1) u.searchParams.set('first', String(next)); else u.searchParams.delete('first');
    location.href = u.href;
    return { first: Math.max(1, next), navigating: true };
}`;

const BING_SEARCH = {
    kind: 'action',
    name: 'Search',
    description: '在必应搜索：按关键词一步跳转到必应搜索结果页，无需手动填搜索框',
    args: {
        keyword: '搜索关键词，如：OpenHarmony'
    },
    functionStr: BING_SEARCH_FN
};

const BING_IMAGE = {
    kind: 'action',
    name: 'SearchImage',
    description: '在必应图片搜索：按关键词跳转到必应图片搜索结果页',
    args: {
        keyword: '图片描述关键词，如：富士山日落'
    },
    functionStr: BING_IMAGE_FN
};

const BING_NEWS = {
    kind: 'action',
    name: 'SearchNews',
    description: '在必应新闻搜索：按关键词跳转到必应新闻结果页',
    args: {
        keyword: '新闻关键词，如：芯片'
    },
    functionStr: BING_NEWS_FN
};

const BING_VIDEOS = {
    kind: 'action',
    name: 'SearchVideos',
    description: '在必应视频搜索：按关键词跳转到必应视频结果页',
    args: {
        keyword: '视频关键词，如：无人机评测'
    },
    functionStr: BING_VIDEOS_FN
};

const BING_MAPS = {
    kind: 'action',
    name: 'SearchMaps',
    description: '在必应地图搜索地点：按名称跳转到必应地图搜索结果',
    args: {
        keyword: '地点/POI 名称，如：外滩'
    },
    functionStr: BING_MAPS_FN
};

const BING_SITE = {
    kind: 'action',
    name: 'SearchSite',
    description: '在指定网站内搜索（必应 site: 语法）：只返回该站收录的页面',
    args: {
        keyword: '搜索关键词；留空则列出该站被收录的页面',
        site: '目标站域名，如 zhihu.com、github.com（自动去掉协议、www 前缀与路径）'
    },
    functionStr: BING_SITE_FN
};

const BING_NEXT = {
    kind: 'action',
    name: 'NextPage',
    description: '翻到必应搜索结果的下一页（每页 10 条，通过 first 参数）',
    functionStr: BING_NEXT_FN
};

const BING_PREV = {
    kind: 'action',
    name: 'PrevPage',
    description: '翻回必应搜索结果的上一页',
    functionStr: BING_PREV_FN
};

const BING_IMG_NEXT = {
    kind: 'action',
    name: 'NextPage',
    description: '翻到必应图片搜索结果的下一页（每页 35 张，通过 first 参数）',
    functionStr: BING_IMG_NEXT_FN
};

const BING_IMG_PREV = {
    kind: 'action',
    name: 'PrevPage',
    description: '翻回必应图片搜索结果的上一页',
    functionStr: BING_IMG_PREV_FN
};

const BING_ACTIONS = [BING_SEARCH, BING_IMAGE, BING_NEWS, BING_VIDEOS, BING_MAPS, BING_SITE];

export function registerBingHints(ctx) {
    for (const host of ['www.bing.com', 'cn.bing.com', 'bing.com']) {
        ctx.browser.hint.register(host, () => BING_ACTIONS);
        ctx.browser.hint.register(host + '/search', () => [BING_NEXT, BING_PREV]);
        ctx.browser.hint.register(host + '/images/search', () => [BING_IMG_NEXT, BING_IMG_PREV]);
    }
}
