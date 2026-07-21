/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * 职责：将 Workflow 终态结果排队投递回宿主 Task。
 */

import type { TaskState } from '../../../aikernel/states/tasks.js';
import type { WorkflowRun } from '../../../aikernel/workflow.js';

type WorkflowDeliveryTask = Pick<TaskState, 'task_status' | 'waitUntilFinished' | 'startInternalTurn'>;

export interface WorkflowDeliveryTaskManager {
    getTask(taskId: string): WorkflowDeliveryTask | undefined;
}

export class WorkflowRunDelivery {
    private readonly deliveryChains = new Map<string, Promise<void>>();

    constructor(private readonly taskManager: WorkflowDeliveryTaskManager) {}

    enqueue(run: WorkflowRun): void {
        const previous = this.deliveryChains.get(run.hostTaskId) ?? Promise.resolve();
        const delivery = previous
            .catch(() => undefined)
            .then(() => deliverWorkflowRun(this.taskManager, run))
            .finally(() => {
                if (this.deliveryChains.get(run.hostTaskId) === delivery) {
                    this.deliveryChains.delete(run.hostTaskId);
                }
            });
        this.deliveryChains.set(run.hostTaskId, delivery);
    }
}

export async function deliverWorkflowRun(taskManager: WorkflowDeliveryTaskManager, run: WorkflowRun): Promise<void> {
    let task = taskManager.getTask(run.hostTaskId);
    if (!task) {
        return;
    }
    if (task.task_status === 'running' || task.task_status === 'waiting') {
        await task.waitUntilFinished();
    }
    task = taskManager.getTask(run.hostTaskId);
    if (!task) {
        return;
    }
    await task.startInternalTurn({
        prompt: buildDeliveryPrompt(run),
        source: 'application',
        metadata: {
            scope: 'global',
            origin: {
                source: 'system',
                reason: 'workflow_completed'
            },
            execution: {
                controller: 'system',
                controllerId: run.id
            }
        }
    });
}

function buildDeliveryPrompt(run: WorkflowRun): string {
    const terminal =
        run.status === 'succeeded'
            ? { output: run.output }
            : {
                  failure: run.failure ?? {
                      code: 'runtime_failed',
                      message: run.error ?? 'Workflow failed without an error message.'
                  }
              };
    return [
        '<system-reminder>',
        `Workflow“${run.definition.name}”（${run.id}）已到达终态，status="${run.status}"。`,
        '本次内部回合负责向用户交付本次 Workflow 的终态结果。',
        '请结合下方结果和当前对话上下文，使用当前对话语言忠实汇报结果、置信度、局限和可选下一步，然后结束本回合。',
        '',
        JSON.stringify(terminal, null, 2),
        '</system-reminder>'
    ].join('\n');
}
