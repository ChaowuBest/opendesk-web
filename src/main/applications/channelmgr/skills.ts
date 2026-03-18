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

export const MANAGE_CHANNELS_SKILL = `
---
name: manage-channels
description: 管理消息渠道插件，包括插件安装/配置、设备配对、查看连接状态等功能。
    消息渠道插件主要用来支持用户通过第三方软件(飞书/小艺/)接入OpenDesk并与Agent对话。
---

# 消息渠道管理

本技能提供对消息渠道插件（如飞书、小艺等）的完整管理功能，包括插件安装配置、设备配对和连接状态监控。

## 插件安装与配置

### 消息渠道1：飞书

#### 飞书 (Feishu / Lark)

插件包名: \`@openclaw/feishu@3.12\` (当前仅针对该特定版本测试)

##### 配置步骤

1. 使用内置工具 installChannelPlugin 工具安装 \`@openclaw/feishu\` 插件
2. 使用 getChannelConfig 工具检查 feishu 渠道是否已有 appId 配置
3. **如果 appId 为空或不存在**：调用 createFeishuBot 工具，让用户通过手机飞书扫码一键创建机器人（工具会在界面上显示二维码，用户扫码后自动返回 App ID 和 App Secret）
4. **如果 appId 已存在**：直接使用现有凭证，或询问用户是否需要重新创建
5. 使用 setChannelConfig 工具将获得的凭证（appId, appSecret）写入配置

**重要**：优先使用 createFeishuBot 扫码创建方式，这比手动在飞书开放平台创建应用要快得多。只有在扫码不可用时才引导用户手动创建。

##### 飞书配置项

飞书渠道的配置 JSON 结构如下：

\`\`\`json
{
    "enabled": true,
    "connectionMode": "websocket",
    "dmPolicy": "pairing",
    "groupPolicy": "allowlist",
    "requireMention": true,
    "accounts": {
        "default": {
            "appId": "<在飞书开放平台获得的App ID>",
            "appSecret": "<在飞书开放平台获得的App Secret>"
        }
    }
}
\`\`\`

使用 setChannelConfig 工具时，channelId 填 "feishu"，config 填上述 JSON 对象。

### 内置消息渠道插件管理工具清单

- 使用 createFeishuBot 通过手机扫码一键创建飞书机器人（推荐，最快捷的方式）
- 使用 listChannelPlugins 查看已安装的插件
- 使用 installChannelPlugin 安装新插件
- 使用 uninstallChannelPlugin 卸载插件
- 使用 toggleChannelPlugin 启用或禁用插件
- 使用 setChannelConfig 设置渠道配置
- 使用 getChannelConfig 获取某个渠道的配置 JSON（调试用）

### 注意事项

- 安装或配置插件后需要重启 OpenDesk 才能生效
- 配置信息会保存在 settings.json 的 applications.channelmgr 下

## 设备配对

当外部用户通过消息渠道（如飞书）首次向机器人发消息时，系统会要求该用户进行"配对"。
配对请求会记录在系统中，等待管理员审批。

### 查看待配对设备

使用 listPairingRequests 工具可以查看所有等待配对审批的设备/用户请求。
每个请求包含用户ID、用户名称、渠道来源和配对码等信息。

### 审批配对请求

使用 approvePairing 工具可以批准某个用户的配对请求。
批准后该用户后续发送的消息将正常被处理和路由到 Agent。
已批准的配对会被持久化存储，重启后仍然有效。

### 拒绝/撤销配对

使用 revokePairing 工具可以拒绝一个待配对请求，或撤销一个已配对用户的权限。

### 查看已配对用户

使用 listApprovedUsers 工具可以查看所有已批准配对的用户列表。

## 查看渠道状态

使用 listChannelStatus 工具可以查看所有消息渠道插件的连接状态。
`;
