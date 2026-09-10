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
 * B 站 hint 定义：
 * - 全站（www.bilibili.com）：Search(keyword, category)，category=all|video|live|article|user，
 *   一步跳到 search.bilibili.com 对应 tab 的搜索结果页；
 * - 搜索结果页（search.bilibili.com）：NextPage / PrevPage（page 参数）；
 * - 视频播放页（www.bilibili.com/video）：TogglePlay（播放/暂停）、ToggleDanmaku（弹幕开关）、
 *   Seek(t)（通过 URL t 参数跳到指定秒数，页面重载后自动从该位置继续）。
 * 播放器按钮 class 为 bpx-player-*（新版播放器），番剧页播放器结构不同，不注册播放器动作。
 */

const BILI_SEARCH_FN = `async (args) => {
    const kw = args && typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (!kw) throw new Error('keyword is required');
    const raw = args && typeof args.category === 'string' && args.category.trim() ? args.category.trim().toLowerCase() : 'all';
    const map = { all: 'all', video: 'video', live: 'live', article: 'article', user: 'upuser' };
    const tab = map[raw];
    if (!tab) throw new Error('unsupported category "' + args.category + '": use all | video | live | article | user');
    location.href = 'https://search.bilibili.com/' + tab + '?keyword=' + encodeURIComponent(kw);
    return { keyword: kw, category: tab, navigating: true };
}`;

const BILI_NEXT_FN = `async () => {
    const u = new URL(location.href);
    const cur = parseInt(u.searchParams.get('page') || '1', 10) || 1;
    const next = cur + 1;
    u.searchParams.set('page', String(next));
    // B 站会按 o（结果偏移）恢复浏览位置，必须与 page 同步更新，否则会被 SPA 拉回旧页
    u.searchParams.set('o', String((next - 1) * 24));
    location.href = u.href;
    return { page: next, navigating: true };
}`;

const BILI_PREV_FN = `async () => {
    const u = new URL(location.href);
    const cur = parseInt(u.searchParams.get('page') || '1', 10) || 1;
    if (cur <= 1) throw new Error('already on the first page');
    const next = cur - 1;
    if (next > 1) {
        u.searchParams.set('page', String(next));
        u.searchParams.set('o', String((next - 1) * 24));
    } else {
        // 回到第一页：page 与 o 都要清掉，残留 o 会让 B 站 SPA 恢复到旧页码
        u.searchParams.delete('page');
        u.searchParams.delete('o');
    }
    location.href = u.href;
    return { page: next, navigating: true };
}`;

const BILI_TOGGLE_PLAY_FN = `async () => {
    const btn = document.querySelector('.bpx-player-ctrl-play');
    const video = document.querySelector('video');
    if (!btn && !video) throw new Error('video player not found: this action only works on video pages');
    if (btn) btn.click(); else if (video.paused) video.play(); else video.pause();
    await new Promise((r) => setTimeout(r, 400));
    const v = document.querySelector('video');
    return { state: v && !v.paused ? 'playing' : 'paused' };
}`;

const BILI_TOGGLE_DANMAKU_FN = `async () => {
    const btn = document.querySelector('.bpx-player-dm-switch');
    if (!btn) throw new Error('danmaku switch not found: this action only works on video pages');
    // 开关内部是 checkbox（bui 组件），checked 属性才是真实状态源；外层 div 的合成 click 不会触发切换
    const input = btn.querySelector('input[type=checkbox]');
    const read = () => (input ? input.checked : btn.className.includes('bpx-player-dm-switch-active'));
    const wasOn = read();
    (input || btn).click();
    await new Promise((r) => setTimeout(r, 300));
    const on = read();
    return { danmaku: on ? 'on' : 'off', toggled: wasOn !== on };
}`;

const BILI_SEEK_FN = `async (args) => {
    const t = Number(args && args.t);
    if (!Number.isFinite(t) || t < 0) throw new Error('t is required: seek target in seconds, e.g. 90 means 1:30');
    const sec = Math.floor(t);
    const u = new URL(location.href);
    u.searchParams.set('t', String(sec));
    location.href = u.href;
    return { t: sec, navigating: true };
}`;

