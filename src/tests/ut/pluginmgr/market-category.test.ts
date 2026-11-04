import { applyPluginManifest, parsePluginManifest } from '../../../main/applications/pluginmgr/discovery/manifest.js';
import { OpenDeskPluginManifestSchema } from '../../../../packages/plugin-sdk/src/package.js';

/**
 * 插件元数据里的 category 字段。
 *
 * 它是给插件市场做分类显示用的纯展示信息：
 * - 可省略（省略就是「未分类」，内置插件因此不受影响）；
 * - 可声明多个分类；
 * - 声明了内容不合法的 category 要当成清单错误报出来，而不是静默丢掉。
 */

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { apiVersion: 1, capabilities: [], ...overrides };
}

describe('插件清单的 category 字段', () => {
    test('未声明时保持 undefined（内置插件不受影响）', () => {
        expect(parsePluginManifest(manifest()).category).toBeUndefined();
    });

    test('支持多个分类并去掉首尾空白', () => {
        expect(parsePluginManifest(manifest({ category: [' 开发工具 ', '效率'] })).category).toEqual([
            '开发工具',
            '效率'
        ]);
    });

    test('非字符串数组被拒绝', () => {
        expect(() => parsePluginManifest(manifest({ category: '开发工具' }))).toThrow(
            'plugin.manifest_invalid_category'
        );
        expect(() => parsePluginManifest(manifest({ category: [''] }))).toThrow('plugin.manifest_invalid_category');
        expect(() => parsePluginManifest(manifest({ category: [1] }))).toThrow('plugin.manifest_invalid_category');
    });

    test('applyPluginManifest 把清单里的分类合并进运行时对象', () => {
        const plugin = { id: 'demo', setup: () => ({}) } as Parameters<typeof applyPluginManifest>[0];

        expect(applyPluginManifest(plugin, parsePluginManifest(manifest({ category: ['效率'] }))).category).toEqual([
            '效率'
        ]);
        // 运行时自己声明的分类优先，与其它元数据字段的优先级一致
        expect(
            applyPluginManifest(
                { ...plugin, category: ['开发工具'] },
                parsePluginManifest(manifest({ category: ['效率'] }))
            ).category
        ).toEqual(['开发工具']);
    });

    test('打包期 schema 同样接受 category', () => {
        const parsed = OpenDeskPluginManifestSchema.parse({
            entry: 'index.js',
            apiVersion: 1,
            capabilities: [],
            category: ['开发工具']
        });

        expect(parsed.category).toEqual(['开发工具']);
        expect(
            OpenDeskPluginManifestSchema.parse({ entry: 'index.js', apiVersion: 1, capabilities: [] }).category
        ).toBeUndefined();
    });
});
