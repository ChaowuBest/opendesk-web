import {
    classifyTestFailureReason,
    OpendeskMetaSchema,
    parseTestResult,
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

    test('accepts test cases with failure reason category', () => {
        const result = OpendeskMetaSchema.safeParse({
            testCases: [
                {
                    ...baseTestCase,
                    failureReasonCategory: TestFailureReasonCategory.DependencyRuntime
                }
            ]
        });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.testCases?.[0].failureReasonCategory).toBe(TestFailureReasonCategory.DependencyRuntime);
    });

    test('requires failed test result to include failure reason category', () => {
        const result = parseTestResult(
            JSON.stringify({
                result: 'failed',
                message: '缺少 python 依赖'
            })
        );

        expect(result.success).toBe(false);
    });

    test('accepts failed test result with failure reason category', () => {
        const result = parseTestResult(
            JSON.stringify({
                result: 'failed',
                message: '缺少 python 依赖',
                failureReasonCategory: TestFailureReasonCategory.DependencyRuntime
            })
        );

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.failureReasonCategory).toBe(TestFailureReasonCategory.DependencyRuntime);
    });

    test('accepts succeeded test result without failure reason category', () => {
        const result = parseTestResult(
            JSON.stringify({
                result: 'succeeded',
                message: '测试通过'
            })
        );

        expect(result.success).toBe(true);
    });

    test('classifies failed test result messages', () => {
        expect(classifyTestFailureReason('No module named pandas')).toBe(TestFailureReasonCategory.DependencyRuntime);
        expect(classifyTestFailureReason('缺少 OPENAI_API_KEY 环境变量')).toBe(TestFailureReasonCategory.Misconfigured);
        expect(classifyTestFailureReason('输入文件格式不支持')).toBe(TestFailureReasonCategory.InputData);
        expect(classifyTestFailureReason('API timeout')).toBe(TestFailureReasonCategory.ExternalService);
        expect(classifyTestFailureReason('实际结果与预期不一致')).toBe(TestFailureReasonCategory.SkillImplementation);
    });
});
