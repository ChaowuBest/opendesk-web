/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * 职责：提供面向 Task 的 Workflow 工具及其自定义卡片展示。
 */

import { z } from 'zod';

import { BaseTool, BaseToolset, type ToolResult } from '../../../aikernel/tool.js';
import { AssistantMessage, type ToolCall } from '../../../aikernel/messages.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import {
    getRequiredWorkflowInputNames,
    normalizeWorkflowJSONValue,
    type WorkflowDefinition,
    type WorkflowDefinitionInput,
    type WorkflowJSONValue,
    type WorkflowRunStatus
} from '../../../aikernel/workflow.js';
import { escapeHtml } from '../../../../common/utils/escape.js';
import { t } from '../../../../locale/index.js';
import {
    WorkflowAuthoringCancelledError,
    type WorkflowAuthoringProgress,
    type WorkflowAuthoringProgressUpdate,
    type WorkflowAuthoringRequestRetry,
    type WorkflowAuthoringResult,
    type WorkflowAuthoringStage,
    type WorkflowInvocation
} from '../authoring/service.js';
import { assertWorkflowEnabled } from '../feature.js';
import type { AvailableWorkflowDefinition, WorkflowLaunchResult } from '../manager.js';

export const LOAD_WORKFLOW_TOOLS_TOOL_NAME = 'LoadWorkflowTools';

export type WorkflowLaunchTarget = string | WorkflowDefinition;

export interface WorkflowListEntry {
    reference: string;
    name: string;
    source: 'task' | 'saved' | 'builtin';
    revision: string;
    createdAt: string;
    description: string;
    whenToUse?: string;
    inputSchema: Record<string, unknown>;
    invocation: WorkflowInvocation;
}

export interface WorkflowListResult {
    status: 'listed';
    workflows: WorkflowListEntry[];
}

export interface WorkflowStopResult {
    runId: string;
    status: WorkflowRunStatus;
    message: string;
}

export interface WorkflowCollectInputAction {
    type: 'collect_input';
    requiredInputs: string[];
    inputSchema: Record<string, unknown>;
    reference: string;
    instruction: string;
}

type WorkflowAuthoringRenderState = Omit<Partial<WorkflowAuthoringResult>, 'status'> & {
    status?: WorkflowAuthoringResult['status'] | 'cancelled';
    stage?: WorkflowAuthoringStage;
    attempt?: number;
    definition?: WorkflowDefinition | WorkflowDefinitionInput;
    errors?: string[];
    requestRetry?: WorkflowAuthoringRequestRetry;
};

const LoadWorkflowToolsSchema = z.object({});

const AuthorWorkflowSchema = z.object({
    request: z.string().min(1).describe(t('workflow.tool.author.request'))
});

const ListWorkflowsSchema = z.object({});

const RunWorkflowSchema = z.object({
    reference: z.string().min(1).describe(t('workflow.tool.run.reference')),
    input: z.record(z.string(), z.unknown()).optional().describe(t('workflow.tool.run.input'))
});

const StopWorkflowSchema = z.object({
    runId: z.string().min(1).describe(t('workflow.tool.stop.runId'))
});

export interface WorkflowToolHost {
    authorWorkflow(
        request: string,
        hostTask: TaskState,
        onProgress?: WorkflowAuthoringProgress
    ): Promise<WorkflowAuthoringResult>;
    listWorkflows(): AvailableWorkflowDefinition[];
    runWorkflow(
        target: WorkflowLaunchTarget,
        input: WorkflowJSONValue | undefined,
        hostTask: TaskState
    ): Promise<WorkflowLaunchResult>;
    stopWorkflow(runId: string, hostTask: TaskState): Promise<WorkflowStopResult>;
}

export function createWorkflowActionToolset(host: WorkflowToolHost): BaseToolset {
    const toolset = new BaseToolset('workflow');
    toolset.addTools(
        new AuthorWorkflowTool(host),
        new ListWorkflowsTool(host),
        new RunWorkflowTool(host),
        new StopWorkflowTool(host)
    );
    return toolset;
}

