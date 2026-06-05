# OpenDesk 节点协议规范

OpenDesk 网关基于 **OpenClaw Node Protocol v4** 提供 WebSocket 服务，允许外部客户端（如移动设备、IoT 节点、第三方应用）与 OpenDesk 进行实时通信。

## 快速开始

```bash
# 安装依赖
pip install websockets

# 运行交互式示例
python3 node_example.py

# 指定网关地址
python3 node_example.py --host 192.168.1.100 --port 18789
```

## 协议概述

### 传输层

- **协议**: WebSocket (RFC 6455)
- **默认端口**: `18789`
- **消息格式**: JSON 文本帧
- **编码**: UTF-8

### 帧格式

所有消息都是 JSON 对象，通过 `type` 字段区分帧类型。

#### Request（请求帧）

客户端向服务端发送的 RPC 请求。

```json
{
    "type": "req",
    "id": "uuid-v4",
    "method": "chat.send",
    "params": {
        "sessionKey": "my-session",
        "message": "你好",
        "idempotencyKey": "uuid-v4"
    }
}
```

| 字段     | 类型    | 说明                                           |
| -------- | ------- | ---------------------------------------------- |
| `type`   | `"req"` | 固定值                                         |
| `id`     | string  | 请求唯一标识（UUID v4），服务端响应会回传此 ID |
| `method` | string  | RPC 方法名                                     |
| `params` | object? | 方法参数                                       |

#### Response（响应帧）

服务端对请求的回应。

```json
{
    "type": "res",
    "id": "uuid-v4",
    "ok": true,
    "payload": { "runId": "uuid", "status": "started" }
}
```

| 字段      | 类型    | 说明                                                            |
| --------- | ------- | --------------------------------------------------------------- |
| `type`    | `"res"` | 固定值                                                          |
| `id`      | string  | 对应请求的 ID                                                   |
| `ok`      | boolean | 是否成功                                                        |
| `payload` | object? | 响应数据                                                        |
| `error`   | object? | 错误信息 `{code, message, details?, retryable?, retryAfterMs?}` |

#### Event（事件帧）

服务端主动推送的事件，无需对应请求。

```json
{
    "type": "event",
    "event": "chat",
    "payload": {
        "runId": "uuid",
        "sessionKey": "my-session",
        "seq": 1,
        "state": "delta",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "你好！" }],
            "timestamp": 1716890400000
        }
    }
}
```

| 字段      | 类型      | 说明                                      |
| --------- | --------- | ----------------------------------------- |
| `type`    | `"event"` | 固定值                                    |
| `event`   | string    | 事件类型（如 `chat`、`tick`、`shutdown`） |
| `payload` | object?   | 事件数据                                  |
| `seq`     | number?   | 事件序号                                  |

## 连接握手

连接建立后需要完成握手流程才能调用其他方法。

### 流程

```
Client                              Server
  |                                     |
  |  ◄──── connect.challenge ────────   |  (1) 服务端发送挑战
  |                                     |
  |  ────── connect request ────────►   |  (2) 客户端回应
  |                                     |
  |  ◄──── hello-ok response ────────   |  (3) 握手完成
  |                                     |
  |  ────── chat.send / 其他方法 ────►  |  (4) 正常通信
```

### 1. 接收挑战 (connect.challenge)

连接建立后，服务端立即发送挑战事件：

```json
{
    "type": "event",
    "event": "connect.challenge",
    "payload": {
        "nonce": "base64url-encoded-random-bytes",
        "ts": 1716890400000
    }
}
```

### 2. 发送连接请求 (connect)

客户端发送 `connect` 请求。对于只需要聊天功能的客户端（operator 模式），无需设备身份认证：

```json
{
    "type": "req",
    "id": "uuid-v4",
    "method": "connect",
    "params": {
        "minProtocol": 4,
        "maxProtocol": 4,
        "client": {
            "id": "my-client-id",
            "displayName": "My Client",
            "version": "1.0.0",
            "platform": "python",
            "mode": "operator"
        }
    }
}
```

**客户端参数说明：**

| 字段                     | 类型   | 必需 | 说明                                                      |
| ------------------------ | ------ | ---- | --------------------------------------------------------- |
| `minProtocol`            | number | 是   | 客户端支持的最低协议版本                                  |
| `maxProtocol`            | number | 是   | 客户端支持的最高协议版本                                  |
| `client.id`              | string | 是   | 客户端唯一标识                                            |
| `client.version`         | string | 是   | 客户端版本                                                |
| `client.platform`        | string | 是   | 平台标识（如 `python`、`android`）                        |
| `client.mode`            | string | 是   | 客户端模式：`operator`（聊天客户端）或 `node`（设备节点） |
| `client.displayName`     | string | 否   | 显示名称                                                  |
| `client.deviceFamily`    | string | 否   | 设备系列                                                  |
| `client.modelIdentifier` | string | 否   | 设备型号                                                  |

