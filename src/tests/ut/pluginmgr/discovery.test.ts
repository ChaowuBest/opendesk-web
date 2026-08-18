import fs from 'fs';
import os from 'os';
import path from 'path';
import { discoverPlugins, verifyPluginRecord } from '../../../main/applications/pluginmgr/discovery/discovery.js';
import { getPluginsDirectory } from '../../../main/applications/pluginmgr/management/paths.js';
import { upsertPluginRecord } from '../../../main/applications/pluginmgr/management/registry.js';
import { computePluginIntegrity } from '../../../main/applications/pluginmgr/discovery/integrity.js';

function writePlugin(directory: string, id: string): void {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
        path.join(directory, 'opendesk.plugin.json'),
        JSON.stringify({
            schemaVersion: 1,
            id,
            entry: './index.js',
            apiVersion: 1,
            capabilities: []
        })
    );
    fs.writeFileSync(path.join(directory, 'index.js'), `export default { id: '${id}', setup() {} };`);
}

describe('pluginmgr discovery', () => {
    let configDirectory: string;

    beforeEach(() => {
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-discovery-'));
    });

    afterEach(() => {
        fs.rmSync(configDirectory, { recursive: true, force: true });
    });

    test('扫描 OpenDesk 配置目录下的 plugins 一级子目录和单文件插件', () => {
        const pluginsDirectory = getPluginsDirectory(configDirectory);
        expect(pluginsDirectory).toBe(path.join(configDirectory, 'plugins'));
        writePlugin(path.join(pluginsDirectory, 'review-helper'), 'review-helper');
        fs.writeFileSync(path.join(pluginsDirectory, 'loose.mjs'), `export default { id: 'loose', setup() {} };`);
        fs.mkdirSync(path.join(pluginsDirectory, '.pluginmgr'), { recursive: true });
        fs.writeFileSync(path.join(pluginsDirectory, '.pluginmgr', 'ignored.js'), 'export default {};');

        const result = discoverPlugins({ configDirectory });

        expect(result.conflicts).toEqual([]);
        expect(result.candidates.map((candidate) => candidate.id)).toEqual(['loose', 'review-helper']);
        expect(result.candidates.every((candidate) => candidate.source === 'local')).toBe(true);
    });

    test('重复插件 id 被诊断并阻止激活', () => {
        const pluginsDirectory = getPluginsDirectory(configDirectory);
        writePlugin(path.join(pluginsDirectory, 'first'), 'duplicate');
        writePlugin(path.join(pluginsDirectory, 'second'), 'duplicate');

        const result = discoverPlugins({ configDirectory });

        expect(result.candidates).toEqual([]);
        expect(result.conflicts).toEqual([
            {
                id: 'duplicate',
                paths: [path.join(pluginsDirectory, 'first'), path.join(pluginsDirectory, 'second')]
            }
        ]);
    });

    test('读取配置的外部插件路径', () => {
        const externalDirectory = path.join(configDirectory, 'external-review');
        writePlugin(externalDirectory, 'external-review');

        const result = discoverPlugins({
            configDirectory,
            externalPaths: [externalDirectory]
        });

        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]).toMatchObject({
            id: 'external-review',
            source: 'external',
            spec: externalDirectory
        });
    });

    test('扫描启动参数指定的插件集合目录', () => {
        const pluginsDirectory = path.join(configDirectory, 'runtime-plugins');
        writePlugin(path.join(pluginsDirectory, 'runtime-review'), 'runtime-review');
        fs.writeFileSync(
            path.join(pluginsDirectory, 'runtime-loose.mjs'),
            `export default { id: 'runtime-loose', setup() {} };`
        );

        const result = discoverPlugins({
            configDirectory,
            pluginDirectories: [pluginsDirectory]
        });

        expect(result.conflicts).toEqual([]);
        expect(result.candidates).toEqual([
            expect.objectContaining({
                id: 'runtime-loose',
                source: 'external',
                spec: path.join(pluginsDirectory, 'runtime-loose.mjs')
            }),
            expect.objectContaining({
                id: 'runtime-review',
                source: 'external',
                spec: path.join(pluginsDirectory, 'runtime-review')
            })
        ]);
    });

    test('扫描构建产物目录中的内置插件', () => {
        const builtinDirectory = path.join(configDirectory, 'builtin');
        writePlugin(path.join(builtinDirectory, 'builtin-review'), 'builtin-review');

        const result = discoverPlugins({
            configDirectory,
            builtinDirectory
        });

        expect(result.conflicts).toEqual([]);
        expect(result.candidates).toEqual([
            expect.objectContaining({
                id: 'builtin-review',
                source: 'builtin',
                managed: false,
                spec: path.join(builtinDirectory, 'builtin-review')
            })
        ]);
    });

    test('内置插件优先于同 id 的用户插件', () => {
        const builtinDirectory = path.join(configDirectory, 'builtin');
        const pluginsDirectory = getPluginsDirectory(configDirectory);
        writePlugin(path.join(builtinDirectory, 'review-helper'), 'review-helper');
        writePlugin(path.join(pluginsDirectory, 'review-helper'), 'review-helper');

        const result = discoverPlugins({
            configDirectory,
            builtinDirectory
        });

        expect(result.conflicts).toEqual([]);
        expect(result.candidates).toEqual([
            expect.objectContaining({
                id: 'review-helper',
                source: 'builtin',
                spec: path.join(builtinDirectory, 'review-helper')
            })
        ]);
    });

    test('校验受管插件完整性', () => {
        const pluginDirectory = path.join(getPluginsDirectory(configDirectory), 'managed', 'package');
        writePlugin(pluginDirectory, 'managed');
        const integrity = computePluginIntegrity(pluginDirectory);
        const record = {
            id: 'managed',
            source: 'managed' as const,
            path: path.relative(getPluginsDirectory(configDirectory), pluginDirectory),
            enabled: true,
            integrity,
            options: {}
        };
        upsertPluginRecord(record, configDirectory);

        expect(verifyPluginRecord(record, configDirectory)).toMatchObject({
            integrityStatus: 'verified',
            allowed: true
        });

        fs.appendFileSync(path.join(pluginDirectory, 'index.js'), '\n// changed');
        expect(verifyPluginRecord(record, configDirectory)).toMatchObject({
            integrityStatus: 'mismatch',
            allowed: false
        });
    });
});
