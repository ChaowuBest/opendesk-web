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

/**
 * 将文件路径统一规范化为正斜杠形式，供渲染层内部比较/拼接使用：
 *  - 去除历史消息遗留的 "/C:/..." 盘符前缀斜杠
 *  - Windows 反斜杠 → 正斜杠（"D:\a\b.ts" → "D:/a/b.ts"）
 * 纯字符串处理，无 IO。
 */
export function normalizeExplorerFilePath(filePath: string): string {
    return normalizeDriveRootPath(filePath).replace(/\\/g, '/');
}

/**
 * 跨平台判定两个文件路径是否指向同一文件。
 * Windows / macOS 默认使用大小写不敏感的文件系统（APFS/NTFS），而对话点击、
 * 工作空间列表等来源的路径大小写可能不一致；直接 === 比较会把同一文件
 * 判为不同，导致树/网格高亮与面包屑选中态失效。统一先规范化分隔符，
 * 再做大小写不敏感的决策（该函数仅用于 UI 展示态匹配，不参与真实 IO）。
 */
export function explorerPathsEqual(a: string, b: string): boolean {
    return normalizeExplorerFilePath(a).toLowerCase() === normalizeExplorerFilePath(b).toLowerCase();
}

/**
 * 跨平台判定 filePath 是否位于 root 目录（或其子目录）之下。
 * 与 explorerPathsEqual 同理：大小写不敏感 + 分隔符归一，避免 Windows 上
 * "位于工作空间内"被误判为"在工作空间外"，导致分级导航退化为单段。
 * 纯字符串处理，无 IO。
 */
export function isPathUnder(filePath: string, root: string): boolean {
    const normalizedFile = normalizeExplorerFilePath(filePath);
    const normalizedRoot = normalizeExplorerFilePath(root);
    if (!normalizedRoot) return true;
    const lowerFile = normalizedFile.toLowerCase();
    const lowerRoot = normalizedRoot.toLowerCase();
    return lowerFile === lowerRoot || lowerFile.startsWith(lowerRoot + '/');
}

/**
 * 返回路径的父目录（正斜杠形式）。根级路径（无分隔符或盘符根）返回自身。
 * 兼容反斜杠输入，统一输出正斜杠，避免旧实现只在 "/" 上切分导致
 * Windows 路径被误当成"无父目录"而返回文件自身。
 */
export function parentDirPath(p: string): string {
    const normalized = p.replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0) return normalized;
    return normalized.slice(0, idx);
}

export interface BreadcrumbSegment {
    name: string;
    dir: string;
}

/**
 * 为文件路径构建分级导航面包屑分段（供编辑器/预览头部展示与点击展开）。
 * 输入兼容正斜杠与 Windows 反斜杠绝对路径；内部统一规范化为正斜杠后，
 * 再按"是否位于 workspaceRoot 下"决定：
 *  - 位于 workspace 下：输出从 workspace 根到文件的完整分级，每段 dir 为
 *    对应目录（最后一段即文件所在目录）；
 *  - 不位于 workspace 下：退化为单段（文件名 + 父目录），保证点击后
 *    展开的是父目录而不是把文件自身当目录去扫描（ENOTDIR 的根因）。
 * 纯字符串处理，无 IO。
 */
export function buildFileBreadcrumbSegments(filePath: string, workspaceRoot: string | null): BreadcrumbSegment[] {
    const file = normalizeExplorerFilePath(filePath);
    const root = workspaceRoot ? normalizeExplorerFilePath(workspaceRoot) : '';

    const segments: BreadcrumbSegment[] = [];
    if (root && isPathUnder(file, root)) {
        const relPath = file.slice(root.length + 1);
        const parts = relPath.split('/');
        let currentDir = root;
        for (let i = 0; i < parts.length; i++) {
            const isLast = i === parts.length - 1;
            if (!isLast) {
                currentDir = currentDir + '/' + parts[i];
                segments.push({ name: parts[i], dir: currentDir });
            } else {
                segments.push({ name: parts[i], dir: currentDir });
            }
        }
    } else {
        segments.push({ name: file.split('/').pop() || file, dir: parentDirPath(file) });
    }
    return segments;
}
