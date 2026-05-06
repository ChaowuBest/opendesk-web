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
