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
    全局待办事项支持单次、周期和间隔执行，以及通过各个应用（如邮件、日历等）发送的事件进行触发。
---

# 全局待办事项管理

本技能介绍如何有效管理全局待办事项，并提供内置工具来完成各项操作。

## 什么是全局待办事项？

全局待办事项是跨任务持久保存的待办项，与任务级待办不同，全局待办在任务结束后仍然保留，可以跨会话使用。

## addGlobalTodo 添加全局待办事项

在本Skill的内置工具中我们提供了 addGlobalTodo 工具来添加全局待办事项。全局待办事项当前支持三种触发方式：

1. 定时任务：设置一个固定的时间执行一次；
2. 重复任务：通过 recurrence 设置每天、每周、双周、每月、每年，或每隔 N 小时、天、周、月、年执行；
3. 事件触发型任务：在指定的事件发生时执行，这些事件通常都是由其他应用提供的；

addGlobalTodo 还支持以下可选配置：

- workspace：触发后创建任务时使用的工作空间绝对路径；不指定则使用当前默认工作空间。
- deliver：触发任务完成后最终回复的投递目标，格式为 \`{"type":"channel","channel":"渠道ID","accountId":"账号ID","recipientId":"接收方ID"}\`；不指定时，如果当前任务本身来自消息渠道，会继承当前会话作为投递目标。
- model：触发任务使用的已配置聊天模型 alias；不指定则在触发时使用全局默认模型。
- reasoningEffort：推理档位，可选 \`\`, \`none\`, \`low\`, \`medium\`, \`high\`, \`max\`；不指定或为空字符串时使用模型默认档位。
- trigger.recurrence：重复任务的结构化频率。type 仍为 cron，但新任务省略 cronExpression；工具会填充内部唤醒规则。只向用户显示自然语言频率，不展示内部表达式。
- trigger.timezone：scheduled 和 cron 触发器的 IANA 时区。用户明确指定时区时使用用户指定值；新建时用户未指定，先调用 \`getCurrentTime\` 获取系统 IANA 时区，按该时区理解用户的时间，省略 timezone 由运行时保存系统时区。recurrence 的 time 按目标时区的当地时间执行并自动跟随夏令时；hour 间隔按真实小时持续计时，day、week、month、year 间隔按当地日历时间执行；scheduled 的 triggerAt 始终是 UTC 绝对时间，timezone 仅决定展示时区。

### 在创建全局待办事项时应遵循以下规则

1. 总是遵循先验证后创建的原则，在验证完确认待办事项的内容具备可行性之后才进行添加；
2. 如果你需要用到重复的脚本执行等，务必提前创建好脚本，并然后在待办事项的内容中，直接执行脚本就可以了；
3. 创建 scheduled 或 cron 触发器前，先调用 \`getCurrentTime\`，读取实际返回的 UTC 时间、本地日期和系统 IANA 时区。用户未指定时区时使用该系统时区，不根据对话语言推断时区，也不照抄示例中的时区。用户指定其他时区时，按该时区计算日期、时间和夏令时偏移。

### updateGlobalTodo 更新全局待办待办事项

指定一个已有的全局待办事项ID，更新其信息，包括修改标题，内容，启用状态等。
updateGlobalTodo 也可以更新 workspace、model、reasoningEffort 和 deliver；使用 removeWorkspace/removeModel/removeDeliver 可以移除对应配置。
更新已有任务时，用户未要求改变时区，应保留任务原时区；未保存 timezone 的旧 cron 继续按 UTC 执行，不用当前系统时区覆盖。为原本没有定时触发器的任务新增 scheduled 或 cron 触发器时，按新建规则先获取系统时区。

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

Agent：我先获取当前时间和系统时区，确定当地的明天上午 9 点...
[调用 getCurrentTime 工具，读取实际返回的 UTC 时间、本地日期和系统 IANA 时区]
[按该系统时区确定明天 09:00，并换算成 UTC triggerAt，使用目标日期的夏令时偏移]
[调用 addGlobalTodo 工具]
- title: "开会提醒"
- content: "参加会议"
- trigger.type: "scheduled"
- trigger.triggerAt: 上一步计算得到的 UTC ISO 时间，以 Z 结尾
- trigger.timezone: 省略，由运行时保存系统时区
- workspace: "/path/to/workspace"（可选）
- deliver: {"type":"channel","channel":"feishu","accountId":"default","recipientId":"oc_xxx"}（可选）
\`\`\`

### 示例3：创建周期性待办

\`\`\`
用户：每周一至周五早上 9 点提醒我写日报

Agent：我先获取系统时区，再按当地时间创建周期性提醒...
[调用 getCurrentTime 工具，读取系统 IANA 时区]
[调用 addGlobalTodo 工具]
- title: "写日报"
- content: "撰写今日工作日报，总结完成事项和明日计划"
- trigger: {"type": "cron", "recurrence": {"mode":"weekly","time":"09:00","weekdays":[1,2,3,4,5]}}
  （注：省略 timezone，按工具获取的系统时区，在周一至周五当地时间 9:00 执行；不含节假日、调休判断，不需要将 time 换算为 UTC）
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

1. **时间与时区**：创建 scheduled 或 cron 触发器前，先使用 \`getCurrentTime\` 获取当前 UTC 时间、本地日期和系统 IANA 时区。
   - 用户明确指定时区时优先使用该时区；用户未指定时，使用工具返回的系统时区，不默认使用北京时间或其他固定时区
   - 所有 scheduled.triggerAt 必须使用 **UTC 时间**（ISO 8601 格式，以 Z 结尾），将目标时区的执行日期和墙钟时间按该日期的实际偏移换算成 UTC；不要将当前偏移直接套用于未来的夏令时日期
   - trigger.timezone 只决定 scheduled 计划的展示时区，不会改变 triggerAt 对应的绝对执行时刻

2. **重复任务频率**：优先使用 trigger.recurrence，支持以下模式；周期 time 为当地 HH:mm，不要预先换算为 UTC。
   - daily：time。
   - weekly：time 和 weekdays（0=周日，1=周一，6=周六，非空）。
   - biweekly：time、weekdays、anchorDate（YYYY-MM-DD），anchorDate 所在当地周一至周日为首个执行周，之后每隔一周执行。
   - monthly：time 和 days（非空日期数组，每项 1..31），每个所选日期执行一次；无该日的月份跳过。
   - yearly：time、months（非空月份数组，每项 1..12）和 days，在每个所选月份的每个所选日期执行；无该日的月份跳过，2 月 29 日仅闰年执行。所有月份和日期的组合均不存在时无效。
   - 旧计划的单个 day、month 仍兼容；新建计划使用 days、months。数组字段存在时优先于相应旧字段，空数组无效，不回退到旧字段。
   - interval：intervalValue（正整数）、intervalUnit（hour、day、week、month、year）和 anchorAt（精确到整分钟的 UTC ISO 时间）。hour 按真实小时累计，不填写 time 或日期选择。新建 day 间隔还需 time；week 还需 time 和非空 weekdays；month 还需 time 和非空 days；year 还需 time、非空 months 和 days。星期、日期、月份都支持多选。
   - 带 time 的日历间隔以 anchorAt 所在当地日、周（周一起始）、月、年为首个执行周期，之后每隔 intervalValue 个日历单位执行所选日期和时间；首个周期只执行不早于 anchorAt 的时刻，不补跑之前的时刻。无所选日期的月份跳过；夏令时不存在的当地时间跳过，重复的当地时间只执行第一次。旧 intervalHours 以及未设置 time 的旧 intervalValue/intervalUnit 计划保持原有执行规则，不要为了修改其他字段而重写。
   以下未明确指定时区的示例均省略 timezone，创建前先获取系统时区；anchorAt 中的日期仅示意格式，实际应根据当前时间和用户要求计算。
   只有用户明确要求“纽约时间每天 9 点”时才指定时区，例如 \`{"type":"cron","recurrence":{"mode":"daily","time":"09:00"},"timezone":"America/New_York"}\`。未指定时区的“每隔 5 小时”用 \`{"type":"cron","recurrence":{"mode":"interval","intervalValue":5,"intervalUnit":"hour","anchorAt":"2026-10-23T02:15:00Z"}}\`。
   每月 1 日、15 日 9 点用 \`{"type":"cron","recurrence":{"mode":"monthly","time":"09:00","days":[1,15]}}\`。每年三月、六月的 1 日和 15 日 9 点用 \`{"type":"cron","recurrence":{"mode":"yearly","time":"09:00","months":[3,6],"days":[1,15]}}\`，每年共执行 4 次。
   每隔 2 周的周一、周三 9:30 用 \`{"type":"cron","recurrence":{"mode":"interval","intervalValue":2,"intervalUnit":"week","weekdays":[1,3],"time":"09:30","anchorAt":"2026-10-23T02:15:00Z"}}\`。每隔 3 个月的 1 日、15 日 18:00 用 \`{"type":"cron","recurrence":{"mode":"interval","intervalValue":3,"intervalUnit":"month","days":[1,15],"time":"18:00","anchorAt":"2026-10-23T02:15:00Z"}}\`。每隔 2 年三月、六月的 1 日 8:00 用 \`{"type":"cron","recurrence":{"mode":"interval","intervalValue":2,"intervalUnit":"year","months":[3,6],"days":[1],"time":"08:00","anchorAt":"2026-10-23T02:15:00Z"}}\`。
   新建时未指定 timezone 默认使用系统时区；未指定 timezone 的旧计划继续按 UTC 执行。已有 cronExpression 仅作兼容，修改其他信息时保留它的表达式和时区；对用户用自然语言说明频率，不输出内部表达式。

3. **一次性任务的自动禁用**：scheduled 和 event 类型的待办在触发执行后会自动设为 enabled=false（未启用），如需再次执行需重新启用

4. **content 字段的重要性**：content 是发送给 Agent 执行的详细指令，Agent 有能力调用工具访问文件、执行命令等，因此具体需求应明确写在 content 中

5. **触发器的时间计算**：设置 scheduled 或 cron 触发器前，务必先调用 \`getCurrentTime\` 获取当前 UTC 时间和系统 IANA 时区。更新已有任务时，以原时区为基准；新建且用户未指定时区时，以系统时区为基准；用户明确指定时区时，以用户指定时区为基准。

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
