import assert from 'node:assert/strict';
import test from 'node:test';
import hmCompatPlugin from '../../../../resources/plugins/hm-compat/index.mjs';
import {
    HARMONY_NPM_REGISTRY,
    HARMONY_PIP_INDEX_URL,
    configureCommonEnvironment,
    injectBashEnv
} from '../../../../resources/plugins/hm-compat/environment.mjs';

const ENV_KEYS = [
    'PATH',
    'PIP_INDEX_URL',
    'PIP_TRUSTED_HOST',
    'PIP_ONLY_BINARY',
    'npm_config_registry',
    'NODE_OPTIONS'
] as const;

function preserveEnvironment() {
    const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    return () => {
        for (const key of ENV_KEYS) {
            if (original[key] === undefined) delete process.env[key];
            else process.env[key] = original[key];
        }
    };
}

test('common environment configures mirrors and cmd-pkgs path idempotently', () => {
    const restore = preserveEnvironment();
    try {
        process.env.PATH = '/usr/bin';
        configureCommonEnvironment('/data/opendesk');
        configureCommonEnvironment('/data/opendesk');

        assert.deepEqual(process.env.PATH?.split(':'), ['/data/opendesk/interpreters/cmd-pkgs/bin', '/usr/bin']);
        assert.equal(process.env.PIP_INDEX_URL, HARMONY_PIP_INDEX_URL);
        assert.equal(process.env.npm_config_registry, HARMONY_NPM_REGISTRY);
    } finally {
        restore();
    }
});

test('bash-only injection requests jitless Node preserving existing options', () => {
    const env: Record<string, string | undefined> = { NODE_OPTIONS: '--trace-warnings' };
    injectBashEnv(env);
    injectBashEnv(env);

    assert.equal(env.NODE_OPTIONS, '--trace-warnings --jitless');
});

test('plugin setup wires shell.env hook dispatching per shell type', () => {
    const restore = preserveEnvironment();
    try {
        delete process.env.OPENDESK_HARMONY_BUILD_VARIANT;
        let shellEnvHook:
            | ((input: { shellType: string }, output: { env: Record<string, string | undefined> }) => void)
            | undefined;
        hmCompatPlugin.setup({
            configDir: '/data/opendesk',
            pluginDir: '/app/resources/plugins/hm-compat',
            hooks: {
                on: (name: unknown, callback: unknown) => {
                    if (name === 'shell.env') shellEnvHook = callback as typeof shellEnvHook;
                    return { dispose() {} };
                }
            },
            tools: { register: () => ({ dispose() {} }) }
        } as never);

        assert.ok(shellEnvHook);

        const zshOutput = { env: { PATH: '/usr/bin' } as Record<string, string | undefined> };
        shellEnvHook({ shellType: 'zsh' }, zshOutput);
        assert.equal(zshOutput.env.PATH, '/usr/bin');
        assert.equal(zshOutput.env.NODE_OPTIONS, undefined);

        const bashOutput = { env: { PATH: '/usr/bin' } as Record<string, string | undefined> };
        shellEnvHook({ shellType: 'bash' }, bashOutput);
        assert.equal(bashOutput.env.NODE_OPTIONS, '--jitless');
        assert.equal(bashOutput.env.PATH, '/usr/bin');
    } finally {
        restore();
    }
});