export function createWorkflowDiscoveryToolset(host: WorkflowToolHost): BaseToolset {
    const toolset = new BaseToolset('workflow-discovery');
    toolset.addTool(new LoadWorkflowToolsTool(host));
    return toolset;
}

export class LoadWorkflowToolsTool extends BaseTool<typeof LoadWorkflowToolsSchema> {
    constructor(private readonly host: WorkflowToolHost) {
        super(LOAD_WORKFLOW_TOOLS_TOOL_NAME, t('workflow.tool.load.description'), LoadWorkflowToolsSchema);
        this.setUniversalExecutor(async (_args, result, taskState) => {
            assertWorkflowEnabled();
            if (!taskState) {
                throw new Error('LoadWorkflowTools requires a host Task');
            }
            await taskState.attachToolset(createWorkflowActionToolset(this.host));
            result.updateResultObject({
                status: 'loaded',
                tools: ['AuthorWorkflow', 'ListWorkflows', 'RunWorkflow', 'StopWorkflow']
            });
            result.updateResult(t('workflow.tool.load.loaded'));
        });
    }
}

export class AuthorWorkflowTool extends BaseTool<typeof AuthorWorkflowSchema> {
    constructor(private readonly host: WorkflowToolHost) {
        super('AuthorWorkflow', t('workflow.tool.author.description'), AuthorWorkflowSchema);
        this.setUniversalExecutor(async (args, result, taskState) => {
            if (!taskState) {
                throw new Error('AuthorWorkflow requires a host Task');
            }
            let authored: WorkflowAuthoringResult;
            try {
                authored = await this.host.authorWorkflow(args.request, taskState, (update) => {
                    updateAuthoringResult(result, update);
                });
            } catch (error) {
                if (error instanceof WorkflowAuthoringCancelledError) {
                    result.result_object = {
                        ...(result.result_object ?? {}),
                        status: 'cancelled',
                        retryable: false,
                        errors: []
                    };
                    result.result = error.message;
                    return;
                }
                const message = error instanceof Error ? error.message : String(error);
                const errors = authoringErrorMessages(error);
                result.updateResultObject({
                    ...(result.result_object ?? {}),
                    stage: 'validate',
                    status: 'failed',
                    retryable: false,
                    errors
                });
                throw new Error(`${message}\n${t('workflow.author.terminalFailure')}`);
            }
            result.result_object = {
                ...(result.result_object ?? {}),
                stage: 'review',
                ...authored
            };
            result.result = JSON.stringify(modelVisibleAuthoringResult(authored), null, 2);
        });
    }

