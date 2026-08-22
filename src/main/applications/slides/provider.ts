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

export interface SlidesCapabilityDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface SlidesCapabilityExecution {
    output: string;
    isError?: boolean;
    mutated?: boolean;
    summary: string;
}

export interface SlidesPresentationOpenResult {
    status: 'opened' | 'not_opened';
    filePath: string;
    message?: string;
}

export interface SlidesCapabilityProvider {
    getCapabilities(): Promise<readonly SlidesCapabilityDefinition[]>;
    openPresentation(taskId: string, filePath: string): Promise<SlidesPresentationOpenResult>;
    execute(taskId: string, name: string, input: Record<string, unknown>): Promise<SlidesCapabilityExecution>;
}

let provider: SlidesCapabilityProvider | undefined;

export function configureSlidesCapabilityProvider(nextProvider: SlidesCapabilityProvider): void {
    provider = nextProvider;
}

export function getSlidesCapabilityProvider(): SlidesCapabilityProvider {
    if (!provider) throw new Error('Slides capability provider is not configured');
    return provider;
}
