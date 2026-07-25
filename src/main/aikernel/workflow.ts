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
 * 职责：定义稳定的 Workflow 领域模型及其纯校验函数。
 */

import crypto from 'node:crypto';

import { z } from 'zod';

export type WorkflowJSONValue =
    null | boolean | number | string | WorkflowJSONValue[] | { [key: string]: WorkflowJSONValue };
export type WorkflowJSONSchema = Record<string, unknown>;

export function normalizeWorkflowJSONValue(value: unknown): WorkflowJSONValue {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (Array.isArray(value)) {
        return value.map((item) => normalizeWorkflowJSONValue(item));
    }
    if (typeof value === 'object') {
        const output: Record<string, WorkflowJSONValue> = {};
        for (const [key, item] of Object.entries(value)) {
            output[key] = normalizeWorkflowJSONValue(item);
        }
        return output;
    }
    return String(value);
}

export interface WorkflowPhaseDefinition {
    name: string;
    description?: string;
}

export interface WorkflowDefinitionInput {
    name: string;
    description: string;
    whenToUse?: string;
    script: string;
    inputSchema?: Record<string, unknown>;
    phases?: WorkflowPhaseDefinition[];
}

export interface WorkflowDefinition {
    id: string;
    revision: string;
    name: string;
    description: string;
    whenToUse?: string;
    script: string;
    inputSchema: Record<string, unknown>;
    phases: WorkflowPhaseDefinition[];
    createdAt: string;
    updatedAt: string;
}

interface WorkflowDefinitionValidationOptions {
    validateSource(source: string): void;
}

interface CreateWorkflowDefinitionOptions extends WorkflowDefinitionValidationOptions {
    id: string;
    now: string;
    createdAt?: string;
}

export type WorkflowRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface WorkflowRunPhase {
    id: string;
    name: string;
    description?: string;
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    startedAt?: string;
    completedAt?: string;
}

export type WorkflowFailureCode = 'agent_failed' | 'runtime_failed';

export interface WorkflowFailure {
    code: WorkflowFailureCode;
    message: string;
    phaseId?: string;
    phaseName?: string;
    agentId?: string;
    agentTitle?: string;
}

export interface WorkflowAgentSnapshot {
    id: string;
    phaseId: string;
    title: string;
    prompt: string;
    model?: string;
    status: 'running' | 'succeeded' | 'failed' | 'cancelled';
    startedAt: string;
    completedAt?: string;
    summary?: string;
    output?: WorkflowJSONValue;
    error?: string;
    failure?: WorkflowFailure;
}

export interface WorkflowRun {
    id: string;
    definition: WorkflowDefinition;
    hostTaskId: string;
    status: WorkflowRunStatus;
    input: WorkflowJSONValue;
    phases: WorkflowRunPhase[];
    agents: WorkflowAgentSnapshot[];
    reports: WorkflowJSONValue[];
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    output?: WorkflowJSONValue;
    error?: string;
    failure?: WorkflowFailure;
}

export class WorkflowValidationError extends Error {
    constructor(readonly errors: string[]) {
        super(errors.join('\n'));
        this.name = 'WorkflowValidationError';
    }
}

export function createWorkflowDefinition(
    input: WorkflowDefinitionInput,
    options: CreateWorkflowDefinitionOptions
): WorkflowDefinition {
    const errors = collectWorkflowDefinitionErrors(input, options);
    if (errors.length > 0) {
        throw new WorkflowValidationError(errors);
    }
    const inputSchema = input.inputSchema ?? {
        type: 'object',
        additionalProperties: true
    };
    const phases = input.phases
        ?.map((phase) => ({
            name: phase.name.trim(),
            ...(phase.description?.trim() ? { description: phase.description.trim() } : {})
        }))
        .filter((phase) => phase.name.length > 0);
    const definitionContent = {
        name: input.name.trim().toLowerCase(),
        description: input.description.trim(),
        ...(input.whenToUse?.trim() ? { whenToUse: input.whenToUse.trim() } : {}),
        script: input.script,
        inputSchema: structuredClone(inputSchema),
        phases: phases ?? []
    };
    return {
        id: options.id,
        revision: computeWorkflowRevision(definitionContent),
        ...definitionContent,
        createdAt: options.createdAt ?? options.now,
        updatedAt: options.now
    };
}

