import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const preloadSource = readFileSync(new URL('../../../renderer/preload.js', import.meta.url), 'utf8');

function methodSource(name: string, nextName: string): string {
    const start = preloadSource.indexOf(`${name}: async`);
    const end = preloadSource.indexOf(`${nextName}:`, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return preloadSource.slice(start, end);
}

describe('renderer preload TailCard section API', () => {
    test('maps list to its dedicated channel and returns data', () => {
        const source = methodSource('listFrontendTailCardSections', 'setFrontendTailCardSection');
        expect(source).toContain("ipcRenderer.invoke('taskManager:listFrontendTailCardSections', taskId)");
        expect(source).toContain("if (result.status !== 'ok')");
        expect(source).toContain('throw new Error(result.message)');
        expect(source).toContain('return result.data');
    });

    test('maps set and remove arguments in order and checks errors', () => {
        const setSource = methodSource('setFrontendTailCardSection', 'removeFrontendTailCardSection');
        const removeSource = methodSource('removeFrontendTailCardSection', 'setSystemPrompt');

        expect(setSource).toContain(
            "ipcRenderer.invoke('taskManager:setFrontendTailCardSection', taskId, id, content)"
        );
        expect(removeSource).toContain("ipcRenderer.invoke('taskManager:removeFrontendTailCardSection', taskId, id)");
        for (const source of [setSource, removeSource]) {
            expect(source).toContain("if (result.status !== 'ok')");
            expect(source).toContain('throw new Error(result.message)');
            expect(source).not.toContain('return result.data');
        }
    });

    test('does not add TailCard state to the normal submit payload', () => {
        const submitSource = methodSource('submitMessage', 'rewindToUserMessage');
        expect(submitSource).toContain("ipcRenderer.invoke('taskManager:submitMessage', taskId, message)");
        expect(submitSource).not.toMatch(/knowledgeMode|sourcePaths|tailCard|tailCards|route/);
    });
});
