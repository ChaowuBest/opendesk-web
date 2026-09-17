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
 * 将路径中的反斜杠统一为正斜杠，并剥离换行符以防注入。
 * picomatch ** 不匹配含 Unicode 行/段分隔符 U+2028/U+2029 的路径，这里一并截断。
 */
export function normalizePath(p: string): string {
    if (!p) return '';
    const newlineIdx = p.search(/[\r\n\u2028\u2029]/);
    if (newlineIdx !== -1) {
        p = p.slice(0, newlineIdx);
    }
    return p.replace(/\\/g, '/');
}

/**
 * 将 MSYS2/Git Bash 风格的路径（如 /c/Projects/...）转换为 Windows 原生路径（如 C:/Projects/...）。
 * 非 Windows 平台原样返回。
 */
export function fromMsysPath(p: string): string {
    if (process.platform !== 'win32') return p;
    return p.replace(/^\/([a-zA-Z])\//, (_, letter: string) => `${letter.toUpperCase()}:/`);
}

/**
 * 获取当前用户的家目录路径。
 * 支持多个平台：
 * - Windows: 优先使用 USERPROFILE，回退到 HOME
 * - macOS/Linux: 使用 HOME 环境变量
 * - OpenHarmony: 使用 USER_DATA_PATH 环境变量
 *
 * @returns 家目录路径，如果无法确定则返回空字符串
 */
export function getHomePath(): string {
    // OpenHarmony 平台优先使用 USER_DATA_PATH
    if ((process.platform as string) === 'openharmony' && process.env.USER_DATA_PATH) {
        return process.env.USER_DATA_PATH;
    }

    // Windows 平台
    if (process.platform === 'win32') {
        return process.env.USERPROFILE || process.env.HOME || '';
    }

    // macOS/Linux 等其他平台
    return process.env.HOME || '';
}

/**
 * 展开 POSIX 风格的家目录前缀（~、~/、~\）为实际家目录路径。
 * 仅处理位于路径开头的 ~；~user 形式无法跨平台解析，保持原样。
 * 家目录无法确定时返回原路径，交由调用方按既有逻辑处理。
 */
export function expandTilde(p: string): string {
    if (!p || (p !== '~' && !p.startsWith('~/') && !p.startsWith('~\\'))) return p;
    const home = getHomePath();
    if (!home) return p;
    return home + p.slice(1);
}

/**
 * 清理路径中的不可见 Unicode 字符和前导/尾随空白。
 *
 * 这些不可见字符会导致 path.isAbsolute() 误判绝对路径为相对路径，
 * 进而使 path.resolve(workspace, inputPath) 产生错误的拼接结果。
 *
 * 常见来源：从网页、PDF 等复制粘贴路径时携带的零宽空格、BOM、前导空格等。
 */
export function cleanPathInput(rawPath: string): string {
    if (!rawPath || typeof rawPath !== 'string') return '';

    return rawPath
        .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '') // 零宽字符、BOM、词连接符
        .replace(/\u00AD/g, '') // 软连字符
        .replace(/\p{Cf}/gu, '') // 所有 Unicode Format 类别的控制字符
        .trim();
}
