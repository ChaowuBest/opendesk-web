import { zhCn as skillZhCn } from '../../../main/applications/skillmgr/locale/zh-cn.js';
import { enUs as skillEnUs } from '../../../main/applications/skillmgr/locale/en-us.js';
import { t as skillT } from '../../../main/applications/skillmgr/locale/index.js';
import { createTranslatorForSkillMgr } from '../../../main/applications/skillmgr/locale/renderer.js';
import { zhCn as appZhCn } from '../../../locale/zh-cn.js';
import { enUs as appEnUs } from '../../../locale/en-us.js';
import { setRuntimeLocale } from '../../../locale/index.js';
import { resolveRendererLocale } from '../../../renderer/locale.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENTRY_JS_PATH = fileURLToPath(new URL('../../../main/applications/skillmgr/renderer/entry.js', import.meta.url));

/**
 * 提取 entry.js 中引用的全部 locale key：
 * - this._t('...') 等字面量调用
 * - DEFAULT_SLOGAN_KEY 常量值
 * - TEST_FAILURE_REASON_CATEGORY_KEYS 映射值
 */
function extractReferencedLocaleKeys(src: string): string[] {
    const keys = new Set<string>();
    for (const m of src.matchAll(/_t\(\s*'([^']+)'/g)) {
        keys.add(m[1]);
    }
    const defaultSloganKey = src.match(/DEFAULT_SLOGAN_KEY\s*=\s*'([^']+)'/);
    if (defaultSloganKey) keys.add(defaultSloganKey[1]);
    const failureKeys = src.match(/TEST_FAILURE_REASON_CATEGORY_KEYS\s*=\s*\{([^}]*)\}/);
    if (failureKeys) {
        for (const m of failureKeys[1].matchAll(/'([^']+)'/g)) keys.add(m[1]);
    }
    return [...keys];
}

function keyDiff(a: Record<string, string>, b: Record<string, string>): string[] {
    const missingInB = Object.keys(a).filter((k) => !(k in b));
    const missingInA = Object.keys(b).filter((k) => !(k in a));
    return [...missingInB, ...missingInA];
}

describe('skillmgr locale', () => {
    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('per-app zh-CN and en-US dictionaries have identical key sets', () => {
        expect(keyDiff(skillZhCn, skillEnUs)).toEqual([]);
    });

    test('app name is 技能中心 in zh-CN and Skills in en-US', () => {
        expect(skillZhCn['app.name']).toBe('技能中心');
        expect(skillEnUs['app.name']).toBe('Skills');
    });

    test('main-process t() follows the active locale and interpolates params', () => {
        setRuntimeLocale('zh-CN');
        expect(skillT('app.name')).toBe('技能中心');
        expect(skillT('skill.install.denied')).toBe('插件已阻止本次 Skill 安装。');

        setRuntimeLocale('en-US');
        expect(skillT('app.name')).toBe('Skills');
        expect(skillT('renderer.skill.analyze.totalSkills', { count: 3 })).toBe('3 skills in total');
    });

    test('main-process t() returns the key itself for unknown keys', () => {
        expect(skillT('skillmgr.does.not.exist')).toBe('skillmgr.does.not.exist');
    });

    test('renderer translator resolves locale from setting and interpolates params', () => {
        expect(createTranslatorForSkillMgr({ locale: 'zh-CN' })('renderer.skill.batch.delete.title')).toBe(
            '批量删除技能'
        );
        expect(createTranslatorForSkillMgr({ locale: 'en-US' })('renderer.skill.batch.delete.title')).toBe(
            'Batch Delete Skills'
        );
        expect(
            createTranslatorForSkillMgr({ locale: 'zh-CN' })('renderer.skill.delete.confirm', { id: 'demo' })
        ).toContain('<b>demo</b>');
        expect(createTranslatorForSkillMgr({ locale: 'en-US' })('renderer.skill.count.installed', { count: 2 })).toBe(
            '2 skills installed'
        );
    });

    test('locale switch detection matches the hot-swap contract', () => {
        // onSettingChanged 广播的是原始 setting（无 resolved_locale），显式语言必须能直接命中
        expect(resolveRendererLocale({ locale: 'zh-CN', resolved_locale: 'zh-CN' })).toBe('zh-CN');
        expect(resolveRendererLocale({ locale: 'en-US' })).toBe('en-US');
        // loadSettingObject 附带 resolved_locale，auto 设置按主进程解析结果渲染
        expect(resolveRendererLocale({ locale: 'auto', resolved_locale: 'zh-CN' })).toBe('zh-CN');
        expect(resolveRendererLocale({ locale: 'auto', resolved_locale: 'en-US' })).toBe('en-US');
        expect(resolveRendererLocale('en-US')).toBe('en-US');

        const needsRefresh = (prev: unknown, next: unknown) =>
            resolveRendererLocale(next) !== resolveRendererLocale(prev);
        expect(needsRefresh({ locale: 'zh-CN', resolved_locale: 'zh-CN' }, { locale: 'zh-CN' })).toBe(false);
        expect(needsRefresh({ locale: 'zh-CN', resolved_locale: 'zh-CN' }, { locale: 'en-US' })).toBe(true);
        expect(needsRefresh({ locale: 'auto', resolved_locale: 'zh-CN' }, { locale: 'en-US' })).toBe(true);

        // 翻译器按新设置重建后输出随即切换（渲染层整体重渲染依赖此契约）
        let currentSetting: unknown = { locale: 'auto', resolved_locale: 'zh-CN' };
        const t = () => createTranslatorForSkillMgr(currentSetting as { locale?: string });
        expect(t()('renderer.skill.tab.analyze')).toBe('分析与优化');
        currentSetting = { locale: 'en-US' };
        expect(t()('renderer.skill.tab.analyze')).toBe('Analyze & Optimize');
        expect(t()('renderer.skill.detail.done')).toBe('Done');
    });

    test('skillmgr-specific keys stay out of the OpenDesk core locale (no pollution)', () => {
        for (const key of Object.keys(skillZhCn)) {
            // app.name 是各应用共用的通用键
            if (key === 'app.name') continue;
            expect(key in appZhCn).toBe(false);
            expect(key in appEnUs).toBe(false);
        }
    });

    test('every locale key referenced by skillmgr entry.js exists in both dictionaries', () => {
        const src = readFileSync(ENTRY_JS_PATH, 'utf8');
        const referenced = extractReferencedLocaleKeys(src);
        expect(referenced.length).toBeGreaterThan(0);
        const missingInZh = referenced.filter((k) => !(k in skillZhCn));
        const missingInEn = referenced.filter((k) => !(k in skillEnUs));
        expect(missingInZh).toEqual([]);
        expect(missingInEn).toEqual([]);
    });

    test('entry.js must not reference the removed DEFAULT_SLOGAN identifier', () => {
        // 回归：重构为 DEFAULT_SLOGAN_KEY 后 REGISTRY_TABS 仍引用旧标识符，
        // 模块加载即抛 ReferenceError 导致整个技能中心无法启动
        const src = readFileSync(ENTRY_JS_PATH, 'utf8');
        expect(src.match(/DEFAULT_SLOGAN(?!_KEY)/)?.[0]).toBeUndefined();
    });
});
