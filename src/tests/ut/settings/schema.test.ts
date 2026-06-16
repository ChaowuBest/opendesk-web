/**
 * Settings schema unit tests.
 */

import { Setting } from '../../../main/utils/setting';

describe('设置 schema', () => {
    test('开发者模式默认关闭', () => {
        const setting = Setting.getSettingSchema().parse({});

        expect(setting.developer_mode).toBe(false);
    });
});