const BILI_LOGIN_FN = `async () => {
    location.href = 'https://passport.bilibili.com/login?gourl=' + encodeURIComponent(location.href);
    return { navigating: true, hint: 'login page opened, scan QR code to sign in, then go back to the video page' };
}`;

/**
 * 互动组 actions（点赞/投币/收藏/三连/关注/评论）的实现说明（均为实测结论）：
 * 1. 点赞走 UI 按钮点击（可靠）；投币/收藏/关注优先 UI 判断但执行走 B 站官方接口
 *    （页面内带 cookie + csrf 的 fetch，与点击按钮效果一致）：
 *    B 站投币/收藏弹窗的渲染受不可控的页面状态影响（弹窗壳 display:none 残留、
 *    懒加载调度、弹窗关闭后冷却等），UI 流程时序不稳定，接口调用结果确定；
 * 2. 已完成状态判断用接口（archive/coins 的 multiply、fav/video/favoured、
 *    relation 的 attribute），工具栏按钮 class 在 API 操作后不会同步更新，不可依赖。
 */

const BILI_LIKE_FN = `async () => {
    const aid = (window.__INITIAL_STATE__ || {}).aid;
    if (!aid) throw new Error('video aid not found: this action only works on video pages');
    const csrf = (document.cookie.match(/bili_jct=([^;]+)/) || [])[1];
    if (!csrf) throw new Error('not logged in: csrf token missing');
    const qs = (u) => fetch(u, { credentials: 'include' }).then((r) => r.json());
    const has = await qs('https://api.bilibili.com/x/web-interface/archive/has/like?aid=' + aid);
    if (has.code === 0 && has.data === 1) return { liked: true, note: 'already liked' };
    const res = await fetch('https://api.bilibili.com/x/web-interface/archive/like', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'aid=' + aid + '&like=1&csrf=' + encodeURIComponent(csrf)
    });
    const data = await res.json();
    if (data.code === 65006) return { liked: true, note: 'already liked' };
    if (data.code !== 0) throw new Error('like failed: ' + (data.message || data.code));
    return { liked: true, note: 'done' };
}`;

const BILI_COIN_FN = `async () => {
    const aid = (window.__INITIAL_STATE__ || {}).aid;
    if (!aid) throw new Error('video aid not found: this action only works on video pages');
    const csrf = (document.cookie.match(/bili_jct=([^;]+)/) || [])[1];
    if (!csrf) throw new Error('not logged in: csrf token missing');
    const qs = (u) => fetch(u, { credentials: 'include' }).then((r) => r.json());
    const coinInfo = await qs('https://api.bilibili.com/x/web-interface/archive/coins?aid=' + aid);
    if (coinInfo.code !== 0) throw new Error('coin status check failed: ' + (coinInfo.message || coinInfo.code));
    if ((coinInfo.data || {}).multiply > 0) {
        return { coined: true, note: 'already coined ' + coinInfo.data.multiply + ' coin(s)' };
    }
    const res = await fetch('https://api.bilibili.com/x/web-interface/coin/add', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'aid=' + aid + '&multiply=1&select_like=1&csrf=' + encodeURIComponent(csrf)
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error('coin failed: ' + (data.message || data.code));
    return { coined: true, note: 'coined 1 coin (with like, B 站默认)' };
}`;

const BILI_FAVORITE_FN = `async () => {
    const aid = (window.__INITIAL_STATE__ || {}).aid;
    if (!aid) throw new Error('video aid not found: this action only works on video pages');
    const uid = (document.cookie.match(/DedeUserID=(\\d+)/) || [])[1];
    const csrf = (document.cookie.match(/bili_jct=([^;]+)/) || [])[1];
    if (!csrf || !uid) throw new Error('not logged in: csrf token missing');
    const qs = (u) => fetch(u, { credentials: 'include' }).then((r) => r.json());
    const favoured = await qs('https://api.bilibili.com/x/v2/fav/video/favoured?aid=' + aid);
    if (favoured.code === 0 && favoured.data && favoured.data.favoured) {
        return { faved: true, note: 'already in favorites' };
    }
    const folders = await qs('https://api.bilibili.com/x/v3/fav/folder/created/list?pn=1&ps=1&up_mid=' + uid + '&type=2');
    const first = folders.data && folders.data.list && folders.data.list[0];
    if (!first) throw new Error('no favorite folder found');
    const res = await fetch('https://api.bilibili.com/x/v3/fav/resource/deal', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'rid=' + aid + '&type=2&add_media_ids=' + first.id + '&csrf=' + encodeURIComponent(csrf)
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error('favorite failed: ' + (data.message || data.code));
    return { faved: true, folder: (first.title || '默认收藏夹') };
}`;

