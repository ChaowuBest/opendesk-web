import { describe, expect, test } from '@jest/globals';
import { NaiveNativeBridge, NaiveSandboxKit } from '../../../platforms/bridges/common.js';
import { NativeBridgeProxy } from '../../../platforms/bridges/renderer.js';

describe('unsupported native shell sandbox', () => {
    test('reports unsupported and refuses launch preparation', async () => {
        const kit = new NaiveSandboxKit();
        expect(await kit.getState()).toEqual({ supported: false, ready: false, reason: 'unsupported' });
        await expect(
            kit.prepare({
                shellPath: '/bin/sh',
                shellArgs: ['-c', 'true'],
                cwd: '/work',
                policyPath: '/policy',
                endpoint: 'http://127.0.0.1:1/decide',
                logPath: '/log',
                readOnly: false
            })
        ).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    });

    test.each([new NaiveNativeBridge(), new NativeBridgeProxy()])(
        'owns a stable placeholder without native transport',
        async (bridge) => {
            const kit = await bridge.getSandboxKit();
            expect(await bridge.getSandboxKit()).toBe(kit);
            expect(await kit.getState()).toMatchObject({ supported: false, ready: false });
        }
    );
});
