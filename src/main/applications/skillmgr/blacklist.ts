/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * 恶意技能黑名单管理器
 * 将用户确认拉黑的 skill 持久化到 blacklist.json
 * 位于 skillmgr 应用目录下：{userDataPath}/apps/skills/blacklist.json
 */

import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { skillRegistry } from './utils/skill-registry.js';

export interface BlacklistEntry {
    /** 拉黑原因（从拦截记录中提取的恶意行为描述） */
    reason: string;
    /** 拉黑时间 ISO string */
    blockedAt: string;
    /** 证据摘要（来自 LLM 归因或手动确认） */
    evidence: string;
}

type Blacklist = Record<string, BlacklistEntry>;

const BLACKLIST_FILENAME = 'blacklist.json';

/** 文件不存在时缓存条目的 mtime 占位值 */
const MTIME_NOT_EXIST = -1;

interface BlacklistCache {
    /** 缓存对应的文件路径：数据目录可在运行期切换（CLI --config-directory 等），路径变化即失效 */
    path: string;
    data: Blacklist;
    mtimeMs: number;
}

/**
 * blacklist.json 为低频变更配置，但黑名单 filter 会对每个 skill 高频求值
 * （如 getUserInvocableSkills 遍历技能列表），故按 mtime 缓存读取结果：
 * 未变更时仅一次 statSync，写入路径直更缓存避免回读。
 */
let blacklistCache: BlacklistCache | null = null;

function getBlacklistFilePath(): string {
    const skillsDir = skillRegistry.getSkillsDirectory();
    return path.join(path.dirname(skillsDir), BLACKLIST_FILENAME);
}

function readBlacklist(): Blacklist {
    const filePath = getBlacklistFilePath();
    try {
        const stat = fs.statSync(filePath);
        if (blacklistCache && blacklistCache.path === filePath && blacklistCache.mtimeMs === stat.mtimeMs) {
            return blacklistCache.data;
        }
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        blacklistCache = { path: filePath, data, mtimeMs: stat.mtimeMs };
        return data;
    } catch {
        // 文件不存在或损坏均按空黑名单处理（与既有行为一致），并缓存避免反复读失败文件
        if (blacklistCache && blacklistCache.path === filePath && blacklistCache.mtimeMs === MTIME_NOT_EXIST) {
            return blacklistCache.data;
        }
        blacklistCache = { path: filePath, data: {}, mtimeMs: MTIME_NOT_EXIST };
        return blacklistCache.data;
    }
}

function writeBlacklist(blacklist: Blacklist): void {
    const filePath = getBlacklistFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(blacklist, null, 2), 'utf8');
    // 写后以写出的数据直更缓存，mtime 取真实值，保证后续读取不回读也不拿过期数据
    try {
        blacklistCache = { path: filePath, data: blacklist, mtimeMs: fs.statSync(filePath).mtimeMs };
    } catch {
        blacklistCache = null;
    }
}

/**
 * 检查 skill 是否在黑名单中（key = `${bundleName}/${skillName}`）
 */
export function isBlacklisted(bundleName: string, skillName: string): boolean {
    const key = `${bundleName}/${skillName}`;
    const blacklist = readBlacklist();
    return key in blacklist;
}

/**
 * 仅按 skillName 检查是否在黑名单中（忽略 bundleName）。
 * 用于 agent 传入的 bundleName 不可靠（如把 skill 名误当 bundleName）时的兜底匹配：
 * 遍历黑名单 key，匹配结尾为 `/${skillName}` 的条目。
 * skillmgr 安装的 skill name 不含 `/`，故 `/${skillName}$` 锚定足够安全。
 */
export function isSkillNameBlacklisted(skillName: string): boolean {
    if (!skillName) return false;
    const blacklist = readBlacklist();
    const suffix = `/${skillName}`;
    for (const key of Object.keys(blacklist)) {
        if (key === skillName || key.endsWith(suffix)) return true;
    }
    return false;
}

/**
 * 判断 skill 是否为用户安装的技能（非系统内置）。
 * 用户安装的 skill 落在 getSkillsDirectory() 下，子目录名 = skillName；
 * 内置技能在各 application bundle 的资源目录里，不在用户技能目录下。
 * 拉黑内置技能会禁用正常功能，故仅允许拉黑用户安装的技能。
 */
export function isUserInstalledSkill(skillName: string): boolean {
    if (!skillName) return false;
    try {
        const userDir = path.join(skillRegistry.getSkillsDirectory(), skillName);
        return fs.existsSync(userDir);
    } catch {
        return false;
    }
}

/**
 * 将 skill 加入黑名单
 *
 * 内置技能（非用户安装）一律忽略——拉黑内置技能会禁用正常功能，
 * 且归因误判内置技能为恶意驱动者时不应生效。
 */
export function addToBlacklist(bundleName: string, skillName: string, reason: string, evidence: string): void {
    if (!isUserInstalledSkill(skillName)) {
        // 内置/外部技能，忽略拉黑请求
        return;
    }
    const key = `${bundleName}/${skillName}`;
    // 基于拷贝修改：写入失败时不得污染缓存，保持缓存与磁盘内容一致
    const blacklist = { ...readBlacklist() };
    blacklist[key] = {
        reason,
        blockedAt: new Date().toISOString(),
        evidence
    };
    writeBlacklist(blacklist);
}

/**
 * 将 skill 移出黑名单
 */
export function removeFromBlacklist(bundleName: string, skillName: string): void {
    const key = `${bundleName}/${skillName}`;
    const blacklist = readBlacklist();
    if (!(key in blacklist)) return;
    // 基于拷贝修改：写入失败时不得污染缓存，保持缓存与磁盘内容一致
    const next = { ...blacklist };
    delete next[key];
    writeBlacklist(next);
}

