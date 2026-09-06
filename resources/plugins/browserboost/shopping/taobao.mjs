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
 * 淘宝 hint 定义：SearchItem（按商品名搜索）+ FilterItem（结果页筛选）。
 *
 * 淘宝 PC 搜索页（s.taobao.com）为 React 新版，组件类名是 CSS modules hash
 * （如 filterItem--zt4XUO0b），因此全部使用 [class*=] 前缀匹配 + 文本/role
 * 匹配定位。排序与筛选均为前端状态驱动（sort= 参数对结果页无效），只能模拟
 * 点击；筛选面板（右侧"筛选"）中的选项点击后立即生效。
 */

const TB_SEARCH_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://s.taobao.com/search?q=' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const TB_FILTER_FN = `async (args) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => el.getBoundingClientRect().width > 0;
    const txt = (el) => (el.textContent || '').trim();
    const setVal = (el, v) => {
        el.focus();
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        if (desc && desc.set) desc.set.call(el, v); else el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const results = [];
    if (!args || typeof args !== 'object') throw new Error('args object is required');
    const keys = ['sort', 'cat', 'price', 'brand', 'shipping'];
    const hasAny = keys.some((k) => args[k] !== undefined && args[k] !== null && args[k] !== '');
    if (!hasAny) throw new Error('no filter specified: pass one of sort/cat/price/brand/shipping');

    if (args.sort !== undefined && args.sort !== '') {
        const sortVal = String(args.sort).toLowerCase();
        const map = { default: '综合', sales: '销量', price: '价格', pricedesc: '价格' };
        const name = map[sortVal];
        if (!name) throw new Error('unsupported sort "' + args.sort + '": use default | sales | price | pricedesc');
        const tab = [...document.querySelectorAll('[role="tab"]')].find((el) => visible(el) && txt(el) === name);
        if (!tab) throw new Error('sort tab "' + name + '" not found');
        if (tab.getAttribute('aria-selected') === 'true') {
            results.push('sort already: ' + name);
        } else {
            tab.click();
            await sleep(500);
            if (name === '价格') {
                // 淘宝价格 tab 点击后弹出排序方向菜单，需要二次选择
                const label = sortVal === 'pricedesc' ? '从高到低' : '从低到高';
                const opt = [...document.querySelectorAll('[class*="priceTabOverLay"] *')].find((el) => txt(el) === label && el.children.length === 0);
                if (!opt) throw new Error('price order "' + label + '" not found');
                opt.click();
                results.push('sorted by price ' + (sortVal === 'pricedesc' ? '(high to low)' : '(low to high)'));
            } else {
                results.push('sorted by ' + name);
            }
            await sleep(900);
        }
    }

    if (args.cat !== undefined && args.cat !== '') {
        const map = { all: '所有宝贝', mall: '天猫', shop: '淘宝店铺', enterprise: '企业购' };
        const name = map[String(args.cat).toLowerCase()];
        if (!name) throw new Error('unsupported cat "' + args.cat + '": use all | mall | shop | enterprise');
        const target = [...document.querySelectorAll('div')].find((el) => visible(el) && txt(el) === name && /baseStyle/.test(el.className));
        if (!target) throw new Error('category tab "' + name + '" not found');
        if (/actStyle/.test(target.className)) {
            results.push('category already: ' + name);
        } else {
            target.click();
            results.push('category: ' + name);
            await sleep(1100);
        }
    }

    if (args.price !== undefined && args.price !== '') {
        const m = String(args.price).trim().match(/^(\\d*)\\s*-\\s*(\\d*)$/);
        if (!m || (m[1] === '' && m[2] === '')) throw new Error('invalid price "' + args.price + '": use "100-500", "100-" or "-500"');
        let low = document.querySelector('input[placeholder*="最低价"]');
        if (!low || !visible(low)) {
            const tab = [...document.querySelectorAll('[role="tab"]')].find((el) => visible(el) && txt(el) === '区间');
            if (!tab) throw new Error('price-range tab not found');
            tab.click();
            await sleep(500);
            low = document.querySelector('input[placeholder*="最低价"]');
        }
        if (!low || !visible(low)) throw new Error('price-range panel did not open');
        const high = document.querySelector('input[placeholder*="最高价"]');
        if (m[1] !== '') setVal(low, m[1]);
        if (m[2] !== '' && high) setVal(high, m[2]);
        await sleep(250);
        const panel = low.closest('[class*="sectionPriceSelecter"]');
        const ok = panel && panel.querySelector('[class*="confirmButton"]');
        if (!ok) throw new Error('confirm button not found in price panel');
        ok.click();
        results.push('price: ' + args.price);
        await sleep(1000);
    }

    const openFilterPanel = async () => {
        let panel = document.querySelector('[class*="panelFilterWrapper"]');
        if (panel && visible(panel)) return panel;
        const btns = [...document.querySelectorAll('div,span,button')].filter((el) => txt(el) === '筛选' && visible(el) && el.children.length <= 2);
        const btn = btns[btns.length - 1];
        if (!btn) throw new Error('filter button not found');
        btn.click();
        await sleep(600);
        panel = document.querySelector('[class*="panelFilterWrapper"]');
        if (!panel || !visible(panel)) throw new Error('filter panel did not open');
        return panel;
    };

    if (args.shipping !== undefined && args.shipping !== '') {
        const map = { freeship: '包邮', free: '包邮', '包邮': '包邮', nextday: '24小时内发', twoday: '48小时内发' };
        const name = map[String(args.shipping).toLowerCase()] || map[String(args.shipping).trim()];
        if (!name) throw new Error('unsupported shipping "' + args.shipping + '": use freeship | nextday | twoday');
        const panel = await openFilterPanel();
        const item = [...panel.querySelectorAll('[class*="text--"]')].find((el) => txt(el) === name);
        if (!item) throw new Error('shipping option "' + name + '" not found in filter panel');
        const holder = item.closest('[class*="filterItem"], [class*="tag"], [class*="item"], [class*="chip"]') || item;
        if (/Selected|selected|active/i.test(holder.className + item.className)) {
            results.push('shipping already: ' + name);
        } else {
            item.click();
            results.push('shipping: ' + name);
            await sleep(1000);
        }
    }

    if (args.brand !== undefined && args.brand !== '') {
        const wanted = String(args.brand).trim();
        const panel = await openFilterPanel();
        const findBrand = () => [...panel.querySelectorAll('[title]')].find((el) => {
            if (!visible(el)) return false;
            const title = el.getAttribute('title');
            return title && (title === wanted || title.includes(wanted) || (el.textContent || '').includes(wanted));
        });
        let item = findBrand();
        if (!item) {
            const expand = [...panel.querySelectorAll('div,span')].find((el) => ['展开全部', '更多'].includes(txt(el)));
            if (expand) {
                expand.click();
                await sleep(500);
                item = findBrand();
            }
        }
        if (!item) throw new Error('brand "' + wanted + '" not found in filter panel');
        if (/Selected|selected/i.test(item.className)) {
            results.push('brand already: ' + wanted);
        } else {
            item.click();
            results.push('brand: ' + (item.getAttribute('title') || wanted));
            await sleep(1000);
        }
    }

    return { applied: results };
}`;

const TB_SEARCH = {
    kind: 'action',
    name: 'SearchItem',
    description: '在淘宝搜索商品：按商品名一步跳转到淘宝搜索结果页，无需手动填搜索框',
    args: {
        keyword: '商品名/搜索关键词，如：无线耳机'
    },
    functionStr: TB_SEARCH_FN
};

const TB_FILTER = {
    kind: 'action',
    name: 'FilterItem',
    description:
        '在淘宝搜索结果页筛选商品，各字段可按需组合，只传需要的字段：' +
        'sort=排序(default综合|sales销量|price价格从低到高|pricedesc价格从高到低)；' +
        'cat=类目(all所有宝贝|mall天猫|shop淘宝店铺|enterprise企业购)；' +
        'price=价格区间，如"100-500"、"100-"、"-500"；' +
        'brand=品牌名(如 华为、Huawei、漫步者，会自动展开全部品牌后匹配)；' +
        'shipping=freeship(包邮)|nextday(24小时内发)|twoday(48小时内发)',
    args: {
        sort: '排序方式：default(综合) | sales(销量) | price(价格从低到高) | pricedesc(价格从高到低)',
        cat: '类目：all(所有宝贝) | mall(天猫) | shop(淘宝店铺) | enterprise(企业购)',
        price: '价格区间，如 100-500、100-、-500',
        brand: '品牌名，如 华为、Huawei、漫步者',
        shipping: 'freeship(包邮) | nextday(24小时内发) | twoday(48小时内发)'
    },
    functionStr: TB_FILTER_FN
};

export function registerTaobaoHints(ctx) {
    ctx.browser.hint.register('s.taobao.com', () => [TB_SEARCH, TB_FILTER]);
    ctx.browser.hint.register('www.taobao.com', () => [TB_SEARCH]);
}
