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

// Dynobox 沙箱把宿主磁盘镜像为虚拟卷根下的单字母目录（Z:\C\foo ↔ 宿主 C:\foo）。
// 沙箱内命令的产物路径是虚拟视图，任务结束后卷已卸载，直接点击无法跳转。
// 沙箱卷固定挂载在 Z: 盘，因此只改写 Z: 开头的路径。
const SANDBOX_VIRTUAL_PATH_RE = /^(?:[Zz]):[/\\]([A-Za-z])([/\\].*)?$/;

/**
 * 将沙箱虚拟路径还原为宿主真实路径："Z:\C\Users\a.txt" → "C:\Users\a.txt"。
 * 仅当路径形如 "Z:<sep><单个盘符字母><sep...>" 时改写（第二段必须是单独的
 * 盘符字母），避免误伤宿主机上真实存在的 "Z:\CORS\..." 之类目录。
 * 纯字符串处理，无 IO；非沙箱路径原样返回。
 */
export function sandboxPathToHostPath(filePath: string): string {
    const match = SANDBOX_VIRTUAL_PATH_RE.exec(filePath);
    if (!match) return filePath;
    const rest = match[2] ? match[2].slice(1) : '';
    return `${match[1].toUpperCase()}:\\${rest}`;
}
