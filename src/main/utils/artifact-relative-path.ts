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
 * 任务产物相对路径（`artifacts/<taskId>/<子目录>/<文件>`，相对 OpenDesk 数据根目录）
 * 的安全形状校验。
 *
 * 该值随任务 JSON 持久化，可被恶意导入包构造成 `..` 穿越或绝对路径，指向数据根之外
 * 的本机文件；所有按此值读盘的路径（模型图片回灌、artifact 存在性探测等）都必须先
 * 通过本校验。校验按段进行而非 path.resolve 前缀比较，以同时兼容 Windows 反斜杠
 * 存储值与跨平台导入：
 * - 段 0 必须是 `artifacts`（绝对路径如 `/etc`、`C:\x` 的首段不满足，天然拒绝）；
 * - 段 1 必须是合法任务 id（`[a-zA-Z0-9_-]{1,128}`）；
 * - 其余段 ≥1 且匹配 `[A-Za-z0-9][A-Za-z0-9._-]*`——首字符必须为字母数字，
 *   天然拒绝 `..`、`.` 开头的隐藏文件与空段；
 * - subdir 指定时段 2 必须等于它（如 images / tool-results / session-memory）。
 */
const ARTIFACT_TASK_ID_SEGMENT = /^[a-zA-Z0-9_-]{1,128}$/;
const ARTIFACT_NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Win32 对文件名有额外归一化：保留设备名（CON/PRN/NUL/AUX/COM1-9/LPT1-9，带扩展名
 * 的形式同样命中）即使带路径前缀也会被解析为设备；段尾的 `.` 与空格会被静默剥离，
 * 造成"写入 a. 得到 a"的碰撞。产物文件由本应用生成时不会出现这类名字，但导入包
 * 的条目名不可信，写入前必须拒绝。
 */
const RESERVED_WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function isForbiddenWindowsFileName(segment: string): boolean {
    return RESERVED_WINDOWS_DEVICE_NAME.test(segment) || /[. ]$/.test(segment);
}

export type ArtifactRelativePathSubdir = 'images' | 'tool-results' | 'session-memory';

export function isSafeArtifactRelativePath(value: unknown, subdir?: ArtifactRelativePathSubdir): boolean {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
        return false;
    }
    const segments = value.split(/[\\/]/);
    if (segments[0] !== 'artifacts' || segments.length < 3) {
        return false;
    }
    if (!ARTIFACT_TASK_ID_SEGMENT.test(segments[1])) {
        return false;
    }
    if (subdir !== undefined && segments[2] !== subdir) {
        return false;
    }
    return segments
        .slice(2)
        .every((segment) => ARTIFACT_NAME_SEGMENT.test(segment) && !isForbiddenWindowsFileName(segment));
}
