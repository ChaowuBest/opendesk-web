import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { createAutoCompactDecision } from '../../../main/aikernel/compaction/auto-compact.js';
import { buildActiveContextView } from '../../../main/aikernel/compaction/context-view.js';
import { prepareContextForModel } from '../../../main/aikernel/compaction/pipeline.js';
import { HookRegistry } from '../../../main/aikernel/hooks.js';
import { GoalController } from '../../../main/aikernel/goal/controller.js';
import { buildGoalContextProjection } from '../../../main/aikernel/goal/projection.js';
import { GoalService } from '../../../main/aikernel/goal/service.js';
import { GoalEvents, createGoalEvent } from '../../../main/aikernel/goal/state.js';
import {
    AssistantMessage,
    CompactSeparatorMessage,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

let tempRootDir: string | undefined;

function createTempAppDirectory(): string {
    tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-goal-test-'));
    setCustomOpendeskDirectory(tempRootDir);
    return tempRootDir;
}

function cleanupTempAppDirectory(): void {
    setCustomOpendeskDirectory(undefined);
    if (tempRootDir && fs.existsSync(tempRootDir)) {
        fs.rmSync(tempRootDir, { recursive: true, force: true });
    }
    tempRootDir = undefined;
}

function resetHookRegistry(): void {
    HookRegistry.beforeFinishTurnCallbacks = [];
    HookRegistry.afterFinishTurnCallbacks = [];
    HookRegistry.beforeTaskStartCallbacks = [];
    HookRegistry.onTaskReviewCallbacks = [];
    HookRegistry.afterParseToolcallCallbacks = [];
    HookRegistry.beforeToolCallCallbacks = [];
    HookRegistry.afterToolCallCallbacks = [];
    HookRegistry.beforeTurnStartCallbacks = [];
    HookRegistry.afterProcessCompletionCallbacks = [];
}

function createTask(): TaskState {
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();
    const task = new TaskState(manager);
    manager.tasks.push(task);
    return task;
}

describe('goal controller and scheduler', () => {
    beforeEach(() => {
        resetHookRegistry();
    });

    afterEach(() => {
        resetHookRegistry();
        jest.restoreAllMocks();
        cleanupTempAppDirectory();
    });

    test('create persists goal state and starts an internal goal turn with metadata', async () => {
        const task = createTask();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        const processSpy = jest.spyOn(task, 'processTaskTurn').mockResolvedValue();

        const result = await GoalService.create(task, { objective: '修复导出问题', source: 'tui' });

        expect(result.ok).toBe(true);
        expect(result.startedScheduler).toBe(true);
        expect(task.goal_state?.status).toBe('active');
        expect(task.goal_state?.revision).toBe(1);
        expect(task.goal_event_log?.map((event) => event.type)).toContain('created');
        expect(task.task_status).toBe('running');
        expect(processSpy).toHaveBeenCalledTimes(1);

        const user = task.chat_context.messages[0] as any;
        expect(user.internal).toBe(true);
        expect(user.metadata.execution.controller).toBe('goal');
        expect(user.metadata.execution.controllerRevision).toBe(1);
        expect(user.getPlainText()).toContain('开始推进当前 goal');
    });

    test('edit increments revision and clears stale evaluation and continuation', () => {
        const task = createTask();
        GoalController.create(task, { objective: 'old', source: 'tui' });
        task.goal_state!.lastEvaluation = {
            goalId: task.goal_state!.id,
            goalRevision: 1,
            status: 'not_met',
            reason: 'old',
            evidence: [],
            nextPrompt: 'continue',
            evaluatedAt: new Date().toISOString()
        };
        task.goal_state!.pendingContinuation = {
            id: 'cont',
            goalId: task.goal_state!.id,
            goalRevision: 1,
            prompt: 'continue',
            reason: 'not_met',
            createdAt: new Date().toISOString()
        };

        const result = GoalController.editObjective(task, 'new', 'tui');

        expect(result.ok).toBe(true);
        expect(task.goal_state?.objective).toBe('new');
        expect(task.goal_state?.revision).toBe(2);
        expect(task.goal_state?.lastEvaluation).toBeUndefined();
        expect(task.goal_state?.pendingContinuation).toBeUndefined();
    });

    test('pending continuation is consumed once on resume', async () => {
        const task = createTask();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(task, 'processTaskTurn').mockResolvedValue();
        GoalController.create(task, { objective: 'goal', source: 'tui' });
        GoalController.pause(task, 'pause', 'tui');
        task.task_status = 'stopped';
        task.goal_state!.pendingContinuation = {
            id: 'cont-1',
            goalId: task.goal_state!.id,
            goalRevision: task.goal_state!.revision,
            prompt: 'custom continuation',
            reason: 'not_met',
            createdAt: new Date().toISOString()
        };

        const result = await GoalService.resume(task, { source: 'tui' });

        expect(result.ok).toBe(true);
        expect(task.goal_state?.pendingContinuation?.consumedAt).toBeDefined();
        expect((task.chat_context.messages[0] as any).getPlainText()).toBe('custom continuation');
    });

    test('stale goal revision tool calls are skipped before permission or execution', async () => {
        const task = createTask();
        GoalController.create(task, { objective: 'goal', source: 'tui' });
        task.goal_state!.revision = 2;

        const assistant = new AssistantMessage();
        const part = new ToolCallMessagePart();
        const toolCall = new ToolCall(0, 'tc-1', 'missing-tool', '{}');
        toolCall.metadata = {
            scope: 'goal',
            execution: {
                controller: 'goal',
                controllerId: task.goal_state!.id,
                controllerRevision: 1
            }
        };
        part.push(toolCall);
        assistant.content.push(part);
        task.chat_context.appendMessage(assistant);

        await task.processToolCalls();

        expect(toolCall.status).toBe('error');
        expect(toolCall.result_object).toEqual({
            skipped: true,
            reason: 'stale_goal_revision',
            goalRevision: 1,
            currentGoalRevision: 2
        });
    });

    test('beforeFinishTurn priority orders task-local and global hooks together', async () => {
        const task = createTask();
        const calls: string[] = [];
        task.hooks.beforeFinishTurn(
            async () => {
                calls.push('task-late');
                return { operation: 'finish' };
            },
            { priority: 400 }
        );
        HookRegistry.beforeFinishTurn(
            async () => {
                calls.push('global-early');
                return { operation: 'finish' };
            },
            { priority: 100 }
        );

        await task.hooks.checkBeforeFinishTurn(task);

        expect(calls).toEqual(['global-early', 'task-late']);
    });

    test('goal projection filters interlude messages and compact summary segments', () => {
        const task = createTask();
        GoalController.create(task, { objective: 'goal', source: 'tui' });
        const goalId = task.goal_state!.id;

        const goalMessage = new UserMessage('goal work');
        goalMessage.metadata = {
            scope: 'goal',
            execution: { controller: 'goal', controllerId: goalId, controllerRevision: 1 }
        };
        const interludeMessage = new UserMessage('paused interlude secret');
        interludeMessage.metadata = { scope: 'interlude' };
        const otherGoalMessage = new UserMessage('other goal work');
        otherGoalMessage.metadata = {
            scope: 'goal',
            execution: { controller: 'goal', controllerId: 'other-goal', controllerRevision: 1 }
        };
        const compact = new CompactSeparatorMessage('mixed summary', {
            projection: {
                projectionPolicy: 'mixed_scoped',
                summarizedScopes: ['global', 'goal', 'interlude'],
                summarizedGoalIds: [goalId, 'other-goal'],
                containsInterlude: true
            },
            summarySegments: [
                { scope: 'global', text: 'global compact context' },
                { scope: 'goal', goalId, text: 'current goal compact context' },
                { scope: 'goal', goalId: 'other-goal', text: 'other goal compact context' },
                { scope: 'interlude', text: 'interlude compact secret' }
            ]
        });
        const legacyCompact = new CompactSeparatorMessage('legacy compact without provenance');

        task.chat_context.appendMessage(goalMessage);
        task.chat_context.appendMessage(interludeMessage);
        task.chat_context.appendMessage(otherGoalMessage);
        task.chat_context.appendMessage(compact);
        task.chat_context.appendMessage(legacyCompact);

        const projected = buildGoalContextProjection(task);
        const text = projected.messages
            .map((message: any) => message.summary ?? message.getPlainText?.() ?? '')
            .join('\n');

        expect(text).toContain('goal work');
        expect(text).toContain('global compact context');
        expect(text).toContain('current goal compact context');
        expect(text).not.toContain('paused interlude secret');
        expect(text).not.toContain('other goal work');
        expect(text).not.toContain('other goal compact context');
        expect(text).not.toContain('interlude compact secret');
        expect(text).not.toContain('legacy compact without provenance');
    });

    test('prepareContextForModel honors goal active context override', async () => {
        const task = createTask();
        GoalController.create(task, { objective: 'goal', source: 'tui' });
        const goalMessage = new UserMessage('goal-visible');
        goalMessage.metadata = {
            scope: 'goal',
            execution: { controller: 'goal', controllerId: task.goal_state!.id, controllerRevision: 1 }
        };
        const interludeMessage = new UserMessage('interlude-hidden');
        interludeMessage.metadata = { scope: 'interlude' };
        task.chat_context.appendMessage(goalMessage);
        task.chat_context.appendMessage(interludeMessage);

        const projected = buildGoalContextProjection(task);
        const preparation = await prepareContextForModel(task.chat_context, undefined, {
            activeContextOverride: buildActiveContextView(projected),
            autoCompactDecisionOverride: createAutoCompactDecision({
                contextWindow: 100_000,
                estimatedContextTokens: 10
            })
        });
        const text = preparation.activeContext.messages
            .map((message: any) => message.getPlainText?.() ?? '')
            .join('\n');

        expect(text).toContain('goal-visible');
        expect(text).not.toContain('interlude-hidden');
    });

    test('budget limited goal requires authorization before resume', async () => {
        const task = createTask();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(task, 'processTaskTurn').mockResolvedValue();
        GoalController.create(task, { objective: 'goal', source: 'tui', maxAttempts: 1 });
        task.task_status = 'stopped';
        task.goal_state!.status = 'budget_limited';
        task.goal_state!.attempts = 1;
        task.goal_state!.pendingContinuation = {
            id: 'budget-continuation',
            goalId: task.goal_state!.id,
            goalRevision: task.goal_state!.revision,
            prompt: 'continue after budget',
            reason: 'max_attempts_exceeded',
            createdAt: new Date().toISOString()
        };

        const rejected = await GoalService.resume(task, { source: 'tui' });
        expect(rejected.ok).toBe(false);
        expect(rejected.messageKey).toBe('goal.resume.requires_budget_authorization');
        expect(task.task_status).toBe('stopped');

        const resumed = await GoalService.resume(task, {
            source: 'api',
            budgetOverride: { maxAttemptsIncrement: 2, reason: 'test_override' }
        });

        expect(resumed.ok).toBe(true);
        expect(resumed.startedScheduler).toBe(true);
        expect(task.goal_state?.status).toBe('active');
        expect(task.goal_state?.maxAttempts).toBe(3);
        expect(task.goal_state?.pendingContinuation?.consumedAt).toBeDefined();
        expect(task.task_status).toBe('running');
    });

    test('one shot budget override only bypasses one budget boundary', async () => {
        const task = createTask();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(task, 'processTaskTurn').mockResolvedValue();
        GoalController.create(task, { objective: 'goal', source: 'tui', maxAttempts: 1 });
        task.task_status = 'stopped';
        task.goal_state!.status = 'budget_limited';
        task.goal_state!.attempts = 1;
        task.goal_state!.pendingContinuation = {
            id: 'one-shot-continuation',
            goalId: task.goal_state!.id,
            goalRevision: task.goal_state!.revision,
            prompt: 'continue once',
            reason: 'max_attempts_exceeded',
            createdAt: new Date().toISOString()
        };

        const resumed = await GoalService.resume(task, {
            source: 'api',
            budgetOverride: { oneShot: true, reason: 'manual one-shot' }
        });

        expect(resumed.ok).toBe(true);
        expect(task.goal_state?.status).toBe('active');
        expect(task.goal_state?.maxAttempts).toBe(1);
        expect(task.goal_state?.oneShotBudgetOverride?.consumedAt).toBeUndefined();

        const firstResult = GoalController.recordEvaluation(task, {
            goalId: task.goal_state!.id,
            goalRevision: task.goal_state!.revision,
            status: 'not_met',
            reason: 'still not done',
            evidence: ['needs another step'],
            nextPrompt: 'next step',
            evaluatedAt: new Date().toISOString()
        });

        expect(firstResult.action).toBe('continue');
        expect(task.goal_state?.status).toBe('active');
        expect(task.goal_state?.attempts).toBe(2);
        expect(task.goal_state?.oneShotBudgetOverride?.consumedAt).toBeDefined();
        expect(task.goal_state?.oneShotBudgetOverride?.consumedReason).toBe('max_attempts_exceeded');

        const secondResult = GoalController.recordEvaluation(task, {
            goalId: task.goal_state!.id,
            goalRevision: task.goal_state!.revision,
            status: 'not_met',
            reason: 'still not done again',
            evidence: ['needs more work'],
            nextPrompt: 'another step',
            evaluatedAt: new Date().toISOString()
        });

        expect(secondResult).toEqual({ action: 'finish', status: 'budget_limited' });
        expect(task.goal_state?.status).toBe('budget_limited');
        expect(task.goal_state?.budgetLimitedReason).toBe('max_attempts_exceeded');
        expect(task.goal_state?.pendingContinuation?.reason).toBe('max_attempts_exceeded');
    });

    test('event log rolls over to tail and artifact after inline limit', () => {
        const root = createTempAppDirectory();
        const task = createTask();
        GoalController.create(task, { objective: 'goal', source: 'tui' });
        const goal = task.goal_state!;

        for (let index = 0; index < 205; index += 1) {
            GoalEvents.appendToTask(task, createGoalEvent(goal, 'evaluated', 'evaluator', { index }));
        }

        expect(task.goal_event_log).toBeUndefined();
        expect(task.goal_event_log_tail).toHaveLength(200);
        expect(task.goal_event_log_artifact).toBe(`artifacts/${task.task_id}/goal/events.jsonl`);
        const artifactPath = path.join(root, 'artifacts', task.task_id, 'goal', 'events.jsonl');
        expect(fs.existsSync(artifactPath)).toBe(true);
        expect(fs.readFileSync(artifactPath, 'utf8').trim().split('\n')).toHaveLength(206);
    });

    test('load prefers event log tail over legacy full event log when both exist', () => {
        const root = createTempAppDirectory();
        const sourceTask = createTask();
        GoalController.create(sourceTask, { objective: 'goal', source: 'tui' });
        const legacyEvent = createGoalEvent(sourceTask.goal_state!, 'created', 'system', { source: 'legacy' });
        const tailEvent = createGoalEvent(sourceTask.goal_state!, 'edited', 'system', { source: 'tail' });
        const taskJsonPath = path.join(root, 'tasks', 'goal-load-tail.json');
        fs.mkdirSync(path.dirname(taskJsonPath), { recursive: true });
        fs.writeFileSync(
            taskJsonPath,
            JSON.stringify(
                {
                    task_id: 'goal-load-tail',
                    task_name: 'Goal load tail',
                    task_status: 'stopped',
                    chat_context: { messages: [] },
                    goal_state: { ...sourceTask.goal_state, taskId: 'goal-load-tail' },
                    goal_event_log: [legacyEvent],
                    goal_event_log_tail: [tailEvent],
                    goal_event_log_artifact: 'artifacts/goal-load-tail/goal/events.jsonl'
                },
                null,
                2
            )
        );

        const loaded = TaskState.load(taskJsonPath, new TaskManagerState());

        expect(loaded.goal_event_log).toBeUndefined();
        expect(loaded.goal_event_log_tail).toHaveLength(1);
        expect(loaded.goal_event_log_tail?.[0].payload).toEqual({ source: 'tail' });
    });

    test('forked unfinished goals get a new id and require explicit review', () => {
        const sourceTask = createTask();
        GoalController.create(sourceTask, { objective: 'goal', source: 'tui' });
        const sourceGoalId = sourceTask.goal_state!.id;
        sourceTask.goal_state!.schedulerLease = {
            id: 'lease-1',
            acquiredAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
            reason: 'resume'
        };
        sourceTask.goal_state!.pendingContinuation = {
            id: 'cont-1',
            goalId: sourceGoalId,
            goalRevision: sourceTask.goal_state!.revision,
            prompt: 'continue old fork context',
            reason: 'not_met',
            createdAt: new Date().toISOString()
        };

        const forkedTask = sourceTask.fork();

        expect(sourceTask.goal_state?.id).toBe(sourceGoalId);
        expect(sourceTask.goal_state?.status).toBe('active');
        expect(forkedTask.goal_state?.id).not.toBe(sourceGoalId);
        expect(forkedTask.goal_state?.taskId).toBe(forkedTask.task_id);
        expect(forkedTask.goal_state?.revision).toBe(sourceTask.goal_state?.revision);
        expect(forkedTask.goal_state?.status).toBe('blocked');
        expect(forkedTask.goal_state?.blockedReason).toBe('forked_history_requires_goal_review');
        expect(forkedTask.goal_state?.schedulerLease).toBeUndefined();
        expect(forkedTask.goal_state?.pendingContinuation).toBeUndefined();
        expect(forkedTask.goal_event_log?.at(-1)?.type).toBe('forked');
        expect(forkedTask.goal_event_log?.at(-1)?.payload).toEqual({
            forkedFromGoalId: sourceGoalId,
            sourceTaskId: sourceTask.task_id
        });
    });
});
