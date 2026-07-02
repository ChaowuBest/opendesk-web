import {
    buildSkillRunSummary,
    formatTestCaseStats,
    parseSkillNameList,
    parseTestCaseIndices,
    resolveSkillIdsByName
} from '../../../main/applications/skillmgr/skill-test-utils.js';

describe('skillmgr skill test CLI helpers', () => {
    test('parses comma separated skill names and trims blanks', () => {
        expect(parseSkillNameList(' skill A,中文技能, , skill B ')).toEqual(['skill A', '中文技能', 'skill B']);
    });

    test('resolves skill ids by name and lets --all take priority', () => {
        const skills = [
            { id: 'id-a', name: 'skill A' },
            { id: 'id-b', name: 'skill B' }
        ];

        expect(resolveSkillIdsByName(skills, ['skill B'], false)).toEqual(['id-b']);
        expect(resolveSkillIdsByName(skills, ['missing'], true)).toEqual(['id-a', 'id-b']);
    });

    test('deduplicates and validates case indices', () => {
        expect(parseTestCaseIndices('1, 3, 3, 5')).toEqual([1, 3, 5]);
        expect(() => parseTestCaseIndices('1, zero')).toThrow('用例序号必须是正整数');
        expect(() => parseTestCaseIndices('0')).toThrow('用例序号必须是正整数');
    });

    test('formats existing test case stats', () => {
        expect(formatTestCaseStats([{ status: 'passed' }, { status: 'failed' }, { status: 'pending' }])).toBe(
            '测试用例 (共3条，1通过，1失败)'
        );
        expect(formatTestCaseStats([])).toBe('');
    });

    test('builds run summary with failure reason buckets', () => {
        const summary = buildSkillRunSummary(['skill-a'], [{ id: 'skill-a', name: 'Skill A' }], {
            'skill-a': {
                testCases: [
                    { status: 'passed' },
                    { status: 'failed', failureReasonCategory: 'dependency_runtime' },
                    { status: 'failed' },
                    { status: 'skipped' }
                ]
            }
        });

        expect(summary).toContain('- Skill A: 共 4 条，1 通过，2 失败，0 未运行，1 跳过');
        expect(summary).toContain('总计: 共 4 条，1 通过，2 失败，0 未运行，1 跳过');
        expect(summary).toContain('- dependency_runtime: 1');
        expect(summary).toContain('- uncategorized: 1');
    });
});
