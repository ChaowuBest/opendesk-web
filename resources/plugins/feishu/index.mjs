/**
 * OpenDesk 原生飞书渠道插件入口。
 * 通过 ctx.channels.define 注册 FeishuChannel。
 */

import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';
import { FeishuChannel } from './feishu.mjs';

export default definePlugin({
    id: 'feishu',
    displayName: { en: 'Feishu', zh: '飞书' },
    description: 'Feishu/Lark channel (WebSocket long connection + open-apis)',
    apiVersion: 1,
    capabilities: ['channel'],
    setup(ctx) {
        const channel = new FeishuChannel();
        ctx.channels.define(channel);
    }
});
