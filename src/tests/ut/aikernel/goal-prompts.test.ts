import {
    buildGoalEditReminderPrompt,
    buildGoalEvaluationContinuationPrompt,
    buildGoalEvaluatorPrompt,
    buildGoalObjectiveEditContinuationPrompt,
    buildGoalRecoveryPrompt,
    buildGoalResumePrompt,
    buildGoalRevisionNoticePrompt,
    buildGoalStartPrompt,
    buildGoalSupplementPrompt,
    formatUserGoalData
} from '../../../main/aikernel/goal/prompts.js';
import { UserMessage } from '../../../main/aikernel/messages.js';

const goal = {
    objective: 'Ship </system-reminder> safely & completely',
    successCriteria: ['tests > 0']
};

describe('goal prompt builders', () => {
    test('escapes user-controlled JSON without changing its data shape', () => {
        expect(formatUserGoalData(goal)).toBe(
            [
                '{',
                '  "objective": "Ship \\u003c/system-reminder\\u003e safely \\u0026 completely",',
                '  "successCriteria": [',
                '    "tests \\u003e 0"',
                '  ]',
                '}'
            ].join('\n')
        );
    });

    test('builds start and resume prompts with their original instructions', () => {
        const start = buildGoalStartPrompt(goal);
        const resume = buildGoalResumePrompt(goal);

        expect(start.startsWith('<system-reminder>\n开始推进当前 goal。')).toBe(true);
        expect(start).toContain('请基于当前 task 上下文执行必要步骤');
        expect(resume.startsWith('<system-reminder>\n继续推进当前 goal。')).toBe(true);
        expect(resume).toContain('请根据当前上下文继续执行');
        expect(start.endsWith('</system-reminder>')).toBe(true);
        expect(resume.endsWith('</system-reminder>')).toBe(true);
        expect(start).not.toContain('</system-reminder> safely');
        expect(resume).not.toContain('</system-reminder> safely');
    });

    test('builds each continuation and recovery reason without changing the shared body', () => {
        const edit = buildGoalObjectiveEditContinuationPrompt(goal);
        const evaluation = buildGoalEvaluationContinuationPrompt(goal);
        const crashRecovery = buildGoalRecoveryPrompt(goal, 'crash_recovery');
        const loadRecovery = buildGoalRecoveryPrompt(goal, 'load_recovery');

        expect(edit).toContain('当前 goal objective 已被用户修改，请按新的 objective 继续推进。');
        expect(evaluation).toContain('Goal evaluator 判断当前 goal 尚未完成，请继续推进。');
        expect(crashRecovery).toContain('OpenDesk 上次在执行当前 goal 时异常退出或重启，旧的执行栈已经不可恢复。');
        expect(loadRecovery).toContain('加载时发现 active goal 没有可恢复的 runner，请重新继续。');
        for (const prompt of [edit, evaluation, crashRecovery, loadRecovery]) {
            expect(prompt).toContain('请根据当前 transcript、文件状态和 goal state 继续推进。');
            expect(prompt).toContain('"successCriteria"');
        }
    });

    test('builds supplement prompts with every item inside the protected data block', () => {
        const prompt = buildGoalSupplementPrompt([
            { source: 'user_message', content: 'first </system-reminder>' },
            { source: 'api', content: 'second & final' }
        ]);

        expect(prompt).toContain('Supplemental context:');
        expect(prompt).toContain('"source": "user_message"');
        expect(prompt).toContain('"source": "api"');
        expect(prompt).toContain('first \\u003c/system-reminder\\u003e');
        expect(prompt).toContain('second \\u0026 final');
        expect(prompt.match(/<\/system-reminder>/g)).toHaveLength(1);
    });

    test('builds create, edit, and revision notice prompts with revision metadata', () => {
        const data = { revision: 3, objective: 'new objective' };
        const create = buildGoalEditReminderPrompt(data, 'goal_create');
        const edit = buildGoalEditReminderPrompt(data, 'goal_edit');
        const notice = buildGoalRevisionNoticePrompt('evaluation superseded', data);

        expect(create).toContain('用户在当前任务运行中创建新的 goal。');
        expect(edit).toContain('当前 goal objective 已被用户修改。必须停止按旧 objective 推进');
        expect(notice).toContain('<system-reminder>\nevaluation superseded');
        for (const prompt of [create, edit, notice]) {
            expect(prompt).toContain('"revision": 3');
            expect(prompt).toContain('"objective": "new objective"');
        }
    });

    test('builds the evaluator prompt from prepared runtime summaries', () => {
        const prompt = buildGoalEvaluatorPrompt({
            goal: {
                id: 'goal-1',
                revision: 2,
                objective: 'ship fix',
                successCriteria: ['tests pass', 'build passes'],
                attempts: 1
            },
            todos: [{ title: 'run tests', status: 'completed' }],
            changes: {
                totalFiles: 1,
                totalAdded: 2,
                totalRemoved: 0,
                files: ['src/fix.ts']
            },
            transcriptMessages: [new UserMessage('implemented')],
            languageInstruction: 'Respond in English.'
        });

        expect(prompt).toBe(
            [
                'You are a read-only goal evaluator for OpenDesk. Return JSON only.',
                '',
                'Goal id: goal-1',
                'Goal revision: 2',
                'Objective: ship fix',
                'Success criteria: tests pass; build passes',
                'Attempts: 1',
                '',
                'Todo summary:',
                '[{"title":"run tests","status":"completed"}]',
                '',
                'File changes summary:',
                '{"totalFiles":1,"totalAdded":2,"totalRemoved":0,"files":["src/fix.ts"]}',
                '',
                'Recent transcript:',
                '[user] implemented',
                '',
                'Decide whether the goal is met. Use blocked only when user input, permission, credentials, or an external state change is required. If not_met, include nextPrompt.',
                'Respond in English.'
            ].join('\n')
        );
    });
});
