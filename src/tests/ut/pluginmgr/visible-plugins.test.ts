import fs from 'fs';
import os from 'os';
import path from 'path';
import { listVisiblePlugins } from '../../../main/applications/pluginmgr/management/manager.js';
import { getPluginsDirectory } from '../../../main/applications/pluginmgr/management/paths.js';
import { upsertPluginRecord } from '../../../main/applications/pluginmgr/management/registry.js';
import { disposePluginHost } from '../../../main/applications/pluginmgr/runtime/bootstrap.js';
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

    afterEach(async () => {
        if (previousBuiltinDirectory === undefined) delete process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        else process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = previousBuiltinDirectory;
        await disposePluginHost();
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

    test('settings.json 的 externalPaths 作为附加插件目录进入列表', () => {
        const externalDirectory = path.join(configDirectory, 'external-root');
        writePlugin(path.join(externalDirectory, 'sidecar'), 'sidecar');
        // 注册 pluginmgr 配置 Schema，否则 setData 会剥离 applications.pluginmgr
        ApplicationRegistry.registerApplication(new PluginMgrApplication());
        Setting.getInstance().setData({
            applications: { pluginmgr: { externalPaths: [path.join(externalDirectory, 'sidecar')] } }
        } as never);

        const records = listVisiblePlugins({ configDirectory });

        expect(records.map((record) => record.id)).toEqual(['sidecar']);
        // 附加插件目录按内置插件处理
        expect(records[0]?.source).toBe('builtin');
        expect(records[0]?.path).toBe(path.join(externalDirectory, 'sidecar'));
    });

    test('残留的 local 记录不覆盖实际按内置插件加载的来源与路径', async () => {
        // 先装到 plugins 目录、后来同名插件出现在内置目录：记录仍是 local，但加载的是内置那份
        writePlugin(path.join(builtinDirectory, 'review'), 'review');
        upsertPluginRecord(
            {
                id: 'review',
                source: 'local',
                path: 'review',
                enabled: true,
                options: {}
            },
            configDirectory
        );

        const [record] = listVisiblePlugins({ configDirectory });

        // source 必须与 path/enabled 同一口径，否则 GUI 会把不可卸载的内置插件显示成本地插件
        expect(record).toMatchObject({ id: 'review', source: 'builtin', path: path.join(builtinDirectory, 'review') });

        // GUI 管理页（PluginMgrApplication.list）必须同口径
        const [guiEntry] = await new PluginMgrApplication().list();
        expect(guiEntry).toMatchObject({
            id: 'review',
            source: 'builtin',
            removable: false,
            path: path.join(builtinDirectory, 'review')
        });
    });
});
