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

/**
 * 把 `catch` 到的 unknown 值转成可读的错误消息。
 *
 * 只取 message 不取 stack：本函数用于面向用户的提示与日志摘要，
 * 需要完整堆栈时请在调用点自行判断 `instanceof Error` 后取 `stack`。
 */
export function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
