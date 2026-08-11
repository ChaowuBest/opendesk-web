// Copyright (c) 2026 The OpenDesk Team
// OpenDesk is licensed under Mulan PSL v2.
// You can use this software according to the terms and conditions of the Mulan PSL v2.
// You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
// EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
// MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.

import path from 'path';
import { z } from 'zod';
import { BaseTool } from '../../../tool.js';
import { SkillRegistry } from '../../../skill.js';
import type { TaskState } from '../../../states/tasks.js';
import { mutateMeta, OPENDESK_META_FILENAME } from './skill-fallback.js';

const DependencyCategorySchema = z.enum(['envVars', 'pythonPackages', 'npmPackages', 'binaries']);
type DependencyCategory = z.infer<typeof DependencyCategorySchema>;

const RecordHarmonyosFallbackSchema = z
    .object({
        bundleName: z.string().min(1).describe('目标 Skill 所属应用的 bundleName'),
        skillName: z.string().min(1).describe('目标 Skill 名称；必须已在当前任务中通过 LoadSkill 加载'),
        category: DependencyCategorySchema.describe(
            '依赖分类，只能是 envVars、pythonPackages、npmPackages、binaries 之一'
        ),
        dependencyName: z.string().min(1).describe('依赖名称'),
        note: z.string().min(1).describe('确认该 fallback 的简短证据或说明')
    })
    .strict();

type RecordHarmonyosFallbackArgs = z.output<typeof RecordHarmonyosFallbackSchema>;

type DependencyRecord = Record<string, unknown> & { name: string };

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 结构损坏，拒绝写入`);
    }
    return value as Record<string, unknown>;
}

/** Deterministic fail-closed upsert. Exported for focused unit tests. */
export function upsertHarmonyosFallback(
    meta: Record<string, unknown>,
    category: DependencyCategory,
    dependencyName: string,
    note: string,
    recordedAt: string
): boolean {
    let dependencies: Record<string, unknown>;
    if (meta['dependencies'] === undefined) {
        dependencies = {};
        meta['dependencies'] = dependencies;
    } else {
        dependencies = requireRecord(meta['dependencies'], 'dependencies');
    }

    let records: DependencyRecord[];
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
            if (typeof record['name'] !== 'string' || record['name'].length === 0) {
                throw new Error(`dependencies.${category}[${index}].name 结构损坏，拒绝写入`);
            }
            return record as DependencyRecord;
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

export class RecordHarmonyosFallbackTool extends BaseTool<typeof RecordHarmonyosFallbackSchema> {
    constructor(private readonly runtimePlatform: string = process.platform as string) {
        super(
            'recordHarmonyosFallback',
            '记录 HarmonyOS 依赖 fallback。目标 Skill 必须已在当前任务中加载。',
            RecordHarmonyosFallbackSchema
        );
        this.serialExecution = true;
        this.setExecutor(this.record.bind(this));
    }

    private async record(args: RecordHarmonyosFallbackArgs, taskState?: TaskState): Promise<string> {
        if (this.runtimePlatform !== 'openharmony') {
            throw new Error('recordHarmonyosFallback 仅允许在 OpenHarmony 运行时使用');
        }
        if (!taskState) throw new Error('缺少当前任务上下文，拒绝写入');

        const wasLoaded = taskState
            .getLoadedSkillsFromContext()
            .some((loaded) => loaded.bundleName === args.bundleName && loaded.skillName === args.skillName);
        if (!wasLoaded) {
            throw new Error(`目标 Skill ${args.bundleName}/${args.skillName} 未在当前任务中通过 LoadSkill 加载`);
        }

        const skill = await SkillRegistry.getInstance().getSkill(args.bundleName, args.skillName);
        if (!skill?.directory) {
            throw new Error(`无法通过 SkillRegistry 精确解析 ${args.bundleName}/${args.skillName} 的目录`);
        }

        const recordedAt = new Date().toISOString();
        await mutateMeta(path.join(skill.directory, OPENDESK_META_FILENAME), (meta) => {
            upsertHarmonyosFallback(meta, args.category, args.dependencyName, args.note, recordedAt);
        });
        return `已记录 ${args.bundleName}/${args.skillName} 的 ${args.category}/${args.dependencyName} HarmonyOS fallback`;
    }
}
