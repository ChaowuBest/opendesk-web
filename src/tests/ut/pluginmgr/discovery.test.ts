import fs from 'fs';
import os from 'os';
import path from 'path';
import { discoverPlugins, verifyPluginRecord } from '../../../main/applications/pluginmgr/discovery/discovery.js';
import { getPluginsDirectory } from '../../../main/applications/pluginmgr/management/paths.js';
import { upsertPluginRecord } from '../../../main/applications/pluginmgr/management/registry.js';
import { computePluginIntegrity } from '../../../main/applications/pluginmgr/discovery/integrity.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

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
    let previousBuiltinDirectory: string | undefined;

    beforeEach(() => {
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-discovery-'));
        // 隔离内置插件目录，避免发现到仓库里真实的内置插件
        previousBuiltinDirectory = process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = path.join(configDirectory, 'builtin-empty');
        // 附加插件目录经 Setting 读取 externalPaths，必须指向隔离目录，否则会带上开发机的真实配置
        setCustomOpendeskDirectory(configDirectory);
        Setting.clearCache();
    });

    afterEach(() => {
        if (previousBuiltinDirectory === undefined) delete process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        else process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = previousBuiltinDirectory;
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
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

    test('附加插件目录中的插件按内置插件被发现', () => {
        const builtinDirectory = path.join(configDirectory, 'builtin');
        const additionalDirectory = path.join(configDirectory, 'additional');
        writePlugin(path.join(builtinDirectory, 'builtin-review'), 'builtin-review');
        writePlugin(path.join(additionalDirectory, 'extra-review'), 'extra-review');

        const result = discoverPlugins({
            configDirectory,
            builtinDirectories: [builtinDirectory, additionalDirectory]
        });

        expect(result.conflicts).toEqual([]);
        expect(result.candidates.map((candidate) => [candidate.id, candidate.source, candidate.origin])).toEqual([
            ['builtin-review', 'builtin', builtinDirectory],
            ['extra-review', 'builtin', additionalDirectory]
        ]);
    });

    test('扫描构建产物目录中的内置插件', () => {
        const builtinDirectory = path.join(configDirectory, 'builtin');
        writePlugin(path.join(builtinDirectory, 'builtin-review'), 'builtin-review');

        const result = discoverPlugins({
            configDirectory,
            builtinDirectories: [builtinDirectory]
        });

        expect(result.conflicts).toEqual([]);
        expect(result.candidates).toEqual([
            expect.objectContaining({
                id: 'builtin-review',
                source: 'builtin',
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
            builtinDirectories: [builtinDirectory]
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
