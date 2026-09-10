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
 * 百度 hint 定义：Search / SearchImage / SearchNews / SearchVideos / SearchMaps /
 * SearchSite / SearchFile（任意百度页面）+ NextPage / PrevPage（仅搜索结果页）。
 *
 * 百度 web 与新闻（tn=news）结果页都是 www.baidu.com/s，翻页用 pn 参数（每页
 * 10 条，pn=0/10/20…），因此 /s 前缀的翻页动作在两类结果页都可用；图片是独立
 * 域名（image.baidu.com），结果页每页 20 张，pn 翻页单独注册在 image.baidu.com/search。
 * 垂直入口：tn=news（新闻）、
 * /sf/vsearch?pd=video（视频）、image.baidu.com（图片）、map.baidu.com（地图）。
 * SearchSite/SearchFile 基于 site: 与 filetype: 高级语法拼接查询词。
 */

const BAIDU_SEARCH_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.baidu.com/s?ie=utf-8&wd=' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const BAIDU_IMAGE_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://image.baidu.com/search/index?tn=baiduimage&ie=utf-8&word=' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const BAIDU_NEWS_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.baidu.com/s?ie=utf-8&tn=news&word=' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const BAIDU_VIDEOS_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.baidu.com/sf/vsearch?pd=video&wd=' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const BAIDU_MAPS_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://map.baidu.com/search/' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const BAIDU_SITE_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    let site = args && typeof args.site === 'string' ? args.site.trim() : '';
    if (!site) throw new Error('site is required, e.g. zhihu.com');
    site = site.replace(/^https?:\\/\\//i, '').replace(/^www\\./i, '').replace(/[\\/?#].*$/, '');
    if (!site) throw new Error('site looks invalid: pass a domain like zhihu.com');
    const query = kw ? kw + ' site:' + site : 'site:' + site;
    location.href = 'https://www.baidu.com/s?ie=utf-8&wd=' + encodeURIComponent(query);
    return { query: query, navigating: true };
}`;

const BAIDU_FILE_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    const ft = args && typeof args.filetype === 'string' ? args.filetype.trim().replace(/^\\./, '') : '';
    if (!kw) throw new Error('keyword is required');
    if (!/^[a-z0-9]{1,10}$/i.test(ft)) throw new Error('filetype looks invalid: use a plain extension like pdf, docx');
    location.href = 'https://www.baidu.com/s?ie=utf-8&wd=' + encodeURIComponent(kw + ' filetype:' + ft);
    return { keyword: kw, filetype: ft, navigating: true };
}`;

const BAIDU_NEXT_FN = `async () => {
    const u = new URL(location.href);
    const cur = parseInt(u.searchParams.get('pn') || '0', 10) || 0;
    const next = cur + 10;
    u.searchParams.set('pn', String(next));
    location.href = u.href;
    return { pn: next, navigating: true };
}`;

const BAIDU_PREV_FN = `async () => {
    const u = new URL(location.href);
    const cur = parseInt(u.searchParams.get('pn') || '0', 10) || 0;
    if (cur <= 0) throw new Error('already on the first page');
    const next = cur - 10;
    if (next > 0) u.searchParams.set('pn', String(next)); else u.searchParams.delete('pn');
    location.href = u.href;
    return { pn: next, navigating: true };
}`;

const BAIDU_IMG_NEXT_FN = `async () => {
    const u = new URL(location.href);
    const cur = parseInt(u.searchParams.get('pn') || '0', 10) || 0;
    const next = cur + 20;
    u.searchParams.set('pn', String(next));
    location.href = u.href;
    return { pn: next, navigating: true };
}`;

const BAIDU_IMG_PREV_FN = `async () => {
    const u = new URL(location.href);
    const cur = parseInt(u.searchParams.get('pn') || '0', 10) || 0;
    if (cur <= 0) throw new Error('already on the first page');
    const next = cur - 20;
    if (next > 0) u.searchParams.set('pn', String(next)); else u.searchParams.delete('pn');
    location.href = u.href;
    return { pn: next, navigating: true };
}`;

