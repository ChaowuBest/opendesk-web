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

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { parseJsonWithRepair } from '../../../../../utils/json.js';
import { logger } from '../../../../utils/logger.js';
import { FileLock } from '../../../../utils/file-lock.js';
import { GlobalHooks } from '../../../hooks.js';
import type { AfterToolCallExecContext, BeforeToolCallExecAction, BeforeToolCallExecContext } from '../../../hooks.js';
import type { TaskState } from '../../../states/tasks.js';
import type { ToolCall } from '../../../messages.js';
import { SkillRegistry } from '../../../skill.js';

import { FAILED_BASH_WINDOW_SIZE } from './constants.js';

/** opendesk_meta.json 文件名 */
export const OPENDESK_META_FILENAME = 'opendesk_meta.json';

/**
 * 在共享路径锁内读取最新元数据、执行修改并原子落盘。
 *
 * 临时文件与目标文件位于同一目录；文件内容 fsync 后 rename，随后 fsync 目录，
 * 任一步骤失败都会关闭句柄并清理尚存的临时文件。文件不存在时以空对象创建。
 */
export async function mutateMeta(
    metaPath: string,
    mutation: (meta: Record<string, unknown>) => void | Promise<void>
): Promise<void> {
    const resolvedMetaPath = path.resolve(metaPath);
    const lock = new FileLock(resolvedMetaPath);

    return lock.runExclusive(async () => {
        const directory = path.dirname(resolvedMetaPath);
        const tempPath = path.join(directory, `.${path.basename(resolvedMetaPath)}.${process.pid}.${randomUUID()}.tmp`);
        let mode = 0o666;
        let meta: Record<string, unknown> = {};

        await fs.promises.mkdir(directory, { recursive: true });
        try {
            try {
                const [raw, stat] = await Promise.all([
                    fs.promises.readFile(resolvedMetaPath, 'utf-8'),
                    fs.promises.stat(resolvedMetaPath)
                ]);
                mode = stat.mode;
                const parsed: unknown = parseJsonWithRepair(raw);
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error(`${OPENDESK_META_FILENAME} 顶层必须是一个 JSON 对象`);
                }
                meta = parsed as Record<string, unknown>;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
                await directoryHandle.sync().catch((error: NodeJS.ErrnoException) => {
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

const SUNSET_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEP_CATEGORIES = ['envVars', 'pythonPackages', 'npmPackages', 'binaries'] as const;
type DepCategory = (typeof DEP_CATEGORIES)[number];

interface FallbackDependency {
    name: string;
    fallback?: string;
    note?: string;
    recordedAt?: string;
    [key: string]: unknown;
}

interface FallbackMeta {
    dependencies?: Partial<Record<DepCategory, FallbackDependency[]>>;
    [key: string]: unknown;
}

interface FallbackSnapshot {
    category: DepCategory;
    index: number;
    name: string;
    fallback: string;
    recordedAt: string | undefined;
}

function isExpired(recordedAt: string, now: Date = new Date()): boolean {
    const recorded = new Date(recordedAt);
    return Number.isNaN(recorded.getTime()) || now.getTime() - recorded.getTime() > SUNSET_DAYS * MS_PER_DAY;
}

function readMetaFrom(filePath: string): FallbackMeta | null {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as FallbackMeta;
    } catch (err) {
        logger.error(`SkillFallback: failed to read ${filePath}:`, err);
        return null;
    }
}

function collectAllDeps(
    deps: FallbackMeta['dependencies']
): Array<{ category: DepCategory; index: number; record: FallbackDependency }> {
    if (!deps) return [];
    return DEP_CATEGORIES.flatMap((category) =>
        (deps[category] ?? []).map((record, index) => ({ category, index, record }))
    );
}

function matchesSnapshot(dependency: FallbackDependency | undefined, snapshot: FallbackSnapshot): boolean {
    return (
        dependency?.name === snapshot.name &&
        dependency.fallback === snapshot.fallback &&
        dependency.recordedAt === snapshot.recordedAt
    );
}

async function removeExpiredFrom(filePath: string, snapshots: FallbackSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return;
    await mutateMeta(filePath, (meta) => {
        const dependencies = (meta as FallbackMeta).dependencies;
        if (!dependencies) return;
        for (const snapshot of snapshots) {
            const dependency = dependencies[snapshot.category]?.[snapshot.index];
            if (!matchesSnapshot(dependency, snapshot)) continue;
            delete dependency.fallback;
            delete dependency.note;
            delete dependency.recordedAt;
        }
    });
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Match a dependency as a shell-ish token rather than as an arbitrary substring. */
export function commandContainsDependencyToken(command: string, dependency: string): boolean {
    const name = dependency.trim();
    if (!name) return false;
    return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(name)}(?=$|[^A-Za-z0-9_])`).test(command);
}

async function checkDependencies(filePath: string, command: string): Promise<string[]> {
    const matched: string[] = [];
    const expired: FallbackSnapshot[] = [];
    for (const { category, index, record } of collectAllDeps(readMetaFrom(filePath)?.dependencies)) {
        if (record.fallback !== 'linux_vm' || !commandContainsDependencyToken(command, record.name)) {
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
        logger.warn(`SkillFallback: failed to remove expired fallback metadata from ${filePath}: ${String(err)}`);
    }
    return matched;
}

/** Keep the accepted full LoadSkill history and leave ownership attribution to the LLM. */
async function resolveExternalSkills(
    task: TaskState
): Promise<Array<{ bundleName: string; skillName: string; skillDir: string }>> {
    const registry = SkillRegistry.getInstance();
    const result: Array<{ bundleName: string; skillName: string; skillDir: string }> = [];
    for (const { bundleName, skillName } of task.getLoadedSkillsFromContext()) {
        try {
            const skill = await registry.getSkill(bundleName, skillName);
            if (skill?.directory) result.push({ bundleName, skillName, skillDir: skill.directory });
        } catch {
            // Ignore unavailable historical skills.
        }
    }
    return result;
}

export async function onBeforeExecuteBash({
    task,
    toolCall
}: BeforeToolCallExecContext): Promise<BeforeToolCallExecAction> {
    const command = toolCall.args_object?.command;
    if (typeof command !== 'string') return { operation: 'allow' };

    for (const { skillDir, skillName } of await resolveExternalSkills(task)) {
        const matched = await checkDependencies(path.join(skillDir, OPENDESK_META_FILENAME), command);
        if (matched.length === 0) continue;
        await task.appendInternalUserMessage(
            `HarmonyOS fallback advisory：Skill ${skillName} 曾记录依赖 ${matched.join('、')} 在当前环境不受支持，` +
                '可考虑切换到 Linux 虚拟机执行，请结合命令语义判断；这是已有经验，不要再次记录该依赖。'
        );
    }
    return { operation: 'allow' };
}

function isToolName(toolCall: ToolCall, bareName: string): boolean {
    return toolCall.tool_name === bareName || toolCall.tool_name.endsWith(`-${bareName}`);
}

/** Check the five tool calls immediately preceding the current node call for a failed Bash. */
export function hasFailedBashBefore(task: TaskState, currentNodeCall: ToolCall): boolean {
    let foundCurrent = false;
    let checkedCalls = 0;

    for (let messageIndex = task.chat_context.messages.length - 1; messageIndex >= 0; messageIndex--) {
        const message = task.chat_context.messages[messageIndex];
        if (message.role !== 'assistant') continue;
        for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
            const part = message.content[partIndex];
            if (part.type !== 'tool_call') continue;
            for (let callIndex = part.toolcalls.length - 1; callIndex >= 0; callIndex--) {
                const call = part.toolcalls[callIndex];
                if (!foundCurrent) {
                    if (call === currentNodeCall) foundCurrent = true;
                    continue;
                }

                const exitCode = (call.result_object as { exitCode?: unknown } | undefined)?.exitCode;
                if (
                    (isToolName(call, 'executeBash') || isToolName(call, 'executeZsh')) &&
                    Number.isInteger(exitCode) &&
                    exitCode !== 0
                )
                    return true;
                checkedCalls++;
                if (checkedCalls === FAILED_BASH_WINDOW_SIZE) return false;
            }
        }
    }
    return false;
}

function buildFallbackPrompt(skills: Array<{ bundleName: string; skillName: string; skillDir: string }>): string {
    const skillList = skills
        .map((skill) => `- bundleName=${skill.bundleName}, skillName=${skill.skillName}（${skill.skillDir}）`)
        .join('\n');
    return [
        '## HarmonyOS fallback 候选（内部提示）',
        '当前成功的 localhost Linux Node 调用之前，任务历史中存在失败的 HarmonyOS Bash/Zsh 调用。',
        '请根据当前任务的完整对话和工具调用记录自行判断：当前 Node 成功是否确实是在替代某个失败 Bash/Zsh、具体依赖是什么，以及它归属哪个已加载 Skill；不要按最近调用、固定窗口或命令相似性做硬性判定。',
        '若无法确认关联、依赖或 Skill 归属，请不要记录。确认 fallback 后必须通过 CallSkillTool 调用专用工具：',
        '调用参数固定使用 bundleName="skillmgr"、skillName="manage-skills"、toolName="recordHarmonyosFallback"。',
        '注意区分两层 bundleName：CallSkillTool 的 bundleName 固定为 "skillmgr"；toolArgs.bundleName 必须从下方“已加载 Skill 全历史”中复制目标 Skill 的真实 bundleName，禁止猜测。toolArgs.skillName 同样必须复制对应的真实 skillName。',
        'toolArgs.category 只能是 envVars、pythonPackages、npmPackages、binaries：环境变量使用 envVars，Python 包使用 pythonPackages，npm 包使用 npmPackages，命令或二进制依赖使用 binaries。禁止使用其他值。',
        'toolArgs.dependencyName 每次只能传入单个依赖名称；如果 Skill 有多个依赖需要记录，请分别多次调用 recordHarmonyosFallback，不要用逗号拼接多个名称。',
        '若 meta 文件中已有该依赖的 fallback advisory，说明经验已经存在，不要重复记录。',
        '严禁使用 writeFile、editFile、searchReplace 或其他通用文件写工具记录 fallback；严禁自行提供路径、fallback、recordedAt。',
        '',
        '已加载 Skill 全历史：',
        skillList,
        '',
        '确认后，调用 recordHarmonyosFallback，并只传 bundleName、skillName、category、dependencyName、note；不确认则不做任何记录。'
    ].join('\n');
}

export async function onAfterExecuteNodeShell({ task, toolCall }: AfterToolCallExecContext): Promise<void> {
    const details = toolCall.result_object as { exitCode?: unknown; nodeId?: unknown } | undefined;
    if (details?.exitCode !== 0 || details.nodeId !== 'opendesk-headless-localhost') return;

    if (!hasFailedBashBefore(task, toolCall)) return;
    const skills = await resolveExternalSkills(task);
    if (skills.length === 0) return;

    await task.appendInternalUserMessage(buildFallbackPrompt(skills));
}

let registered = false;

/** Register the OpenHarmony-specific skill fallback hooks. */
export function registerHarmonyosFallbackHooks(): void {
    if (registered) return;
    registered = true;
    for (const toolName of ['executeBash', 'executeZsh'] as const) {
        GlobalHooks.registerToolHook(toolName, { beforeToolCall: onBeforeExecuteBash });
    }
    GlobalHooks.registerToolHook('executeNodeShell', { afterToolCall: onAfterExecuteNodeShell });
}
