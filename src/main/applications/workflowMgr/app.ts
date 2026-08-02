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

/**
 * 职责：装配 Workflow 服务，并仅提供轻量的 Application 桥接。
 */

import { BaseApplication, type EventDecl } from '../base.js';
import type { Skill } from '../../aikernel/skill.js';
import type { WorkflowJSONValue, WorkflowRun } from '../../aikernel/workflow.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import { GlobalState } from '../../aikernel/states/global.js';
import { getArtifactDirectory } from '../../utils/setting.js';
import { t as appT } from './locale/index.js';
import { WorkflowAgentRunner } from './agent/runner.js';
import {
    WorkflowAuthoringService,
    type WorkflowAuthoringProgress,
    type WorkflowAuthoringResult
} from './authoring/service.js';
import { createBuiltinWorkflows } from './definitions/builtin.js';
import { WorkflowRunDelivery } from './run/delivery.js';
import { WorkflowManager, type AvailableWorkflowDefinition, type WorkflowLaunchResult } from './manager.js';
import { WorkflowRuntime } from './run/runtime/host.js';
import { createWorkflowSkills } from './tooling/skills.js';
import type { WorkflowRunSummary } from './storage.js';
import {
    LOAD_WORKFLOW_TOOLS_TOOL_NAME,
    type WorkflowStopResult,
    type WorkflowToolHost,
    type WorkflowLaunchTarget
} from './tooling/tools.js';

export class WorkflowMgrApplication extends BaseApplication implements WorkflowToolHost {
    private readonly agentRunner = new WorkflowAgentRunner();
    private readonly manager: WorkflowManager;
    private readonly authoring: WorkflowAuthoringService;
    private readonly delivery: WorkflowRunDelivery;

    constructor() {
        super('workflowMgr', false);
        this.delivery = new WorkflowRunDelivery(GlobalState.getInstance().taskManagerState);
        this.manager = new WorkflowManager({
            dataDirectory: this.getDataDirectory(),
            runRootDirectory: getArtifactDirectory(),
            runtime: new WorkflowRuntime(),
            builtins: createBuiltinWorkflows(),
            runAgent: async (request, run) => {
                const hostTask = GlobalState.getInstance().taskManagerState.getTask(run.hostTaskId);
                if (!hostTask) {
                    throw new Error(`该 Workflow 的宿主 Task 已不存在：${run.hostTaskId}`);
                }
                return await this.agentRunner.run(hostTask, request, { executionId: run.id });
            },
            stopRunAgents: (runId) => this.agentRunner.stopExecution(runId),
            onRunUpdated: (run) => this.sendEventToSubscribers('runUpdated', run),
            onRunCompleted: (run) => this.delivery.enqueue(run)
        });
        this.authoring = new WorkflowAuthoringService(this.agentRunner, this.manager, [LOAD_WORKFLOW_TOOLS_TOOL_NAME]);
    }

    getName(): string {
        return appT('app.name');
    }

    async getSupportedEvents(): Promise<EventDecl[]> {
        return [
            {
                eventName: 'runUpdated',
                eventDescription: 'Workflow run state changed'
            },
            {
                eventName: 'runSelected',
                eventDescription: 'Workflow detail selection changed'
            }
        ];
    }

    async getSkills(): Promise<Skill[]> {
        return createWorkflowSkills(
            this.manager.listAvailableDefinitions().map(({ definition }) => definition),
            this
        );
    }

    async authorWorkflow(
        hostTask: TaskState,
        onProgress?: WorkflowAuthoringProgress
    ): Promise<WorkflowAuthoringResult> {
        return await this.authoring.author(hostTask, onProgress);
    }

    listWorkflows(): AvailableWorkflowDefinition[] {
        return this.manager.listAvailableDefinitions();
    }

    async runWorkflow(
        target: WorkflowLaunchTarget,
        input: WorkflowJSONValue | undefined,
        hostTask: TaskState
    ): Promise<WorkflowLaunchResult> {
        return await this.manager.launch(target, input, hostTask.task_id, hostTask.task_name ?? undefined);
    }

    async stopWorkflow(runId: string, _hostTask: TaskState): Promise<WorkflowStopResult> {
        const run = await this.manager.stop(runId);
        return {
            runId: run.id,
            status: run.status,
            message:
                run.status === 'cancelled'
                    ? `Workflow run ${run.id} 已停止。`
                    : `Workflow run ${run.id} 已经处于 ${run.status} 状态。`
        };
    }

    async stopRunForUI(runId: string): Promise<WorkflowRun> {
        return await this.manager.stop(runId);
    }

    notifyRunSelectedForUI(runId: string): void {
        if (!this.manager.getRun(runId)) {
            throw new Error(`未找到 Workflow run：${runId}`);
        }
        this.sendEventToSubscribers('runSelected', runId);
    }

    getRunForUI(runId: string): WorkflowRun | undefined {
        return this.manager.getRun(runId);
    }

    listRunsForUI(): WorkflowRunSummary[] {
        return this.manager.listRuns();
    }
}
