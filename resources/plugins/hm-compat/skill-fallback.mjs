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
 * HarmonyOS skill fallback（hm-compat 插件的一部分，由 index.mjs 接线）。
 *
 * 维护「某 Skill 的某依赖在 HarmonyOS 上不受支持、需回退 Linux VM 执行」的经验记录，
 * 经验保存在各 Skill 目录的 opendesk_meta.json 中：
 * - skill.load.after：跟踪本进程内加载过的 Skill 及其目录（hook 输入不含 taskId，
 *   因此范围是「本次运行中加载过」，弱于宿主时代的「当前任务已加载」）；
 * - shell.execute.after（bash/zsh）：命令命中已记录的 fallback 依赖时，将 advisory
 *   追加到工具结果（插件侧无法注入内部用户消息，与 recovery.mjs 同用结果追加模式）；
 * - tool.execute.after（executeNodeShell）：任务最近 FAILED_BASH_WINDOW_SIZE 次
 *   Bash/Zsh 中存在失败、随后 Linux Node 执行成功时，向结果追加 fallback 候选提示，
 *   引导模型调用本插件注册的 recordHarmonyosFallback 工具补录经验；
 * - tools.register：recordHarmonyosFallback 工具，fail-closed 地把经验写入目标
 *   Skill 的 opendesk_meta.json（临时文件 + fsync + rename 原子落盘）。
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';

/** opendesk_meta.json 文件名 */
export const OPENDESK_META_FILENAME = 'opendesk_meta.json';

// fallback 记录保留天数：超期后视为经验失效，从 meta 中清除 fallback 字段。
const SUNSET_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// fallback 依赖分类，与 opendesk_meta.json 的 dependencies 结构一一对应。
const DEP_CATEGORIES = ['envVars', 'pythonPackages', 'npmPackages', 'binaries'];

// 回看窗口大小：判断 executeNodeShell 成功前最近多少次 Bash/Zsh 中是否存在失败。
const FAILED_BASH_WINDOW_SIZE = 5;

// per-task shell 结果窗口跟踪的任务数上限，防止 Map 无界增长。
const MAX_TRACKED_TASKS = 200;

const LOG_PREFIX = '[hm-compat:skill-fallback]';

// ── opendesk_meta.json 原子修改 ───────────────────────────────────────────────

/** 模块级共享：resolved path → 串行化链（等价宿主时代按路径共享的 FileLock）。 */
const metaLocks = new Map();

function withMetaLock(resolvedMetaPath, task) {
    let entry = metaLocks.get(resolvedMetaPath);
    if (!entry) {
        entry = { tail: Promise.resolve() };
        metaLocks.set(resolvedMetaPath, entry);
    }
    const result = entry.tail.then(task, task);
    entry.tail = result.then(
        () => {},
        () => {}
    );
    return result;
}

/**
 * 在共享路径锁内读取最新元数据、执行修改并原子落盘。
 *
 * 临时文件与目标文件位于同一目录；文件内容 fsync 后 rename，随后 fsync 目录，
 * 任一步骤失败都会关闭句柄并清理尚存的临时文件。文件不存在时以空对象创建。
 */
