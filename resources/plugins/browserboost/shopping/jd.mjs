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
 * 京东 hint 定义：SearchItem（按商品名搜索）+ FilterItem（结果页筛选）。
 *
 * 京东 PC 搜索结果页（search.jd.com）为 React 新版，筛选栏类名是 CSS modules
 * hash（如 _sort-tag-button_3m6t1_11），因此全部使用 [class*=] 前缀匹配 +
 * 文本匹配定位，不依赖完整类名。交互均为前端状态驱动，不改 URL，只能模拟点击。
 */

const JD_SEARCH_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://search.jd.com/Search?keyword=' + encodeURIComponent(kw) + '&enc=utf-8';
    return { keyword: kw, navigating: true };
}`;

const JD_FILTER_FN = `async (args) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => el.getBoundingClientRect().width > 0;
    const txt = (el) => (el.textContent || '').trim();
    const hoverOpen = (el) => {
        // 京东 React 的 hover 监听可能挂在外层容器（如 _checkbox-item_）上，
        // 从触发元素向上逐层派发以确保命中真正的监听节点
        let node = el;
        for (let i = 0; i < 3 && node; i++) {
            node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            node = node.parentElement;
        }
    };
    const setVal = (el, v) => {
        el.focus();
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        if (desc && desc.set) desc.set.call(el, v); else el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const results = [];
    if (!args || typeof args !== 'object') throw new Error('args object is required');
    const keys = ['sort', 'price', 'brand', 'shipping', 'selfrun', 'instock', 'plus', 'cod', 'global', 'used'];
    const hasAny = keys.some((k) => args[k] !== undefined && args[k] !== null && args[k] !== '');
    if (!hasAny) throw new Error('no filter specified: pass one of sort/price/brand/shipping/selfrun/instock/plus/cod/global/used');

    if (args.sort !== undefined && args.sort !== '') {
        const map = { default: '综合', sales: '销量', price: '价格' };
        const name = map[String(args.sort).toLowerCase()];
        if (!name) throw new Error('unsupported sort "' + args.sort + '": use default | sales | price');
        let target = null;
        if (name === '综合') {
            target = [...document.querySelectorAll('[class*=_trigger-wrap-button_]')].find((el) => visible(el) && txt(el).startsWith('综合'));
        } else {
            target = [...document.querySelectorAll('[class*=_sort-tag-button_]')].find((el) => visible(el) && txt(el) === name);
        }
        if (!target) throw new Error('sort option "' + name + '" not found on this page');
        if (target.className.includes('__active_')) {
            results.push('sort already: ' + name);
        } else {
            target.click();
            results.push('sorted by ' + name);
            await sleep(900);
        }
    }

    if (args.price !== undefined && args.price !== '') {
        const m = String(args.price).trim().match(/^(\\d*)\\s*-\\s*(\\d*)$/);
        if (!m || (m[1] === '' && m[2] === '')) throw new Error('invalid price "' + args.price + '": use "100-500", "100-" or "-500"');
        let low = document.querySelector('input[placeholder="最低价"]');
        if (!low || !visible(low)) {
            const trig = [...document.querySelectorAll('[class*=_trigger-wrap-button_]')].find((el) => visible(el) && txt(el).includes('价格区间'));
            if (!trig) throw new Error('price-range trigger not found');
            hoverOpen(trig);
            await sleep(400);
            low = document.querySelector('input[placeholder="最低价"]');
            if (!low || !visible(low)) {
                // 京东部分下拉由 click 触发（hover 仅对部分入口生效），click 兜底
                trig.click();
                await sleep(400);
                low = document.querySelector('input[placeholder="最低价"]');
            }
        }
        if (!low || !visible(low)) throw new Error('price-range panel did not open');
        const high = document.querySelector('input[placeholder="最高价"]');
        if (m[1] !== '') setVal(low, m[1]);
        if (m[2] !== '' && high) setVal(high, m[2]);
        await sleep(250);
        const body = low.closest('[class*=_drop-down-body_]');
        const ok = body ? [...body.querySelectorAll('[class*=_common-button_]')].find((b) => txt(b) === '确定') : null;
        if (!ok) throw new Error('confirm button not found in price panel');
        ok.click();
        results.push('price: ' + args.price);
        await sleep(900);
    }

    if (args.brand !== undefined && args.brand !== '') {
        const wanted = String(args.brand).trim();
        const row = [...document.querySelectorAll('[class*=_filter-type_]')].find((el) => {
            const label = el.querySelector('[class*=_filter-type-label_]');
            return label && txt(label) === '品牌';
        });
        if (!row) throw new Error('brand row not found');
        const findItem = () => [...row.querySelectorAll('[class*=_value-item_]')].find((el) => {
            if (!visible(el)) return false;
            const t = txt(el);
            return t === wanted || t.startsWith(wanted) || t.includes(wanted);
        });
        let item = findItem();
        if (!item) {
            const more = row.querySelector('[class*=_filter-type-more_]') || [...row.querySelectorAll('div,span')].find((el) => txt(el) === '更多');
            if (more) {
                more.click();
                await sleep(500);
                item = findItem();
            }
        }
        if (!item) throw new Error('brand "' + wanted + '" not found in brand list');
        if (item.querySelector('[class*=_value-check_]')) {
            results.push('brand already selected: ' + txt(item));
        } else {
            item.click();
            results.push('brand: ' + txt(item));
            await sleep(900);
        }
    }

    const boolOpt = (label) => (v) => {
        const s = String(v).toLowerCase();
        if (v === true || s === 'true' || v === '1') return { label: label, on: true };
        if (v === false || s === 'false' || v === '0') return { label: label, on: false };
        return null;
    };
    const toggles = [
        ['shipping', (v) => { const s = String(v).toLowerCase(); return ['jd', 'jdlogistics', '物流'].includes(s) ? { label: '京东物流', on: true } : null; }],
        ['instock', boolOpt('仅显示有货')],
        ['plus', boolOpt('PLUS95折')],
        ['cod', boolOpt('货到付款')],
        ['global', boolOpt('京东国际')],
        ['used', boolOpt('拍拍二手')]
    ];
    for (const [key, resolve] of toggles) {
        const v = args[key];
        if (v === undefined || v === null || v === '') continue;
        const opt = resolve(v);
        if (!opt) throw new Error('unsupported ' + key + ': ' + v);
        const el = [...document.querySelectorAll('[class*=_filter-select_]')].find((e) => visible(e) && txt(e) === opt.label);
        if (!el) throw new Error('filter "' + opt.label + '" not found on this page');
        const active = el.className.includes('__active_');
        if (active === opt.on) {
            results.push(opt.label + ' already ' + (opt.on ? 'on' : 'off'));
        } else {
            el.click();
            results.push(opt.label + ': ' + (opt.on ? 'on' : 'off'));
            await sleep(900);
        }
    }

    if (args.selfrun !== undefined && args.selfrun !== '') {
        // 面板实际选项为三个独立项：京东自营 / 旗舰店 / 京喜自营
        const opts = { self: '京东自营', '京东自营': '京东自营', flagship: '旗舰店', jingxi: '京喜自营' };
        const label = opts[String(args.selfrun).toLowerCase()] || opts[String(args.selfrun).trim()];
        if (!label) throw new Error('unsupported selfrun "' + args.selfrun + '": use self | jingxi');
        let drop = [...document.querySelectorAll('[class*=_drop-down-body_]')].find((d) => visible(d) && (d.textContent || '').includes('自营'));
        if (!drop) {
            const trig = [...document.querySelectorAll('[class*=_filter-select_]')].find((el) => visible(el) && txt(el).includes('自营'));
            if (!trig) throw new Error('selfrun trigger not found');
            hoverOpen(trig);
            await sleep(500);
            drop = [...document.querySelectorAll('[class*=_drop-down-body_]')].find((d) => visible(d) && (d.textContent || '').includes('自营'));
            if (!drop) {
                // hover 未命中监听节点时用 click 兜底
                trig.click();
                await sleep(500);
                drop = [...document.querySelectorAll('[class*=_drop-down-body_]')].find((d) => visible(d) && (d.textContent || '').includes('自营'));
            }
        }
        if (!drop) throw new Error('selfrun panel did not open');
        const cands = [...drop.querySelectorAll('div,span')].filter((el) => txt(el) === label);
        const option = cands.find((el) => el.children.length === 0) || cands[cands.length - 1];
        if (!option) throw new Error('selfrun option "' + label + '" not found');
        option.click();
        await sleep(200);
        const ok = [...drop.querySelectorAll('[class*=_common-button_]')].find((b) => txt(b).startsWith('确定'));
        if (!ok) throw new Error('confirm button not found in selfrun panel');
        ok.click();
        results.push('selfrun: ' + label);
        await sleep(900);
    }

    return { applied: results };
}`;

const JD_SEARCH = {
    kind: 'action',
    name: 'SearchItem',
    description: '在京东搜索商品：按商品名一步跳转到京东搜索结果页，无需手动填搜索框',
    args: {
        keyword: '商品名/搜索关键词，如：无线耳机'
    },
    functionStr: JD_SEARCH_FN
};

const JD_FILTER = {
    kind: 'action',
    name: 'FilterItem',
    description:
        '在京东搜索结果页筛选商品，各字段可按需组合，只传需要的字段：' +
        'sort=排序(default综合|sales销量|price价格)；' +
        'price=价格区间，如"100-500"、"100-"、"-500"；' +
        'brand=品牌名(如 华为、Apple，会自动展开品牌列表后匹配)；' +
        'shipping=jd(京东物流)；selfrun=self(京东自营)|flagship(旗舰店)|jingxi(京喜自营)；' +
        'instock=true(仅显示有货)；plus=true(PLUS95折)；cod=true(货到付款)；' +
        'global=true(京东国际)；used=true(拍拍二手)。传 false 可取消对应布尔筛选',
    args: {
        sort: '排序方式：default(综合) | sales(销量) | price(价格)',
        price: '价格区间，如 100-500、100-、-500',
        brand: '品牌名，与页面品牌显示名匹配，如 华为、Apple',
        shipping: '设为 jd 启用京东物流筛选',
        selfrun: 'self(京东自营) | flagship(旗舰店) | jingxi(京喜自营)',
        instock: 'true=仅显示有货，false=取消',
        plus: 'true=PLUS95折，false=取消',
        cod: 'true=货到付款，false=取消',
        global: 'true=京东国际，false=取消',
        used: 'true=拍拍二手，false=取消'
    },
    functionStr: JD_FILTER_FN
};

export function registerJdHints(ctx) {
    ctx.browser.hint.register('search.jd.com', () => [JD_SEARCH, JD_FILTER]);
    ctx.browser.hint.register('www.jd.com', () => [JD_SEARCH]);
}
