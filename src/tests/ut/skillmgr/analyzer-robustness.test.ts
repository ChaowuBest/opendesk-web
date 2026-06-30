import { jest } from '@jest/globals';
import { SkillAnalyzer } from '../../../main/applications/skillmgr/analyzer/analyze.js';
import { GlobalState } from '../../../main/aikernel/states/global.js';
import { logger } from '../../../main/utils/logger.js';

function makeAnalyzerWithTaskManager(taskManagerState: { getTask: jest.Mock }): SkillAnalyzer {
    jest.spyOn(GlobalState, 'getInstance').mockReturnValue({ taskManagerState } as any);
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    return new SkillAnalyzer();
}

function makeRunningState(total: number = 1) {
    return {
        running: true,
        taskType: 'testrun',
        total,
        completed: 0,
        currentSkill: null,
        runningTaskIds: new Set<string>(),
        results: {}
    };
}

describe('SkillAnalyzer robustness boundaries', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('stop clears pending queue even before any task is created', async () => {
        const taskManagerState = { getTask: jest.fn() };
        const analyzer = makeAnalyzerWithTaskManager(taskManagerState);
        const queue = ['skill-a', 'skill-b'];

        (analyzer as any).state = makeRunningState(2);
        (analyzer as any)._currentQueue = queue;

        await analyzer.stop();

        expect(queue).toHaveLength(0);
        expect((analyzer as any)._currentQueue).toBeUndefined();
        expect(analyzer.getStatus()).toMatchObject({
            running: false,
            completed: 0,
            currentSkill: null
        });
        expect(taskManagerState.getTask).not.toHaveBeenCalled();
    });

    test('background failure stops running tasks and clears analyzer state', () => {
        const stop = jest.fn();
        const taskManagerState = { getTask: jest.fn(() => ({ stop })) };
        const analyzer = makeAnalyzerWithTaskManager(taskManagerState);
        const queue = ['skill-a'];

        (analyzer as any).state = {
            ...makeRunningState(1),
            runningTaskIds: new Set(['task-1']),
            currentSkill: 'skill-a'
        };
        (analyzer as any)._currentQueue = queue;

        (analyzer as any)._handleBackgroundFailure('测试运行', new Error('boom'));

        expect(queue).toHaveLength(0);
        expect(stop).toHaveBeenCalledWith('system');
        expect(analyzer.getStatus()).toMatchObject({
            running: false,
            currentSkill: null
        });
        expect((analyzer as any).state.runningTaskIds.size).toBe(0);
    });

    test('test background worker records a case failure instead of rejecting the run', async () => {
        const taskManagerState = { getTask: jest.fn() };
        const analyzer = makeAnalyzerWithTaskManager(taskManagerState);
        const plan = {
            skillId: 'skill-a',
            skillDir: '/tmp/skill-a',
            skillName: 'Skill A',
            testCase: {
                index: 1,
                title: 'case one',
                prompt: 'run it',
                expectedResult: 'works',
                status: 'pending'
            }
        };
        const failTestCase = jest.fn();

        (analyzer as any).state = makeRunningState(1);
        (analyzer as any)._runTestForCase = jest.fn(async () => {
            throw new Error('case boom');
        });
        (analyzer as any)._failTestCase = failTestCase;

        await (analyzer as any)._runTestsInBackground([plan], 1);

        expect(failTestCase).toHaveBeenCalledWith(plan, '测试运行内部异常: case boom');
        expect(analyzer.getStatus()).toMatchObject({
            running: false,
            completed: 1,
            currentSkill: null
        });
    });
});
