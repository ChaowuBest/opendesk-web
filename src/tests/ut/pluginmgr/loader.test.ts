import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolvePluginEntry } from '../../../main/applications/pluginmgr/discovery/loader.js';
import { OPENDESK_RUNTIME_VERSION } from '../../../main/utils/version.js';
import { loadPluginResources, readPluginManifest } from '../../../main/applications/pluginmgr/discovery/manifest.js';

describe('OpenDesk plugin loader', () => {
    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-loader-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('插件兼容检查版本与根包版本保持同步', () => {
        const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8')) as {
            version: string;
        };
        expect(OPENDESK_RUNTIME_VERSION).toBe(packageJson.version);
    });

    test('优先读取 package.json 中声明的 OpenDesk 入口', () => {
        fs.mkdirSync(path.join(root, 'dist'));
        fs.writeFileSync(path.join(root, 'dist', 'plugin.js'), 'export default {};');
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ opendesk: { plugin: './dist/plugin.js' } }));

        const resolved = resolvePluginEntry(root, root);

        expect(resolved.entry).toBe(path.join(root, 'dist', 'plugin.js'));
        expect(resolved.rootDir).toBe(root);
    });

    test('从 standalone manifest 解析插件入口', () => {
        fs.mkdirSync(path.join(root, 'dist'));
        fs.writeFileSync(path.join(root, 'dist', 'plugin.js'), 'export default {};');
        fs.writeFileSync(
            path.join(root, 'opendesk.plugin.json'),
            JSON.stringify({
                schemaVersion: 1,
                id: 'standalone',
                entry: './dist/plugin.js',
                apiVersion: 1,
                capabilities: []
            })
        );

        expect(resolvePluginEntry(root, root)).toEqual({
            entry: path.join(root, 'dist', 'plugin.js'),
            rootDir: root
        });
    });

    test('拒绝指向插件目录之外的入口', () => {
        const outside = path.join(path.dirname(root), 'outside.js');
        fs.writeFileSync(outside, 'export default {};');
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ opendesk: { plugin: '../outside.js' } }));

        expect(() => resolvePluginEntry(root, root)).toThrow('plugin.entry_outside_root');

        fs.rmSync(outside, { force: true });
    });

    test('无 package 声明时加载目录 index 文件', () => {
        const entry = path.join(root, 'index.mjs');
        fs.writeFileSync(entry, 'export default {};');

        expect(resolvePluginEntry(root, root).entry).toBe(entry);
    });

    test('安装插件必须显式声明 OpenDesk 原生入口', () => {
        fs.writeFileSync(path.join(root, 'index.js'), 'export default {};');
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ main: './index.js' }));

        expect(() => resolvePluginEntry(root, root, { requireDeclaration: true })).toThrow('plugin.entry_not_declared');
    });

    test('从 package.json 读取插件分发声明', () => {
        const entry = path.join(root, 'index.js');
        fs.writeFileSync(entry, 'export default {};');
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({
                name: 'opendesk-plugin-secure',
                version: '1.2.3',
                opendesk: {
                    plugin: './index.js',
                    schemaVersion: 1,
                    id: 'secure',
                    apiVersion: 1,
                    capabilities: ['tool', 'hook'],
                    minOpenDeskVersion: '0.2.0'
                }
            })
        );

        expect(readPluginManifest(entry, root)).toEqual({
            schemaVersion: 1,
            entry: './index.js',
            id: 'secure',
            displayName: undefined,
            description: undefined,
            version: '1.2.3',
            apiVersion: 1,
            capabilities: ['tool', 'hook'],
            minOpenDeskVersion: '0.2.0',
            maxOpenDeskVersion: undefined,
            contributions: undefined
        });
    });

    test('加载 manifest 声明的 Skill 目录和 MCP server', () => {
        const entry = path.join(root, 'index.js');
        const skillDirectory = path.join(root, 'skills', 'review-code');
        fs.mkdirSync(skillDirectory, { recursive: true });
        fs.writeFileSync(entry, 'export default {};');
        fs.writeFileSync(
            path.join(skillDirectory, 'SKILL.md'),
            `---
name: review-code
description: Review code changes
metadata:
    source: plugin
user-invocable: false
---
Review the current changes.`
        );
        fs.writeFileSync(
            path.join(root, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'contributor',
                apiVersion: 1,
                capabilities: ['skill', 'mcp'],
                resources: {
                    skills: ['./skills'],
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

        const manifest = readPluginManifest(entry, root);
        const resources = loadPluginResources(manifest, root);

        expect(resources.skills).toEqual([
            expect.objectContaining({
                name: 'review-code',
                description: 'Review code changes',
                body: 'Review the current changes.',
                directory: fs.realpathSync(skillDirectory),
                frontmatter: expect.objectContaining({ metadata: { source: 'plugin' } }),
                userInvocable: false,
                modelInvocable: true
            })
        ]);
        expect(resources.mcpServers).toEqual([
            {
                name: 'project-files',
                transport: 'stdio',
                command: 'node',
                args: ['./server.js'],
                cwd: fs.realpathSync(root),
                env: undefined
            }
        ]);
    });

    test('拒绝越过插件根目录的 manifest Skill 路径', () => {
        const entry = path.join(root, 'index.js');
        fs.writeFileSync(entry, 'export default {};');
        fs.writeFileSync(
            path.join(root, 'opendesk.plugin.json'),
            JSON.stringify({
                apiVersion: 1,
                capabilities: ['skill'],
                resources: { skills: ['../outside'] }
            })
        );

        const manifest = readPluginManifest(entry, root);
        expect(() => loadPluginResources(manifest, root)).toThrow('plugin.manifest_skill_path_invalid:outside_root');
    });

    test('manifest contribution 必须声明对应 capability', () => {
        const entry = path.join(root, 'index.js');
        fs.writeFileSync(entry, 'export default {};');
        fs.writeFileSync(
            path.join(root, 'opendesk.plugin.json'),
            JSON.stringify({
                apiVersion: 1,
                capabilities: [],
                resources: { skills: ['./skills'] }
            })
        );

        expect(() => readPluginManifest(entry, root)).toThrow('plugin.manifest_resource_capability_missing:skill');
    });

    test('拒绝未知的 capability 声明', () => {
        const entry = path.join(root, 'index.js');
        fs.writeFileSync(entry, 'export default {};');
        fs.writeFileSync(
            path.join(root, 'opendesk.plugin.json'),
            JSON.stringify({ apiVersion: 1, capabilities: ['root-access'] })
        );

        expect(() => readPluginManifest(entry, root)).toThrow('plugin.manifest_unknown_capability');
    });

    test('在导入插件代码前拒绝非法 manifest id', () => {
        const entry = path.join(root, 'index.js');
        fs.writeFileSync(entry, 'export default {};');
        fs.writeFileSync(
            path.join(root, 'opendesk.plugin.json'),
            JSON.stringify({ id: '../unsafe', apiVersion: 1, capabilities: [] })
        );

        expect(() => readPluginManifest(entry, root)).toThrow('plugin.manifest_invalid_id');
    });
});
