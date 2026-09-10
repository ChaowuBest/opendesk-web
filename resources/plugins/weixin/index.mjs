/**
 * OpenDesk 原生微信渠道插件入口。
 * 通过 ctx.channels.register 注册 WechatChannel。
 */

import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';
import { WechatChannel } from './wechat.mjs';

// 展示名称等静态元数据统一声明在 opendesk.plugin.json，入口只保留运行时字段。
export default definePlugin({
    id: 'weixin',
    setup(ctx) {
        const channel = new WechatChannel();
        ctx.channels.register(channel);
    }
});
