import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    appendAdditionalPrompt,
    DEFAULT_ANALYSIS_PROMPTS,
    readAnalysisPrompts,
    writeAnalysisPrompts
} from '../../../main/applications/skillmgr/analyzer/prompts';

describe('skillmgr analysis prompts persistence', () => {
    let tempDir: string;
    let promptsPath: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-prompts-test-'));
        promptsPath = path.join(tempDir, 'prompts.json');
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('reads defaults when prompts file is missing or invalid', () => {
        expect(readAnalysisPrompts(promptsPath)).toEqual(DEFAULT_ANALYSIS_PROMPTS);

        fs.writeFileSync(promptsPath, '{invalid', 'utf-8');

        expect(readAnalysisPrompts(promptsPath)).toEqual(DEFAULT_ANALYSIS_PROMPTS);
    });

    test('normalizes and persists the three supported prompt fields', () => {
        const saved = writeAnalysisPrompts(
            {
                dependencyAnalysis: 'deps extra',
                testGeneration: 'tests extra',
                testRun: 123 as unknown as string
            },
            promptsPath
        );

        expect(saved).toEqual({
            dependencyAnalysis: 'deps extra',
            testGeneration: 'tests extra',
            testRun: ''
        });
        expect(readAnalysisPrompts(promptsPath)).toEqual(saved);
        expect(fs.readdirSync(tempDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    test('appends only non-empty additional prompts', () => {
        expect(appendAdditionalPrompt('base prompt', '')).toBe('base prompt');
        expect(appendAdditionalPrompt('base prompt', '   \n  ')).toBe('base prompt');
        expect(appendAdditionalPrompt('base prompt', 'extra prompt')).toBe('base prompt\n\nextra prompt');
    });
});
