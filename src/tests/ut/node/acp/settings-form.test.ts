import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpAgentFormError, buildAcpAgentProfile } from '../../../../renderer/components/acpAgentSettings.js';

const profileId = '11111111-1111-4111-8111-111111111111';

function baseForm() {
    return {
        id: '',
        name: 'Codex',
        enabled: true,
        dispatchable: false,
        whenToUse: '',
        transportType: 'stdio',
        command: 'codex',
        argsJson: '["acp"]',
        cwd: 'workspace',
        fixedCwd: '',
        envJson: '{"CODEX_API_KEY":"${env:CODEX_API_KEY}"}',
        inheritEnv: true,
        url: '',
        headersJson: '{}',
        cookies: 'include',
        modeId: '',
        configOptionsJson: '{"reasoning_effort":"high","sandbox":true}',
        mcpServerIds: 'filesystem, browser',
        reconnectEnabled: true,
        maxAttempts: '3',
        initialDelayMs: '500',
        maxDelayMs: '5000'
    };
}

test('ACP agent settings build a stdio profile without resolving secret templates', () => {
    const profile = buildAcpAgentProfile(baseForm(), () => profileId);

    assert.deepEqual(profile, {
        id: profileId,
        name: 'Codex',
        enabled: true,
        dispatchable: false,
        whenToUse: '',
        transport: {
            type: 'stdio',
            command: 'codex',
            args: ['acp'],
            cwd: 'workspace',
            env: { CODEX_API_KEY: '${env:CODEX_API_KEY}' },
            inheritEnv: true
        },
        session: {
            configOptions: { reasoning_effort: 'high', sandbox: true },
            mcpServerIds: ['filesystem', 'browser']
        },
        reconnect: {
            enabled: true,
            maxAttempts: 3,
            initialDelayMs: 500,
            maxDelayMs: 5000
        }
    });
});

test('ACP agent settings build a Streamable HTTP profile', () => {
    const form = {
        ...baseForm(),
        id: profileId,
        name: 'Remote Agent',
        transportType: 'streamableHttp',
        url: 'https://agent.example.com/acp',
        headersJson: '{"Authorization":"Bearer ${env:REMOTE_TOKEN}"}',
        cookies: 'omit',
        modeId: 'code'
    };

    const profile = buildAcpAgentProfile(form, () => 'unused');

    assert.deepEqual(profile.transport, {
        type: 'streamableHttp',
        url: 'https://agent.example.com/acp',
        headers: { Authorization: 'Bearer ${env:REMOTE_TOKEN}' },
        cookies: 'omit'
    });
    assert.equal(profile.session.modeId, 'code');
    assert.equal(profile.id, profileId);
});

test('ACP agent settings return stable validation codes for invalid fields', () => {
    const cases = [
        [{ ...baseForm(), name: '' }, 'nameRequired'],
        [{ ...baseForm(), argsJson: '{}' }, 'argsInvalid'],
        [{ ...baseForm(), envJson: '{"TOKEN":1}' }, 'envInvalid'],
        [{ ...baseForm(), cwd: 'fixed', fixedCwd: '' }, 'fixedCwdRequired'],
        [{ ...baseForm(), transportType: 'streamableHttp', url: 'file:///tmp/agent' }, 'urlInvalid'],
        [{ ...baseForm(), configOptionsJson: '{"count":2}' }, 'configOptionsInvalid'],
        [{ ...baseForm(), maxAttempts: '21' }, 'reconnectInvalid']
    ] as const;

    for (const [form, code] of cases) {
        assert.throws(
            () => buildAcpAgentProfile(form, () => profileId),
            (error: unknown) => error instanceof AcpAgentFormError && error.code === code
        );
    }
});
