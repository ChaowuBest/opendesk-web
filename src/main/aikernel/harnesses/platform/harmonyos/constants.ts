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

// Bash 摩擦检测滑动窗口大小：跟踪近期 Bash 执行成败的窗口长度。
export const BASH_FRICTION_WINDOW_SIZE = 5;

// Bash 摩擦检测失败阈值：窗口内失败次数达到此值时触发提示。
export const BASH_FRICTION_FAILURE_THRESHOLD = 2;

// 回看窗口大小：检查当前 Node 成功调用之前最近多少次工具调用中是否存在失败的 Bash。
export const FAILED_BASH_WINDOW_SIZE = 5;
