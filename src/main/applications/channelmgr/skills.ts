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
description: 管理消息渠道插件的设备配对、查看连接状态等功能
---

# 消息渠道管理

本技能提供对消息渠道插件（如飞书、微信等）的管理功能，包括设备配对和连接状态监控。

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
