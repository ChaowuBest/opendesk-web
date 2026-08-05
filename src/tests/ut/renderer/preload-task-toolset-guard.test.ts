import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const preloadSource = readFileSync(new URL('../../../renderer/preload.js', import.meta.url), 'utf8');
const runtimeEnvironmentSource = readFileSync(
    new URL('../../../platforms/bridges/harmonyos/runtime-environment.ts', import.meta.url),
    'utf8'
);

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
    test('uses the Node-free HarmonyOS runtime environment parser', () => {
        expect(preloadSource).toContain("from '../platforms/bridges/harmonyos/runtime-environment.js'");
        expect(preloadSource).not.toContain("from '../platforms/bridges/harmonyos/runtime.js'");
        expect(runtimeEnvironmentSource).not.toMatch(/from\s+['"]node:/);
        expect(runtimeEnvironmentSource).not.toMatch(/require\(['"]node:/);
    });

    test('keeps exposing renderer APIs when Harmony metadata is unavailable', () => {
        expect(preloadSource).toContain('function resolveRendererHarmonyRuntime()');
        expect(preloadSource).toContain('createHarmonyRuntimeEnvironment({');
        expect(preloadSource).toContain("console.warn('[HarmonyRuntime] Renderer metadata unavailable:', error)");
        expect(preloadSource).toMatch(/catch \(error\) \{[\s\S]*?return null;/);
    });
});
