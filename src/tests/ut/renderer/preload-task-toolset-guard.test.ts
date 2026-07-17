import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const preloadSource = readFileSync(new URL('../../../renderer/preload.js', import.meta.url), 'utf8');

describe('renderer preload task toolset callback ownership', () => {
    test('only the preload instance that exposed taskManagerAPI listens for tool calls', () => {
        const exposure = "const taskManagerExposed = safeExposeInMainWorld('taskManagerAPI'";
        const duplicateGuard = 'if (!taskManagerExposed)';
        const toolCallListener = "ipcRenderer.on('taskManager:callTool'";

        expect(preloadSource).toContain('return true;');
        expect(preloadSource).toContain('return false;');
        expect(preloadSource.indexOf(exposure)).toBeGreaterThan(-1);
        expect(preloadSource.indexOf(duplicateGuard)).toBeGreaterThan(preloadSource.indexOf(exposure));
        expect(preloadSource.indexOf(toolCallListener)).toBeGreaterThan(preloadSource.indexOf(duplicateGuard));
    });
});
