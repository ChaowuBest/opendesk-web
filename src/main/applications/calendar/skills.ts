export const CALENDAR_SKILL = `
---
name: calendar
description: 提供日程管理功能：查看指定日期的日程安排和会议列表、添加新日程、删除日程
---

# 日历日程管理

本技能提供完整的日程管理能力，包括查看、添加和删除日程项。

## 查看日程

使用本 Skill 内置的 **getCalendarItems** 工具可以获取指定日期的日程安排和会议列表。
需要提供日期字符串，格式为 YYYY-MM-DD。

## 添加日程

使用本 Skill 内置的 **addCalendarItem** 工具可以添加新的日程项。需要提供：
- 日程标题（subject）
- 日期（dateString，格式 YYYY-MM-DD）
- 开始时间（startTime，格式 HH:MM，24小时制）
- 结束时间（endTime，格式 HH:MM，24小时制）
- 可选：地点（location）
- 可选：是否全天事件（isAllDay）

## 删除日程

使用本 Skill 内置的 **deleteCalendarItem** 工具可以删除指定的日程项。
需要提供日程项的 uid（可通过 getCalendarItems 获取）。

## 注意事项

- 查询、添加、删除日程均支持本地日历和已配置的外部日历数据源（如 Outlook）。
- 日程的唯一标识为 uid，跨工具通用。
`;
