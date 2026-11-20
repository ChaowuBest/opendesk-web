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

import type { TaskManagerState } from '../../aikernel/task/manager.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import { GoalController } from '../../aikernel/goal/controller.js';
import { GoalService } from '../../aikernel/goal/service.js';
import type { GoalCommandResult } from '../../aikernel/goal/state.js';
import { getTaskTodosForDisplay } from '../../aikernel/todos/task-todos.js';
import { ApplicationRegistry } from '../registry.js';
import { parseGoalEditIfMatch } from '../../../common/goal/command.js';

/** Shared GUI policy around the domain goal service, independent of its caller's transport. */
export function createGuiGoalOperations(manager: Pick<TaskManagerState, 'getTask'>) {
    const run = async <T>(taskId: string, action: (task: TaskState) => T | Promise<T>) => {
        const task = manager.getTask(taskId);
        if (!task) return { status: 'error' as const, message: `task ${taskId} not found` };
        return { status: 'ok' as const, data: await action(task) };
    };
    return {
        getGoalStatus: (taskId: string) => run(taskId, (task) => GoalController.getStatus(task)),
        createGoal: (taskId: string, objective: unknown) =>
            run(taskId, async (task): Promise<GoalCommandResult> => {
                const goal = task.goal_state;
                if (goal && goal.status !== 'complete' && goal.status !== 'cleared') {
                    return {
                        ok: false,
                        status: goal.status,
                        messageKey: 'goal.create.requires_clear',
                        errorCode: 'goal_exists'
                    };
                }
                const result = await GoalService.create(
                    task,
                    { objective: String(objective ?? ''), source: 'gui' },
                    {
                        projectDisplayMessage: true
                    }
                );
                const response: GoalCommandResult =
                    result.ok === false && result.errorCode === 'task_running' && task.goal_state?.status === 'active'
                        ? {
                              ok: true,
                              status: task.goal_state.status,
                              summary: GoalController.getStatus(task).summary,
                              startedScheduler: false
                          }
                        : result;
                if (response.clearedTaskTodos) {
                    ApplicationRegistry.dispatchEvent('todomgr', 'taskTodosUpdated', { taskId, todos: [] });
                }
                return response;
            }),
        editGoal: (taskId: string, objective: unknown, options?: unknown) =>
            run(taskId, async (task): Promise<GoalCommandResult> => {
                const rawIfMatch =
                    options && typeof options === 'object' && !Array.isArray(options)
                        ? (options as Record<string, unknown>).ifMatch
                        : undefined;
                const ifMatch = parseGoalEditIfMatch(rawIfMatch);
                if (rawIfMatch !== undefined && !ifMatch) {
                    return {
                        ok: false,
                        messageKey: 'goal.edit.invalid_precondition',
                        errorCode: 'invalid_goal_precondition'
                    };
                }
                return GoalService.edit(task, String(objective ?? ''), 'gui', {
                    projectDisplayMessage: true,
                    ...(ifMatch ? { ifMatch } : {})
                });
            }),
        addGoalSupplement: (taskId: string, content: unknown) =>
            run(taskId, (task) =>
                GoalService.addSupplement(task, {
                    content: String(content ?? ''),
                    source: 'gui'
                })
            ),
        pauseGoal: (taskId: string) => run(taskId, (task) => GoalService.pause(task, 'gui')),
        resumeGoal: (taskId: string) => run(taskId, (task) => GoalService.resume(task, { source: 'gui' })),
        clearGoal: (taskId: string) =>
            run(taskId, async (task) => {
                const result = await GoalService.clear(task, 'gui');
                ApplicationRegistry.dispatchEvent('todomgr', 'taskTodosUpdated', {
                    taskId,
                    todos: getTaskTodosForDisplay(taskId)
                });
                return result;
            }),
        async stopTask(taskId: string) {
            const task = manager.getTask(taskId);
            if (!task) return { status: 'error' as const, message: `task ${taskId} not found` };
            if (task.goal_state?.status === 'active') {
                return { status: 'ok' as const, data: await GoalService.stopActiveGoal(task, 'gui') };
            }
            task.stop();
            return { status: 'ok' as const };
        }
    };
}

export type GuiGoalOperations = ReturnType<typeof createGuiGoalOperations>;
