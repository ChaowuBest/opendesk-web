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

// 展示名称等静态元数据统一声明在 opendesk.plugin.json，入口只保留运行时字段。
export default {
    id: 'browserboost',
    async setup(ctx) {
        // 宿主通过「入口 URL + 时间戳 query」重载插件，静态相对 import 的子模块
        // 不带 query，会命中 Node ESM 缓存导致热重载拿到旧代码；这里给子模块
        // 同样附加时间戳 query，保证 shopping/ 下的实现随入口一起刷新。
        const ts = Date.now();
        const [
            { registerJdHints },
            { registerTaobaoHints },
            { registerXianyuHints },
            { registerGoogleHints },
            { registerBingHints },
            { registerBaiduHints },
            { registerBilibiliHints },
            { registerZhihuHints },
            { registerXiaohongshuHints },
            { registerEastmoneyHints },
            { registerThsHints }
        ] = await Promise.all([
            import(`./shopping/jd.mjs?opendesk=${ts}`),
            import(`./shopping/taobao.mjs?opendesk=${ts}`),
            import(`./shopping/xianyu.mjs?opendesk=${ts}`),
            import(`./search/google.mjs?opendesk=${ts}`),
            import(`./search/bing.mjs?opendesk=${ts}`),
            import(`./search/baidu.mjs?opendesk=${ts}`),
            import(`./media/bilibili.mjs?opendesk=${ts}`),
            import(`./media/zhihu.mjs?opendesk=${ts}`),
            import(`./media/xiaohongshu.mjs?opendesk=${ts}`),
            import(`./finance/eastmoney.mjs?opendesk=${ts}`),
            import(`./finance/ths.mjs?opendesk=${ts}`)
        ]);
        registerJdHints(ctx);
        registerTaobaoHints(ctx);
        registerXianyuHints(ctx);
        registerGoogleHints(ctx);
        registerBingHints(ctx);
        registerBaiduHints(ctx);
        registerBilibiliHints(ctx);
        registerZhihuHints(ctx);
        registerXiaohongshuHints(ctx);
        registerEastmoneyHints(ctx);
        registerThsHints(ctx);
    }
};
