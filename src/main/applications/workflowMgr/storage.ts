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
 * 职责：持久化 Workflow Definition、Task 所属 Run 和轻量 Run 索引。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { type WorkflowDefinition, type WorkflowRun, type WorkflowRunStatus } from '../../aikernel/workflow.js';

const DEFINITION_STORE_VERSION = 2;
const RUN_INDEX_VERSION = 1;

interface WorkflowDefinitionStoreData {
    version: number;
    definitions: WorkflowDefinition[];
}

interface WorkflowRunIndexData {
    version: number;
    runs: WorkflowRunSummary[];
}

export interface WorkflowRunSummary {
    runId: string;
    workflowName: string;
    hostTaskId: string;
    hostTaskName?: string;
    status: WorkflowRunStatus;
    startedAt: string;
    updatedAt: string;
}

export class WorkflowStorage {
    private readonly definitionStorePath: string;
    private readonly runIndexPath: string;
    private persistChain: Promise<void> = Promise.resolve();

    constructor(
        dataDirectory: string,
        private readonly runRootDirectory: string
    ) {
        this.definitionStorePath = path.join(dataDirectory, 'workflow.json');
        this.runIndexPath = path.join(dataDirectory, 'workflow-run-index.json');
        fs.mkdirSync(dataDirectory, { recursive: true });
        fs.mkdirSync(runRootDirectory, { recursive: true });
    }

    loadDefinitions(): WorkflowDefinition[] {
        if (!fs.existsSync(this.definitionStorePath)) {
            return [];
        }
        const parsed = JSON.parse(
            fs.readFileSync(this.definitionStorePath, 'utf8')
        ) as Partial<WorkflowDefinitionStoreData>;
        if (
            parsed.version !== DEFINITION_STORE_VERSION ||
            !Array.isArray(parsed.definitions) ||
            !parsed.definitions.every(isWorkflowDefinition)
        ) {
            throw new Error(`不支持的 Workflow 数据文件：${this.definitionStorePath}`);
        }
        return structuredClone(parsed.definitions);
    }

    loadRunIndex(): WorkflowRunSummary[] {
        let summaries: WorkflowRunSummary[];
        if (!fs.existsSync(this.runIndexPath)) {
            return this.rebuildRunIndex();
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.runIndexPath, 'utf8')) as Partial<WorkflowRunIndexData>;
            if (parsed.version !== RUN_INDEX_VERSION || !Array.isArray(parsed.runs)) {
                summaries = this.rebuildRunIndex();
            } else {
                summaries = parsed.runs
                    .filter(isWorkflowRunSummary)
                    .filter((summary) => fs.existsSync(this.runPath(summary.hostTaskId, summary.runId)));
            }
        } catch {
            summaries = this.rebuildRunIndex();
        }
        return summaries;
    }

    saveRunIndex(summaries: readonly WorkflowRunSummary[]): Promise<void> {
        return this.enqueueAtomicWrite(this.runIndexPath, serializeRunIndex(summaries));
    }

    saveRunIndexSynchronously(summaries: readonly WorkflowRunSummary[]): void {
        atomicWriteSynchronously(this.runIndexPath, serializeRunIndex(summaries));
    }

    loadRun(hostTaskId: string, runId: string): WorkflowRun | undefined {
        const runPath = this.runPath(hostTaskId, runId);
        if (!fs.existsSync(runPath)) {
            return undefined;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(runPath, 'utf8')) as unknown;
            return parseCurrentRun(parsed, hostTaskId, runId);
        } catch {
            return undefined;
        }
    }

    saveRun(run: WorkflowRun): Promise<void> {
        const runPath = this.runPath(run.hostTaskId, run.id);
        return this.enqueueAtomicWrite(runPath, JSON.stringify(run, null, 4));
    }

    saveRunSynchronously(run: WorkflowRun): void {
        atomicWriteSynchronously(this.runPath(run.hostTaskId, run.id), JSON.stringify(run, null, 4));
    }

    private rebuildRunIndex(): WorkflowRunSummary[] {
        const summaries: WorkflowRunSummary[] = [];
        for (const taskEntry of fs.readdirSync(this.runRootDirectory, { withFileTypes: true })) {
            if (!taskEntry.isDirectory()) {
                continue;
            }
            const workflowRunRoot = path.join(this.runRootDirectory, taskEntry.name, 'workflow-runs');
            if (!fs.existsSync(workflowRunRoot)) {
                continue;
            }
            for (const runEntry of fs.readdirSync(workflowRunRoot, { withFileTypes: true })) {
                if (!runEntry.isDirectory()) {
                    continue;
                }
                const run = this.loadRun(taskEntry.name, runEntry.name);
                if (!run) {
                    continue;
                }
                summaries.push(toWorkflowRunSummary(run));
            }
        }
        summaries.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
        this.saveRunIndexSynchronously(summaries);
        return summaries;
    }

    private runPath(hostTaskId: string, runId: string): string {
        return path.join(this.runRootDirectory, hostTaskId, 'workflow-runs', runId, 'run.json');
    }

    private enqueueAtomicWrite(targetPath: string, content: string): Promise<void> {
        const write = this.persistChain.then(async () => {
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
            const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
            try {
                await fs.promises.writeFile(temporaryPath, content, 'utf8');
                await fs.promises.rename(temporaryPath, targetPath);
            } catch (error) {
                await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
                throw error;
            }
        });
        this.persistChain = write.catch(() => undefined);
        return write;
    }
}

