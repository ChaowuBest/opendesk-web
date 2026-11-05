import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { discoverPlugins } from '../../../main/applications/pluginmgr/discovery/discovery.js';
import {
    PLUGINS_DIRECTORY_ENV,
    BUILTIN_PLUGINS_DIRECTORY_ENV,
    findUnusablePluginDirectories,
    getBuiltinPluginsDirectories,
    setRuntimePluginsDirectories
} from '../../../main/applications/pluginmgr/management/paths.js';
import {
    listVisiblePlugins,
    setPluginEnabled,
    uninstallPlugin
} from '../../../main/applications/pluginmgr/management/manager.js';
import { getPluginRecord, upsertPluginRecord } from '../../../main/applications/pluginmgr/management/registry.js';
import {
    setPluginGrantedCapabilities,
    setPluginOptions
} from '../../../main/applications/pluginmgr/management/policy.js';
import { disposePluginHost, initializePluginHost } from '../../../main/applications/pluginmgr/runtime/bootstrap.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { logger } from '../../../main/utils/logger.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

function writePlugin(directory: string, id: string, extra: Record<string, unknown> = {}): void {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
        path.join(directory, 'opendesk.plugin.json'),
        JSON.stringify({
            id,
            entry: './index.js',
            apiVersion: 1,
            capabilities: [],
            ...extra
        })
    );
    fs.writeFileSync(path.join(directory, 'index.js'), `export default { id: '${id}', setup() {} };`);
}

