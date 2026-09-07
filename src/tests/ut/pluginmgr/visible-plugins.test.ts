import fs from 'fs';
import os from 'os';
import path from 'path';
import { listVisiblePlugins } from '../../../main/applications/pluginmgr/management/manager.js';
import { getPluginsDirectory } from '../../../main/applications/pluginmgr/management/paths.js';
import { upsertPluginRecord } from '../../../main/applications/pluginmgr/management/registry.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';
import { PluginMgrApplication } from '../../../main/applications/pluginmgr/app.js';

function writePlugin(directory: string, id: string, manifestExtra: Record<string, unknown> = {}): void {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
        path.join(directory, 'opendesk.plugin.json'),
        JSON.stringify({
            schemaVersion: 1,
            id,
            entry: './index.js',
            apiVersion: 1,
            capabilities: [],
            ...manifestExtra
        })
    );
    fs.writeFileSync(path.join(directory, 'index.js'), `export default { id: '${id}', setup() {} };`);
}

describe('pluginmgr listVisiblePlugins', () => {
    let configDirectory: string;
    let builtinDirectory: string;
    let previousBuiltinDirectory: string | undefined;

    beforeEach(() => {
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-visible-'));
        builtinDirectory = path.join(configDirectory, 'builtin');
        // 隔离内置插件目录，避免发现到仓库里真实的内置插件
        previousBuiltinDirectory = process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = builtinDirectory;
        // getPluginManagerConfig 经 Setting 读取外部路径配置，需指向隔离目录
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

    test('registry 记录与内置插件合并展示，与 GUI 口径一致', () => {
        writePlugin(path.join(getPluginsDirectory(configDirectory), 'review-helper'), 'review-helper');
        writePlugin(path.join(builtinDirectory, 'feishu'), 'feishu');
        upsertPluginRecord(
            {
                id: 'review-helper',
                source: 'local',
                path: 'review-helper',
                enabled: true,
                options: {},
                installedAt: '2026-01-01T00:00:00.000Z'
            },
            configDirectory
        );

        const records = listVisiblePlugins(configDirectory);

        expect(records.map((record) => record.id)).toEqual(['feishu', 'review-helper']);
        const feishu = records.find((record) => record.id === 'feishu');
        expect(feishu?.source).toBe('builtin');
        expect(feishu?.enabled).toBe(true);
        expect(feishu?.path).toBe(path.join(builtinDirectory, 'feishu'));
        const review = records.find((record) => record.id === 'review-helper');
        expect(review?.source).toBe('local');
        expect(review?.installedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    test('禁用的内置插件保留 registry 记录中的 enabled=false 状态', () => {
        writePlugin(path.join(builtinDirectory, 'feishu'), 'feishu');
        upsertPluginRecord(
            {
                id: 'feishu',
                source: 'builtin',
                path: path.join('feishu'),
                enabled: false,
                options: {}
            },
            configDirectory
        );

        const records = listVisiblePlugins(configDirectory);

        expect(records).toHaveLength(1);
        expect(records[0]?.enabled).toBe(false);
    });

    test('registry 记录的展示路径优先采用 discovery 的绝对路径（与 GUI 一致）', () => {
        writePlugin(path.join(builtinDirectory, 'feishu'), 'feishu');
        // 启停内置插件时 registry 会写入相对路径（path.relative(builtinDirectory, spec)）
        upsertPluginRecord(
            {
                id: 'feishu',
                source: 'builtin',
                path: path.join('feishu'),
                enabled: true,
                options: {}
            },
            configDirectory
        );

        const records = listVisiblePlugins(configDirectory);

        expect(records).toHaveLength(1);
        expect(records[0]?.path).toBe(path.join(builtinDirectory, 'feishu'));
    });

    test('未被 discovery 覆盖的 registry 记录按来源解析为绝对路径', () => {
        writePlugin(path.join(builtinDirectory, 'feishu'), 'feishu');
        upsertPluginRecord(
            {
                id: 'feishu',
                source: 'builtin',
                path: path.join('feishu'),
                enabled: false,
                options: {}
            },
            configDirectory
        );

        const records = listVisiblePlugins(configDirectory);

        expect(records).toHaveLength(1);
        expect(records[0]?.path).toBe(path.join(builtinDirectory, 'feishu'));
    });

    test('平台不匹配的插件不出现在列表中', () => {
        writePlugin(path.join(builtinDirectory, 'hm-compat'), 'hm-compat', {
            platforms: ['openharmony']
        });

        const records = listVisiblePlugins(configDirectory);

        expect(records).toEqual([]);
    });

    test('平台不匹配的插件即使存在启用的 registry 记录也不出现在列表中', () => {
        writePlugin(path.join(builtinDirectory, 'hm-compat'), 'hm-compat', {
            platforms: ['openharmony']
        });
        upsertPluginRecord(
            {
                id: 'hm-compat',
                source: 'builtin',
                path: 'hm-compat',
                enabled: true,
                options: {}
            },
            configDirectory
        );

        const records = listVisiblePlugins(configDirectory);

        expect(records).toEqual([]);
    });

    test('平台不匹配的禁用插件记录同样不出现在列表中', () => {
        writePlugin(path.join(builtinDirectory, 'hm-compat'), 'hm-compat', {
            platforms: ['openharmony']
        });
        upsertPluginRecord(
            {
                id: 'hm-compat',
                source: 'builtin',
                path: 'hm-compat',
                enabled: false,
                options: {}
            },
            configDirectory
        );

        const records = listVisiblePlugins(configDirectory);

        expect(records).toEqual([]);
    });

    test('externalPaths 中的外部路径插件出现在列表中（与 GUI 口径一致）', () => {
        const externalDirectory = path.join(configDirectory, 'external-root');
        writePlugin(path.join(externalDirectory, 'sidecar'), 'sidecar');

        const records = listVisiblePlugins({
            configDirectory,
            externalPaths: [path.join(externalDirectory, 'sidecar')]
        });

        expect(records.map((record) => record.id)).toEqual(['sidecar']);
        expect(records[0]?.source).toBe('external');
        expect(records[0]?.path).toBe(path.join(externalDirectory, 'sidecar'));
    });

    test('settings.json 的 externalPaths 未显式传参时同样生效', () => {
        const externalDirectory = path.join(configDirectory, 'external-root');
        writePlugin(path.join(externalDirectory, 'sidecar'), 'sidecar');
        // 注册 pluginmgr 配置 Schema，否则 setData 会剥离 applications.pluginmgr
        ApplicationRegistry.registerApplication(new PluginMgrApplication());
        Setting.getInstance().setData({
            applications: { pluginmgr: { externalPaths: [path.join(externalDirectory, 'sidecar')] } }
        } as never);

        const records = listVisiblePlugins({ configDirectory });

        expect(records.map((record) => record.id)).toEqual(['sidecar']);
        expect(records[0]?.source).toBe('external');
    });
});