    override async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const state = toolcall.result_object as WorkflowAuthoringRenderState | undefined;
        const stage = state?.stage ?? 'generate';
        const requestRetry = state?.requestRetry;
        const activeStep = authoringStageIndex(stage);
        const cancelled = state?.status === 'cancelled';
        const succeeded = toolcall.status === 'success' && state?.status === 'authored';
        const title = cancelled
            ? t('workflow.author.card.cancelledTitle')
            : succeeded
              ? t('workflow.author.card.succeededTitle')
              : requestRetry
                ? t('workflow.author.card.requestRetryTitle')
                : t(`workflow.author.card.${stage}Title`);
        const body = cancelled
            ? t('workflow.author.card.cancelledBody')
            : succeeded
              ? t('workflow.author.card.succeededBody', {
                    name: state?.workflowName ?? '',
                    reference: state?.reference ?? ''
                })
              : requestRetry
                ? t('workflow.author.card.requestRetryBody', {
                      attempt: requestRetry.attempt,
                      seconds: Math.max(1, Math.ceil(requestRetry.delayMs / 1000))
                  })
                : t(`workflow.author.card.${stage}Body`);
        const steps = [
            t('workflow.author.card.stepGenerate'),
            t('workflow.author.card.stepValidate'),
            t('workflow.author.card.stepReview')
        ];
        const icon = cancelled
            ? `<span class="workflow-authoring-status workflow-authoring-status-cancelled"
                    style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-top:2px;border-radius:999px;font-size:10px;font-weight:700;color:#d97706;background:rgba(245,158,11,0.14);">■</span>`
            : succeeded
              ? `<span class="workflow-authoring-status workflow-authoring-status-success"
                    style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-top:2px;border-radius:999px;font-size:11px;font-weight:700;color:#15803d;background:rgba(34,197,94,0.14);">✓</span>`
              : '<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-top:2px;flex:0 0 16px;"><i class="fa-solid fa-spinner fa-spin text-blue-500 text-xs"></i></span>';
        const args = toolcall.args_object as z.infer<typeof AuthorWorkflowSchema> | undefined;
        const details = renderAuthoringDetails(args?.request ?? '', state, succeeded, cancelled);
        return `<div class="od-inline-toolcall-container">
            <div class="workflow-authoring-card text-[11px]"
                style="max-width:100%;min-width:0;padding:10px 12px;border:1px solid var(--od-border-strong,rgba(148,163,184,0.35));border-radius:10px;background:var(--od-bg-elevated,rgba(248,250,252,0.82));color:var(--od-text-muted,#64748b);">
                <div class="workflow-authoring-main flex items-start gap-2">
                    ${icon}
                    <div class="min-w-0" style="flex:1;">
                        <div class="font-semibold" style="color:var(--od-text,#334155);">${escapeHtml(title)}</div>
                        <div class="workflow-authoring-body mt-0.5">${escapeHtml(body)}</div>
                        <div class="workflow-authoring-steps flex flex-wrap gap-1.5 mt-2">
                            ${steps
                                .map((step, index) =>
                                    renderAuthoringStep(step, succeeded || (!cancelled && index <= activeStep))
                                )
                                .join('')}
                        </div>
                        ${details}
                    </div>
                </div>
            </div>
        </div>`;
    }
}

export class ListWorkflowsTool extends BaseTool<typeof ListWorkflowsSchema> {
    constructor(private readonly host: WorkflowToolHost) {
        super('ListWorkflows', t('workflow.tool.list.description'), ListWorkflowsSchema);
        this.setUniversalExecutor(async (_args, result, taskState) => {
            if (!taskState) {
                throw new Error('ListWorkflows requires a host Task');
            }
            const listed: WorkflowListResult = {
                status: 'listed',
                workflows: [
                    ...listAuthoredWorkflowsFromTask(taskState),
                    ...this.host
                        .listWorkflows()
                        .map(({ definition, source }) => toWorkflowListEntry(definition, definition.name, source))
                ]
            };
            result.updateResultObject(listed);
            result.updateResult(JSON.stringify(listed, null, 2));
        });
    }
}

export class RunWorkflowTool extends BaseTool<typeof RunWorkflowSchema> {
    constructor(private readonly host: WorkflowToolHost) {
        super('RunWorkflow', t('workflow.tool.run.description'), RunWorkflowSchema);
        this.setUniversalExecutor(async (args, result, taskState) => {
            if (!taskState) {
                throw new Error('RunWorkflow requires a host Task');
            }
            const authored = args.reference.startsWith('authoring_')
                ? resolveAuthoredWorkflowFromTask(taskState, args.reference)
                : undefined;
            const input = args.input === undefined ? undefined : normalizeWorkflowJSONValue(args.input);
            const launch = await this.host.runWorkflow(
                authored ? structuredClone(authored.definition) : args.reference,
                input,
                taskState
            );
            result.updateResultObject(launch);
            result.updateResult(t('workflow.run.started', { runId: launch.runId }));
            stopHostTurnAfterLaunch(taskState, launch.runId);
        });
    }

