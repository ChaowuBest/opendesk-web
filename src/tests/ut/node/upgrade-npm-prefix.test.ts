import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { asyncShellExec } from '../../../main/utils/shellExec.js';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { setPlatform, type AbstractPlatform } from '../../../platforms/base.js';

setPlatform({
    getInjectedEnviron: () => new Map()
} as AbstractPlatform);

test('stripNpmPrefix removes NPM_CONFIG_PREFIX from child process env', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-npm-prefix-test-'));
    setCustomOpendeskDirectory(tempDir);

    try {
        // Without stripNpmPrefix: buildInterpretersEnv sets NPM_CONFIG_PREFIX
        // to <tempDir>/interpreters/npm-global
        const withPrefix = await asyncShellExec('echo $NPM_CONFIG_PREFIX', { timeout: 5000 });
        assert.ok(withPrefix.stdout.trim().length > 0, 'NPM_CONFIG_PREFIX should be set without stripNpmPrefix');
        assert.ok(
            withPrefix.stdout.includes('npm-global'),
            'NPM_CONFIG_PREFIX should point to interpreters/npm-global'
        );

        // With stripNpmPrefix: NPM_CONFIG_PREFIX should be removed
        const stripped = await asyncShellExec('echo "${NPM_CONFIG_PREFIX:-UNSET}"', {
            timeout: 5000,
            stripNpmPrefix: true
        });
        assert.strictEqual(
            stripped.stdout.trim(),
            'UNSET',
            'NPM_CONFIG_PREFIX should be removed when stripNpmPrefix is true'
        );
    } finally {
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('stripNpmPrefix removes npm_config_prefix (lowercase) from child process env', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-npm-prefix-test-'));
    setCustomOpendeskDirectory(tempDir);

    try {
        // npm_config_prefix is set by npm when running under npm scripts
        // Simulate by setting it in process.env
        const originalNpmConfigPrefix = process.env.npm_config_prefix;
        process.env.npm_config_prefix = '/tmp/fake-nvm-prefix';
        try {
            const stripped = await asyncShellExec('echo "${npm_config_prefix:-UNSET}"', {
                timeout: 5000,
                stripNpmPrefix: true
            });
            assert.strictEqual(
                stripped.stdout.trim(),
                'UNSET',
                'npm_config_prefix should be removed when stripNpmPrefix is true'
            );
        } finally {
            if (originalNpmConfigPrefix !== undefined) {
                process.env.npm_config_prefix = originalNpmConfigPrefix;
            } else {
                delete process.env.npm_config_prefix;
            }
        }
    } finally {
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('npm root -g with stripNpmPrefix returns the real global root', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-npm-prefix-test-'));
    setCustomOpendeskDirectory(tempDir);

    try {
        // Without stripNpmPrefix: npm root -g would return the interpreters dir
        // (only when npm_config_prefix is not set, which is the case when running directly)
        const realRoot = await asyncShellExec('npm root -g', {
            timeout: 15000,
            stripNpmPrefix: true
        });
        const realRootPath = realRoot.stdout.trim();

        // The real global root should NOT contain 'opendesk/interpreters'
        assert.ok(
            !realRootPath.includes('opendesk') || realRootPath.includes('.nvm'),
            `Real global root should not be the interpreters sandbox, got: ${realRootPath}`
        );

        // It should end with 'node_modules'
        assert.ok(
            realRootPath.endsWith('node_modules'),
            `npm root -g should end with node_modules, got: ${realRootPath}`
        );
    } finally {
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
