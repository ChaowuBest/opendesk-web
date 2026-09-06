/**
 * OpenDesk 原生飞书渠道插件入口。
 * 通过 ctx.channels.register 注册 FeishuChannel。
 */

import { definePlugin } from '@bitclub.ai/opendesk-plugin-sdk';
import { FeishuChannel } from './feishu.mjs';

// 展示名称等静态元数据统一声明在 opendesk.plugin.json，入口只保留运行时字段。
export default definePlugin({
    id: 'feishu',
    setup(ctx) {
        const channel = new FeishuChannel();
        ctx.channels.register(channel);
    }
});
