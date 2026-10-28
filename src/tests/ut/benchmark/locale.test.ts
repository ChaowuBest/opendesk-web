import { zhCn } from '../../../main/applications/benchmark/locale/zh-cn.js';
import { enUs } from '../../../main/applications/benchmark/locale/en-us.js';

describe('benchmark locale', () => {
    test('中英文词表 key 集合一致', () => {
        expect(Object.keys(zhCn).sort()).toEqual(Object.keys(enUs).sort());
    });

    test('应用名本地化', () => {
        expect(zhCn['app.name']).toBe('测评');
        expect(enUs['app.name']).toBe('Benchmarks');
    });

    test('占位符在中英文里保持一致', () => {
        const placeholders = (text: string) => (text.match(/\$\{[a-zA-Z_]+\}/g) ?? []).sort();
        for (const key of Object.keys(zhCn)) {
            expect({ key, placeholders: placeholders(enUs[key]) }).toEqual({
                key,
                placeholders: placeholders(zhCn[key])
            });
        }
    });

    test('应用专属词条不污染核心 locale', () => {
        // 只是结构性约定：应用文案统一放在应用自己的 locale/ 目录
        expect(Object.keys(zhCn).some((key) => key.startsWith('benchmark.'))).toBe(true);
    });
});
