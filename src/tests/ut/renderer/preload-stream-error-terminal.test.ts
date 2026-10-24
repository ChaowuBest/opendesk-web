import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const preloadSource = readFileSync(new URL('../../../renderer/preload.js', import.meta.url), 'utf8');

/**
 * Issue #125 回归守护：preload 中全部 4 处流式 listener（streamCall /
 * streamCallMainWorld × applicationRegistryAPI / applicationAPI 两个 API 面）
 * 必须支持错误终帧：收到 (undefined, error) 时先解绑 listener 再 reject，
 * 保证 streamCall() Promise 一定 settle。
 */
describe('renderer preload stream error terminal handling', () => {
    test('all four stream listeners reject with the error terminal payload', () => {
        const rejectBranches = preloadSource.match(/reject\(new Error\(error\)\)/g) ?? [];
        expect(rejectBranches.length).toBe(4);
    });

    test('every error reject unbinds the stream listener before settling', () => {
        const pattern = /reject\(new Error\(error\)\)/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(preloadSource)) !== null) {
            const rejectIndex = match.index;
            const lastOn = preloadSource.lastIndexOf('ipcRenderer.on(', rejectIndex);
            const lastOff = preloadSource.lastIndexOf('ipcRenderer.off(', rejectIndex);
            expect(lastOff).toBeGreaterThan(lastOn);
        }
    });

    test('success terminal keeps resolving without an error payload', () => {
        // 每个 reject 分支都应与一个无错误的 resolve 分支成对出现
        const resolveBranches = preloadSource.match(/resolve\(\);/g) ?? [];
        expect(resolveBranches.length).toBeGreaterThanOrEqual(4);
    });
});
