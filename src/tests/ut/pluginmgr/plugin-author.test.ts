import { applyPluginManifest, parsePluginManifest } from '../../../main/applications/pluginmgr/discovery/manifest.js';
import { OpenDeskPluginManifestSchema } from '../../../../packages/plugin-sdk/src/package.js';

/**
 * 插件元数据里的 author 字段。
 *
 * 契约：`{ name, institution?, homepage? }`，name / institution 支持
 * 字符串或按语言声明的对象；它只用于界面展示（插件详情 + 插件市场卡片），
 * 不参与加载与权限判定，因此可以被安全地省略。
 */

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { apiVersion: 1, capabilities: [], ...overrides };
}

describe('插件清单的 author 字段', () => {
    test('未声明时保持 undefined', () => {
        expect(parsePluginManifest(manifest()).author).toBeUndefined();
    });

    test('支持本地化 name / institution 与 homepage', () => {
        expect(
            parsePluginManifest(
                manifest({
                    author: {
                        name: { 'zh-CN': '张三', 'en-US': 'Zhang San' },
                        institution: { 'zh-CN': '开放原子开源基金会', 'en-US': 'OpenAtom Foundation' },
                        homepage: 'https://example.com/team'
                    }
                })
            ).author
        ).toEqual({
            name: { zh: '张三', en: 'Zhang San' },
            institution: { zh: '开放原子开源基金会', en: 'OpenAtom Foundation' },
            homepage: 'https://example.com/team'
        });
    });

    test('name / institution 也可以是纯字符串', () => {
        expect(
            parsePluginManifest(manifest({ author: { name: 'OpenDesk Team', institution: 'OpenAtom' } })).author
        ).toEqual({
            name: 'OpenDesk Team',
            institution: 'OpenAtom',
            homepage: undefined
        });
    });

    test('缺 name、类型不对或 homepage 不是 http(s) 时拒绝', () => {
        expect(() => parsePluginManifest(manifest({ author: 'OpenDesk Team' }))).toThrow(
            'plugin.manifest_invalid_author'
        );
        expect(() => parsePluginManifest(manifest({ author: { institution: 'OpenAtom' } }))).toThrow(
            'plugin.manifest_invalid_author'
        );
        expect(() => parsePluginManifest(manifest({ author: { name: '' } }))).toThrow('plugin.manifest_invalid_author');
        expect(() => parsePluginManifest(manifest({ author: { name: 'A', homepage: 'javascript:alert(1)' } }))).toThrow(
            'plugin.manifest_invalid_author'
        );
        expect(() => parsePluginManifest(manifest({ author: { name: 'A', homepage: 'not-a-url' } }))).toThrow(
            'plugin.manifest_invalid_author'
        );
    });

    test('applyPluginManifest 把清单里的作者合并进运行时对象', () => {
        const plugin = { id: 'demo', setup: () => ({}) } as Parameters<typeof applyPluginManifest>[0];
        const parsed = parsePluginManifest(manifest({ author: { name: 'OpenDesk Team' } }));

        expect(applyPluginManifest(plugin, parsed).author).toEqual({
            name: 'OpenDesk Team',
            institution: undefined,
            homepage: undefined
        });
        // 运行时自己声明的作者优先，与其它元数据字段的优先级一致
        expect(applyPluginManifest({ ...plugin, author: { name: 'Runtime Team' } }, parsed).author).toEqual({
            name: 'Runtime Team'
        });
    });

    test('打包期 schema 同样接受 author 并校验 homepage', () => {
        const parsed = OpenDeskPluginManifestSchema.parse({
            entry: 'index.js',
            apiVersion: 1,
            capabilities: [],
            author: { name: { 'zh-CN': '张三' }, homepage: 'https://example.com' }
        });

        expect(parsed.author).toEqual({ name: { 'zh-CN': '张三' }, homepage: 'https://example.com' });
        expect(
            OpenDeskPluginManifestSchema.parse({ entry: 'index.js', apiVersion: 1, capabilities: [] }).author
        ).toBeUndefined();
        // 打包期与宿主解析同一套协议限制：非 http(s) 主页在发布前就被拒绝
        expect(() =>
            OpenDeskPluginManifestSchema.parse({
                entry: 'index.js',
                apiVersion: 1,
                capabilities: [],
                author: { name: 'A', homepage: 'ftp://example.com' }
            })
        ).toThrow();
    });
});