export async function mutateMeta(metaPath, mutation) {
    const resolvedMetaPath = path.resolve(metaPath);

    return withMetaLock(resolvedMetaPath, async () => {
        const directory = path.dirname(resolvedMetaPath);
        const tempPath = path.join(directory, `.${path.basename(resolvedMetaPath)}.${process.pid}.${randomUUID()}.tmp`);
        let mode = 0o666;
        let meta = {};

        await fs.promises.mkdir(directory, { recursive: true });
        try {
            try {
                const [raw, stat] = await Promise.all([
                    fs.promises.readFile(resolvedMetaPath, 'utf-8'),
                    fs.promises.stat(resolvedMetaPath)
                ]);
                mode = stat.mode;
                const parsed = JSON.parse(raw);
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error(`${OPENDESK_META_FILENAME} 顶层必须是一个 JSON 对象`);
                }
                meta = parsed;
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }

            const result = await mutation(meta);
            const file = await fs.promises.open(tempPath, 'wx', mode);
            try {
                await file.writeFile(`${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
                await file.sync();
            } finally {
                await file.close();
            }

            await fs.promises.rename(tempPath, resolvedMetaPath);
            const directoryHandle = await fs.promises.open(directory, 'r');
            try {
                // Windows 不支持对目录句柄执行 fsync，忽略平台性错误（目录 fsync 仅对 POSIX 落盘语义有意义）
                await directoryHandle.sync().catch((error) => {
                    if (error.code !== 'EPERM' && error.code !== 'ENOTSUP' && error.code !== 'EINVAL') {
                        throw error;
                    }
                });
            } finally {
                await directoryHandle.close();
            }
            return result;
        } catch (error) {
            await fs.promises.rm(tempPath, { force: true }).catch(() => {});
            throw error;
        }
    });
}

// ── fallback 记录结构与匹配 ───────────────────────────────────────────────────

function isExpired(recordedAt, now = new Date()) {
    const recorded = new Date(recordedAt);
    return Number.isNaN(recorded.getTime()) || now.getTime() - recorded.getTime() > SUNSET_DAYS * MS_PER_DAY;
}

function readMetaFrom(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (err) {
        console.error(`${LOG_PREFIX} failed to read ${filePath}:`, err);
        return null;
    }
}

function collectAllDeps(deps) {
    if (!deps || typeof deps !== 'object') return [];
    return DEP_CATEGORIES.flatMap((category) =>
        (Array.isArray(deps[category]) ? deps[category] : []).map((record, index) => ({ category, index, record }))
    );
}

function matchesSnapshot(dependency, snapshot) {
    return (
        dependency?.name === snapshot.name &&
        dependency.fallback === snapshot.fallback &&
        dependency.recordedAt === snapshot.recordedAt
    );
}

async function removeExpiredFrom(filePath, snapshots) {
    if (snapshots.length === 0) return;
    await mutateMeta(filePath, (meta) => {
        const dependencies = meta.dependencies;
        if (!dependencies) return;
        for (const snapshot of snapshots) {
            const list = dependencies[snapshot.category];
            const dependency = Array.isArray(list) ? list[snapshot.index] : undefined;
            if (!matchesSnapshot(dependency, snapshot)) continue;
            delete dependency.fallback;
            delete dependency.note;
            delete dependency.recordedAt;
        }
    });
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Match a dependency as a shell-ish token rather than as an arbitrary substring. */
export function commandContainsDependencyToken(command, dependency) {
    const name = dependency.trim();
    if (!name) return false;
    return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(name)}(?=$|[^A-Za-z0-9_])`).test(command);
}

async function checkDependencies(filePath, command) {
    const matched = [];
    const expired = [];
    for (const { category, index, record } of collectAllDeps(readMetaFrom(filePath)?.dependencies)) {
        if (record?.fallback !== 'linux_vm' || !commandContainsDependencyToken(command, record?.name)) {
            continue;
        }
        if (!record.recordedAt || isExpired(record.recordedAt)) {
            expired.push({
                category,
                index,
                name: record.name,
                fallback: record.fallback,
                recordedAt: record.recordedAt
            });
            continue;
        }
        matched.push(record.name);
    }
    try {
        await removeExpiredFrom(filePath, expired);
    } catch (err) {
        console.error(`${LOG_PREFIX} failed to remove expired fallback metadata from ${filePath}: ${String(err)}`);
    }
    return matched;
}

// ── recordHarmonyosFallback 工具：fail-closed 的经验写入 ──────────────────────

function requireRecord(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 结构损坏，拒绝写入`);
    }
    return value;
}

/** Deterministic fail-closed upsert. Exported for focused unit tests. */
export function upsertHarmonyosFallback(meta, category, dependencyName, note, recordedAt) {
    if (dependencyName.includes(',')) {
        throw new Error('dependencyName 只能包含单个依赖名称，不能包含逗号分隔的多个名称');
    }

    let dependencies;
    if (meta.dependencies === undefined) {
        dependencies = {};
        meta.dependencies = dependencies;
    } else {
        dependencies = requireRecord(meta.dependencies, 'dependencies');
    }

    let records;
    const categoryValue = dependencies[category];
    if (categoryValue === undefined) {
        records = [];
        dependencies[category] = records;
    } else {
        if (!Array.isArray(categoryValue)) {
            throw new Error(`dependencies.${category} 结构损坏，拒绝写入`);
        }
        records = categoryValue.map((entry, index) => {
            const record = requireRecord(entry, `dependencies.${category}[${index}]`);
            if (typeof record.name !== 'string' || record.name.length === 0) {
                throw new Error(`dependencies.${category}[${index}].name 结构损坏，拒绝写入`);
            }
            return record;
        });
        dependencies[category] = records;
    }

    const matches = records.filter((record) => record.name === dependencyName);
    if (matches.length > 1) {
        throw new Error(`dependencies.${category} 中存在多条同名依赖 ${dependencyName}，拒绝写入`);
    }

    const target = matches[0] ?? { name: dependencyName };
    if (target.fallback === 'linux_vm') return false;
    if (matches.length === 0) records.push(target);
    target.fallback = 'linux_vm';
    target.note = note;
    target.recordedAt = recordedAt;
    return true;
}

const RecordHarmonyosFallbackSchema = z
    .object({
        bundleName: z.string().min(1).describe('目标 Skill 所属应用的 bundleName'),
        skillName: z.string().min(1).describe('目标 Skill 名称；必须已在当前任务中通过 LoadSkill 加载'),
        category: z
            .enum(DEP_CATEGORIES)
            .describe('依赖分类，只能是 envVars、pythonPackages、npmPackages、binaries 之一'),
        dependencyName: z
            .string()
            .min(1)
            .refine((val) => !val.includes(','), {
                message: 'dependencyName 只能包含单个依赖名称，不能包含逗号分隔的多个名称'
            })
            .describe('单个依赖名称；每次调用只能记录一个依赖，不要传入逗号分隔的多个名称'),
        note: z.string().min(1).describe('确认该 fallback 的简短证据或说明')
    })
    .strict();

// ── hook 辅助：per-task 失败窗口 ──────────────────────────────────────────────

/** taskId → 最近若干次 Bash/Zsh 执行结果（'success' | 'failure'）的滑动窗口。 */
const shellOutcomesByTask = new Map();

function trackShellOutcome(taskId, returnCode) {
    if (!taskId || !Number.isInteger(returnCode)) return;
    const outcomes = shellOutcomesByTask.get(taskId) ?? [];
    outcomes.push(returnCode === 0 ? 'success' : 'failure');
    if (outcomes.length > FAILED_BASH_WINDOW_SIZE) {
        outcomes.shift();
    }
    shellOutcomesByTask.set(taskId, outcomes);
    if (shellOutcomesByTask.size > MAX_TRACKED_TASKS) {
        const oldest = shellOutcomesByTask.keys().next().value;
        shellOutcomesByTask.delete(oldest);
    }
}

function hasRecentFailedShell(taskId) {
    const outcomes = shellOutcomesByTask.get(taskId);
    return Boolean(outcomes?.some((outcome) => outcome === 'failure'));
}

/** 提示触发后清空窗口，避免同一任务内连续成功的 Node 调用重复提示。 */
function resetShellWindow(taskId) {
    shellOutcomesByTask.delete(taskId);
}

function buildFallbackPrompt(recordToolName, skills) {
    const skillList = [...skills.entries()]
        .map(([key, skillDir]) => {
            const separator = key.indexOf('/');
            const bundleName = key.slice(0, separator);
            const skillName = key.slice(separator + 1);
            return `- bundleName=${bundleName}, skillName=${skillName}（${skillDir}）`;
        })
        .join('\n');
    return [
        '## HarmonyOS fallback 候选（内部提示）',
        '当前成功的 Linux Node 调用之前，任务历史中存在失败的 HarmonyOS Bash/Zsh 调用。',
        '请根据当前任务的完整对话和工具调用记录自行判断：当前 Node 成功是否确实是在替代某个失败 Bash/Zsh、具体依赖是什么，以及它归属哪个已加载 Skill；不要按最近调用、固定窗口或命令相似性做硬性判定。',
        `若无法确认关联、依赖或 Skill 归属，请不要记录。确认 fallback 后必须调用专用工具 ${recordToolName}：`,
        'toolArgs.bundleName 与 toolArgs.skillName 必须从下方「已加载 Skill 全历史」中复制目标 Skill 的真实 bundleName 与 skillName，禁止猜测。',
        'toolArgs.category 只能是 envVars、pythonPackages、npmPackages、binaries：环境变量使用 envVars，Python 包使用 pythonPackages，npm 包使用 npmPackages，命令或二进制依赖使用 binaries。禁止使用其他值。',
        `toolArgs.dependencyName 每次只能传入单个依赖名称；如果 Skill 有多个依赖需要记录，请分别多次调用 ${recordToolName}，不要用逗号拼接多个名称。`,
        '若 meta 文件中已有该依赖的 fallback advisory，说明经验已经存在，不要重复记录。',
        '严禁使用 writeFile、editFile、searchReplace 或其他通用文件写工具记录 fallback；严禁自行提供路径、fallback、recordedAt。',
        '',
        '已加载 Skill 全历史：',
        skillList,
        '',
        `确认后，调用 ${recordToolName}，并只传 bundleName、skillName、category、dependencyName、note；不确认则不做任何记录。`
    ].join('\n');
}

// ── 接线 ──────────────────────────────────────────────────────────────────────

/**
 * 注册 HarmonyOS skill fallback hooks 与 recordHarmonyosFallback 工具。
 *
 * @param {import('@bitclub.ai/opendesk-plugin-sdk').PluginContext} context
 */
export function setupSkillFallback(context) {
    /** bundleName/skillName → Skill 目录，记录本次运行中加载过的 Skill。 */
    const loadedSkills = new Map();
    const recordToolName = `${context.pluginId}-recordHarmonyosFallback`;

    context.hooks.on('skill.load.after', (input) => {
        if (typeof input?.skillDirectory === 'string' && input.skillDirectory) {
            loadedSkills.set(`${input.bundleName}/${input.skillName}`, input.skillDirectory);
        }
    });

    context.hooks.on('shell.execute.after', async (input, output) => {
        // OpenHarmony 上 terminal 应用注册 executeBash / executeZsh，其余 shell 不参与
        if (input.shellType !== 'bash' && input.shellType !== 'zsh') return;

        // 失败窗口跟踪：供 executeNodeShell 成功后的 fallback 候选判断使用
        trackShellOutcome(input.taskId, input.returnCode);

        const command = typeof input.args?.command === 'string' ? input.args.command : '';
        if (!command || loadedSkills.size === 0) return;

        try {
            for (const [key, skillDir] of loadedSkills) {
                const matched = await checkDependencies(path.join(skillDir, OPENDESK_META_FILENAME), command);
                if (matched.length === 0) continue;
                output.result +=
                    `\n\nHarmonyOS fallback advisory：Skill ${key} 曾记录依赖 ${matched.join('、')} 在当前环境不受支持，` +
                    '可考虑切换到 Linux 虚拟机（Headless Node）执行，请结合命令语义判断；这是已有经验，不要再次记录该依赖。';
            }
        } catch (err) {
            console.error(`${LOG_PREFIX} fallback advisory check failed:`, err);
        }
    });

    context.hooks.on('tool.execute.after', async (input, output) => {
        if (input.tool !== 'executeNodeShell' && !input.tool.endsWith('-executeNodeShell')) return;
        const details = output.resultObject;
        if (!details || typeof details !== 'object' || details.exitCode !== 0) return;

        // 任务最近几次 Bash/Zsh 中存在失败，且随后 Linux Node 执行成功 → 可能是 fallback
        if (!hasRecentFailedShell(input.taskId)) return;
        if (loadedSkills.size === 0) return;

        try {
            output.result += `\n\n${buildFallbackPrompt(recordToolName, loadedSkills)}`;
            resetShellWindow(input.taskId);
        } catch (err) {
            console.error(`${LOG_PREFIX} failed to append fallback prompt:`, err);
        }
    });

    context.tools.register({
        name: 'recordHarmonyosFallback',
        description: '记录 HarmonyOS 依赖 fallback。目标 Skill 必须已在当前任务中加载。',
        parameters: RecordHarmonyosFallbackSchema,
        serialExecution: true,
        execute: async (args) => {
            if (process.platform !== 'openharmony') {
                throw new Error('recordHarmonyosFallback 仅允许在 OpenHarmony 运行时使用');
            }
            const skillDir = loadedSkills.get(`${args.bundleName}/${args.skillName}`);
            if (!skillDir) {
                throw new Error(`目标 Skill ${args.bundleName}/${args.skillName} 未在当前任务中通过 LoadSkill 加载`);
            }

            const recordedAt = new Date().toISOString();
            await mutateMeta(path.join(skillDir, OPENDESK_META_FILENAME), (meta) => {
                upsertHarmonyosFallback(meta, args.category, args.dependencyName, args.note, recordedAt);
            });
            return `已记录 ${args.bundleName}/${args.skillName} 的 ${args.category}/${args.dependencyName} HarmonyOS fallback`;
        }
    });
}
