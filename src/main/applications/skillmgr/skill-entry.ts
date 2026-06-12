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
 * Agent Skills 入口文件发现策略。
 *
 * 规范要求（agentskills.io）入口文件名为 SKILL.md。
 * 市场实际存在多种变体：
 *   - skill.md（小写）
 *   - skills.md（复数）
 *   - SKILLS.md（全大写复数）
 *
 * 此模块提供统一的 case-insensitive 匹配，供 worker（扫描）和 utils（加载/安装）共同引用。
 */

import fs from 'fs';
import path from 'path';

/** 安装后统一规范化为该文件名 */
export const CANONICAL_SKILL_FILENAME = 'SKILL.md';

/** 市场已知的非规范入口文件名变体（均为小写，用于 case-insensitive 匹配） */
const ENTRY_FILENAME_ALIASES: ReadonlySet<string> = new Set(['skill.md', 'skills.md']);

/**
 * 判断文件名是否属于技能入口文件（case-insensitive）。
 */
export function isSkillEntryFilename(name: string): boolean {
    return ENTRY_FILENAME_ALIASES.has(path.basename(name).toLowerCase());
}

/**
 * 在指定目录中查找技能入口文件（SKILL.md 及其已知变体）。
 * 优先返回规范名 SKILL.md；否则返回第一个匹配的非规范变体；找不到返回 null。
 */
export function findSkillEntryFile(dirPath: string): string | null {
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const canonical = entries.find((e) => e.isFile() && e.name === CANONICAL_SKILL_FILENAME);
        if (canonical) return path.join(dirPath, canonical.name);

        const alias = entries.find((e) => e.isFile() && ENTRY_FILENAME_ALIASES.has(e.name.toLowerCase()));
        if (alias) return path.join(dirPath, alias.name);
    } catch {
        // permission errors or non-existent dir
    }
    return null;
}
