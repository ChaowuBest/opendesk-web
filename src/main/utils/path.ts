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
import { cleanPathInput, fromMsysPath } from '../../utils/path.js';
import { getHomeDir } from './temp.js';

/**
 * 本地文件路径规范化，filemgr / devicemgr / adminconsole 等工具共用同一口径，
 * 保证 getDeclaredPermissions 声明的路径与执行时实际读写的路径一致、权限规则可匹配：
 * - 清理不可见 Unicode 字符与首尾空白，并把被 JSON 转义序列污染的控制字符
 *   （\b \t \n \f \r，常见于 Windows 路径经模型 JSON 输出后的损坏）还原为反斜杠字母组合；
 * - 展开 ~ 为用户主目录；
 * - Windows 下转换 MSYS2/Git Bash 风格路径，避免 path.resolve 产生双重前缀；
 * - 相对路径按 basePath（通常为任务工作区）解析为绝对路径；
 * - 统一正斜杠并折叠连续斜杠（保留 UNC 的 // 与协议前缀 ://）。
 * 空或非法输入返回空字符串。
 */
export function sanitizeLocalPath(inputPath: string | undefined, basePath?: string): string {
    if (!inputPath || typeof inputPath !== 'string') return '';

    let p = cleanPathInput(inputPath)
        .replace(/\x08/g, '\\b')
        .replace(/\x09/g, '\\t')
        .replace(/\x0A/g, '\\n')
        .replace(/\x0C/g, '\\f')
        .replace(/\x0D/g, '\\r');

    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
        p = getHomeDir() + p.slice(1);
    }

    p = fromMsysPath(p);

    p = basePath ? path.resolve(basePath, p) : path.resolve(p);

    p = p.replace(/\\/g, '/');

    p = p.replace(/(?<!:)\/{2,}/g, '/');

    return p;
}
