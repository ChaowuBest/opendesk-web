import fs from 'fs';
import os from 'os';
import path from 'path';
import { PluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { resolveUninstallTarget, uninstallPlugin } from '../../../main/applications/pluginmgr/management/manager.js';
import {
    ensurePluginDataDirectory,
    getPluginDataDirectory,
    getPluginsDirectory,
    getPluginTrashDirectory
} from '../../../main/applications/pluginmgr/management/paths.js';
import { upsertPluginRecord } from '../../../main/applications/pluginmgr/management/registry.js';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';

/** 写入一个最小可卸载的本地插件目录（manifest + 入口） */
function writePluginDirectory(configDirectory: string, id: string): string {
    const directory = path.join(getPluginsDirectory(configDirectory), id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
        path.join(directory, 'opendesk.plugin.json'),
        JSON.stringify({ id, entry: './index.js', apiVersion: 1, capabilities: [] })
    );
    fs.writeFileSync(path.join(directory, 'index.js'), `export default { id: '${id}', setup() {} };`);
    return directory;
}

function registerPlugin(configDirectory: string, id: string): void {
    upsertPluginRecord(
        {
            id,
            source: 'local',
            path: id,
            enabled: true,
            options: {},
            installedAt: '2026-01-01T00:00:00.000Z'
        },
        configDirectory
    );
}

describe('插件私有数据目录', () => {
    let configDirectory: string;
    let host: PluginHost;

    beforeEach(() => {
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-data-'));
        host = new PluginHost();
    });

    afterEach(async () => {
        await host.dispose();
        fs.rmSync(configDirectory, { recursive: true, force: true });
    });

    test('激活插件时注入 ctx.dataDir，目录已创建且在 plugins/.pluginmgr/data 下', async () => {
        let received: string | undefined;
        await host.activate(
            definePlugin({
                id: 'data-fixture',
                capabilities: [],
                setup(ctx) {
                    received = ctx.dataDir;
                }
            }),
            { origin: 'test:data-fixture', configDir: configDirectory }
        );

        const expected = path.join(configDirectory, 'plugins', '.pluginmgr', 'data', 'data-fixture');
        expect(received).toBe(expected);
        expect(fs.existsSync(expected)).toBe(true);
    });

    test('数据目录建不出来时不抛错，也不影响插件激活', async () => {
        // 配置目录位置被一个普通文件占住：mkdir 必然失败。数据目录只是插件的可选
        // 持久化区域，不能因此让整个插件加载失败（否则宿主会留下无法回滚的幽灵实例）。
        const blockedConfig = path.join(configDirectory, 'blocked-config');
        fs.writeFileSync(blockedConfig, 'not a directory');

        expect(() => ensurePluginDataDirectory('blocked-plugin', blockedConfig)).not.toThrow();

        let setupCalled = false;
        const entry = await host.activate(
            definePlugin({
                id: 'blocked-plugin',
                capabilities: [],
                setup() {
                    setupCalled = true;
                }
            }),
            { origin: 'test:blocked-plugin', configDir: blockedConfig }
        );

        expect(setupCalled).toBe(true);
        expect(entry.status).toBe('active');
    });

    test('卸载默认保留数据目录，重新激活同一插件后数据仍在', async () => {
        const pluginDirectory = writePluginDirectory(configDirectory, 'keep-data');
        registerPlugin(configDirectory, 'keep-data');

        const firstHost = new PluginHost();
        await firstHost.activate(
            definePlugin({
                id: 'keep-data',
                capabilities: [],
                setup(ctx) {
                    fs.writeFileSync(path.join(ctx.dataDir, 'state.json'), '{"counter":1}');
                }
            }),
            { origin: 'test:keep-data', configDir: configDirectory }
        );
        await firstHost.dispose();

        const result = await uninstallPlugin('keep-data', { configDirectory });

        expect(result).toEqual({ success: true });
        expect(fs.existsSync(pluginDirectory)).toBe(false);
        const dataDirectory = getPluginDataDirectory('keep-data', configDirectory);
        expect(fs.readFileSync(path.join(dataDirectory, 'state.json'), 'utf-8')).toBe('{"counter":1}');

        // 重新安装后再次激活：拿到的还是同一个数据目录，原有数据可直接继承
        writePluginDirectory(configDirectory, 'keep-data');
        let received: string | undefined;
        await host.activate(
            definePlugin({
                id: 'keep-data',
                capabilities: [],
                setup(ctx) {
                    received = ctx.dataDir;
                }
            }),
            { origin: 'test:keep-data', configDir: configDirectory }
        );

        expect(received).toBe(dataDirectory);
        expect(fs.existsSync(path.join(received!, 'state.json'))).toBe(true);
    });

    test('卸载时勾选删除数据才清理数据目录，且插件目录仍进 trash 可追溯', async () => {
        writePluginDirectory(configDirectory, 'drop-data');
        registerPlugin(configDirectory, 'drop-data');
        const dataDirectory = getPluginDataDirectory('drop-data', configDirectory);
        fs.mkdirSync(dataDirectory, { recursive: true });
        fs.writeFileSync(path.join(dataDirectory, 'cache.bin'), 'cached');

        const result = await uninstallPlugin('drop-data', { configDirectory, removeData: true });

        expect(result).toEqual({ success: true });
        expect(fs.existsSync(dataDirectory)).toBe(false);
        // 数据目录直接删除，只有插件代码目录进 trash（避免同 basename 的 trash 撞名）
        const trashed = fs
            .readdirSync(getPluginTrashDirectory(configDirectory))
            .filter((name) => name.startsWith('drop-data-'));
        expect(trashed).toHaveLength(1);
    });

    test('数据目录不存在时删除数据也照常完成卸载', async () => {
        writePluginDirectory(configDirectory, 'no-data');
        registerPlugin(configDirectory, 'no-data');

        const result = await uninstallPlugin('no-data', { configDirectory, removeData: true });

        expect(result).toEqual({ success: true });
        expect(fs.existsSync(getPluginDataDirectory('no-data', configDirectory))).toBe(false);
        expect(fs.existsSync(path.join(getPluginsDirectory(configDirectory), 'no-data'))).toBe(false);
    });

    test('删除数据目录按插件 id 拼接，不依赖磁盘目录名', async () => {
        // 注册表记录里的 id 与容器目录名不一致（旧数据 / 手工改名的目录）：
        // 数据目录必须按 id 拼，删的也是 id 对应的那一份
        const directory = path.join(getPluginsDirectory(configDirectory), 'case-plugin');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
            path.join(directory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'Case-Plugin',
                entry: './index.js',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(path.join(directory, 'index.js'), "export default { id: 'Case-Plugin', setup() {} };");
        upsertPluginRecord(
            {
                id: 'Case-Plugin',
                source: 'local',
                path: 'case-plugin',
                enabled: true,
                options: {},
                installedAt: '2026-01-01T00:00:00.000Z'
            },
            configDirectory
        );

        const dataDirectory = getPluginDataDirectory('Case-Plugin', configDirectory);
        fs.mkdirSync(dataDirectory, { recursive: true });
        fs.writeFileSync(path.join(dataDirectory, 'state.json'), '{}');

        // 卸载目标是 plugins/<容器目录名>，而数据目录按插件 id 拼接（两者大小写不同）
        expect(resolveUninstallTarget('Case-Plugin', configDirectory)).toEqual({ ok: true, target: directory });

        const result = await uninstallPlugin('Case-Plugin', { configDirectory, removeData: true });

        expect(result).toEqual({ success: true });
        expect(fs.existsSync(dataDirectory)).toBe(false);
        expect(fs.existsSync(directory)).toBe(false);
    });
});
