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

export const NOTES_SKILL = `
---
name: manage-notes
description: 提供完整的笔记管理功能：创建笔记、编辑笔记内容和元数据、阅读笔记、列出笔记（支持搜索和日期过滤）、管理标签、删除笔记（支持回收站恢复）
---

# 笔记管理

本技能提供完整的笔记管理能力，包括创建、阅读、编辑、删除笔记，以及标签管理和回收站功能。

## 创建笔记

使用 **createNote** 工具可以创建新笔记。需要提供：
- 标题（title，必填）
- 可选：内容（content，HTML格式）
- 可选：标签（tags，字符串数组）
- 可选：是否置顶（isPinned，布尔值）

## 阅读笔记

使用 **readNote** 工具可以读取指定笔记的完整内容，包括元数据和HTML内容。需要提供笔记ID（noteId）。

## 编辑笔记

使用 **editNote** 工具可以修改已有笔记。需要提供：
- 笔记ID（noteId，必填）
- 可选：新标题（title）
- 可选：新内容（content，HTML格式）
- 可选：新标签列表（tags）
- 可选：是否置顶（isPinned）

仅需提供需要修改的字段，未提供的字段将保持原值不变。

## 列出笔记

使用 **listNotes** 工具可以获取笔记列表。支持：
- 按关键词搜索（searchQuery，按标题匹配）
- 按标签过滤（tagFilter）
- 按日期范围筛选（startDate/endDate，格式 YYYY-MM-DD）
- 排序方式（sortBy：updatedAt/createdAt/title）

## 列出标签

使用 **listTags** 工具可以获取所有标签列表。

## 删除笔记

使用 **deleteNotes** 工具可以删除一条或多条笔记。需要提供笔记ID列表（noteIds，字符串数组）。删除后笔记将移入回收站，10天内可恢复。

## 注意事项

- 笔记内容为HTML格式
- 标签为字符串，可通过标签筛选笔记
- 删除的笔记会进入回收站，10天后自动永久删除
- 日期格式统一使用 YYYY-MM-DD
`;
