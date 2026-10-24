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

/** 任务名最大长度（按 Unicode 码点计），超过则截断并追加省略号 */
export const TASK_NAME_MAX_LENGTH = 30;

/**
 * 将候选任务名折叠空白并截断到统一长度。
 *
 * - 连续空白折叠为单个空格，首尾裁剪，避免任务名在列表中折行显示
 * - 按 Unicode 码点截断，避免把 emoji 等代理对截半产生乱码
 * - 发生截断时追加 "..." 省略号
 */
export function truncateTaskName(text: string): string {
    const compact = text.replace(/\s+/g, ' ').trim();
    if (Array.from(compact).length <= TASK_NAME_MAX_LENGTH) {
        return compact;
    }
    const truncated = Array.from(compact).slice(0, TASK_NAME_MAX_LENGTH).join('').trimEnd();
    return `${truncated}...`;
}
