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
 * 东方财富 hint 定义：
 * - SearchStock(keyword)：搜索股票/指数，6 位代码直达行情页，5 位代码直达港股页，名称关键词跳搜索页；
 * - SwitchKline(period)：切换 K 线周期（个股/指数/港股页通用，无复权的页面周期较少）；
 * - SwitchFq(type)：切换复权方式（仅个股页有效）；
 * - OpenFundFlow()：打开资金流向页（仅个股页有效）。
 *
 * SearchStock 泛化到所有 *.eastmoney.com 子站（东财全站统一头部搜索框）。
 * K 线周期切换覆盖个股页(sz/sh/bj)、指数页(zs)、港股页(hk/) —— 三者均含 ul.k_tab.mqc_tab。
 * 复权和资金流向仅在个股页注册（指数/港股无 .kfq、资金流向页仅对个股有意义）。
 */

const EM_SEARCH_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    const code6 = kw.match(/^\\d{6}$/);
    if (code6) {
        // 6 位纯数字按市场前缀直达行情页：6 开头沪市(1)，0/3 开头深市(0)，4/8/9 开头北交所(92)
        const first = kw[0];
        const market = first === '6' ? '1' : (first === '0' || first === '3') ? '0' : '92';
        location.href = 'https://quote.eastmoney.com/unify/r/' + market + '.' + kw;
        return { keyword: kw, market: 'A股', navigating: true };
    }
    const code5 = kw.match(/^\\d{5}$/);
    if (code5) {
        // 5 位纯数字按港股处理（带前导 0 的 4 位代码如 0700 也补足 5 位）
        location.href = 'https://quote.eastmoney.com/unify/r/116.' + kw;
        return { keyword: kw, market: '港股', navigating: true };
    }
    location.href = 'https://so.eastmoney.com/web/s?keyword=' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const EM_KLINE_FN = `async (args) => {
    const raw = args && typeof args.period === 'string' && args.period.trim() ? args.period.trim() : '';
    if (!raw) throw new Error('period is required');
    const map = {
        day: '日K', weekly: '周K', monthly: '月K',
        '5m': '5分钟', '15m': '15分钟', '30m': '30分钟', '60m': '60分钟',
        '日K': '日K', '周K': '周K', '月K': '月K',
        '5分钟': '5分钟', '15分钟': '15分钟', '30分钟': '30分钟', '60分钟': '60分钟'
    };
    const label = map[raw.toLowerCase ? raw.toLowerCase() : raw] || map[raw];
    if (!label) throw new Error('unsupported period "' + raw + '": use day|weekly|monthly|5m|15m|30m|60m');
    const tab = document.querySelector('ul.k_tab.mqc_tab');
    if (!tab) throw new Error('kline tab not found: this action only works on eastmoney stock pages');
    const target = [...tab.querySelectorAll('a')].find((a) => (a.textContent || '').trim() === label);
    if (!target) throw new Error('period "' + label + '" not found on this page');
    if (target.className.includes('active')) return { period: label, already: true };
    target.click();
    return { period: label, switched: true };
}`;

const EM_FQ_FN = `async (args) => {
    const raw = args && typeof args.type === 'string' && args.type.trim() ? args.type.trim() : '';
    if (!raw) throw new Error('type is required');
    const map = { qian: '前复权', hou: '后复权', bu: '不复权', '前复权': '前复权', '后复权': '后复权', '不复权': '不复权' };
    const label = map[raw] || map[raw.toLowerCase ? raw.toLowerCase() : raw];
    if (!label) throw new Error('unsupported type "' + raw + '": use qian(前复权) | hou(后复权) | bu(不复权)');
    const wrap = document.querySelector('.kfq');
    if (!wrap) throw new Error('fq selector not found: this action only works on eastmoney stock pages');
    const items = [...wrap.querySelectorAll('li a')];
    const target = items.find((a) => (a.textContent || '').trim() === label);
    if (!target) throw new Error('fq option "' + label + '" not found');
    if (target.className.includes('active')) return { type: label, already: true };
    const trigger = wrap.querySelector('.kfq_t');
    if (trigger) trigger.click();
    target.click();
    return { type: label, switched: true };
}`;

