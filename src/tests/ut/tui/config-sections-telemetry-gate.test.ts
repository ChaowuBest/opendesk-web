import { afterEach, describe, expect, test } from '@jest/globals';
import { getFeatureManager, resetFeatureManagerForTests } from '../../../common/features/manager.js';
import { getVisibleSectionDefs } from '../../../main/tui/components/config/configMain.js';

/**
 * telemetry 特性门控对 TUI 设置页的影响：
 * 插件禁用远程遥测后，设置主菜单不再提供「遥测」入口（配置项本身留在设置文件里）。
 */
describe('TUI 设置分区 telemetry 门控', () => {
    afterEach(() => {
        resetFeatureManagerForTests();
    });

    function sectionValues(): string[] {
        return getVisibleSectionDefs().map((section) => section.value);
    }

    test('特性未禁用时提供遥测配置入口', () => {
        expect(sectionValues()).toContain('telemetry');
    });

    test('特性禁用后收起遥测配置入口，其余分区不受影响', () => {
        getFeatureManager().setFeatureDisabled('telemetry', 'test-plugin', true);

        const values = sectionValues();
        expect(values).not.toContain('telemetry');
        expect(values).toContain('providers');
        expect(values).toContain('plugins');
        expect(values).toContain('language');
    });

    test('特性恢复后入口回到原位置', () => {
        getFeatureManager().setFeatureDisabled('telemetry', 'test-plugin', true);
        expect(sectionValues()).not.toContain('telemetry');

        getFeatureManager().setFeatureDisabled('telemetry', 'test-plugin', false);
        const values = sectionValues();
        expect(values).toContain('telemetry');
        // 仍在 plugins 之前（保持原声明顺序）
        expect(values.indexOf('telemetry')).toBeLessThan(values.indexOf('plugins'));
    });
});
