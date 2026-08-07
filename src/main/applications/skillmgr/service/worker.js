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
 * Skills 应用 Worker：在 Worker 线程中执行 list/refresh/getSkillsDirectory/addFromDirectory/addFromZip/addFromUrl/delete/searchRegistry/installFromRegistry。
 * 来源解析与下载解压逻辑集中在 utils，由 SkillRegistry 仅负责目录安装。
 * 写操作完成后通过 skillsRegistryChanged 通知主进程同步 SkillRegistry（主进程 getToolsets 依赖之）。
 */

import { parentPort } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { BaseWorker } from '../../base.js';
import { NotificationManager } from '../../../utils/notificationmgr.js';
import { skillRegistry } from '../utils/skill-registry.js';
import { skillInstallManager } from '../utils/skill-installer.js';
import { isSkillEntryFilename, findSkillEntryFile } from '../skill-entry.js';
import {
    getSkillStatus,
    setSkillStatus,
    getAllStatuses,
    setDefaultStatus,
    removeSkillStatus,
    setBatchDefaultDisabled
} from '../status.js';
import { getAllBlacklisted, removeFromBlacklist } from '../blacklist.js';

function notifyMainSync() {
    parentPort?.postMessage({ type: 'skillsRegistryChanged' });
}

class SkillsWorker extends BaseWorker {
    constructor(bundleName, appDataDirectory) {
        super(bundleName, appDataDirectory);
    }

    async initialize() {
        // 可选：在 Worker 内预加载技能列表，与主进程无强依赖
    }

    async applicationConfigChanged(config) {
        await super.applicationConfigChanged(config || {});
        skillRegistry.setRuntimeConfig(config);
        skillRegistry.refresh();
    }

    list() {
        const skills = skillRegistry.listSkills();
        const statuses = getAllStatuses();
        const allBlacklisted = getAllBlacklisted();
        return skills.map((s) => {
            // skillmgr 安装的技能 id 即 SKILL.md frontmatter.name（无 bundle 前缀），
            // 而黑名单 key 形如 `${bundleName}/${skillName}`，写入侧 bundleName 固定为 'skillmgr'。
            // 直接拼出黑名单 key 查表，避免 split 导致 bundleName/skillName 错位。
            const blacklistKey = `skillmgr/${s.id}`;
            const blEntry = allBlacklisted[blacklistKey] ?? null;
            const bl = blEntry !== null;
            return {
                ...s,
                readonly: s.source === 'config',
                enabled: statuses[s.id] !== false && !bl,
                blacklisted: bl,
                blacklistEvidence: blEntry?.evidence || '',
                blacklistReason: blEntry?.reason || '',
                blockedAt: blEntry?.blockedAt || ''
            };
        });
    }

    refresh() {
        const { toolsets, errors } = skillRegistry.refresh();
        return { count: toolsets.length, errors };
    }

    getSkillsDirectory() {
        return skillRegistry.getSkillsDirectory();
    }

    async addFromDirectory(sourceDirectory) {
        const result = await skillInstallManager.installFromDirectory(sourceDirectory);
        if (!result.success) throw new Error(result.error);
        setDefaultStatus(result.name, true);
        notifyMainSync();
        return { name: result.name };
    }

    async addFromZip(zipPath, skillRelPath) {
        const result = await skillInstallManager.installFromLocalZip(zipPath, skillRelPath);
        if (!result.success) throw new Error(result.error);
        setDefaultStatus(result.name, true);
        notifyMainSync();
        return { name: result.name };
    }

    async addFromUrl(url) {
        const result = await skillInstallManager.installFromUrl(url);
        if (!result.success) throw new Error(result.error);
        setDefaultStatus(result.name, true);
        notifyMainSync();
        return { name: result.name };
    }

    delete(skillId) {
        const result = skillInstallManager.deleteSkill(skillId);
        // 技能目录已不存在视为删除成功（可能已被批量删除或来自外部挂载）
        if (!result.success && !(result.error && result.error.includes('不存在'))) {
            throw new Error(result.error);
        }
        removeSkillStatus(skillId);
        notifyMainSync();
    }