const EM_FUND_FLOW_FN = `async () => {
    const m = location.pathname.match(/(?:sz|sh|bj)(\\d{6})\\.html$/);
    if (!m) throw new Error('not an eastmoney stock page: cannot resolve stock code');
    location.href = 'https://data.eastmoney.com/zjlx/' + m[1] + '.html';
    return { code: m[1], navigating: true };
}`;

const EM_SEARCH = {
    kind: 'action',
    name: 'SearchStock',
    description: '在东方财富搜索股票或指数：6 位代码（如 600519、000858）直达行情页，名称/关键词跳转到东方财富搜索页',
    args: {
        keyword: '股票代码或名称，如 600519、贵州茅台'
    },
    functionStr: EM_SEARCH_FN
};

const EM_KLINE = {
    kind: 'action',
    name: 'SwitchKline',
    description: '切换东方财富个股页的 K 线周期：day(日K) | weekly(周K) | monthly(月K) | 5m | 15m | 30m | 60m',
    args: {
        period: 'day | weekly | monthly | 5m | 15m | 30m | 60m'
    },
    functionStr: EM_KLINE_FN
};

const EM_FQ = {
    kind: 'action',
    name: 'SwitchFq',
    description: '切换东方财富个股页的复权方式：qian(前复权) | hou(后复权) | bu(不复权)',
    args: {
        type: 'qian | hou | bu'
    },
    functionStr: EM_FQ_FN
};

const EM_FUND_FLOW = {
    kind: 'action',
    name: 'OpenFundFlow',
    description: '打开当前东方财富个股的资金流向页（data.eastmoney.com/zjlx/{code}.html）',
    functionStr: EM_FUND_FLOW_FN
};

const EM_F10_FN = `async (args) => {
    const raw = args && typeof args.section === 'string' ? args.section.trim().toLowerCase() : 'cpbd';
    const map = {
        cpbd: 'cpbd', gsgk: 'gsgk', jyfx: 'jyfx', hxtc: 'hxtc', gdyj: 'gdyj',
        gsds: 'gsds', gbjg: 'gbjg', cwfx: 'cwfx', fhrz: 'fhrz', zbyz: 'zbyz',
        thbj: 'thbj', glgg: 'glgg',
        '操盘必读': 'cpbd', '公司概况': 'gsgk', '经营分析': 'jyfx', '核心题材': 'hxtc',
        '股东研究': 'gdyj', '公司大事': 'gsds', '股本结构': 'gbjg', '财务分析': 'cwfx',
        '分红融资': 'fhrz', '资本运作': 'zbyz', '行业分析': 'thbj', '关联个股': 'glgg'
    };
    const section = map[raw] || raw;
    if (!section) throw new Error('section is required: cpbd|gsgk|jyfx|hxtc|gdyj|gsds|gbjg|cwfx|fhrz|zbyz|thbj|glgg');
    const m = location.pathname.match(/([Ss][ZzHh]|[Bb][Jj])\\d{6}\\.html$/);
    if (!m) throw new Error('not an eastmoney stock page: cannot extract stock code');
    const prefix = m[1].toUpperCase();
    const digits = m[0].slice(m[1].length, -5); // sz300059.html → 300059
    location.href = 'https://emweb.securities.eastmoney.com/pc_hsf10/pages/index.html?type=web&code=' + prefix + digits + '&color=b#/' + section;
    return { code: prefix + digits, section: section, navigating: true };
}`;

const EM_SWITCH_MARKET_FN = `async (args) => {
    const raw = args && typeof args.board === 'string' ? args.board.trim() : '';
    if (!raw) throw new Error('board is required');
    const map = {
        hs_a: 'hs_a_board', sh_a: 'sh_a_board', sz_a: 'sz_a_board', bj_a: 'bj_a_board',
        gem: 'gem_board', kcb: 'kcb_board', new: 'newshares', b: 'b_board',
        ab: 'ab_comparison', st: 'st_board', staq: 'staq_net_board',
        '沪深京A股': 'hs_a_board', '上证A股': 'sh_a_board', '深证A股': 'sz_a_board',
        '北证A股': 'bj_a_board', '创业板': 'gem_board', '科创板': 'kcb_board',
        '新股': 'newshares', 'B股': 'b_board', 'AB股比价': 'ab_comparison',
        '风险警示板': 'st_board', '两网及退市': 'staq_net_board'
    };
    const hash = map[raw] || map[raw.toLowerCase()];
    if (!hash) throw new Error('unsupported board "' + raw + '": use hs_a(沪深京A股) | sh_a(上证A股) | sz_a(深证A股) | bj_a(北证A股) | gem(创业板) | kcb(科创板) | new(新股) | b(B股)');
    location.href = 'https://quote.eastmoney.com/center/gridlist.html#' + hash;
    return { board: hash, navigating: true };
}`;

