import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const preloadSource = readFileSync(new URL('../../../renderer/preload.js', import.meta.url), 'utf8');
const harmonyRuntimeSource = readFileSync(new URL('../../../common/harmonyRuntime.ts', import.meta.url), 'utf8');

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

describe('renderer preload Harmony runtime sandbox compatibility', () => {
    test('uses the Node-free common runtime parser', () => {
        expect(preloadSource).toContain("from '../common/harmonyRuntime.js'");
        expect(preloadSource).not.toContain("from '../main/utils/harmonyRuntime.js'");
        expect(harmonyRuntimeSource).not.toMatch(/from\s+['"]node:/);
        expect(harmonyRuntimeSource).not.toMatch(/require\(['"]node:/);
    });

    test('keeps exposing renderer APIs when Harmony metadata is unavailable', () => {
        expect(preloadSource).toContain('function resolveRendererHarmonyRuntime()');
        expect(preloadSource).toContain('createHarmonyRuntimeEnvironment({');
        expect(preloadSource).toContain("console.warn('[HarmonyRuntime] Renderer metadata unavailable:', error)");
        expect(preloadSource).toMatch(/catch \(error\) \{[\s\S]*?return null;/);
    });
});
