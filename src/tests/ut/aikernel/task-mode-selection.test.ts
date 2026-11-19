import { describe, expect, test } from '@jest/globals';
import { getSupportedModeSnapshot, selectGlobalMode } from '../../../main/aikernel/task/mode.js';
import type { ModeDecl } from '../../../main/aikernel/agents/common.js';

function mode(id: string): ModeDecl {
    return {
        id,
        name: id,
        description: `${id} description`,
        icon: id[0],
        color: '#000000',
        permissionFactory: () => []
    };
}

function agent(
    modes: ModeDecl[],
    defaultMode = modes[0]
): {
    supportedModes: () => ModeDecl[];
    getDefaultMode: () => ModeDecl;
} {
    return {
        supportedModes: () => modes,
        getDefaultMode: () => defaultMode
    };
}

describe('global mode selection', () => {
    const standard = mode('standard');
    const plan = mode('plan');
    const mainAgent = agent([standard, plan]);

    test('builds a stable supported-mode snapshot and falls back stale state to default', () => {
        expect(getSupportedModeSnapshot(mainAgent, 'removed')).toEqual({
            modes: [
                { id: 'standard', name: 'standard', description: 'standard description', icon: 's', color: '#000000' },
                { id: 'plan', name: 'plan', description: 'plan description', icon: 'p', color: '#000000' }
            ],
            defaultModeId: 'standard',
            currentModeId: 'standard'
        });
        expect(getSupportedModeSnapshot(mainAgent, 'plan').currentModeId).toBe('plan');
    });

    test('rejects an unknown mode without changing persisted current state or broadcasting', () => {
        const events: string[] = [];
        const current = 'standard';
        const result = selectGlobalMode(mainAgent, current, 'missing');
        expect(result).toEqual({ status: 'error', message: 'unknown mode: missing' });
        if (result.status === 'ok') events.push(result.modeId);
        expect(current).toBe('standard');
        expect(events).toEqual([]);
    });

    test('reports changed only for a valid new mode so hosts persist and broadcast once', () => {
        let current: string | null = 'standard';
        const events: string[] = [];
        const apply = (requested: unknown) => {
            const result = selectGlobalMode(mainAgent, current, requested);
            if (result.status === 'ok') {
                current = result.modeId;
                if (result.changed) events.push(result.modeId);
            }
            return result;
        };

        expect(apply('plan')).toEqual({ status: 'ok', modeId: 'plan', changed: true });
        expect(apply('plan')).toEqual({ status: 'ok', modeId: 'plan', changed: false });
        expect(apply('missing')).toEqual({ status: 'error', message: 'unknown mode: missing' });
        expect(current).toBe('plan');
        expect(events).toEqual(['plan']);
    });
});