const EM_F10 = {
    kind: 'action',
    name: 'OpenF10',
    description:
        '跳转东方财富 F10 资料页并定位到指定板块：cpbd(操盘必读) | gsgk(公司概况) | jyfx(经营分析) | hxtc(核心题材) | gdyj(股东研究) | gsds(公司大事) | gbjg(股本结构) | cwfx(财务分析) | fhrz(分红融资) | zbyz(资本运作) | thbj(行业分析) | glgg(关联个股)',
    args: {
        section: 'cpbd | gsgk | jyfx | hxtc | gdyj | gsds | gbjg | cwfx | fhrz | zbyz | thbj | glgg，也可用中文'
    },
    functionStr: EM_F10_FN
};

const EM_SWITCH_MARKET = {
    kind: 'action',
    name: 'SwitchMarket',
    description:
        '在行情中心切换行情板块列表：hs_a(沪深京A股) | sh_a(上证A股) | sz_a(深证A股) | bj_a(北证A股) | gem(创业板) | kcb(科创板) | new(新股) | b(B股) | st(风险警示板)',
    args: {
        board: 'hs_a | sh_a | sz_a | bj_a | gem | kcb | new | b | st'
    },
    functionStr: EM_SWITCH_MARKET_FN
};

/** 个股页正则：quote.eastmoney.com/sz300059.html、sh600519.html、bj920001.html 等 */
const EM_STOCK_PAGE_RE = /^quote\.eastmoney\.com\/(?:sz|sh|bj)\d{6}\.html/i;

/** 指数页正则：quote.eastmoney.com/zs000001.html 等（有 K 线周期切换，无复权） */
const EM_INDEX_PAGE_RE = /^quote\.eastmoney\.com\/zs\d{6}\.html/i;

/** 港股页正则：quote.eastmoney.com/hk/00700.html 等（有 K 线周期切换，无复权） */
const EM_HK_PAGE_RE = /^quote\.eastmoney\.com\/hk\/\d{4,5}\.html/i;

/** 行情中心列表页正则：quote.eastmoney.com/center/gridlist.html 等（支持板块 hash 切换） */
const EM_GRIDLIST_PAGE_RE = /^quote\.eastmoney\.com\/center\/gridlist\.html/i;

/**
 * 泛化注册：
 * - SearchStock 覆盖所有 eastmoney.com 子站（东财全站统一头部搜索框）；
 * - K 线周期切换覆盖个股/指数/港股页（三者均有 ul.k_tab.mqc_tab）；
 * - 复权、资金流向、F10 资料仅在个股页注册（指数/港股无 .kfq，资金流向/F10 仅对个股有意义）；
 * - SwitchMarket 在行情中心列表页注册（gridlist.html 的板块 hash 切换）。
 */
export function registerEastmoneyHints(ctx) {
    // SearchStock 覆盖所有东财子站（全站统一头部搜索框），用 ** 匹配裸域名+带路径
    ctx.browser.hint.register('*.eastmoney.com**', () => [EM_SEARCH]);
    ctx.browser.hint.register(EM_STOCK_PAGE_RE, () => [EM_KLINE, EM_FQ, EM_FUND_FLOW, EM_F10]);
    ctx.browser.hint.register(EM_INDEX_PAGE_RE, () => [EM_KLINE]);
    ctx.browser.hint.register(EM_HK_PAGE_RE, () => [EM_KLINE]);
    ctx.browser.hint.register(EM_GRIDLIST_PAGE_RE, () => [EM_SWITCH_MARKET]);
}
