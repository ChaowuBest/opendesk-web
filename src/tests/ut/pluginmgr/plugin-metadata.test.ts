import { applyPluginManifest, parsePluginManifest } from '../../../main/applications/pluginmgr/discovery/manifest.js';
import { OpenDeskPluginManifestSchema } from '../../../../packages/plugin-sdk/src/package.js';

/**
 * 插件清单的 homepage 字段，以及被移除的 schemaVersion。
 *
 * - `homepage` 与市场条目里的同名字段同义（插件自身站点），只接受 http(s)，
 *   安装时会与市场条目做一致性校验，因此两边必须是同一个地址；
 * - `schemaVersion` 已整体移除：它不参与任何版本协商，旧清单里的这个键按未知字段忽略。
 */

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { apiVersion: 1, capabilities: [], ...overrides };
}

describe('插件清单的 homepage 字段', () => {
    test('未声明时保持 undefined', () => {
        expect(parsePluginManifest(manifest()).homepage).toBeUndefined();
    });

    test('接受 http(s) 地址', () => {
        expect(parsePluginManifest(manifest({ homepage: 'https://gitcode.com/x/y' })).homepage).toBe(
            'https://gitcode.com/x/y'
        );
        expect(parsePluginManifest(manifest({ homepage: 'http://example.com' })).homepage).toBe('http://example.com');
    });

    test('非 http(s) 或不是地址时拒绝', () => {
        expect(() => parsePluginManifest(manifest({ homepage: 'ftp://example.com' }))).toThrow(
            'plugin.manifest_invalid_homepage'
        );
        expect(() => parsePluginManifest(manifest({ homepage: 'javascript:alert(1)' }))).toThrow(
            'plugin.manifest_invalid_homepage'
        );
        expect(() => parsePluginManifest(manifest({ homepage: 'not-a-url' }))).toThrow(
            'plugin.manifest_invalid_homepage'
        );
    });

    test('applyPluginManifest 合并清单里的 homepage', () => {
        const plugin = { id: 'demo', setup: () => ({}) } as Parameters<typeof applyPluginManifest>[0];
        const parsed = parsePluginManifest(manifest({ homepage: 'https://example.com/plugin' }));

        expect(applyPluginManifest(plugin, parsed).homepage).toBe('https://example.com/plugin');
        // 运行时自己声明的地址优先
        expect(applyPluginManifest({ ...plugin, homepage: 'https://runtime.example.com' }, parsed).homepage).toBe(
            'https://runtime.example.com'
        );
    });

    test('打包期 schema 同样校验 homepage', () => {
        const parsed = OpenDeskPluginManifestSchema.parse({
            entry: 'index.js',
            apiVersion: 1,
            capabilities: [],
            description: { 'zh-CN': '演示插件' },
            homepage: 'https://example.com/plugin'
        });

        expect(parsed.homepage).toBe('https://example.com/plugin');
        expect(parsed.description).toEqual({ 'zh-CN': '演示插件' });
        expect(() =>
            OpenDeskPluginManifestSchema.parse({
                entry: 'index.js',
                apiVersion: 1,
                capabilities: [],
                homepage: 'ftp://example.com'
            })
        ).toThrow();
    });
});

describe('插件清单不再有 schemaVersion', () => {
    test('没有该字段也能正常解析', () => {
        expect(parsePluginManifest(manifest({ id: 'demo' })).id).toBe('demo');
    });

    test('旧清单里残留的 schemaVersion 按未知字段忽略（不再报 schema_unsupported）', () => {
        expect(parsePluginManifest(manifest({ id: 'legacy', schemaVersion: 2 })).id).toBe('legacy');
        expect(
            OpenDeskPluginManifestSchema.parse({ entry: 'index.js', apiVersion: 1, capabilities: [], schemaVersion: 2 })
        ).not.toHaveProperty('schemaVersion');
    });
});