const BILI_TRIPLE_FN = `async () => {
    const aid = (window.__INITIAL_STATE__ || {}).aid;
    if (!aid) throw new Error('video aid not found: this action only works on video pages');
    const csrf = (document.cookie.match(/bili_jct=([^;]+)/) || [])[1];
    const uid = (document.cookie.match(/DedeUserID=(\\d+)/) || [])[1];
    if (!csrf || !uid) throw new Error('not logged in: csrf token missing');
    const qs = (u) => fetch(u, { credentials: 'include' }).then((r) => r.json());
    const results = [];
    // 点赞
    const has = await qs('https://api.bilibili.com/x/web-interface/archive/has/like?aid=' + aid);
    if (has.code === 0 && has.data === 1) results.push('like: already');
    else {
        const res = await fetch('https://api.bilibili.com/x/web-interface/archive/like', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'aid=' + aid + '&like=1&csrf=' + encodeURIComponent(csrf)
        });
        const data = await res.json();
        if (data.code !== 0 && data.code !== 65006) throw new Error('like failed: ' + (data.message || data.code));
        results.push('like: done');
    }
    // 投币（select_like=1 与 B 站默认一致，已赞幂等）
    const coinInfo = await qs('https://api.bilibili.com/x/web-interface/archive/coins?aid=' + aid);
    if (coinInfo.code !== 0) throw new Error('coin status check failed: ' + (coinInfo.message || coinInfo.code));
    if ((coinInfo.data || {}).multiply > 0) results.push('coin: already');
    else {
        const res = await fetch('https://api.bilibili.com/x/web-interface/coin/add', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'aid=' + aid + '&multiply=1&select_like=1&csrf=' + encodeURIComponent(csrf)
        });
        const data = await res.json();
        if (data.code !== 0) throw new Error('coin failed: ' + (data.message || data.code));
        results.push('coin: done(1 coin)');
    }
    // 收藏到默认收藏夹
    const favoured = await qs('https://api.bilibili.com/x/v2/fav/video/favoured?aid=' + aid);
    if (favoured.code === 0 && favoured.data && favoured.data.favoured) results.push('fav: already');
    else {
        const folders = await qs('https://api.bilibili.com/x/v3/fav/folder/created/list?pn=1&ps=1&up_mid=' + uid + '&type=2');
        const first = folders.data && folders.data.list && folders.data.list[0];
        if (!first) throw new Error('no favorite folder found');
        const res = await fetch('https://api.bilibili.com/x/v3/fav/resource/deal', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'rid=' + aid + '&type=2&add_media_ids=' + first.id + '&csrf=' + encodeURIComponent(csrf)
        });
        const data = await res.json();
        if (data.code !== 0) throw new Error('favorite failed: ' + (data.message || data.code));
        results.push('fav: done(' + (first.title || '默认收藏夹') + ')');
    }
    return { tripled: results };
}`;

