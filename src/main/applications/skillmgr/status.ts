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

/** 文件不存在时缓存条目的 mtime 占位值 */
const MTIME_NOT_EXIST = -1;

interface StatusCache {
    /** 缓存对应的文件路径：数据目录可在运行期切换（CLI --config-directory 等），路径变化即失效 */
    path: string;
    data: Record<string, boolean>;
    mtimeMs: number;
}

/**
 * status.json 为低频变更配置，但 skill filter 会对每个 skill 高频求值
 * （如 getUserInvocableSkills 遍历技能列表），故按 mtime 缓存读取结果：
 * 未变更时仅一次 statSync，写入路径直更缓存避免回读。
 */
let statusCache: StatusCache | null = null;

function getStatusFilePath(): string {
    const skillsDir = skillRegistry.getSkillsDirectory();
    return path.join(path.dirname(skillsDir), STATUS_FILENAME);
}

function readStatus(): Record<string, boolean> {
    const filePath = getStatusFilePath();
    try {
        const stat = fs.statSync(filePath);
        if (statusCache && statusCache.path === filePath && statusCache.mtimeMs === stat.mtimeMs) {
            return statusCache.data;
        }
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        statusCache = { path: filePath, data, mtimeMs: stat.mtimeMs };
        return data;
    } catch {
        // 文件不存在或损坏均按空状态处理（与既有行为一致），并缓存避免反复读失败文件
        if (statusCache && statusCache.path === filePath && statusCache.mtimeMs === MTIME_NOT_EXIST) {
            return statusCache.data;
        }
        statusCache = { path: filePath, data: {}, mtimeMs: MTIME_NOT_EXIST };
        return statusCache.data;
    }
}

function writeStatus(status: Record<string, boolean>): void {
    const filePath = getStatusFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(status, null, 2), 'utf8');
    // 写后以写出的数据直更缓存，mtime 取真实值，保证后续读取不回读也不拿过期数据
    try {
        statusCache = { path: filePath, data: status, mtimeMs: fs.statSync(filePath).mtimeMs };
    } catch {
        statusCache = null;
    }
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
    // 基于拷贝修改：写入失败时不得污染缓存，保持缓存与磁盘内容一致
    const status = { ...readStatus() };
    status[skillId] = enabled;
    writeStatus(status);
}

/**
 * 获取所有状态记录
 */
export function getAllStatuses(): Record<string, boolean> {
    return { ...readStatus() };
}

/**
 * 为技能设置默认启用状态。
 * 仅在记录尚不存在时写入——避免覆盖用户手动设置的值。
 * @param skillId 技能 ID
 * @param enabled 默认是否启用
 */
export function setDefaultStatus(skillId: string, enabled: boolean): void {
    const status = readStatus();
    if (skillId in status) return;
    writeStatus({ ...status, [skillId]: enabled });
}

/**
 * 移除技能的状态记录（在删除技能时调用）
 */
export function removeSkillStatus(skillId: string): void {
    const status = readStatus();
    if (!(skillId in status)) return;
    const next = { ...status };
    delete next[skillId];
    writeStatus(next);
}

/**
 * 将技能 ID 列表中的技能默认设置为禁用（批量导入时使用）。
 * 仅在记录尚不存在时写入。
 */
export function setBatchDefaultDisabled(skillIds: string[]): void {
    const status = readStatus();
    const additions: Record<string, boolean> = {};
    for (const id of skillIds) {
        if (!(id in status)) {
            additions[id] = false;
        }
    }
    if (Object.keys(additions).length > 0) {
        writeStatus({ ...status, ...additions });
    }
}