describe('插件清单的 iconUrl 字段', () => {
    test('未声明时保持 undefined', () => {
        expect(parsePluginManifest(manifest()).iconUrl).toBeUndefined();
    });

    test('接受 http(s) 图片地址', () => {
        expect(parsePluginManifest(manifest({ iconUrl: 'https://example.com/icon.png' })).iconUrl).toBe(
            'https://example.com/icon.png'
        );
        expect(parsePluginManifest(manifest({ iconUrl: 'http://example.com/icon.png' })).iconUrl).toBe(
            'http://example.com/icon.png'
        );
    });

    test('接受包内相对路径，指向随包分发的图标文件', () => {
        expect(parsePluginManifest(manifest({ iconUrl: 'icon.png' })).iconUrl).toBe('icon.png');
        expect(parsePluginManifest(manifest({ iconUrl: './assets/icon.png' })).iconUrl).toBe('./assets/icon.png');
    });

    test('绝对路径、目录穿越与根相对路径都不接受', () => {
        expect(() => parsePluginManifest(manifest({ iconUrl: '/etc/passwd' }))).toThrow(
            'plugin.manifest_invalid_icon_url'
        );
        expect(() => parsePluginManifest(manifest({ iconUrl: 'C:/Windows/icon.png' }))).toThrow(
            'plugin.manifest_invalid_icon_url'
        );
        expect(() => parsePluginManifest(manifest({ iconUrl: '../outside.png' }))).toThrow(
            'plugin.manifest_invalid_icon_url'
        );
        expect(() => parsePluginManifest(manifest({ iconUrl: 'assets/../../icon.png' }))).toThrow(
            'plugin.manifest_invalid_icon_url'
        );
        // 反斜杠根相对路径（\\share\\icon.png）：宿主与打包期 schema 都要拒，
        // 且不能依赖 path.isAbsolute（POSIX 打包机上它对反斜杠路径返回 false）
        expect(() => parsePluginManifest(manifest({ iconUrl: '\\Windows\\icon.png' }))).toThrow(
            'plugin.manifest_invalid_icon_url'
        );
    });

    test('非 http(s) 地址（如 javascript:、data:）拒绝', () => {
        expect(() => parsePluginManifest(manifest({ iconUrl: 'javascript:alert(1)' }))).toThrow(
            'plugin.manifest_invalid_icon_url'
        );
        expect(() => parsePluginManifest(manifest({ iconUrl: 'data:text/html;base64,PGI+' }))).toThrow(
            'plugin.manifest_invalid_icon_url'
        );
        expect(() => parsePluginManifest(manifest({ iconUrl: 'ftp://example.com/icon.png' }))).toThrow(
            'plugin.manifest_invalid_icon_url'
        );
    });

    test('打包期 schema 同样校验 iconUrl', () => {
        expect(
            OpenDeskPluginManifestSchema.parse({
                entry: 'index.js',
                apiVersion: 1,
                capabilities: [],
                iconUrl: 'https://example.com/icon.png'
            }).iconUrl
        ).toBe('https://example.com/icon.png');
        expect(
            OpenDeskPluginManifestSchema.parse({
                entry: 'index.js',
                apiVersion: 1,
                capabilities: [],
                iconUrl: 'assets/icon.png'
            }).iconUrl
        ).toBe('assets/icon.png');
        expect(() =>
            OpenDeskPluginManifestSchema.parse({
                entry: 'index.js',
                apiVersion: 1,
                capabilities: [],
                iconUrl: 'javascript:alert(1)'
            })
        ).toThrow();
        expect(() =>
            OpenDeskPluginManifestSchema.parse({
                entry: 'index.js',
                apiVersion: 1,
                capabilities: [],
                iconUrl: '../outside.png'
            })
        ).toThrow();
        expect(() =>
            OpenDeskPluginManifestSchema.parse({
                entry: 'index.js',
                apiVersion: 1,
                capabilities: [],
                iconUrl: '\\Windows\\icon.png'
            })
        ).toThrow();
    });
});
