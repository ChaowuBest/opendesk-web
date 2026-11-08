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

import path from 'node:path';

/**
 * 归一化回收站排除清单（各平台沙箱 --trash-exclude 的公共入口）。
 *
 * 过滤空条目与相对路径并去重。原生层对脏条目是"全有或全无"的失败模式：
 * dynobox 遇到非绝对路径直接以退出码 2 拒绝启动（整条沙箱命令起不来），
 * Windows 则是原样拼进清单（永不命中的死条目）。宿主侧先粗筛掉这些条目，
 * 只会缩小排除面（更多删除进回收站），不会造成误删。
 *
 * 绝对路径判定同时接受 POSIX 与 Win32 形态：清单里既有各平台原生目录，
 * 也有宿主统一传入的跨平台目录（如 /tmp），按宿主平台单侧判定会把另一侧
 * 形态误删，也会让单测在不同宿主上结果不一致。
 */
export function normalizeTrashExcludeDirs(dirs?: readonly string[]): string[] {
    const result: string[] = [];
    for (const raw of dirs ?? []) {
        const dir = raw.trim();
        if (!dir || !(path.posix.isAbsolute(dir) || path.win32.isAbsolute(dir))) continue;
        if (!result.includes(dir)) result.push(dir);
    }
    return result;
}
