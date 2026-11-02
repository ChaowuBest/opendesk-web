import { parsePluginManifest } from '../../../main/applications/pluginmgr/discovery/manifest.js';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { apiVersion: 1, capabilities: [], ...overrides };
}

describe('插件清单版本字段', () => {
    test('接受 SemVer 版本号', () => {
        expect(parsePluginManifest(manifest({ version: '1.0.0' })).version).toBe('1.0.0');
        expect(parsePluginManifest(manifest({ version: '0.1.0' })).version).toBe('0.1.0');
        expect(parsePluginManifest(manifest({ version: '1.2.3-beta.1' })).version).toBe('1.2.3-beta.1');
        // semver 默认放宽 v 前缀与首尾空白
        expect(parsePluginManifest(manifest({ version: ' v1.2.3 ' })).version).toBe('v1.2.3');
    });

    test('未声明版本时保持 undefined', () => {
        expect(parsePluginManifest(manifest()).version).toBeUndefined();
    });

    test('非 SemVer 版本号被拒绝', () => {
        expect(() => parsePluginManifest(manifest({ version: '1.0' }))).toThrow('plugin.manifest_invalid_version');
        expect(() => parsePluginManifest(manifest({ version: 'latest' }))).toThrow('plugin.manifest_invalid_version');
        expect(() => parsePluginManifest(manifest({ version: '2024-09' }))).toThrow('plugin.manifest_invalid_version');
        expect(() => parsePluginManifest(manifest({ version: '  ' }))).toThrow('plugin.manifest_invalid_version');
    });

    test('宿主兼容范围字段同样要求 SemVer', () => {
        const parsed = parsePluginManifest(manifest({ minOpenDeskVersion: '0.2.0', maxOpenDeskVersion: '0.9.0' }));
        expect(parsed.minOpenDeskVersion).toBe('0.2.0');
        expect(parsed.maxOpenDeskVersion).toBe('0.9.0');

        expect(() => parsePluginManifest(manifest({ minOpenDeskVersion: '0.2' }))).toThrow(
            'plugin.manifest_invalid_min_opendesk_version'
        );
        expect(() => parsePluginManifest(manifest({ maxOpenDeskVersion: '^0.9.0' }))).toThrow(
            'plugin.manifest_invalid_max_opendesk_version'
        );
    });
});