export function toWorkflowRunSummary(run: WorkflowRun, hostTaskName?: string): WorkflowRunSummary {
    return {
        runId: run.id,
        workflowName: run.definition.name,
        hostTaskId: run.hostTaskId,
        ...(hostTaskName?.trim() ? { hostTaskName: hostTaskName.trim() } : {}),
        status: run.status,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt
    };
}

function serializeRunIndex(summaries: readonly WorkflowRunSummary[]): string {
    return JSON.stringify(
        {
            version: RUN_INDEX_VERSION,
            runs: [...summaries].sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        } satisfies WorkflowRunIndexData,
        null,
        4
    );
}

function atomicWriteSynchronously(targetPath: string, content: string): void {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, content, 'utf8');
    fs.renameSync(temporaryPath, targetPath);
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const source = value as Partial<WorkflowDefinition>;
    return (
        typeof source.id === 'string' &&
        Boolean(source.id) &&
        typeof source.revision === 'string' &&
        Boolean(source.revision) &&
        typeof source.name === 'string' &&
        typeof source.description === 'string' &&
        typeof source.script === 'string' &&
        Boolean(source.inputSchema) &&
        typeof source.inputSchema === 'object' &&
        !Array.isArray(source.inputSchema) &&
        Array.isArray(source.phases) &&
        source.phases.every(
            (phase) =>
                Boolean(phase) &&
                typeof phase === 'object' &&
                typeof phase.name === 'string' &&
                (phase.description === undefined || typeof phase.description === 'string')
        ) &&
        typeof source.createdAt === 'string' &&
        typeof source.updatedAt === 'string' &&
        (source.whenToUse === undefined || typeof source.whenToUse === 'string')
    );
}

function parseCurrentRun(value: unknown, hostTaskId: string, runId: string): WorkflowRun | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const source = value as Partial<WorkflowRun>;
    if (
        source.id !== runId ||
        source.hostTaskId !== hostTaskId ||
        !isWorkflowDefinition(source.definition) ||
        typeof source.startedAt !== 'string' ||
        typeof source.updatedAt !== 'string' ||
        !isWorkflowRunStatus(source.status) ||
        source.input === undefined ||
        !Array.isArray(source.phases) ||
        !Array.isArray(source.agents) ||
        !Array.isArray(source.reports)
    ) {
        return undefined;
    }
    return structuredClone(source as WorkflowRun);
}

function isWorkflowRunSummary(value: unknown): value is WorkflowRunSummary {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const summary = value as Partial<WorkflowRunSummary>;
    return (
        typeof summary.runId === 'string' &&
        typeof summary.workflowName === 'string' &&
        typeof summary.hostTaskId === 'string' &&
        isWorkflowRunStatus(summary.status) &&
        typeof summary.startedAt === 'string' &&
        typeof summary.updatedAt === 'string'
    );
}

function isWorkflowRunStatus(value: unknown): value is WorkflowRunStatus {
    return value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled';
}
