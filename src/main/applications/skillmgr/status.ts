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
 * 技能激活状态管理器
 * 将每个技能的启用/禁用状态持久化到 status.json
 * 位于 skillmgr 应用目录下：{userDataPath}/apps/skills/status.json
 */

import path from 'path';
import fs from 'fs';
import { skillRegistry } from './utils/skill-registry.js';

const STATUS_FILENAME = 'status.json';

function getStatusFilePath(): string {
    const skillsDir = skillRegistry.getSkillsDirectory();
    return path.join(path.dirname(skillsDir), STATUS_FILENAME);
}

function readStatus(): Record<string, boolean> {
    const filePath = getStatusFilePath();
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(raw);
        }
    } catch {
        // 文件损坏则重建
    }
    return {};
}

function writeStatus(status: Record<string, boolean>): void {
    const filePath = getStatusFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(status, null, 2), 'utf8');
}

/**
 * 获取单个技能的启用状态。如果 status.json 中没有记录，默认返回 true（启用）
 */
export function getSkillStatus(skillId: string): boolean {
    const status = readStatus();
    return status[skillId] !== false;
}

/**
 * 设置单个技能的启用状态
 */
export function setSkillStatus(skillId: string, enabled: boolean): void {
    const status = readStatus();
    status[skillId] = enabled;
    writeStatus(status);
}

/**
 * 批量设置多个技能的启用状态（一次读写 status.json）
 */
export function setSkillsStatus(skillIds: string[], enabled: boolean): void {
    const status = readStatus();
    for (const skillId of skillIds) {
        status[skillId] = enabled;
    }
    writeStatus(status);
}

/**
 * 获取所有状态记录
 */
export function getAllStatuses(): Record<string, boolean> {
    return readStatus();
}

/**
 * 为技能设置默认启用状态。
 * 仅在记录尚不存在时写入——避免覆盖用户手动设置的值。
 * @param skillId 技能 ID
 * @param enabled 默认是否启用
 */
export function setDefaultStatus(skillId: string, enabled: boolean): void {
    const status = readStatus();
    if (!(skillId in status)) {
        status[skillId] = enabled;
        writeStatus(status);
    }
}

/**
 * 移除技能的状态记录（在删除技能时调用）
 */
export function removeSkillStatus(skillId: string): void {
    const status = readStatus();
    if (skillId in status) {
        delete status[skillId];
        writeStatus(status);
    }
}

/**
 * 将技能 ID 列表中的技能默认设置为禁用（批量导入时使用）。
 * 仅在记录尚不存在时写入。
 */
export function setBatchDefaultDisabled(skillIds: string[]): void {
    const status = readStatus();
    let changed = false;
    for (const id of skillIds) {
        if (!(id in status)) {
            status[id] = false;
            changed = true;
        }
    }
    if (changed) {
        writeStatus(status);
    }
}
