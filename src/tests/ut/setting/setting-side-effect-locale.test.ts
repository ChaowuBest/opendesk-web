/**
 * 保存设置后的生效步骤提示文案契约：
 * renderer 按 `sp.save.sideEffect.<label>` 取文案，新增步骤却漏配文案时，
 * 用户会在通知里看到英文原文或 locale key —— 这里把对应关系钉死。
 */

import { describe, expect, test } from '@jest/globals';
import { SETTING_SIDE_EFFECT_LABELS } from '../../../main/utils/setting-side-effects.js';
import { zhCn } from '../../../locale/zh-cn.js';
import { enUs } from '../../../locale/en-us.js';

describe('设置保存生效步骤的提示文案', () => {
    test('每个步骤 id 在中英文里都有文案', () => {
        // 失败时直接列出缺文案的步骤 id，而不是只说某个 key 不匹配
        const missing = SETTING_SIDE_EFFECT_LABELS.filter((label) => {
            const key = `sp.save.sideEffect.${label}`;
            return !zhCn[key] || !enUs[key];
        });

        expect(missing).toEqual([]);
    });

    test('汇总提示文案在中英文里都存在', () => {
        expect(zhCn['sp.save.sideEffectFailed']).toBeTruthy();
        expect(enUs['sp.save.sideEffectFailed']).toBeTruthy();
    });
});
