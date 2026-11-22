import { DEFAULT_SHORTCUTS, getShortcuts, Setting } from '../../../main/utils/setting.js';

describe('TUI 快捷键配置读取', () => {
    beforeEach(() => {
        Setting.updateInstanceData({});
    });

    test('未配置时回落到 schema 默认值', () => {
        expect(getShortcuts()).toEqual(DEFAULT_SHORTCUTS);
    });

    test('用户配置覆盖默认值，未显式配置的键位仍保留默认值', () => {
        Setting.updateInstanceData({ cli_config: { shortcuts: { switch_mode: 'ctrl+u' } } });

        expect(getShortcuts().switch_mode).toBe('ctrl+u');
        expect(getShortcuts().output_display).toBe('ctrl+o');
        expect(getShortcuts().show_help).toBe('ctrl+h');
    });

    test('显式置空的键位保持空串，供状态栏隐藏对应提示', () => {
        Setting.updateInstanceData({ cli_config: { shortcuts: { output_display: '' } } });

        expect(getShortcuts().output_display).toBe('');
        expect(getShortcuts().switch_mode).toBe('ctrl+k');
    });
});
