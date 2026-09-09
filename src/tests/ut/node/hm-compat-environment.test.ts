import assert from 'node:assert/strict';
import test from 'node:test';
import {
    HARMONY_NPM_REGISTRY,
    HARMONY_PIP_INDEX_URL,
    configureBashEnvironment,
    configureZshEnvironment
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

test('zsh environment prepends unified cmd-pkgs and Harmonybrew paths idempotently', () => {
    const restore = preserveEnvironment();
    try {
        process.env.PATH = '/usr/bin';
        configureZshEnvironment('/data/opendesk');
        configureZshEnvironment('/data/opendesk');

        assert.deepEqual(process.env.PATH?.split(':'), [
            '/data/opendesk/interpreters/cmd-pkgs/bin',
            '/storage/Users/currentUser/.harmonybrew/bin',
            '/usr/bin'
        ]);
        assert.equal(process.env.PIP_INDEX_URL, HARMONY_PIP_INDEX_URL);
        assert.equal(process.env.npm_config_registry, HARMONY_NPM_REGISTRY);
    } finally {
        restore();
    }
});

test('bash environment prepends cmd-pkgs path, configures mirrors and requests jitless Node', () => {
    const restore = preserveEnvironment();
    try {
        process.env.PATH = '/usr/bin';
        process.env.NODE_OPTIONS = '--trace-warnings';
        configureBashEnvironment('/data/opendesk');
        configureBashEnvironment('/data/opendesk');

        assert.deepEqual(process.env.PATH?.split(':'), ['/data/opendesk/interpreters/cmd-pkgs/bin', '/usr/bin']);
        assert.equal(process.env.PIP_INDEX_URL, HARMONY_PIP_INDEX_URL);
        assert.equal(process.env.npm_config_registry, HARMONY_NPM_REGISTRY);
        assert.equal(process.env.NODE_OPTIONS, '--trace-warnings --jitless');
    } finally {
        restore();
    }
});
