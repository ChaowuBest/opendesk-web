/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';
import path from 'path';
import { SkillRegistry } from '../skillregistry.js';

export interface AnalysisPrompts {
    dependencyAnalysis: string;
    testGeneration: string;
    testRun: string;
}

export const DEFAULT_ANALYSIS_PROMPTS: AnalysisPrompts = {
    dependencyAnalysis: '',
    testGeneration: '',
    testRun: ''
};

const PROMPTS_FILENAME = 'prompts.json';

function normalizePrompts(value: unknown): AnalysisPrompts {
    const source =
        value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    return {
        dependencyAnalysis:
            typeof source['dependencyAnalysis'] === 'string'
                ? source['dependencyAnalysis']
                : DEFAULT_ANALYSIS_PROMPTS.dependencyAnalysis,
        testGeneration:
            typeof source['testGeneration'] === 'string'
                ? source['testGeneration']
                : DEFAULT_ANALYSIS_PROMPTS.testGeneration,
        testRun: typeof source['testRun'] === 'string' ? source['testRun'] : DEFAULT_ANALYSIS_PROMPTS.testRun
    };
}

export function getAnalysisPromptsFilePath(): string {
    return path.join(path.dirname(SkillRegistry.getSkillsDirectory()), PROMPTS_FILENAME);
}

export function readAnalysisPrompts(filePath: string = getAnalysisPromptsFilePath()): AnalysisPrompts {
    try {
        if (!fs.existsSync(filePath)) {
            return { ...DEFAULT_ANALYSIS_PROMPTS };
        }
        return normalizePrompts(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    } catch {
        return { ...DEFAULT_ANALYSIS_PROMPTS };
    }
}

export function writeAnalysisPrompts(
    prompts: Partial<AnalysisPrompts>,
    filePath: string = getAnalysisPromptsFilePath()
): AnalysisPrompts {
    const normalized = normalizePrompts(prompts);
    const dir = path.dirname(filePath);
    const tmpPath = path.join(
        dir,
        `${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    );
    fs.mkdirSync(dir, { recursive: true });
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), 'utf-8');
        fs.renameSync(tmpPath, filePath);
    } catch (error) {
        try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
            /* ignore cleanup failure */
        }
        throw error;
    }
    return normalized;
}

export function appendAdditionalPrompt(basePrompt: string, additionalPrompt: string): string {
    const trimmed = additionalPrompt.trim();
    if (!trimmed) return basePrompt;

    return `${basePrompt}

${trimmed}`;
}