    override async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const result = toolcall.result_object as Partial<WorkflowLaunchResult> | undefined;
        const runId = result?.runId;
        const workflowName = result?.workflowName ?? '';
        if (!runId || toolcall.status !== 'success') {
            return undefined;
        }
        return `<div class="od-inline-toolcall-container">
            <button type="button"
                data-workflow-run-id="${escapeHtml(runId)}"
                class="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-left transition-colors"
                onclick="(async function(button){var runId=button.dataset.workflowRunId;window.localStorage.setItem('opendesk.workflow.selectedRunId',runId);await window.globalControlAPI.openApplication('workflow');await window.applicationRegistryAPI.callMainWorld('workflow','notifyRunSelectedForUI',runId);})(this)">
                <span class="flex items-center gap-2 min-w-0">
                    <i class="fas fa-diagram-project text-indigo-500"></i>
                    <span class="min-w-0">
                        <span class="block text-xs font-medium text-slate-700 truncate">${escapeHtml(workflowName)}</span>
                        <span class="block text-[11px] text-slate-400 truncate">${escapeHtml(runId)}</span>
                    </span>
                </span>
                <span class="shrink-0 inline-flex items-center gap-1.5 text-xs text-emerald-600">
                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                    ${escapeHtml(t('workflow.card.started'))}
                    <i class="fas fa-chevron-right text-[9px] text-slate-400"></i>
                </span>
            </button>
        </div>`;
    }
}

function modelVisibleAuthoringResult(authored: WorkflowAuthoringResult): {
    reference: string;
    status: 'authored';
    inputSchema: Record<string, unknown>;
    launchInput?: WorkflowJSONValue;
    missingRequiredInputs: string[];
    launchReady: boolean;
    invocation: WorkflowInvocation;
    nextAction:
        | WorkflowCollectInputAction
        | {
              type: 'run_workflow';
              invocation: WorkflowInvocation;
          };
    message: string;
} {
    return {
        reference: authored.reference,
        status: authored.status,
        inputSchema: authored.inputSchema,
        ...(authored.launchInput === undefined ? {} : { launchInput: authored.launchInput }),
        missingRequiredInputs: authored.missingRequiredInputs,
        launchReady: authored.launchReady,
        invocation: authored.invocation,
        nextAction: authored.launchReady
            ? {
                  type: 'run_workflow',
                  invocation: structuredClone(authored.invocation)
              }
            : createCollectInputAction(authored),
        message: authored.message
    };
}

function createCollectInputAction(authored: WorkflowAuthoringResult): WorkflowCollectInputAction {
    return {
        type: 'collect_input',
        requiredInputs: [...authored.missingRequiredInputs],
        inputSchema: structuredClone(authored.inputSchema),
        reference: authored.reference,
        instruction: t('workflow.nextAction.collectInput', {
            fields: authored.missingRequiredInputs.join(', ')
        })
    };
}

function authoringErrorMessages(error: unknown): string[] {
    if (
        error &&
        typeof error === 'object' &&
        Array.isArray((error as { errors?: unknown }).errors) &&
        (error as { errors: unknown[] }).errors.every((item) => typeof item === 'string')
    ) {
        return (error as { errors: string[] }).errors;
    }
    return [error instanceof Error ? error.message : String(error)];
}

function toWorkflowListEntry(
    definition: WorkflowDefinition,
    reference: string,
    source: WorkflowListEntry['source'],
    invocation?: WorkflowInvocation
): WorkflowListEntry {
    const requiredInputs = getRequiredWorkflowInputNames(definition.inputSchema);
    const input = invocation?.input
        ? structuredClone(invocation.input)
        : requiredInputs.length > 0
          ? Object.fromEntries(requiredInputs.map((name) => [name, `<${name}>`]))
          : undefined;
    return {
        reference,
        name: definition.name,
        source,
        revision: definition.revision,
        createdAt: definition.createdAt,
        description: definition.description,
        ...(definition.whenToUse ? { whenToUse: definition.whenToUse } : {}),
        inputSchema: structuredClone(definition.inputSchema),
        invocation: {
            reference,
            ...(input ? { input } : {})
        }
    };
}

