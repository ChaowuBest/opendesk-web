/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * 将原生沙箱 ask 请求中的卷内路径（"/C/Users/a.txt"）还原为宿主真实路径
 * （"C:/Users/a.txt"）。不合法（非单字母卷段、含遍历段、控制字符等）时返回
 * null，调用方按 deny 处理（fail-closed）。
 */
export function virtualPathToHostPath(value: string): string | null {
    const normalized = value.replace(/\\/g, '/');
    const drive = /^\/([A-Za-z])(?:\/(.*))?$/.exec(normalized);
    if (
        !drive ||
        /[:*?"<>|]/.test(drive[2] || '') ||
        [...value].some((char) => char.charCodeAt(0) < 32) ||
        (drive[2] || '').split('/').some((part) => part === '.' || part === '..')
    )
        return null;
    return `${drive[1].toUpperCase()}:/${drive[2] || ''}`;
}