    /**
     * 流式批量删除技能，每删一个 yield 进度，全部完成后只通知一次主进程刷新
     */
    async *deleteSkills(skillIds) {
        if (!Array.isArray(skillIds) || skillIds.length === 0) {
            yield { type: 'complete', total: 0, deleted: 0, errors: [] };
            return;
        }
        const errors = [];
        let deleted = 0;
        for (let i = 0; i < skillIds.length; i++) {
            const result = skillInstallManager.deleteSkill(skillIds[i], false);
            if (result.success) {
                deleted++;
                removeSkillStatus(skillIds[i]);
            } else if (result.error && result.error.includes('不存在')) {
                // 技能已不存在，视为已删除
                deleted++;
                removeSkillStatus(skillIds[i]);
            } else {
                errors.push({ id: skillIds[i], error: result.error });
            }
            yield { type: 'progress', index: i + 1, total: skillIds.length, deleted, current: skillIds[i] };
            // 让出事件循环，避免长时间阻塞 Worker 导致其他请求无法处理
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        // 防御性刷新：确保缓存与文件系统一致（处理部分 deleteSkill 失败但未触发 loadAll 的情况）
        skillRegistry.refresh();
        notifyMainSync();
        yield { type: 'complete', total: skillIds.length, deleted, errors };
    }

    /**
     * 流式批量导入技能，每个技能导入后 yield 进度，全部完成后仅通知一次主进程刷新
     */
    async *batchImportSkills(skills) {
        if (!Array.isArray(skills) || skills.length === 0) {
            yield { type: 'complete', total: 0, success: 0, failed: 0, errors: [] };
            return;
        }
        const errors = [];
        let success = 0;
        let failed = 0;
        const importedNames = [];
        for (let i = 0; i < skills.length; i++) {
            const skill = skills[i];
            let result;
            try {
                if (skill.type === 'directory') {
                    result = await skillInstallManager.installFromDirectory(skill.path, { refresh: false });
                } else {
                    result = await skillInstallManager.installFromLocalZip(skill.path, undefined, { refresh: false });
                }
                if (result.success) {
                    success++;
                    if (result.name) importedNames.push(result.name);
                } else {
                    failed++;
                    errors.push({ index: i, name: skill.name, error: result.error });
                }
            } catch (e) {
                failed++;
                errors.push({ index: i, name: skill.name, error: e?.message || '导入失败' });
            }
            yield { type: 'progress', index: i + 1, total: skills.length, success, failed, current: skill.name };
            // 让出事件循环，避免长时间阻塞 Worker 导致其他请求无法处理
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        // 批量导入的技能默认设置为未启用
        if (importedNames.length > 0) {
            setBatchDefaultDisabled(importedNames);
        }
        // 全部导入完成后一次性刷新 worker 侧缓存并通知主进程
        skillRegistry.refresh();
        notifyMainSync();
        yield { type: 'complete', total: skills.length, success, failed, errors };
    }

    getRegistries() {
        return skillInstallManager.getRegistriesInfo();
    }

    async searchRegistry(registryId, query = '', page = 1, limit = 20, cursor, categoryFilter) {
        const opts = {
            query: String(query || ''),
            page: Number(page) || 1,
            limit: Number(limit) || 20,
            cursor: cursor || undefined,
            categoryFilter: categoryFilter || undefined
        };
        if (registryId === 'skillsmp') {
            opts.apiKey = (this.config?.skillsmp_api_key || '').trim();
        }
        return skillInstallManager.searchRegistry(registryId, opts);
    }

    skillExists(skillName) {
        return skillRegistry.skillExists(skillName);
    }

    /** 从 Registry 安装技能（installUrl 为 registry slug、zip URL 或 registry 返回的仓库地址） */
    async installFromRegistry(installUrl, force = false, customName) {
        if (!installUrl || typeof installUrl !== 'string') {
            throw new Error('无效的安装 URL');
        }
        const result = await skillInstallManager.installFromRegistryInstallUrl(installUrl, { force, customName });
        if (!result.success) throw new Error(result.error);
        if (result.name) setDefaultStatus(result.name, true);
        notifyMainSync();
        return { name: result.name };
    }

    /**
     * 流式扫描目录中的技能：递归扫描，遇到含 SKILL.md 的子目录和含 SKILL.md 的 zip 文件均视为技能。
     * 使用 AsyncGenerator 通过 handleStreamMessage 向渲染进程流式推送进度与结果。
     */
    async *scanDirectoryForSkills(dirPath) {
        const normalized = path.resolve(String(dirPath));
        if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
            yield { type: 'error', message: '目录不存在或无效' };
            return;
        }

        // 第一阶段：统计总条目数（用于进度条）
        let totalEntries = 0;
        const countEntries = (p) => {
            try {
                const entries = fs.readdirSync(p, { withFileTypes: true });
                for (const e of entries) {
                    totalEntries++;
                    if (e.isDirectory()) countEntries(path.join(p, e.name));
                }
            } catch {
                /* skip */
            }
        };
        countEntries(normalized);

        yield { type: 'scanStart', total: totalEntries, directory: normalized };

        // 第二阶段：扫描技能
        let scanned = 0;
        const foundSkills = [];

        const scanDir = async function* (currentPath) {
            let entries;
            try {
                entries = fs.readdirSync(currentPath, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);

                if (entry.isDirectory()) {
                    scanned++;
                    try {
                        if (findSkillEntryFile(fullPath)) {
                            foundSkills.push({
                                path: fullPath,
                                name: entry.name,
                                type: 'directory'
                            });
                            yield {
                                type: 'progress',
                                scanned,
                                total: totalEntries,
                                found: foundSkills.length,
                                current: fullPath
                            };
                            continue; // 技能目录不再递归
                        }
                    } catch {
                        /* skip */
                    }
                    yield* scanDir(fullPath);
                } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
                    scanned++;
                    // 检查 zip 内是否包含 SKILL.md
                    try {
                        const zip = new AdmZip(fullPath);
                        const zipEntries = zip.getEntries();
                        const hasSkillMd = zipEntries.some(
                            (ze) => !ze.isDirectory && isSkillEntryFilename(ze.entryName)
                        );
                        if (hasSkillMd) {
                            foundSkills.push({
                                path: fullPath,
                                name: entry.name,
                                type: 'zip'
                            });
                        }
                    } catch {
                        /* skip invalid zips */
                    }
                    yield {
                        type: 'progress',
                        scanned,
                        total: totalEntries,
                        found: foundSkills.length,
                        current: fullPath
                    };
                } else {
                    scanned++;
                }
            }
        };

        yield* scanDir(normalized);

        // 去重：同一父目录下如果同时存在解压后的目录和同名 zip，只保留目录
        const dedupedSkills = [];
        const dirNames = new Set();
        for (const s of foundSkills) {
            if (s.type === 'directory') {
                dirNames.add(s.name.toLowerCase());
            }
        }
        for (const s of foundSkills) {
            if (s.type === 'zip') {
                const baseName = s.name.replace(/\.zip$/i, '');
                if (dirNames.has(baseName.toLowerCase())) continue; // 跳过已有同名目录的 zip
            }
            dedupedSkills.push(s);
        }

        yield {
            type: 'complete',
            scanned,
            total: totalEntries,
            found: dedupedSkills.length,
            skills: dedupedSkills
        };
    }

    getSkillDetail(skillId) {
        return skillRegistry.getSkillDetail(skillId);
    }

    sendNotification(type, title, message) {
        NotificationManager.getInstance().sendNotification(type, '技能中心', title, message);
    }

    getSkillStatus(skillId) {
        return getSkillStatus(skillId);
    }

    setSkillStatus(skillId, enabled) {
        setSkillStatus(skillId, enabled);
        notifyMainSync();
    }

    removeFromBlacklist(skillId) {
        // skillId 即 SKILL.md frontmatter.name（无 bundle 前缀），黑名单 key 形如 `skillmgr/${skillId}`。
        // 直接以 'skillmgr' 为 bundleName 调用，避免 split 导致 key 错位、删不掉黑名单条目。
        removeFromBlacklist('skillmgr', skillId);
        notifyMainSync();
    }
}

export default SkillsWorker;