export class StopWorkflowTool extends BaseTool<typeof StopWorkflowSchema> {
    constructor(private readonly host: WorkflowToolHost) {
        super('StopWorkflow', t('workflow.tool.stop.description'), StopWorkflowSchema);
        this.setUniversalExecutor(async (args, result, taskState) => {
            if (!taskState) {
                throw new Error('StopWorkflow requires a host Task');
            }
            const stopped = await this.host.stopWorkflow(args.runId, taskState);
            result.updateResultObject(stopped);
            result.updateResult(stopped.message);
        });
    }
}

export function resolveAuthoredDefinitionFromTask(hostTask: TaskState, reference: string): WorkflowDefinition {
    return structuredClone(resolveAuthoredWorkflowFromTask(hostTask, reference).definition);
}

function listAuthoredWorkflowsFromTask(hostTask: TaskState): WorkflowListEntry[] {
    return listAuthoredWorkflowResultsFromTask(hostTask).map((authored) =>
        toWorkflowListEntry(authored.definition, authored.reference, 'task', authored.invocation)
    );
}

function listAuthoredWorkflowResultsFromTask(hostTask: TaskState): WorkflowAuthoringResult[] {
    const authored: WorkflowAuthoringResult[] = [];
    const messages = hostTask.chat_context?.messages ?? [];
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const message = messages[messageIndex];
        if (!(message instanceof AssistantMessage)) {
            continue;
        }
        for (let contentIndex = message.content.length - 1; contentIndex >= 0; contentIndex -= 1) {
            const part = message.content[contentIndex];
            if (part.type !== 'tool_call') {
                continue;
            }
            for (let callIndex = part.toolcalls.length - 1; callIndex >= 0; callIndex -= 1) {
                const toolCall = part.toolcalls[callIndex];
                if (toolCall.tool_name !== 'workflow-AuthorWorkflow') {
                    continue;
                }
                const result = toolCall.result_object as Partial<WorkflowAuthoringResult> | undefined;
                if (result?.status === 'authored' && typeof result.reference === 'string' && result.definition) {
                    authored.push(structuredClone(result as WorkflowAuthoringResult));
                }
            }
        }
    }
    return authored;
}

function resolveAuthoredWorkflowFromTask(hostTask: TaskState, reference: string): WorkflowAuthoringResult {
    const authored = listAuthoredWorkflowResultsFromTask(hostTask).find(
        (candidate) => candidate.reference === reference
    );
    if (authored) {
        return authored;
    }
    throw new Error(t('workflow.error.authoringNotFound', { reference }));
}

function stopHostTurnAfterLaunch(hostTask: TaskState, runId: string): void {
    let pending = true;
    hostTask.hooks.afterToolCall((activeTask, toolCall) => {
        if (!pending || toolCall.tool_name !== 'workflow-RunWorkflow' || toolCall.status !== 'success') {
            return;
        }
        const result = toolCall.result_object as Partial<WorkflowLaunchResult> | undefined;
        if (result?.runId !== runId) {
            return;
        }
        pending = false;
        activeTask.stop('system');
    });
}

function updateAuthoringResult(
    result: Pick<ToolResult, 'result_object' | 'updateResultObject'>,
    update: WorkflowAuthoringProgressUpdate
): void {
    result.updateResultObject({
        ...(result.result_object ?? {}),
        ...update
    });
}

function authoringStageIndex(stage: WorkflowAuthoringStage): number {
    if (stage === 'generate') return 0;
    return stage === 'validate' ? 1 : 2;
}

function renderAuthoringStep(label: string, active: boolean): string {
    const style = active
        ? 'border-color:rgba(37,99,235,0.35);color:#60a5fa;background:rgba(37,99,235,0.12);'
        : 'border-color:var(--od-border-strong,rgba(148,163,184,0.35));color:var(--od-text-muted,#64748b);background:var(--od-bg-muted,rgba(255,255,255,0.7));';
    return `<span class="workflow-authoring-step ${active ? 'is-active' : ''}"
        style="border-width:1px;border-style:solid;border-radius:999px;padding:2px 8px;${style}">${escapeHtml(label)}</span>`;
}

