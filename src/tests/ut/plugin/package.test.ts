import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    OpenDeskPluginManifestSchema,
    OpenDeskPluginPackageError,
    validateOpenDeskPluginDirectory,
    validateOpenDeskPluginPackage
} from '../../../../packages/plugin-sdk/src/package.js';
import { isValidVersion } from '../../../main/utils/version.js';

describe('OpenDesk plugin package validator', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-package-'));
        fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(root, 'dist', 'plugin.js'), 'export default {};');
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('接受静态 Skill 和 MCP contribution 声明', () => {
        fs.mkdirSync(path.join(root, 'skills', 'review-code'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({
                name: 'opendesk-plugin-contributor',
                version: '1.0.0'
            })
        );
        fs.writeFileSync(
            path.join(root, 'opendesk.plugin.json'),
            JSON.stringify({
                entry: './dist/plugin.js',
                schemaVersion: 1,
                apiVersion: 1,
                capabilities: ['skill', 'mcp'],
                resources: {
                    skills: ['./skills/review-code'],
                    mcpServers: [
                        {
                            name: 'project-files',
                            transport: 'stdio',
                            command: 'node',
                            args: ['./server.js'],
                            cwd: '.'
                        }
                    ]
                }
            })
        );

        expect(validateOpenDeskPluginPackage(root)).toMatchObject({
            name: 'opendesk-plugin-contributor',
            entry: path.join(root, 'dist', 'plugin.js'),
            capabilities: ['skill', 'mcp']
        });
    });

    test('兼容 package.json 中的 opendesk 声明', () => {
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({
                name: 'opendesk-plugin-package-declaration',
                version: '1.0.0',
                opendesk: {
                    plugin: './dist/plugin.js',
                    schemaVersion: 1,
                    apiVersion: 1,
                    capabilities: []
                }
            })
        );

        expect(validateOpenDeskPluginPackage(root)).toMatchObject({
            name: 'opendesk-plugin-package-declaration',
            entry: path.join(root, 'dist', 'plugin.js')
        });
    });

    test('接受只包含 standalone manifest 的插件目录', () => {
        fs.writeFileSync(
            path.join(root, 'opendesk.plugin.json'),
            JSON.stringify({
                entry: './dist/plugin.js',
                schemaVersion: 1,
                id: 'standalone-plugin',
                version: '1.2.3',
                apiVersion: 1,
                capabilities: []
            })
        );

        expect(validateOpenDeskPluginDirectory(root)).toMatchObject({
            id: 'standalone-plugin',
            name: 'standalone-plugin',
            version: '1.2.3',
            entry: path.join(root, 'dist', 'plugin.js')
        });
    });

    test('区分缺少插件声明与格式错误的插件声明', () => {
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({
                name: 'ordinary-package',
                version: '1.0.0'
            })
        );

        let missingDeclarationError: unknown;
        try {
            validateOpenDeskPluginPackage(root);
        } catch (error) {
            missingDeclarationError = error;
        }
        expect(missingDeclarationError).toBeInstanceOf(OpenDeskPluginPackageError);
        expect(missingDeclarationError).toMatchObject({
            code: 'plugin_declaration_missing'
        });

        fs.writeFileSync(path.join(root, 'opendesk.plugin.json'), JSON.stringify([]));

        let invalidManifestError: unknown;
        try {
            validateOpenDeskPluginPackage(root);
        } catch (error) {
            invalidManifestError = error;
        }
        expect(invalidManifestError).toBeInstanceOf(OpenDeskPluginPackageError);
        expect(invalidManifestError).toMatchObject({
            code: 'plugin_manifest_invalid'
        });
    });

    test('拒绝 standalone manifest 与 package.json 声明冲突', () => {
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({
                name: 'opendesk-plugin-conflict',
                version: '1.0.0',
                opendesk: {
                    plugin: './dist/other.js',
                    id: 'other',
                    schemaVersion: 1,
                    apiVersion: 1,
                    capabilities: []
                }
            })
        );
        fs.writeFileSync(
            path.join(root, 'opendesk.plugin.json'),
            JSON.stringify({
                entry: './dist/plugin.js',
                id: 'plugin',
                schemaVersion: 1,
                apiVersion: 1,
                capabilities: []
            })
        );

        expect(() => validateOpenDeskPluginPackage(root)).toThrow(
            'opendesk.plugin.json conflicts with package.json#opendesk'
        );
    });

    test('拒绝未声明对应 capability 的静态资源', () => {
        fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({
                name: 'opendesk-plugin-invalid',
                version: '1.0.0',
                opendesk: {
                    plugin: './dist/plugin.js',
                    schemaVersion: 1,
                    apiVersion: 1,
                    capabilities: [],
                    resources: {
                        skills: ['./skills']
                    }
                }
            })
        );

        expect(() => validateOpenDeskPluginPackage(root)).toThrow(
            'plugin skill resource requires the skill capability'
        );
    });

    test('拒绝越过插件根目录的静态资源路径', () => {
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({
                name: 'opendesk-plugin-invalid',
                version: '1.0.0',
                opendesk: {
                    plugin: './dist/plugin.js',
                    schemaVersion: 1,
                    apiVersion: 1,
                    capabilities: ['skill'],
                    resources: {
                        skills: ['../outside']
                    }
                }
            })
        );

        expect(() => validateOpenDeskPluginPackage(root)).toThrow('Unsafe plugin path');
    });

    test('displayName 支持本地化对象形式并拒绝非法值', () => {
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({ name: 'opendesk-plugin-localized', version: '1.0.0' })
        );
        fs.writeFileSync(
            path.join(root, 'opendesk.plugin.json'),
            JSON.stringify({
                entry: './dist/plugin.js',
                schemaVersion: 1,
                apiVersion: 1,
                capabilities: [],
                displayName: { en: 'Localized Plugin', zh: '本地化插件' }
            })
        );

        expect(validateOpenDeskPluginDirectory(root)).toMatchObject({
            name: 'opendesk-plugin-localized'
        });

        fs.writeFileSync(
            path.join(root, 'opendesk.plugin.json'),
            JSON.stringify({
                entry: './dist/plugin.js',
                schemaVersion: 1,
                apiVersion: 1,
                capabilities: [],
                displayName: { en: '' }
            })
        );

        expect(() => validateOpenDeskPluginDirectory(root)).toThrow(OpenDeskPluginPackageError);
    });
});