const BAIDU_SEARCH = {
    kind: 'action',
    name: 'Search',
    description: '在百度搜索：按关键词一步跳转到百度搜索结果页，无需手动填搜索框',
    args: {
        keyword: '搜索关键词，如：OpenHarmony'
    },
    functionStr: BAIDU_SEARCH_FN
};

const BAIDU_IMAGE = {
    kind: 'action',
    name: 'SearchImage',
    description: '在百度图片搜索：按关键词跳转到百度图片搜索结果页',
    args: {
        keyword: '图片描述关键词，如：富士山日落'
    },
    functionStr: BAIDU_IMAGE_FN
};

const BAIDU_NEWS = {
    kind: 'action',
    name: 'SearchNews',
    description: '在百度新闻搜索：按关键词跳转到百度新闻结果页',
    args: {
        keyword: '新闻关键词，如：芯片'
    },
    functionStr: BAIDU_NEWS_FN
};

const BAIDU_VIDEOS = {
    kind: 'action',
    name: 'SearchVideos',
    description: '在百度视频搜索：按关键词跳转到百度视频聚合结果页',
    args: {
        keyword: '视频关键词，如：无人机评测'
    },
    functionStr: BAIDU_VIDEOS_FN
};

const BAIDU_MAPS = {
    kind: 'action',
    name: 'SearchMaps',
    description: '在百度地图搜索地点：按名称跳转到百度地图搜索结果',
    args: {
        keyword: '地点/POI 名称，如：外滩'
    },
    functionStr: BAIDU_MAPS_FN
};

const BAIDU_SITE = {
    kind: 'action',
    name: 'SearchSite',
    description: '在指定网站内搜索（百度 site: 语法）：只返回该站收录的页面',
    args: {
        keyword: '搜索关键词；留空则列出该站被收录的页面',
        site: '目标站域名，如 zhihu.com、github.com（自动去掉协议、www 前缀与路径）'
    },
    functionStr: BAIDU_SITE_FN
};

const BAIDU_FILE = {
    kind: 'action',
    name: 'SearchFile',
    description: '搜索指定类型的文件（百度 filetype: 语法）：快速定位 PDF/文档等资源',
    args: {
        keyword: '搜索关键词',
        filetype: '文件类型扩展名，如 pdf、docx、pptx'
    },
    functionStr: BAIDU_FILE_FN
};

const BAIDU_NEXT = {
    kind: 'action',
    name: 'NextPage',
    description: '翻到百度搜索结果的下一页（每页 10 条，通过 pn 参数）',
    functionStr: BAIDU_NEXT_FN
};

const BAIDU_PREV = {
    kind: 'action',
    name: 'PrevPage',
    description: '翻回百度搜索结果的上一页',
    functionStr: BAIDU_PREV_FN
};

const BAIDU_IMG_NEXT = {
    kind: 'action',
    name: 'NextPage',
    description: '翻到百度图片搜索结果的下一页（每页 20 张，通过 pn 参数）',
    functionStr: BAIDU_IMG_NEXT_FN
};

const BAIDU_IMG_PREV = {
    kind: 'action',
    name: 'PrevPage',
    description: '翻回百度图片搜索结果的上一页',
    functionStr: BAIDU_IMG_PREV_FN
};

const BAIDU_ACTIONS = [BAIDU_SEARCH, BAIDU_IMAGE, BAIDU_NEWS, BAIDU_VIDEOS, BAIDU_MAPS, BAIDU_SITE, BAIDU_FILE];

export function registerBaiduHints(ctx) {
    ctx.browser.hint.register('www.baidu.com', () => BAIDU_ACTIONS);
    ctx.browser.hint.register('www.baidu.com/s', () => [BAIDU_NEXT, BAIDU_PREV]);
    ctx.browser.hint.register('image.baidu.com/search', () => [BAIDU_IMG_NEXT, BAIDU_IMG_PREV]);
}