const BILI_FOLLOW_FN = `async (args) => {
    const btn = document.querySelector('.upinfo-btn-panel .follow-btn');
    if (!btn) throw new Error('follow button not found: this action only works on video pages');
    const before = (btn.textContent || '').trim();
    if (/已关注/.test(before) || !btn.className.includes('not-follow')) {
        return { followed: true, note: 'already following' };
    }
    // UP 信息栏的关注按钮依赖 Vue 组件挂载，存在组件未挂载而点击无响应的情况，
    // 因此直接调用 B 站关注接口（同源 cookie + csrf），与点击按钮效果一致
    const upLink = document.querySelector('.up-detail a[href*="space.bilibili.com"]');
    const m = upLink ? (upLink.getAttribute('href') || '').match(/space\\.bilibili\\.com\\/(\\d+)/) : null;
    if (!m) throw new Error('up mid not found on this page');
    const qs = (u) => fetch(u, { credentials: 'include' }).then((r) => r.json());
    const rel = await qs('https://api.bilibili.com/x/relation?fid=' + m[1]);
    if (rel.code !== 0) throw new Error('relation check failed: ' + (rel.message || rel.code));
    if (rel.data && rel.data.attribute !== 0) return { followed: true, note: 'already following' };
    const csrf = (document.cookie.match(/bili_jct=([^;]+)/) || [])[1];
    if (!csrf) throw new Error('not logged in: csrf token missing');
    const res = await fetch('https://api.bilibili.com/x/relation/modify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'fid=' + m[1] + '&act=1&re_src=16&csrf=' + encodeURIComponent(csrf)
    });
    const data = await res.json();
    if (data.code !== 0 && !(data.message || '').includes('已经关注')) {
        throw new Error('follow failed: ' + (data.message || data.code));
    }
    return { followed: true, note: 'followed UP ' + m[1] };
}`;

const BILI_COMMENT_FN = `async (args) => {
    const text = args && typeof args.content === 'string' ? args.content.trim() : '';
    if (!text) throw new Error('content is required');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // 评论区是 Web Component（bili-comments）且懒加载，用主滚动触发渲染
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(2500);
    const deepQuery = (root, sel) => {
        const found = root.querySelector(sel);
        if (found) return found;
        for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) {
                const hit = deepQuery(el.shadowRoot, sel);
                if (hit) return hit;
            }
        }
        return null;
    };
    const bc = document.querySelector('bili-comments');
    const root = bc && bc.shadowRoot ? bc.shadowRoot : document;
    const editor = deepQuery(root, '[contenteditable=true]');
    if (!editor) throw new Error('comment editor not found (comment area may still be loading), retry later');
    editor.focus();
    await sleep(200);
    const ok = document.execCommand('insertText', false, text);
    if (!ok || !(editor.textContent || '').includes(text.slice(0, 8))) {
        editor.textContent = text;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    await sleep(400);
    // 发布按钮与编辑器同属一个评论框实例，必须沿 shadow host 链向上找：
    // 页面可能同时存在多个评论框实例，全局查找会点错实例导致发表无效（实测）
    let submit = null;
    for (let i = 0; i < 10 && !submit; i++) {
        await sleep(400);
        let node = editor.getRootNode().host;
        for (let hop = 0; hop < 6 && node && !submit; hop++) {
            if (node.shadowRoot) {
                submit = [...node.shadowRoot.querySelectorAll('button')].find((b) => (b.textContent || '').trim().includes('发布') && !b.disabled) || null;
            }
            try {
                const rn = node.getRootNode();
                node = rn && rn.host ? rn.host : null;
            } catch (err) {
                node = null;
            }
        }
    }
    if (!submit) throw new Error('publish button not active yet, retry later');
    // Lit 组件的监听不响应单纯的 click，需要完整指针事件序列（实测）
    const opts = { bubbles: true, cancelable: true, view: window };
    submit.dispatchEvent(new PointerEvent('pointerdown', opts));
    submit.dispatchEvent(new MouseEvent('mousedown', opts));
    submit.dispatchEvent(new PointerEvent('pointerup', opts));
    submit.dispatchEvent(new MouseEvent('mouseup', opts));
    submit.dispatchEvent(new MouseEvent('click', opts));
    await sleep(2500);
    const cleared = editor ? (editor.textContent || '').trim() === '' : false;
    return { posted: cleared, content: text, editorCleared: cleared };
}`;

const BILI_SEARCH = {
    kind: 'action',
    name: 'Search',
    description: '在 B 站搜索：一步跳转到 B 站搜索结果页，无需手动填搜索框',
    args: {
        keyword: '搜索关键词，如：OpenHarmony 教程',
        category: '可选。all(全部，默认) | video(视频) | live(直播) | article(图文/专栏) | user(用户/UP主)'
    },
    functionStr: BILI_SEARCH_FN
};

