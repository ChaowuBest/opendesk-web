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

export const MANAGE_GLOBAL_TODOS_SKILL = `
---
name: manage-global-todos
description:
    介绍全局待办事项的管理，包括添加、删除、更新、查询等操作。
    全局待办事项支持通过定时触发、周期触发（类似crontab）以及通过各个应用（如邮件、日历等）发送的事件进行触发。
---

# 全局待办事项管理

本技能介绍如何有效管理全局待办事项，并提供内置工具来完成各项操作。

## 什么是全局待办事项？

全局待办事项是跨任务持久保存的待办项，与任务级待办不同，全局待办在任务结束后仍然保留，可以跨会话使用。

## addGlobalTodo 添加全局待办事项

在本Skill的内置工具中我们提供了 addGlobalTodo 工具来添加全局待办事项。全局待办事项当前支持三种触发方式：

1. 定时任务：设置一个固定的时间执行一次；
2. 周期型任务：通过给定Crontab风格的周期表达式来定期执行任务；
3. 事件触发型任务：在指定的事件发生时执行，这些事件通常都是由其他应用提供的；

addGlobalTodo 还支持以下可选配置：

- workspace：触发后创建任务时使用的工作空间绝对路径；不指定则使用当前默认工作空间。
- deliver：触发任务完成后最终回复的投递目标，格式为 \`{"type":"channel","channel":"渠道ID","accountId":"账号ID","recipientId":"接收方ID"}\`；不指定时，如果当前任务本身来自消息渠道，会继承当前会话作为投递目标。

### 在创建全局待办事项时应遵循以下规则

1. 总是遵循先验证后创建的原则，在验证完确认待办事项的内容具备可行性之后才进行添加；
2. 如果你需要用到重复的脚本执行等，务必提前创建好脚本，并然后在待办事项的内容中，直接执行脚本就可以了；

### updateGlobalTodo 更新全局待办待办事项

指定一个已有的全局待办事项ID，更新其信息，包括修改标题，内容，启用状态等。
updateGlobalTodo 也可以更新 workspace 和 deliver；使用 removeWorkspace/removeDeliver 可以移除对应配置。

### listGlobalTodoDeliverTargets 列出可用投递目标

列出当前已连接消息渠道及历史联系人。用户要求“发送到某个渠道/群/联系人”但没有提供完整 ID 时，应先调用该工具获取可用 deliver 对象，再创建或更新全局待办。

### listGlobalTodos 列出全局待办

查询所有全局待办事项，支持筛选。

### deleteGlobalTodo 删除全局待办

指定待办事项的ID，删除指定的全局待办事项。

## 使用示例

### 示例1：创建简单的全局待办

\`\`\`
用户：帮我添加一个待办，提醒我明天检查邮件

Agent：我来帮你添加一个全局待办。首先获取当前时间来确定"明天"的具体日期...
[调用 getCurrentTime 工具]
[调用 addGlobalTodo 工具，title="检查邮件", content="打开邮箱，查看并处理未读邮件"]
\`\`\`

### 示例2：创建定时触发的待办

\`\`\`
用户：明天上午9点提醒我开会

Agent：我来帮你创建一个定时提醒。首先获取当前 UTC 时间...
[调用 getCurrentTime 工具，假设当前 UTC 时间为 2026-02-28T10:00:00Z]
[调用 addGlobalTodo 工具]
- title: "开会提醒"
- content: "参加会议"
- trigger: {"type": "scheduled", "triggerAt": "2026-03-01T01:00:00Z"}
  （注：北京时间上午9点 = UTC时间凌晨1点）
- workspace: "/path/to/workspace"（可选）
- deliver: {"type":"channel","channel":"feishu","accountId":"default","recipientId":"oc_xxx"}（可选）
\`\`\`

### 示例3：创建周期性待办

\`\`\`
用户：每个工作日早上提醒我写日报

Agent：我来创建一个周期性提醒...
[调用 addGlobalTodo 工具]
- title: "写日报"
- content: "撰写今日工作日报，总结完成事项和明日计划"
- trigger: {"type": "cron", "cronExpression": "0 1 * * 1-5"}
  （注：UTC 1:00 = 北京时间 9:00，工作日触发）
\`\`\`

### 示例4：查看和管理待办

\`\`\`
用户：我有哪些待办事项？

Agent：让我查看你的全局待办列表...
[调用 listGlobalTodos 工具]

用户：把第一个待办设为未启用

Agent：好的，我来更新这个待办的启用状态...
[调用 updateGlobalTodo 工具，设置 enabled=false]
\`\`\`

## 重要注意事项

1. **时间格式**：所有 scheduled 触发器的时间必须使用 **UTC 时间**（ISO 8601 格式，以 Z 结尾）。例如：
   - 北京时间 2026-03-01 09:00 (UTC+8) → UTC 时间 \`2026-03-01T01:00:00Z\`
   - 使用 \`getCurrentTime\` 工具获取当前 UTC 时间作为计算基准

2. **cron 表达式**：使用标准 5 字段格式 "分 时 日 月 周"，时间为 UTC 时间

3. **一次性任务的自动禁用**：scheduled 和 event 类型的待办在触发执行后会自动设为 enabled=false（未启用），如需再次执行需重新启用

4. **content 字段的重要性**：content 是发送给 Agent 执行的详细指令，Agent 有能力调用工具访问文件、执行命令等，因此具体需求应明确写在 content 中

5. **触发器的时间计算**：设置 scheduled 触发器前，务必先调用 \`getCurrentTime\` 获取当前 UTC 时间，然后根据用户描述的时间进行计算

6. **事件触发型待办**：创建事件触发型待办时，需要指定 \`bundleName\`（应用标识）和 \`eventName\`（事件名称）。可使用 \`getSupportedEvents\` 工具查询所有应用已注册的事件清单。

### getSupportedEvents 获取可用事件

查询所有应用已注册的事件清单，用于创建事件触发型待办事项时选择合适的触发事件。

\`\`\`
用户：我想在收到新邮件时提醒我处理

Agent：让我先查看有哪些可用的事件...
[调用 getSupportedEvents 工具]
[发现 mailbox 应用有 newEmailCountsUpdated 事件]
[调用 addGlobalTodo 工具，trigger: {"type": "event", "bundleName": "mailbox", "eventName": "newEmailCountsUpdated"}]
\`\`\`
`;
