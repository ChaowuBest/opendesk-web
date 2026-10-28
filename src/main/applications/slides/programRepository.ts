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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface PresentationProgramManifest {
    schemaVersion: 2;
    projectId: string;
    taskId: string;
    outputPath?: string;
    baselineAvailable: boolean;
    runCount: number;
    lastSuccessfulProgramId?: string;
    lastRevision?: string;
    sourcePath?: string;
    sourceRevision?: string;
    assets?: Record<string, { file: string; sourcePath: string }>;
    expectedSlideCount?: number;
    updatedAt: string;
}

interface PresentationProgramRunRecord {
    schemaVersion: 2;
    programId: string;
    taskId: string;
    outputPath: string;
    mode: 'generator' | 'incremental';
    status: 'running' | 'succeeded' | 'failed' | 'timed_out';
    startedAt: string;
    finishedAt?: string;
    stage?: string;
    stageUpdatedAt?: string;
    expectedRevision?: string;
    sourcePath: string;
    sourceRevision: string;
    assets?: Record<string, { file: string; sourcePath: string }>;
    result?: unknown;
}

export interface PresentationProgramRecordInput {
    taskId: string;
    outputPath: string;
    program: string;
    sourcePath: string;
    startFrom: 'current' | 'blank';
    expectedSlideCount?: number;
    expectedRevision?: string;
    beforeBytes?: Uint8Array;
    assets?: Record<string, { sourcePath: string; bytes: Uint8Array; ext: string }>;
}

export interface PresentationProgramRecordContext {
    programId: string;
    baselineAvailable: boolean;
    priorRunCount: number;
    sourcePath: string;
    sourceRevision: string;
    reportStage(stage: string): void;
}

function atomicWrite(filePath: string, contents: string | Uint8Array): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, contents);
    fs.renameSync(temporaryPath, filePath);
}

function readManifest(filePath: string, fallback: PresentationProgramManifest): PresentationProgramManifest {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PresentationProgramManifest;
}

function jsonSafeResult(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'bytes'));
}

export class PresentationProgramRepository {
    private readonly pendingByProject = new Map<string, Promise<unknown>>();

    constructor(private readonly rootDirectory: string) {}

    private projectId(taskId: string): string {
        return crypto.createHash('sha256').update(`task:${taskId}`).digest('hex');
    }

    getOutputPath(taskId: string): string | undefined {
        const projectId = this.projectId(taskId);
        const manifestPath = path.join(this.rootDirectory, 'projects', projectId, 'manifest.json');
        if (!fs.existsSync(manifestPath)) return undefined;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PresentationProgramManifest;
        return manifest.outputPath;
    }

    private getGeneratorManifest(taskId: string, sourcePath: string): PresentationProgramManifest | undefined {
        const manifestPath = path.join(this.rootDirectory, 'projects', this.projectId(taskId), 'manifest.json');
        if (!fs.existsSync(manifestPath)) return undefined;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PresentationProgramManifest;
        return manifest.sourcePath === path.resolve(sourcePath) ? manifest : undefined;
    }

    getAssetPaths(taskId: string, sourcePath: string): Record<string, string> {
        const manifest = this.getGeneratorManifest(taskId, sourcePath);
        if (!manifest) return {};
        const projectDirectory = path.join(this.rootDirectory, 'projects', this.projectId(taskId));
        let assets = manifest.assets;
        // Earlier v2 manifests kept assets only in run records; failed retries may have no assets.
        if (assets === undefined) {
            assets = {};
            for (let number = manifest.runCount; number > 0; number -= 1) {
                const runPath = path.join(projectDirectory, 'runs', `program-${String(number).padStart(6, '0')}.json`);
                if (!fs.existsSync(runPath)) continue;
                const run = JSON.parse(fs.readFileSync(runPath, 'utf8')) as PresentationProgramRunRecord;
                if (run.sourcePath === path.resolve(sourcePath)) assets = { ...run.assets, ...assets };
            }
        }
        return Object.fromEntries(
            Object.entries(assets).map(([id, asset]) => [id, path.join(projectDirectory, asset.file)])
        );
    }

    getExpectedSlideCount(taskId: string, sourcePath: string): number | undefined {
        return this.getGeneratorManifest(taskId, sourcePath)?.expectedSlideCount;
    }

    getSourcePath(taskId: string, workspace?: string): string {
        const projectId = this.projectId(taskId);
        if (workspace) {
            return path.join(
                path.resolve(workspace),
                '.opendesk',
                'presentation-automation',
                projectId.slice(0, 16),
                'main.mjs'
            );
        }
        return path.join(this.rootDirectory, 'projects', projectId, 'source', 'main.mjs');
    }

