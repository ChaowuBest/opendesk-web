/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * See the Mulan PSL v2 for more details.
 */

/**
 * 工具的用户可见显示名：
 * - string：所有语言使用同一名称；
 * - Record<string, string>：按语言代码（如 'zh-CN' / 'en-US'）映射的多语言名称。
 *
 * 显示名由 BaseTool 自描述，仅在渲染边界（toRenderJSON / TUI / 内联 HTML）实时解析为当前语言的
 * 字符串后推送给前端；identifier（tool_name）是持久化真源，显示名不落盘。
 */
export type ToolDisplayName = string | Record<string, string>;
