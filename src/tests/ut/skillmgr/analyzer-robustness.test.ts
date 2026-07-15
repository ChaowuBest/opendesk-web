import fs from 'fs';
import os from 'os';
import path from 'path';
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

    test('serializes concurrent result writes without losing either status', async () => {
        const analyzer = makeAnalyzerWithTaskManager({ getTask: jest.fn() });
        const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-analyzer-status-'));
        const metaPath = path.join(skillDir, 'opendesk_meta.json');
        const testCases = [
            { index: 1, title: 'one', prompt: 'run one', expectedResult: 'works', status: 'pending' },
            { index: 2, title: 'two', prompt: 'run two', expectedResult: 'fails', status: 'pending' }
        ];

        try {
            fs.writeFileSync(metaPath, JSON.stringify({ testCases }), 'utf8');
            (analyzer as any).state = {
                ...makeRunningState(2),
                results: { 'skill-a': { testCases: testCases.map((testCase) => ({ ...testCase })) } }
            };

            await Promise.all([
                (analyzer as any)._updateTestCaseStatus(
                    'skill-a',
                    skillDir,
                    1,
                    { result: 'succeeded', message: 'done' },
                    'task-1'
                ),
                (analyzer as any)._updateTestCaseStatus(
                    'skill-a',
                    skillDir,
                    2,
                    {
                        result: 'failed',
                        message: 'boom',
                        failureReasonCategory: 'skill_implementation'
                    },
                    'task-2'
                )
            ]);

            const persisted = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            expect(persisted.testCases).toMatchObject([
                { index: 1, status: 'passed', actualResult: 'done', taskId: 'task-1' },
                {
                    index: 2,
                    status: 'failed',
                    error: 'boom',
                    failureReasonCategory: 'skill_implementation',
                    taskId: 'task-2'
                }
            ]);
            expect(analyzer.getStatus().results['skill-a'].testCases).toMatchObject(persisted.testCases);
            expect(fs.readdirSync(skillDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
        } finally {
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
    });

    test('does not update memory or the target file when atomic rename fails', async () => {
        const analyzer = makeAnalyzerWithTaskManager({ getTask: jest.fn() });
        const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-analyzer-rename-'));
        const metaPath = path.join(skillDir, 'opendesk_meta.json');
        const testCase = { index: 1, title: 'one', prompt: 'run', expectedResult: 'works', status: 'pending' };

        try {
            fs.writeFileSync(metaPath, JSON.stringify({ testCases: [testCase] }), 'utf8');
            (analyzer as any).state = {
                ...makeRunningState(1),
                results: { 'skill-a': { testCases: [{ ...testCase }] } }
            };
            jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('rename failed'));

            await expect(
                (analyzer as any)._updateTestCaseStatus(
                    'skill-a',
                    skillDir,
                    1,
                    { result: 'succeeded', message: 'done' },
                    'task-1'
                )
            ).rejects.toThrow('rename failed');

            expect(JSON.parse(fs.readFileSync(metaPath, 'utf8')).testCases[0].status).toBe('pending');
            expect(analyzer.getStatus().results['skill-a'].testCases?.[0]).toMatchObject({ status: 'pending' });
            expect(fs.readdirSync(skillDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
        } finally {
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
    });

    test('commits repeated writes to one case in call order', async () => {
        const analyzer = makeAnalyzerWithTaskManager({ getTask: jest.fn() });
        const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-analyzer-order-'));
        const metaPath = path.join(skillDir, 'opendesk_meta.json');
        const testCase = { index: 1, title: 'one', prompt: 'run', expectedResult: 'works', status: 'pending' };

        try {
            fs.writeFileSync(metaPath, JSON.stringify({ testCases: [testCase] }), 'utf8');
            (analyzer as any).state = {
                ...makeRunningState(1),
                results: { 'skill-a': { testCases: [{ ...testCase }] } }
            };

            const failedWrite = (analyzer as any)._updateTestCaseStatus('skill-a', skillDir, 1, {
                result: 'failed',
                message: 'first result',
                failureReasonCategory: 'external_service'
            });
            const passedWrite = (analyzer as any)._updateTestCaseStatus('skill-a', skillDir, 1, {
                result: 'succeeded',
                message: 'second result'
            });
            await Promise.all([failedWrite, passedWrite]);

            const persisted = JSON.parse(fs.readFileSync(metaPath, 'utf8')).testCases[0];
            expect(persisted).toMatchObject({ status: 'passed', actualResult: 'second result' });
            expect(persisted.error).toBeUndefined();
            expect(analyzer.getStatus().results['skill-a'].testCases?.[0]).toMatchObject(persisted);
        } finally {
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
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
