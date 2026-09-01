/**
 * OpenDesk 原生微信渠道插件入口。
 * 通过 ctx.channels.register 注册 WechatChannel。
 */

import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';
import { WechatChannel } from './wechat.mjs';

export default definePlugin({
    id: 'weixin',
    displayName: { en: 'WeChat', zh: '微信' },
    description: {
        en: 'WeChat channel (getUpdates long-poll + sendMessage)',
        zh: '微信消息渠道（getUpdates 长轮询 + sendMessage）'
    },
    apiVersion: 1,
    capabilities: ['channel'],
    setup(ctx) {
        const channel = new WechatChannel();
        ctx.channels.register(channel);
    }
});
