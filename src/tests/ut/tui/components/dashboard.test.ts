import {
    DashboardBar,
    getPythonEnvironmentPrompt,
    shouldShowPythonEnvironmentPrompt,
    shouldShowDashboardStatusBlock
} from '../../../../main/tui/components/dashboard';
import { Setting } from '../../../../main/utils/setting';
import { setRuntimeLocale } from '../../../../locale/index';
import { getFeatureManager, resetFeatureManagerForTests } from '../../../../common/features/manager.js';
import stripAnsi from 'strip-ansi';

describe('DashboardBar status filters', () => {
    beforeEach(() => {
        Setting.clearCache();
        Setting.updateInstanceData({});
        setRuntimeLocale('en-US');
    });

    afterEach(() => {
        setRuntimeLocale(null);
        Setting.clearCache();
    });

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

    test('被插件禁用的应用不再贡献状态块，仅隐藏入口的应用照常显示', () => {
        expect(shouldShowDashboardStatusBlock('browser')).toBe(true);

        getFeatureManager().setApplicationHidden('browser', 'plugin-a', true);
        expect(shouldShowDashboardStatusBlock('browser')).toBe(true);

        getFeatureManager().setApplicationDisabled('browser', 'plugin-a', true);
        expect(shouldShowDashboardStatusBlock('browser')).toBe(false);

        resetFeatureManagerForTests();
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

    test('shows the configured output display shortcut beside Ctrl+K', async () => {
        Setting.updateInstanceData({
            cli_config: {
                shortcuts: {
                    output_display: 'ctrl+u'
                }
            }
        });
        const dashboard = new DashboardBar(() => undefined);
        await (dashboard as any).refresh();

        const output = stripAnsi(dashboard.render(200).join('\n'));
        expect(output).toContain('Ctrl+K switch mode • Ctrl+U switch display • Ctrl+H help');
        expect(output).not.toContain('Display: Minimal');
    });
});
