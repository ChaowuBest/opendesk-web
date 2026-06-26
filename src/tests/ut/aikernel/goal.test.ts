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
import { GoalEvents, GoalStates, createGoalEvent } from '../../../main/aikernel/goal/state.js';
import {
    AssistantMessage,
    CompactSeparatorMessage,
    ToolCall,
    ToolCallMessagePart,
    Usage,
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
        expect(GoalEvents.getTail(task.goal_event_log).map((event) => event.type)).toContain('created');
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
        GoalController.pause(task, 'tui');
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

    test('resume note is recorded and injected only into the resumed turn', async () => {
        const task = createTask();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        jest.spyOn(task, 'processTaskTurn').mockResolvedValue();
        GoalController.create(task, { objective: 'goal', source: 'tui' });
        GoalController.pause(task, 'tui');
        task.task_status = 'stopped';

        const result = await GoalService.resume(task, { source: 'tui', note: '我已经修复了网络，重试搜索' });

        expect(result.ok).toBe(true);
        expect(task.goal_state?.objective).toBe('goal');
        expect(task.goal_state?.revision).toBe(1);
        const resumedEvent = GoalEvents.getTail(task.goal_event_log).find((event) => event.type === 'resumed');
        expect(resumedEvent?.payload).toEqual({ note: '我已经修复了网络，重试搜索' });
        expect((task.chat_context.messages[0] as any).getPlainText()).toContain('我已经修复了网络，重试搜索');
    });

    test('resume starts after a pending pause interrupt settles', async () => {
        const task = createTask();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        const processSpy = jest.spyOn(task, 'processTaskTurn').mockResolvedValue();
        GoalController.create(task, { objective: 'goal', source: 'tui' });
        GoalController.pause(task, 'tui');
        task.task_status = 'stopped';
        task.runtimeInterrupt = {
            requested: true,
            reason: 'goal_pause',
            requestedAt: new Date().toISOString()
        };

        jest.useFakeTimers();
        setTimeout(() => {
            task.runtimeInterrupt = undefined;
        }, 100);
        const resultPromise = GoalService.resume(task, { source: 'gui' });
        await jest.advanceTimersByTimeAsync(150);
        const result = await resultPromise;
        jest.useRealTimers();

        expect(result.ok).toBe(true);
        expect(result.startedScheduler).toBe(true);
        expect(task.goal_state?.status).toBe('active');
        expect(task.task_status).toBe('running');
        expect(processSpy).toHaveBeenCalledTimes(1);
        expect(GoalEvents.getTail(task.goal_event_log).map((event) => event.type)).toContain('resumed');
    });

    test('resume does not change goal state while a pause interrupt remains pending', async () => {
        const task = createTask();
        const processSpy = jest.spyOn(task, 'processTaskTurn').mockResolvedValue();
        GoalController.create(task, { objective: 'goal', source: 'tui' });
        GoalController.pause(task, 'tui');
        task.task_status = 'stopped';
        task.runtimeInterrupt = {
            requested: true,
            reason: 'goal_pause',
            requestedAt: new Date().toISOString()
        };

        jest.useFakeTimers();
        const resultPromise = GoalService.resume(task, { source: 'gui' });
        await jest.advanceTimersByTimeAsync(2_050);
        const result = await resultPromise;
        jest.useRealTimers();

        expect(result.ok).toBe(false);
        expect(result.messageKey).toBe('goal.resume.runner_stopping');
        expect(task.goal_state?.status).toBe('paused');
        expect(task.task_status).toBe('stopped');
        expect(processSpy).not.toHaveBeenCalled();
        expect(GoalEvents.getTail(task.goal_event_log).map((event) => event.type)).not.toContain('resumed');
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

    test('goal projection preserves full transcript while keeping goal-scoped history', () => {
        const task = createTask();
        GoalController.create(task, { objective: 'goal', source: 'tui' });
        const goalId = task.goal_state!.id;

        const goalMessage = new UserMessage('goal work');
        goalMessage.metadata = {
            scope: 'goal',
            execution: { controller: 'goal', controllerId: goalId, controllerRevision: 1 }
        };
        const sideMessage = new UserMessage('paused side chat');
        sideMessage.metadata = { scope: 'global' };
        const otherGoalMessage = new UserMessage('other goal work');
        otherGoalMessage.metadata = {
            scope: 'goal',
            execution: { controller: 'goal', controllerId: 'other-goal', controllerRevision: 1 }
        };
        const compact = new CompactSeparatorMessage('mixed summary', {
            projection: {
                projectionPolicy: 'mixed_scoped',
                summarizedScopes: ['global', 'goal'],
                summarizedGoalIds: [goalId, 'other-goal']
            },
            summarySegments: [
                { scope: 'global', text: 'global compact context' },
                { scope: 'goal', goalId, text: 'current goal compact context' },
                { scope: 'goal', goalId: 'other-goal', text: 'other goal compact context' }
            ]
        });
        const legacyCompact = new CompactSeparatorMessage('legacy compact without provenance');

        task.chat_context.appendMessage(goalMessage);
        task.chat_context.appendMessage(sideMessage);
        task.chat_context.appendMessage(otherGoalMessage);
        task.chat_context.appendMessage(compact);
        task.chat_context.appendMessage(legacyCompact);

        const projected = buildGoalContextProjection(task);
        const text = projected.messages
            .map((message: any) => message.summary ?? message.getPlainText?.() ?? '')
            .join('\n');

        expect(text).toContain('goal work');
        expect(text).toContain('other goal work');
        expect(text).toContain('paused side chat');
        expect(text).toContain('mixed summary');
        expect(text).toContain('legacy compact without provenance');
    });

    test('prepareContextForModel honors goal active context override', async () => {
        const task = createTask();
        GoalController.create(task, { objective: 'goal', source: 'tui' });
        const goalMessage = new UserMessage('goal-visible');
        goalMessage.metadata = {
            scope: 'goal',
            execution: { controller: 'goal', controllerId: task.goal_state!.id, controllerRevision: 1 }
        };
        const sideMessage = new UserMessage('side-visible');
        sideMessage.metadata = { scope: 'global' };
        task.chat_context.appendMessage(goalMessage);
        task.chat_context.appendMessage(sideMessage);

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
        expect(text).toContain('side-visible');
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

        expect(firstResult).toEqual({ action: 'finish', status: 'budget_limited' });
        expect(task.goal_state?.status).toBe('budget_limited');
        expect(task.goal_state?.attempts).toBe(2);
        expect(task.goal_state?.oneShotBudgetOverride?.consumedAt).toBeDefined();
        expect(task.goal_state?.oneShotBudgetOverride?.consumedReason).toBe('max_attempts_exceeded');
        expect(task.goal_state?.budgetLimitedReason).toBe('max_attempts_exceeded');
        expect(task.goal_state?.pendingContinuation?.reason).toBe('max_attempts_exceeded');

        const secondResult = GoalController.recordEvaluation(task, {
            goalId: task.goal_state!.id,
            goalRevision: task.goal_state!.revision,
            status: 'not_met',
            reason: 'still not done again',
            evidence: ['needs more work'],
            nextPrompt: 'another step',
            evaluatedAt: new Date().toISOString()
        });

        // 第二次调用时 goal 已处于 budget_limited，守卫条件直接返回 finish
        expect(secondResult).toEqual({ action: 'finish', status: 'budget_limited' });
        expect(task.goal_state?.status).toBe('budget_limited');
        expect(task.goal_state?.budgetLimitedReason).toBe('max_attempts_exceeded');
        expect(task.goal_state?.pendingContinuation?.reason).toBe('max_attempts_exceeded');
    });

    test('new goal resets token budget baseline so prior goal usage is not counted', () => {
        const task = createTask();
        // 第一个 goal：创建时 chat_context 为空，baseline 为 0
        GoalController.create(task, {
            objective: 'goal-1',
            source: 'tui',
            tokenBudget: { maxTotalTokens: 5000 }
        });
        const goal1 = task.goal_state!;
        expect(goal1.tokenUsageBaseline).toBe(0);

        // 模拟 goal-1 执行期间产生的 assistant token（3000）
        const assistant1 = new AssistantMessage();
        assistant1.usage = Usage.fromRaw({ total_tokens: 3000 });
        task.chat_context.appendMessage(assistant1);

        // 完成第一个 goal，使其进入终态，才允许创建第二个
        goal1.status = 'complete';
        goal1.completedAt = new Date().toISOString();

        // 创建第二个 goal：baseline 应快照旧 goal 已累积的 3000 token
        GoalController.create(task, {
            objective: 'goal-2',
            source: 'tui',
            tokenBudget: { maxTotalTokens: 5000 }
        });
        const goal2 = task.goal_state!;
        expect(goal2.tokenUsageBaseline).toBe(3000);

        // 新 goal 尚未产生新 token，预算检查应从 0 计起，不触发限制
        expect(GoalController.checkBudgetBoundary(task)).toBe(false);
        expect(goal2.tokenBudget?.usedTotalTokens).toBe(0);
        expect(goal2.status).toBe('active');

        // goal-2 执行产生 2000 token：增量 2000，仍未达上限
        const assistant2 = new AssistantMessage();
        assistant2.usage = Usage.fromRaw({ total_tokens: 2000 });
        task.chat_context.appendMessage(assistant2);
        expect(GoalController.checkBudgetBoundary(task)).toBe(false);
        expect(goal2.tokenBudget?.usedTotalTokens).toBe(2000);

        // 再产生 3000 token：增量累计达 5000，触发 token 预算限制
        const assistant3 = new AssistantMessage();
        assistant3.usage = Usage.fromRaw({ total_tokens: 3000 });
        task.chat_context.appendMessage(assistant3);
        expect(GoalController.checkBudgetBoundary(task)).toBe(true);
        expect(goal2.status).toBe('budget_limited');
        expect(goal2.budgetLimitedReason).toBe('token_budget_exceeded');
        expect(goal2.tokenBudget?.usedTotalTokens).toBe(5000);
    });

    test('completed goal resets token time and turn usage counters', () => {
        const task = createTask();
        GoalController.create(task, {
            objective: 'goal',
            source: 'tui',
            maxAttempts: 5,
            tokenBudget: { maxTotalTokens: 10_000 },
            timeBudgetMs: 60_000
        });
        const goal = task.goal_state!;
        goal.attempts = 3;
        goal.startedAt = '2026-01-01T00:00:00.000Z';
        const assistant = new AssistantMessage();
        assistant.usage = Usage.fromRaw({ total_tokens: 1234 });
        task.chat_context.appendMessage(assistant);

        const result = GoalController.recordEvaluation(task, {
            goalId: goal.id,
            goalRevision: goal.revision,
            status: 'met',
            reason: 'done',
            evidence: ['verified'],
            evaluatedAt: new Date().toISOString()
        });

        expect(result).toEqual({ action: 'finish', status: 'complete' });
        expect(goal.status).toBe('complete');
        expect(goal.attempts).toBe(0);
        expect(goal.tokenBudget?.usedTotalTokens).toBe(0);
        expect(goal.tokenUsageBaseline).toBe(1234);
        expect(goal.startedAt).toBe(goal.completedAt);
        const summary = GoalController.getStatus(task).summary;
        expect(summary?.attempts).toBe(0);
        expect(summary?.tokenBudget?.usedTotalTokens).toBe(0);
    });

    test('forked goal resets token usage baseline to forked task snapshot', () => {
        const sourceTask = createTask();
        GoalController.create(sourceTask, { objective: 'goal', source: 'tui' });
        // 模拟源 goal 执行产生的 token
        const assistant = new AssistantMessage();
        assistant.usage = Usage.fromRaw({ total_tokens: 4000 });
        sourceTask.chat_context.appendMessage(assistant);

        const forkedTask = sourceTask.fork();
        const forkedGoal = forkedTask.goal_state!;
        // fork 后 chat_context 是源 task 的快照副本，baseline 应等于当前累计（4000），
        // 使 forked goal 重新独立计量 token 消耗
        expect(forkedGoal.tokenUsageBaseline).toBe(4000);
        expect(forkedGoal.status).toBe('blocked');
        expect(forkedGoal.blockedReason).toBe('forked_history_requires_goal_review');
    });

    test('event log rolls over to tail and artifact after inline limit', () => {
        const root = createTempAppDirectory();
        const task = createTask();
        GoalController.create(task, { objective: 'goal', source: 'tui' });
        const goal = task.goal_state!;

        for (let index = 0; index < 205; index += 1) {
            GoalEvents.appendToTask(task, createGoalEvent(goal, 'evaluated', 'evaluator', { index }));
        }

        expect(task.goal_event_log?.mode).toBe('artifact');
        expect(GoalEvents.getTail(task.goal_event_log)).toHaveLength(200);
        expect(task.goal_event_log?.mode === 'artifact' ? task.goal_event_log.artifactPath : undefined).toBe(
            `artifacts/${task.task_id}/goal/events.jsonl`
        );
        const artifactPath = path.join(root, 'artifacts', task.task_id, 'goal', 'events.jsonl');
        expect(fs.existsSync(artifactPath)).toBe(true);
        expect(fs.readFileSync(artifactPath, 'utf8').trim().split('\n')).toHaveLength(206);
    });

    test('render JSON exposes safe goal summary without event payload or artifact path', () => {
        const task = createTask();
        GoalController.create(task, { objective: 'goal', source: 'tui', maxAttempts: 3 });
        GoalEvents.appendToTask(
            task,
            createGoalEvent(task.goal_state!, 'evaluated', 'evaluator', { rawEvidence: 'hidden' })
        );

        const rendered = task.toRenderJSON() as any;

        expect(rendered.goal.objective).toBe('goal');
        expect(rendered.goal.attempts).toBe(0);
        expect(rendered.goal.maxAttempts).toBe(3);
        expect(rendered.goal.recentEvents.at(-1)).toEqual({
            type: 'evaluated',
            revision: 1,
            timestamp: expect.any(String),
            source: 'evaluator'
        });
        expect(JSON.stringify(rendered.goal)).not.toContain('rawEvidence');
        expect(JSON.stringify(rendered.goal)).not.toContain('artifactPath');

        GoalController.clear(task, 'gui');
        expect(GoalStates.renderSummary(task.goal_state)).toBeUndefined();
        expect((task.toRenderJSON() as any).goal.status).toBe('cleared');

        // 终态不再因保留期过期而消失：即使 cleared 已超过原保留期，render JSON 仍返回 cleared summary
        const oldClearedAt = new Date(Date.now() - 31_000).toISOString();
        task.goal_state!.clearedAt = oldClearedAt;
        task.goal_state!.updatedAt = oldClearedAt;
        expect((task.toRenderJSON() as any).goal).not.toBeUndefined();
        expect((task.toRenderJSON() as any).goal.status).toBe('cleared');
    });

    test('status summary keeps objective timeline events for active refresh', () => {
        const task = createTask();
        GoalController.create(task, { objective: 'initial goal objective', source: 'gui' });
        GoalController.editObjective(task, 'updated goal objective', 'gui');
        for (let index = 0; index < 12; index += 1) {
            GoalEvents.appendToTask(task, createGoalEvent(task.goal_state!, 'evaluated', 'evaluator', { index }));
        }

        const summary = GoalController.getStatus(task).summary as any;

        expect(summary.recentEvents).toHaveLength(8);
        expect(summary.recentEvents.at(-1).type).toBe('evaluated');
        expect(summary.objectiveEvents).toEqual([
            expect.objectContaining({
                type: 'created',
                objective: 'initial goal objective'
            }),
            expect.objectContaining({
                type: 'edited',
                objective: 'updated goal objective',
                previousObjective: 'initial goal objective'
            })
        ]);
    });

    test('creating a goal names an unnamed task from the objective', () => {
        const task = createTask();

        GoalController.create(task, { objective: 'ship the goal sidebar timeline fix', source: 'gui' });

        expect(task.task_name).toBe('ship the goal sidebar timeline fix');

        task.task_name = 'Existing task title';
        GoalController.clear(task, 'gui');
        GoalController.create(task, { objective: 'replacement objective', source: 'gui' });

        expect(task.task_name).toBe('Existing task title');

        const placeholderTask = createTask();
        placeholderTask.task_name = '未命名任务';
        GoalController.create(placeholderTask, { objective: 'goal derived from placeholder', source: 'gui' });

        expect(placeholderTask.task_name).toBe('goal derived from placeholder');
    });

    test('load migrates legacy event log tail over legacy full event log when both exist', () => {
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

        expect(loaded.goal_event_log?.mode).toBe('artifact');
        expect(GoalEvents.getTail(loaded.goal_event_log)).toHaveLength(1);
        expect(GoalEvents.getTail(loaded.goal_event_log)[0].payload).toEqual({ source: 'tail' });
        expect(loaded.toJSON()).not.toHaveProperty('goal_event_log_tail');
        expect(loaded.toJSON()).not.toHaveProperty('goal_event_log_artifact');
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
        const forkedEvents = GoalEvents.getTail(forkedTask.goal_event_log);
        expect(forkedEvents.at(-1)?.type).toBe('forked');
        expect(forkedEvents.at(-1)?.payload).toEqual({
            forkedFromGoalId: sourceGoalId,
            sourceTaskId: sourceTask.task_id
        });
    });

    test('blocked goal rejects unrelated user messages at shared submit entry', async () => {
        const task = createTask();
        GoalController.create(task, { objective: 'goal', source: 'tui' });
        task.goal_state!.status = 'blocked';
        task.goal_state!.blockedReason = 'needs_credentials';

        const result = await task.submitUserMessage('换个话题聊一下');

        expect(result).toEqual({ status: 'error', messageKey: 'goal.blocked.unrelated_message' });
        expect(task.goal_state?.status).toBe('blocked');
        expect(task.chat_context.messages).toHaveLength(0);
    });

    test('paused goal resumes from a plain resume user message', async () => {
        const task = createTask();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        const processSpy = jest.spyOn(task, 'processTaskTurn').mockResolvedValue();
        GoalController.create(task, { objective: 'goal', source: 'tui' });
        GoalController.pause(task, 'tui');
        task.task_status = 'stopped';
        task.goal_state!.pendingContinuation = {
            id: 'paused-continuation',
            goalId: task.goal_state!.id,
            goalRevision: task.goal_state!.revision,
            prompt: 'resume paused goal',
            reason: 'manual_pause',
            createdAt: new Date().toISOString()
        };

        const result = await task.submitUserMessage('resume');

        expect(result).toEqual({ status: 'ok' });
        expect(task.goal_state?.status).toBe('active');
        expect(task.goal_state?.pendingContinuation?.consumedAt).toBeDefined();
        expect(task.task_status).toBe('running');
        expect(processSpy).toHaveBeenCalledTimes(1);
        expect((task.chat_context.messages[0] as any).internal).toBe(true);
        expect((task.chat_context.messages[0] as any).getPlainText()).toBe('resume paused goal');
    });
});
