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
name: notes
description: 提供笔记管理功能：查看笔记列表、创建新笔记、修改笔记内容、删除笔记、管理标签
---

# 笔记管理

本技能提供完整的笔记管理能力，包括查看、创建、修改和删除笔记，以及标签管理。

## 查看笔记

使用 **getNotes** 工具可以获取笔记列表。支持按关键词搜索、按标签过滤、按时间排序。

## 创建笔记

使用 **createNote** 工具可以创建新笔记。需要提供：
- 标题（title）
- 可选：内容（content，HTML格式）
- 可选：标签（tags，字符串数组）

## 修改笔记

使用 **updateNote** 工具可以修改已有笔记的标题、标签和置顶状态。

## 删除笔记

使用 **deleteNote** 工具可以删除指定笔记。

## 注意事项

- 笔记内容为HTML格式
- 标签为字符串，可通过标签筛选笔记
`;