/**
 * 打包期（插件 SDK，自带正则）与运行期（宿主 pluginmgr，semver 库）对版本号的判定
 * 必须完全一致，否则会出现「CLI 打包通过、宿主加载报错」这种事后才发现的问题。
 */
describe('版本号规则与宿主保持一致', () => {
    const SAMPLES = [
        '1.2.3',
        'v1.2.3',
        ' 1.2.3 ',
        '0.0.0',
        '1.2.3-alpha',
        '1.2.3-0a',
        '1.2.3-alpha.1',
        '1.2.3-beta+exp.sha.5114f85',
        '1.2.3+build.5',
        '1.0',
        'V1.2.3',
        'latest',
        '01.2.3',
        '1.2.3-01',
        '1.2.3-alpha..b',
        '1.2.3-.',
        '1.2.3+a..b',
        '1.2.3-',
        '1.2.3-a_b',
        '9007199254740992.0.0',
        ''
    ];

    test('SDK 清单校验与宿主 SemVer 判定结论一致', () => {
        for (const version of SAMPLES) {
            const parsed = OpenDeskPluginManifestSchema.safeParse({
                entry: './dist/plugin.js',
                apiVersion: 1,
                capabilities: [],
                version
            });
            expect({ version, accepted: parsed.success }).toEqual({ version, accepted: isValidVersion(version) });
        }
    });
});
