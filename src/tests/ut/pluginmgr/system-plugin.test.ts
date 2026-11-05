import fs from 'fs';
import os from 'os';
import path from 'path';
import { discoverPlugins } from '../../../main/applications/pluginmgr/discovery/discovery.js';
import {
    isPluginEnabledFixed,
    listVisiblePlugins,
    setPluginEnabled
} from '../../../main/applications/pluginmgr/management/manager.js';
import { getPluginRecord, upsertPluginRecord } from '../../../main/applications/pluginmgr/management/registry.js';
import { getPluginsDirectory } from '../../../main/applications/pluginmgr/management/paths.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

function writePlugin(directory: string, id: string, manifestExtra: Record<string, unknown> = {}): void {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
        path.join(directory, 'opendesk.plugin.json'),
        JSON.stringify({
            id,
            entry: './index.js',
            apiVersion: 1,
            capabilities: [],
            ...manifestExtra
        })
    );
    fs.writeFileSync(path.join(directory, 'index.js'), `export default { id: '${id}', setup() {} };`);
}

describe('内置插件清单固定启停（system / enabled）', () => {
    let configDirectory: string;
    let builtinDirectory: string;
    let previousBuiltinDirectory: string | undefined;

    beforeEach(() => {
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-system-'));
        builtinDirectory = path.join(configDirectory, 'builtin');
        previousBuiltinDirectory = process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = builtinDirectory;
        // 附加插件目录经 Setting 读取配置，必须指向隔离目录，否则会读到开发机上的真实配置
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

    test('system + enabled=false 的内置插件仍可被发现，但标记为禁用', () => {
        writePlugin(path.join(builtinDirectory, 'account'), 'account', { system: true, enabled: false });

        const [candidate] = discoverPlugins({ configDirectory }).candidates;

        expect(candidate).toMatchObject({ id: 'account', source: 'builtin', system: true, enabled: false });
    });

    test('system 未声明 enabled 时默认始终启用', () => {
        writePlugin(path.join(builtinDirectory, 'account'), 'account', { system: true });

        const [candidate] = discoverPlugins({ configDirectory }).candidates;

        expect(candidate).toMatchObject({ system: true, enabled: true });
    });

    test('system 的启停状态以清单为准，忽略注册表里的用户开关', () => {
        writePlugin(path.join(builtinDirectory, 'account'), 'account', { system: true, enabled: true });
        upsertPluginRecord(
            {
                id: 'account',
                source: 'builtin',
                path: 'account',
                enabled: false,
                options: {}
            },
            configDirectory
        );

        const [candidate] = discoverPlugins({ configDirectory }).candidates;

        expect(candidate).toMatchObject({ system: true, enabled: true });
    });

    test('后装插件声明 system/enabled 时被忽略，开关仍由注册表决定', () => {
        writePlugin(path.join(getPluginsDirectory(configDirectory), 'review-helper'), 'review-helper', {
            system: true,
            enabled: false
        });

        const [candidate] = discoverPlugins({ configDirectory }).candidates;

        expect(candidate).toMatchObject({ source: 'local', system: false, enabled: true });
        expect(isPluginEnabledFixed('review-helper', { configDirectory })).toBe(false);
    });

    test('isPluginEnabledFixed 只对内置插件返回 true', () => {
        writePlugin(path.join(builtinDirectory, 'account'), 'account', { system: true });
        writePlugin(path.join(builtinDirectory, 'plain'), 'plain');

        expect(isPluginEnabledFixed('account', { configDirectory })).toBe(true);
        expect(isPluginEnabledFixed('plain', { configDirectory })).toBe(false);
        expect(isPluginEnabledFixed('unknown', { configDirectory })).toBe(false);
    });

    test('内置插件通过 package.json#opendesk 声明 system 同样固定启停', () => {
        // readPluginManifest（GUI/TUI 列表）支持 package.json#opendesk 声明；
        // discovery 侧必须读到同一份声明，否则会出现「列表显示锁定、CLI 却能改开关」的分裂
        const directory = path.join(builtinDirectory, 'packaged');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
            path.join(directory, 'package.json'),
            JSON.stringify({
                name: 'packaged',
                version: '1.0.0',
                opendesk: { plugin: './index.js', apiVersion: 1, capabilities: [], system: true }
            })
        );
        fs.writeFileSync(path.join(directory, 'index.js'), `export default { id: 'packaged', setup() {} };`);

        const [candidate] = discoverPlugins({ configDirectory }).candidates;
        expect(candidate).toMatchObject({ id: 'packaged', system: true, enabled: true });

        expect(isPluginEnabledFixed('packaged', { configDirectory })).toBe(true);
        expect(setPluginEnabled('packaged', false, { configDirectory })).toBe(false);
        expect(getPluginRecord('packaged', configDirectory)).toBeUndefined();
    });

    test('setPluginEnabled 拒绝修改固定启停的插件，且不写入注册表', () => {
        writePlugin(path.join(builtinDirectory, 'account'), 'account', { system: true, enabled: true });

        expect(setPluginEnabled('account', false, { configDirectory })).toBe(false);
        expect(setPluginEnabled('account', true, { configDirectory })).toBe(false);
        expect(getPluginRecord('account', configDirectory)).toBeUndefined();
    });

    test('setPluginEnabled 对声明了 system 的后装插件照常生效', () => {
        writePlugin(path.join(getPluginsDirectory(configDirectory), 'review-helper'), 'review-helper', {
            system: true
        });

        expect(setPluginEnabled('review-helper', false, { configDirectory })).toBe(true);
        expect(getPluginRecord('review-helper', configDirectory)?.enabled).toBe(false);
    });

    test('listVisiblePlugins 展示清单固定的禁用状态，与是否有注册表记录无关', () => {
        writePlugin(path.join(builtinDirectory, 'account'), 'account', { system: true, enabled: false });

        const records = listVisiblePlugins({ configDirectory });

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ id: 'account', source: 'builtin', enabled: false, system: true });
    });

    test('listVisiblePlugins 对普通插件不标记 system，供 CLI/TUI 列表区分', () => {
        writePlugin(path.join(builtinDirectory, 'plain'), 'plain');

        const records = listVisiblePlugins({ configDirectory });

        expect(records[0]?.system).toBe(false);
    });

    test('listVisiblePlugins 对 system 插件忽略注册表里的禁用状态', () => {
        writePlugin(path.join(builtinDirectory, 'account'), 'account', { system: true, enabled: true });
        upsertPluginRecord(
            {
                id: 'account',
                source: 'builtin',
                path: 'account',
                enabled: false,
                options: {}
            },
            configDirectory
        );

        const records = listVisiblePlugins({ configDirectory });

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ id: 'account', enabled: true });
    });
});
