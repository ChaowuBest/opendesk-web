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
 * 同花顺 hint 定义：
 * - NavigateToStock(code)：跳转到指定股票的个股页（全站通用，导航动作）；
 * - SwitchKline(period)：切换 K 线周期（分时/日K/周K/月K/季K/年K/120分/60分/30分/15分/1分）；
 * - SwitchTab(tab)：切换左侧功能 Tab（资料/资讯/盘口/资金）；
 * - OpenF10()：打开当前个股的 F10 资料页（basic.10jqka.com.cn/{code}/）。
 */

const THS_NAV_STOCK_FN = `async (args) => {
    const code = args && typeof args.code === 'string' ? args.code.trim() : '';
    if (!code || !/^\\d{6}$/.test(code)) throw new Error('code is required: must be a 6-digit stock code');
    location.href = 'https://stockpage.10jqka.com.cn/' + code + '/';
    return { code: code, navigating: true };
}`;

const THS_KLINE_FN = `async (args) => {
    const raw = args && typeof args.period === 'string' && args.period.trim() ? args.period.trim() : '';
    if (!raw) throw new Error('period is required');
    const map = {
        minute: '分时', day: '日K', weekly: '周K', monthly: '月K', quarterly: '季K', yearly: '年K',
        '120m': '120分', '60m': '60分', '30m': '30分', '15m': '15分', '1m': '1分',
        '分时': '分时', '日K': '日K', '周K': '周K', '月K': '月K', '季K': '季K', '年K': '年K',
        '120分': '120分', '60分': '60分', '30分': '30分', '15分': '15分', '1分': '1分'
    };
    const label = map[raw] || map[raw.toLowerCase()];
    if (!label) throw new Error('unsupported period "' + raw + '": use minute|day|weekly|monthly|quarterly|yearly|120m|60m|30m|15m|1m');
    const target = [...document.querySelectorAll('button')].find(
        (b) => (b.textContent || '').trim() === label && b.children.length === 0
    );
    if (!target) throw new Error('period "' + label + '" not found on this page');
    const isActive = target.className.includes('font-[600]');
    if (isActive) return { period: label, already: true };
    target.click();
    return { period: label, switched: true };
}`;

const THS_TAB_FN = `async (args) => {
    const raw = args && typeof args.tab === 'string' ? args.tab.trim() : '';
    if (!raw) throw new Error('tab is required');
    const map = {
        profile: '/corporate-profile/', news: '/news/', quote: '/stock-quote/', money: '/money-flow/',
        '资料': '/corporate-profile/', '资讯': '/news/', '盘口': '/stock-quote/', '资金': '/money-flow/'
    };
    const suffix = map[raw] || map[raw.toLowerCase()];
    if (!suffix) throw new Error('unsupported tab "' + raw + '": use profile(资料) | news(资讯) | quote(盘口) | money(资金)');
    const codeMatch = location.pathname.match(/\\/(\\d{6})\\//);
    if (!codeMatch) throw new Error('not a ths stock page: cannot resolve stock code from URL');
    location.href = location.origin + '/' + codeMatch[1] + suffix;
    return { tab: raw, navigating: true };
}`;

const THS_OPEN_F10_FN = `async () => {
    const codeMatch = location.pathname.match(/\\/(\\d{6})\\//);
    if (!codeMatch) throw new Error('not a ths stock page: cannot resolve stock code from URL');
    location.href = 'https://basic.10jqka.com.cn/' + codeMatch[1] + '/';
    return { code: codeMatch[1], navigating: true };
}`;

const THS_NAV_STOCK = {
    kind: 'action',
    name: 'NavigateToStock',
    description: '跳转到同花顺个股行情页：输入 6 位股票代码直接打开对应个股页面',
    args: {
        code: '6 位股票代码，如 600519'
    },
    functionStr: THS_NAV_STOCK_FN
};

const THS_KLINE = {
    kind: 'action',
    name: 'SwitchKline',
    description:
        '切换同花顺个股页的 K 线周期：minute(分时) | day(日K) | weekly(周K) | monthly(月K) | quarterly(季K) | yearly(年K) | 120m | 60m | 30m | 15m | 1m',
    args: {
        period: 'minute | day | weekly | monthly | quarterly | yearly | 120m | 60m | 30m | 15m | 1m'
    },
    functionStr: THS_KLINE_FN
};

const THS_TAB = {
    kind: 'action',
    name: 'SwitchTab',
    description: '切换同花顺个股页左侧功能 Tab：profile(资料) | news(资讯) | quote(盘口) | money(资金)',
    args: {
        tab: 'profile | news | quote | money'
    },
    functionStr: THS_TAB_FN
};

const THS_OPEN_F10 = {
    kind: 'action',
    name: 'OpenF10',
    description: '打开当前同花顺个股的 F10 资料页（basic.10jqka.com.cn/{code}/）',
    functionStr: THS_OPEN_F10_FN
};

export function registerThsHints(ctx) {
    // NavigateToStock 覆盖所有同花顺子站（导航动作，与页面自带搜索无关）
    ctx.browser.hint.register('*.10jqka.com.cn**', () => [THS_NAV_STOCK]);
    // K 线周期 / Tab 切换 / F10 仅在个股页有效
    ctx.browser.hint.register('stockpage.10jqka.com.cn', () => [THS_KLINE, THS_TAB, THS_OPEN_F10]);
}
