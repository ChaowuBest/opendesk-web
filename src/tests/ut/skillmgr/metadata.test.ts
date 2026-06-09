import {
    classifyTestFailureReason,
    OpendeskMetaSchema,
    TestFailureReasonCategory
} from '../../../main/applications/skillmgr/analyzer/metadata.js';

describe('skillmgr metadata test failure reason', () => {
    const baseTestCase = {
        index: 1,
        title: '失败分类兼容性',
        prompt: '执行一个测试用例',
        expectedResult: '测试用例应通过',
        status: 'failed',
        error: '实际结果与预期不一致'
    };

    test('accepts old test cases without failure reason category', () => {
        const result = OpendeskMetaSchema.safeParse({
            testCases: [baseTestCase]
        });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.testCases?.[0].failureReasonCategory).toBeUndefined();
    });

    test('accepts new test cases with failure reason category', () => {
        const result = OpendeskMetaSchema.safeParse({
            testCases: [
                {
                    ...baseTestCase,
                    failureReasonCategory: TestFailureReasonCategory.Placeholder
                }
            ]
        });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.testCases?.[0].failureReasonCategory).toBe(TestFailureReasonCategory.Placeholder);
    });

    test('classifies failed test result messages', () => {
        expect(classifyTestFailureReason('实际结果与预期不一致')).toBe(TestFailureReasonCategory.Placeholder);
    });
});