const BILI_NEXT = {
    kind: 'action',
    name: 'NextPage',
    description: '翻到 B 站搜索结果的下一页（page 参数）',
    functionStr: BILI_NEXT_FN
};

const BILI_PREV = {
    kind: 'action',
    name: 'PrevPage',
    description: '翻回 B 站搜索结果的上一页',
    functionStr: BILI_PREV_FN
};

const BILI_TOGGLE_PLAY = {
    kind: 'action',
    name: 'TogglePlay',
    description: '切换 B 站视频播放/暂停，返回切换后的状态',
    functionStr: BILI_TOGGLE_PLAY_FN
};

const BILI_TOGGLE_DANMAKU = {
    kind: 'action',
    name: 'ToggleDanmaku',
    description: '开关 B 站视频弹幕，返回切换后的状态',
    functionStr: BILI_TOGGLE_DANMAKU_FN
};

const BILI_SEEK = {
    kind: 'action',
    name: 'Seek',
    description: '跳转 B 站视频到指定时间点（页面重载后从该位置自动播放）',
    args: {
        t: '目标时间，单位秒，如 90 表示 1:30'
    },
    functionStr: BILI_SEEK_FN
};

const BILI_LOGIN = {
    kind: 'action',
    name: 'Login',
    description: 'B 站未登录时使用：跳转到扫码登录页，登录后自动回到当前页面',
    functionStr: BILI_LOGIN_FN
};

const BILI_LIKE = {
    kind: 'action',
    name: 'Like',
    description: '点赞当前 B 站视频（已点赞则跳过）',
    functionStr: BILI_LIKE_FN
};

const BILI_COIN = {
    kind: 'action',
    name: 'Coin',
    description: '给当前 B 站视频投 1 枚硬币（默认选项，含"同时点赞内容"；已投则跳过）',
    functionStr: BILI_COIN_FN
};

const BILI_FAVORITE = {
    kind: 'action',
    name: 'Favorite',
    description: '收藏当前 B 站视频到默认收藏夹（已收藏则跳过）',
    functionStr: BILI_FAVORITE_FN
};

const BILI_TRIPLE = {
    kind: 'action',
    name: 'Triple',
    description: '一键三连当前 B 站视频：依次完成点赞、投 1 枚硬币、收藏到默认收藏夹（已完成项自动跳过）',
    functionStr: BILI_TRIPLE_FN
};

const BILI_FOLLOW = {
    kind: 'action',
    name: 'Follow',
    description: '关注当前视频的 UP 主（已关注则跳过）',
    functionStr: BILI_FOLLOW_FN
};

const BILI_COMMENT = {
    kind: 'action',
    name: 'Comment',
    description:
        '在当前 B 站视频下发表一条评论（自动滚动到评论区、填入内容并点击发布）。' +
        'posted=true 表示 B 站已受理发送请求；新评论可能进入审核队列，服务端展示有延迟',
    args: {
        content: '要发表的评论文字'
    },
    functionStr: BILI_COMMENT_FN
};

export function registerBilibiliHints(ctx) {
    ctx.browser.hint.register('www.bilibili.com', () => [BILI_SEARCH]);
    ctx.browser.hint.register('search.bilibili.com', () => [BILI_SEARCH, BILI_NEXT, BILI_PREV]);
    ctx.browser.hint.register('www.bilibili.com/video', () => [BILI_TOGGLE_PLAY, BILI_TOGGLE_DANMAKU, BILI_SEEK]);
    // 视频页互动组：未登录只提供 Login，其余（点赞/投币/收藏/三连/关注/评论）需登录态
    ctx.browser.hint.register('www.bilibili.com/video', async (context) => {
        const dom = await context.dom();
        // 登录按钮 class 名也会出现在页面内联 CSS 里，必须匹配元素形态而非裸字符串
        if (/class="[^"]*header-login-entry/.test(dom)) return [BILI_LOGIN];
        return [BILI_LIKE, BILI_COIN, BILI_FAVORITE, BILI_TRIPLE, BILI_FOLLOW, BILI_COMMENT];
    });
}
