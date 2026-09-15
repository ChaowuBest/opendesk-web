import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    buildChildProcessEnv,
    buildInterpretersEnv,
    hasUserPythonEnvironment,
    injectNonInteractiveEnv,
    shouldUseIsolatedPython,
    stripUserPythonEnvironment
} from '../../../main/utils/shellExec';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting';

describe('terminal Python environment isolation', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-python-env-'));
        setCustomOpendeskDirectory(tempDir);
    });

    afterEach(() => {
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('detects user configured Python environments', () => {
        expect(hasUserPythonEnvironment({ VIRTUAL_ENV: '/work/.venv' })).toBe(true);
        expect(hasUserPythonEnvironment({ CONDA_PREFIX: '/opt/conda/envs/app' })).toBe(true);
        expect(hasUserPythonEnvironment({ VIRTUAL_ENV: '   ' })).toBe(false);
        expect(hasUserPythonEnvironment({})).toBe(false);
    });

    test('uses current virtual environment before isolated Python when inheritance is enabled', () => {
        expect(shouldUseIsolatedPython(Setting.getSettingSchema().parse({}), {})).toBe(true);
        expect(
            shouldUseIsolatedPython(Setting.getSettingSchema().parse({}), {
                VIRTUAL_ENV: '/work/.venv'
            })
        ).toBe(false);
    });

    test('uses isolated Python when inheritance is disabled and isolation is enabled', () => {
        expect(
            shouldUseIsolatedPython(
                Setting.getSettingSchema().parse({
                    cli_config: {
                        use_isolated_python: true,
                        inherit_venv: false
                    }
                }),
                {
                    VIRTUAL_ENV: '/work/.venv'
                }
            )
        ).toBe(true);
    });

    test('does not use isolated Python when isolation is disabled', () => {
        expect(
            shouldUseIsolatedPython(
                Setting.getSettingSchema().parse({
                    cli_config: {
                        use_isolated_python: false,
                        inherit_venv: true
                    }
                }),
                {}
            )
        ).toBe(false);
    });

    test('injects pip target when isolated Python is enabled', () => {
        const env = buildInterpretersEnv({
            useIsolatedPython: true,
            baseEnv: {
                PATH: '/usr/bin',
                PYTHONPATH: '/user/pythonpath'
            }
        });

        expect(env.NPM_CONFIG_PREFIX).toContain('npm-global');
        expect(env.PIP_TARGET).toContain('pip-global');
        expect(env.PYTHONPATH).toBe([env.PIP_TARGET, '/user/pythonpath'].join(path.delimiter));
        expect(env.PATH).toContain('npm-global');
        expect(env.PATH).toContain('pip-global');
        expect(env.PATH).toContain(path.join('uv', 'tools', 'bin'));
        expect(env.PATH?.endsWith(`${path.delimiter}/usr/bin`)).toBe(true);
    });

    test('does not override Python variables when isolated Python is disabled', () => {
        const env = buildInterpretersEnv({
            useIsolatedPython: false,
            baseEnv: {
                PATH: '/work/.venv/bin',
                PIP_TARGET: '/user/pip-target',
                PYTHONPATH: '/user/pythonpath'
            }
        });

        expect(env.NPM_CONFIG_PREFIX).toContain('npm-global');
        expect(env.PIP_TARGET).toBeUndefined();
        expect(env.PYTHONPATH).toBeUndefined();
        expect(env.PATH).toContain('npm-global');
        expect(env.PATH).not.toContain('pip-global');
        expect(env.PATH?.endsWith(`${path.delimiter}/work/.venv/bin`)).toBe(true);
    });

    test('preserves explicitly configured interpreter directories', () => {
        const npmPrefix = path.join(tempDir, 'custom-npm');
        const pipTarget = path.join(tempDir, 'custom-pip');
        const uvCacheDir = path.join(tempDir, 'custom-uv-cache');
        const uvToolDir = path.join(tempDir, 'custom-uv-tools');
        const uvToolBinDir = path.join(tempDir, 'custom-uv-bin');
        const env = buildInterpretersEnv({
            useIsolatedPython: true,
            baseEnv: {
                PATH: '/usr/bin',
                NPM_CONFIG_PREFIX: npmPrefix,
                PIP_TARGET: pipTarget,
                UV_CACHE_DIR: uvCacheDir,
                UV_TOOL_DIR: uvToolDir,
                UV_TOOL_BIN_DIR: uvToolBinDir
            }
        });

        expect(env.NPM_CONFIG_PREFIX).toBe(npmPrefix);
        expect(env.PIP_TARGET).toBe(pipTarget);
        expect(env.UV_CACHE_DIR).toBe(uvCacheDir);
        expect(env.UV_TOOL_DIR).toBe(uvToolDir);
        expect(env.UV_TOOL_BIN_DIR).toBe(uvToolBinDir);
        expect(env.PATH).toContain(uvToolBinDir);
    });

    test('builds the same complete child environment for shell and MCP processes', () => {
        const npmPrefix = path.join(tempDir, 'child-npm');
        const env = buildChildProcessEnv({
            OPENDESK_ENV_TEST: 'explicit',
            NPM_CONFIG_PREFIX: npmPrefix,
            PYTHONIOENCODING: 'custom-encoding'
        });

        expect(env.OPENDESK_ENV_TEST).toBe('explicit');
        expect(env.NPM_CONFIG_PREFIX).toBe(npmPrefix);
        expect(env.PATH).toContain(npmPrefix);
        expect(env.PYTHONIOENCODING).toBe('custom-encoding');
        expect(env.PYTHONUTF8).toBe('1');
        expect(env.CI).toBe('true');
    });

    test('does not enable Python inspect mode in non-interactive child processes', () => {
        const env: NodeJS.ProcessEnv = {};

        injectNonInteractiveEnv(env);

        expect(env.CI).toBe('true');
        expect(env.PYTHONINSPECT).toBeUndefined();
    });

    test('strips active virtual environment metadata for forced isolated Python', () => {
        const env = stripUserPythonEnvironment({
            VIRTUAL_ENV: '/work/.venv',
            VIRTUAL_ENV_PROMPT: '(.venv)',
            CONDA_PREFIX: '/opt/conda/envs/app',
            CONDA_PREFIX_1: '/opt/conda',
            CONDA_DEFAULT_ENV: 'app',
            CONDA_PROMPT_MODIFIER: '(app)',
            CONDA_SHLVL: '2',
            CONDA_EXE: '/opt/conda/bin/conda',
            PYTHONHOME: '/user/python-home',
            PYTHONPATH: '/user/python-path',
            PYTHONUSERBASE: '/user/python-user-base',
            PATH: [
                '/work/.venv/bin',
                '/usr/bin',
                '/opt/conda/envs/app/bin',
                '/opt/conda/envs/app/condabin',
                '/opt/conda/bin',
                '/opt/conda/condabin'
            ].join(path.delimiter)
        });

        expect(env.VIRTUAL_ENV).toBeUndefined();
        expect(env.VIRTUAL_ENV_PROMPT).toBeUndefined();
        expect(env.CONDA_PREFIX).toBeUndefined();
        expect(env.CONDA_PREFIX_1).toBeUndefined();
        expect(env.CONDA_DEFAULT_ENV).toBeUndefined();
        expect(env.CONDA_PROMPT_MODIFIER).toBeUndefined();
        expect(env.CONDA_SHLVL).toBeUndefined();
        expect(env.CONDA_EXE).toBeUndefined();
        expect(env.PYTHONHOME).toBeUndefined();
        expect(env.PYTHONPATH).toBeUndefined();
        expect(env.PYTHONUSERBASE).toBeUndefined();
        expect(env.PATH).toBe('/usr/bin');
    });
});