describe('附加插件目录（内置插件同等对待）', () => {
    let configDirectory: string;
    let builtinDirectory: string;
    let additionalDirectory: string;
    let previousBuiltinPluginsDirectory: string | undefined;
    let previousPluginsDirectory: string | undefined;
    let warnSpy: jest.SpiedFunction<typeof logger.warn>;

    beforeEach(() => {
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-additional-plugins-'));
        builtinDirectory = path.join(configDirectory, 'builtin');
        additionalDirectory = path.join(configDirectory, 'additional');
        previousBuiltinPluginsDirectory = process.env[BUILTIN_PLUGINS_DIRECTORY_ENV];
        previousPluginsDirectory = process.env[PLUGINS_DIRECTORY_ENV];
        process.env[BUILTIN_PLUGINS_DIRECTORY_ENV] = builtinDirectory;
        delete process.env[PLUGINS_DIRECTORY_ENV];
        setRuntimePluginsDirectories('');
        setCustomOpendeskDirectory(configDirectory);
        Setting.clearCache();
        warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    });

    afterEach(async () => {
        warnSpy.mockRestore();
        await disposePluginHost();
        setRuntimePluginsDirectories('');
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        if (previousBuiltinPluginsDirectory === undefined) delete process.env[BUILTIN_PLUGINS_DIRECTORY_ENV];
        else process.env[BUILTIN_PLUGINS_DIRECTORY_ENV] = previousBuiltinPluginsDirectory;
        if (previousPluginsDirectory === undefined) delete process.env[PLUGINS_DIRECTORY_ENV];
        else process.env[PLUGINS_DIRECTORY_ENV] = previousPluginsDirectory;
        fs.rmSync(configDirectory, { recursive: true, force: true });
    });

    test('环境变量按逗号拆分多个目录，其中的插件来源为 builtin', () => {
        const secondDirectory = path.join(configDirectory, 'additional-second');
        writePlugin(path.join(additionalDirectory, 'extra-review'), 'extra-review');
        writePlugin(path.join(secondDirectory, 'extra-docs'), 'extra-docs');
        writePlugin(path.join(builtinDirectory, 'builtin-review'), 'builtin-review');
        process.env[PLUGINS_DIRECTORY_ENV] = ` ${additionalDirectory} , ${secondDirectory} `;

        const ids = discoverPlugins({ configDirectory })
            .candidates.map((candidate) => `${candidate.id}:${candidate.source}`)
            .sort();

        expect(ids).toEqual(['builtin-review:builtin', 'extra-docs:builtin', 'extra-review:builtin']);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('非法路径只告警一次并继续加载其它目录', () => {
        const missingDirectory = path.join(configDirectory, 'missing');
        const notADirectory = path.join(configDirectory, 'not-a-directory.txt');
        fs.writeFileSync(notADirectory, 'plain file');
        writePlugin(path.join(additionalDirectory, 'extra-review'), 'extra-review');
        process.env[PLUGINS_DIRECTORY_ENV] = `${missingDirectory},${notADirectory},${additionalDirectory}`;

        // 多次发现（如插件重载）不该反复刷同一条告警
        expect(discoverPlugins({ configDirectory }).candidates.map((candidate) => candidate.id)).toEqual([
            'extra-review'
        ]);
        expect(discoverPlugins({ configDirectory }).candidates.map((candidate) => candidate.id)).toEqual([
            'extra-review'
        ]);

        const messages = warnSpy.mock.calls.map((call) => String(call[0]));
        expect(messages).toEqual([expect.stringContaining(missingDirectory), expect.stringContaining(notADirectory)]);
    });

    test('附加目录里不是插件的条目静默跳过，自称插件却加载不了的留告警', () => {
        writePlugin(path.join(additionalDirectory, 'extra-review'), 'extra-review');
        // 文档目录、没有清单的散装脚本：都不是合法插件，保持安静
        fs.mkdirSync(path.join(additionalDirectory, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(additionalDirectory, 'notes.md'), '# notes');
        fs.writeFileSync(path.join(additionalDirectory, 'loose.js'), 'export default 1;');
        // 声明了入口但入口文件不存在：自称插件却加载不了，必须留下可排查的线索
        fs.mkdirSync(path.join(additionalDirectory, 'broken'), { recursive: true });
        fs.writeFileSync(
            path.join(additionalDirectory, 'broken', 'opendesk.plugin.json'),
            JSON.stringify({ id: 'broken', entry: './missing.js', apiVersion: 1 })
        );
        // 清单本身损坏（非法 JSON）：同样要告警，否则只会表现为「插件不见了」
        fs.mkdirSync(path.join(additionalDirectory, 'corrupt'), { recursive: true });
        fs.writeFileSync(path.join(additionalDirectory, 'corrupt', 'opendesk.plugin.json'), '{ "id": ');
        process.env[PLUGINS_DIRECTORY_ENV] = additionalDirectory;

        expect(discoverPlugins({ configDirectory }).candidates.map((candidate) => candidate.id)).toEqual([
            'extra-review'
        ]);
        const messages = warnSpy.mock.calls.map((call) => String(call[0]));
        expect(messages).toHaveLength(2);
        expect(messages[0]).toContain(path.join(additionalDirectory, 'broken'));
        // 告警要说明原因，否则只知道「没加载」，还是得自己去猜
        expect(messages[0]).toContain('plugin.entry_not_found');
        expect(messages[1]).toContain(path.join(additionalDirectory, 'corrupt'));
    });

    test('附加目录本身就是一个加载不了的插件目录时明确告警，而不是发现 0 个插件', () => {
        const pluginDirectory = path.join(additionalDirectory, 'extra-review');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({ id: 'extra-review', entry: './missing.js', apiVersion: 1 })
        );
        process.env[PLUGINS_DIRECTORY_ENV] = pluginDirectory;

        expect(discoverPlugins({ configDirectory }).candidates).toEqual([]);
        expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([expect.stringContaining(pluginDirectory)]);
    });

    test('附加目录里的失效符号链接不会中断发现', () => {
        writePlugin(path.join(additionalDirectory, 'extra-review'), 'extra-review');
        try {
            fs.symlinkSync(
                path.join(additionalDirectory, 'missing-target'),
                path.join(additionalDirectory, 'dangling'),
                'dir'
            );
        } catch {
            // Windows 非开发者模式下无权创建符号链接，此时跳过该用例
            return;
        }
        process.env[PLUGINS_DIRECTORY_ENV] = additionalDirectory;

        // statSync 对失效链接会抛错，必须按「不是插件」处理，不能让整次发现失败
        expect(discoverPlugins({ configDirectory }).candidates.map((candidate) => candidate.id)).toEqual([
            'extra-review'
        ]);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('附加目录可以直接指向单个插件目录', () => {
        const pluginDirectory = path.join(additionalDirectory, 'extra-review');
        writePlugin(pluginDirectory, 'extra-review');
        process.env[PLUGINS_DIRECTORY_ENV] = pluginDirectory;

        const candidates = discoverPlugins({ configDirectory }).candidates.map((candidate) => ({
            id: candidate.id,
            spec: candidate.spec,
            origin: candidate.origin
        }));

        expect(candidates).toEqual([{ id: 'extra-review', spec: pluginDirectory, origin: pluginDirectory }]);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('CLI 注入的目录与环境变量合并并去重', () => {
        const cliDirectory = path.join(configDirectory, 'cli-plugins');
        writePlugin(path.join(additionalDirectory, 'extra-review'), 'extra-review');
        writePlugin(path.join(cliDirectory, 'cli-review'), 'cli-review');
        process.env[PLUGINS_DIRECTORY_ENV] = additionalDirectory;

        setRuntimePluginsDirectories(` ${cliDirectory} , ${additionalDirectory} `);

        expect(getBuiltinPluginsDirectories().slice(1)).toEqual([additionalDirectory, cliDirectory]);
        expect(
            discoverPlugins({ configDirectory })
                .candidates.map((candidate) => candidate.id)
                .sort()
        ).toEqual(['cli-review', 'extra-review']);
    });

    test('CLI 注入的非法路径同样只告警不中断', () => {
        const missingDirectory = path.join(configDirectory, 'cli-missing');
        writePlugin(path.join(additionalDirectory, 'extra-review'), 'extra-review');

        setRuntimePluginsDirectories(`${missingDirectory},${additionalDirectory}`);

        expect(discoverPlugins({ configDirectory }).candidates.map((candidate) => candidate.id)).toEqual([
            'extra-review'
        ]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(missingDirectory));
    });

    test('附加目录插件的启停策略按绝对路径记录，重新发现后仍解析回原目录', () => {
        writePlugin(path.join(additionalDirectory, 'extra-review'), 'extra-review');
        process.env[PLUGINS_DIRECTORY_ENV] = additionalDirectory;

        expect(setPluginEnabled('extra-review', false, configDirectory)).toBe(true);
        // 附加目录之间可能有同名条目，相对路径无法唯一还原，因此记绝对路径
        expect(getPluginRecord('extra-review', configDirectory)).toMatchObject({
            source: 'builtin',
            path: path.join(additionalDirectory, 'extra-review'),
            enabled: false
        });
        expect(discoverPlugins({ configDirectory }).candidates).toEqual([]);

        expect(setPluginEnabled('extra-review', true, configDirectory)).toBe(true);
        expect(
            listVisiblePlugins({ configDirectory }).map((record) => ({
                id: record.id,
                source: record.source,
                path: record.path
            }))
        ).toEqual([{ id: 'extra-review', source: 'builtin', path: path.join(additionalDirectory, 'extra-review') }]);
    });

    test('附加目录与主内置目录存在同名容器时不会互相顶替', () => {
        // 两个内置目录里各有一个叫 shared 的容器目录，但插件 ID 不同
        writePlugin(path.join(builtinDirectory, 'shared'), 'builtin-shared');
        writePlugin(path.join(additionalDirectory, 'shared'), 'extra-shared');
        process.env[PLUGINS_DIRECTORY_ENV] = additionalDirectory;

        expect(setPluginEnabled('extra-shared', false, configDirectory)).toBe(true);
        expect(setPluginEnabled('extra-shared', true, configDirectory)).toBe(true);

        const specs = new Map(discoverPlugins({ configDirectory }).candidates.map((c) => [c.id, c.spec]));
        expect(specs.get('builtin-shared')).toBe(path.join(builtinDirectory, 'shared'));
        expect(specs.get('extra-shared')).toBe(path.join(additionalDirectory, 'shared'));
    });

    test('附加目录里与内置插件同 ID 的条目被忽略（内置优先）', () => {
        writePlugin(path.join(builtinDirectory, 'review'), 'review');
        writePlugin(path.join(additionalDirectory, 'review-copy'), 'review');
        process.env[PLUGINS_DIRECTORY_ENV] = additionalDirectory;

        const discovery = discoverPlugins({ configDirectory });

        expect(discovery.conflicts).toEqual([]);
        expect(discovery.candidates.map((candidate) => candidate.spec)).toEqual([
            path.join(builtinDirectory, 'review')
        ]);
        expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([
            expect.stringContaining(path.join(additionalDirectory, 'review-copy'))
        ]);
    });

    test('附加目录取消配置后，注册表里的残留记录不再把插件拉进运行时', () => {
        writePlugin(path.join(additionalDirectory, 'extra-review'), 'extra-review');
        process.env[PLUGINS_DIRECTORY_ENV] = additionalDirectory;
        expect(setPluginEnabled('extra-review', false, configDirectory)).toBe(true);
        expect(setPluginEnabled('extra-review', true, configDirectory)).toBe(true);

        // 下一次启动没有传入该附加目录：插件文件还在磁盘上，但记录不该把它拉回来
        process.env[PLUGINS_DIRECTORY_ENV] = '';

        expect(discoverPlugins({ configDirectory }).candidates).toEqual([]);
        expect(getPluginRecord('extra-review', configDirectory)).toMatchObject({ enabled: true });
    });

    test('指向被忽略副本的旧记录不会与目录里的插件撞成发现冲突', () => {
        writePlugin(path.join(builtinDirectory, 'review'), 'review');
        // 附加目录里的同 ID 副本按内置优先被忽略，但它可能留下过一条注册表记录
        writePlugin(path.join(additionalDirectory, 'review-copy'), 'review');
        process.env[PLUGINS_DIRECTORY_ENV] = additionalDirectory;
        upsertPluginRecord(
            {
                id: 'review',
                source: 'builtin',
                path: path.join(additionalDirectory, 'review-copy'),
                enabled: true,
                options: {}
            },
            configDirectory
        );

        const discovery = discoverPlugins({ configDirectory });

        expect(discovery.conflicts).toEqual([]);
        expect(discovery.candidates.map((candidate) => candidate.spec)).toEqual([
            path.join(builtinDirectory, 'review')
        ]);
    });

    test('附加目录里的插件按内置插件处理：清单 system 同样固定启停', () => {
        writePlugin(path.join(additionalDirectory, 'fixed'), 'fixed', { system: true });
        process.env[PLUGINS_DIRECTORY_ENV] = additionalDirectory;

        expect(
            discoverPlugins({ configDirectory }).candidates.find((candidate) => candidate.id === 'fixed')
        ).toMatchObject({ source: 'builtin', system: true, enabled: true });
        // 清单固定启停：写注册表也不会生效，直接拒绝
        expect(setPluginEnabled('fixed', false, configDirectory)).toBe(false);
        expect(getPluginRecord('fixed', configDirectory)).toBeUndefined();
    });

    test('附加目录插件的 options 与权限记录也按绝对路径写入，重新发现后仍能取回', () => {
        writePlugin(path.join(additionalDirectory, 'extra-review'), 'extra-review');
        process.env[PLUGINS_DIRECTORY_ENV] = additionalDirectory;

        setPluginOptions('extra-review', { endpoint: 'dev' });
        setPluginGrantedCapabilities('extra-review', ['tool']);

        expect(getPluginRecord('extra-review', configDirectory)).toMatchObject({
            source: 'builtin',
            path: path.join(additionalDirectory, 'extra-review'),
            options: { endpoint: 'dev' },
            grantedCapabilities: ['tool']
        });
        // 记录里的绝对路径必须能被发现阶段反解回原目录，否则策略每次都要重新写一遍
        expect(
            discoverPlugins({ configDirectory }).candidates.find((candidate) => candidate.id === 'extra-review')
                ?.options
        ).toEqual({ endpoint: 'dev' });
    });

    test('附加目录插件按内置插件处理：不可卸载', async () => {
        writePlugin(path.join(additionalDirectory, 'extra-review'), 'extra-review');
        process.env[PLUGINS_DIRECTORY_ENV] = additionalDirectory;

        await expect(uninstallPlugin('extra-review', { configDirectory })).resolves.toMatchObject({
            success: false,
            error: 'plugin.uninstall_builtin'
        });
        expect(fs.existsSync(path.join(additionalDirectory, 'extra-review'))).toBe(true);
    });

    test('被禁用的附加目录插件卸载时仍提示不可卸载，而不是找不到插件', async () => {
        writePlugin(path.join(additionalDirectory, 'extra-review'), 'extra-review');
        process.env[PLUGINS_DIRECTORY_ENV] = additionalDirectory;
        expect(setPluginEnabled('extra-review', false, configDirectory)).toBe(true);

        await expect(uninstallPlugin('extra-review', { configDirectory })).resolves.toEqual({
            success: false,
            error: 'plugin.uninstall_builtin'
        });
    });

    test('CLI 入口注册 --plugins-directory 并在子命令前转交运行时目录', () => {
        const cliSource = fs.readFileSync(path.resolve(process.cwd(), 'src/main/cli.ts'), 'utf8');

        expect(cliSource).toContain("'--plugins-directory <paths>'");
        // 子命令不会触发根命令 action，必须挂在 preAction 钩子上
        expect(cliSource).toContain("prog.hook('preAction'");
        expect(cliSource).toContain('setRuntimePluginsDirectories(pluginsDirectory)');
        // 一次性子命令把 logger 输出收进内存缓冲，非法目录必须直接提示到终端
        expect(cliSource).toContain('findUnusablePluginDirectories(pluginsDirectory)');
    });

    test('非法目录条目可被单独检出，供终端提示', () => {
        const missingDirectory = path.join(configDirectory, 'cli-missing');
        const notADirectory = path.join(configDirectory, 'cli-file.txt');
        fs.writeFileSync(notADirectory, 'plain file');
        writePlugin(path.join(additionalDirectory, 'extra-review'), 'extra-review');

        expect(
            findUnusablePluginDirectories(` ${missingDirectory} , ${notADirectory} , ${additionalDirectory} `)
        ).toEqual([missingDirectory, notADirectory]);
        expect(findUnusablePluginDirectories('')).toEqual([]);
    });

    test('环境变量帮助文档包含附加插件目录', async () => {
        const { OPENDESK_ENV_VAR_DOCS } = await import('../../../main/tui/env.js');

        expect(OPENDESK_ENV_VAR_DOCS.map((entry) => entry.name)).toContain(PLUGINS_DIRECTORY_ENV);
    });

    test('插件宿主会加载附加目录中的插件，并把 origin 记为该目录', async () => {
        const pluginDirectory = path.join(additionalDirectory, 'extra-review');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({ id: 'extra-review', entry: './index.mjs', apiVersion: 1 })
        );
        fs.writeFileSync(path.join(pluginDirectory, 'index.mjs'), `export default { id: 'extra-review', setup() {} };`);
        process.env[PLUGINS_DIRECTORY_ENV] = additionalDirectory;

        await initializePluginHost();

        expect(getPluginHost().get('extra-review')).toMatchObject({
            status: 'active',
            origin: additionalDirectory
        });
    });
});
