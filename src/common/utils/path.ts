/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

// POSIX 语境下 Windows 盘符路径常被误写为 "/C:/foo/bar"（前导斜杠 + 盘符），
// 该形式在 Windows 上会被解析为"当前盘根目录下的 C: 目录"，导致存在性检查误报。
const DRIVE_ROOT_RE = /^\/([A-Za-z]:)[/\\]/;

/**
 * 规范化 POSIX 风格的 Windows 盘符根路径："/C:/foo" → "C:/foo"（大小写盘符均可）。
 * 其余路径（含常规 POSIX 绝对路径）原样返回；纯字符串处理，无 IO。
 */
export function normalizeDriveRootPath(filePath: string): string {
    return DRIVE_ROOT_RE.test(filePath) ? filePath.slice(1) : filePath;
}
