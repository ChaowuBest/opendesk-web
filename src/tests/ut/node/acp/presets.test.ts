import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ACP_AGENT_PRESETS,
    createAcpAgentPresetDraft,
    getAcpAgentPreset
} from '../../../../common/acp/agentPresets.js';

test('ACP preset catalog exposes a stable unique set of recommended agents', () => {
    assert.deepEqual(
        ACP_AGENT_PRESETS.map((preset) => preset.id),
        ['github-copilot', 'claude-code', 'gemini-cli', 'qwen-code', 'codex-cli', 'opencode']
    );
    assert.equal(new Set(ACP_AGENT_PRESETS.map((preset) => preset.id)).size, ACP_AGENT_PRESETS.length);
    assert.ok(ACP_AGENT_PRESETS.every((preset) => preset.transport.type === 'stdio'));
    assert.ok(ACP_AGENT_PRESETS.every((preset) => preset.requiresDownloadNotice));
});

test('ACP preset drafts use platform-specific npx launchers and safe defaults', () => {
    const translate = (key: string) => `translated:${key}`;
    const unixDraft = createAcpAgentPresetDraft('codex-cli', 'linux', translate);
    const windowsDraft = createAcpAgentPresetDraft('codex-cli', 'win32', translate);

    assert.equal(unixDraft.transport.command, 'npx');
    assert.equal(windowsDraft.transport.command, 'cmd.exe');
    assert.deepEqual(unixDraft.transport.args, ['-y', '@zed-industries/codex-acp@latest']);
    assert.deepEqual(windowsDraft.transport.args, [
        '/d',
        '/s',
        '/c',
        'npx.cmd',
        '-y',
        '@zed-industries/codex-acp@latest'
    ]);
    assert.equal(unixDraft.enabled, true);
    assert.equal(unixDraft.dispatchable, true);
    assert.equal(unixDraft.whenToUse, 'translated:sp.agents.preset.codex.whenToUse');
    assert.deepEqual(unixDraft.session, { configOptions: {}, mcpBindings: [] });
    assert.deepEqual(unixDraft.execution, {
        location: 'client',
        workspace: { strategy: 'task' },
        compatibility: 'preferred'
    });
    assert.deepEqual(unixDraft.reconnect, {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 500,
        maxDelayMs: 5000
    });
});

test('ACP preset lookups reject unknown ids and return immutable catalog data', () => {
    assert.equal(getAcpAgentPreset('missing'), undefined);
    assert.throws(() => createAcpAgentPresetDraft('missing', 'linux', (key) => key), /Unknown ACP agent preset/);
    assert.ok(Object.isFrozen(ACP_AGENT_PRESETS));
    assert.ok(ACP_AGENT_PRESETS.every((preset) => Object.isFrozen(preset.transport.args)));
});