/**
 * 获取所有黑名单记录
 */
export function getAllBlacklisted(): Blacklist {
    return { ...readBlacklist() };
}

/**
 * 获取所有黑名单 skill 的源文件目录绝对路径集合。
 * skillmgr 安装的 skill 目录名 = skill name（见 utils.ts: targetDir = path.resolve(skillsDir, safeName)），
 * 故黑名单 key `bundleName/skillName` 取 skillName 部分，拼 `getSkillsDirectory()/<skillName>`。
 * 供安全网关在文件工具（readFile/find/grep）调用时比对——命中即拦截，防止 agent 直读源文件绕过黑名单。
 * 返回 resolve 后的绝对路径数组，无黑名单时返回空数组。
 */
export function getBlacklistedSkillDirectories(): string[] {
    const blacklist = readBlacklist();
    const skillsDir = skillRegistry.getSkillsDirectory();
    const dirs: string[] = [];
    for (const key of Object.keys(blacklist)) {
        // key 形如 `bundleName/skillName`；skillmgr 安装的 skill name 不含 `/`，取最后一段
        const skillName = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
        if (skillName) {
            dirs.push(path.resolve(skillsDir, skillName));
        }
    }
    return dirs;
}

/**
 * 获取拦截记录目录路径
 */
export function getInterceptionsDirectory(): string {
    const skillsDir = skillRegistry.getSkillsDirectory();
    const interceptionsDir = path.join(path.dirname(skillsDir), 'interceptions');
    return interceptionsDir;
}

export interface InterceptionRecord {
    /** 记录唯一 ID：异步归因据此定位本次记录，避免依赖数组下标 */
    recordId: string;
    /** 被拦 tool call 的工具名 */
    toolName: string;
    /** 被拦命令/内容摘要 */
    command: string;
    /** 拦截原因 */
    reason: string;
    /** 风险等级 */
    riskLevel: string;
    /** 风险类型（analysis_timeout / service_unavailable / 真实恶意类型等） */
    riskType: string;
    /** AgentMoss 命中的违规层（L1.1/L1.2/L2.1/L2.2/L2.3/L3.1 + brain_L1/brain_L2），按真实执行顺序 */
    violatedLayers?: string[];
    /** 安全级别 */
    securityLevel: string;
    /** 拦截发生时的 turn 号 */
    turn: number;
    /** 确定性归因的 skill（CallSkillTool 路径） */
    certain?: Array<{ bundleName: string; skillName: string }>;
    /** 弱关联疑似 skill（本 turn 加载的其余 skill） */
    suspected?: Array<{
        bundleName: string;
        skillName: string;
        confidence: 'high' | 'medium' | 'low';
        evidence: string;
    }>;
    /** LLM 归因是否已完成 */
    attributed: boolean;
}

/**
 * 保存拦截记录到本地 interceptions/<task_id>.json
 *
 * 返回该条记录的 recordId：调用方（如异步 LLM 归因）后续按 ID 更新自己的记录，
 * 不能依赖数组下标——同任务二次拦截会追加到末尾，下标 0 永远指向第一条。
 */
export function saveInterceptionRecord(taskId: string, record: Omit<InterceptionRecord, 'recordId'>): string {
    const dir = getInterceptionsDirectory();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, `${taskId}.json`);
    let records: InterceptionRecord[] = [];
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            records = JSON.parse(raw);
        }
    } catch {
        // 文件损坏则重建
    }
    const recordId = randomUUID();
    records.push({ ...record, recordId });
    fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
    return recordId;
}

/**
 * 读取指定任务的拦截记录
 */
export function readInterceptionRecords(taskId: string): InterceptionRecord[] {
    const dir = getInterceptionsDirectory();
    const filePath = path.join(dir, `${taskId}.json`);
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(raw);
        }
    } catch {
        // 文件损坏返回空
    }
    return [];
}

/**
 * 更新拦截记录中的 attribution 结果（按 saveInterceptionRecord 返回的 recordId 定位）
 */
export function updateInterceptionAttribution(
    taskId: string,
    recordId: string,
    certain: Array<{ bundleName: string; skillName: string }>,
    suspected: Array<{
        bundleName: string;
        skillName: string;
        confidence: 'high' | 'medium' | 'low';
        evidence: string;
    }>
): void {
    const filePath = path.join(getInterceptionsDirectory(), `${taskId}.json`);
    try {
        if (!fs.existsSync(filePath)) return;
        const raw = fs.readFileSync(filePath, 'utf8');
        const records: InterceptionRecord[] = JSON.parse(raw);
        const target = records.find((r) => r.recordId === recordId);
        if (target) {
            target.certain = certain;
            target.suspected = suspected;
            target.attributed = true;
            fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
        }
    } catch {
        // 忽略写入失败
    }
}

/**
 * 清除任务的拦截记录（拉黑后清除本地记录）
 */
export function clearInterceptionRecords(taskId: string): void {
    const filePath = path.join(getInterceptionsDirectory(), `${taskId}.json`);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch {
        // 忽略删除失败
    }
}

/**
 * 清除全部拦截记录（存储超限后一键清理，与 AgentGate tool_calls 清空联动）。
 * 返回删除的文件数。
 */
export function clearAllInterceptionRecords(): number {
    const dir = getInterceptionsDirectory();
    if (!fs.existsSync(dir)) return 0;
    let removed = 0;
    try {
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.json')) continue;
            try {
                fs.unlinkSync(path.join(dir, file));
                removed++;
            } catch {
                // 单个文件删除失败跳过，不影响其余
            }
        }
    } catch {
        // 目录不可读，返回已删除数
    }
    return removed;
}