function renderAuthoringDetails(
    request: string,
    state: WorkflowAuthoringRenderState | undefined,
    succeeded: boolean,
    cancelled: boolean
): string {
    const definition = state?.definition;
    const errors = state?.errors ?? [];
    const requestRetry = state?.requestRetry;
    const phaseNames = definition?.phases?.map((phase) => phase.name).join(' → ') ?? '';
    const inputContract = definition
        ? JSON.stringify(
              {
                  inputSchema: definition.inputSchema
              },
              null,
              2
          )
        : '';
    const status = cancelled
        ? t('workflow.author.details.cancelled')
        : succeeded
          ? t('workflow.author.details.reviewed')
          : requestRetry?.status === 'retrying'
            ? t('workflow.author.details.requestRetrying', { attempt: requestRetry.attempt })
            : requestRetry
              ? t('workflow.author.details.requestRetryScheduled', {
                    attempt: requestRetry.attempt,
                    seconds: Math.max(1, Math.ceil(requestRetry.delayMs / 1000))
                })
              : errors.length > 0
                ? t('workflow.author.details.rejected', { attempt: state?.attempt ?? 1 })
                : state?.stage === 'review'
                  ? t('workflow.author.details.reviewing')
                  : t('workflow.author.details.generating');
    const definitionDetails = definition
        ? `<div style="margin-top:10px;">
                <div style="font-weight:600;color:var(--od-text,#334155);">${escapeHtml(
                    t('workflow.author.details.definition')
                )}</div>
                <div style="margin-top:4px;">${escapeHtml(definition.name)} · ${escapeHtml(
                    definition.description
                )}</div>
                <div style="margin-top:4px;">${escapeHtml(
                    t('workflow.author.details.phases', { phases: phaseNames })
                )}</div>
                <pre style="margin:6px 0 0;max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid var(--od-border-strong,rgba(148,163,184,0.28));border-radius:7px;padding:8px;background:var(--od-bg-muted,rgba(15,23,42,0.04));">${escapeHtml(
                    inputContract
                )}</pre>
                <details class="workflow-authoring-script" style="margin-top:7px;">
                    <summary style="cursor:pointer;color:#60a5fa;">${escapeHtml(
                        t('workflow.author.details.script')
                    )}</summary>
                    <pre style="margin:6px 0 0;max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid var(--od-border-strong,rgba(148,163,184,0.28));border-radius:7px;padding:8px;background:var(--od-bg-muted,rgba(15,23,42,0.04));">${escapeHtml(
                        definition.script
                    )}</pre>
                </details>
            </div>`
        : '';
    const visibleErrors = requestRetry ? [requestRetry.error] : errors;
    const errorDetails =
        visibleErrors.length > 0
            ? `<div style="margin-top:8px;color:#ef4444;white-space:pre-wrap;">${visibleErrors
                  .map((error) => escapeHtml(error))
                  .join('\n')}</div>`
            : '';
    return `<details class="workflow-authoring-details" ${visibleErrors.length > 0 ? 'open' : ''} style="margin-top:8px;">
        <summary style="cursor:pointer;display:inline-flex;align-items:center;gap:5px;color:#60a5fa;">
            <i class="fa-solid fa-chevron-down" style="font-size:9px;"></i>
            <span>${escapeHtml(t('workflow.author.details.show'))}</span>
        </summary>
        <div style="margin-top:8px;padding:9px;border:1px solid var(--od-border-strong,rgba(148,163,184,0.28));border-radius:8px;background:var(--od-bg-muted,rgba(15,23,42,0.035));">
            <div style="font-weight:600;color:var(--od-text,#334155);">${escapeHtml(status)}</div>
            <div style="margin-top:8px;font-weight:600;color:var(--od-text,#334155);">${escapeHtml(
                t('workflow.author.details.request')
            )}</div>
            <div style="margin-top:3px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(request)}</div>
            ${errorDetails}
            ${definitionDetails}
        </div>
    </details>`;
}
