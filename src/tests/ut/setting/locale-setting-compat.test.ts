import { resolveLocaleSetting, resolvePreferredLocale } from '../../../common/locale.js';
import { Setting } from '../../../main/utils/setting.js';

describe('语言包动态语言的设置兼容性', () => {
    test('设置 schema 放行为 auto 或 BCP-47 语言 tag', () => {
        const localeSchema = Setting.getSettingSchema().shape.locale;
        expect(localeSchema.safeParse('auto').success).toBe(true);
        expect(localeSchema.safeParse('zh-CN').success).toBe(true);
        expect(localeSchema.safeParse('tr-TR').success).toBe(true);
        expect(localeSchema.safeParse('id-ID').success).toBe(true);
        expect(localeSchema.safeParse('pt-BR').success).toBe(true);
        // 非法格式仍拒绝
        expect(localeSchema.safeParse('not a tag!').success).toBe(false);
        expect(localeSchema.safeParse('1').success).toBe(false);
    });

    test('显式语言命中可用集合时直接返回（规范化）', () => {
        expect(resolveLocaleSetting('tr-TR', [], ['zh-CN', 'en-US', 'tr-TR'])).toBe('tr-TR');
        expect(resolveLocaleSetting('tr_TR', [], ['zh-CN', 'en-US', 'tr-TR'])).toBe('tr-TR');
    });

    test('语言包卸载后的残留值回退系统语言解析', () => {
        expect(resolveLocaleSetting('tr-TR', ['zh-Hans-CN'], ['zh-CN', 'en-US'])).toBe('zh-CN');
        expect(resolveLocaleSetting('tr-TR', ['fr-FR'], ['zh-CN', 'en-US'])).toBe('en-US');
    });

    test('auto 模式在可用集合内做最佳匹配（精确 -> 主语言）', () => {
        const available = ['en-US', 'id-ID', 'tr-TR', 'zh-CN'];
        expect(resolvePreferredLocale(['tr-TR'], available)).toBe('tr-TR');
        expect(resolvePreferredLocale(['tr'], available)).toBe('tr-TR');
        expect(resolvePreferredLocale(['id-ID'], available)).toBe('id-ID');
        expect(resolvePreferredLocale(['zh-Hans-CN'], available)).toBe('zh-CN');
        // 未命中任何可用语言时保持 en-US 兜底
        expect(resolvePreferredLocale(['ja-JP'], available)).toBe('en-US');
    });

    test('默认可用集合仍为内置语言，保持既有解析结果', () => {
        expect(resolvePreferredLocale(['zh-Hant-TW'])).toBe('zh-CN');
        expect(resolvePreferredLocale(['ja-JP', 'zh-Hans-CN'])).toBe('en-US');
        expect(resolveLocaleSetting('zh-CN', ['en-US'])).toBe('zh-CN');
    });
});