**设备认证（可选）**：如果是设备节点需要发送设备命令或被网关主动调用，需要提供 `device` 和 `auth` 字段进行 Ed25519 签名认证。详见[设备认证](#设备认证)章节。

### 3. 接收握手确认 (hello-ok)

服务端返回握手确认：

```json
{
    "type": "res",
    "id": "uuid-v4",
    "ok": true,
    "payload": {
        "type": "hello-ok",
        "protocol": 4,
        "server": {
            "version": "1.0.0",
            "connId": "uuid-v4"
        },
        "features": {
            "methods": ["connect", "chat.send", "sessions.list", ...],
            "events": ["chat", "tick", "shutdown", ...]
        },
        "snapshot": {
            "sessions": [],
            "presence": []
        },
        "auth": {
            "role": "operator",
            "scopes": [],
            "issuedAtMs": 1716890400000
        },
        "policy": {
            "maxPayload": 26214400,
            "maxBufferedBytes": 52428800,
            "tickIntervalMs": 30000
        }
    }
}
```

## 聊天会话

### 发送消息 (chat.send)

```json
{
    "type": "req",
    "id": "uuid-v4",
    "method": "chat.send",
    "params": {
        "sessionKey": "my-session",
        "message": "帮我分析一下这段代码",
        "idempotencyKey": "uuid-v4",
        "thinking": "medium"
    }
}
```

| 参数             | 类型   | 必需 | 说明                                               |
| ---------------- | ------ | ---- | -------------------------------------------------- |
| `sessionKey`     | string | 是   | 会话标识。同一 sessionKey 的多次请求共享对话历史   |
| `message`        | string | 是\* | 用户消息文本（无附件时必需，有附件时可为空字符串） |
| `idempotencyKey` | string | 是   | 幂等键（UUID v4），防止重复处理                    |
| `thinking`       | string | 否   | 思考深度：`low`、`medium`、`high`                  |
| `attachments`    | array  | 否   | 附件列表（见下方附件格式说明）                     |

> \* `message` 字段在有 `attachments` 时可为空字符串 `""`，但必须至少存在一个非空附件。

### 附件格式 (attachments)

`attachments` 数组中的每个元素为 `ChatAttachment` 对象：

| 字段       | 类型   | 必需 | 说明                                                                     |
| ---------- | ------ | ---- | ------------------------------------------------------------------------ |
| `type`     | string | 否   | 附件类型，如 `"image"`。同时支持以 `mimeType` 推断类型                   |
| `mimeType` | string | 否   | MIME 类型，如 `"image/png"`、`"image/jpeg"`。默认 `"image/png"`          |
| `fileName` | string | 否   | 文件名，用于日志和 MIME 推断                                             |
| `content`  | string | 是   | **Base64 编码**的文件内容（支持纯 base64 或 `data:xxx;base64,...` 格式） |

**示例：发送一条带图片的消息**

```json
{
    "type": "req",
    "id": "uuid-v4",
    "method": "chat.send",
    "params": {
        "sessionKey": "my-session",
        "message": "请分析这张图片",
        "idempotencyKey": "uuid-v4",
        "attachments": [
            {
                "type": "image",
                "mimeType": "image/png",
                "fileName": "screenshot.png",
                "content": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC..."
            }
        ]
    }
}
```

**示例：仅发送图片（无文本）**

```json
{
    "type": "req",
    "id": "uuid-v4",
    "method": "chat.send",
    "params": {
        "sessionKey": "my-session",
        "message": "",
        "idempotencyKey": "uuid-v4",
        "attachments": [
            {
                "type": "image",
                "mimeType": "image/jpeg",
                "fileName": "photo.jpg",
                "content": "/9j/4AAQSkZJRgABAQAAAQABAAD..."
            }
        ]
    }
}
```

**响应格式**（即时 ACK）：

```json
{
    "type": "res",
    "id": "uuid-v4",
    "ok": true,
    "payload": {
        "runId": "uuid-v4",
        "status": "started"
    }
}
```

### 流式接收回复 (chat 事件)

发送消息后，服务端通过 `chat` 事件推送 AI 的流式回复。

**增量文本 (delta)**：

```json
{
    "type": "event",
    "event": "chat",
    "payload": {
        "runId": "uuid-v4",
        "sessionKey": "my-session",
        "seq": 1,
        "state": "delta",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "这段代码..." }],
            "timestamp": 1716890400000
        }
    }
}
```

**完成 (final)**：

```json
{
    "type": "event",
    "event": "chat",
    "payload": {
        "runId": "uuid-v4",
        "sessionKey": "my-session",
        "seq": 5,
        "state": "final",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "完整回复内容..." }],
            "timestamp": 1716890405000
        }
    }
}
```

**错误 (error)**：

```json
{
    "type": "event",
    "event": "chat",
    "payload": {
        "runId": "uuid-v4",
        "sessionKey": "my-session",
        "seq": 1,
        "state": "error",
        "errorMessage": "错误描述"
    }
}
```

### 聊天事件状态说明

| state        | 说明                                   |
| ------------ | -------------------------------------- |
| `started`    | 任务已开始处理                         |
| `delta`      | 增量文本输出。客户端应追加到显示缓冲区 |
| `thinking`   | 模型正在思考（深度思考模式）           |
| `toolCall`   | 模型正在调用工具                       |
| `toolResult` | 工具调用结果                           |
| `final`      | 任务完成，包含最终完整回复             |
| `error`      | 任务出错                               |

## 常用方法

### sessions.list — 列出会话

```json
{ "type": "req", "id": "uuid", "method": "sessions.list" }
```

### chat.history — 获取对话历史

```json
{
    "type": "req",
    "id": "uuid",
    "method": "chat.history",
    "params": { "sessionKey": "my-session" }
}
```

### chat.abort — 中止对话

```json
{
    "type": "req",
    "id": "uuid",
    "method": "chat.abort",
    "params": { "sessionKey": "my-session", "runId": "target-run-id" }
}
```

### health — 健康检查

```json
{ "type": "req", "id": "uuid", "method": "health" }
```

## 设备认证

设备节点（`mode: "node"`）如需被网关主动调用（如执行系统命令、获取位置等），需要提供设备认证。

### 认证流程

1. 客户端生成 Ed25519 密钥对
2. 使用私钥对认证载荷签名
3. 在 `connect` 请求中携带 `device` 和 `auth` 字段

```json
{
    "type": "req",
    "id": "uuid-v4",
    "method": "connect",
    "params": {
        "minProtocol": 4,
        "maxProtocol": 4,
        "client": {
            "id": "android-node-001",
            "version": "2.0.0",
            "platform": "android",
            "mode": "node"
        },
        "role": "node",
        "device": {
            "id": "device-public-key-hash",
            "publicKey": "base64-encoded-ed25519-public-key",
            "signature": "base64-encoded-signature",
            "signedAt": 1716890400000,
            "nonce": "challenge-nonce"
        },
        "auth": {
            "token": "pairing-token"
        }
    }
}
```

认证通过后，服务端在 `hello-ok` 的 `auth` 字段返回 `deviceToken`，用于后续连接的身份凭证。

## 心跳与保活

服务端每 30 秒发送 `tick` 事件：

```json
{ "type": "event", "event": "tick", "payload": { "ts": 1716890430000 } }
```

客户端无需回复。若长时间未收到 tick 或被服务端关闭连接，应自动重连。

## 错误处理

服务端使用标准错误格式：

```json
{
    "type": "res",
    "id": "uuid",
    "ok": false,
    "error": {
        "code": "INVALID_PARAMS",
        "message": "sessionKey is required"
    }
}
```

常见错误码：

| 错误码                          | 说明           |
| ------------------------------- | -------------- |
| `INVALID_PARAMS`                | 参数无效或缺失 |
| `METHOD_NOT_FOUND`              | 未知方法       |
| `NOT_AUTHENTICATED`             | 未完成握手     |
| `PROTOCOL_MISMATCH`             | 协议版本不兼容 |
| `DEVICE_AUTH_SIGNATURE_INVALID` | 设备签名无效   |
| `INTERNAL_ERROR`                | 内部错误       |

## 连接关闭

服务端可能在以下情况关闭连接：

- 握手超时（30 秒内未完成 connect）
- 协议不兼容
- 服务端关闭（发送 `shutdown` 事件后关闭）

## 示例代码

参见同目录下的 `node_example.py`，一个完整的 Python 交互式聊天客户端。

### 功能特性

- 文本对话：直接输入消息发送到 AI
- **图片发送**：使用 `/image <文件路径> [消息]` 发送图片附件（base64 编码）
- 思考过程：`/verbose` 命令切换深度思考显示
- 多会话：`/new` 命令创建新会话
- 流式输出：实时显示 AI 回复

### 图片发送示例

```bash
# 启动客户端
python3 node_example.py

# 在交互式中发送图片
You › /image ~/Pictures/screenshot.png 请分析这张截图

# 仅发送图片（使用默认提示语）
You › /image ~/Pictures/photo.jpg
```

编程方式发送图片：

```python
from node_example import encode_image_to_base64, send_message

# 编码图片
attachment = encode_image_to_base64("~/Pictures/screenshot.png")

# 发送带图片的消息
await send_message(ws, session_key, "请分析这张图片", attachments=[attachment])
```