export function updateWorkflowDefinition(
    current: WorkflowDefinition,
    input: WorkflowDefinitionInput,
    options: WorkflowDefinitionValidationOptions & { now: string }
): WorkflowDefinition {
    return createWorkflowDefinition(input, {
        ...options,
        id: current.id,
        createdAt: current.createdAt
    });
}

export function validateWorkflowDefinition(
    definition: WorkflowDefinition,
    options: WorkflowDefinitionValidationOptions
): void {
    const errors = collectWorkflowDefinitionErrors(definition, options);
    if (errors.length > 0) {
        throw new WorkflowValidationError(errors);
    }
}

export function validateWorkflowInput(schema: Record<string, unknown>, input: WorkflowJSONValue): WorkflowJSONValue {
    let parser: z.ZodType;
    try {
        parser = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch (error) {
        throw new Error(`Workflow 输入结构无效：${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = parser.safeParse(input);
    if (!parsed.success) {
        throw new WorkflowValidationError(
            parsed.error.issues.map((issue) => `Workflow 输入无效：${formatZodPath(issue.path)}${issue.message}`)
        );
    }
    return parsed.data as WorkflowJSONValue;
}

export function getRequiredWorkflowInputNames(schema: Record<string, unknown>): string[] {
    if (schema.type !== 'object' || !Array.isArray(schema.required)) {
        return [];
    }
    return schema.required.filter((name): name is string => typeof name === 'string');
}

export function computeWorkflowRevision(
    definition: Pick<WorkflowDefinitionInput, 'script' | 'inputSchema' | 'phases'>
): string {
    const executableContract = {
        script: definition.script,
        inputSchema: definition.inputSchema ?? {
            type: 'object',
            additionalProperties: true
        },
        phases: definition.phases ?? []
    };
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(sortWorkflowValue(executableContract)))
        .digest('hex');
}

export function collectWorkflowDefinitionErrors(
    input: WorkflowDefinitionInput,
    options: WorkflowDefinitionValidationOptions
): string[] {
    const errors: string[] = [];
    const name = input.name.trim().toLowerCase();
    if (!WORKFLOW_NAME_PATTERN.test(name)) {
        errors.push('Workflow 名称只能使用小写字母、数字和单个连字符。');
    }
    if (!input.description.trim()) {
        errors.push('Workflow 描述不能为空。');
    }
    try {
        options.validateSource(input.script);
    } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
    }
    const inputSchema = input.inputSchema ?? {
        type: 'object',
        additionalProperties: true
    };
    try {
        z.fromJSONSchema(inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch (error) {
        errors.push(`Workflow 输入结构无效：${error instanceof Error ? error.message : String(error)}`);
    }
    const phaseNames = (input.phases ?? []).map((phase) => phase.name.trim());
    if (phaseNames.some((phaseName) => !phaseName)) {
        errors.push('Workflow 阶段名称不能为空。');
    }
    const nonEmptyPhaseNames = phaseNames.filter(Boolean);
    if (new Set(nonEmptyPhaseNames).size !== nonEmptyPhaseNames.length) {
        errors.push('Workflow 阶段名称不能重复。');
    }
    return [...new Set(errors)];
}

const WORKFLOW_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function formatZodPath(path: PropertyKey[]): string {
    return path.length > 0 ? `${path.map((part) => String(part)).join('.')}: ` : '';
}

function sortWorkflowValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => sortWorkflowValue(item));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, sortWorkflowValue(item)])
    );
}
