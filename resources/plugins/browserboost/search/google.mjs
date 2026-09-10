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
 * 谷歌 hint 定义：Search / SearchImage / SearchNews / SearchVideos / SearchMaps /
 * SearchSite / SearchFile（任意谷歌页面）+ NextPage / PrevPage（仅搜索结果页）。
 *
 * 谷歌垂直搜索统一走 /search 的 tbm 参数：isch=图片、nws=新闻、vid=视频；
 * web/新闻/视频结果页翻页用 start 参数（每页 10 条）。图片结果页为无限滚动，
 * 没有传统分页，因此结果页生成器检测 tbm=isch / udm=2 时不返回翻页动作。
 * SearchSite/SearchFile 基于 site: 与 filetype: 高级运算符拼接查询词。
 */

const GOOGLE_SEARCH_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.google.com/search?q=' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const GOOGLE_IMAGE_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.google.com/search?q=' + encodeURIComponent(kw) + '&tbm=isch';
    return { keyword: kw, navigating: true };
}`;

const GOOGLE_NEWS_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.google.com/search?q=' + encodeURIComponent(kw) + '&tbm=nws';
    return { keyword: kw, navigating: true };
}`;

const GOOGLE_VIDEOS_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.google.com/search?q=' + encodeURIComponent(kw) + '&tbm=vid';
    return { keyword: kw, navigating: true };
}`;

const GOOGLE_MAPS_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.google.com/maps/search/' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const GOOGLE_SITE_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    let site = args && typeof args.site === 'string' ? args.site.trim() : '';
    if (!site) throw new Error('site is required, e.g. zhihu.com');
    site = site.replace(/^https?:\\/\\//i, '').replace(/^www\\./i, '').replace(/[\\/?#].*$/, '');
    if (!site) throw new Error('site looks invalid: pass a domain like zhihu.com');
    const query = kw ? kw + ' site:' + site : 'site:' + site;
    location.href = 'https://www.google.com/search?q=' + encodeURIComponent(query);
    return { query: query, navigating: true };
}`;

const GOOGLE_FILE_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    const ft = args && typeof args.filetype === 'string' ? args.filetype.trim().replace(/^\\./, '') : '';
    if (!kw) throw new Error('keyword is required');
    if (!/^[a-z0-9]{1,10}$/i.test(ft)) throw new Error('filetype looks invalid: use a plain extension like pdf, docx');
    location.href = 'https://www.google.com/search?q=' + encodeURIComponent(kw + ' filetype:' + ft);
    return { keyword: kw, filetype: ft, navigating: true };
}`;

const GOOGLE_NEXT_FN = `async () => {
    const u = new URL(location.href);
    const cur = parseInt(u.searchParams.get('start') || '0', 10) || 0;
    const next = cur + 10;
    u.searchParams.set('start', String(next));
    location.href = u.href;
    return { start: next, navigating: true };
}`;

const GOOGLE_PREV_FN = `async () => {
    const u = new URL(location.href);
    const cur = parseInt(u.searchParams.get('start') || '0', 10) || 0;
    if (cur <= 0) throw new Error('already on the first page');
    const next = cur - 10;
    if (next > 0) u.searchParams.set('start', String(next)); else u.searchParams.delete('start');
    location.href = u.href;
    return { start: next, navigating: true };
}`;

const GOOGLE_SEARCH = {
    kind: 'action',
    name: 'Search',
    description: '在谷歌搜索：按关键词一步跳转到谷歌搜索结果页，无需手动填搜索框',
    args: {
        keyword: '搜索关键词，如：OpenHarmony'
    },
    functionStr: GOOGLE_SEARCH_FN
};

const GOOGLE_IMAGE = {
    kind: 'action',
    name: 'SearchImage',
    description: '在谷歌图片搜索：按关键词跳转到谷歌图片搜索结果页',
    args: {
        keyword: '图片描述关键词，如：富士山日落'
    },
    functionStr: GOOGLE_IMAGE_FN
};

const GOOGLE_NEWS = {
    kind: 'action',
    name: 'SearchNews',
    description: '在谷歌新闻搜索：按关键词跳转到谷歌新闻结果页',
    args: {
        keyword: '新闻关键词，如：芯片'
    },
    functionStr: GOOGLE_NEWS_FN
};

const GOOGLE_VIDEOS = {
    kind: 'action',
    name: 'SearchVideos',
    description: '在谷歌视频搜索：按关键词跳转到谷歌视频结果页',
    args: {
        keyword: '视频关键词，如：无人机评测'
    },
    functionStr: GOOGLE_VIDEOS_FN
};

const GOOGLE_MAPS = {
    kind: 'action',
    name: 'SearchMaps',
    description: '在谷歌地图搜索地点：按名称跳转到谷歌地图搜索结果',
    args: {
        keyword: '地点/POI 名称，如：外滩'
    },
    functionStr: GOOGLE_MAPS_FN
};

const GOOGLE_SITE = {
    kind: 'action',
    name: 'SearchSite',
    description: '在指定网站内搜索（谷歌 site: 语法）：只返回该站收录的页面',
    args: {
        keyword: '搜索关键词；留空则列出该站被收录的页面',
        site: '目标站域名，如 zhihu.com、github.com（自动去掉协议、www 前缀与路径）'
    },
    functionStr: GOOGLE_SITE_FN
};

const GOOGLE_FILE = {
    kind: 'action',
    name: 'SearchFile',
    description: '搜索指定类型的文件（谷歌 filetype: 语法）：快速定位 PDF/文档等资源',
    args: {
        keyword: '搜索关键词',
        filetype: '文件类型扩展名，如 pdf、docx、pptx'
    },
    functionStr: GOOGLE_FILE_FN
};

const GOOGLE_NEXT = {
    kind: 'action',
    name: 'NextPage',
    description: '翻到谷歌搜索结果的下一页（每页 10 条，通过 start 参数）',
    functionStr: GOOGLE_NEXT_FN
};

const GOOGLE_PREV = {
    kind: 'action',
    name: 'PrevPage',
    description: '翻回谷歌搜索结果的上一页',
    functionStr: GOOGLE_PREV_FN
};

const GOOGLE_ACTIONS = [GOOGLE_SEARCH, GOOGLE_IMAGE, GOOGLE_NEWS, GOOGLE_VIDEOS, GOOGLE_MAPS, GOOGLE_SITE, GOOGLE_FILE];

/** 结果页专用生成器：图片结果页是无限滚动，不提供翻页动作 */
function googleResultHints(context) {
    const isImageResult = /[?&](tbm=isch|udm=2)(?=&|$)/.test(context.address || '');
    return isImageResult ? [] : [GOOGLE_NEXT, GOOGLE_PREV];
}

export function registerGoogleHints(ctx) {
    for (const host of ['www.google.com', 'www.google.com.hk']) {
        ctx.browser.hint.register(host, () => GOOGLE_ACTIONS);
        ctx.browser.hint.register(host + '/search', googleResultHints);
    }
}
