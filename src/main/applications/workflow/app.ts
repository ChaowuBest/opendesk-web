/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * 职责：装配 Workflow 服务，并仅提供轻量的 Application 桥接。
 */

import { BaseApplication, type EventDecl } from '../base.js';
import type { Skill } from '../../aikernel/skill.js';
import type { BaseToolset } from '../../aikernel/tool.js';
import type { WorkflowJSONValue, WorkflowRun } from '../../aikernel/workflow.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import { GlobalState } from '../../aikernel/states/global.js';
import { getArtifactDirectory } from '../../utils/setting.js';
import { t } from '../../../locale/index.js';
import { WorkflowAgentRunner } from './agent/runner.js';
import {
    WorkflowAuthoringService,
    type WorkflowAuthoringProgress,
    type WorkflowAuthoringResult
} from './authoring/service.js';
import { createBuiltinWorkflows } from './definitions/builtin.js';
import { WorkflowRunDelivery } from './run/delivery.js';
import { assertWorkflowEnabled, isWorkflowEnabled, registerWorkflowSkillGate } from './feature.js';
import { WorkflowManager, type AvailableWorkflowDefinition, type WorkflowLaunchResult } from './manager.js';
import { WorkflowRuntime } from './run/runtime/host.js';
import { createWorkflowSkills } from './tooling/skills.js';
import type { WorkflowRunSummary } from './storage.js';
import {
    LOAD_WORKFLOW_TOOLS_TOOL_NAME,
    createWorkflowDiscoveryToolset,
    type WorkflowStopResult,
    type WorkflowToolHost,
    type WorkflowLaunchTarget
} from './tooling/tools.js';

export class WorkflowApplication extends BaseApplication implements WorkflowToolHost {
    private readonly agentRunner = new WorkflowAgentRunner();
    private readonly manager: WorkflowManager;
    private readonly authoring: WorkflowAuthoringService;
    private readonly delivery: WorkflowRunDelivery;

    constructor() {
        super('workflow', t('workflow.app.name'), false);
        registerWorkflowSkillGate();
        this.delivery = new WorkflowRunDelivery(GlobalState.getInstance().taskManagerState);
        this.manager = new WorkflowManager({
            dataDirectory: this.getDataDirectory(),
            runRootDirectory: getArtifactDirectory(),
            runtime: new WorkflowRuntime(),
            builtins: createBuiltinWorkflows(),
            runAgent: async (request, run) => {
                const hostTask = GlobalState.getInstance().taskManagerState.getTask(run.hostTaskId);
                if (!hostTask) {
                    throw new Error(t('workflow.error.hostTaskMissing', { taskId: run.hostTaskId }));
                }
                return await this.agentRunner.run(hostTask, request, { executionId: run.id });
            },
            stopRunAgents: (runId) => this.agentRunner.stopExecution(runId),
            onRunUpdated: (run) => this.sendEventToSubscribers('runUpdated', run),
            onRunCompleted: (run) => this.delivery.enqueue(run)
        });
        this.authoring = new WorkflowAuthoringService(this.agentRunner, this.manager, [LOAD_WORKFLOW_TOOLS_TOOL_NAME]);
    }

    isExperimental(): boolean {
        return true;
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
        return createWorkflowSkills(this.manager.listAvailableDefinitions().map(({ definition }) => definition));
    }

    async getToolsets(): Promise<BaseToolset[]> {
        return isWorkflowEnabled() ? [createWorkflowDiscoveryToolset(this)] : [];
    }

    async authorWorkflow(
        request: string,
        hostTask: TaskState,
        onProgress?: WorkflowAuthoringProgress
    ): Promise<WorkflowAuthoringResult> {
        assertWorkflowEnabled();
        return await this.authoring.author(request, hostTask, onProgress);
    }

    listWorkflows(): AvailableWorkflowDefinition[] {
        assertWorkflowEnabled();
        return this.manager.listAvailableDefinitions();
    }

    async runWorkflow(
        target: WorkflowLaunchTarget,
        input: WorkflowJSONValue | undefined,
        hostTask: TaskState
    ): Promise<WorkflowLaunchResult> {
        assertWorkflowEnabled();
        return await this.manager.launch(target, input, hostTask.task_id, hostTask.task_name ?? undefined);
    }

    async stopWorkflow(runId: string, _hostTask: TaskState): Promise<WorkflowStopResult> {
        assertWorkflowEnabled();
        const run = await this.manager.stop(runId);
        return {
            runId: run.id,
            status: run.status,
            message:
                run.status === 'cancelled'
                    ? t('workflow.stop.stopped', { runId: run.id })
                    : t('workflow.stop.alreadyTerminal', { runId: run.id, status: run.status })
        };
    }

    async stopRunForUI(runId: string): Promise<WorkflowRun> {
        assertWorkflowEnabled();
        return await this.manager.stop(runId);
    }

    notifyRunSelectedForUI(runId: string): void {
        assertWorkflowEnabled();
        if (!this.manager.getRun(runId)) {
            throw new Error(t('workflow.error.runNotFound', { runId }));
        }
        this.sendEventToSubscribers('runSelected', runId);
    }

    getRunForUI(runId: string): WorkflowRun | undefined {
        assertWorkflowEnabled();
        return this.manager.getRun(runId);
    }

    listRunsForUI(): WorkflowRunSummary[] {
        assertWorkflowEnabled();
        return this.manager.listRuns();
    }
}
