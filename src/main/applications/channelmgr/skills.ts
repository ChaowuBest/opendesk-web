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
description: 管理消息渠道插件，包括插件安装/配置、消息渠道相关的设备配对、查看连接状态等功能。
    消息渠道插件主要用来支持用户通过第三方软件（微信/飞书/Zalo/WhatsApp/小艺）接入OpenDesk并与Agent对话。
---

# 消息渠道管理

本技能提供对消息渠道插件的完整管理功能，包括插件安装配置、设备配对和连接状态监控。
当前已经支持的消息渠道包括微信和飞书，其他消息渠道正在适配中。

## 消息渠道与登录

微信与飞书是 OpenDesk **内置原生消息渠道插件**（位于 resources/plugins，随 OpenDesk 自动加载），
不需要手动安装。

当用户说"登录微信"、"登录飞书"、"连接 WhatsApp"、"登录 Zalo"等时，**必须使用 loginChannel 工具**，
传入对应的 channelId。

| 渠道 | channelId | 登录方式 |
|------|-----------|----------|
| 微信 | \`weixin\` | 扫码登录（getAccountLoginQr） |
| 飞书 | \`feishu\` | 参数登录（appId/appSecret） |

### 消息渠道1：微信

- 渠道 id：\`weixin\`
- 登录：调用 loginChannel（channelId=weixin），系统生成二维码，用户使用微信扫码后完成登录
- 登录成功后凭证由渠道插件自行持久化，无需手动配置
- 支持单聊与群聊文本消息

### 消息渠道2：飞书

- 渠道 id：\`feishu\`
- 登录：调用 loginChannelWithParams 工具或引导用户在「消息渠道」界面通过参数登录表单输入
  **App ID** 与 **App Secret**（来自飞书开放平台创建的企业自建应用）
- 也可使用 createFeishuBot 工具通过手机扫码一键创建机器人，获取 App ID/App Secret
- 应用需启用「长连接」事件订阅（应用能力 > 事件与回调 > 长连接模式），插件通过 WebSocket 接收消息
- 支持单聊/群聊文本与图片消息

### 账号级设置

在「消息渠道」界面可为每个账号设置 **工作目录（workspace）** 与 **模式（agent）**，
从该账号进入的消息会自动使用这些设定创建任务。

### 内置消息渠道插件管理工具清单

- 使用 loginChannel 登录消息渠道（微信扫码 / 飞书等），传入对应 channelId
- 使用 createFeishuBot 通过手机扫码一键创建飞书机器人（推荐，最快捷的方式）
- 使用 listChannelPlugins 查看已安装的插件
- 使用 installChannelPlugin 安装消息渠道插件（OpenDesk 插件）
- 使用 uninstallChannelPlugin 卸载插件
- 使用 toggleChannelPlugin 启用或禁用插件
- 使用 setChannelConfig 设置渠道配置
- 使用 getChannelConfig 获取某个渠道的配置 JSON（调试用）

### 注意事项

- 微信/飞书为内置插件，随 OpenDesk 启动自动加载；第三方插件安装、卸载、启停或配置后会自动重新加载消息渠道
- 账号级运行时配置（workspace/agent）保存在 settings.json 的 applications.channelmgr.<channelId>.accountRuntime 下

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
