import { describe, it, expect } from '@jest/globals';
import { injectScriptIntoFrames } from '../../../main/utils/webview-frame-inject.js';

describe('injectScriptIntoFrames', () => {
    it('injects the script into the main frame and all child frames', () => {
        const calls: string[] = [];
        const mkExecutor = () => ({
            executeJavaScript: (code: string): Promise<void> => {
                calls.push(code);
                return Promise.resolve();
            }
        });
        const child1 = mkExecutor();
        const child2 = mkExecutor();
        const main = { ...mkExecutor(), frames: [child1, child2] };
        const webContents = { mainFrame: main };

        const count = injectScriptIntoFrames(webContents as never, 'SCRIPT');

        expect(count).toBe(3);
        expect(calls).toEqual(['SCRIPT', 'SCRIPT', 'SCRIPT']);
    });

    it('returns 0 when there is no main frame', () => {
        expect(injectScriptIntoFrames({ mainFrame: null }, 'S')).toBe(0);
    });

    it('keeps injecting into remaining frames when one execution rejects', () => {
        const main = {
            executeJavaScript: () => Promise.resolve(),
            frames: [
                { executeJavaScript: () => Promise.reject(new Error('destroyed')) },
                { executeJavaScript: () => Promise.resolve() }
            ]
        };
        const count = injectScriptIntoFrames({ mainFrame: main as never }, 'S');
        expect(count).toBe(3);
    });

    it('does not throw when frame enumeration fails', () => {
        const main = {
            executeJavaScript: () => Promise.resolve(),
            get frames() {
                throw new Error('boom');
            }
        };
        expect(() => injectScriptIntoFrames({ mainFrame: main as never }, 'S')).not.toThrow();
    });
});
