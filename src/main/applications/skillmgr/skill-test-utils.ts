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

export interface SkillTestCliSkill {
    id: string;
    name?: string;
    description?: string;
}

export interface SkillTestCaseLike {
    index?: unknown;
    title?: unknown;
    status?: unknown;
    failureReasonCategory?: unknown;
}

export interface SkillTestCaseStats {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    skipped: number;
}

export function parseSkillNameList(names?: string): string[] {
    if (!names) return [];
    return names
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
}

export function parseTestCaseIndices(indices?: string): number[] {
    if (!indices) return [];

    const result: number[] = [];
    const seen = new Set<number>();
    for (const raw of indices.split(',')) {
        const trimmed = raw.trim();
        if (!trimmed) continue;

        if (!/^\d+$/.test(trimmed)) {
            throw new Error(`用例序号必须是正整数: ${trimmed}`);
        }

        const index = Number(trimmed);
        if (!Number.isSafeInteger(index) || index <= 0) {
            throw new Error(`用例序号必须是正整数: ${trimmed}`);
        }

        if (!seen.has(index)) {
            seen.add(index);
            result.push(index);
        }
    }

    return result;
}

export function resolveSkillIdsByName(skills: SkillTestCliSkill[], names: string[], all: boolean): string[] {
    if (all) {
        return skills.map((skill) => skill.id);
    }

    const ids: string[] = [];
    for (const name of names) {
        const matched = skills.find((skill) => skill.name === name || skill.id === name);
        if (!matched) {
            throw new Error(`未找到技能: ${name}`);
        }
        ids.push(matched.id);
    }

    return [...new Set(ids)];
}

export function getTestCaseStats(testCases: unknown): SkillTestCaseStats {
    const cases = Array.isArray(testCases) ? testCases : [];
    const stats: SkillTestCaseStats = {
        total: cases.length,
        passed: 0,
        failed: 0,
        pending: 0,
        skipped: 0
    };

    for (const testCase of cases) {
        const status = (testCase as SkillTestCaseLike | undefined)?.status;
        if (status === 'passed') stats.passed++;
        else if (status === 'failed') stats.failed++;
        else if (status === 'skipped') stats.skipped++;
        else if (status === 'pending') stats.pending++;
    }

    return stats;
}

export function formatTestCaseStats(testCases: unknown): string {
    const stats = getTestCaseStats(testCases);
    if (stats.total === 0) return '';
    return `测试用例 (共${stats.total}条，${stats.passed}通过，${stats.failed}失败)`;
}

export function buildSkillRunSummary(
    skillIds: string[],
    skills: SkillTestCliSkill[],
    results: Record<string, { testCases?: unknown[]; error?: string } | undefined>
): string {
    const skillMap = new Map(skills.map((skill) => [skill.id, skill]));
    const failureBuckets = new Map<string, number>();
    let total = 0;
    let passed = 0;
    let failed = 0;
    let pending = 0;
    let skipped = 0;

    const lines: string[] = ['测试运行统计:'];
    for (const skillId of skillIds) {
        const skill = skillMap.get(skillId);
        const result = results[skillId];
        const stats = getTestCaseStats(result?.testCases);
        total += stats.total;
        passed += stats.passed;
        failed += stats.failed;
        pending += stats.pending;
        skipped += stats.skipped;

        for (const testCase of result?.testCases ?? []) {
            const tc = testCase as SkillTestCaseLike;
            if (tc.status !== 'failed') continue;
            const category =
                typeof tc.failureReasonCategory === 'string' && tc.failureReasonCategory
                    ? tc.failureReasonCategory
                    : 'uncategorized';
            failureBuckets.set(category, (failureBuckets.get(category) ?? 0) + 1);
        }

        const label = skill?.name || skillId;
        const errorText = result?.error ? `，错误: ${result.error}` : '';
        lines.push(
            `- ${label}: 共 ${stats.total} 条，${stats.passed} 通过，${stats.failed} 失败，${stats.pending} 未运行，${stats.skipped} 跳过${errorText}`
        );
    }

    lines.push('');
    lines.push(`总计: 共 ${total} 条，${passed} 通过，${failed} 失败，${pending} 未运行，${skipped} 跳过`);

    if (failureBuckets.size > 0) {
        lines.push('');
        lines.push('失败原因分类:');
        for (const [category, count] of [...failureBuckets.entries()].sort((a, b) => b[1] - a[1])) {
            lines.push(`- ${category}: ${count}`);
        }
    }

    return lines.join('\n');
}
