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

export const MANAGE_DEVICES_SKILL = `
---
name: manage-devices
description: 管理通过 OpenClaw Node 协议接入的设备节点，包括查看在线设备、配对审批、远程命令调用等功能。
---

# 设备管理

本技能提供对通过 OpenClaw Node WebSocket 协议接入的设备节点的完整管理能力。
设备节点可以是 macOS App、Windows App、iOS App 等客户端，它们通过 WebSocket 连接到 OpenDesk 的设备网关。

## 网关状态

使用 getDeviceGatewayStatus 工具查看设备网关的运行状态，包括监听端口、在线设备数、已配对设备数等信息。

## 查看设备

### 在线设备

使用 listConnectedDevices 工具可以查看当前通过 WebSocket 连接的所有在线设备。
每个设备包含以下信息：节点 ID、显示名称、平台、设备系列、能力列表、支持的命令、连接时间等。

### 已配对设备

使用 listPairedDevices 工具可以查看所有已完成配对的设备（包括当前离线的）。
已配对设备可以在重新连接后自动认证，无需再次配对。

## 设备配对

当新设备首次连接到网关时，需要完成配对流程：

1. 设备连接并发送配对请求
2. 使用 listPendingDevicePairings 查看待审批的配对请求
3. 使用 approveDevicePairing 审批通过配对请求（需要提供 requestId）
4. 使用 rejectDevicePairing 拒绝配对请求

### 自动审批

来自本机（localhost/127.0.0.1）的连接默认自动审批，可在配置中关闭。

### 注意事项

- 配对请求有效期为 5 分钟，过期自动清除
- 审批后设备将获得 pairing token，后续连接可直接认证
- 重新配对会轮换 token，旧 token 失效

## 远程命令调用

使用 invokeDeviceCommand 工具可以向在线设备发送命令。设备必须在连接时声明支持该命令。

### 常见命令类别

| 能力 | 常见命令 | 说明 |
|------|---------|------|
| camera | camera.snap, camera.record | 摄像头拍照/录制 |
| canvas | canvas.navigate, canvas.screenshot | 画布导航/截图 |
| screen | screen.record | 屏幕录制 |
| location | location.get | 获取地理位置 |
| voice | voice.record | 录音 |

### 调用示例

要对名为 "我的 iPhone" 的设备拍照：
1. 使用 listConnectedDevices 获取设备的 nodeId
2. 使用 invokeDeviceCommand，传入 nodeId 和 command="camera.snap"

### 超时处理

命令调用默认超时 30 秒，可通过 timeoutMs 参数自定义。超时后将返回 TIMEOUT 错误。
`;
