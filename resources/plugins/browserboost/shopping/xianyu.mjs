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
 * 闲鱼 hint 定义：SearchItem（按商品名搜索）+ FilterItem（结果页筛选）。
 *
 * 闲鱼 PC 端（www.goofish.com）为 React 应用，筛选控件类名是 CSS modules hash
 * （如 search-select-container--ANusUe9S），因此全部使用 [class*=] 前缀匹配 +
 * 文本匹配定位。排序类筛选均不改 URL，只能模拟点击；区域筛选通过 antd popover
 * 的省/市列表 + 「查看xx件宝贝」按钮应用。
 */

const XY_SEARCH_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    location.href = 'https://www.goofish.com/search?q=' + encodeURIComponent(kw);
    return { keyword: kw, navigating: true };
}`;

const XY_FILTER_FN = `async (args) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => el.getBoundingClientRect().width > 0;
    const txt = (el) => (el.textContent || '').trim();
    const title = (c) => txt(c.querySelector('[class*=search-select-title--]') || '');
    const results = [];
    if (!args || typeof args !== 'object') throw new Error('args object is required');
    const keys = ['sort', 'priceSort', 'posted', 'price', 'tags', 'area'];
    const hasAny = keys.some((k) => args[k] !== undefined && args[k] !== null && args[k] !== '');
    if (!hasAny) throw new Error('no filter specified: pass one of sort/priceSort/posted/price/tags/area');

    const containers = () => [...document.querySelectorAll('[class*=search-select-container--]')].filter(visible);

    if (args.sort !== undefined && args.sort !== '') {
        const map = { default: '综合', active: '最近活跃', nearest: '距离最近', credit: '信用排序', discount: '新降价' };
        const name = map[String(args.sort).toLowerCase()];
        if (!name) throw new Error('unsupported sort "' + args.sort + '": use default | active | nearest | credit | discount');
        if (name === '新降价') {
            const c = containers().find((el) => title(el) === '新降价');
            if (!c) throw new Error('sort option "新降价" not found');
            // 选中态：容器内联样式出现 background-color
            if (!/background-color/.test(c.getAttribute('style') || '')) {
                c.click();
                results.push('sort: 新降价');
                await sleep(900);
            } else {
                results.push('sort already: 新降价');
            }
        } else {
            const c = containers()[0];
            if (!c) throw new Error('sort dropdown not found');
            if (title(c) === name) {
                results.push('sort already: ' + name);
            } else {
                c.click();
                await sleep(300);
                const item = [...c.querySelectorAll('[class*=search-select-item--]')].find((i) => txt(i) === name);
                if (!item) throw new Error('sort option "' + name + '" not found');
                item.click();
                results.push('sort: ' + name);
                await sleep(900);
            }
        }
    }

    if (args.priceSort !== undefined && args.priceSort !== '') {
        const val = String(args.priceSort).toLowerCase();
        const label = val === 'asc' ? '价格从低到高' : val === 'desc' ? '价格从高到低' : null;
        if (!label) throw new Error('unsupported priceSort "' + args.priceSort + '": use asc | desc');
        const c = containers().find((el) => title(el) === '价格');
        if (!c) throw new Error('price sort dropdown not found');
        c.click();
        await sleep(300);
        const item = [...c.querySelectorAll('[class*=search-select-item--]')].find((i) => txt(i) === label);
        if (!item) throw new Error('price order "' + label + '" not found');
        item.click();
        results.push('priceSort: ' + label);
        await sleep(900);
    }

    if (args.posted !== undefined && args.posted !== '') {
        const map = { latest: '最新', '1d': '1天内', '3d': '3天内', '7d': '7天内', '14d': '14天内', day1: '1天内', day3: '3天内', day7: '7天内', day14: '14天内' };
        const name = map[String(args.posted).toLowerCase()];
        if (!name) throw new Error('unsupported posted "' + args.posted + '": use latest | 1d | 3d | 7d | 14d');
        const c = containers().find((el) => ['新发布', '最新', '1天内', '3天内', '7天内', '14天内'].includes(title(el)));
        if (!c) throw new Error('posted dropdown not found');
        if (title(c) === name) {
            results.push('posted already: ' + name);
        } else {
            c.click();
            await sleep(300);
            const item = [...c.querySelectorAll('[class*=search-select-item--]')].find((i) => txt(i) === name);
            if (!item) throw new Error('posted option "' + name + '" not found');
            item.click();
            results.push('posted: ' + name);
            await sleep(900);
        }
    }

    if (args.price !== undefined && args.price !== null && args.price !== '') {
        const raw = String(args.price).replace(/\\s/g, '');
        const m = raw.match(/^(\\d*\\.?\\d*)-(\\d*\\.?\\d*)$/);
        if (!m || (!m[1] && !m[2])) {
            throw new Error('invalid price "' + args.price + '": use a range like 100-200, 100- (no upper) or -200 (no lower)');
        }
        const inputs = [...document.querySelectorAll('input[class*=search-price-input--]')].filter(visible);
        if (inputs.length < 2) throw new Error('price inputs not found');
        const setInput = (el, v) => {
            el.value = v;
            let called = false;
            for (const k of Object.keys(el)) {
                if (k.indexOf('__reactProps$') === 0 && el[k] && typeof el[k].onChange === 'function') {
                    el[k].onChange({ target: el, currentTarget: el, value: v });
                    called = true;
                }
            }
            if (!called) {
                const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
                if (d && d.set) d.set.call(el, v);
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        };
        setInput(inputs[0], m[1]);
        setInput(inputs[1], m[2]);
        await sleep(150);
        // 价格输入行内的「确定」按钮触发提交（React onChange 同步 state 后，合成 click 即可生效）
        const row = inputs[0].closest('[class*=search-price-input-container--]') || inputs[0].parentElement.parentElement;
        const confirm = [...row.querySelectorAll('button')].find((b) => txt(b) === '确定');
        if (!confirm) throw new Error('price confirm button not found');
        confirm.click();
        results.push('price: ' + (m[1] || '0') + '-' + (m[2] || '不限'));
        await sleep(1600);
    }

    if (args.tags !== undefined && args.tags !== '') {
        const wanted = String(args.tags).split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
        const applied = [];
        for (const tag of wanted) {
            const label = [...document.querySelectorAll('[class*=search-checkbox-label--]')].find((el) => visible(el) && txt(el) === tag);
            if (!label) throw new Error('tag "' + tag + '" not found (available: 个人闲置/验货宝/验号担保/包邮/超赞/鱼小铺/全新/严选/转卖)');
            const box = label.parentElement;
            if (box && box.querySelector('[class*=search-checkbox-checked--]')) {
                applied.push(tag + '(already)');
            } else {
                label.click();
                applied.push(tag);
                await sleep(800);
            }
        }
        results.push('tags: ' + applied.join(','));
    }

    if (args.area !== undefined && args.area !== '') {
        const wanted = String(args.area).trim();
        let province = wanted;
        let city = null;
        if (wanted.includes('-')) {
            const parts = wanted.split('-');
            province = parts[0].trim();
            city = parts[1].trim();
        }
        // 常见城市到省份的映射，未收录城市请使用「省名-城市名」格式
        const CITY_PROVINCE = {
            '北京': '北京', '上海': '上海', '天津': '天津', '重庆': '重庆',
            '深圳': '广东', '广州': '广东', '东莞': '广东', '佛山': '广东', '珠海': '广东', '中山': '广东', '惠州': '广东',
            '杭州': '浙江', '宁波': '浙江', '温州': '浙江', '金华': '浙江',
            '南京': '江苏', '苏州': '江苏', '无锡': '江苏', '常州': '江苏', '南通': '江苏',
            '成都': '四川', '武汉': '湖北', '长沙': '湖南', '郑州': '河南', '西安': '陕西',
            '福州': '福建', '厦门': '福建', '泉州': '福建', '青岛': '山东', '济南': '山东',
            '合肥': '安徽', '南昌': '江西', '昆明': '云南', '贵阳': '贵州', '南宁': '广西',
            '沈阳': '辽宁', '大连': '辽宁', '哈尔滨': '黑龙江', '长春': '吉林', '石家庄': '河北',
            '太原': '山西', '兰州': '甘肃', '呼和浩特': '内蒙古', '乌鲁木齐': '新疆',
            '海口': '海南', '西宁': '青海', '银川': '宁夏', '拉萨': '西藏'
        };
        const trigger = document.querySelector('[class*=areaTextContainer--]');
        if (!trigger || !visible(trigger)) throw new Error('area trigger not found');
        if (!trigger.className.includes('ant-popover-open')) {
            trigger.click();
            await sleep(500);
        }
        const pop = document.querySelector('[class*="ant-popover-placement"]');
        if (!pop) throw new Error('area popover did not open');
        const findProv = (name) => [...pop.querySelectorAll('[class*=provItem--]')].find((el) => visible(el) && txt(el) === name);
        if (!city && !findProv(province) && CITY_PROVINCE[province]) {
            city = province;
            province = CITY_PROVINCE[province];
        }
        const prov = findProv(province);
        if (!prov) throw new Error('province "' + province + '" not found; use a province name (如 广东), a major city (如 深圳), or 省名-城市名 (如 广东-深圳)');
        prov.click();
        await sleep(500);
        if (city) {
            const cityItem = [...pop.querySelectorAll('[class*=provItem--]')].find((el) => visible(el) && txt(el) === city);
            if (!cityItem) throw new Error('city "' + city + '" not found under ' + province);
            cityItem.click();
            await sleep(400);
        } else {
            const all = [...pop.querySelectorAll('[class*=provItem--]')].find((el) => visible(el) && txt(el) === '全');
            if (all) {
                all.click();
                await sleep(400);
            }
        }
        const apply = [...pop.querySelectorAll('*')].filter((el) => txt(el).includes('件宝贝') && el.children.length <= 1).pop();
        if (!apply) throw new Error('area apply button (查看xx件宝贝) not found');
        apply.click();
        results.push('area: ' + wanted);
        await sleep(1200);
    }

    return { applied: results };
}`;

const XY_SEARCH = {
    kind: 'action',
    name: 'SearchItem',
    description: '在闲鱼搜索商品：按商品名一步跳转到闲鱼搜索结果页，无需手动填搜索框',
    args: {
        keyword: '商品名/搜索关键词，如：无线耳机'
    },
    functionStr: XY_SEARCH_FN
};

const XY_FILTER = {
    kind: 'action',
    name: 'FilterItem',
    description:
        '在闲鱼搜索结果页筛选商品，各字段可按需组合，只传需要的字段：' +
        'sort=排序(default综合|active最近活跃|nearest距离最近|credit信用排序|discount新降价)；' +
        'priceSort=价格排序(asc从低到高|desc从高到低)；' +
        'posted=发布时间(latest最新|1d|3d|7d|14d)；' +
        'tags=标签，逗号分隔多个，可选值：个人闲置/验货宝/验号担保/包邮/超赞/鱼小铺/全新/严选/转卖；' +
        'price=价格区间(如 100-200 表示100到200元；100- 表示不低于100；-200 表示不高于200)；' +
        'area=区域(自取同城用，如 广东 全省、深圳、或 广东-深圳 精确到城市)。',
    args: {
        sort: '排序：default(综合) | active(最近活跃) | nearest(距离最近) | credit(信用排序) | discount(新降价)',
        priceSort: '价格排序：asc(从低到高) | desc(从高到低)',
        posted: '发布时间：latest(最新) | 1d | 3d | 7d | 14d',
        price: '价格区间：如 "100-200"（100到200元）、"100-"（不低于100）、"-200"（不高于200）',
        tags: '标签，逗号分隔多个：个人闲置、验货宝、验号担保、包邮、超赞、鱼小铺、全新、严选、转卖',
        area: '区域：省份名(如 广东)、主要城市(如 深圳)、或 省名-城市名(如 广东-深圳)'
    },
    functionStr: XY_FILTER_FN
};

export function registerXianyuHints(ctx) {
    ctx.browser.hint.register('www.goofish.com', () => [XY_SEARCH, XY_FILTER]);
    ctx.browser.hint.register('goofish.com', () => [XY_SEARCH, XY_FILTER]);
}
