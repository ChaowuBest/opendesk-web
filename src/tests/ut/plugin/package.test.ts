import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    OpenDeskPluginPackageError,
    validateOpenDeskPluginDirectory,
    validateOpenDeskPluginPackage
} from '../../../../packages/plugin-sdk/src/package.js';

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
                contributions: {
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

    test('拒绝未声明对应 capability 的 contribution', () => {
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
                    contributions: {
                        skills: ['./skills']
                    }
                }
            })
        );

        expect(() => validateOpenDeskPluginPackage(root)).toThrow(
            'plugin skill contribution requires the skill capability'
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
                    contributions: {
                        skills: ['../outside']
                    }
                }
            })
        );

        expect(() => validateOpenDeskPluginPackage(root)).toThrow('Unsafe plugin path');
    });
});