    async recordRun<T extends { apiVersion: string; ok: boolean; revision?: unknown }>(
        input: PresentationProgramRecordInput,
        execute: (context: PresentationProgramRecordContext) => Promise<T>
    ): Promise<{ context: PresentationProgramRecordContext; result: T }> {
        const normalizedOutputPath = path.resolve(input.outputPath);
        const projectId = this.projectId(input.taskId);
        const previous = this.pendingByProject.get(projectId) ?? Promise.resolve();
        const current = previous
            .catch(() => undefined)
            .then(async () => {
                const projectDirectory = path.join(this.rootDirectory, 'projects', projectId);
                const manifestPath = path.join(projectDirectory, 'manifest.json');
                const fallbackManifest: PresentationProgramManifest = {
                    schemaVersion: 2,
                    projectId,
                    taskId: input.taskId,
                    outputPath: normalizedOutputPath,
                    baselineAvailable: false,
                    runCount: 0,
                    updatedAt: new Date().toISOString()
                };
                const manifest = readManifest(manifestPath, fallbackManifest);
                const runNumber = manifest.runCount + 1;
                const programId = `program-${String(runNumber).padStart(6, '0')}`;
                const sourcePath = path.resolve(input.sourcePath);
                const sourceRevision = crypto.createHash('sha256').update(input.program).digest('hex');
                const context: PresentationProgramRecordContext = {
                    programId,
                    baselineAvailable: manifest.baselineAvailable,
                    priorRunCount: manifest.runCount,
                    sourcePath,
                    sourceRevision,
                    reportStage: () => undefined
                };

                if (input.beforeBytes && !manifest.baselineAvailable) {
                    atomicWrite(path.join(projectDirectory, 'baseline', 'original.pptx'), input.beforeBytes);
                    manifest.baselineAvailable = true;
                    context.baselineAvailable = true;
                }
                if (input.beforeBytes) {
                    atomicWrite(
                        path.join(projectDirectory, 'checkpoints', `${programId}-before.pptx`),
                        input.beforeBytes
                    );
                }
                atomicWrite(sourcePath, input.program);
                atomicWrite(path.join(projectDirectory, 'programs', `${programId}.mjs`), input.program);

                const archivedAssets: Record<string, { file: string; sourcePath: string }> = {};
                for (const [id, asset] of Object.entries(input.assets ?? {})) {
                    const safeId = `${id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
                    const relativeFile = path.join('assets', programId, `${safeId}.${asset.ext}`);
                    atomicWrite(path.join(projectDirectory, relativeFile), asset.bytes);
                    archivedAssets[id] = { file: relativeFile, sourcePath: asset.sourcePath };
                }

                const runPath = path.join(projectDirectory, 'runs', `${programId}.json`);
                const run: PresentationProgramRunRecord = {
                    schemaVersion: 2,
                    programId,
                    taskId: input.taskId,
                    outputPath: normalizedOutputPath,
                    mode: input.startFrom === 'blank' ? 'generator' : 'incremental',
                    status: 'running',
                    startedAt: new Date().toISOString(),
                    stage: 'queued',
                    stageUpdatedAt: new Date().toISOString(),
                    sourcePath,
                    sourceRevision,
                    ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
                    ...(Object.keys(archivedAssets).length ? { assets: archivedAssets } : {})
                };
                atomicWrite(runPath, `${JSON.stringify(run, null, 4)}\n`);
                context.reportStage = (stage: string): void => {
                    run.stage = stage;
                    run.stageUpdatedAt = new Date().toISOString();
                    atomicWrite(runPath, `${JSON.stringify(run, null, 4)}\n`);
                };

                let result: T;
                try {
                    result = await execute(context);
                } catch (error) {
                    result = {
                        apiVersion: 'presentation/v1',
                        ok: false,
                        error: {
                            code: 'PRESENTATION_HOST_FAILED',
                            message: error instanceof Error ? error.message : String(error)
                        }
                    } as unknown as T;
                }

                const errorCode =
                    result && typeof result === 'object' && 'error' in result
                        ? (result.error as { code?: unknown } | undefined)?.code
                        : undefined;
                run.status = result.ok
                    ? 'succeeded'
                    : errorCode === 'PRESENTATION_PROGRAM_TIMEOUT'
                      ? 'timed_out'
                      : 'failed';
                run.finishedAt = new Date().toISOString();
                run.result = jsonSafeResult(result);
                atomicWrite(runPath, `${JSON.stringify(run, null, 4)}\n`);

                manifest.assets = { ...manifest.assets, ...archivedAssets };
                if (input.expectedSlideCount !== undefined) manifest.expectedSlideCount = input.expectedSlideCount;
                manifest.runCount = runNumber;
                manifest.outputPath = normalizedOutputPath;
                manifest.sourcePath = sourcePath;
                manifest.sourceRevision = sourceRevision;
                manifest.updatedAt = run.finishedAt;
                const revision = (result.revision as { after?: unknown } | undefined)?.after;
                if (result.ok) {
                    manifest.lastSuccessfulProgramId = programId;
                    if (typeof revision === 'string') manifest.lastRevision = revision;
                }
                atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
                return { context, result };
            });
        this.pendingByProject.set(projectId, current);
        try {
            return await current;
        } finally {
            if (this.pendingByProject.get(projectId) === current) this.pendingByProject.delete(projectId);
        }
    }
}
