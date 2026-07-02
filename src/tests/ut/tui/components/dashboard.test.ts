import {
    getPythonEnvironmentPrompt,
    shouldShowPythonEnvironmentPrompt,
    shouldShowDashboardStatusBlock
} from '../../../../main/tui/components/dashboard';
import { Setting } from '../../../../main/utils/setting';

describe('DashboardBar status filters', () => {
    test('formats venv prompt from active Python environment', () => {
        expect(getPythonEnvironmentPrompt({ VIRTUAL_ENV: '/workspace/project/venv' })).toBe('(venv: venv)');
        expect(getPythonEnvironmentPrompt({ VIRTUAL_ENV: '/workspace/project/.venv/' })).toBe('(venv: .venv)');
        expect(getPythonEnvironmentPrompt({ CONDA_PREFIX: '/opt/conda/envs/agent' })).toBe('(conda: agent)');
        expect(
            getPythonEnvironmentPrompt({
                CONDA_PREFIX: '/home/intellios/miniconda3',
                CONDA_DEFAULT_ENV: 'base'
            })
        ).toBe('(conda: base)');
        expect(
            getPythonEnvironmentPrompt({
                VIRTUAL_ENV: '/workspace/project/.venv',
                CONDA_PREFIX: '/home/intellios/miniconda3',
                CONDA_DEFAULT_ENV: 'base'
            })
        ).toBe('(venv: .venv) (conda: base)');
        expect(getPythonEnvironmentPrompt({})).toBeNull();
    });

    test('hides message, todo, and filesystem status blocks from bottom bar', () => {
        expect(shouldShowDashboardStatusBlock('channelmgr')).toBe(false);
        expect(shouldShowDashboardStatusBlock('todomgr')).toBe(false);
        expect(shouldShowDashboardStatusBlock('filemgr')).toBe(false);
        expect(shouldShowDashboardStatusBlock('calendar')).toBe(true);
    });

    test('shows Python prompt only when current environment may be used', () => {
        expect(shouldShowPythonEnvironmentPrompt(Setting.getSettingSchema().parse({}))).toBe(true);
        expect(
            shouldShowPythonEnvironmentPrompt(
                Setting.getSettingSchema().parse({
                    cli_config: {
                        inherit_venv: false,
                        use_isolated_python: true
                    }
                })
            )
        ).toBe(false);
        // inherit_venv=false 时用户 Python 环境始终被剥离，不显示 prompt
        expect(
            shouldShowPythonEnvironmentPrompt(
                Setting.getSettingSchema().parse({
                    cli_config: {
                        inherit_venv: false,
                        use_isolated_python: false
                    }
                })
            )
        ).toBe(false);
    });
});
