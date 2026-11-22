import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    getOpenCodeVcsInfo,
    openCodeProviderAuthMethods,
    permissionRulesetFromConfig
} from '../../../main/server/opencode/instance-info.js';

describe('opencode instance info', () => {
    const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;

    beforeAll(() => {
        process.env.GIT_CONFIG_GLOBAL = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-gitconfig-')),
            'config'
        );
    });

    afterAll(() => {
        if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
    });

    test('permission config expands to an opencode ruleset in declaration order', () => {
        expect(
            permissionRulesetFromConfig({
                '*': 'ask',
                read: 'allow',
                bash: { '*': 'ask', 'rm *': 'deny' },
                external_directory: { '/tmp/**': 'allow', ignored: 'sometimes' }
            })
        ).toEqual([
            { permission: '*', pattern: '*', action: 'ask' },
            { permission: 'read', pattern: '*', action: 'allow' },
            { permission: 'bash', pattern: '*', action: 'ask' },
            { permission: 'bash', pattern: 'rm *', action: 'deny' },
            { permission: 'external_directory', pattern: '/tmp/**', action: 'allow' }
        ]);
    });

    test('missing or malformed permission config yields an empty ruleset', () => {
        expect(permissionRulesetFromConfig(undefined)).toEqual([]);
        expect(permissionRulesetFromConfig(['allow'])).toEqual([]);
        expect(permissionRulesetFromConfig({ bash: 'maybe' })).toEqual([]);
    });

    test('default branch follows the primary remote HEAD before local branches', async () => {
        const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-vcs-remote-')));
        const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
        git('-c', 'init.defaultBranch=main', 'init');
        git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init');
        git('remote', 'add', 'origin', 'https://example.invalid/repo.git');
        git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
        git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');

        await expect(getOpenCodeVcsInfo(workspace)).resolves.toEqual({ branch: 'main', default_branch: 'develop' });
    });

    test('a detached HEAD reports only the default branch', async () => {
        const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-vcs-detached-')));
        const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
        git('-c', 'init.defaultBranch=master', 'init');
        git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init');
        git('checkout', '--detach');

        await expect(getOpenCodeVcsInfo(workspace)).resolves.toEqual({ default_branch: 'master' });
    });

    test('providers are connected with an API key', () => {
        expect(openCodeProviderAuthMethods()).toEqual([{ type: 'api', label: 'API key' }]);
    });
});
