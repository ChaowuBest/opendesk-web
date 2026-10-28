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

import type { PresentationContentReview } from '../../office/presentationContentReview.js';

export interface PresentationProgramInput {
    program?: string;
    programPath?: string;
    startFrom: 'auto' | 'current' | 'blank';
    expectedRevision?: string;
    unsavedChanges?: 'save' | 'discard';
    outputPath?: string;
    assets?: Record<string, string>;
    expectedSlideCount?: number;
    workspace?: string;
    suggestedName?: string;
}

export interface PresentationProgramExecution {
    apiVersion: string;
    ok: boolean;
    committed: boolean;
    programId: string;
    outputPath: string;
    provenance: {
        baselineAvailable: boolean;
        priorRunCount: number;
        mode: 'generator' | 'incremental';
        sourcePath: string;
        sourceRevision: string;
    };
    recovery?: {
        strategy: 'edit-generator-source';
        sourcePath: string;
        sourceRevision: string;
        preserveCompleteProgram: true;
        rerun: {
            programPath: string;
            startFrom: 'blank';
        };
    };
    revision?: unknown;
    diff?: unknown;
    validation?: unknown;
    contentReview?: PresentationContentReview;
    acceptance?: { passed: boolean; structuralPassed: boolean; contentPassed: boolean };
    open?: SlidesPresentationOpenResult;
    value?: unknown;
    error?: unknown;
}

export interface SlidesPresentationOpenResult {
    status: 'opened' | 'not_opened';
    filePath: string;
    message?: string;
}

export interface SlidesCapabilityProvider {
    openPresentation(taskId: string, filePath: string): Promise<SlidesPresentationOpenResult>;
    isProgramAvailable(): Promise<boolean>;
    executeProgram(taskId: string, input: PresentationProgramInput): Promise<PresentationProgramExecution>;
}

let provider: SlidesCapabilityProvider | undefined;

export function configureSlidesCapabilityProvider(nextProvider: SlidesCapabilityProvider): void {
    provider = nextProvider;
}

export function getSlidesCapabilityProvider(): SlidesCapabilityProvider {
    if (!provider) throw new Error('Slides capability provider is not configured');
    return provider;
}
